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
import { hostnameFromUrlString } from '../url-utils.js';

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
 * @param {object} ctx - request context (ctx.dataAccess.Site + postgrestClient).
 * @param {object} [opts]
 * @param {string} [opts.organizationId] - the brand's organization UUID.
 * @param {string} [opts.brandId] - the brand UUID.
 * @param {string} [opts.domain] - the market/project domain or primary URL. Tolerates
 *   a bare hostname ("example.com") or a full URL ("https://example.com/x"); it is
 *   normalized to the hostname via hostnameFromUrlString (the single source of truth
 *   for brand -> Semrush project domain derivation) so all call sites resolve to the
 *   same base URL as the brand-create path.
 * @param {string} [opts.updatedBy] - audit actor for the brand_sites row.
 * @param {object} [opts.log] - logger.
 * @returns {Promise<string|null>} the site id ONLY when the brand_sites link was
 *   established; null otherwise — bad input, data-access unavailable, cross-org,
 *   no postgrest client, or a failed link write (the site may exist in those
 *   cases, but a non-null return always means "linked").
 */
export async function ensureMarketSite(ctx, {
  organizationId,
  brandId,
  domain,
  updatedBy = 'serenity-market',
  log,
} = {}) {
  if (
    !domain || !hasText(domain)
    || !organizationId || !hasText(organizationId)
    || !brandId || !hasText(brandId)
  ) {
    return null;
  }

  const Site = ctx?.dataAccess?.Site;
  const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
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
    const siteId = site.getId();

    // Only link a same-org site. A pre-existing site for this domain in another
    // org cannot be duplicated (base_url is globally unique) and must not be
    // cross-linked — this mirrors syncBrandSites, which matches sites by org.
    if (site.getOrganizationId() !== organizationId) {
      log?.warn?.('ensureMarketSite: existing site for domain belongs to another org; not linked', {
        brandId, domain, siteId, siteOrg: site.getOrganizationId(), brandOrg: organizationId,
      });
      // Return null: the site exists but no brand_sites link was established, so a
      // caller must not read this as a successful mirror.
      return null;
    }

    if (!postgrestClient?.from) {
      // Site ensured, but no client to write the brand_sites link → not linked.
      log?.warn?.('ensureMarketSite: postgrest client unavailable; site ensured but not linked', {
        brandId, siteId, domain,
      });
      return null;
    }

    const { error } = await postgrestClient
      .from('brand_sites')
      .upsert({
        organization_id: organizationId,
        brand_id: brandId,
        site_id: siteId,
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
          brandId, siteId, code: error.code, error: error.message,
        });
      } else {
        log?.warn?.('ensureMarketSite: brand_sites link upsert failed (non-fatal)', {
          brandId, siteId, code: error.code, error: error.message,
        });
      }
      return null;
    }
    return siteId;
  } catch (e) {
    log?.error?.('ensureMarketSite: failed to ensure site for market domain (non-fatal)', {
      brandId, domain, error: e.message,
    });
    return null;
  }
}
