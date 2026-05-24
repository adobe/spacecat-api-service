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
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isValidUUID } from '@adobe/spacecat-shared-utils';

import {
  createFacsAccessMappings,
  listFacsAccessMappings,
  listFacsAccessMappingHistory,
  requirePostgrestForFacsMappings,
  revokeFacsAccessMappingById,
} from '../support/facs-access-mappings.js';
import { getBrandById } from '../support/brands-storage.js';

const MAX_SUBJECTS_PER_REQUEST = 100;
const ALLOWED_SUBJECT_TYPES = new Set(['user', 'org']);

/**
 * Phase 2 of the MAC/FACS integration: management endpoints for
 * `facs_access_mappings`. Customers' org admins assign / revoke brand-scoped
 * access for users in their own org via these endpoints.
 *
 * Four endpoints, all gated on `llmo/can_manage_user` at the wrapper:
 *   - `GET /facs/access-mappings`         — list active bindings
 *   - `GET /facs/access-mappings/history` — list active + revoked (audit)
 *   - `POST /facs/access-mappings`        — bulk-create bindings
 *   - `DELETE /facs/access-mappings/:id`  — soft-revoke by id (non-revertable)
 *
 * `required-capabilities.js` excludes these routes from the S2S surface.
 * The wrapper-level admin bypass (`PRODUCTS_FACS_ADMIN_PERMISSIONS`) admits
 * holders of `llmo/can_manage_user` without consulting the route gate —
 * listing the permission in `PRODUCTS_ROUTES.LLMO` exists for the coverage
 * invariant only.
 *
 * Two preconditions on POST (mac-state-layer.md §"Resource-ownership
 * precondition"):
 *   1. The resource (brand) referenced in the body must belong to the
 *      caller's IMS org. A resource owned by another org returns 403 for
 *      the whole request.
 *   2. Each subject in `subjects[]` must be a member of the caller's IMS
 *      org. Subjects that fail this check are placed in the response's
 *      `rejected` bucket — distinct from `skipped` (idempotent duplicates).
 *
 * The binding row carries no capability — capability is decided by FACS /
 * MacGiver at login and lives in the JWT. The state layer answers only
 * "is this subject scoped to this resource in this org?".
 */
function FacsAccessMappingsController(context) {
  const { log } = context;

  /**
   * Resolve the caller's IMS org. Always returns a bare ident
   * (no `@AdobeOrg` suffix) so it matches the `ims_org_id` column shape
   * and what IMS returns in `orgRef.ident`.
   */
  function resolveCallerImsOrgId(ctx) {
    return ctx.attributes?.authInfo?.getTenantIds?.()?.[0] ?? null;
  }

  /**
   * Resolve the canonical caller identifier for audit columns. After the
   * auth-service canonicalization (mac-state-layer.md §"Identifiers and
   * flags"), `profile.sub` is the `<ident>@<authSrc>` form. Returns null
   * when the auth path didn't set `sub` (legacy JWT or anonymous).
   */
  function resolveCallerUserIdent(ctx) {
    return ctx.attributes?.authInfo?.getProfile?.()?.sub ?? null;
  }

  /**
   * Returns true when the brand identified by `resourceId` belongs to the
   * caller's IMS org. Two lookups: IMS org → SpaceCat org (via
   * `Organization.findByImsOrgId`), then brand under that SpaceCat org
   * (via `getBrandById`). Either lookup missing → not owned.
   *
   * This is the controller's defence-in-depth resource-ownership gate
   * (mac-state-layer.md §"Resource-ownership precondition"). The wrapper
   * has already validated FACS permission; this check stops a caller from
   * binding subjects to a brand owned by another IMS org.
   */
  async function isBrandOwnedByCallerOrg(ctx, brandId, imsOrgId) {
    const { Organization } = ctx.dataAccess;
    const org = await Organization.findByImsOrgId(imsOrgId);
    if (!org) {
      return false;
    }
    const { postgrestClient } = ctx.dataAccess.services;
    const brand = await getBrandById(org.getId(), brandId, postgrestClient);
    return Boolean(brand);
  }

  /**
   * Returns true when the supplied subject is a member of the caller's
   * IMS org. For `subject.type === 'org'`, the only legal value is the
   * caller's own org id (cross-org binding to another org isn't a v1
   * concern). For `subject.type === 'user'`, calls `imsClient.
   * getImsAdminOrganizations(subject.id)` and walks the response —
   * the response is an array of `{ orgRef: { ident, authSrc }, ... }`;
   * we compare `orgRef.ident` against the caller's bare-ident IMS org id.
   *
   * Fails closed on IMS-client errors: an outage or unknown user surfaces
   * as `false`, which lands the subject in the `rejected` bucket rather
   * than admitting it on the optimistic assumption that membership holds.
   *
   * TODO(MAC-IMS-API): confirm with the IMS team that
   * `getImsAdminOrganizations` is the right endpoint for membership checks
   * at this volume (one call per subject per POST). If a bulk endpoint
   * becomes available, switch to it to bound POST latency.
   */
  async function isSubjectInOrg(ctx, subject, imsOrgId) {
    if (subject.type === 'org') {
      return subject.id === imsOrgId;
    }
    // type === 'user'
    const { imsClient } = ctx;
    if (!imsClient?.getImsAdminOrganizations) {
      log.warn(
        { tag: 'facs-mappings', subject: subject.id },
        'imsClient not available — failing subject-membership check closed',
      );
      return false;
    }
    try {
      const orgs = await imsClient.getImsAdminOrganizations(subject.id);
      return Array.isArray(orgs) && orgs.some((o) => o?.orgRef?.ident === imsOrgId);
    } catch (err) {
      log.warn(
        { tag: 'facs-mappings', subject: subject.id, err: err.message },
        'IMS membership check failed — rejecting subject',
      );
      return false;
    }
  }

  function validateCreateBody(data) {
    if (!data || typeof data !== 'object') {
      return 'request body is required';
    }
    const { resourceType, resourceId, subjects } = data;
    if (!hasText(resourceType)) {
      return 'resourceType is required';
    }
    if (resourceType !== 'brand') {
      return 'resourceType must be \'brand\' for v1';
    }
    if (!hasText(resourceId) || !isValidUUID(resourceId)) {
      return 'resourceId must be a valid UUID';
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

  function buildListFilters(ctx, imsOrgId) {
    const params = ctx.pathInfo?.params || {};
    const queryParams = ctx.pathInfo?.queryParams || {};
    return {
      imsOrgId,
      subjectType: queryParams.subjectType || params.subjectType,
      subjectId: queryParams.subjectId || params.subjectId,
      resourceType: queryParams.resourceType || params.resourceType,
      resourceId: queryParams.resourceId || params.resourceId,
      limit: queryParams.limit || params.limit,
    };
  }

  /**
   * GET /facs/access-mappings — list ACTIVE bindings, filtered by query
   * params, always scoped to the caller's org.
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

    const filters = buildListFilters(ctx, imsOrgId);
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
   * GET /facs/access-mappings/history — list ACTIVE + REVOKED bindings
   * (audit surface). Same query filters as the active list, plus an
   * optional `since=<ISO>` filter for time-range slicing.
   */
  async function listHistory(ctx) {
    const guard = requirePostgrestForFacsMappings(ctx);
    if (guard) {
      return guard;
    }

    const imsOrgId = resolveCallerImsOrgId(ctx);
    if (!imsOrgId) {
      return forbidden('Caller has no IMS org');
    }

    const filters = buildListFilters(ctx, imsOrgId);
    if (filters.subjectType && !ALLOWED_SUBJECT_TYPES.has(filters.subjectType)) {
      return badRequest('subjectType filter must be \'user\' or \'org\'');
    }
    const queryParams = ctx.pathInfo?.queryParams || {};
    if (queryParams.since) {
      filters.since = queryParams.since;
    }

    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const rows = await listFacsAccessMappingHistory(postgrestClient, filters);
      return ok({ mappings: rows });
    } catch (error) {
      log.error({ tag: 'facs-mappings', err: error.message }, 'Failed to list FACS access mapping history');
      return internalServerError('Failed to list access mapping history');
    }
  }

  /**
   * POST /facs/access-mappings — bulk-create subject→resource bindings.
   *
   * Body shape: `{ resourceType, resourceId, subjects[] }`. No
   * `facsPermission` field — capability is decided by FACS at login.
   *
   * Returns `201 { created[], rejected[], skipped[] }`:
   *   - `created`  — bindings that were inserted.
   *   - `rejected` — subjects that failed the membership check
   *                  (`reason: 'not-in-org'`).
   *   - `skipped`  — subjects whose binding already exists active
   *                  (`reason: 'duplicate'`).
   *
   * Returns 403 when the resource doesn't belong to the caller's org —
   * the request is structurally invalid; we don't partial-respond.
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

    const err = validateCreateBody(ctx.data);
    if (err) {
      return badRequest(err);
    }

    const { resourceType, resourceId, subjects } = ctx.data;
    const createdBy = resolveCallerUserIdent(ctx);

    // (1) Resource-ownership precondition — request-level, fail-closed 403.
    let owned;
    try {
      owned = await isBrandOwnedByCallerOrg(ctx, resourceId, imsOrgId);
    } catch (error) {
      log.error(
        { tag: 'facs-mappings', err: error.message, resourceId },
        'Resource-ownership lookup failed',
      );
      return internalServerError('Failed to verify resource ownership');
    }
    if (!owned) {
      log.warn(
        { tag: 'facs-mappings', imsOrgId, resourceId },
        'Resource not owned by caller org — denying create',
      );
      return forbidden('Resource not owned by caller org');
    }

    // (2) Subject-membership precondition — per-subject, partition into
    //     `eligible` (proceed to insert) and `rejected` (skip with reason).
    const eligible = [];
    const rejected = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const subject of subjects) {
      // eslint-disable-next-line no-await-in-loop
      const inOrg = await isSubjectInOrg(ctx, subject, imsOrgId);
      if (inOrg) {
        eligible.push(subject);
      } else {
        rejected.push({ subject, reason: 'not-in-org' });
      }
    }

    if (eligible.length === 0) {
      return createResponse({ created: [], rejected, skipped: [] }, 201);
    }

    // (3) Bulk-insert the eligible subjects. Duplicates of active rows land
    //     in `skipped`.
    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const result = await createFacsAccessMappings(postgrestClient, {
        imsOrgId,
        resourceType,
        resourceId,
        subjects: eligible,
        createdBy,
      });
      return createResponse({ ...result, rejected }, 201);
    } catch (error) {
      log.error(
        { tag: 'facs-mappings', err: error.message },
        'Failed to create FACS access mappings',
      );
      return internalServerError('Failed to create access mappings');
    }
  }

  /**
   * DELETE /facs/access-mappings/:id — soft-revoke a single binding by row
   * id, scoped to the caller's org. The reason is optional and may come
   * from the request body OR the `?reason=` query param (some CDNs strip
   * DELETE bodies; the fallback keeps the API usable).
   *
   * Returns the tombstoned row when revoked, 404 when no active row
   * matched (idempotent re-revoke or unknown id). The revoke RPC enforces
   * ims-org scoping — cross-org revoke is structurally impossible.
   */
  async function revokeMappingById(ctx) {
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

    const queryParams = ctx.pathInfo?.queryParams || {};
    const reasonFromBody = ctx.data && typeof ctx.data === 'object' ? ctx.data.reason : undefined;
    const revokeReason = reasonFromBody || queryParams.reason || null;

    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const tombstone = await revokeFacsAccessMappingById(postgrestClient, {
        id,
        imsOrgId,
        revokedBy: resolveCallerUserIdent(ctx),
        revokeReason,
      });
      if (!tombstone) {
        return notFound('Mapping not found');
      }
      return ok(tombstone);
    } catch (error) {
      log.error(
        { tag: 'facs-mappings', err: error.message, id },
        'Failed to revoke FACS access mapping by id',
      );
      return internalServerError('Failed to revoke access mapping');
    }
  }

  return {
    listMappings,
    listHistory,
    createMappings,
    revokeMappingById,
  };
}

export default FacsAccessMappingsController;
