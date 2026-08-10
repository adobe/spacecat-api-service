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
 * The organization's own row, not a brand's override of it. `brand_id` is absent
 * from every row before the brand-scope migration and NULL on the organization's
 * row after it, so this selects correctly under both schemas.
 *
 * @param {object} row - Raw PostgREST `feature_flags` row.
 * @returns {boolean} `true` for the organization-level row.
 */
const isOrgRow = (row) => (row.brand_id ?? null) === null;

/**
 * Writes an organization's boolean feature flag, creating the row when it does
 * not exist yet and updating it in place when it does. A brand's override of the
 * same flag is left untouched.
 *
 * Keyed on the row's primary key rather than a composite `ON CONFLICT` target,
 * so it does not depend on the shape of the table's unique key. That costs
 * atomicity: two concurrent creates of the *same* flag leave one hitting the
 * unique constraint as a retryable duplicate-key error. The write callers are
 * the admin endpoint, onboarding and mode remediation, which carry essentially
 * no concurrency.
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

  const { data: existing, error: readError } = await postgrestClient
    .from('feature_flags')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('product', product)
    .eq('flag_name', flagName);

  if (readError) {
    throw new Error(`Failed to upsert feature flag: ${readError.message}`);
  }

  const current = (existing ?? []).find(isOrgRow);
  const { data, error } = current
    ? await postgrestClient
      .from('feature_flags')
      .update({ flag_value: value, updated_by: updatedBy })
      .eq('id', current.id)
      .select()
      .single()
    : await postgrestClient
      .from('feature_flags')
      .insert({
        organization_id: organizationId,
        product,
        flag_name: flagName,
        flag_value: value,
        updated_by: updatedBy,
      })
      .select()
      .single();

  if (error) {
    throw new Error(`Failed to upsert feature flag: ${error.message}`);
  }

  return data;
}

/**
 * Reads an organization's own value for a feature flag, ignoring any brand's
 * override of it.
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
    .select('*')
    .eq('organization_id', organizationId)
    .eq('product', product)
    .eq('flag_name', flagName);

  if (error) {
    throw new Error(`Failed to read feature flag ${flagName}: ${error.message}`);
  }

  const row = (data ?? []).find(isOrgRow);
  return typeof row?.flag_value === 'boolean' ? row.flag_value : null;
}

/**
 * Lists an organization's own enabled flags for a product. Brand overrides are
 * excluded, so the endpoint built on this describes the organization's state.
 *
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

  return (data ?? []).filter(isOrgRow);
}
