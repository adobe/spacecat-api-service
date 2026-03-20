/*
 * Copyright 2025 Adobe. All rights reserved.
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
import {
  SiteImsOrgAccess as SiteImsOrgAccessModel,
  AccessGrantLog as AccessGrantLogModel,
} from '@adobe/spacecat-shared-data-access';
import {
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { ImsOrgAccessDto } from '../dto/ims-org-access.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * ImsOrgAccess controller. Manages cross-org delegation grants scoped to a site.
 * All endpoints require admin access (canManageImsOrgAccess).
 *
 * @param {object} ctx - Request context.
 * @returns {object} ImsOrgAccess controller.
 */
function ImsOrgAccessController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { SiteImsOrgAccess, AccessGrantLog, Site } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * POST /sites/:siteId/ims-org-access
   * Creates a delegation grant for a site. Idempotent on duplicate.
   */
  const createGrant = async (context) => {
    if (!accessControlUtil.canManageImsOrgAccess()) {
      return forbidden('Only admins can manage IMS org access grants');
    }

    const { siteId } = context.params;
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const {
      organizationId,
      targetOrganizationId,
      productCode,
      role,
      expiresAt,
    } = context.data || {};

    if (!isValidUUID(organizationId)) {
      return badRequest('organizationId (delegate org UUID) required');
    }
    if (!isValidUUID(targetOrganizationId)) {
      return badRequest('targetOrganizationId (site-owning org UUID) required');
    }
    if (!productCode) {
      return badRequest('productCode required');
    }

    // grantedBy is derived from the authenticated identity, not the request body.
    const { sub } = accessControlUtil.authInfo.getProfile() || {};
    const grantedBy = sub ? `ims:${sub}` : 'system';

    try {
      const grant = await SiteImsOrgAccess.create({
        siteId,
        organizationId,
        targetOrganizationId,
        productCode,
        role: role || SiteImsOrgAccessModel.DELEGATION_ROLES.AGENCY,
        grantedBy,
        expiresAt,
        updatedBy: grantedBy,
      });

      if (AccessGrantLog) {
        await AccessGrantLog.create({
          siteId,
          organizationId,
          targetOrganizationId,
          productCode,
          action: AccessGrantLogModel.GRANT_ACTIONS.GRANT,
          role: grant.getRole(),
          performedBy: grantedBy,
        }).catch((err) => ctx.log.warn('[ImsOrgAccess] Failed to write access grant log', err));
      }

      return createResponse(ImsOrgAccessDto.toJSON(grant), 201);
    } catch (e) {
      if (e.status === 409) {
        return createResponse({ message: e.message }, 409);
      }
      ctx.log.error(`[ImsOrgAccess] Error creating grant for site ${siteId}`, e);
      return internalServerError(e.message);
    }
  };

  /**
   * GET /sites/:siteId/ims-org-access
   * Lists all grants for a site.
   */
  const listGrants = async (context) => {
    if (!accessControlUtil.canManageImsOrgAccess()) {
      return forbidden('Only admins can manage IMS org access grants');
    }

    const { siteId } = context.params;
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    try {
      const grants = await SiteImsOrgAccess.allBySiteId(siteId);
      return ok(grants.map((g) => ImsOrgAccessDto.toJSON(g)));
    } catch (e) {
      ctx.log.error(`[ImsOrgAccess] Error listing grants for site ${siteId}`, e);
      return internalServerError(e.message);
    }
  };

  /**
   * GET /sites/:siteId/ims-org-access/:accessId
   * Gets a single grant by ID.
   */
  const getGrant = async (context) => {
    if (!accessControlUtil.canManageImsOrgAccess()) {
      return forbidden('Only admins can manage IMS org access grants');
    }

    const { siteId, accessId } = context.params;
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(accessId)) {
      return badRequest('Access ID required');
    }

    try {
      const grant = await SiteImsOrgAccess.findById(accessId);
      if (!grant || grant.getSiteId() !== siteId) {
        return notFound('Grant not found');
      }
      return ok(ImsOrgAccessDto.toJSON(grant));
    } catch (e) {
      ctx.log.error(`[ImsOrgAccess] Error getting grant ${accessId}`, e);
      return internalServerError(e.message);
    }
  };

  /**
   * DELETE /sites/:siteId/ims-org-access/:accessId
   * Revokes a delegation grant. Writes an audit log entry before removal.
   */
  const revokeGrant = async (context) => {
    if (!accessControlUtil.canManageImsOrgAccess()) {
      return forbidden('Only admins can manage IMS org access grants');
    }

    const { siteId, accessId } = context.params;
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(accessId)) {
      return badRequest('Access ID required');
    }

    // performedBy is derived from the authenticated identity, not the request body.
    const { sub } = accessControlUtil.authInfo.getProfile() || {};
    const performedBy = sub ? `ims:${sub}` : 'system';

    try {
      const grant = await SiteImsOrgAccess.findById(accessId);
      if (!grant || grant.getSiteId() !== siteId) {
        return notFound('Grant not found');
      }

      if (AccessGrantLog) {
        await AccessGrantLog.create({
          siteId,
          organizationId: grant.getOrganizationId(),
          targetOrganizationId: grant.getTargetOrganizationId(),
          productCode: grant.getProductCode(),
          action: AccessGrantLogModel.GRANT_ACTIONS.REVOKE,
          role: grant.getRole(),
          performedBy,
        }).catch((err) => ctx.log.warn('[ImsOrgAccess] Failed to write access revoke log', err));
      }

      await grant.remove();
      return createResponse(null, 204);
    } catch (e) {
      ctx.log.error(`[ImsOrgAccess] Error revoking grant ${accessId}`, e);
      return internalServerError(e.message);
    }
  };

  return {
    createGrant,
    listGrants,
    getGrant,
    revokeGrant,
  };
}

export default ImsOrgAccessController;
