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
import { resolveCallerImsUserId } from '../support/utils.js';

// IMS GUID format: <hex>@<alphanumeric-with-dots>
const IMS_USER_ID_RE = /^[A-Za-z0-9]+@[A-Za-z0-9.]+$/;

function toProfileShape(imsProfile) {
  return {
    firstName: imsProfile.first_name || '-',
    lastName: imsProfile.last_name || '-',
    email: imsProfile.email || '',
  };
}

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
   * Resolves the CALLER'S OWN details from their auth profile, bypassing both the
   * TrialUser lookup and the admin-gated IMS fallback. The id is resolved with
   * {@link resolveCallerImsUserId} — the same helper the server-owned authorship
   * stamp uses to decide what to write — so an id this service stamped is exactly
   * the id it can resolve back here.
   *
   * Without this, a non-admin caller who is not a TrialUser row cannot see their
   * own name — not even against records they authored themselves, whose
   * server-stamped `createdBy`/`updatedBy` is exactly this id. They get the
   * `system` placeholder below, which the UI renders as an unresolved member.
   * Returning the caller's own claims discloses nothing new: it is the identity
   * they authenticated with. Other users' details stay admin-gated.
   *
   * `profile.email` is deliberately NOT a source for the EMAIL field — on both
   * the JWT and the IMS profile that claim carries the IMS user id rather than an
   * RFC-5322 address (same reason llmo-akamai.js `getCallerEmail` prefers
   * `trial_email` / `preferred_username`), and an id in an email column is worse
   * than an empty one. It IS a source for the id itself, inside
   * {@link resolveCallerImsUserId} — the two uses pull opposite ways on the same
   * claim, which is exactly why the id resolution lives in one shared place.
   *
   * @param {string} externalUserId - The requested external user ID.
   * @param {string} organizationId - The organization ID the request addresses.
   * @returns {Object|null} the caller's own details, or null when the requested
   *   id is not the caller's own.
   */
  const resolveCallerOwnDetails = (externalUserId, organizationId) => {
    const callerUserId = resolveCallerImsUserId(ctx);
    if (callerUserId === null || callerUserId !== externalUserId) {
      return null;
    }

    // Invariant: a non-null id means the profile chain resolved, so this second
    // traversal cannot throw — no optional chaining needed (unlike the defensive
    // shared helper above, which is reached with an arbitrary context).
    const profile = ctx.attributes.authInfo.getProfile();
    const email = [profile.trial_email, profile.preferred_username].find((v) => hasText(v));
    return {
      firstName: profile.first_name || profile.given_name || '-',
      lastName: profile.last_name || profile.family_name || '-',
      email: email ?? '',
      organizationId,
    };
  };

  /**
   * Resolves the details of a user who has no TrialUser row: the caller's own
   * identity comes from their auth profile, anyone else's from IMS and only for
   * an admin requestor.
   *
   * Reports which of the three paths answered alongside the details, so the bulk
   * caller can count IMS calls it actually made. `source: 'ims'` means the
   * upstream call was issued — including when it threw, since a failed call still
   * consumed IMS capacity; the self and placeholder paths issue none. That count
   * is the operational signal for IMS volume, so it must not absorb the two paths
   * that never leave the process.
   *
   * @param {string} externalUserId - The external user ID to resolve.
   * @param {string} organizationId - The organization ID for fallback.
   * @returns {Promise<{details: Object, source: 'self'|'placeholder'|'ims'}>}
   *   The user details and which path produced them.
   */
  const fetchNonTrialUserDetails = async (externalUserId, organizationId) => {
    const own = resolveCallerOwnDetails(externalUserId, organizationId);
    if (own) {
      log.debug(`Resolved the caller's own details from the auth profile for ${externalUserId}`);
      return { details: own, source: 'self' };
    }

    // Check if requestor has admin access
    if (!accessControlUtil.hasAdminReadAccess()) {
      log.debug(`User is not admin, returning system defaults for ${externalUserId}`);
      return {
        details: {
          firstName: 'system',
          lastName: '-',
          email: '',
          organizationId,
        },
        source: 'placeholder',
      };
    }

    // Try to fetch from IMS for admin users
    try {
      log.debug(`Admin user requesting details for ${externalUserId}, attempting IMS fallback`);
      const imsProfile = await imsClient.getImsAdminProfile(externalUserId);
      return {
        details: {
          ...toProfileShape(imsProfile),
          organizationId,
        },
        source: 'ims',
      };
    } catch (error) {
      log.warn(`Failed to fetch user details from IMS for ${externalUserId}: ${error.message}`);
      return {
        details: {
          firstName: '-',
          lastName: '-',
          email: '',
          organizationId,
        },
        source: 'ims',
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
        // User not found in trial users - own profile, else IMS if admin
        ({ details: userDetails } = await fetchNonTrialUserDetails(
          externalUserId,
          organizationId,
        ));
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
          // User not found in trial users - own profile, else IMS if admin
          // eslint-disable-next-line no-await-in-loop
          const { details, source } = await fetchNonTrialUserDetails(
            externalUserId,
            organizationId,
          );
          if (source === 'ims') {
            imsCallCount += 1;
          }
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

  /**
   * Resolves a user's profile by IMS user ID (admin-only).
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Resolved user profile.
   */
  const resolveUser = async (context) => {
    if (!accessControlUtil.isAccessTypeJWT() || !accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can resolve user profiles');
    }

    const { userId } = context.params;

    if (!hasText(userId)) {
      return badRequest('userId path parameter is required');
    }

    if (!IMS_USER_ID_RE.test(userId)) {
      return badRequest('userId must be a valid IMS GUID (e.g. ABCDEF@AdobeOrg)');
    }

    try {
      const imsProfile = await imsClient.getImsAdminProfile(userId);
      log.info(`Admin resolved IMS profile for userId: ${userId}`);
      return ok(toProfileShape(imsProfile));
    } catch (e) {
      log.error(`Failed to resolve user profile for ${userId}: ${e.message}`);
      const statusMatch = e.message?.match(/status: (\d{3})/);
      const upstreamStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;
      if (upstreamStatus === 404) {
        return notFound(`User not found: ${userId}`);
      }
      if (upstreamStatus >= 400 && upstreamStatus < 500) {
        return badRequest(`Invalid userId: ${userId}`);
      }
      return internalServerError('Failed to resolve user profile');
    }
  };

  return {
    getUserDetailsByExternalUserId,
    getUserDetailsInBulk,
    resolveUser,
  };
}

export default UserDetailsController;
