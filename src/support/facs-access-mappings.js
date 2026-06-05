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

/**
 * PostgREST helpers for the `facs_access_mappings` table — state-layer
 * management endpoints only.
 *
 * Backs the new `/state/access-mappings/*` URL grammar (see
 * `mysticat-architecture/platform/decisions/mac-state-layer.md`
 * §"State Layer Management Endpoints") under the hybrid permission model
 * (`mysticat-architecture/platform/decisions/rebac-hybrid-permission-model.md`).
 *
 * Schema (per mac-state-layer.md §"State Layer Schema"):
 *
 *   (id, subject_type, subject_id, resource_type, resource_id,
 *    ims_org_id, product, granted_capabilities text[],
 *    created_by, created_at, revoked_at, revoked_by, revoke_reason)
 *
 * - `product` is the uppercase product code (e.g. `'LLMO'`), sourced from
 *   the `x-product` header upstream. Every read and write is scoped to it
 *   together with `ims_org_id`.
 * - `granted_capabilities` is the per-resource capability set the binding
 *   confers; the wrapper unions it with the JWT to form the caller's
 *   effective set.
 *
 * Page-size caps: list endpoints default to **50** rows per request and
 * hard-cap at **500**.
 *
 * Every read and write is **always** scoped to both `imsOrgId` and `product`.
 * Cross-org / cross-product access is structurally impossible via this module
 * — there is no helper that accepts a row id without also requiring an
 * `imsOrgId` filter, and every list/create requires `product`.
 */

// `requirePostgrestForFacsMappings` is re-exported from a shared module so
// the V2 brand controller and the state-layer endpoints share one
// availability check (with their own error messages). See
// `src/support/postgrest-availability.js` for the implementation.
export { requirePostgrestForFacsMappings } from './postgrest-availability.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

function clampLimit(limit) {
  // Defensive: treat any non-positive / non-finite / non-integer input as
  // "use the default". Otherwise clamp to the hard cap. This avoids
  // turning a negative client-supplied limit into a 1-row query (which
  // would look like a successful empty page to the caller).
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.floor(n), MAX_LIST_LIMIT);
}

function applySubjectFilter(query, { subjectType, subjectId }) {
  let q = query;
  if (subjectType) {
    q = q.eq('subject_type', subjectType);
  }
  if (subjectId) {
    q = q.eq('subject_id', subjectId);
  }
  return q;
}

function applyResourceFilter(query, { resourceType, resourceId }) {
  let q = query;
  if (resourceType) {
    q = q.eq('resource_type', resourceType);
  }
  if (resourceId) {
    q = q.eq('resource_id', resourceId);
  }
  return q;
}

/**
 * Lists **active** access bindings within the caller's org + product.
 * Filters are optional — absence narrows nothing. `imsOrgId` and `product`
 * are REQUIRED so cross-org / cross-product queries are structurally
 * impossible.
 *
 * Active = `revoked_at IS NULL`. Tombstoned (revoked) bindings are
 * excluded; use `listFacsAccessMappingHistory` to see them.
 *
 * @param {object} postgrestClient
 * @param {object} filters
 * @param {string} filters.imsOrgId            - REQUIRED.
 * @param {string} filters.product             - REQUIRED. Uppercase product code.
 * @param {'user'|'org'} [filters.subjectType]
 * @param {string} [filters.subjectId]
 * @param {string} [filters.resourceType]
 * @param {string} [filters.resourceId]
 * @param {number} [filters.limit=50]          - Default 50; hard cap 500.
 * @returns {Promise<object[]>}
 */
export async function listFacsAccessMappings(postgrestClient, filters = {}) {
  const { imsOrgId, product, limit } = filters;
  if (!imsOrgId) {
    throw new Error('listFacsAccessMappings: imsOrgId is required');
  }
  if (!product) {
    throw new Error('listFacsAccessMappings: product is required');
  }
  let query = postgrestClient
    .from('facs_access_mappings')
    .select('*')
    .eq('ims_org_id', imsOrgId)
    .eq('product', product)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(clampLimit(limit));
  query = applySubjectFilter(query, filters);
  query = applyResourceFilter(query, filters);
  const { data, error } = await query;
  if (error) {
    throw new Error(`listFacsAccessMappings failed: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Lists access bindings including tombstones (active + revoked) within the
 * caller's org + product. Powers `GET /state/access-mappings/history` for
 * audit forensics. Filters are optional; ordering is by `created_at DESC`.
 *
 * @param {object} postgrestClient
 * @param {object} filters
 * @param {string} filters.imsOrgId            - REQUIRED.
 * @param {string} filters.product             - REQUIRED. Uppercase product code.
 * @param {'user'|'org'} [filters.subjectType]
 * @param {string} [filters.subjectId]
 * @param {string} [filters.resourceType]
 * @param {string} [filters.resourceId]
 * @param {string} [filters.since]             - ISO timestamp; rows with
 *                                                `created_at >= since`.
 * @param {number} [filters.limit=50]          - Default 50; hard cap 500.
 * @returns {Promise<object[]>}
 */
export async function listFacsAccessMappingHistory(postgrestClient, filters = {}) {
  const {
    imsOrgId, product, since, limit,
  } = filters;
  if (!imsOrgId) {
    throw new Error('listFacsAccessMappingHistory: imsOrgId is required');
  }
  if (!product) {
    throw new Error('listFacsAccessMappingHistory: product is required');
  }
  let query = postgrestClient
    .from('facs_access_mappings')
    .select('*')
    .eq('ims_org_id', imsOrgId)
    .eq('product', product)
    .order('created_at', { ascending: false })
    .limit(clampLimit(limit));
  query = applySubjectFilter(query, filters);
  query = applyResourceFilter(query, filters);
  if (since) {
    query = query.gte('created_at', since);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`listFacsAccessMappingHistory failed: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Bulk-inserts subject↔resource bindings for one resource within the
 * caller's org + product. Duplicates (matching the active-row partial
 * unique index `(subject_type, subject_id, resource_type, resource_id,
 * ims_org_id, product) WHERE revoked_at IS NULL`) land in `skipped` rather
 * than failing the whole batch — idempotent by design.
 *
 * Each binding row carries `granted_capabilities` (the per-resource
 * capability set the wrapper unions with the JWT to form the caller's
 * effective set) — REQUIRED, non-empty. See mac-state-layer.md
 * §"State Layer Schema".
 *
 * @param {object} postgrestClient
 * @param {object} args
 * @param {string} args.imsOrgId
 * @param {string} args.product          - Uppercase product code (e.g. 'LLMO').
 * @param {string} args.resourceType
 * @param {string} args.resourceId
 * @param {string[]} args.grantedCapabilities  - REQUIRED, non-empty.
 * @param {Array<{ type: 'user'|'org', id: string }>} args.subjects
 * @param {string} [args.createdBy] - IMS user id of the grantor (audit).
 * @returns {Promise<{ created: object[], skipped: Array<{ subject: object, reason: string }> }>}
 */
export async function createFacsAccessMappings(postgrestClient, {
  imsOrgId,
  product,
  resourceType,
  resourceId,
  grantedCapabilities,
  subjects,
  createdBy,
}) {
  if (!Array.isArray(subjects) || subjects.length === 0) {
    return { created: [], skipped: [] };
  }
  if (!imsOrgId) {
    throw new Error('createFacsAccessMappings: imsOrgId is required');
  }
  if (!product) {
    throw new Error('createFacsAccessMappings: product is required');
  }
  if (!Array.isArray(grantedCapabilities) || grantedCapabilities.length === 0) {
    throw new Error('createFacsAccessMappings: grantedCapabilities is required (non-empty array)');
  }
  const rows = subjects.map(({ type, id }) => ({
    subject_type: type,
    subject_id: id,
    resource_type: resourceType,
    resource_id: resourceId,
    ims_org_id: imsOrgId,
    product,
    granted_capabilities: grantedCapabilities,
    created_by: createdBy ?? null,
  }));

  // PostgREST upsert with onConflict: rows matching the active partial
  // unique index are silently skipped when ignoreDuplicates: true. We then
  // diff against the requested rows to compute the `skipped` array.
  //
  // Note: the index is partial (WHERE revoked_at IS NULL), so a previously-
  // revoked binding for the same (subject, resource, org, product) does NOT
  // conflict — it gets a fresh row with a new id. This is the design's
  // "re-grant after revoke = new row, not reactivation" property.
  const { data, error } = await postgrestClient
    .from('facs_access_mappings')
    .upsert(rows, {
      onConflict: 'subject_type,subject_id,resource_type,resource_id,ims_org_id,product',
      ignoreDuplicates: true,
    })
    .select('*');
  if (error) {
    throw new Error(`createFacsAccessMappings failed: ${error.message}`);
  }
  const created = data ?? [];
  const createdKey = (row) => `${row.subject_type}|${row.subject_id}`;
  const createdKeys = new Set(created.map(createdKey));
  const skipped = subjects
    .filter(({ type, id }) => !createdKeys.has(`${type}|${id}`))
    .map((subject) => ({ subject, reason: 'duplicate' }));
  return { created, skipped };
}

/**
 * Soft-revokes a single binding by primary key, scoped to the caller's
 * org. Invokes the `wrpc_revoke_facs_access_mapping` RPC defined in
 * mysticat-data-service, which is the ONLY legal mutation path on
 * `facs_access_mappings` (UPDATE / DELETE are not granted to any REST
 * role; the RPC runs with SECURITY DEFINER and validates active-row +
 * org-scope before tombstoning).
 *
 * Idempotent semantics: the RPC filters on `revoked_at IS NULL`, so
 * revoking an already-revoked row returns `null` rather than an error.
 * Cross-org revoke is structurally impossible — the RPC's `ims_org_id`
 * filter guarantees the row matched belongs to the caller's org.
 *
 * @param {object} postgrestClient
 * @param {object} args
 * @param {string} args.id              - Binding row id.
 * @param {string} args.imsOrgId        - REQUIRED — org scope guard.
 * @param {string} args.revokedBy       - IMS user id of the revoker (audit).
 * @param {string} [args.revokeReason]  - Optional free-text / enum reason.
 * @returns {Promise<object|null>} The tombstoned row, or `null` when no
 *                                  active row matched (idempotent re-revoke
 *                                  or unknown id).
 */
export async function revokeFacsAccessMappingById(postgrestClient, {
  id,
  imsOrgId,
  revokedBy,
  revokeReason,
}) {
  if (!id) {
    throw new Error('revokeFacsAccessMappingById: id is required');
  }
  if (!imsOrgId) {
    throw new Error('revokeFacsAccessMappingById: imsOrgId is required');
  }
  const { data, error } = await postgrestClient
    .rpc('wrpc_revoke_facs_access_mapping', {
      p_id: id,
      p_ims_org_id: imsOrgId,
      p_revoked_by: revokedBy ?? null,
      p_revoke_reason: revokeReason ?? null,
    });
  if (error) {
    throw new Error(`revokeFacsAccessMappingById failed: ${error.message}`);
  }
  // PostgREST returns the function's return value as the data payload.
  // `wrpc_revoke_facs_access_mapping` returns a `facs_access_mappings` row
  // (or NULL when no active row matched). Some PostgREST clients deliver
  // this as `{...row}`, others as `[{...row}]`; normalize both, and treat
  // null / empty as "no row revoked".
  if (data === null || data === undefined) {
    return null;
  }
  if (Array.isArray(data)) {
    return data[0] ?? null;
  }
  if (typeof data === 'object' && Object.keys(data).length === 0) {
    return null;
  }
  return data;
}
