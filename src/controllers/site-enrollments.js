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
  created,
  notFound,
  ok,
  forbidden,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import TierClient from '@adobe/spacecat-shared-tier-client';

import { SiteEnrollmentDto } from '../dto/site-enrollment.js';
import AccessControlUtil from '../support/access-control-util.js';

const ASO_PRODUCT_CODE = EntitlementModel.PRODUCT_CODES.ASO;
const ASO_TIER = EntitlementModel.TIERS.FREE_TRIAL;
const SUMMIT_PLG_HANDLER = 'summit-plg';

/**
 * SiteEnrollments controller. Provides methods to read site enrollments.
 * @param {object} ctx - Context of the request.
 * @returns {object} SiteEnrollments controller.
 * @constructor
 */
function SiteEnrollmentsController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { SiteEnrollment, Site, Configuration } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Gets site enrollments by site ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of site enrollments response.
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

      const siteEnrollments = await SiteEnrollment.allBySiteId(siteId);
      const enrollments = siteEnrollments.map(
        (enrollment) => SiteEnrollmentDto.toJSON(enrollment),
      );
      return ok(enrollments);
    } catch (e) {
      context.log.error(`Error getting site enrollments for site ${siteId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Creates an ASO enrollment for a site if the summit-plg handler is enabled.
   * Admin only.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Created site enrollment response.
   */
  const createEnrollmentForSite = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create site enrollments');
    }

    const { siteId } = context.params;
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      const configuration = await Configuration.findLatest();
      if (!configuration.isHandlerEnabledForSite(SUMMIT_PLG_HANDLER, site)) {
        return badRequest(`PLG handler (${SUMMIT_PLG_HANDLER}) is not enabled for site ${siteId}`);
      }

      const tierClient = await TierClient.createForSite(context, site, ASO_PRODUCT_CODE);
      const { siteEnrollment } = await tierClient.createEntitlement(ASO_TIER);
      return created(SiteEnrollmentDto.toJSON(siteEnrollment));
    } catch (e) {
      if (e.message?.includes('already exists') || e.message?.includes('Already enrolled')) {
        return badRequest('Site is already enrolled in ASO');
      }
      context.log.error(`Error creating enrollment for site ${siteId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  return {
    getBySiteID,
    createEnrollmentForSite,
  };
}

export default SiteEnrollmentsController;
