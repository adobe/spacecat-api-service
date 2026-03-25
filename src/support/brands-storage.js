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

import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * Maps a DB brand row (with joined aliases/competitors) to the V2 config shape
 * the UI expects.
 */
const BRAND_SELECT = '*, brand_aliases(alias), competitors(name), brand_sites(site_id)';

function mapDbBrandToV2(row) {
  const aliases = (row.brand_aliases || []).map((a) => a.alias).filter(hasText);
  const competitors = (row.competitors || []).map((c) => c.name).filter(hasText);
  const siteIds = (row.brand_sites || []).map((bs) => bs.site_id).filter(hasText);

  return {
    id: row.id,
    name: row.name,
    status: row.status || 'active',
    origin: row.origin || 'human',
    description: row.description || null,
    vertical: row.vertical || null,
    region: row.regions || [],
    urls: (row.owned_urls || []).map((u) => ({ value: u })),
    socialAccounts: (row.social || []).map((s) => ({ url: s })),
    earnedContent: (row.earned_sources || []).map((e) => ({ url: e })),
    brandAliases: aliases,
    competitors,
    siteIds,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Resolves brand URLs to site IDs by matching against the sites table,
 * then syncs the brand_sites junction table.
 */
async function syncBrandSites(organizationId, brandId, urls, postgrestClient, updatedBy) {
  if (!urls || urls.length === 0) return;

  const urlValues = urls
    .map((u) => (typeof u === 'string' ? u : u?.value))
    .filter(hasText);
  if (urlValues.length === 0) return;

  const { data: sites } = await postgrestClient
    .from('sites')
    .select('id, base_url')
    .eq('organization_id', organizationId)
    .in('base_url', urlValues);

  if (!sites || sites.length === 0) return;

  const rows = sites.map((s) => ({
    organization_id: organizationId,
    brand_id: brandId,
    site_id: s.id,
    updated_by: updatedBy,
  }));

  const { error } = await postgrestClient
    .from('brand_sites')
    .upsert(rows, { onConflict: 'brand_id,site_id' });

  if (error) throw new Error(`Failed to sync brand_sites: ${error.message}`);
}

/**
 * Lists all brands for an organization from the normalized brands table,
 * including joined aliases and competitors.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {object} postgrestClient - PostgREST client
 * @param {object} [options]
 * @param {string} [options.status] - Filter by status (active, pending, deleted)
 * @returns {Promise<object[]>} Array of brands in V2 config shape
 */
export async function listBrands(organizationId, postgrestClient, options = {}) {
  if (!postgrestClient?.from) return [];

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
  if (error) throw new Error(`Failed to list brands: ${error.message}`);

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
  if (!postgrestClient?.from || !hasText(brandId)) return null;

  const { data, error } = await postgrestClient
    .from('brands')
    .select(BRAND_SELECT)
    .eq('organization_id', organizationId)
    .eq('id', brandId)
    .maybeSingle();

  if (error) throw new Error(`Failed to get brand: ${error.message}`);
  if (!data) return null;

  return mapDbBrandToV2(data);
}

/**
 * Creates or updates a brand in the normalized brands table,
 * including nested aliases and competitors.
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
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');
  if (!hasText(brand?.name)) throw new Error('Brand name is required');

  const earnedSources = (brand.earnedContent || [])
    .map((e) => e?.url || e?.name).filter(hasText);
  const social = (brand.socialAccounts || [])
    .map((s) => s?.url || s?.handle).filter(hasText);
  const ownedUrls = (brand.urls || [])
    .map((u) => (typeof u === 'string' ? u : u?.value)).filter(hasText);
  const regions = (brand.region || [])
    .map((r) => (typeof r === 'string' ? r : String(r))).filter(hasText);

  const row = {
    organization_id: organizationId,
    name: brand.name,
    status: brand.status || 'active',
    origin: brand.origin || 'human',
    description: brand.description || null,
    vertical: brand.vertical || null,
    earned_sources: earnedSources,
    social,
    owned_urls: ownedUrls,
    regions,
    updated_by: updatedBy,
  };

  const { data: upserted, error } = await postgrestClient
    .from('brands')
    .upsert(row, { onConflict: 'organization_id,name' })
    .select('id, name')
    .single();

  if (error) throw new Error(`Failed to upsert brand: ${error.message}`);

  const brandId = upserted.id;

  const aliases = [...new Set(
    (brand.brandAliases || [])
      .map((a) => (typeof a === 'string' ? a : a?.name))
      .filter(hasText),
  )];

  const competitorNames = [...new Set(
    (brand.competitors || [])
      .map((c) => (typeof c === 'string' ? c : c?.name))
      .filter(hasText),
  )];

  const syncOps = [];

  if (aliases.length > 0) {
    const aliasRows = aliases.map((alias) => ({
      organization_id: organizationId,
      brand_id: brandId,
      alias,
      updated_by: updatedBy,
    }));
    syncOps.push(
      postgrestClient
        .from('brand_aliases')
        .upsert(aliasRows, { onConflict: 'brand_id,alias' }),
    );
  }

  if (competitorNames.length > 0) {
    const competitorRows = competitorNames.map((name) => ({
      organization_id: organizationId,
      brand_id: brandId,
      name,
      updated_by: updatedBy,
    }));
    syncOps.push(
      postgrestClient
        .from('competitors')
        .upsert(competitorRows, { onConflict: 'brand_id,name' }),
    );
  }

  if (syncOps.length > 0) {
    const results = await Promise.all(syncOps);
    for (const result of results) {
      if (result.error) throw new Error(`Failed to sync brand relations: ${result.error.message}`);
    }
  }

  await syncBrandSites(organizationId, brandId, brand.urls, postgrestClient, updatedBy);

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
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');

  const patch = { updated_by: updatedBy };

  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.origin !== undefined) patch.origin = updates.origin;
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.vertical !== undefined) patch.vertical = updates.vertical;

  if (updates.region !== undefined) {
    patch.regions = (updates.region || [])
      .map((r) => (typeof r === 'string' ? r : String(r))).filter(hasText);
  }
  if (updates.urls !== undefined) {
    patch.owned_urls = (updates.urls || [])
      .map((u) => (typeof u === 'string' ? u : u?.value)).filter(hasText);
  }
  if (updates.socialAccounts !== undefined) {
    patch.social = (updates.socialAccounts || [])
      .map((s) => s?.url || s?.handle).filter(hasText);
  }
  if (updates.earnedContent !== undefined) {
    patch.earned_sources = (updates.earnedContent || [])
      .map((e) => e?.url || e?.name).filter(hasText);
  }

  const { data, error } = await postgrestClient
    .from('brands')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', brandId)
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`Failed to update brand: ${error.message}`);
  if (!data) return null;

  if (updates.brandAliases !== undefined) {
    const aliases = [...new Set(
      (updates.brandAliases || [])
        .map((a) => (typeof a === 'string' ? a : a?.name))
        .filter(hasText),
    )];

    if (aliases.length > 0) {
      const aliasRows = aliases.map((alias) => ({
        organization_id: organizationId,
        brand_id: brandId,
        alias,
        updated_by: updatedBy,
      }));
      const { error: aliasErr } = await postgrestClient
        .from('brand_aliases')
        .upsert(aliasRows, { onConflict: 'brand_id,alias' });
      if (aliasErr) throw new Error(`Failed to sync aliases: ${aliasErr.message}`);
    }
  }

  if (updates.competitors !== undefined) {
    const competitorNames = [...new Set(
      (updates.competitors || [])
        .map((c) => (typeof c === 'string' ? c : c?.name))
        .filter(hasText),
    )];

    if (competitorNames.length > 0) {
      const competitorRows = competitorNames.map((name) => ({
        organization_id: organizationId,
        brand_id: brandId,
        name,
        updated_by: updatedBy,
      }));
      const { error: compErr } = await postgrestClient
        .from('competitors')
        .upsert(competitorRows, { onConflict: 'brand_id,name' });
      if (compErr) throw new Error(`Failed to sync competitors: ${compErr.message}`);
    }
  }

  if (updates.urls !== undefined) {
    await syncBrandSites(organizationId, brandId, updates.urls, postgrestClient, updatedBy);
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
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');

  const { data, error } = await postgrestClient
    .from('brands')
    .update({ status: 'deleted', updated_by: updatedBy })
    .eq('organization_id', organizationId)
    .eq('id', brandId)
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`Failed to delete brand: ${error.message}`);
  return !!data;
}

/**
 * Lists all regions (available markets) from the regions reference table.
 *
 * @param {object} postgrestClient - PostgREST client
 * @returns {Promise<object[]>} Array of { code, name }
 */
export async function listRegions(postgrestClient) {
  if (!postgrestClient?.from) return [];

  const { data, error } = await postgrestClient
    .from('regions')
    .select('code, name')
    .order('code', { ascending: true });

  if (error) throw new Error(`Failed to list regions: ${error.message}`);
  return data || [];
}
