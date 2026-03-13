/* eslint-disable header/header */
/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use it except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { hasText, isNonEmptyArray } from '@adobe/spacecat-shared-utils';

/**
 * Maps a V2 CustomerConfig brand to the Postgres brands table row format.
 * @param {object} brand - V2 brand from customer.customer.brands
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} [updatedBy] - User who performed the update
 * @returns {object} Row for brands table (snake_case for PostgREST)
 */
function mapV2BrandToDbRow(brand, organizationId, updatedBy = 'system') {
  const aliases = (brand.brandAliases || []).map((a) => (typeof a === 'string' ? a : a?.name)).filter(hasText);
  const competitors = (brand.competitors || []).map((c) => (typeof c === 'string' ? c : c?.name)).filter(hasText);
  const earnedSources = (brand.earnedContent || []).map((e) => e?.url || e?.name).filter(hasText);
  const social = (brand.socialAccounts || []).map((s) => s?.url || s?.handle).filter(hasText);
  const ownedUrls = (brand.urls || []).map((u) => (typeof u === 'string' ? u : u?.value)).filter(hasText);
  const regions = (brand.region || []).map((r) => (typeof r === 'string' ? r : String(r))).filter(hasText);

  return {
    organization_id: organizationId,
    name: brand.name,
    status: brand.status || 'active',
    origin: brand.origin || 'human',
    description: brand.description || null,
    vertical: brand.vertical || null,
    aliases: aliases.length > 0 ? aliases : [],
    competitors: competitors.length > 0 ? competitors : [],
    earned_sources: earnedSources.length > 0 ? earnedSources : [],
    social: social.length > 0 ? social : [],
    owned_urls: ownedUrls.length > 0 ? ownedUrls : [],
    regions: regions.length > 0 ? regions : [],
    updated_by: updatedBy,
  };
}

/**
 * Syncs V2 customer config brands to the Postgres brands table.
 * Only runs when PostgREST client is available (DATA_SERVICE_PROVIDER=postgres).
 * Logs the request (customer config) and throws on failure.
 *
 * @param {object} params
 * @param {object} params.customerConfig - Full V2 customer config (customer.brands)
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {object} params.postgrestClient - PostgREST client from dataAccess.services
 * @param {object} params.log - Logger
 * @param {string} [params.updatedBy] - User who performed the update
 * @returns {Promise<void>}
 * @throws {Error} When PostgREST upsert fails
 */
export async function syncBrandConfig({
  customerConfig,
  organizationId,
  postgrestClient,
  log,
  updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    return;
  }

  const brands = customerConfig?.customer?.brands;
  if (!isNonEmptyArray(brands)) {
    log.debug(`No brands to sync for organization: ${organizationId}`);
    return;
  }

  log.info(`Brand sync request for organization ${organizationId}`, {
    organizationId,
    updatedBy,
    brandCount: brands.length,
    customerConfig,
  });

  const brandsWithoutName = brands.filter((b) => !hasText(b?.name));
  if (brandsWithoutName.length > 0) {
    log.error(
      `Brand(s) without name skipped for organization ${organizationId}:`,
      brandsWithoutName.map((b) => b?.id ?? '(no id)'),
    );
  }

  const rows = brands
    .filter((b) => hasText(b?.name))
    .map((b) => mapV2BrandToDbRow(b, organizationId, updatedBy));

  if (rows.length === 0) {
    return;
  }

  const { error } = await postgrestClient
    .from('brands')
    .upsert(rows, { onConflict: 'organization_id,name' });

  if (error) {
    log.error(`Brand presence sync failed for organization ${organizationId}`, {
      error,
      organizationId,
      customerConfig,
    });
    throw new Error(`Brand sync failed: ${error.message}`);
  }

  log.info(`Synced ${rows.length} brand(s) to Postgres for organization: ${organizationId}`);
}
