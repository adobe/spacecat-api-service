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
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { getSiteMetrics, validateAndNormalizeDates } from '../support/site-metrics-service.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * Site Metrics controller.
 * @param {object} ctx - Context object.
 * @returns {object} Site Metrics controller.
 * @constructor
 */
function SiteMetricsController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess, log } = ctx;

  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Site } = dataAccess;

  /**
   * Get metrics for a site
   * @param {object} req - Request object
   * @returns {Promise<Response>} Response with metrics data
   */
  async function getMetricsForSite(req) {
    const { siteId } = req.params;
    /* c8 ignore next - req.query is always defined in practice, defensive check */
    const { startDate, endDate } = req.query || {};

    // Validate site ID
    if (!isValidUUID(siteId)) {
      return badRequest('Invalid site ID format');
    }

    // Validate dates
    const dateValidation = validateAndNormalizeDates(startDate, endDate);
    if (dateValidation.error) {
      return badRequest(dateValidation.error);
    }

    // Find site
    const site = await Site.findById(siteId);
    if (!site) {
      return notFound(`Site not found: ${siteId}`);
    }

    // Check access control
    const accessControlUtil = AccessControlUtil(ctx);
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its metrics');
    }

    // Fetch metrics
    try {
      const metrics = await getSiteMetrics(
        ctx,
        siteId,
        dateValidation.startDate,
        dateValidation.endDate,
      );

      return ok({
        ...metrics,
        baseURL: site.getBaseURL(),
      });
    } catch (error) {
      log.error(`Error fetching metrics for site ${siteId}:`, error);
      throw error;
    }
  }

  return {
    getMetricsForSite,
  };
}

export default SiteMetricsController;
