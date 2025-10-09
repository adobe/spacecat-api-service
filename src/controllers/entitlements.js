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
  notFound,
  ok,
  forbidden,
  internalServerError,
  created,
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import TierClient from '@adobe/spacecat-shared-tier-client';

import { EntitlementDto } from '../dto/entitlement.js';
import AccessControlUtil from '../support/access-control-util.js';

const LLMO_PRODUCT_CODE = EntitlementModel.PRODUCT_CODES.LLMO;
const LLMO_TIER = EntitlementModel.TIERS.FREE_TRIAL;

/**
 * Entitlements controller. Provides methods to read entitlements by organization.
 * @param {object} ctx - Context of the request.
 * @returns {object} Entitlements controller.
 * @constructor
 */
function EntitlementsController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Entitlement, Organization } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Gets entitlements by organization ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of entitlements response.
   */
  const getByOrganizationID = async (context) => {
    const { organizationId } = context.params;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    try {
      // Get organization to check access control
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Only users belonging to the organization can view its entitlements');
      }

      const entitlements = await Entitlement.allByOrganizationId(organizationId);

      const orgEntitlements = entitlements
        .map((entitlement) => EntitlementDto.toJSON(entitlement));
      return ok(orgEntitlements);
    } catch (e) {
      context.log.error(`Error getting entitlements for organization ${organizationId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Creates an entitlement for an organization.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of entitlements response.
   */
  const createEntitlement = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create entitlements');
    }
    const { organizationId } = context.params;
    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }
    try {
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }
      const tierClient = await TierClient.createForOrg(
        context,
        organization,
        LLMO_PRODUCT_CODE,
      );
      const { entitlement } = await tierClient.createEntitlement(LLMO_TIER);
      return created(EntitlementDto.toJSON(entitlement));
    } catch (e) {
      context.log.error(`Error creating entitlement for organization ${organizationId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  return {
    getByOrganizationID,
    createEntitlement,
  };
}

export default EntitlementsController;
