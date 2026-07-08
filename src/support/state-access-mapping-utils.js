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

// Offset is forwarded to PostgREST's `.range(offset, offset + limit - 1)` so
// pagination happens DB-side (no client-side over-fetch + slice). Any
// non-finite / negative input collapses to 0 (first page).
function clampOffset(offset) {
  const n = Number(offset);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.floor(n);
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
  const off = clampOffset(filters.offset);
  let query = postgrestClient
    .from('facs_access_mappings')
    .select('*')
    .eq('ims_org_id', imsOrgId)
    .eq('product', product)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .range(off, off + clampLimit(limit) - 1);
  query = applySubjectFilter(query, filters);
  query = applyResourceFilter(query, filters);
  const { data, error } = await query;
  if (error) {
    throw new Error(`listFacsAccessMappings failed: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Builds the set of `resource_id`s the caller may **view** for a product +
 * resource type — the union of org-scoped and user-scoped active bindings whose
 * `granted_capabilities` include `<product>/can_view`. Used by ReBAC-filtered
 * collection endpoints (list-sites, list-brands) to narrow results to the
 * resources a resource-scoped caller can see.
 *
 * Org-scoped grants always apply; the user-scoped read runs only when a
 * `subjectId` is known (a missing subjectId must NOT widen the query — without
 * the `subject_id` filter PostgREST would return every user's bindings). Bounded
 * by `MAX_LIST_LIMIT` per subject scope, mirroring the list endpoints.
 *
 * @param {object} postgrestClient
 * @param {object} args
 * @param {string} args.imsOrgId      - REQUIRED. Canonical caller org id.
 * @param {string} args.product       - REQUIRED. Uppercase product code.
 * @param {string} args.resourceType  - REQUIRED. e.g. 'site' | 'brand'.
 * @param {string} [args.subjectId]   - Caller's canonical user id (JWT sub).
 * @returns {Promise<Set<string>>} resource_ids the caller may view.
 */
export async function listViewableResourceIds(postgrestClient, {
  imsOrgId, product, resourceType, subjectId,
}) {
  const viewCapability = `${product.toLowerCase()}/can_view`;
  const subjectScopes = [{ subjectType: 'org', subjectId: imsOrgId }];
  if (subjectId) {
    subjectScopes.push({ subjectType: 'user', subjectId });
  }
  const pages = await Promise.all(subjectScopes.map((scope) => listFacsAccessMappings(
    postgrestClient,
    {
      imsOrgId,
      product,
      resourceType,
      subjectType: scope.subjectType,
      subjectId: scope.subjectId,
      limit: MAX_LIST_LIMIT,
    },
  )));
  const ids = new Set();
  for (const rows of pages) {
    for (const row of rows) {
      if ((row.granted_capabilities ?? []).includes(viewCapability)) {
        ids.add(row.resource_id);
      }
    }
  }
  return ids;
}

/**
 * Fetches a single **active** binding by primary key, scoped to the caller's
 * org + product. Used to authorize PATCH / DELETE before mutating: the caller's
 * management authority is evaluated against the row's `resource_id`
 * (hybrid-model §8.3 — a state-layer manager may only act on resources where
 * they hold `can_manage_users`). Returns the row, or `null` when no active row
 * matches (unknown id, revoked, or a different org / product).
 *
 * @param {object} postgrestClient
 * @param {object} args
 * @param {string} args.id        - Binding row id.
 * @param {string} args.imsOrgId  - REQUIRED — org scope guard.
 * @param {string} args.product   - REQUIRED — product scope guard.
 * @returns {Promise<object|null>}
 */
export async function getFacsAccessMappingById(postgrestClient, { id, imsOrgId, product }) {
  if (!id) {
    throw new Error('getFacsAccessMappingById: id is required');
  }
  if (!imsOrgId) {
    throw new Error('getFacsAccessMappingById: imsOrgId is required');
  }
  if (!product) {
    throw new Error('getFacsAccessMappingById: product is required');
  }
  const { data, error } = await postgrestClient
    .from('facs_access_mappings')
    .select('*')
    .eq('id', id)
    .eq('ims_org_id', imsOrgId)
    .eq('product', product)
    .is('revoked_at', null)
    .limit(1);
  if (error) {
    throw new Error(`getFacsAccessMappingById failed: ${error.message}`);
  }
  return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
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
  const off = clampOffset(filters.offset);
  let query = postgrestClient
    .from('facs_access_mappings')
    .select('*')
    .eq('ims_org_id', imsOrgId)
    .eq('product', product)
    .order('created_at', { ascending: false })
    .range(off, off + clampLimit(limit) - 1);
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
 * Lists rows from the append-only `facs_access_mapping_audit_events` operation
 * log, scoped to the caller's org + product. Backs
 * `GET /organizations/:organizationId/permission/audit-logs`. Ordered by
 * `created_at DESC`; all filters optional.
 *
 * @param {object} postgrestClient
 * @param {object} filters
 * @param {string} filters.imsOrgId      - REQUIRED — the tenant-isolation key.
 * @param {string} filters.product       - REQUIRED. Uppercase product code.
 * @param {string} [filters.operation]   - 'create' | 'update_capabilities' | 'revoke'
 * @param {string} [filters.outcome]     - 'allow' | 'deny' | 'error'
 * @param {string} [filters.resourceType]
 * @param {string} [filters.resourceId]
 * @param {string} [filters.actorId]
 * @param {string} [filters.mappingId]
 * @param {string} [filters.since]       - ISO timestamp; `created_at >= since`.
 * @param {string} [filters.until]       - ISO timestamp; `created_at <= until`.
 * @param {number} [filters.limit=50]    - Default 50; hard cap 500.
 * @returns {Promise<object[]>}
 */
export async function listFacsAccessMappingAuditEvents(postgrestClient, filters = {}) {
  const {
    imsOrgId, product, operation, outcome,
    resourceType, resourceId, actorId, mappingId, since, until, limit,
  } = filters;
  if (!imsOrgId) {
    throw new Error('listFacsAccessMappingAuditEvents: imsOrgId is required');
  }
  if (!product) {
    throw new Error('listFacsAccessMappingAuditEvents: product is required');
  }
  const off = clampOffset(filters.offset);
  let query = postgrestClient
    .from('facs_access_mapping_audit_events')
    .select('*')
    .eq('ims_org_id', imsOrgId)
    .eq('product', product)
    .order('created_at', { ascending: false })
    .range(off, off + clampLimit(limit) - 1);
  const eqFilters = {
    operation,
    outcome,
    resource_type: resourceType,
    resource_id: resourceId,
    actor_id: actorId,
    mapping_id: mappingId,
  };
  for (const [column, value] of Object.entries(eqFilters)) {
    if (value) {
      query = query.eq(column, value);
    }
  }
  if (since) {
    query = query.gte('created_at', since);
  }
  if (until) {
    query = query.lte('created_at', until);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`listFacsAccessMappingAuditEvents failed: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Appends one row to the `facs_access_mapping_audit_events` operation log.
 *
 * The table is append-only by grant: `postgrest_writer` holds SELECT + INSERT
 * (UPDATE / DELETE are revoked), and `postgrest_anon` holds SELECT only. The
 * api-service PostgREST client authenticates as `postgrest_writer`, so a direct
 * insert is the legal write path (no RPC needed — the row is immutable once
 * written).
 *
 * Callers MUST treat a thrown error here as non-fatal for the originating
 * mapping mutation: a failed audit write should log a warning, never fail the
 * create / update / revoke response. (The controller's `emitAuditEvent` wrapper
 * enforces this.)
 *
 * @param {object} postgrestClient
 * @param {object} event
 * @param {string} event.imsOrgId               - REQUIRED — tenant key.
 * @param {string} event.product                - REQUIRED — uppercase product code.
 * @param {string} event.operation              - 'create' | 'update_capabilities' | 'revoke'
 * @param {string} event.outcome                - 'allow' | 'deny' | 'error'
 * @param {number} event.statusCode             - REQUIRED — HTTP status returned
 *                                                to the caller (NOT NULL column).
 * @param {string} [event.actorId]              - IMS ident of the actor. NOT NULL
 *                                                column; coalesced to 'unknown'.
 * @param {string} [event.requestId]            - Invocation/request id. NOT NULL
 *                                                column; coalesced to 'unknown'.
 * @param {string} [event.mappingId]            - Affected binding row id.
 * @param {string} [event.bindingSubjectType]
 * @param {string} [event.bindingSubjectId]
 * @param {string} [event.resourceType]
 * @param {string} [event.resourceId]
 * @param {string[]} [event.grantedCapabilities]
 * @param {string} [event.revokeReason]
 * @param {string} [event.denialReason]
 * @param {number} [event.statusCode]
 * @param {string} [event.errorMessage]
 * @returns {Promise<object|null>} The inserted row, or null.
 */
export async function insertFacsAccessMappingAuditEvent(postgrestClient, event = {}) {
  const {
    imsOrgId,
    product,
    operation,
    outcome,
    statusCode,
    actorId,
    requestId,
    mappingId,
    bindingSubjectType,
    bindingSubjectId,
    resourceType,
    resourceId,
    grantedCapabilities,
    revokeReason,
    denialReason,
    errorMessage,
  } = event;
  if (!imsOrgId) {
    throw new Error('insertFacsAccessMappingAuditEvent: imsOrgId is required');
  }
  if (!product) {
    throw new Error('insertFacsAccessMappingAuditEvent: product is required');
  }
  if (!operation) {
    throw new Error('insertFacsAccessMappingAuditEvent: operation is required');
  }
  if (!outcome) {
    throw new Error('insertFacsAccessMappingAuditEvent: outcome is required');
  }
  // status_code, request_id and actor_id are NOT NULL columns. statusCode is
  // semantically required (the HTTP status); request_id / actor_id are coalesced
  // to 'unknown' so a missing invocation id or anonymous caller never blocks the
  // audit write.
  if (typeof statusCode !== 'number') {
    throw new Error('insertFacsAccessMappingAuditEvent: statusCode (number) is required');
  }
  const row = {
    ims_org_id: imsOrgId,
    product,
    operation,
    outcome,
    status_code: statusCode,
    actor_id: actorId ?? 'unknown',
    request_id: requestId ?? 'unknown',
    mapping_id: mappingId ?? null,
    binding_subject_type: bindingSubjectType ?? null,
    binding_subject_id: bindingSubjectId ?? null,
    resource_type: resourceType ?? null,
    resource_id: resourceId ?? null,
    granted_capabilities: grantedCapabilities ?? null,
    revoke_reason: revokeReason ?? null,
    denial_reason: denialReason ?? null,
    error_message: errorMessage ?? null,
  };
  const { data, error } = await postgrestClient
    .from('facs_access_mapping_audit_events')
    .insert(row)
    .select('*');
  if (error) {
    throw new Error(`insertFacsAccessMappingAuditEvent failed: ${error.message}`);
  }
  return Array.isArray(data) ? (data[0] ?? null) : data;
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
    // On create, last-modified is the creation itself — stamp the creator so a
    // fresh row's `updated_by` reflects the actor. `updated_by` is NOT NULL;
    // fall back to 'system' (the column default) when there's no caller ident.
    updated_by: createdBy ?? 'system',
  }));

  // The active-row uniqueness index is PARTIAL (WHERE revoked_at IS NULL).
  // Postgres `ON CONFLICT (cols)` cannot target a partial index unless the
  // matching predicate is also supplied, and PostgREST's `onConflict` option
  // only emits the column list — so an upsert raises "there is no unique or
  // exclusion constraint matching the ON CONFLICT specification". Instead we
  // insert each row directly and treat a unique-violation (SQLSTATE 23505)
  // against the partial index as a duplicate to skip.
  //
  // Because the index is partial, a previously-revoked binding for the same
  // (subject, resource, org, product) does NOT conflict — it gets a fresh row
  // with a new id. This is the design's "re-grant after revoke = new row, not
  // reactivation" property.
  const results = await Promise.all(rows.map((row) => postgrestClient
    .from('facs_access_mappings')
    .insert(row)
    .select('*')));

  const created = [];
  const skipped = [];
  results.forEach(({ data, error }, i) => {
    if (error && error.code !== '23505') {
      throw new Error(`createFacsAccessMappings failed: ${error.message}`);
    }
    if (error) {
      // 23505: unique violation against the active-row partial index.
      skipped.push({
        subject: { type: rows[i].subject_type, id: rows[i].subject_id },
        reason: 'duplicate',
      });
    } else if (Array.isArray(data) && data.length > 0) {
      created.push(data[0]);
    }
  });
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
  // `wrpc_revoke_facs_access_mapping` is declared `RETURNS facs_access_mappings`,
  // so when no active row matches it yields an ALL-NULL composite row (every
  // column null) rather than SQL NULL — surfaced as an object whose keys are
  // all null. Some clients deliver a single row as `{...row}`, others as
  // `[{...row}]`; normalize both, then treat a missing row OR a row without an
  // `id` (the all-null no-match case) as "no row revoked".
  let row = data;
  if (Array.isArray(data)) {
    row = data[0] ?? null;
  }
  if (!row || typeof row !== 'object' || row.id == null) {
    return null;
  }
  return row;
}

/**
 * Replaces `granted_capabilities` on a single ACTIVE binding, scoped to the
 * caller's org + product. Invokes the `wrpc_set_facs_access_mapping_capabilities`
 * RPC defined in mysticat-data-service — the ONLY legal capability-edit path
 * (no UPDATE grant exists on the table for any REST role; the RPC runs with
 * SECURITY DEFINER and filters on `revoked_at IS NULL`, so it cannot mutate a
 * tombstoned row or change the binding's identity).
 *
 * @param {object} postgrestClient
 * @param {object} args
 * @param {string} args.id                  - Binding row id.
 * @param {string} args.imsOrgId            - REQUIRED — org scope guard.
 * @param {string} args.product             - REQUIRED — product scope guard.
 * @param {string[]} args.grantedCapabilities - New capability set (replaces).
 * @param {string} [args.updatedBy]         - IMS ident of the editor; stamped
 *                                             onto `updated_by` (RPC COALESCEs a
 *                                             null back to 'system').
 * @returns {Promise<object|null>} The updated row, or `null` when no active
 *                                  row matched (unknown id, revoked, or a
 *                                  different org/product).
 */
export async function updateFacsAccessMappingCapabilities(postgrestClient, {
  id,
  imsOrgId,
  product,
  grantedCapabilities,
  updatedBy,
}) {
  if (!id) {
    throw new Error('updateFacsAccessMappingCapabilities: id is required');
  }
  if (!imsOrgId) {
    throw new Error('updateFacsAccessMappingCapabilities: imsOrgId is required');
  }
  if (!product) {
    throw new Error('updateFacsAccessMappingCapabilities: product is required');
  }
  const { data, error } = await postgrestClient
    .rpc('wrpc_set_facs_access_mapping_capabilities', {
      p_id: id,
      p_ims_org_id: imsOrgId,
      p_product: product,
      p_granted_capabilities: grantedCapabilities ?? [],
      // Stamp the editor; the RPC COALESCEs a null back to 'system'.
      p_updated_by: updatedBy ?? null,
    });
  if (error) {
    throw new Error(`updateFacsAccessMappingCapabilities failed: ${error.message}`);
  }
  // Same return contract as the revoke RPC: `RETURNS facs_access_mappings`
  // yields an all-NULL composite row on no-match. Normalize single/array and
  // treat a row without an `id` as "not found".
  let row = data;
  if (Array.isArray(data)) {
    row = data[0] ?? null;
  }
  if (!row || typeof row !== 'object' || row.id == null) {
    return null;
  }
  return row;
}
