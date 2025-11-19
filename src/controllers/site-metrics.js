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
    const accessControlUtil = AccessControlUtil.fromContext(ctx);
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

  /**
   * Get aggregated metrics for all sites
   * @param {object} req - Request object
   * @returns {Promise<Response>} Response with aggregated metrics data
   */
  async function getMetricsForAllSites(req) {
    /* c8 ignore next - req.query is always defined in practice, defensive check */
    const { startDate, endDate } = req.query || {};

    // Validate dates
    const dateValidation = validateAndNormalizeDates(startDate, endDate);
    if (dateValidation.error) {
      return badRequest(dateValidation.error);
    }

    // Get all sites
    const sites = await Site.all();
    if (sites.length === 0) {
      return ok({
        siteCount: 0,
        startDate: dateValidation.startDate,
        endDate: dateValidation.endDate,
        audits: {
          total: 0, successful: 0, failed: 0, successRate: 0, byType: {},
        },
        opportunities: { total: 0, byType: {} },
        suggestions: { total: 0, byStatus: {} },
      });
    }

    // Check access control - user must have access to at least one site
    const accessControlUtil = AccessControlUtil.fromContext(ctx);
    let hasAnyAccess = false;
    const accessibleSites = [];

    // eslint-disable-next-line no-restricted-syntax
    for (const site of sites) {
      // eslint-disable-next-line no-await-in-loop
      if (await accessControlUtil.hasAccess(site)) {
        hasAnyAccess = true;
        accessibleSites.push(site);
      }
    }

    if (!hasAnyAccess) {
      return forbidden('You do not have access to any sites');
    }

    // Aggregate metrics across all accessible sites
    try {
      const aggregatedMetrics = {
        siteCount: accessibleSites.length,
        startDate: dateValidation.startDate,
        endDate: dateValidation.endDate,
        audits: {
          total: 0, successful: 0, failed: 0, successRate: 0, byType: {},
        },
        opportunities: { total: 0, byType: {} },
        suggestions: { total: 0, byStatus: {} },
      };

      // eslint-disable-next-line no-restricted-syntax
      for (const site of accessibleSites) {
        // eslint-disable-next-line no-await-in-loop
        const siteMetrics = await getSiteMetrics(
          ctx,
          site.getId(),
          dateValidation.startDate,
          dateValidation.endDate,
        );

        // Aggregate audits
        aggregatedMetrics.audits.total += siteMetrics.audits.total;
        aggregatedMetrics.audits.successful += siteMetrics.audits.successful;
        aggregatedMetrics.audits.failed += siteMetrics.audits.failed;

        // Aggregate audit types
        Object.entries(siteMetrics.audits.byType).forEach(([type, counts]) => {
          if (!aggregatedMetrics.audits.byType[type]) {
            aggregatedMetrics.audits.byType[type] = { total: 0, successful: 0, failed: 0 };
          }
          aggregatedMetrics.audits.byType[type].total += counts.total;
          aggregatedMetrics.audits.byType[type].successful += counts.successful;
          aggregatedMetrics.audits.byType[type].failed += counts.failed;
        });

        // Aggregate opportunities
        aggregatedMetrics.opportunities.total += siteMetrics.opportunities.total;
        Object.entries(siteMetrics.opportunities.byType).forEach(([type, count]) => {
          const current = aggregatedMetrics.opportunities.byType[type] || 0;
          aggregatedMetrics.opportunities.byType[type] = current + count;
        });

        // Aggregate suggestions
        aggregatedMetrics.suggestions.total += siteMetrics.suggestions.total;
        Object.entries(siteMetrics.suggestions.byStatus).forEach(([status, count]) => {
          const current = aggregatedMetrics.suggestions.byStatus[status] || 0;
          aggregatedMetrics.suggestions.byStatus[status] = current + count;
        });
      }

      // Calculate overall success rate
      const totalAudits = aggregatedMetrics.audits.total;
      const successfulAudits = aggregatedMetrics.audits.successful;
      aggregatedMetrics.audits.successRate = totalAudits > 0
        ? parseFloat(((successfulAudits / totalAudits) * 100).toFixed(1))
        : 0;

      return ok(aggregatedMetrics);
    } catch (error) {
      log.error('Error fetching aggregated metrics for all sites:', error);
      throw error;
    }
  }

  return {
    getMetricsForSite,
    getMetricsForAllSites,
  };
}

export default SiteMetricsController;
