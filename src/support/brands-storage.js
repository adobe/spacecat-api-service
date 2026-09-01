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

import { composeBaseURL, hasText } from '@adobe/spacecat-shared-utils';

import { SERENITY_BRAND_SITE_TYPE } from './serenity/site-linkage.js';
import { normalizeBrandName } from './normalize-brand-name.js';
import { readFeatureFlagScopes, resolveFlagRowForBrand } from './feature-flags-storage.js';
import {
  SERENITY_FEATURE_FLAG_NAME,
  SERENITY_FEATURE_FLAG_PRODUCT,
} from './serenity/serenity-active.js';

// Upper bound for the active-brand duplicate scan (LLMO-7284). Comfortably above
// any realistic active-brands-per-org count; its only purpose is to make a
// silent PostgREST db-max-rows truncation impossible (a full page => fail closed).
const ACTIVE_BRAND_SCAN_LIMIT = 1000;

/**
 * PostgREST select string — joins all normalized child tables.
 */
const BRAND_SELECT = [
  '*',
  'base_site:sites!site_id(id, base_url)',
  'brand_aliases(alias, regions)',
  'brand_social_accounts(url, regions)',
  'brand_earned_sources(name, url, regions)',
  'competitors(name, url, aliases, regions)',
  'brand_sites(site_id, paths, type, sites(base_url))',
  'brand_urls(url)',
].join(', ');

// LLMO-6978: on delete a brand is renamed to `{name}_deleted` to free its
// original name for reuse (see deleteBrand). A same-named deleted brand already
// present bumps the suffix to `_deleted2`, `_deleted3`, ... Each colliding
// rename costs one round-trip, so this caps a pathological loop (a customer
// deleting the same name hundreds of times) rather than any expected volume.
const MAX_DELETED_NAME_ATTEMPTS = 100;

// Re-landed from Igor Grubic's #2504 (LLMO-5183): map the data-layer
// chk_active_brand_has_site_id CheckViolation to a typed 400 (covers the race
// where site_id is cleared between our SELECT and this write).
function rethrowCheckViolation(error, fallbackMessage) {
  if (error.code === '23514' && error.message?.includes('chk_active_brand_has_site_id')) {
    const err = new Error('Cannot activate a brand without a base site URL');
    err.status = 400;
    throw err;
  }
  throw new Error(fallbackMessage);
}

function normalizeNullableText(value, fieldName) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    // Tag with a 400 status so callers that reach storage without going through
    // the controller's validation surface a client error rather than a 500.
    const error = new Error(`${fieldName} must be a string or null`);
    error.status = 400;
    throw error;
  }
  const trimmed = value.trim();
  return hasText(trimmed) ? trimmed : null;
}

/**
 * Splits a full URL string into its base URL and path.
 * e.g. "https://example.com/products" -> { base: "https://example.com", path: "/products" }
 * A root path "/" is treated as no path (empty string).
 */
function parseUrlParts(urlString) {
  try {
    const u = new URL(urlString);
    const base = `${u.protocol}//${u.host}`;
    const path = u.pathname === '/' ? '' : u.pathname;
    return { base, path };
  } catch {
    return { base: urlString, path: '' };
  }
}

/**
 * Reads the organization's `LLMO/serenity` rows — its own and every brand's
 * override — in one query, for {@link withSerenityState}.
 *
 * One query serves a whole response: a 16-brand list resolves from a single read,
 * not sixteen. Read fresh rather than through `serenity-active.js`'s cache: that
 * cache exists to keep request-time gates off the DB, whereas this value is
 * payload the UI renders, and a brand shown as active seconds after its wave
 * released it is worth one indexed read.
 *
 * Consequence, accepted deliberately: for up to one cache TTL after a flip this
 * payload and the request-time gates can disagree, in whichever direction the flip
 * went. A brand released mid-TTL reports `serenityActive: true` while a gate on a
 * not-yet-expired entry still refuses it; a brand rolled back reports `false` while
 * a gate still admits it. The window is bounded by `BRAND_CACHE_TTL_MS`, the gates
 * are the authority and fail closed, and no write is half-applied by it, so the
 * alternative (routing this read through the gate cache, which is keyed on a
 * request context rather than a PostgREST client) is not worth the coupling.
 *
 * A failure propagates: the rows live in the same database as the brand read that
 * just succeeded, so an error here is a real fault, not a reason to report every
 * brand as inactive. On a write path, resolve BEFORE the write, so that fault
 * cannot turn an edit that already committed into a 500.
 *
 * @param {string} organizationId - SpaceCat organization UUID.
 * @param {object} postgrestClient - PostgREST client.
 * @returns {Promise<{orgRow: object|null, brandRows: Map<string, object>}>}
 */
export async function readSerenityFlagScopes(organizationId, postgrestClient) {
  return readFeatureFlagScopes({
    organizationId,
    product: SERENITY_FEATURE_FLAG_PRODUCT,
    flagName: SERENITY_FEATURE_FLAG_NAME,
    postgrestClient,
  });
}

/**
 * Adds the derived per-brand serenity fields to a brand payload: whether the
 * Semrush-backed experience is live for THIS brand, and when it went live.
 *
 * Resolved from the brand's own override row falling back to the organization's,
 * so no consumer re-implements the resolution rule — project-elmo-ui reads
 * `serenityActive` to decide whether a brand is on the Semrush read path and
 * whether its classic-UI editors are locked, and an organization mid-migration
 * has both answers among its brands.
 *
 * Applied by the handlers that return a brand payload rather than inside the
 * readers, so that the internal reads which never surface these fields — the
 * brand-claims Slack commands, the elements authorizers, site attach, the
 * opportunities controller, and the edit handler's own pre-write guards — neither
 * pay for the flag query nor inherit its failure mode.
 *
 * @param {object} brand - Brand in V2 config shape, from {@link mapDbBrandToV2}.
 * @param {{orgRow: object|null, brandRows: Map<string, object>}} scopes - From
 *   {@link readSerenityFlagScopes}.
 * @returns {object} The brand, with the two derived fields set.
 */
export function withSerenityState(brand, scopes) {
  const row = resolveFlagRowForBrand(scopes, brand.id);
  const serenityActive = row?.flag_value === true;
  return {
    ...brand,
    // Independent of `semrushSubWorkspaceId`, which is set when the brand is
    // provisioned — a brand can be bound for waves before it is released.
    serenityActive,
    // The resolved row's `updated_at`, the same timestamp operator tooling reads
    // as the migration date — the column is NOT NULL, so an active brand always
    // has one. Null while inactive, since nothing has gone live.
    serenityActivatedAt: serenityActive ? row.updated_at : null,
  };
}

/**
 * Maps a DB brand row (with all joined child tables) to the V2 config shape
 * the UI expects.
 *
 * `urls[]` unions `brand_urls` (raw user-submitted list) with `brand_sites`
 * (join to the sites table). Each entry carries `onboarded` — true when the
 * URL's base resolves to a site row in the org — and `siteId` for onboarded
 * entries. Legacy brands with no `brand_urls` rows fall back to the
 * `brand_sites` expansion, where every entry is by definition onboarded.
 *
 * The derived per-brand serenity fields are NOT set here — a handler returning
 * this payload to a client adds them with {@link withSerenityState}.
 *
 * @param {object} row - DB brand row with joined child tables.
 * @returns {object} Brand in V2 config shape.
 */
function mapDbBrandToV2(row) {
  // The set of base URLs the brand explicitly lists as its own (brand_urls).
  const brandUrlBases = new Set(
    (row.brand_urls || [])
      .map((bu) => composeBaseURL(parseUrlParts(bu.url).base))
      .filter(hasText),
  );

  // Exclude Semrush market-site rows from the brand response: a market's domain
  // is NOT a brand URL (the brand is a shell with no domain of its own), so these
  // rows must not surface in urls[] or siteIds. They are a pure backend linkage —
  // integrations resolve them via the sites / brand_sites tables directly.
  //
  // Exception: when the brand ALSO lists that exact domain as a brand URL, it IS a
  // brand URL (not just a hidden market mirror) and must keep its onboarded/siteId
  // status in the response. syncBrandSites collapses such an overlap into a single
  // serenity-typed row (one row per (brand, site)); surfacing it here is what keeps
  // a brand URL from silently flipping to onboarded:false the moment a market is
  // created for the same domain.
  const ownBrandSites = (row.brand_sites || [])
    .filter((bs) => bs.type !== SERENITY_BRAND_SITE_TYPE
      || (hasText(bs.sites?.base_url) && brandUrlBases.has(composeBaseURL(bs.sites.base_url))));

  const siteIds = ownBrandSites.map((bs) => bs.site_id).filter(hasText);

  // Index brand_sites by normalized base URL so brand_urls entries can be
  // tagged onboarded/siteId by matching their base. brand_sites.site_id is
  // NOT NULL in the schema, so no defensive filter on it here.
  const siteByBase = new Map();
  ownBrandSites.forEach((bs) => {
    const base = bs.sites?.base_url;
    if (!hasText(base)) {
      return;
    }
    siteByBase.set(composeBaseURL(base), {
      siteId: bs.site_id,
      type: hasText(bs.type) ? bs.type : null,
    });
  });

  // Legacy fallback: expand brand_sites paths into URL entries (one per path,
  // or one for the base URL when no paths are set). Used when brand_urls is
  // empty — i.e. the brand predates the brand_urls child table.
  const brandSitesUrls = ownBrandSites.flatMap((bs) => {
    const base = bs.sites?.base_url;
    if (!hasText(base)) {
      return [];
    }
    const paths = bs.paths || [];
    const effectivePaths = paths.length === 0 ? ['/'] : paths;
    return effectivePaths.map((p) => {
      const entry = {
        value: p === '/' ? base : `${base}${p}`,
        onboarded: true,
        siteId: bs.site_id,
      };
      // Only the root entry (/) carries the base-URL type; subpaths are plain URLs
      if (p === '/' && hasText(bs.type)) {
        entry.type = bs.type;
      }
      return entry;
    });
  });

  const brandUrlsEntries = (row.brand_urls || []).map((bu) => {
    const { base } = parseUrlParts(bu.url);
    const siteInfo = siteByBase.get(composeBaseURL(base));
    const entry = { value: bu.url, onboarded: Boolean(siteInfo) };
    if (siteInfo) {
      entry.siteId = siteInfo.siteId;
    }
    // Propagate brand_sites.type for onboarded URLs so legacy readers that
    // relied on type in the V2 response still see it. brand_urls itself
    // carries no type column.
    if (hasText(siteInfo?.type)) {
      entry.type = siteInfo.type;
    }
    return entry;
  });

  const urls = brandUrlsEntries.length > 0 ? brandUrlsEntries : brandSitesUrls;

  return {
    id: row.id,
    name: row.name,
    baseSiteId: row.base_site?.id || row.site_id || null,
    baseUrl: row.base_site?.base_url || null,
    // Read-only: the brand's own Semrush sub-workspace (dual-mode) — the
    // write-of-record column. Null for brands still in flat mode (no
    // sub-workspace minted yet). Consumers use it to scope per-brand Semrush
    // views to the sub-workspace.
    semrushSubWorkspaceId: row.semrush_sub_workspace_id || null,
    // Read-only: deferred Semrush provisioning data for a pending (draft) brand
    // (serenity dual-mode). Object { primaryUrl, markets: [{ market,
    // languageCode }] } the wizard collected before provisioning; null once
    // activation has provisioned it (or for a non-pending brand). Lets the UI
    // re-hydrate the draft's primary URL + market on the activation form.
    pendingSemrushProvisioning: row.pending_semrush_provisioning || null,
    status: row.status || 'active',
    origin: row.origin || 'human',
    description: row.description || null,
    brandContext: row.brand_context ?? null,
    mentionSentimentGuidance: row.mention_sentiment_guidance ?? null,
    vertical: row.vertical || null,
    // Internal ops gate (LLMO-5741): opt-in flag the mystique Brand Claims
    // consumer reads back to decide whether a BP-sheet-ready event becomes a
    // claims run. Default false so brands stay off the automated path until an
    // operator flips it (via the `brand-claims` Slack command).
    brandClaimsEnabled: row.brand_claims_enabled ?? false,
    region: row.regions || [],
    urls,
    socialAccounts: (row.brand_social_accounts || []).map((s) => ({
      url: s.url,
      regions: s.regions || [],
    })),
    earnedContent: (row.brand_earned_sources || []).map((e) => ({
      name: e.name,
      url: e.url,
      regions: e.regions || [],
    })),
    brandAliases: (row.brand_aliases || []).map((a) => ({
      name: a.alias,
      regions: a.regions || [],
    })),
    competitors: (row.competitors || []).map((c) => ({
      name: c.name,
      url: c.url || null,
      aliases: c.aliases || [],
      regions: c.regions || [],
    })),
    siteIds,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Fully replaces a child table for a brand by deleting all existing rows then
 * inserting the new ones. Used for social accounts, earned sources, aliases, competitors.
 */
async function replaceChildRows(table, brandId, rows, onConflict, postgrestClient) {
  const { error: deleteError } = await postgrestClient
    .from(table)
    .delete()
    .eq('brand_id', brandId);
  if (deleteError) {
    throw new Error(`Failed to clear ${table}: ${deleteError.message}`);
  }
  if (rows.length === 0) {
    return;
  }
  const { error: insertError } = await postgrestClient
    .from(table)
    .upsert(rows, { onConflict });
  if (insertError) {
    throw new Error(`Failed to sync ${table}: ${insertError.message}`);
  }
}

/**
 * Verifies a candidate primary site (`baseSiteId`) belongs to the same org as the
 * brand being anchored to it, before that site_id is ever persisted.
 *
 * serenity-docs#346: `brand.organization_id != site.organization_id` is exactly the
 * org-ID mismatch pattern the investigation traced (Tata Capital, BMW, Toyota, ...) —
 * a brand silently anchored to a *different* org's site. Both upsertBrand (fresh
 * create / first anchor) and updateBrand (first set, or pending re-point) must call
 * this before writing site_id; the immutable-once-set branches in each are
 * unaffected, since they already refuse to change an existing active site_id.
 *
 * @param {object} postgrestClient - PostgREST client
 * @param {string} siteId - Candidate `brands.site_id`
 * @param {string} organizationId - SpaceCat organization UUID the brand belongs to
 * @param {string} brandLabel - Whatever identifies the brand in the caller's context,
 *   for the error message only — upsertBrand passes the brand name (not yet
 *   persisted, so no id exists yet); updateBrand passes the fetched brand's
 *   name when its existing-row read found one, else falls back to brandId.
 * @throws {Error} status 409, code 'brand_site_org_mismatch', if the site does not
 *   belong to organizationId (including if it doesn't exist at all)
 */
async function assertSiteBelongsToOrg(postgrestClient, siteId, organizationId, brandLabel) {
  const { data: anchorSite, error: anchorSiteError } = await postgrestClient
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (anchorSiteError) {
    throw new Error(
      `Failed to verify primary site org for brand "${brandLabel}": ${anchorSiteError.message}`,
    );
  }
  if (!anchorSite) {
    // Plain ASCII (no em dash) to match this file's other thrown, client-facing
    // messages: an em dash here previously crashed createErrorResponse's
    // X-Error header (@adobe/fetch rejects non-Latin1 header content with a
    // raw TypeError, surfacing as a 500 instead of this 409 — caught by the
    // it-postgres IT suite, not the mocked unit tests). createErrorResponse
    // now sanitizes the header regardless (serenity-docs#346), but this stays
    // ASCII too rather than leaning on that alone.
    const err = new Error(
      `Cannot anchor brand "${brandLabel}" to site ${siteId}: that site `
      + `does not exist, or does not belong to organization ${organizationId}.`,
    );
    err.status = 409;
    err.code = 'brand_site_org_mismatch';
    throw err;
  }
}

/**
 * Fully replaces brand_sites for a brand. Groups submitted URLs by normalized base URL
 * (via composeBaseURL) so that multiple paths under the same site share one brand_sites row.
 */
async function syncBrandSites(organizationId, brandId, urls, postgrestClient, updatedBy) {
  // Serenity market-site rows (type='serenity') are owned by the serenity market
  // lifecycle, NOT by the brand's URL list. A market's domain is generally not in
  // brand.urls, so the delete-all-then-reinsert below would wipe these links on
  // every brand edit. Preserve them: collect the protected site ids first, exclude
  // them from the delete, and keep their type from being downgraded on re-upsert
  // (when a brand URL happens to resolve to the same site as a market).
  //
  // The delete is type-based (IS DISTINCT FROM 'serenity'), so a serenity row
  // inserted concurrently by ensureMarketSite is never deleted here. The only
  // residual race is a downgrade: if a concurrent ensureMarketSite inserts a
  // serenity row for a site that is ALSO a brand URL, between this SELECT and the
  // upsert below, the upsert may re-tag it to the URL's type. That requires a
  // simultaneous brand edit + market write whose domains collide — by design
  // unusual — and self-heals on the next market write (ensureMarketSite re-upserts
  // type='serenity'). Not worth a cross-request lock PostgREST can't cheaply give.
  const { data: protectedRows, error: protectedError } = await postgrestClient
    .from('brand_sites')
    .select('site_id')
    .eq('brand_id', brandId)
    .eq('type', SERENITY_BRAND_SITE_TYPE);
  // Fail closed (consistent with the delete/upsert error handling below): a
  // swallowed SELECT error would leave protectedSiteIds empty, and the re-upsert
  // would then downgrade a serenity row to the brand URL's type — silently
  // unprotecting a market-mirror link. A failed brand edit is recoverable; a
  // corrupted serenity marker surfaces later as a vanished market site.
  if (protectedError) {
    throw new Error(`Failed to sync brand_sites: cannot read protected rows: ${protectedError.message}`);
  }
  const protectedSiteIds = new Set((protectedRows || []).map((r) => r.site_id));

  const { error: deleteError } = await postgrestClient
    .from('brand_sites')
    .delete()
    .eq('brand_id', brandId)
    // Delete every non-semrush row (including NULL-type rows; a bare .neq would
    // skip NULLs). type IS DISTINCT FROM 'serenity'.
    .or(`type.is.null,type.neq.${SERENITY_BRAND_SITE_TYPE}`);
  if (deleteError) {
    throw new Error(`Failed to sync brand_sites: ${deleteError.message}`);
  }

  if (!urls || urls.length === 0) {
    return;
  }

  // Group paths by base URL and track type
  const pathsByBase = new Map();
  const typeByBase = new Map();
  urls
    .forEach((u) => {
      const value = typeof u === 'string' ? u : u?.value;
      if (!hasText(value)) {
        return;
      }
      const { base, path } = parseUrlParts(value);
      const normalizedBase = composeBaseURL(base);
      if (!pathsByBase.has(normalizedBase)) {
        pathsByBase.set(normalizedBase, []);
      }
      pathsByBase.get(normalizedBase).push(path || '/');
      // First URL with a type wins for a given base URL — prevents silent overwrite
      // when multiple paths under the same domain carry different types.
      if (typeof u === 'object' && hasText(u?.type) && !typeByBase.has(normalizedBase)) {
        typeByBase.set(normalizedBase, u.type);
      }
    });

  if (pathsByBase.size === 0) {
    return;
  }

  const { data: sites, error: sitesError } = await postgrestClient
    .from('sites')
    .select('id, base_url')
    .eq('organization_id', organizationId)
    .in('base_url', [...pathsByBase.keys()]);
  if (sitesError) {
    throw new Error(`Failed to sync brand_sites: cannot read sites: ${sitesError.message}`);
  }

  if (!sites || sites.length === 0) {
    return;
  }

  const rows = sites.map((s) => ({
    organization_id: organizationId,
    brand_id: brandId,
    site_id: s.id,
    paths: pathsByBase.get(s.base_url) || [],
    // A brand URL may resolve to the same site as a preserved market row. Keep
    // that row tagged 'serenity' rather than downgrading it to the URL's type.
    type: protectedSiteIds.has(s.id)
      ? SERENITY_BRAND_SITE_TYPE
      : (typeByBase.get(s.base_url) || null),
    updated_by: updatedBy,
  }));

  const { error } = await postgrestClient
    .from('brand_sites')
    .upsert(rows, { onConflict: 'brand_id,site_id' });
  if (error) {
    throw new Error(`Failed to sync brand_sites: ${error.message}`);
  }
}

/**
 * Syncs the raw user-submitted URL list to the brand_urls table. Every URL the
 * caller supplies is persisted, independent of whether it resolves to a
 * brand_sites row. Values are normalized with composeBaseURL so storage keys
 * match the form brand_sites uses and the response union in
 * mapDbBrandToV2 can match bases exactly.
 */
async function syncBrandUrls(organizationId, brandId, urls, postgrestClient, updatedBy) {
  const seen = new Set();
  const rows = (urls || [])
    .map((u) => {
      const value = typeof u === 'string' ? u : u?.value;
      if (!hasText(value)) {
        return null;
      }
      const { base, path } = parseUrlParts(value);
      return { url: `${composeBaseURL(base)}${path}` };
    })
    .filter((u) => u && !seen.has(u.url) && seen.add(u.url))
    .map((u) => ({
      organization_id: organizationId,
      brand_id: brandId,
      url: u.url,
      updated_by: updatedBy,
    }));
  await replaceChildRows('brand_urls', brandId, rows, 'brand_id,url', postgrestClient);
}

/**
 * Syncs social accounts for a brand to the brand_social_accounts table.
 *
 * `socialAccounts` being `undefined` (the field was omitted) or `null`
 * (explicitly nulled, e.g. by a JSON.stringify round-trip of an unset field)
 * means the caller never touched this collection — skip the sync
 * entirely rather than let `replaceChildRows` wipe existing rows (LLMO-6591).
 * A caller that DOES want to clear the collection sends `[]` explicitly, which
 * still reaches `replaceChildRows` and deletes as before.
 */
// eslint-disable-next-line max-len
async function syncSocialAccounts(brandId, organizationId, socialAccounts, postgrestClient, updatedBy) {
  if (socialAccounts === undefined || socialAccounts === null) {
    return;
  }
  const rows = (socialAccounts || [])
    .filter((s) => hasText(s?.url))
    .map((s) => ({
      organization_id: organizationId,
      brand_id: brandId,
      url: s.url,
      regions: s.regions || [],
      updated_by: updatedBy,
    }));
  await replaceChildRows('brand_social_accounts', brandId, rows, 'brand_id,url', postgrestClient);
}

/**
 * Syncs earned content sources for a brand to the brand_earned_sources table.
 *
 * `earnedContent` being `undefined` or `null` means the caller never touched
 * this collection — skip the sync entirely (LLMO-6591; see syncSocialAccounts).
 */
// eslint-disable-next-line max-len
async function syncEarnedSources(brandId, organizationId, earnedContent, postgrestClient, updatedBy) {
  if (earnedContent === undefined || earnedContent === null) {
    return;
  }
  const rows = (earnedContent || [])
    .filter((e) => hasText(e?.url) && hasText(e?.name))
    .map((e) => ({
      organization_id: organizationId,
      brand_id: brandId,
      name: e.name,
      url: e.url,
      regions: e.regions || [],
      updated_by: updatedBy,
    }));
  await replaceChildRows('brand_earned_sources', brandId, rows, 'brand_id,url', postgrestClient);
}

/**
 * Syncs aliases for a brand to the brand_aliases table.
 *
 * `brandAliases` being `undefined` or `null` means the caller never touched
 * this collection — skip the sync entirely (LLMO-6591; see syncSocialAccounts).
 */
async function syncAliases(brandId, organizationId, brandAliases, postgrestClient, updatedBy) {
  if (brandAliases === undefined || brandAliases === null) {
    return;
  }
  const seen = new Set();
  const rows = (brandAliases || [])
    .map((a) => ({ alias: typeof a === 'string' ? a : a?.name, regions: a?.regions || [] }))
    .filter((a) => hasText(a.alias) && !seen.has(a.alias) && seen.add(a.alias))
    .map((a) => ({
      organization_id: organizationId,
      brand_id: brandId,
      alias: a.alias,
      regions: a.regions,
      updated_by: updatedBy,
    }));
  await replaceChildRows('brand_aliases', brandId, rows, 'brand_id,alias', postgrestClient);
}

/**
 * Syncs competitors for a brand to the competitors table.
 *
 * `competitors` being `undefined` or `null` means the caller never touched
 * this collection — skip the sync entirely (LLMO-6591; see syncSocialAccounts).
 */
async function syncCompetitors(brandId, organizationId, competitors, postgrestClient, updatedBy) {
  if (competitors === undefined || competitors === null) {
    return;
  }
  const seen = new Set();
  const rows = (competitors || [])
    .map((c) => ({
      name: typeof c === 'string' ? c : c?.name,
      url: c?.url || null,
      aliases: Array.isArray(c?.aliases) ? c.aliases : [],
      regions: c?.regions || [],
    }))
    .filter((c) => hasText(c.name) && !seen.has(c.name) && seen.add(c.name))
    .map((c) => ({
      organization_id: organizationId,
      brand_id: brandId,
      name: c.name,
      url: c.url,
      aliases: c.aliases,
      regions: c.regions,
      updated_by: updatedBy,
    }));
  await replaceChildRows('competitors', brandId, rows, 'brand_id,name', postgrestClient);
}

/**
 * Lists all brands for an organization from the normalized brands table,
 * including all child rows (aliases, competitors, social, earned, sites).
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {object} postgrestClient - PostgREST client
 * @param {object} [options]
 * @param {string} [options.status] - Filter by status (active, pending, deleted)
 * @returns {Promise<object[]>} Array of brands in V2 config shape
 */
export async function listBrands(organizationId, postgrestClient, options = {}) {
  if (!postgrestClient?.from) {
    return [];
  }

  let query = postgrestClient
    .from('brands')
    .select(BRAND_SELECT)
    .eq('organization_id', organizationId)
    .order('name', { ascending: true });

  if (hasText(options.status)) {
    query = query.eq('status', options.status);
  } else {
    query = query.neq('status', 'deleted');
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list brands: ${error.message}`);
  }

  return (data || []).map(mapDbBrandToV2);
}

/**
 * Gets a single brand by ID from the normalized brands table.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} brandId - Brand UUID
 * @param {object} postgrestClient - PostgREST client
 * @returns {Promise<object|null>} Brand in V2 config shape or null
 */
export async function getBrandById(organizationId, brandId, postgrestClient) {
  if (!postgrestClient?.from || !hasText(brandId)) {
    return null;
  }

  const { data, error } = await postgrestClient
    .from('brands')
    .select(BRAND_SELECT)
    .eq('organization_id', organizationId)
    .eq('id', brandId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get brand: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  return mapDbBrandToV2(data);
}

/**
 * Lightweight brand/org-membership + display-name lookup. Selects only `id, name`
 * — unlike {@link getBrandById}, which pays for a wide 8-table join
 * (`BRAND_SELECT`: aliases, social accounts, earned sources, competitors, sites,
 * urls) to build the full brand DTO. Callers that only need to confirm a brand
 * belongs to an org and want its display name (e.g. auth guards enriching a
 * filter-dimensions response) should use this instead.
 *
 * @param {string} organizationId - SpaceCat organization UUID.
 * @param {string} brandId - Brand UUID.
 * @param {object} postgrestClient - PostgREST client.
 * @returns {Promise<{id: string, name: string} | null>} the brand's id + name,
 *   or null if it doesn't exist / doesn't belong to the org.
 */
export async function getBrandIdentity(organizationId, brandId, postgrestClient) {
  if (!postgrestClient?.from || !hasText(brandId)) {
    return null;
  }

  const { data, error } = await postgrestClient
    .from('brands')
    .select('id, name')
    .eq('organization_id', organizationId)
    .eq('id', brandId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get brand identity: ${error.message}`);
  }
  return data ?? null;
}

/**
 * Reads a brand's PRIMARY site id (`brands.site_id`) — the site that anchors the
 * brand shell itself (as opposed to a market-mirror site linked via
 * `brand_sites`). Used by the serenity market-delete cleanup (LLMO-6405 R12) to
 * ensure the brand's primary site link is never removed when its last market is
 * deleted. Lightweight single-column read; returns null when the brand has no
 * primary site (a serenity shell before activation) or is not found.
 *
 * @param {string} organizationId - SpaceCat organization UUID.
 * @param {string} brandId - Brand UUID.
 * @param {object} postgrestClient - PostgREST client.
 * @returns {Promise<string|null>} the brand's primary site id, or null.
 */
export async function getBrandBaseSiteId(organizationId, brandId, postgrestClient) {
  // Can't scope the query without all three → THROW (not return null) so a
  // best-effort caller's catch treats it as "primary unresolved" and skips
  // primary-site-dependent cleanup. Returning null here would be ambiguous with a
  // successfully-resolved "brand has no primary site" and would silently disable
  // the primary-site guard in the delete-orphan-unlink path (LLMO-6405 review).
  if (!postgrestClient?.from || !hasText(brandId) || !hasText(organizationId)) {
    throw new Error('getBrandBaseSiteId: organizationId, brandId, and a postgrest client are all required');
  }

  const { data, error } = await postgrestClient
    .from('brands')
    .select('site_id')
    .eq('organization_id', organizationId)
    .eq('id', brandId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get brand primary site: ${error.message}`);
  }
  return data?.site_id ?? null;
}

/**
 * Reads a brand's aliases (the `brand_aliases` rows) — the extra names the brand
 * is known by, beyond its display name — each with its `regions`. Returned as
 * `{ name, regions }[]` (empty when the brand has none), the shape the Semrush
 * create/sync path region-clamps per market (an alias only lands on the markets
 * its `regions` list; region-less applies everywhere). Rows with a blank alias
 * are skipped; de-duplicated by name (case-insensitive, first-seen wins).
 *
 * @param {string} brandId - Brand UUID.
 * @param {object} postgrestClient - PostgREST client.
 * @returns {Promise<{name: string, regions: string[]}[]>} aliases (empty when none).
 */
export async function getBrandAliases(brandId, postgrestClient) {
  if (!postgrestClient?.from || !hasText(brandId)) {
    return [];
  }
  const { data, error } = await postgrestClient
    .from('brand_aliases')
    .select('alias, regions')
    .eq('brand_id', brandId);
  if (error) {
    throw new Error(`Failed to get brand aliases: ${error.message}`);
  }
  const seen = new Set();
  const out = [];
  for (const row of data || []) {
    const name = hasText(row?.alias) ? row.alias : null;
    if (name === null) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    seen.add(key);
    out.push({ name, regions: row.regions || [] });
  }
  return out;
}

/**
 * Reads a brand's URL sources — the user-submitted brand URLs, social accounts,
 * and earned-content sources — for propagation to the brand's Semrush projects.
 * Returned in the same V2 shape the create payload carries, so the same
 * `collectBrandUrlEntries` helper handles both the create body and a persisted
 * brand. `urls` carry no region (they apply to every market); social/earned
 * carry `regions` for per-market filtering. Empty arrays when the brand has none.
 *
 * @param {string} brandId - Brand UUID.
 * @param {object} postgrestClient - PostgREST client.
 * @returns {Promise<{urls: object[], socialAccounts: object[], earnedContent: object[]}>}
 */
export async function getBrandUrlSources(brandId, postgrestClient) {
  const empty = { urls: [], socialAccounts: [], earnedContent: [] };
  if (!postgrestClient?.from || !hasText(brandId)) {
    return empty;
  }
  const { data, error } = await postgrestClient
    .from('brands')
    .select('brand_urls(url), brand_social_accounts(url, regions), brand_earned_sources(url, regions)')
    .eq('id', brandId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to get brand URL sources: ${error.message}`);
  }
  if (!data) {
    return empty;
  }
  return {
    urls: (data.brand_urls || []).map((u) => ({ value: u.url })),
    socialAccounts: (data.brand_social_accounts || [])
      .map((s) => ({ url: s.url, regions: s.regions || [] })),
    earnedContent: (data.brand_earned_sources || [])
      .map((e) => ({ url: e.url, regions: e.regions || [] })),
  };
}

/**
 * Reads a brand's competitors ("other brands to track") for propagation to the
 * brand's Semrush projects as benchmarks. Returns `{ name, url, aliases, regions }`
 * per competitor: the benchmark is domain-keyed (from `url`) but also carries the
 * competitor's `brand_name` (from `name`) and `brand_aliases` (from `aliases`), and
 * `regions` region-filters which markets track it. Empty array when the brand has
 * none.
 *
 * @param {string} brandId - Brand UUID.
 * @param {object} postgrestClient - PostgREST client.
 * @returns {Promise<{name: string, url: string, aliases: string[], regions: string[]}[]>}
 */
export async function getBrandCompetitors(brandId, postgrestClient) {
  if (!postgrestClient?.from || !hasText(brandId)) {
    return [];
  }
  const { data, error } = await postgrestClient
    .from('competitors')
    .select('name, url, aliases, regions')
    .eq('brand_id', brandId);
  if (error) {
    throw new Error(`Failed to get brand competitors: ${error.message}`);
  }
  return (data || [])
    .filter((c) => hasText(c?.url))
    .map((c) => ({
      name: c.name,
      url: c.url,
      aliases: c.aliases || [],
      regions: c.regions || [],
    }));
}

/**
 * Resolves the single active brand for a given (organization, site) pair.
 *
 * Lookup is `brands.site_id === siteId` AND `status === 'active'` AND
 * `organization_id === organizationId`. `brands.site_id` is the authoritative
 * mapping from a brand to its primary site — set during v2 onboarding. Per
 * LLMO-4592, ACTIVE brands have a unique `(organization_id, site_id)` pair
 * when site_id is set.
 *
 * `brand_sites` is intentionally NOT used here: that join table also stores
 * citation entries (sites the brand mentions), so a `brand_sites` row
 * matching `site_id` does not mean the brand IS the brand for that site.
 * Brands missing `site_id` are not considered v2-onboarded for this site
 * and resolve to null (404 at the endpoint).
 *
 * If the data violates the LLMO-4592 invariant and multiple ACTIVE brands
 * match, the first row (deterministic, ordered by name) is returned and a
 * warning is logged so monitoring can surface the data integrity issue.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} siteId - Site UUID
 * @param {object} postgrestClient - PostgREST client
 * @param {object} [log] - Optional logger for the multi-match warning path
 * @returns {Promise<object|null>} Brand in V2 config shape or null
 */
export async function getBrandBySite(organizationId, siteId, postgrestClient, log) {
  if (!postgrestClient?.from || !hasText(organizationId) || !hasText(siteId)) {
    return null;
  }

  const { data, error } = await postgrestClient
    .from('brands')
    .select(BRAND_SELECT)
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .eq('site_id', siteId)
    .order('name', { ascending: true });

  if (error) {
    throw new Error(`Failed to resolve brand for site: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return null;
  }

  if (data.length > 1) {
    log?.warn?.(
      `Multiple active brands for org ${organizationId} site ${siteId} `
      + `(LLMO-4592 invariant violation): picking ${data[0].id} deterministically`,
    );
  }
  return mapDbBrandToV2(data[0]);
}

/**
 * Sets the brand-scoped `brand_claims_enabled` scheduling gate (LLMO-5741),
 * keyed on the brand UUID (the PK), so operators can enable/disable Brand Claims
 * for a brand directly. Returns the updated `{ id, name, site_id }` or null when
 * no brand matches the id. `site_id` (the brand's primary site) lets callers keep
 * the per-site `brand-claims` audit toggle in lock-step with this flag.
 *
 * @param {Object} params
 * @param {string} params.brandId - Brand UUID.
 * @param {boolean} params.enabled - Target flag value.
 * @param {Object} params.postgrestClient - PostgREST client.
 * @param {string} [params.updatedBy] - Audit actor.
 * @returns {Promise<{id: string, name: string, site_id: string|null}|null>}
 */
export async function setBrandClaimsEnabled({
  brandId,
  enabled,
  postgrestClient,
  updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  if (!hasText(brandId)) {
    return null;
  }

  const { data, error } = await postgrestClient
    .from('brands')
    .update({ brand_claims_enabled: enabled, updated_by: updatedBy })
    .eq('id', brandId)
    // Do not flip the flag on a soft-deleted brand (matches the .neq guard used
    // across brands-storage); a deleted brand returns no row -> null.
    .neq('status', 'deleted')
    .select('id, name, site_id')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to update brand claims flag: ${error.message}`);
  }
  return data || null;
}

/**
 * True when the site is a Semrush market mirror — i.e. it is linked to a brand
 * via a `brand_sites` row tagged `type='serenity'`. These rows are written ONLY
 * for Semrush-managed brands (see `ensureMarketSite`), so a hit means the site's
 * base_url is pinned to a Semrush project domain and must be treated as immutable.
 *
 * This is the second linkage path the URL-immutability guard must check:
 * `getBrandBySite` resolves a brand only via `brands.site_id` (the brand's OWN
 * primary site), but a serenity brand shell has no `site_id` — its market sites
 * are reachable only through `brand_sites`. Checking only `getBrandBySite` would
 * leave every market mirror's URL editable and free to desync from Semrush.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} siteId - Site UUID
 * @param {object} postgrestClient - PostgREST client
 * @returns {Promise<boolean>} true when a serenity-typed brand_sites row exists
 */
export async function isSemrushMarketMirrorSite(organizationId, siteId, postgrestClient) {
  if (!postgrestClient?.from || !hasText(organizationId) || !hasText(siteId)) {
    return false;
  }

  const { data, error } = await postgrestClient
    .from('brand_sites')
    .select('site_id')
    .eq('organization_id', organizationId)
    .eq('site_id', siteId)
    .eq('type', SERENITY_BRAND_SITE_TYPE)
    .limit(1);

  if (error) {
    throw new Error(`Failed to resolve market-mirror link for site: ${error.message}`);
  }

  return Array.isArray(data) && data.length > 0;
}

/**
 * Lightweight lookup of every brand id linked to a site within an org — the
 * union of the brand whose OWN primary site this is (`brands.site_id`) and any
 * brand that lists it via `brand_sites`. Used by resource-aware authorization
 * (e.g. `AccessControlUtil.hasLlmoCapabilityForSite`) to map a `:siteId` route
 * to the LLMO ReBAC `brand` resource(s), then check state-layer grants on them.
 *
 * Selects ids only (no child-table joins) — cheaper than `getBrandBySite`, and
 * returns all linked brands rather than the single primary one.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} siteId - Site UUID
 * @param {object} postgrestClient - PostgREST client
 * @returns {Promise<Set<string>>} brand ids linked to the site (empty when none)
 */
export async function listBrandIdsForSite(organizationId, siteId, postgrestClient) {
  if (!postgrestClient?.from || !hasText(organizationId) || !hasText(siteId)) {
    return new Set();
  }

  const [ownRes, linkedRes] = await Promise.all([
    postgrestClient
      .from('brands')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .eq('site_id', siteId),
    postgrestClient
      .from('brand_sites')
      .select('brand_id')
      .eq('organization_id', organizationId)
      .eq('site_id', siteId),
  ]);

  if (ownRes.error) {
    throw new Error(`Failed to resolve brands for site: ${ownRes.error.message}`);
  }
  if (linkedRes.error) {
    throw new Error(`Failed to resolve brand-site links for site: ${linkedRes.error.message}`);
  }

  const ids = new Set();
  (ownRes.data || []).forEach((row) => hasText(row.id) && ids.add(row.id));
  (linkedRes.data || []).forEach((row) => hasText(row.brand_id) && ids.add(row.brand_id));
  return ids;
}

/**
 * Inverse of {@link listBrandIdsForSite}: given a set of brand ids, resolve
 * every site within the org linked to at least one of them — the union of the
 * brands' OWN primary sites (`brands.site_id`) and any `brand_sites` links.
 *
 * Used by ReBAC-filtered collection endpoints (list-sites, list-projects) under
 * a `brand`-scoped product (LLMO) to narrow the org's sites to those the caller
 * may view, by first resolving the caller's viewable brands then mapping those
 * brands back to sites. Two org-scoped reads regardless of collection size —
 * scales with the (small) set of viewable brands, never a per-site N+1.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {Set<string>|string[]} brandIds - brand ids the caller may view
 * @param {object} postgrestClient - PostgREST client
 * @returns {Promise<Set<string>>} site ids linked to any of `brandIds` (empty when none)
 */
export async function listSiteIdsForBrands(organizationId, brandIds, postgrestClient) {
  const ids = [...(brandIds ?? [])].filter(hasText);
  if (!postgrestClient?.from || !hasText(organizationId) || ids.length === 0) {
    return new Set();
  }

  const [ownRes, linkedRes] = await Promise.all([
    postgrestClient
      .from('brands')
      .select('site_id')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .in('id', ids),
    postgrestClient
      .from('brand_sites')
      .select('site_id')
      .eq('organization_id', organizationId)
      .in('brand_id', ids),
  ]);

  if (ownRes.error) {
    throw new Error(`Failed to resolve sites for brands: ${ownRes.error.message}`);
  }
  if (linkedRes.error) {
    throw new Error(`Failed to resolve brand-site links for brands: ${linkedRes.error.message}`);
  }

  const siteIds = new Set();
  (ownRes.data || []).forEach((row) => hasText(row.site_id) && siteIds.add(row.site_id));
  (linkedRes.data || []).forEach((row) => hasText(row.site_id) && siteIds.add(row.site_id));
  return siteIds;
}

// normalizeBrandName is the canonical brand-name comparison key. It is defined
// once in ./normalize-brand-name.js and shared with the detection-side reconcile
// report (scripts/reconcile-org-identity-integrity.mjs) so prevention and
// detection can never drift. Re-exported here to preserve the existing public
// import surface (`import { normalizeBrandName } from './brands-storage.js'`).
export { normalizeBrandName };

/**
 * LLMO-7284 (AC13): prevent a SECOND active brand with the same normalized name in one
 * organization at WRITE time — prevention, not post-hoc detection. The DB's
 * `uq_brand_name_per_org` unique constraint only rejects EXACT `(organization_id, name)`
 * collisions, so whitespace/casing variants ("Acme Inc" vs "acme  inc") slip past it and
 * are exactly what scripts/reconcile-org-identity-integrity.mjs reports after the fact.
 * This closes that gap at the two moments an active identity is created: an active
 * create/upsert (upsertBrand) and a promotion/rename to active (updateBrand).
 *
 * Enforced in the application layer rather than as a DB constraint deliberately: a
 * normalized-name partial unique index would require prod to already be free of the very
 * duplicates the report exists to surface (an ADD ... VALIDATE would otherwise fail), and
 * the duplicate-brand DB work tracked under SITES-49449 is a separate migration effort.
 * See the PR description for the full rationale.
 *
 * Fails CLOSED on a lookup error (same rationale as the LLMO-5556 existing-brand guard):
 * a swallowed error must not be read as "no duplicate" and let one through.
 *
 * @param {object} params
 * @param {object} params.postgrestClient
 * @param {string} params.organizationId
 * @param {string} params.name              the name the brand will hold once written
 * @param {string} [params.excludeBrandId]  the brand being written — its own row must not
 *                                           be counted as its own duplicate
 * @param {object} [params.log]             logger for the block/truncation breadcrumbs
 * @throws {Error} `.status=409`, `.code='brand_duplicate_active_name'` on a collision
 */
// TODO(SITES-49449): remove this app-layer scan once the normalized-name partial
// unique index lands and prod is de-duped — the DB then holds the invariant and a
// second (drift-prone) enforcement point here becomes redundant cost.
export async function assertNoDuplicateActiveBrandName({
  postgrestClient,
  organizationId,
  name,
  excludeBrandId = null,
  log = console,
}) {
  const normalized = normalizeBrandName(name);
  // An empty/whitespace-only name is rejected by the callers' own name validation;
  // there is nothing to compare, and comparing "" would match other blank rows.
  if (!normalized) {
    return;
  }

  let query = postgrestClient
    .from('brands')
    .select('id, name')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    // Bound the scan so a PostgREST db-max-rows cap cannot SILENTLY truncate it and
    // let a normalized twin beyond the cap slip through (which would make this
    // fail-closed guard fail OPEN). ACTIVE_BRAND_SCAN_LIMIT is far above any real
    // active-brands-per-org count; hitting it means misconfiguration, so we fail
    // closed loudly below rather than validate a partial view.
    .limit(ACTIVE_BRAND_SCAN_LIMIT);
  if (hasText(excludeBrandId)) {
    query = query.neq('id', excludeBrandId);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to check for a duplicate active brand named "${name}": ${error.message}`);
  }
  if ((data || []).length >= ACTIVE_BRAND_SCAN_LIMIT) {
    // Fail CLOSED: a full page means the scan may be truncated, so we cannot prove
    // uniqueness. Rejecting is safer than admitting a possible duplicate silently.
    throw new Error(
      `Active-brand duplicate scan for org ${organizationId} returned the full `
      + `${ACTIVE_BRAND_SCAN_LIMIT}-row cap; the result may be truncated and `
      + 'uniqueness cannot be verified. Aborting the write (investigate db-max-rows / '
      + 'the org\'s active-brand count).',
    );
  }

  const clash = (data || []).find((b) => normalizeBrandName(b.name) === normalized);
  if (clash) {
    // Live ops breadcrumb: the after-the-fact reconcile report also catches this,
    // but a warn here surfaces a blocked duplicate at the moment it happens.
    log?.warn?.(
      `[llmo-7284] blocked a duplicate active brand in org ${organizationId}: `
      + `"${name}" collides with existing "${clash.name}" (normalized-equal).`,
    );
    const err = new Error(
      `An active brand named "${clash.name}" already exists in this organization `
      + '(brand names are compared case- and whitespace-insensitively). '
      + 'Rename the brand or reuse the existing one.',
    );
    err.status = 409;
    err.code = 'brand_duplicate_active_name';
    throw err;
  }
}

/**
 * Creates or updates a brand in the normalized brands table,
 * including all nested child tables (aliases, competitors, social, earned, sites).
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {object} params.brand - Brand data in V2 config shape
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @param {object} [params.log] - Logger (defaults to console).
 * @param {string|null} [params.forceBrandId] - Pre-generated brand id to persist
 *   (serenity-first provisioning); null lets the DB generate it.
 * @param {string|null} [params.semrushSubWorkspaceId] - Provisioned sub-workspace
 *   pointer to persist atomically with the row; null keeps the brand in flat mode.
 * @returns {Promise<object>} Created/updated brand in V2 config shape
 */
export async function upsertBrand({
  organizationId,
  brand,
  postgrestClient,
  updatedBy = 'system',
  log = console,
  // Serenity-first provisioning: when a brand is created in Semrush-prompts mode
  // the sub-workspace + project are provisioned BEFORE the row is written, so the
  // controller supplies the pre-generated brand id (used as the sub-workspace
  // title key) and the resulting sub-workspace pointer to persist atomically with
  // the row. Both default to null (normal create — DB generates the id, the brand
  // stays in flat mode). These are explicit params, NOT read from `brand`, so a
  // client-supplied id can never force a row id.
  forceBrandId = null,
  semrushSubWorkspaceId = null,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }
  if (!hasText(brand?.name)) {
    throw new Error('Brand name is required');
  }

  const regions = (brand.region || [])
    .map((r) => (typeof r === 'string' ? r : String(r))).filter(hasText);

  // Check if a non-deleted brand already exists with this name. Soft-deleted
  // brands are excluded (.neq('status', 'deleted')) so that creating a brand
  // whose name matches a deleted record is treated as a fresh create — the
  // caller gets the expected new brand instead of a resurrected row that
  // inherits the deleted brand's site_id and anchoring state (LLMO-5919).
  const { data: existing, error: existingError } = await postgrestClient
    .from('brands')
    .select('id, site_id, status')
    .eq('organization_id', organizationId)
    .eq('name', brand.name)
    .neq('status', 'deleted')
    .maybeSingle();

  // Fail closed (LLMO-5556): PostgREST returns { data: null, error } on a query
  // failure instead of throwing. If we ignored the error, `existing` would be
  // null and the immutability guard below would treat the brand as new — letting
  // a transient failure overwrite an existing primary site. Surface the error
  // instead so the caller (and SQS retry) handles it rather than guessing.
  if (existingError) {
    throw new Error(`Failed to look up existing brand "${brand.name}": ${existingError.message}`);
  }

  // An active brand must be anchored by a SpaceCat base site (chk_active_brand_has_site_id,
  // SITES-49449). A Semrush sub-workspace brand is NOT exempt from this — the
  // brand/market management model (LLMO-6405) makes site_id mandatory on every
  // create path, subworkspace mode or not, so semrush_sub_workspace_id is no
  // longer a substitute anchor. Respect persisted site_id on the update path.
  const hasAnchor = hasText(brand.baseSiteId) || hasText(existing?.site_id);
  const status = (!hasAnchor && (brand.status || 'active') === 'active')
    ? 'pending'
    : (brand.status || 'active');

  // LLMO-5587: a by-name upsert that resolves onto an existing *active* brand must
  // not silently demote it to pending — that is the express.adobe.com vector (a
  // create/re-upsert colliding on (org, name) with a stale/pending status). Intentful
  // demotions go through setBrandStatus / PATCH /v2/orgs/{org}/brands/{id}/status.
  if (status === 'pending' && existing?.status === 'active') {
    const err = new Error(
      `Brand "${brand.name}" already exists and is active; demoting it to pending `
      + `must go through PATCH /v2/orgs/${organizationId}/brands/${existing.id}/status.`,
    );
    err.status = 409;
    err.code = 'brand_status_demotion_not_allowed';
    throw err;
  }

  // LLMO-7284 (AC13): a create/upsert that produces a NET-NEW active identity must
  // not introduce a second active brand with the same normalized name in this org.
  // Only fire for a fresh create or a pending->active upsert (`existing?.status !==
  // 'active'`): `name` is the upsert conflict key and cannot change here, so
  // re-saving an ALREADY-active row by its own exact name introduces no new
  // normalized identity — checking it would wrongly 409 a verbatim re-onboard in an
  // org that already holds a pre-existing normalized-duplicate twin (the exact dirty
  // data the reconcile report surfaces), wedging SQS-retried re-syncs. Excludes the
  // same-name `existing` row for the same reason. The exact-name lookup above and the
  // DB's `uq_brand_name_per_org` both miss a DIFFERENT exact name that normalizes to
  // the same value; this closes that gap. Best-effort against a concurrent create of
  // a normalized twin (read-then-write, no DB backstop for the normalized case — the
  // partial unique index is deferred); the exact-name race is still caught by the DB.
  if (status === 'active' && existing?.status !== 'active') {
    await assertNoDuplicateActiveBrandName({
      postgrestClient,
      organizationId,
      name: brand.name,
      excludeBrandId: existing?.id,
      log,
    });
  }

  const row = {
    organization_id: organizationId,
    name: brand.name,
    status,
    origin: brand.origin || 'human',
    description: brand.description || null,
    vertical: brand.vertical || null,
    regions,
    // Clear legacy array columns — data now lives in normalized tables.
    earned_sources: [],
    social: [],
    updated_by: updatedBy,
  };

  // Serenity-first create: force the pre-generated id (so the row matches the
  // sub-workspace title key) and bind the brand to its sub-workspace in the same
  // write. Both only ever set on a fresh Semrush-mode create.
  if (hasText(forceBrandId)) {
    row.id = forceBrandId;
  }
  if (hasText(semrushSubWorkspaceId)) {
    row.semrush_sub_workspace_id = semrushSubWorkspaceId;
  }

  const brandContext = normalizeNullableText(brand.brandContext, 'brandContext');
  if (brandContext !== undefined) {
    row.brand_context = brandContext;
  }

  const mentionSentimentGuidance = normalizeNullableText(
    brand.mentionSentimentGuidance,
    'mentionSentimentGuidance',
  );
  if (mentionSentimentGuidance !== undefined) {
    row.mention_sentiment_guidance = mentionSentimentGuidance;
  }

  // baseSiteId is immutable once persisted (mirrors updateBrand). Only set it
  // when the brand has no site_id yet — re-onboarding/re-upserting an existing
  // brand by name must NOT re-point its primary site (LLMO-5556: this silently
  // overwrote mongodb.com -> learn.mongodb.com and merck.com -> keytruda.com).
  // LLMO-5919: soft-deleted brands are now excluded from `existing` (see filter
  // above), so `existing === null` covers both fresh creates and resurrections.
  // In both cases we always write an explicit site_id — or null to clear the
  // deleted brand's stale anchor so it cannot survive the ON CONFLICT UPDATE
  // and collide with whichever brand now owns that site.
  // LLMO-6405: a Semrush-anchored (serenity-first) create now ALSO carries a
  // primary site — the UI's primary-URL step selects an onboarded Site and sends
  // its baseSiteId, so brands.site_id is populated on every path (a Semrush brand
  // is anchored by BOTH its sub-workspace AND its primary site). The previous skip
  // (which left Semrush brands' site_id NULL) is removed; a genuine collision with
  // another brand's primary site still surfaces as the brands_base_site_unique 409
  // handled below.
  // serenity-docs#346: a brand's primary site must belong to the same org as the
  // brand itself — anchoring to another org's site is exactly the org-ID mismatch
  // pattern the investigation traced (Tata Capital, BMW, Toyota, ...). Verify on
  // both paths that assign a *new* anchor (fresh create, or first anchor for a
  // previously Semrush-only brand); the immutable-once-set branch below is
  // unaffected since it already refuses to change an existing site_id.
  const wantsNewAnchor = hasText(brand.baseSiteId)
    && (existing === null || !hasText(existing.site_id));
  if (wantsNewAnchor) {
    await assertSiteBelongsToOrg(postgrestClient, brand.baseSiteId, organizationId, brand.name);
  }

  if (existing === null || !hasText(existing.site_id)) {
    // Fresh create, or first anchor for a previously unanchored brand: assign
    // whatever baseSiteId the caller supplied (or leave unset if they didn't).
    row.site_id = hasText(brand.baseSiteId) ? brand.baseSiteId : null;
  } else {
    // Already anchored (existing.site_id is set) — site_id is immutable once
    // persisted, so this call never changes it. But it MUST still be carried
    // forward into `row` explicitly: this upsert always goes through
    // `.upsert(row, { onConflict: 'organization_id,name' })`, and a column
    // absent from that payload is not preserved on the resulting UPDATE — it
    // ends up unset on the written row. Before this fix, re-submitting the
    // brand's OWN already-correct baseSiteId (the common case: any caller
    // that reads a brand back and re-upserts it verbatim) omitted site_id
    // from every one of the three prior branches, silently clearing an
    // already-anchored brand's site_id and tripping
    // chk_active_brand_has_site_id — a 400 on a request that never intended
    // to touch the anchor at all. Found via a brandalf migration script
    // re-upserting already-onboarded brands (Grainger, Druva, Interface, ABB,
    // Arkose Labs all hit this identically).
    if (hasText(brand.baseSiteId) && brand.baseSiteId !== existing.site_id) {
      log.warn(`upsertBrand: ignoring baseSiteId change for brand "${brand.name}" `
        + `(org ${organizationId}) — primary site is immutable `
        + `(existing=${existing.site_id}, attempted=${brand.baseSiteId})`);
    }
    row.site_id = existing.site_id;
  }

  const { data: upserted, error } = await postgrestClient
    .from('brands')
    .upsert(row, { onConflict: 'organization_id,name' })
    .select('id, name')
    .single();

  if (error) {
    if (error.code === '23505' && error.message?.includes('brands_base_site_unique')) {
      const err = new Error('This site is already the primary URL for another brand');
      err.status = 409;
      throw err;
    }
    rethrowCheckViolation(error, `Failed to upsert brand: ${error.message}`);
  }

  const brandId = upserted.id;

  await Promise.all([
    syncAliases(brandId, organizationId, brand.brandAliases, postgrestClient, updatedBy),
    syncCompetitors(brandId, organizationId, brand.competitors, postgrestClient, updatedBy),
    syncSocialAccounts(brandId, organizationId, brand.socialAccounts, postgrestClient, updatedBy),
    syncEarnedSources(brandId, organizationId, brand.earnedContent, postgrestClient, updatedBy),
  ]);

  if (brand.urls !== undefined) {
    await Promise.all([
      syncBrandSites(organizationId, brandId, brand.urls, postgrestClient, updatedBy),
      syncBrandUrls(organizationId, brandId, brand.urls, postgrestClient, updatedBy),
    ]);
  }

  return getBrandById(organizationId, brandId, postgrestClient);
}

/**
 * Updates a brand by its UUID.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.brandId - Brand UUID
 * @param {object} params.updates - Partial brand data in V2 config shape
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @returns {Promise<object|null>} Updated brand or null if not found
 */
export async function updateBrand({
  organizationId,
  brandId,
  updates,
  postgrestClient,
  updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const patch = { updated_by: updatedBy };

  if (updates.name !== undefined) {
    patch.name = updates.name;
  }
  if (updates.status !== undefined) {
    patch.status = updates.status;
  }
  if (updates.origin !== undefined) {
    patch.origin = updates.origin;
  }
  if (updates.description !== undefined) {
    patch.description = updates.description;
  }
  if (updates.brandContext !== undefined) {
    patch.brand_context = normalizeNullableText(updates.brandContext, 'brandContext');
  }
  if (updates.mentionSentimentGuidance !== undefined) {
    patch.mention_sentiment_guidance = normalizeNullableText(
      updates.mentionSentimentGuidance,
      'mentionSentimentGuidance',
    );
  }
  if (updates.vertical !== undefined) {
    patch.vertical = updates.vertical;
  }

  // Fetch the persisted row once when baseSiteId or status is changing — it feeds
  // the baseSiteId mutation rules, the active->pending demotion guard, and the
  // active-without-site guard below. (Existing-fetch pattern adapted from Igor
  // Grubic's #2504, broadened from site_id-only to also read `status`.)
  // LLMO-5870: an explicit `baseSiteId: null` is an unset request — fetch the row
  // so `existing.status` is available to gate the clear on pending brands.
  const wantsClearBaseSite = updates.baseSiteId === null;
  const needsExistingFetch = hasText(updates.baseSiteId)
    || wantsClearBaseSite
    || updates.status !== undefined
    || updates.name !== undefined // LLMO-7284: a rename needs the current name+status
    || updates.expectedUpdatedAt !== undefined;
  let existing = null;
  if (needsExistingFetch) {
    const { data: current, error: currentError } = await postgrestClient
      .from('brands')
      .select('name, site_id, status, updated_at')
      .eq('id', brandId)
      .maybeSingle();
    // Fail closed: a swallowed read error leaves `current` null, so the guard
    // below would treat the brand as having no site_id and re-point the
    // immutable site_id on a transient failure (the LLMO-5556 regression this
    // block guards against). Throw instead of silently corrupting the link.
    if (currentError) {
      throw new Error(`Failed to read current baseSiteId for brand: ${currentError.message}`);
    }
    existing = current;
  }

  // LLMO-6591: optimistic concurrency. A caller that read the brand and echoes
  // that read's `updatedAt` back on save is telling us what it thinks the
  // current state is; if the row moved since then (another tab/request wrote
  // in between), a routine save must not blindly overwrite fields — including
  // collections it never touched but whose stale, empty local copy would
  // otherwise wipe real data on the very next PATCH. Opt-in and backward
  // compatible: omitting `expectedUpdatedAt` skips this check entirely, so
  // existing callers are unaffected until they start sending it.
  //
  // This early check is a FAST-FAIL for the common case (an obviously-stale
  // read), not the actual concurrency guarantee — it is a plain read-then-compare
  // and is itself racy: two requests reading the same `updated_at` within this
  // window would both pass it. The real guarantee is the `.eq('updated_at', ...)`
  // predicate added to the UPDATE statement below, which Postgres evaluates
  // atomically against the row as it exists at write time. `brands` has an
  // unconditional `BEFORE UPDATE ... update_updated_at()` trigger (every write
  // bumps it), so that predicate reliably fails when — and only when — another
  // write landed in between. `expectedUpdatedAtChecked` (below) lets the
  // post-update branch tell "predicate failed because of a race" apart from
  // "row doesn't exist", since both otherwise look identical (`data` is null).
  let expectedUpdatedAtChecked = false;
  if (updates.expectedUpdatedAt !== undefined && existing) {
    expectedUpdatedAtChecked = true;
    const expected = new Date(updates.expectedUpdatedAt).getTime();
    const actual = new Date(existing.updated_at).getTime();
    if (Number.isNaN(expected) || expected !== actual) {
      const err = new Error(
        'This brand was changed since it was loaded - reload and reapply your edit.',
      );
      err.status = 409;
      err.code = 'brand_stale_write';
      throw err;
    }
  }

  // baseSiteId mutation rules:
  //  - First set (NULL -> value): allowed for any brand.
  //  - Re-point (value -> different value): allowed for ANY brand via THIS explicit
  //    updateBrand path (serenity-docs#349). A user deliberately picks an existing
  //    Site in the org to become the brand's primary site, and the controller
  //    (updateBrandForOrg) validates eligibility + drives the Semrush propagation
  //    before this write. This is the sanctioned re-point path — NOT to be confused
  //    with the SILENT overwrite guard that stays in upsertBrand (the automated
  //    re-onboard path, LLMO-5556: mongodb.com -> learn.mongodb.com etc.), which
  //    still refuses to move an existing site_id.
  //  - Clear (value -> NULL): allowed ONLY for pending brands, so the site can be
  //    freed for reuse by another brand. Active brands keep chk_active_brand_has_site_id.
  // The partial unique index (brands_base_site_unique) skips NULLs and still rejects
  // a re-point that collides with another brand's primary URL at the DB level.
  const isPending = (existing?.status || '').toLowerCase() === 'pending';
  if (wantsClearBaseSite) {
    if (isPending) {
      patch.site_id = null;
    }
  } else if (hasText(updates.baseSiteId) && updates.baseSiteId !== existing?.site_id) {
    // serenity-docs#346: same org-ID mismatch guard as upsertBrand — verify the
    // new/re-pointed site actually belongs to this brand's org before persisting.
    const brandLabel = existing?.name || brandId;
    await assertSiteBelongsToOrg(postgrestClient, updates.baseSiteId, organizationId, brandLabel);
    patch.site_id = updates.baseSiteId;
  }

  // LLMO-5587: the generic update path must not demote an active brand to pending.
  // A routine field save that echoes a stale `status` is the express.adobe.com
  // vector; intentful demotions go through setBrandStatus (the /status endpoint).
  if (patch.status === 'pending' && existing?.status === 'active') {
    const err = new Error(
      'Demoting an active brand to pending must go through '
      + `PATCH /v2/orgs/${organizationId}/brands/${brandId}/status.`,
    );
    err.status = 409;
    err.code = 'brand_status_demotion_not_allowed';
    throw err;
  }

  // Re-landed from Igor Grubic's #2504 (LLMO-5183): an active brand must have a base
  // site. Reject a promote-to-active that would leave site_id NULL with a typed 400
  // rather than surfacing the data-layer CheckViolation as a generic 500.
  if (patch.status === 'active') {
    // A clear-and-activate in the same PATCH must not lean on the old site_id —
    // treat the brand as site-less so it returns the typed 400 below rather than
    // letting the DB CheckViolation surface as a 500 (LLMO-5870).
    const hasBaseSite = hasText(patch.site_id)
      || (hasText(existing?.site_id) && !wantsClearBaseSite);
    if (!hasBaseSite) {
      const err = new Error(
        'Cannot activate a brand without a base site URL — set baseSiteId in the same PATCH.',
      );
      err.status = 400;
      throw err;
    }
  }

  // LLMO-7284 (AC13): the write must not leave a second active brand with the same
  // normalized name in this org. Two distinct new-active-identity events are checked
  // (a routine save that echoes status:'active' with no rename is a no-op and skipped):
  //   1. a genuine promotion (pending->active), and
  //   2. a RENAME of an already-active brand to a different normalized name.
  // `existing` is guaranteed loaded here (needsExistingFetch covers both status and
  // name changes). Excludes this brand's own row. Best-effort against a concurrent
  // twin (read-then-write, no DB backstop for the normalized case).
  const isPromotion = patch.status === 'active' && existing?.status !== 'active';
  const willBeActive = patch.status === 'active'
    || (patch.status === undefined && existing?.status === 'active');
  const isActiveRename = willBeActive
    && hasText(patch.name)
    && normalizeBrandName(patch.name) !== normalizeBrandName(existing?.name);
  if (isPromotion || isActiveRename) {
    const resultingName = hasText(patch.name) ? patch.name : existing?.name;
    await assertNoDuplicateActiveBrandName({
      postgrestClient,
      organizationId,
      name: resultingName,
      excludeBrandId: brandId,
    });
  }

  if (updates.region !== undefined) {
    patch.regions = (updates.region || [])
      .map((r) => (typeof r === 'string' ? r : String(r))).filter(hasText);
  }

  // Clear legacy columns on any brand update so old data doesn't linger.
  patch.social = [];
  patch.earned_sources = [];

  // LLMO-6591: the actual compare-and-swap. Adding the predicate directly on
  // the UPDATE (rather than trusting the earlier read-then-compare) means
  // Postgres evaluates it atomically against the row as it exists at write
  // time — a concurrent write that lands between our read and this statement
  // changes `updated_at` (the unconditional BEFORE UPDATE trigger guarantees
  // that), so this predicate then matches zero rows instead of silently
  // succeeding. Equality is Postgres's own timestamptz comparison, not a JS
  // string compare, so it isn't sensitive to textual formatting differences
  // between what the client echoes back and what's stored.
  let updateQuery = postgrestClient
    .from('brands')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', brandId);
  if (updates.expectedUpdatedAt !== undefined) {
    updateQuery = updateQuery.eq('updated_at', updates.expectedUpdatedAt);
  }
  // serenity-docs#349 / #3131 follow-up (LLMO — live e2e on prod): select the SAME
  // wide embed getBrandById reads, directly off THIS UPDATE's own
  // `Prefer: return=representation` — PostgREST embeds resources on an UPDATE's
  // RETURNING exactly like it does on a GET. That makes `data` below a
  // guaranteed-fresh snapshot: it comes back on the very request that just
  // committed the write, and — confirmed against this env's Vault config
  // (`dx_mysticat/prod/api-service` POSTGREST_URL=`http://data-svc-balanced.internal`)
  // and mysticat-data-service's `reader.tf` ALB rules — every non-GET/HEAD/OPTIONS
  // request on that host lands on the writer fleet, no exceptions. A plain
  // follow-up `getBrandById()` call is a bare GET, and GETs on that same host ARE
  // routed to a *separate* PostgREST fleet reading Aurora's reader endpoint — a
  // real, independently-replicating replica with nonzero lag, not the same node
  // the write just landed on. That is the confirmed mechanism behind the
  // brand_repoint_not_persisted false-positive: the write commits on the writer,
  // but the very next GET can still be served stale data by the reader. Selecting
  // the full embed here means the common case (see below) never needs that
  // second, possibly-stale GET at all.
  const { data, error } = await updateQuery.select(BRAND_SELECT).maybeSingle();

  if (error) {
    if (error.code === '23505' && error.message?.includes('brands_base_site_unique')) {
      const err = new Error('This site is already the primary URL for another brand');
      err.status = 409;
      throw err;
    }
    rethrowCheckViolation(error, `Failed to update brand: ${error.message}`);
  }
  if (!data) {
    // The UPDATE matched zero rows. If we already confirmed via the pre-read
    // that the row existed with a matching `updated_at`, the row must have
    // changed between that read and this write — a genuine race the fast-fail
    // check above could not catch on its own. Anything else (no expectedUpdatedAt,
    // or the row never existed) is the pre-existing not-found case.
    if (expectedUpdatedAtChecked) {
      const err = new Error(
        'This brand was changed since it was loaded - reload and reapply your edit.',
      );
      err.status = 409;
      err.code = 'brand_stale_write';
      throw err;
    }
    return null;
  }

  // Each sync function now skips itself when its collection is `undefined`
  // (LLMO-6591), so the per-field `!== undefined` guards that used to live
  // here are redundant — call unconditionally and let the shared guard decide.
  await Promise.all([
    syncAliases(brandId, organizationId, updates.brandAliases, postgrestClient, updatedBy),
    syncCompetitors(brandId, organizationId, updates.competitors, postgrestClient, updatedBy),
    syncSocialAccounts(brandId, organizationId, updates.socialAccounts, postgrestClient, updatedBy),
    syncEarnedSources(brandId, organizationId, updates.earnedContent, postgrestClient, updatedBy),
  ]);

  if (updates.urls !== undefined) {
    await Promise.all([
      syncBrandSites(organizationId, brandId, updates.urls, postgrestClient, updatedBy),
      syncBrandUrls(organizationId, brandId, updates.urls, postgrestClient, updatedBy),
    ]);
  }

  // Whether a follow-up read is even needed depends on what this call actually
  // changed. `data` already reflects this UPDATE's own committed `brands` row —
  // including the `base_site` join that drives baseSiteId/baseUrl — with none of
  // the reader-replica staleness risk described above. A request that touched no
  // child-table collection can therefore return it directly: no second read, no
  // race, period.
  const childTablesTouched = updates.brandAliases !== undefined
    || updates.competitors !== undefined
    || updates.socialAccounts !== undefined
    || updates.earnedContent !== undefined
    || updates.urls !== undefined;

  if (!childTablesTouched) {
    return mapDbBrandToV2(data);
  }

  // The child-table syncs above ran as separate requests AFTER this UPDATE
  // committed, so their effect isn't part of `data`'s RETURNING payload — a
  // follow-up read is genuinely unavoidable to pick up aliases/competitors/
  // social/earned/urls. That follow-up is a plain GET, so on this host it CAN be
  // served by the lagging reader fleet described above. Rather than trust it for
  // the one field the #3131 safety net downstream actually gates on, override
  // baseSiteId/baseUrl with the values this call already knows are correct from
  // `data` — read back on the writer, in this same request, from the very UPDATE
  // that changed `site_id` (or deliberately left it unchanged). This makes the
  // re-point contract (returned baseSiteId always reflects the just-applied
  // write) hold unconditionally, regardless of how stale the follow-up read's
  // OTHER fields might transiently be.
  const freshRow = await getBrandById(organizationId, brandId, postgrestClient);
  if (!freshRow) {
    return null;
  }
  freshRow.baseSiteId = data.base_site?.id ?? data.site_id ?? null;
  freshRow.baseUrl = data.base_site?.base_url || null;
  return freshRow;
}

/**
 * Soft-deletes a brand, renaming it to `{name}_deleted` so its original name is
 * freed for reuse (LLMO-6978).
 *
 * The `brands` table has a per-org unique constraint on `name`
 * (`uq_brand_name_per_org`) that spans deleted rows, so a soft-deleted brand
 * that kept its original name would keep that name "taken" and block a customer
 * from recreating a brand with the same name. To avoid that, the delete renames
 * the brand to `{name}_deleted` in the same UPDATE that flips its status to
 * `deleted`. If a same-named deleted brand already exists in the org (e.g. the
 * customer created + deleted "Acme" more than once), an incrementing index is
 * appended (`{name}_deleted2`, `{name}_deleted3`, ...) until the name is free —
 * the only re-collision case is a customer literally naming a brand `..._deleted`.
 *
 * A brand that is already `deleted` short-circuits (returns true → idempotent
 * 204) WITHOUT re-renaming, so a repeated delete never double-suffixes an
 * already-renamed brand (`Acme_deleted` → `Acme_deleted_deleted`). Any other
 * status — including a NULL status, which the rest of the code treats as a live
 * brand — is renamed as normal. This early check is a JS `status === 'deleted'`
 * guard rather than a SQL `status != 'deleted'` filter, which would also
 * exclude NULL-status rows (`NULL <> 'deleted'` is NULL) and leave them
 * undeletable. To also close the read-then-write race, the UPDATE itself is
 * filtered with PostgREST `.not('status', 'eq', 'deleted')` — which DOES match
 * NULL-status rows — so a concurrent delete that already renamed the row turns
 * our UPDATE into a zero-row no-op (reported as success) instead of
 * re-suffixing it.
 *
 * A colliding rename surfaces as a `23505` on the per-org name constraint
 * (`uq_brand_name_per_org`, the only unique column this UPDATE touches), which
 * we resolve by advancing the index and retrying; any other 23505 is surfaced
 * rather than retried. Race-safe against concurrent deletes of same-named
 * brands (the rename is keyed by brand id, so a re-run recomputes the same
 * target and is idempotent).
 *
 * Backfilling brands deleted before this change (which kept their original
 * names) is a separate one-off data migration and is intentionally out of scope
 * here — this governs only the forward-looking delete path.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} brandId - Brand UUID
 * @param {object} postgrestClient - PostgREST client
 * @param {string} [updatedBy] - User performing the operation
 * @returns {Promise<boolean>} True if the brand is deleted (freshly soft-deleted,
 *   or already deleted — DELETE stays idempotent), false if no such brand exists
 */
export async function deleteBrand(organizationId, brandId, postgrestClient, updatedBy = 'system') {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  // Read the brand's current name (and status) so we can rename it on delete.
  const { data: brand, error: readError } = await postgrestClient
    .from('brands')
    .select('name, status')
    .eq('organization_id', organizationId)
    .eq('id', brandId)
    .maybeSingle();

  if (readError) {
    throw new Error(`Failed to delete brand: ${readError.message}`);
  }
  // Genuinely not found → false (404).
  if (!brand) {
    return false;
  }
  // Already soft-deleted → succeed idempotently (matches the pre-LLMO-6978
  // behavior where a repeat delete returned 204) WITHOUT re-renaming, so an
  // already-renamed name is never re-suffixed (`Acme_deleted_deleted`).
  if (brand.status === 'deleted') {
    return true;
  }

  // Try `{name}_deleted`, then `{name}_deleted2`, `{name}_deleted3`, ... until a
  // free name lands. A collision rejects the UPDATE with a 23505 (a same-named
  // brand was already deleted, or two deletes race) — advance the index and
  // retry rather than surfacing a 500. The UPDATE is keyed by brand id, so a
  // concurrent re-run recomputes the same target name and stays idempotent.
  for (let index = 1; index <= MAX_DELETED_NAME_ATTEMPTS; index += 1) {
    const deletedName = index === 1
      ? `${brand.name}_deleted`
      : `${brand.name}_deleted${index}`;

    // eslint-disable-next-line no-await-in-loop -- sequential retry on name collision
    const { error } = await postgrestClient
      .from('brands')
      .update({ status: 'deleted', name: deletedName, updated_by: updatedBy })
      .eq('organization_id', organizationId)
      .eq('id', brandId)
      // Make the write itself the concurrency guard: only a still-live row is
      // renamed. If a concurrent deleteBrand already flipped this row to
      // `deleted` between our SELECT above and this UPDATE, we match zero rows
      // instead of re-suffixing an already-renamed brand (`Acme_deleted` →
      // `Acme_deleted2`). PostgREST `.not(...eq...)` still matches NULL-status
      // rows (unlike a bare `status != 'deleted'`), so NULL-status live brands
      // stay deletable.
      .not('status', 'eq', 'deleted')
      .select('id')
      .maybeSingle();

    if (!error) {
      // Either we renamed + soft-deleted the row, OR a racing caller already
      // soft-deleted it so our status-guarded UPDATE matched zero rows — either
      // way the brand is now deleted, so report success idempotently.
      return true;
    }
    // A 23505 on our per-org name constraint means `{name}_deletedN` is taken —
    // advance the index and retry. Any other 23505 (a different unique
    // constraint) can't be resolved by renaming, so surface it immediately
    // rather than burning the whole retry budget on an unresolvable violation.
    if (error.code !== '23505' || !error.message?.includes('uq_brand_name_per_org')) {
      throw new Error(`Failed to delete brand: ${error.message}`);
    }
    // else: `{name}_deletedN` is taken — fall through and try the next index.
  }

  throw new Error(
    `Failed to delete brand: could not free the name "${brand.name}" after `
    + `${MAX_DELETED_NAME_ATTEMPTS} attempts`,
  );
}

/**
 * Explicitly sets a brand's lifecycle status (the intentful status-transition path,
 * e.g. approve -> active, move-to-pending -> pending).
 *
 * This is deliberately kept separate from updateBrand and minimal (status + updated_by
 * only, no child-table sync). The generic updateBrand path carries the active->pending
 * demotion guard (LLMO-5587); legitimate, intended transitions route through here so they
 * are not blocked by that guard.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.brandId - Brand UUID
 * @param {string} params.status - Target status ('active' | 'pending')
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @returns {Promise<object|null>} Updated brand in V2 shape, or null if not found
 */
export async function setBrandStatus({
  organizationId,
  brandId,
  status,
  postgrestClient,
  updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  // LLMO-7284 (AC13): promoting a brand to active via the intentful status-transition
  // path must also refuse to create a second active brand with the same normalized name
  // in this org (parity with updateBrand's promotion guard). Fetch the row first for its
  // name and current status, skip a no-op re-approval of an already-active brand, and let
  // a missing/soft-deleted brand fall through to the UPDATE below (which 404s on no row).
  if (status === 'active') {
    const { data: current, error: currentError } = await postgrestClient
      .from('brands')
      .select('name, status')
      .eq('organization_id', organizationId)
      .eq('id', brandId)
      .neq('status', 'deleted')
      .maybeSingle();
    if (currentError) {
      throw new Error(`Failed to read brand before status transition: ${currentError.message}`);
    }
    if (current && current.status !== 'active') {
      await assertNoDuplicateActiveBrandName({
        postgrestClient, organizationId, name: current.name, excludeBrandId: brandId,
      });
    }
  }

  const { data, error } = await postgrestClient
    .from('brands')
    .update({ status, updated_by: updatedBy })
    .eq('organization_id', organizationId)
    .eq('id', brandId)
    // Do not resurrect a soft-deleted brand via a status transition — a deleted
    // brand matches no row here, so the caller gets a 404 (use a dedicated
    // undelete flow if reactivation is ever needed).
    .neq('status', 'deleted')
    .select('id')
    .maybeSingle();

  if (error) {
    // Lifted from Igor Grubic's PR #2504 (LLMO-5183): the data layer enforces
    // chk_active_brand_has_site_id (an active brand must have a base site_id). Map the
    // CheckViolation to a typed 400 rather than surfacing a generic 500.
    if (error.code === '23514' && error.message?.includes('chk_active_brand_has_site_id')) {
      const err = new Error('Cannot activate a brand without a base site URL');
      err.status = 400;
      throw err;
    }
    throw new Error(`Failed to set brand status: ${error.message}`);
  }

  if (!data) {
    return null;
  }
  return getBrandById(organizationId, brandId, postgrestClient);
}

/**
 * Lists all regions (available markets) from the regions reference table.
 *
 * @param {object} postgrestClient - PostgREST client
 * @returns {Promise<object[]>} Array of { code, name }
 */
export async function listRegions(postgrestClient) {
  if (!postgrestClient?.from) {
    return [];
  }

  const { data, error } = await postgrestClient
    .from('regions')
    .select('code, name')
    .order('code', { ascending: true });

  if (error) {
    throw new Error(`Failed to list regions: ${error.message}`);
  }
  return data || [];
}
