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

const PRODUCTS = new Set(['ASO', 'LLMO']);
const FLAG_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * @param {unknown} raw - Product label from path or body (any casing)
 * @returns {'ASO'|'LLMO'|null}
 */
export function normalizeFeatureFlagProduct(raw) {
  const p = String(raw ?? '').trim().toUpperCase();
  if (!PRODUCTS.has(p)) {
    return null;
  }
  return /** @type {'ASO'|'LLMO'} */ (p);
}

/**
 * @param {unknown} flagName
 * @returns {boolean}
 */
export function isValidFeatureFlagName(flagName) {
  if (typeof flagName !== 'string') {
    return false;
  }
  if (flagName.length === 0 || flagName.length > 255) {
    return false;
  }
  return FLAG_NAME_PATTERN.test(flagName);
}

/**
 * Upserts a boolean feature flag row (org + product + flag_name unique).
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat org id (matches mysticat organizations.id)
 * @param {'ASO'|'LLMO'} params.product
 * @param {string} params.flagName
 * @param {boolean} params.value
 * @param {string} params.updatedBy
 * @param {object} params.postgrestClient
 * @returns {Promise<object>} Raw PostgREST row (snake_case)
 */
export async function upsertFeatureFlag({
  organizationId,
  product,
  flagName,
  value,
  updatedBy,
  postgrestClient,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for feature flags');
  }

  const row = {
    organization_id: organizationId,
    product,
    flag_name: flagName,
    flag_value: value,
    updated_by: updatedBy,
  };

  const { data, error } = await postgrestClient
    .from('feature_flags')
    .upsert(row, { onConflict: 'organization_id,product,flag_name' })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to upsert feature flag: ${error.message}`);
  }

  return data;
}

/**
 * Reads a single feature flag value by org, product, and flag name.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {'ASO'|'LLMO'} params.product
 * @param {string} params.flagName
 * @param {object} params.postgrestClient
 * @returns {Promise<boolean|null>} The flag value, or null if not found / not a boolean.
 */
export async function readFeatureFlag({
  organizationId,
  product,
  flagName,
  postgrestClient,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for feature flags');
  }

  const { data, error } = await postgrestClient
    .from('feature_flags')
    .select('flag_value')
    .eq('organization_id', organizationId)
    .eq('product', product)
    .eq('flag_name', flagName)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read feature flag ${flagName}: ${error.message}`);
  }

  return typeof data?.flag_value === 'boolean' ? data.flag_value : null;
}

/**
 * @param {object} params
 * @param {string} params.organizationId
 * @param {'ASO'|'LLMO'} params.product
 * @param {object} params.postgrestClient
 * @returns {Promise<object[]>} Raw rows with `flag_value` true only (disabled rows are omitted).
 */
export async function listFeatureFlagsByOrgAndProduct({
  organizationId,
  product,
  postgrestClient,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for feature flags');
  }

  const { data, error } = await postgrestClient
    .from('feature_flags')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('product', product)
    .eq('flag_value', true)
    .order('flag_name', { ascending: true });

  if (error) {
    throw new Error(`Failed to list feature flags: ${error.message}`);
  }

  return data ?? [];
}
