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
 * Normalizes the deferred Semrush provisioning data of a pending (draft) brand
 * into the shape persisted in `brands.pending_semrush_provisioning` (a JSONB object
 * `{ primaryUrl?, markets: [{ market, languageCode, modelIds? }], generatePrompts? }`).
 * These are the primary URL + initial markets (each with its chosen AI models/LLMs)
 * plus whether activation should generate topics/prompts — all collected by the
 * add-brand wizard before a sub-workspace/project exist; activation reads them
 * back to provision the real Semrush projects, then clears the column.
 * The canonical shape is the `PendingSemrushProvisioning` type exported by
 * `@adobe/spacecat-shared-data-access` (shared with project-elmo-ui).
 *
 * Returns `undefined` when the caller did not supply the field (leave the column
 * untouched), `null` when explicitly cleared or nothing useful remains, or the
 * cleaned object otherwise.
 *
 * @param {unknown} value - `{ primaryUrl?, markets }`, null, or undefined.
 * @returns {{primaryUrl: (string|null), markets: Array<{market: string,
 *   languageCode: string, modelIds?: string[]}>}|null|undefined}
 */
function normalizePendingSemrushProvisioning(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('pendingSemrushProvisioning must be an object or null');
    error.status = 400;
    throw error;
  }
  const markets = (Array.isArray(value.markets) ? value.markets : [])
    .map((m) => {
      const market = {
        market: typeof m?.market === 'string' ? m.market.trim() : '',
        languageCode: typeof m?.languageCode === 'string' ? m.languageCode.trim() : '',
      };
      // Per-market AI models (LLMs) chosen for this market; applied to the
      // project at activation. Keep only non-empty strings; omit the key
      // entirely when none remain so a cleared selection doesn't persist `[]`.
      const modelIds = (Array.isArray(m?.modelIds) ? m.modelIds : [])
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(hasText);
      if (modelIds.length > 0) {
        market.modelIds = modelIds;
      }
      return market;
    })
    .filter((m) => hasText(m.market) && hasText(m.languageCode));
  const primaryUrl = typeof value.primaryUrl === 'string' && hasText(value.primaryUrl)
    ? value.primaryUrl.trim()
    : null;
  // Whether activation should generate topics/prompts for the provisioned
  // project(s). Only meaningful as an explicit boolean; absent means "legacy
  // stash, leave generation off" and is omitted so the column stays minimal.
  const hasGeneratePrompts = typeof value.generatePrompts === 'boolean';
  // Nothing worth persisting → treat as cleared. An explicit generatePrompts
  // flag IS worth persisting on its own: a bare no-prompt draft (no URL, no
  // market) still needs the stash so activation knows to provision a
  // sub-workspace-only brand rather than treating it as a non-Semrush brand.
  if (markets.length === 0 && !hasText(primaryUrl) && !hasGeneratePrompts) {
    return null;
  }
  const result = { primaryUrl, markets };
  if (hasGeneratePrompts) {
    result.generatePrompts = value.generatePrompts;
  }
  return result;
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
 * Maps a DB brand row (with all joined child tables) to the V2 config shape
 * the UI expects.
 *
 * `urls[]` unions `brand_urls` (raw user-submitted list) with `brand_sites`
 * (join to the sites table). Each entry carries `onboarded` — true when the
 * URL's base resolves to a site row in the org — and `siteId` for onboarded
 * entries. Legacy brands with no `brand_urls` rows fall back to the
 * `brand_sites` expansion, where every entry is by definition onboarded.
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
    // Read-only: the brand's own Semrush sub-workspace (dual-mode). Null for
    // brands still in flat mode (no sub-workspace minted yet). Consumers use it
    // to scope per-brand Semrush views to the sub-workspace.
    semrushWorkspaceId: row.semrush_workspace_id || null,
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
 */
// eslint-disable-next-line max-len
async function syncSocialAccounts(brandId, organizationId, socialAccounts, postgrestClient, updatedBy) {
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
 */
// eslint-disable-next-line max-len
async function syncEarnedSources(brandId, organizationId, earnedContent, postgrestClient, updatedBy) {
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
 */
async function syncAliases(brandId, organizationId, brandAliases, postgrestClient, updatedBy) {
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
 */
async function syncCompetitors(brandId, organizationId, competitors, postgrestClient, updatedBy) {
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
 * @param {string|null} [params.semrushWorkspaceId] - Provisioned sub-workspace
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
  semrushWorkspaceId = null,
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

  // An active brand must be anchored by either a SpaceCat base site OR a Semrush
  // sub-workspace (serenity dual-mode): a Semrush brand has no SpaceCat site, but
  // its sub-workspace (semrush_workspace_id, set on the serenity-first create
  // path) is a valid anchor — mirrors the relaxed chk_active_brand_has_site_id
  // DB constraint. Respect persisted site_id on the update path.
  const hasAnchor = hasText(brand.baseSiteId)
    || hasText(existing?.site_id)
    || hasText(semrushWorkspaceId);
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
  if (hasText(semrushWorkspaceId)) {
    row.semrush_workspace_id = semrushWorkspaceId;
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

  // Deferred Semrush provisioning data for a pending (draft) brand: the primary
  // URL + desired (market, languageCode) the wizard collected before a
  // sub-workspace / project exist. Persisted as JSONB so activation can
  // provision it later, then cleared. Undefined leaves the column untouched.
  const pendingSemrushProvisioning = normalizePendingSemrushProvisioning(
    brand.pendingSemrushProvisioning,
  );
  if (pendingSemrushProvisioning !== undefined) {
    row.pending_semrush_provisioning = pendingSemrushProvisioning;
  }

  // A Semrush-anchored create (serenity-first, semrushWorkspaceId set) is NEVER
  // anchored by a SpaceCat site: its primary URL is the Semrush project domain,
  // which may coincidentally match an onboarded site. Setting site_id from that
  // match would collide with the site's existing primary brand (409
  // brands_base_site_unique) — so ignore baseSiteId entirely on this path.
  const anchoredBySemrush = hasText(semrushWorkspaceId);

  // baseSiteId is immutable once persisted (mirrors updateBrand). Only set it
  // when the brand has no site_id yet — re-onboarding/re-upserting an existing
  // brand by name must NOT re-point its primary site (LLMO-5556: this silently
  // overwrote mongodb.com -> learn.mongodb.com and merck.com -> keytruda.com).
  // LLMO-5919: soft-deleted brands are now excluded from `existing` (see filter
  // above), so `existing === null` covers both fresh creates and resurrections.
  // In both cases we always write an explicit site_id — or null to clear the
  // deleted brand's stale anchor so it cannot survive the ON CONFLICT UPDATE
  // and collide with whichever brand now owns that site.
  if (!anchoredBySemrush) {
    if (existing === null) {
      row.site_id = hasText(brand.baseSiteId) ? brand.baseSiteId : null;
    } else if (hasText(brand.baseSiteId) && !hasText(existing.site_id)) {
      row.site_id = brand.baseSiteId;
    } else if (
      hasText(brand.baseSiteId)
      && hasText(existing.site_id)
      && existing.site_id !== brand.baseSiteId
    ) {
      log.warn(`upsertBrand: ignoring baseSiteId change for brand "${brand.name}" `
        + `(org ${organizationId}) — primary site is immutable `
        + `(existing=${existing.site_id}, attempted=${brand.baseSiteId})`);
    }
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
    || updates.status !== undefined;
  let existing = null;
  if (needsExistingFetch) {
    const { data: current, error: currentError } = await postgrestClient
      .from('brands')
      .select('site_id, status')
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

  // baseSiteId mutation rules (LLMO-5870):
  //  - First set (NULL -> value): allowed for any brand.
  //  - Re-point (value -> different value): allowed ONLY for pending brands, so a
  //    draft can swap its primary URL before activation.
  //  - Clear (value -> NULL): allowed ONLY for pending brands, so the site can be
  //    freed for reuse by another brand.
  // Active brands stay immutable-once-set: a routine field save that echoes a
  // stale baseSiteId must never re-point or strip a live brand's anchor (the
  // LLMO-5556 / express.adobe.com regression guard). Clearing a pending brand's
  // site_id is safe at the DB level — the partial unique index
  // (brands_base_site_unique) skips NULLs and chk_active_brand_has_site_id only
  // constrains active brands. The unique index still rejects a re-point that
  // collides with another brand's primary URL.
  const isPending = (existing?.status || '').toLowerCase() === 'pending';
  if (wantsClearBaseSite) {
    if (isPending) {
      patch.site_id = null;
    }
  } else if (hasText(updates.baseSiteId) && (!existing?.site_id || isPending)) {
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

  if (updates.region !== undefined) {
    patch.regions = (updates.region || [])
      .map((r) => (typeof r === 'string' ? r : String(r))).filter(hasText);
  }

  // Deferred Semrush provisioning data (pending/draft brands). Activation passes
  // `pendingSemrushProvisioning: null` to clear it once the real projects are
  // provisioned.
  if (updates.pendingSemrushProvisioning !== undefined) {
    patch.pending_semrush_provisioning = normalizePendingSemrushProvisioning(
      updates.pendingSemrushProvisioning,
    );
  }

  // Clear legacy columns on any brand update so old data doesn't linger.
  patch.social = [];
  patch.earned_sources = [];

  const { data, error } = await postgrestClient
    .from('brands')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', brandId)
    .select('id')
    .maybeSingle();

  if (error) {
    if (error.code === '23505' && error.message?.includes('brands_base_site_unique')) {
      const err = new Error('This site is already the primary URL for another brand');
      err.status = 409;
      throw err;
    }
    rethrowCheckViolation(error, `Failed to update brand: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  const childSyncs = [];

  if (updates.brandAliases !== undefined) {
    childSyncs.push(
      syncAliases(brandId, organizationId, updates.brandAliases, postgrestClient, updatedBy),
    );
  }
  if (updates.competitors !== undefined) {
    childSyncs.push(
      syncCompetitors(brandId, organizationId, updates.competitors, postgrestClient, updatedBy),
    );
  }
  if (updates.socialAccounts !== undefined) {
    // eslint-disable-next-line max-len
    childSyncs.push(syncSocialAccounts(brandId, organizationId, updates.socialAccounts, postgrestClient, updatedBy));
  }
  if (updates.earnedContent !== undefined) {
    childSyncs.push(
      syncEarnedSources(brandId, organizationId, updates.earnedContent, postgrestClient, updatedBy),
    );
  }

  if (childSyncs.length > 0) {
    await Promise.all(childSyncs);
  }

  if (updates.urls !== undefined) {
    await Promise.all([
      syncBrandSites(organizationId, brandId, updates.urls, postgrestClient, updatedBy),
      syncBrandUrls(organizationId, brandId, updates.urls, postgrestClient, updatedBy),
    ]);
  }

  return getBrandById(organizationId, brandId, postgrestClient);
}

/**
 * Soft-deletes a brand by setting status to 'deleted'.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} brandId - Brand UUID
 * @param {object} postgrestClient - PostgREST client
 * @param {string} [updatedBy] - User performing the operation
 * @returns {Promise<boolean>} True if deleted, false if not found
 */
export async function deleteBrand(organizationId, brandId, postgrestClient, updatedBy = 'system') {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const { data, error } = await postgrestClient
    .from('brands')
    .update({ status: 'deleted', updated_by: updatedBy })
    .eq('organization_id', organizationId)
    .eq('id', brandId)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to delete brand: ${error.message}`);
  }
  return !!data;
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
