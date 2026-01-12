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
  notFound,
  ok,
  forbidden,
} from '@adobe/spacecat-shared-http-utils';
import { OpportunitySummaryDto } from '../../dto/opportunity-summary.js';
import AccessControlUtil from '../../support/access-control-util.js';
import { fetchPaidTrafficData } from './paid-traffic-data.js';
import {
  OPPORTUNITY_TYPE_CONFIGS,
  categorizeOpportunities,
  processOpportunityMatching,
  combineAndSortOpportunities,
} from './opportunity-matcher.js';

async function validateSiteAndPermissions(siteId, Site, accessControlUtil) {
  const site = await Site.findById(siteId);
  if (!site) {
    return { ok: false, response: notFound('Site not found') };
  }

  if (!await accessControlUtil.hasAccess(site)) {
    return {
      ok: false,
      response: forbidden('Only users belonging to the organization of the site can view its opportunities'),
    };
  }

  return { ok: true, site };
}

/**
 * Top Paid Opportunities controller.
 * @param {object} ctx - Context of the request.
 * @param {object} env - Environment variables.
 * @returns {object} Controller with getTopPaidOpportunities function.
 * @constructor
 */
function TopPaidOpportunitiesController(ctx, env = {}) {
  const { dataAccess, log } = ctx;
  const { Opportunity, Suggestion, Site } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  const getTopPaidOpportunities = async (context) => {
    const siteId = context.params?.siteId;

    // Validate site and permissions
    const validation = await validateSiteAndPermissions(siteId, Site, accessControlUtil);
    if (!validation.ok) {
      return validation.response;
    }
    const { site } = validation;

    const PAGE_VIEW_THRESHOLD = env.PAID_DATA_THRESHOLD ?? 1000;
    const TOP_URLS_LIMIT = 20;

    // Fetch all opportunities with NEW or IN_PROGRESS status first
    const [newOpportunities, inProgressOpportunities] = await Promise.all([
      Opportunity.allBySiteIdAndStatus(siteId, 'NEW'),
      Opportunity.allBySiteIdAndStatus(siteId, 'IN_PROGRESS'),
    ]);

    const allOpportunities = [...newOpportunities, ...inProgressOpportunities];

    // Categorize opportunities using configuration
    const categorizedOpportunities = categorizeOpportunities(allOpportunities);

    // Check if any opportunity types require Athena query (i.e., require URL matching)
    const configsRequiringAthena = OPPORTUNITY_TYPE_CONFIGS.filter(
      (config) => config.requiresUrlMatching
        && categorizedOpportunities.get(config.category).length > 0,
    );

    let allPaidTrafficData = [];

    // Query Athena if any opportunity types need it
    if (configsRequiringAthena.length > 0) {
      log.info(`Fetching paid traffic data for site ${siteId}...`);
      const startTime = Date.now();
      // Create a context object with env, s3, and request data
      const fetchContext = {
        ...ctx,
        env,
        data: context.data,
      };
      allPaidTrafficData = await fetchPaidTrafficData(fetchContext, site, log);
      const duration = Date.now() - startTime;
      log.info(`Paid traffic data fetch completed in ${duration}ms - Retrieved ${allPaidTrafficData.length} URLs`);
    } else {
      const categoryNames = OPPORTUNITY_TYPE_CONFIGS
        .filter((config) => config.requiresUrlMatching)
        .map((config) => config.displayName)
        .join(', ');
      log.info(`No ${categoryNames} opportunities found for site ${siteId}, skipping Athena query`);
    }

    // Process opportunity matching
    const { matchResults, paidUrlsMap } = await processOpportunityMatching(
      categorizedOpportunities,
      allPaidTrafficData,
      PAGE_VIEW_THRESHOLD,
      Suggestion,
      log,
    );

    // Combine and sort opportunities
    const filteredOpportunities = combineAndSortOpportunities(
      categorizedOpportunities,
      matchResults,
    );

    // Convert to DTOs
    const opportunitySummaries = await Promise.all(
      filteredOpportunities.map(async (opportunity) => {
        const opportunityId = opportunity.getId();
        const paidUrlsData = paidUrlsMap.get(opportunityId);
        // Only fetch NEW suggestions if not a CWV opportunity (no paidUrlsData)
        const suggestions = paidUrlsData
          ? []
          : await Suggestion.allByOpportunityIdAndStatus(opportunityId, 'NEW');
        return OpportunitySummaryDto.toJSON(opportunity, suggestions, paidUrlsData, TOP_URLS_LIMIT);
      }),
    );

    return ok(opportunitySummaries);
  };

  return {
    getTopPaidOpportunities,
  };
}

export default TopPaidOpportunitiesController;
