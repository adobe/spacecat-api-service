/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// @ts-check

import { composeBaseURL, hasText } from '@adobe/spacecat-shared-utils';
import * as dataAccessModels from '@adobe/spacecat-shared-data-access';
import { hostnameFromUrlString, isPublicHostname } from '../url-utils.js';

// `Site` is a runtime value (the model class carrying the DELIVERY_TYPES static
// map) but the data-access package's .d.ts re-exports its models as types only,
// so tsc can't see it as a value. Reach it through the namespace and assert the
// one shape we depend on, rather than hard-coding the 'other' literal.
const { Site: SiteModel } = /** @type {{ Site: { DELIVERY_TYPES: Record<string, string> } }} */ (
  /** @type {unknown} */ (dataAccessModels)
);

/**
 * The brand_sites.type marker for a Site that mirrors a Semrush market (project).
 * It distinguishes these rows from the brand's own-URL / citation rows so that:
 *   - syncBrandSites preserves them (a brand edit must not delete a market's site
 *     link just because the market's domain isn't in the brand's URL list), and
 *   - mapDbBrandToV2 excludes them from the brand's urls[] (a market's domain is
 *     NOT a brand URL — the brand is a shell with no domain of its own).
 */
export const SERENITY_BRAND_SITE_TYPE = 'serenity';

/**
 * Mirrors a Semrush market (project) as a SpaceCat Site entity, linked to the
 * owning brand via a `brand_sites` row tagged `type='serenity'`.
 *
 * Domain model (per the Serenity setup): a brand is a shell with NO domain of its
 * own — like its Semrush sub-workspace. Each MARKET (project) has its own primary
 * URL / domain, and that domain maps to a single Site on our side (for backwards
 * compatibility and integrations that resolve a site by its base URL). A brand
 * with markets on distinct domains therefore owns several market Sites.
 *
 * Why the dedicated `type='serenity'` marker (not a plain own-site row): a market's
 * domain is generally NOT in the brand's URL list, and `syncBrandSites` rebuilds
 * `brand_sites` from `brand.urls` on every brand edit (delete-all-then-reinsert).
 * An unmarked row would be silently deleted on the next edit. The marker lets
 * syncBrandSites preserve the link and lets mapDbBrandToV2 keep it out of the
 * brand's urls[].
 *
 * Lifecycle: created on brand creation / activation / market creation; never
 * auto-deleted (market deletion leaves the Site + link in place).
 *
 * Best-effort by contract: the Semrush project is the primary outcome and has
 * already succeeded when this runs, so a site/link failure is logged and
 * swallowed (never thrown) rather than failing a market the user can see is live.
 *
 * siteId fast path (LLMO-6405, Phase 2): when the caller already holds the
 * SpaceCat Site identity for this market — because the market was created from
 * an already-onboarded URL, so the client passed `siteId` — the domain →
 * find-or-create resolution is skipped entirely and THAT site is linked
 * directly. The same-org guard and the best-effort link write are preserved;
 * only the domain normalization / SSRF / find-or-create steps are bypassed
 * (the site already exists, so there is no base_url to validate here). When
 * `siteId` is absent the behavior is byte-for-byte the domain path below.
 *
 * @param {object} ctx - request context (ctx.dataAccess.Site + postgrestClient).
 * @param {object} [opts]
 * @param {string} [opts.organizationId] - the brand's organization UUID.
 * @param {string} [opts.brandId] - the brand UUID.
 * @param {string} [opts.domain] - the market/project domain or primary URL. Tolerates
 *   a bare hostname ("example.com") or a full URL ("https://example.com/x"); it is
 *   normalized to the hostname via hostnameFromUrlString (the single source of truth
 *   for brand -> Semrush project domain derivation) so all call sites resolve to the
 *   same base URL as the brand-create path. Ignored when `siteId` is supplied.
 * @param {string} [opts.siteId] - a known SpaceCat Site UUID to link directly
 *   (skips the domain → Site find-or-create). Takes precedence over `domain`.
 * @param {string} [opts.updatedBy] - audit actor for the brand_sites row.
 * @param {boolean} [opts.requireLink=true] - whether the `brand_sites` mirror
 *   write must succeed for a non-null return. `true` (activate / brand-create):
 *   the mirror is a REQUIRED step — a failed/absent mirror returns null (so the
 *   caller can keep the brand pending). `false` (market-create, LLMO-6405): the
 *   mirror is best-effort — return the resolved Site id even if the mirror write
 *   didn't land, so the caller can still bind the market↔site on
 *   `brand_to_semrush_projects` (the DTO's source of truth), which is independent
 *   of the secondary raw-PostgREST mirror.
 * @param {object} [opts.log] - logger.
 * @returns {Promise<string|null>} the resolved market Site id, or null. With
 *   `requireLink=true` a non-null return means the brand_sites link was
 *   established; with `requireLink=false` it means the Site was ensured (found/
 *   created) and belongs to the brand's org, regardless of the mirror write.
 *   Always null on bad input, data-access unavailable, a cross-org site, or an
 *   unresolvable domain.
 */
export async function ensureMarketSite(ctx, {
  organizationId,
  brandId,
  domain,
  siteId,
  updatedBy = 'serenity-market',
  requireLink = true,
  log,
} = {}) {
  if (!organizationId || !hasText(organizationId) || !brandId || !hasText(brandId)) {
    return null;
  }

  const Site = ctx?.dataAccess?.Site;
  const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;

  // Shared brand_sites mirror write. Returns the linked site id on success, or
  // null (no client / write error). Callers combine this with `requireLink` to
  // decide the return (see the return sites below). Kept shared so the row shape
  // and the 23514 alert-token handling stay identical across the siteId fast path
  // and the domain path.
  const writeBrandSiteLink = async (linkSiteId) => {
    if (!postgrestClient?.from) {
      // Site ensured/known, but no client to write the brand_sites link → not linked.
      log?.warn?.('ensureMarketSite: postgrest client unavailable; site ensured but not linked', {
        brandId, siteId: linkSiteId, domain,
      });
      return null;
    }
    const { error } = await postgrestClient
      .from('brand_sites')
      .upsert({
        organization_id: organizationId,
        brand_id: brandId,
        site_id: linkSiteId,
        paths: ['/'],
        type: SERENITY_BRAND_SITE_TYPE,
        updated_by: updatedBy,
      }, { onConflict: 'brand_id,site_id' });
    if (error) {
      // Non-fatal: the Site exists and the link can be re-ensured on a later
      // market write. Return null (not siteId) — the link was NOT established, so
      // a caller must not read a non-null return as a successful mirror.
      //
      // A Postgres CHECK-constraint violation (code 23514) here almost always
      // means the `brand_sites.type='serenity'` migration is not yet deployed in
      // this env — a PERSISTENT, alertable condition (every market create/activate
      // then produces a Semrush project + Site with NO link), not a transient
      // blip. Emit a DISTINCT, greppable ERROR token for that case so on-call can
      // tell "migration missing" from an ordinary write hiccup; keep WARN for the
      // transient case.
      if (error.code === '23514') {
        log?.error?.('ensureMarketSite: SERENITY_MARKET_LINK_REJECTED — brand_sites link rejected by a CHECK constraint; is the brand_sites.type=serenity migration deployed in this env?', {
          brandId, siteId: linkSiteId, code: error.code, error: error.message,
        });
      } else {
        log?.warn?.('ensureMarketSite: brand_sites link upsert failed (non-fatal)', {
          brandId, siteId: linkSiteId, code: error.code, error: error.message,
        });
      }
      return null;
    }
    return linkSiteId;
  };

  // ----- siteId fast path (LLMO-6405): link a known Site directly. -----
  if (siteId && hasText(siteId)) {
    if (!Site || typeof Site.findById !== 'function') {
      log?.warn?.('ensureMarketSite: Site data-access unavailable; skipping', { brandId, siteId });
      return null;
    }
    try {
      const site = await Site.findById(siteId);
      if (!site) {
        log?.warn?.('ensureMarketSite: supplied siteId not found; skipping', { brandId, siteId });
        return null;
      }
      // Same-org guard, identical to the domain path: never cross-link a Site
      // that belongs to another org.
      if (site.getOrganizationId() !== organizationId) {
        log?.warn?.('ensureMarketSite: supplied site belongs to another org; not linked', {
          brandId,
          siteId,
          siteOrg: site.getOrganizationId(),
          brandOrg: organizationId,
        });
        return null;
      }
      const linked = await writeBrandSiteLink(site.getId());
      // When requireLink is false (market-create, LLMO-6405), return the resolved
      // site id EVEN IF the best-effort brand_sites mirror write didn't land — the
      // caller binds the market↔site on brand_to_semrush_projects (the DTO's source
      // of truth, via linkSiteToLiveRows on the data-access model), which must be
      // recorded independent of the secondary raw-PostgREST mirror. When requireLink
      // is true (activate / brand-create) the mirror is a required step, so a failed
      // mirror still returns null (contract preserved).
      return (linked || !requireLink) ? site.getId() : null;
    } catch (e) {
      log?.error?.('ensureMarketSite: failed to link supplied site (non-fatal)', {
        brandId, siteId, error: e.message,
      });
      return null;
    }
  }

  // ----- domain path (unchanged when siteId is absent). -----
  if (!domain || !hasText(domain)) {
    return null;
  }
  if (!Site || typeof Site.findByBaseURL !== 'function') {
    log?.warn?.('ensureMarketSite: Site data-access unavailable; skipping', { brandId, domain });
    return null;
  }

  // Normalize to a bare hostname first: callers pass either a bare domain or a
  // full URL, and composeBaseURL does not strip a path/scheme — so a URL with a
  // path would resolve to the wrong base_url, miss the existing Site, and hit the
  // global base_url uniqueness constraint on every retry. hostnameFromUrlString
  // keeps this in lockstep with brandDomainFromPayload (the brand-create path).
  const hostname = hostnameFromUrlString(domain);
  if (!hostname || !hasText(hostname)) {
    log?.warn?.('ensureMarketSite: domain did not resolve to a hostname; skipping', { brandId, domain });
    return null;
  }
  // SSRF guard: a market domain becomes a Site base_url that downstream workers
  // fetch, and Site.create only validates the scheme — so refuse internal/private
  // hosts (localhost, loopback, link-local, RFC1918, *.internal, bare IPs) here,
  // the single chokepoint shared by the brand-create / market-create / activate
  // callers. Skip (return null) rather than throw — keeps the best-effort contract
  // and, on the required activate path, leaves the brand pending (502) for a fix.
  if (!isPublicHostname(hostname)) {
    log?.warn?.('ensureMarketSite: domain is not a public hostname; refusing to mirror as a Site', { brandId, domain, hostname });
    return null;
  }
  const baseURL = composeBaseURL(hostname);

  try {
    // Global base_url uniqueness means at most one Site per domain; findByBaseURL
    // makes this idempotent across markets that happen to share a domain.
    let site = await Site.findByBaseURL(baseURL);
    if (!site) {
      // OTHER delivery type: a Semrush-managed market site is not an AEM target.
      site = await Site.create({
        baseURL,
        organizationId,
        deliveryType: SiteModel.DELIVERY_TYPES.OTHER,
      });
    }
    const resolvedSiteId = site.getId();

    // Only link a same-org site. A pre-existing site for this domain in another
    // org cannot be duplicated (base_url is globally unique) and must not be
    // cross-linked — this mirrors syncBrandSites, which matches sites by org.
    if (site.getOrganizationId() !== organizationId) {
      log?.warn?.('ensureMarketSite: existing site for domain belongs to another org; not linked', {
        brandId,
        domain,
        siteId: resolvedSiteId,
        siteOrg: site.getOrganizationId(),
        brandOrg: organizationId,
      });
      // Cross-org: the Site is not this brand's, so bind nothing.
      return null;
    }

    // See the fast-path note: requireLink=false returns the resolved id even if
    // the best-effort brand_sites mirror write failed (LLMO-6405).
    const linked = await writeBrandSiteLink(resolvedSiteId);
    return (linked || !requireLink) ? resolvedSiteId : null;
  } catch (e) {
    log?.error?.('ensureMarketSite: failed to ensure site for market domain (non-fatal)', {
      brandId, domain, error: e.message,
    });
    return null;
  }
}

/**
 * Resolves a SpaceCat Site UUID to its bare hostname (the domain a Semrush
 * market/project tracks). Lets a market-create caller supply a `siteId` instead
 * of a `brandDomain`: the site's `base_url` is normalized to a hostname via
 * `hostnameFromUrlString` (the same normalizer every other brand → Semrush
 * domain derivation uses), so the derived domain is identical to what a
 * `brandDomain` caller would have sent.
 *
 * Best-effort: returns null (never throws) on missing input, unavailable
 * data-access, an unknown site, or a lookup failure. The caller decides whether
 * a null is a hard 400 (a supplied siteId that cannot resolve) or a silent skip.
 *
 * @param {object} dataAccess - `ctx.dataAccess` (reads `dataAccess.Site`).
 * @param {string|null|undefined} siteId - the SpaceCat Site UUID to resolve.
 * @param {object} [log] - logger.
 * @returns {Promise<string|null>} the site's hostname, or null when unresolvable.
 */
export async function resolveSiteDomain(dataAccess, siteId, log) {
  if (!siteId || !hasText(siteId)) {
    return null;
  }
  const Site = dataAccess?.Site;
  if (!Site || typeof Site.findById !== 'function') {
    log?.warn?.('resolveSiteDomain: Site data-access unavailable; cannot resolve site domain', { siteId });
    return null;
  }
  try {
    const site = await Site.findById(siteId);
    if (!site) {
      log?.warn?.('resolveSiteDomain: site not found', { siteId });
      return null;
    }
    return hostnameFromUrlString(site.getBaseURL());
  } catch (e) {
    log?.warn?.('resolveSiteDomain: lookup failed (non-fatal)', { siteId, error: e.message });
    return null;
  }
}

/**
 * R12 (LLMO-6405): removes the brand_sites `type='serenity'` link for `siteId`
 * when the DELETED market was the LAST live market on that site — so a site that
 * no longer backs any market is not left orphaned in `brand_sites`. Reference-
 * counts the brand's live mapping rows (`BrandSemrushProject.allByBrandId`,
 * ignoring tombstones) and only unlinks when ZERO remaining live rows point at
 * `siteId`. The brand's PRIMARY site (`primarySiteId`, i.e. `brands.site_id`) is
 * NEVER unlinked — it backs the brand shell itself, not just a market.
 *
 * The Site entity is never deleted here; only the `brand_sites` row is removed.
 * Best-effort by contract: the market delete has already succeeded upstream, so
 * any failure here is logged under a greppable token and swallowed (never
 * throws). No-op when `siteId` is absent/unknown.
 *
 * @param {object} ctx - request context (ctx.dataAccess.BrandSemrushProject + postgrestClient).
 * @param {object} [opts]
 * @param {string} [opts.brandId] - the brand UUID.
 * @param {string} [opts.siteId] - the deleted market's linked Site UUID.
 * @param {string|null} [opts.primarySiteId] - the brand's primary site (brands.site_id);
 *   never unlinked. Null/absent means the brand has no primary site to protect.
 * @param {object} [log] - logger.
 * @returns {Promise<boolean>} true when a brand_sites row was removed; false otherwise.
 */
export async function unlinkMarketSiteIfOrphaned(ctx, opts, log) {
  const { brandId, siteId, primarySiteId } = opts || {};
  // No linked site on the deleted market → nothing to reference-count.
  if (!siteId || !hasText(siteId) || !brandId || !hasText(brandId)) {
    return false;
  }
  // Never unlink the brand's primary site — it anchors the brand, not a market.
  if (primarySiteId && hasText(primarySiteId) && siteId === primarySiteId) {
    return false;
  }
  const BrandSemrushProject = ctx?.dataAccess?.BrandSemrushProject;
  const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
  if (!BrandSemrushProject || typeof BrandSemrushProject.allByBrandId !== 'function'
      || !postgrestClient?.from) {
    return false;
  }
  try {
    const rows = await BrandSemrushProject.allByBrandId(brandId);
    // A live row still pointing at this site means another market shares it →
    // keep the link.
    const stillReferenced = (Array.isArray(rows) ? rows : []).some(
      (row) => !row.getDeletedAt() && row.getSiteId() === siteId,
    );
    if (stillReferenced) {
      return false;
    }
    const { error } = await postgrestClient
      .from('brand_sites')
      .delete()
      .eq('brand_id', brandId)
      .eq('site_id', siteId)
      .eq('type', SERENITY_BRAND_SITE_TYPE);
    if (error) {
      log?.warn?.('unlinkMarketSiteIfOrphaned: SERENITY_MARKET_UNLINK_FAILED — brand_sites unlink failed (non-fatal)', {
        brandId, siteId, error: error.message,
      });
      return false;
    }
    log?.info?.('unlinkMarketSiteIfOrphaned: removed orphaned brand_sites market link', {
      brandId, siteId,
    });
    return true;
  } catch (e) {
    log?.error?.('unlinkMarketSiteIfOrphaned: SERENITY_MARKET_UNLINK_FAILED — unlink threw (non-fatal)', {
      brandId, siteId, error: e.message,
    });
    return false;
  }
}
