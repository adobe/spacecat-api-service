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
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';

/**
 * UserDetails controller. Provides methods to fetch user details by external user ID.
 * @param {object} ctx - Context of the request.
 * @returns {object} UserDetails controller.
 * @constructor
 */
function UserDetailsController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess, imsClient, log } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { TrialUser, Organization } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Helper function to fetch user details from IMS if user is admin.
   * @param {string} externalUserId - The external user ID to fetch from IMS.
   * @param {string} organizationId - The organization ID for fallback.
   * @returns {Promise<Object>} User details object.
   */
  const fetchFromImsIfAdmin = async (externalUserId, organizationId) => {
    // Check if requestor has admin access
    if (!accessControlUtil.hasAdminAccess()) {
      log.debug(`User is not admin, returning system defaults for ${externalUserId}`);
      return {
        firstName: 'system',
        lastName: '',
        email: 'system',
        organizationId,
      };
    }

    // Try to fetch from IMS for admin users
    try {
      log.debug(`Admin user requesting details for ${externalUserId}, attempting IMS fallback`);
      const imsProfile = await imsClient.getImsAdminProfile(externalUserId);
      return {
        firstName: imsProfile.first_name || 'system',
        lastName: imsProfile.last_name || '',
        email: imsProfile.email || 'system',
        organizationId,
      };
    } catch (error) {
      log.warn(`Failed to fetch user details from IMS for ${externalUserId}: ${error.message}`);
      return {
        firstName: 'system',
        lastName: '',
        email: 'system',
        organizationId,
      };
    }
  };

  /**
   * Gets user details by external user ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} User details response.
   */
  const getUserDetailsByExternalUserId = async (context) => {
    const { organizationId, externalUserId } = context.params;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    if (!hasText(externalUserId)) {
      return badRequest('External user ID is required');
    }

    try {
      // Check if user has access to the organization
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Access denied to this organization');
      }

      // Find trial user by external user ID and organization ID
      const trialUsers = await TrialUser.allByOrganizationId(organizationId);
      const trialUser = trialUsers.find(
        (user) => user.getExternalUserId() === externalUserId,
      );

      let userDetails;
      if (trialUser) {
        userDetails = {
          firstName: trialUser.getFirstName(),
          lastName: trialUser.getLastName(),
          email: trialUser.getEmailId(),
          organizationId: trialUser.getOrganizationId(),
        };
      } else {
        // User not found in trial users - try IMS if admin
        userDetails = await fetchFromImsIfAdmin(externalUserId, organizationId);
      }

      return ok(userDetails);
    } catch (e) {
      context.log.error(`Error getting user details for external user ID ${externalUserId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Gets user details for multiple users in bulk.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Bulk user details response.
   */
  const getUserDetailsInBulk = async (context) => {
    const { organizationId } = context.params;
    const { userIds } = context.data;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return badRequest('userIds array is required and must not be empty');
    }

    try {
      // Check if user has access to the organization
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound('Organization not found');
      }

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Access denied to this organization');
      }

      // Fetch all trial users for the organization
      const trialUsers = await TrialUser.allByOrganizationId(organizationId);

      // Create a map of externalUserId to user details
      const userDetailsMap = {};
      let imsCallCount = 0;

      for (const externalUserId of userIds) {
        const trialUser = trialUsers.find(
          (user) => user.getExternalUserId() === externalUserId,
        );

        if (trialUser) {
          userDetailsMap[externalUserId] = {
            firstName: trialUser.getFirstName(),
            lastName: trialUser.getLastName(),
            email: trialUser.getEmailId(),
            organizationId: trialUser.getOrganizationId(),
          };
        } else {
          // User not found in trial users - try IMS if admin
          imsCallCount += 1;
          // eslint-disable-next-line no-await-in-loop
          const details = await fetchFromImsIfAdmin(externalUserId, organizationId);
          userDetailsMap[externalUserId] = details;
        }
      }

      // Log IMS fallback count
      if (imsCallCount > 0) {
        context.log.info(`Fetched user details from IMS ${imsCallCount} times for organization ${organizationId}`);
      }

      return ok(userDetailsMap);
    } catch (e) {
      context.log.error(`Error getting bulk user details for organization ${organizationId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  return {
    getUserDetailsByExternalUserId,
    getUserDetailsInBulk,
  };
}

export default UserDetailsController;
