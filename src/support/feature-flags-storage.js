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
 * Every query feeding this predicate selects the full row, and must keep doing
 * so. Naming `brand_id` in a projection fails against the current schema, where
 * the column does not exist yet; omitting it once it does exist makes every
 * override row arrive with `brand_id: undefined` and read as the organization's
 * own. A wildcard projection is the only shape that is correct under both.
 *
 * @param {object} row - Raw PostgREST `feature_flags` row.
 * @returns {boolean} `true` for the organization-level row.
 */
const isOrgRow = (row) => (row.brand_id ?? null) === null;

/**
 * Every row of one flag for an organization — its own and each brand's override.
 *
 * The single place this query is built. Callers differ only in how they report a
 * failure, so the raw `{ data, error }` is handed back rather than thrown on
 * here: the read path names the flag in its message, the write path does not.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {'ASO'|'LLMO'} params.product
 * @param {string} params.flagName
 * @param {object} params.postgrestClient
 * @returns {Promise<{data: object[]|null, error: {message: string}|null}>}
 */
async function fetchFeatureFlagRows({
  organizationId,
  product,
  flagName,
  postgrestClient,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for feature flags');
  }

  // Wildcard projection is required — see `isOrgRow`.
  return postgrestClient
    .from('feature_flags')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('product', product)
    .eq('flag_name', flagName);
}

/**
 * Reads both scopes of one flag for an organization in a single query: the
 * organization's own row, and every brand's override of it keyed by brand id.
 *
 * One query serves any number of brands, so a caller resolving a whole brand
 * list does not read per brand. Pair it with {@link resolveFlagRowForBrand}.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {'ASO'|'LLMO'} params.product
 * @param {string} params.flagName
 * @param {object} params.postgrestClient
 * @returns {Promise<{orgRow: object|null, brandRows: Map<string, object>}>}
 */
export async function readFeatureFlagScopes({
  organizationId,
  product,
  flagName,
  postgrestClient,
}) {
  const { data, error } = await fetchFeatureFlagRows({
    organizationId,
    product,
    flagName,
    postgrestClient,
  });

  if (error) {
    throw new Error(`Failed to read feature flag ${flagName}: ${error.message}`);
  }

  const rows = data ?? [];
  const brandRows = new Map();
  for (const row of rows) {
    const brandId = row.brand_id ?? null;
    if (brandId !== null) {
      brandRows.set(brandId, row);
    }
  }
  return { orgRow: rows.find(isOrgRow) ?? null, brandRows };
}

/**
 * Resolves which row governs a flag for one brand: the brand's own override
 * when it has one, otherwise the organization's row.
 *
 * The brand row is an override rather than a second condition ANDed with the
 * organization's, so a brand is on under an organization that is off — which is
 * what every migration wave before the last one looks like, and why the
 * organization's row is the last step of a rollout rather than the first. A
 * brand row of `false` likewise holds one brand back from an organization that
 * is on.
 *
 * Before the brand-scope migration no row carries a `brand_id`, so `brandRows`
 * is always empty and this resolves to the organization's row for every brand —
 * i.e. exactly the pre-migration behaviour, under either schema.
 *
 * @param {{orgRow: object|null, brandRows: Map<string, object>}} scopes - From
 *   {@link readFeatureFlagScopes}.
 * @param {string} [brandId] - Brand UUID to resolve for.
 * @returns {object|null} The governing row, or null when the flag is unset for
 *   that brand.
 */
export function resolveFlagRowForBrand(scopes, brandId) {
  return scopes.brandRows.get(brandId) ?? scopes.orgRow ?? null;
}

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
  const { data: existing, error: readError } = await fetchFeatureFlagRows({
    organizationId,
    product,
    flagName,
    postgrestClient,
  });

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
  const { orgRow } = await readFeatureFlagScopes({
    organizationId,
    product,
    flagName,
    postgrestClient,
  });
  return typeof orgRow?.flag_value === 'boolean' ? orgRow.flag_value : null;
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

  // Wildcard projection is required — see `isOrgRow`.
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
