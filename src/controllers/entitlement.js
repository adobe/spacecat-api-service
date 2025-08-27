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
  createResponse,
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
  hasText,
} from '@adobe/spacecat-shared-utils';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';

import { EntitlementDto } from '../dto/entitlement.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * Entitlement controller. Provides methods to read entitlements by organization.
 * @param {object} ctx - Context of the request.
 * @returns {object} Entitlement controller.
 * @constructor
 */
function EntitlementController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Entitlement, Organization } = dataAccess;

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

      // Check if user has access to this organization
      const accessControlUtil = AccessControlUtil.fromContext(context);
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Only users belonging to the organization can view its entitlements');
      }

      const entitlements = await Entitlement.allByOrganizationId(organizationId);
      const orgEntitlements = entitlements
        .map((entitlement) => EntitlementDto.toJSON(entitlement));
      return ok(orgEntitlements);
    } catch (e) {
      return internalServerError(e.message);
    }
  };

  /**
   * Creates a new entitlement for an organization.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Entitlement response.
   */
  const create = async (context) => {
    const { organizationId } = context.params;
    const { productCode, tier, quotas } = context.data;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    if (!hasText(productCode)) {
      return badRequest('Product code is required');
    }

    if (!hasText(tier)) {
      return badRequest('Tier is required');
    }

    // Validate product code
    const validProductCodes = Object.values(EntitlementModel.PRODUCT_CODES);
    if (!validProductCodes.includes(productCode)) {
      return badRequest(`Product code must be one of: ${validProductCodes.join(', ')}`);
    }

    // Validate tier
    const validTiers = Object.values(EntitlementModel.TIERS);
    if (!validTiers.includes(tier)) {
      return badRequest(`Tier must be one of: ${validTiers.join(', ')}`);
    }

    try {
      // Check if user has access to the organization
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      const accessControlUtil = AccessControlUtil.fromContext(context);
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Only users belonging to the organization can create entitlements');
      }

      // Check if entitlement already exists with this product code
      // TODO: Add duplicate check once the correct method names are identified
      // For now, we'll let the database handle uniqueness constraints

      // Create new entitlement
      context.log.info(`Creating new entitlement for organization ${organizationId} with product code ${productCode} and tier ${tier}`);
      context.log.info(`Quotas: ${JSON.stringify(quotas)}`);
      const entitlement = await Entitlement.create({
        organizationId,
        productCode,
        tier,
        quotas: quotas ?? {},
      });

      return createResponse(EntitlementDto.toJSON(entitlement), 201);
    } catch (e) {
      return internalServerError(e.message);
    }
  };

  return {
    getByOrganizationID,
    create,
  };
}

export default EntitlementController;
