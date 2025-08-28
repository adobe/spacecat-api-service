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
  forbidden,
  notFound,
  ok,
  created,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { TrialUserActivity as TrialUserActivityModel, Entitlement as EntitlementModel, TrialUser as TrialUserModel } from '@adobe/spacecat-shared-data-access';
import { UserActivityDto } from '../dto/user-activity.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * UserActivities controller. Provides methods to read and create user activities.
 * @param {object} ctx - Context of the request.
 * @returns {object} UserActivities controller.
 * @constructor
 */
function UserActivitiesController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const {
    TrialUserActivity,
    Site,
    TrialUser,
    Entitlement,
  } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Handles user status transition when signing in.
   * @param {object} trialUser - The trial user object.
   * @param {string} activityType - The type of activity being performed.
   * @returns {Promise<void>}
   */
  const handleUserStatusTransition = async (trialUser, activityType) => {
    if (activityType === TrialUserActivityModel.TYPES.SIGN_IN
        && trialUser.getStatus() === TrialUserModel.STATUSES.INVITED) {
      trialUser.setStatus(TrialUserModel.STATUSES.REGISTERED);
      await trialUser.save();
    }
  };

  /**
   * Gets user activities by site ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of user activities response.
   */
  const getBySiteID = async (context) => {
    const { siteId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    try {
      // Check if user has access to the site
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Access denied to this site');
      }

      const userActivities = await TrialUserActivity.allBySiteId(siteId);
      const activities = userActivities.map((activity) => UserActivityDto.toJSON(activity));
      return ok(activities);
    } catch (e) {
      context.log.error(`Error getting user activities for site ${siteId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Creates a trial user activity for a specific site.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} UserActivity response.
   */
  const createTrialUserActivity = async (context) => {
    const { siteId } = context.params;
    const activityData = context.data;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isNonEmptyObject(activityData)) {
      return badRequest('Activity data is required');
    }

    // Prepare activity data - only include fields that are present
    const activityPayload = Object.fromEntries(
      Object.entries({
        type: activityData.type,
        productCode: activityData.productCode,
        details: activityData.details,
      }).filter(([_, value]) => value !== undefined),
    );

    if (!activityPayload.type
        || !Object.values(TrialUserActivityModel.TYPES).includes(activityPayload.type)) {
      const validTypes = Object.values(TrialUserActivityModel.TYPES).join(', ');
      return badRequest(
        `Valid activity type is required (${validTypes})`,
      );
    }

    if (!activityPayload.productCode
        || !Object.values(EntitlementModel.PRODUCT_CODES).includes(activityPayload.productCode)) {
      const validProductCodes = Object.values(EntitlementModel.PRODUCT_CODES).join(', ');
      return badRequest(
        `Valid product code is required (${validProductCodes})`,
      );
    }

    try {
      // Check if user has access to the site
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Access denied to this site');
      }

      // Get trial user ID from the authenticated user's context
      // const { authInfo } = context.attributes;

      // if (!authInfo?.getProfile()?.trial_email) {
      //   return badRequest('User\'s trial email not found');
      // }

      // Find the trial user by email
      const trialUser = await TrialUser.findByEmailId('ppatwal@adobe.com');
      if (!trialUser) {
        return notFound('Trial user not found for the authenticated user');
      }

      const trialUserId = trialUser.getId();

      // Get organization ID from the site
      const organizationId = site.getOrganizationId();

      // Find entitlement using organization ID and product code
      const entitlements = await Entitlement.allByOrganizationIdAndProductCode(
        organizationId,
        activityPayload.productCode,
      );
      if (!entitlements || entitlements.length === 0) {
        return notFound('Entitlement not found for this organization and product code');
      }

      const entitlementId = entitlements[0].getId();

      // Handle user status transition when signing in
      await handleUserStatusTransition(trialUser, activityPayload.type);

      // Create user activity using prepared payload
      const userActivity = await TrialUserActivity.create({
        ...activityPayload,
        siteId,
        trialUserId,
        entitlementId,
      });
      return created(UserActivityDto.toJSON(userActivity));
    } catch (e) {
      context.log.error(`Error creating user activity for site ${siteId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  return {
    getBySiteID,
    createTrialUserActivity,
  };
}

export default UserActivitiesController;
