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
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { SiteEnrollmentDto } from '../dto/site-enrollment.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * SiteEnrollment controller. Provides methods to read site enrollments.
 * @param {object} ctx - Context of the request.
 * @returns {object} SiteEnrollment controller.
 * @constructor
 */
function SiteEnrollmentController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { SiteEnrollment, Site } = dataAccess;

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

      const accessControlUtil = AccessControlUtil.fromContext(context);
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Access denied to this site');
      }

      const siteEnrollments = await SiteEnrollment.allBySiteId(siteId);
      const enrollments = siteEnrollments.map(
        (enrollment) => SiteEnrollmentDto.toJSON(enrollment),
      );
      return ok(enrollments);
    } catch (e) {
      return internalServerError(e.message);
    }
  };

  return {
    getBySiteID,
  };
}

export default SiteEnrollmentController;
