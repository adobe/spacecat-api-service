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

import {
  badRequest,
  createResponse,
  forbidden,
  internalServerError,
  noContent,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isValidUUID } from '@adobe/spacecat-shared-utils';

import {
  bulkCreateFacsAccessMappings,
  bulkDeleteFacsAccessMappings,
  deleteFacsAccessMappingById,
  listFacsAccessMappings,
  requirePostgrestForFacsMappings,
} from '../support/facs-access-mappings.js';

const MAX_SUBJECTS_PER_REQUEST = 100;
const ALLOWED_SUBJECT_TYPES = new Set(['user', 'org']);

/**
 * Phase 2 of the MAC/FACS integration: management endpoints for
 * `facs_access_mappings`. Customers' org admins assign / revoke ReBAC grants
 * for their own org members via these endpoints.
 *
 * `facsWrapper` (Phase 1) already enforces that the caller holds
 * `llmo/can_manage_user` for the writes and `llmo/can_view` for the read.
 * `required-capabilities.js` excludes these routes from the S2S surface —
 * only authenticated customer admins via FACS can reach them.
 *
 * This is a first-draft controller; expect iteration as the management UI
 * comes online (pagination via cursor, audit trail visibility, etc.).
 */
function FacsAccessMappingsController(context) {
  const { log } = context;

  /**
   * Resolve the caller's IMS org. Always returns a bare ident
   * (no `@AdobeOrg` suffix) so it matches the `ims_org_id` column shape.
   */
  function resolveCallerImsOrgId(ctx) {
    return ctx.attributes?.authInfo?.getTenantIds?.()?.[0] ?? null;
  }

  function resolveCallerUserIdent(ctx) {
    const profile = ctx.attributes?.authInfo?.getProfile?.() || {};
    // Same fallback chain facsWrapper uses for log lines and subject_id
    // resolution: prefer `sub` (JWT session tokens), fall back to `email`
    // (IMS-bearer-token requests).
    return profile.sub || profile.email || null;
  }

  function validateBulkBody(data) {
    if (!data || typeof data !== 'object') {
      return 'request body is required';
    }
    const {
      facsPermission, resourceType, resourceId, subjects,
    } = data;
    if (!hasText(facsPermission)) {
      return 'facsPermission is required';
    }
    if (!hasText(resourceType)) {
      return 'resourceType is required';
    }
    if (!hasText(resourceId)) {
      return 'resourceId is required';
    }
    if (!Array.isArray(subjects) || subjects.length === 0) {
      return 'subjects must be a non-empty array';
    }
    if (subjects.length > MAX_SUBJECTS_PER_REQUEST) {
      return `subjects must contain at most ${MAX_SUBJECTS_PER_REQUEST} entries`;
    }
    for (const subject of subjects) {
      if (!subject || typeof subject !== 'object'
          || !ALLOWED_SUBJECT_TYPES.has(subject.type)
          || !hasText(subject.id)) {
        return 'each subject must be { type: \'user\'|\'org\', id: <non-empty> }';
      }
    }
    return null;
  }

  /**
   * GET /facs/access-mappings — list mappings, filtered by query params,
   * always scoped to the caller's org.
   */
  async function listMappings(ctx) {
    const guard = requirePostgrestForFacsMappings(ctx);
    if (guard) {
      return guard;
    }

    const imsOrgId = resolveCallerImsOrgId(ctx);
    if (!imsOrgId) {
      return forbidden('Caller has no IMS org');
    }

    const params = ctx.pathInfo?.params || {};
    const queryParams = ctx.pathInfo?.queryParams || {};
    const filters = {
      imsOrgId,
      subjectType: queryParams.subjectType || params.subjectType,
      subjectId: queryParams.subjectId || params.subjectId,
      facsPermission: queryParams.facsPermission || params.facsPermission,
      resourceType: queryParams.resourceType || params.resourceType,
      resourceId: queryParams.resourceId || params.resourceId,
      limit: queryParams.limit || params.limit,
    };
    if (filters.subjectType && !ALLOWED_SUBJECT_TYPES.has(filters.subjectType)) {
      return badRequest('subjectType filter must be \'user\' or \'org\'');
    }

    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const rows = await listFacsAccessMappings(postgrestClient, filters);
      return ok({ mappings: rows });
    } catch (error) {
      log.error({ tag: 'facs-mappings', err: error.message }, 'Failed to list FACS access mappings');
      return internalServerError('Failed to list access mappings');
    }
  }

  /**
   * POST /facs/access-mappings — bulk create. See the schema in
   * `src/support/facs-access-mappings.js#bulkCreateFacsAccessMappings`.
   */
  async function createMappings(ctx) {
    const guard = requirePostgrestForFacsMappings(ctx);
    if (guard) {
      return guard;
    }

    const imsOrgId = resolveCallerImsOrgId(ctx);
    if (!imsOrgId) {
      return forbidden('Caller has no IMS org');
    }

    const err = validateBulkBody(ctx.data);
    if (err) {
      return badRequest(err);
    }

    const {
      facsPermission, resourceType, resourceId, subjects,
    } = ctx.data;
    const createdBy = resolveCallerUserIdent(ctx);

    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const result = await bulkCreateFacsAccessMappings(postgrestClient, {
        imsOrgId,
        facsPermission,
        resourceType,
        resourceId,
        subjects,
        createdBy,
      });
      return createResponse(result, 201);
    } catch (error) {
      log.error({ tag: 'facs-mappings', err: error.message }, 'Failed to create FACS access mappings');
      return internalServerError('Failed to create access mappings');
    }
  }

  /**
   * DELETE /facs/access-mappings — bulk delete by body. Same shape as POST.
   */
  async function deleteMappingsBulk(ctx) {
    const guard = requirePostgrestForFacsMappings(ctx);
    if (guard) {
      return guard;
    }

    const imsOrgId = resolveCallerImsOrgId(ctx);
    if (!imsOrgId) {
      return forbidden('Caller has no IMS org');
    }

    const err = validateBulkBody(ctx.data);
    if (err) {
      return badRequest(err);
    }

    const {
      facsPermission, resourceType, resourceId, subjects,
    } = ctx.data;

    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const result = await bulkDeleteFacsAccessMappings(postgrestClient, {
        imsOrgId,
        facsPermission,
        resourceType,
        resourceId,
        subjects,
      });
      return ok(result);
    } catch (error) {
      log.error({ tag: 'facs-mappings', err: error.message }, 'Failed to bulk-delete FACS access mappings');
      return internalServerError('Failed to delete access mappings');
    }
  }

  /**
   * DELETE /facs/access-mappings/:id — single removal by row id, scoped to
   * the caller's org. Idempotent: returns 204 whether the row existed or not
   * (a deliberately permissive UX choice — the row is gone either way).
   */
  async function deleteMappingById(ctx) {
    const guard = requirePostgrestForFacsMappings(ctx);
    if (guard) {
      return guard;
    }

    const imsOrgId = resolveCallerImsOrgId(ctx);
    if (!imsOrgId) {
      return forbidden('Caller has no IMS org');
    }

    const { id } = ctx.pathInfo?.params || {};
    if (!hasText(id) || !isValidUUID(id)) {
      return badRequest('id must be a valid UUID');
    }

    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const deleted = await deleteFacsAccessMappingById(postgrestClient, { id, imsOrgId });
      if (!deleted) {
        return notFound('Mapping not found');
      }
      return noContent();
    } catch (error) {
      log.error({
        tag: 'facs-mappings', err: error.message, id,
      }, 'Failed to delete FACS access mapping by id');
      return internalServerError('Failed to delete access mapping');
    }
  }

  return {
    listMappings,
    createMappings,
    deleteMappingsBulk,
    deleteMappingById,
  };
}

export default FacsAccessMappingsController;
