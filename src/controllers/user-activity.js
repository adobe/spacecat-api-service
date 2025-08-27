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
  createResponse,
  badRequest,
  ok,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import {
  TrialUserActivity as TrialUserActivityModel,
  Entitlement as EntitlementModel,
} from '@adobe/spacecat-shared-data-access';

import { UserActivityDto } from '../dto/user-activity.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * UserActivity controller. Provides methods to read and create user activities.
 * @param {object} ctx - Context of the request.
 * @returns {object} UserActivity controller.
 * @constructor
 */
function UserActivityController(ctx) {
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
        return badRequest('Site not found');
      }

      const accessControlUtil = AccessControlUtil.fromContext(context);
      if (!await accessControlUtil.hasAccess(site)) {
        return badRequest('Access denied to this site');
      }

      const userActivities = await TrialUserActivity.allBySiteId(siteId);
      const activities = userActivities.map((activity) => UserActivityDto.toJSON(activity));
      return ok(activities);
    } catch (e) {
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

    // Validate required fields
    const { type, productCode } = activityData;

    if (!type || !Object.values(TrialUserActivityModel.TYPES).includes(type)) {
      return badRequest(`Valid activity type is required (${Object.values(TrialUserActivityModel.TYPES).join(', ')})`);
    }

    if (!productCode || !Object.values(EntitlementModel.PRODUCT_CODES).includes(productCode)) {
      return badRequest(`Valid product code is required (${Object.values(EntitlementModel.PRODUCT_CODES).join(', ')})`);
    }

    try {
      // Check if user has access to the site
      const site = await Site.findById(siteId);
      if (!site) {
        return badRequest('Site not found');
      }

      const accessControlUtil = AccessControlUtil.fromContext(context);
      if (!await accessControlUtil.hasAccess(site)) {
        return badRequest('Access denied to this site');
      }

      // Get trial user ID from the authenticated user's context
      const { authInfo } = context.attributes;
      const profile = authInfo?.getProfile();
      context.log.info(`Finding trial user by email ${JSON.stringify(profile)}`);

      if (!profile?.email) {
        return badRequest('User\'s trial email not found');
      }

      // Find the trial user by email
      const trialUser = await TrialUser.findByEmailId(authInfo.getProfile().email);
      if (!trialUser) {
        return badRequest('Trial user not found for the authenticated user');
      }

      const trialUserId = trialUser.getId();

      // Get organization ID from the site
      const organizationId = site.getOrganizationId();

      // Find entitlement using organization ID and product code
      const entitlements = await Entitlement.allByOrganizationIdAndProductCode(
        organizationId,
        productCode,
      );
      if (!entitlements || entitlements.length === 0) {
        return badRequest('Entitlement not found for this organization and product code');
      }

      const entitlementId = entitlements[0].getId();

      const userActivity = await TrialUserActivity.create({
        ...activityData,
        siteId,
        trialUserId,
        entitlementId,
      });
      return createResponse(UserActivityDto.toJSON(userActivity), 201);
    } catch (e) {
      return internalServerError(e.message);
    }
  };

  return {
    getBySiteID,
    createTrialUserActivity,
  };
}

export default UserActivityController;
