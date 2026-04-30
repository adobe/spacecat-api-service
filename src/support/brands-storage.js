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

/**
 * PostgREST select string — joins all normalized child tables.
 */
const BRAND_SELECT = [
  '*',
  'base_site:sites!site_id(id, base_url)',
  'brand_aliases(alias, regions)',
  'brand_social_accounts(url, regions)',
  'brand_earned_sources(name, url, regions)',
  'competitors(name, url, regions)',
  'brand_sites(site_id, paths, type, sites(base_url))',
  'brand_urls(url)',
].join(', ');

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
  const siteIds = (row.brand_sites || []).map((bs) => bs.site_id).filter(hasText);

  // Index brand_sites by normalized base URL so brand_urls entries can be
  // tagged onboarded/siteId by matching their base. brand_sites.site_id is
  // NOT NULL in the schema, so no defensive filter on it here.
  const siteByBase = new Map();
  (row.brand_sites || []).forEach((bs) => {
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
  const brandSitesUrls = (row.brand_sites || []).flatMap((bs) => {
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
    status: row.status || 'active',
    origin: row.origin || 'human',
    description: row.description || null,
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
 * Asserts the primary brand_sites row mirroring brands.site_id exists for a brand.
 *
 * The primary citation row links a brand to its canonical site via
 * (brand_id, site_id=brands.site_id, paths=['/'], type='base'). This helper
 * is idempotent (uses ON CONFLICT DO NOTHING) and is called unconditionally
 * after every upsertBrand / updateBrand whose resulting brand has a site_id.
 *
 * Closes the LLMO-4621 Pattern A bleed where a downstream caller passing
 * `urls=[]` to upsertBrand could trip the destructive DELETE in
 * syncBrandSites without a matching INSERT, leaving the active root brand
 * with zero brand_sites rows.
 *
 * No-op when primarySiteId is unset (e.g. pending Brandalf siblings whose
 * brand entity legitimately has site_id=NULL).
 */
async function ensurePrimaryBrandSite({
  organizationId, brandId, primarySiteId, postgrestClient, updatedBy,
}) {
  if (!hasText(primarySiteId)) {
    return;
  }
  const { error } = await postgrestClient
    .from('brand_sites')
    .upsert(
      {
        organization_id: organizationId,
        brand_id: brandId,
        site_id: primarySiteId,
        paths: ['/'],
        type: 'base',
        updated_by: updatedBy,
      },
      { onConflict: 'brand_id,site_id', ignoreDuplicates: true },
    );
  if (error) {
    throw new Error(`Failed to ensure primary brand_sites row: ${error.message}`);
  }
}

/**
 * Reconciles brand_sites for a brand against a caller-supplied URL list.
 *
 * Non-destructive to the primary citation row: rows whose site_id matches
 * brands.site_id are protected from the orphan-cleanup step regardless of
 * whether the caller's URL list resolves to that site. The primary row is
 * (re-)asserted independently by ensurePrimaryBrandSite.
 *
 * Behavior:
 * 1. Resolve brands.site_id for the brand (the protected primary).
 * 2. Group submitted URLs by composeBaseURL(base) and look up matching sites
 *    rows in the same org. Upsert one brand_sites row per matched site.
 * 3. Delete any pre-existing brand_sites rows that are NOT in the desired
 *    set AND not the primary site — i.e. genuine orphan citations.
 *
 * Replaces the prior DELETE-then-INSERT scheme that would silently wipe
 * citations (and the primary row) when the caller's URL list was empty
 * or didn't match any sites.base_url (LLMO-4621 Pattern A).
 */
async function syncBrandSites(organizationId, brandId, urls, postgrestClient, updatedBy) {
  // 1. Resolve the primary site we must protect from the orphan-cleanup DELETE.
  const { data: brandRow, error: brandFetchError } = await postgrestClient
    .from('brands')
    .select('site_id')
    .eq('id', brandId)
    .maybeSingle();
  if (brandFetchError) {
    throw new Error(`Failed to load brand for syncBrandSites: ${brandFetchError.message}`);
  }
  const primarySiteId = brandRow?.site_id || null;

  // 2. Group paths by base URL and track type from caller-supplied URLs.
  const pathsByBase = new Map();
  const typeByBase = new Map();
  (urls || []).forEach((u) => {
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

  // 3. Upsert citations matching the caller's URL list.
  const desiredSiteIds = new Set();
  if (pathsByBase.size > 0) {
    const { data: sites, error: sitesError } = await postgrestClient
      .from('sites')
      .select('id, base_url')
      .eq('organization_id', organizationId)
      .in('base_url', [...pathsByBase.keys()]);
    if (sitesError) {
      throw new Error(`Failed to load sites for syncBrandSites: ${sitesError.message}`);
    }
    if (sites && sites.length > 0) {
      const rows = sites.map((s) => ({
        organization_id: organizationId,
        brand_id: brandId,
        site_id: s.id,
        paths: pathsByBase.get(s.base_url) || [],
        type: typeByBase.get(s.base_url) || null,
        updated_by: updatedBy,
      }));
      const { error: upsertError } = await postgrestClient
        .from('brand_sites')
        .upsert(rows, { onConflict: 'brand_id,site_id' });
      if (upsertError) {
        throw new Error(`Failed to sync brand_sites: ${upsertError.message}`);
      }
      sites.forEach((s) => desiredSiteIds.add(s.id));
    }
  }

  // 4. Delete orphan citations: pre-existing rows NOT in desired set AND
  //    NOT the primary site. Compute orphan id list in JS (rather than via
  //    PostgREST .not('site_id', 'in', ...)) so the DELETE targets PK ids
  //    explicitly — robust against quoting edge-cases in the UUID list.
  const { data: existing, error: existingError } = await postgrestClient
    .from('brand_sites')
    .select('id, site_id')
    .eq('brand_id', brandId);
  if (existingError) {
    throw new Error(`Failed to load brand_sites for syncBrandSites: ${existingError.message}`);
  }

  const protectedSiteIds = new Set(desiredSiteIds);
  if (primarySiteId) {
    protectedSiteIds.add(primarySiteId);
  }
  const orphanIds = (existing || [])
    .filter((bs) => !protectedSiteIds.has(bs.site_id))
    .map((bs) => bs.id);

  if (orphanIds.length > 0) {
    const { error: deleteError } = await postgrestClient
      .from('brand_sites')
      .delete()
      .in('id', orphanIds);
    if (deleteError) {
      throw new Error(`Failed to clean brand_sites: ${deleteError.message}`);
    }
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
      regions: c?.regions || [],
    }))
    .filter((c) => hasText(c.name) && !seen.has(c.name) && seen.add(c.name))
    .map((c) => ({
      organization_id: organizationId,
      brand_id: brandId,
      name: c.name,
      url: c.url,
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
 * Creates or updates a brand in the normalized brands table,
 * including all nested child tables (aliases, competitors, social, earned, sites).
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {object} params.brand - Brand data in V2 config shape
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @returns {Promise<object>} Created/updated brand in V2 config shape
 */
export async function upsertBrand({
  organizationId,
  brand,
  postgrestClient,
  updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }
  if (!hasText(brand?.name)) {
    throw new Error('Brand name is required');
  }

  const regions = (brand.region || [])
    .map((r) => (typeof r === 'string' ? r : String(r))).filter(hasText);

  // Check if the brand already exists with a base site set.
  // This prevents silently downgrading an active brand to pending when a caller
  // re-upserts by name without passing baseSiteId.
  const { data: existing } = await postgrestClient
    .from('brands')
    .select('site_id')
    .eq('organization_id', organizationId)
    .eq('name', brand.name)
    .maybeSingle();

  // A brand cannot be active without a base site ID — but respect persisted state
  // on the update path (the DB row may already have site_id set).
  const hasBaseSite = hasText(brand.baseSiteId) || hasText(existing?.site_id);
  const status = (!hasBaseSite && (brand.status || 'active') === 'active')
    ? 'pending'
    : (brand.status || 'active');

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

  // Set base site ID if provided.
  if (hasText(brand.baseSiteId)) {
    row.site_id = brand.baseSiteId;
  }

  const { data: upserted, error } = await postgrestClient
    .from('brands')
    .upsert(row, { onConflict: 'organization_id,name' })
    .select('id, name, site_id')
    .single();

  if (error) {
    if (error.code === '23505' && error.message?.includes('brands_base_site_unique')) {
      const err = new Error('This site is already the primary URL for another brand');
      err.status = 409;
      throw err;
    }
    throw new Error(`Failed to upsert brand: ${error.message}`);
  }

  const brandId = upserted.id;
  const primarySiteId = upserted.site_id;

  await Promise.all([
    syncAliases(brandId, organizationId, brand.brandAliases, postgrestClient, updatedBy),
    syncCompetitors(brandId, organizationId, brand.competitors, postgrestClient, updatedBy),
    syncSocialAccounts(brandId, organizationId, brand.socialAccounts, postgrestClient, updatedBy),
    syncEarnedSources(brandId, organizationId, brand.earnedContent, postgrestClient, updatedBy),
  ]);

  // Always assert the primary brand_sites row when brands.site_id is set —
  // independent of whether the caller passed brand.urls. Closes the
  // LLMO-4621 Pattern A bleed (downstream caller passing urls=[] could
  // wipe the primary citation row when syncBrandSites was destructive).
  await ensurePrimaryBrandSite({
    organizationId, brandId, primarySiteId, postgrestClient, updatedBy,
  });

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
  if (updates.vertical !== undefined) {
    patch.vertical = updates.vertical;
  }

  // baseSiteId is immutable once set — only allow setting from NULL.
  // The DB partial unique index (brands_base_site_unique) enforces uniqueness.
  if (hasText(updates.baseSiteId)) {
    const { data: current } = await postgrestClient
      .from('brands')
      .select('site_id')
      .eq('id', brandId)
      .maybeSingle();

    if (!current?.site_id) {
      patch.site_id = updates.baseSiteId;
    }
    // If site_id is already set, silently ignore the update (immutable).
  }

  if (updates.region !== undefined) {
    patch.regions = (updates.region || [])
      .map((r) => (typeof r === 'string' ? r : String(r))).filter(hasText);
  }

  // Clear legacy columns on any brand update so old data doesn't linger.
  patch.social = [];
  patch.earned_sources = [];

  const { data, error } = await postgrestClient
    .from('brands')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', brandId)
    .select('id, site_id')
    .maybeSingle();

  if (error) {
    if (error.code === '23505' && error.message?.includes('brands_base_site_unique')) {
      const err = new Error('This site is already the primary URL for another brand');
      err.status = 409;
      throw err;
    }
    throw new Error(`Failed to update brand: ${error.message}`);
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

  // Re-assert the primary brand_sites row when brands.site_id is set. Cheap
  // ON CONFLICT DO NOTHING upsert so update calls that don't touch site_id
  // are no-ops. Catches the NULL→set transition when an operator finally
  // assigns a base site to a previously-pending brand.
  await ensurePrimaryBrandSite({
    organizationId,
    brandId,
    primarySiteId: data.site_id,
    postgrestClient,
    updatedBy,
  });

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
