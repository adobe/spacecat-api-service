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
  createResponse,
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

  /**
   * Adds enrollments for an entitlement.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of created enrollments response.
   */
  const addEnrollments = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can add enrollments');
    }

    const { entitlementId } = context.params;
    if (!isValidUUID(entitlementId)) {
      return badRequest('Entitlement ID required');
    }

    const { siteIds } = context.data;
    if (!Array.isArray(siteIds) || siteIds.length === 0) {
      return badRequest('siteIds array is required and must not be empty');
    }

    // Validate all siteIds are UUIDs
    const invalidSiteIds = siteIds.filter((siteId) => !isValidUUID(siteId));
    if (invalidSiteIds.length > 0) {
      return badRequest(`Invalid site IDs: ${invalidSiteIds.join(', ')}`);
    }

    try {
      // Verify entitlement exists
      const entitlement = await Entitlement.findById(entitlementId);
      if (!entitlement) {
        return notFound('Entitlement not found');
      }

      const { SiteEnrollment, Site } = dataAccess;

      // Process each siteId in parallel
      const enrollmentPromises = siteIds.map(async (siteId) => {
        try {
          // Verify site exists
          const site = await Site.findById(siteId);
          if (!site) {
            return {
              success: false,
              siteId,
              error: 'Site not found',
            };
          }

          // Check if enrollment already exists
          const existingEnrollments = await SiteEnrollment.allBySiteId(siteId);
          const existingEnrollment = existingEnrollments.find(
            (enrollment) => enrollment.getEntitlementId() === entitlementId,
          );

          if (existingEnrollment) {
            return {
              success: false,
              siteId,
              error: 'Enrollment already exists',
            };
          }

          // Create enrollment
          const enrollment = await SiteEnrollment.create({
            siteId,
            entitlementId,
          });

          context.log.info(`Created enrollment ${enrollment.getId()} for site ${siteId} and entitlement ${entitlementId}`);

          return {
            success: true,
            siteId,
            enrollmentId: enrollment.getId(),
            entitlementId: enrollment.getEntitlementId(),
            createdAt: enrollment.getCreatedAt(),
          };
        } catch (error) {
          context.log.error(`Error creating enrollment for site ${siteId}: ${error.message}`);
          return {
            success: false,
            siteId,
            error: error.message,
          };
        }
      });

      const enrollmentResults = await Promise.allSettled(enrollmentPromises);

      const results = [];
      const errors = [];

      enrollmentResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          const {
            success, siteId, error, ...data
          } = result.value;
          if (success) {
            results.push({ siteId, ...data });
          } else {
            errors.push({ siteId, error });
          }
        } else {
          errors.push({
            siteId: 'unknown',
            error: result.reason?.message || 'Unknown error',
          });
        }
      });

      const response = {
        success: results,
        errors,
        summary: {
          total: siteIds.length,
          successful: results.length,
          failed: errors.length,
        },
      };

      // Return 201 if at least one enrollment was created, otherwise 400
      if (results.length > 0) {
        return created(response);
      }

      return createResponse(response, 400);
    } catch (e) {
      context.log.error(`Error adding enrollments for entitlement ${entitlementId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Deletes enrollments by their IDs.
   * Note: Uses POST method instead of DELETE because the @adobe/helix-shared-body-data
   * middleware does not parse request bodies for DELETE requests.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Response with deletion results.
   */
  const deleteEnrollments = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can delete enrollments');
    }

    const { enrollmentIds } = context.data;
    if (!Array.isArray(enrollmentIds) || enrollmentIds.length === 0) {
      return badRequest('enrollmentIds array is required and must not be empty');
    }

    // Validate all enrollmentIds are UUIDs
    const invalidEnrollmentIds = enrollmentIds.filter((enrollmentId) => !isValidUUID(enrollmentId));
    if (invalidEnrollmentIds.length > 0) {
      return badRequest(`Invalid enrollment IDs: ${invalidEnrollmentIds.join(', ')}`);
    }

    try {
      const { SiteEnrollment } = dataAccess;

      // Process each enrollmentId in parallel
      const deletionPromises = enrollmentIds.map(async (enrollmentId) => {
        try {
          // Verify enrollment exists
          const enrollment = await SiteEnrollment.findById(enrollmentId);
          if (!enrollment) {
            return {
              success: false,
              enrollmentId,
              error: 'Enrollment not found',
            };
          }

          const siteId = enrollment.getSiteId();
          const entitlementId = enrollment.getEntitlementId();

          // Delete enrollment
          await enrollment.remove();

          context.log.info(`Deleted enrollment ${enrollmentId} for site ${siteId}`);

          return {
            success: true,
            enrollmentId,
            siteId,
            entitlementId,
          };
        } catch (error) {
          context.log.error(`Error deleting enrollment ${enrollmentId}: ${error.message}`);
          return {
            success: false,
            enrollmentId,
            error: error.message,
          };
        }
      });

      const deletionResults = await Promise.allSettled(deletionPromises);

      const results = [];
      const errors = [];

      deletionResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          const {
            success, enrollmentId, error, ...data
          } = result.value;
          if (success) {
            results.push({ enrollmentId, ...data });
          } else {
            errors.push({ enrollmentId, error });
          }
        } else {
          errors.push({
            enrollmentId: 'unknown',
            error: result.reason?.message || 'Unknown error',
          });
        }
      });

      const response = {
        success: results,
        errors,
        summary: {
          total: enrollmentIds.length,
          successful: results.length,
          failed: errors.length,
        },
      };

      // Return 200 if at least one enrollment was deleted, otherwise 400
      if (results.length > 0) {
        return ok(response);
      }

      return createResponse(response, 400);
    } catch (e) {
      context.log.error(`Error deleting enrollments: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  return {
    getByOrganizationID,
    createEntitlement,
    addEnrollments,
    deleteEnrollments,
  };
}

export default EntitlementsController;
