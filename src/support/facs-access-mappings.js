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
 * PostgREST helpers for the `facs_access_mappings` table — management
 * endpoints only.
 *
 * Phase 2 of the MAC/FACS integration. The table itself lives in
 * `mysticat-data-service` (db/migrations/20260528000000_facs_access_mappings.sql).
 *
 * The wrapper-side point read (`findFacsAccessMapping`) lives in
 * `@adobe/spacecat-shared-http-utils/src/auth/facs-state-layer.js` next to
 * `facsWrapper`, so the wrapper has a single source of truth for the
 * authorisation query. This module hosts the bulk variants the state-layer
 * management endpoints need (list / bulk-create / bulk-delete /
 * single-delete-by-id).
 *
 * Every read and write is **always** scoped to `imsOrgId`. Cross-org access is
 * structurally impossible via this module — there is no helper that accepts a
 * row id without also requiring an `imsOrgId` filter.
 */

// `requirePostgrestForFacsMappings` is re-exported from a shared module so
// the V2 brand controller and the FACS state-layer endpoints share one
// availability check (with their own error messages). See
// `src/support/postgrest-availability.js` for the implementation.
export { requirePostgrestForFacsMappings } from './postgrest-availability.js';

/**
 * Lists access mappings within the caller's org. All filters are optional —
 * absence narrows nothing. The caller MUST pass `imsOrgId` so cross-org
 * queries are structurally impossible.
 *
 * @param {object} postgrestClient
 * @param {object} filters
 * @param {string} filters.imsOrgId            - REQUIRED.
 * @param {'user'|'org'} [filters.subjectType]
 * @param {string} [filters.subjectId]
 * @param {string} [filters.facsPermission]
 * @param {string} [filters.resourceType]
 * @param {string} [filters.resourceId]
 * @param {number} [filters.limit=100]         - Max rows returned (capped at 500).
 * @returns {Promise<object[]>}
 */
export async function listFacsAccessMappings(postgrestClient, filters = {}) {
  const {
    imsOrgId,
    subjectType,
    subjectId,
    facsPermission,
    resourceType,
    resourceId,
    limit,
  } = filters;
  if (!imsOrgId) {
    throw new Error('listFacsAccessMappings: imsOrgId is required');
  }
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  let query = postgrestClient
    .from('facs_access_mappings')
    .select('*')
    .eq('ims_org_id', imsOrgId)
    .order('updated_at', { ascending: false })
    .limit(capped);
  if (subjectType) {
    query = query.eq('subject_type', subjectType);
  }
  if (subjectId) {
    query = query.eq('subject_id', subjectId);
  }
  if (facsPermission) {
    query = query.eq('facs_permission', facsPermission);
  }
  if (resourceType) {
    query = query.eq('resource_type', resourceType);
  }
  if (resourceId) {
    query = query.eq('resource_id', resourceId);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`listFacsAccessMappings failed: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Bulk-inserts mappings. Each row carries a uniform `(facsPermission,
 * resourceType, resourceId, imsOrgId)` triple and one of the supplied
 * `subjects`. Duplicates (matching the unique key
 * `(subject_type, subject_id, facs_permission, resource_type, resource_id,
 * ims_org_id)`) land in `skipped` rather than failing the whole batch —
 * idempotent by design.
 *
 * @param {object} postgrestClient
 * @param {object} args
 * @param {string} args.imsOrgId
 * @param {string} args.facsPermission
 * @param {string} args.resourceType
 * @param {string} args.resourceId
 * @param {Array<{ type: 'user'|'org', id: string }>} args.subjects
 * @param {string} [args.createdBy] - Audit trail.
 * @returns {Promise<{ created: object[], skipped: Array<{ subject: object, reason: string }> }>}
 */
export async function bulkCreateFacsAccessMappings(postgrestClient, {
  imsOrgId,
  facsPermission,
  resourceType,
  resourceId,
  subjects,
  createdBy,
}) {
  if (!Array.isArray(subjects) || subjects.length === 0) {
    return { created: [], skipped: [] };
  }
  const rows = subjects.map(({ type, id }) => ({
    subject_type: type,
    subject_id: id,
    facs_permission: facsPermission,
    resource_type: resourceType,
    resource_id: resourceId,
    ims_org_id: imsOrgId,
    created_by: createdBy ?? null,
    updated_by: createdBy ?? null,
  }));

  // PostgREST upsert-style insert with onConflict: rows matching the unique
  // index are returned in `data` only if they were actually inserted — when
  // ignoreDuplicates: true, conflicting rows are silently skipped. We then
  // diff against the requested rows to compute the `skipped` array.
  const { data, error } = await postgrestClient
    .from('facs_access_mappings')
    .upsert(rows, {
      onConflict:
        'subject_type,subject_id,facs_permission,resource_type,resource_id,ims_org_id',
      ignoreDuplicates: true,
    })
    .select('*');
  if (error) {
    throw new Error(`bulkCreateFacsAccessMappings failed: ${error.message}`);
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
 * Bulk-delete mappings matching `(facsPermission, resourceType, resourceId,
 * imsOrgId)` for the given subjects. Returns the rows that were actually
 * removed plus any subjects that did not match an existing row.
 *
 * @param {object} postgrestClient
 * @param {object} args - same shape as `bulkCreateFacsAccessMappings` minus createdBy.
 * @returns {Promise<{ deleted: object[], skipped: Array<{ subject: object, reason: string }> }>}
 */
export async function bulkDeleteFacsAccessMappings(postgrestClient, {
  imsOrgId,
  facsPermission,
  resourceType,
  resourceId,
  subjects,
}) {
  if (!Array.isArray(subjects) || subjects.length === 0) {
    return { deleted: [], skipped: [] };
  }
  // Group subject ids by type so we can issue at most two delete statements
  // (PostgREST .in() only takes a list of values for one column).
  const idsByType = subjects.reduce((acc, { type, id }) => {
    (acc[type] ||= []).push(id);
    return acc;
  }, {});

  const deleted = [];
  for (const [type, ids] of Object.entries(idsByType)) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await postgrestClient
      .from('facs_access_mappings')
      .delete()
      .eq('ims_org_id', imsOrgId)
      .eq('subject_type', type)
      .eq('facs_permission', facsPermission)
      .eq('resource_type', resourceType)
      .eq('resource_id', resourceId)
      .in('subject_id', ids)
      .select('*');
    if (error) {
      throw new Error(`bulkDeleteFacsAccessMappings failed: ${error.message}`);
    }
    deleted.push(...(data ?? []));
  }

  const deletedKey = (row) => `${row.subject_type}|${row.subject_id}`;
  const deletedKeys = new Set(deleted.map(deletedKey));
  const skipped = subjects
    .filter(({ type, id }) => !deletedKeys.has(`${type}|${id}`))
    .map((subject) => ({ subject, reason: 'not-found' }));
  return { deleted, skipped };
}

/**
 * Removes a single mapping by primary key, but ONLY within the caller's org.
 * Returns the deleted row when removed, or `null` when no row matched —
 * which is the standard "remove this exact grant" UI flow's idempotent
 * outcome.
 *
 * @param {object} postgrestClient
 * @param {object} args
 * @param {string} args.id
 * @param {string} args.imsOrgId
 * @returns {Promise<object|null>}
 */
export async function deleteFacsAccessMappingById(postgrestClient, { id, imsOrgId }) {
  const { data, error } = await postgrestClient
    .from('facs_access_mappings')
    .delete()
    .eq('id', id)
    .eq('ims_org_id', imsOrgId)
    .select('*')
    .maybeSingle();
  if (error) {
    throw new Error(`deleteFacsAccessMappingById failed: ${error.message}`);
  }
  return data ?? null;
}
