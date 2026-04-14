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
import { fetchEmailTrafficData } from './email-traffic-data.js';
import {
  OPPORTUNITY_TYPE_CONFIGS,
  categorizeOpportunities,
  processOpportunityMatching,
  combineAndSortOpportunities,
} from './opportunity-matcher.js';
import { loadSuggestionsByOpportunityIds } from '../paid/opportunity-suggestions.js';

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
 * Top Email Opportunities controller.
 * @param {object} ctx - Context of the request.
 * @param {object} env - Environment variables.
 * @returns {object} Controller with getTopEmailOpportunities function.
 * @constructor
 */
function TopEmailOpportunitiesController(ctx, env = {}) {
  const { dataAccess, log } = ctx;
  const { Opportunity, Suggestion, Site } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  const getTopEmailOpportunities = async (context) => {
    const siteId = context.params?.siteId;

    const validation = await validateSiteAndPermissions(siteId, Site, accessControlUtil);
    if (!validation.ok) {
      return validation.response;
    }
    const { site } = validation;

    const PAGE_VIEW_THRESHOLD = env.EMAIL_DATA_THRESHOLD ?? 500;
    const TOP_URLS_LIMIT = 20;

    // Fetch all opportunities with NEW or IN_PROGRESS status first
    const [newOpportunities, inProgressOpportunities] = await Promise.all([
      Opportunity.allBySiteIdAndStatus(siteId, 'NEW'),
      Opportunity.allBySiteIdAndStatus(siteId, 'IN_PROGRESS'),
    ]);

    const allOpportunitiesUnfiltered = [...newOpportunities, ...inProgressOpportunities];
    const categorizedOpportunitiesUnfiltered = categorizeOpportunities(allOpportunitiesUnfiltered);
    const supportedOpportunities = Array.from(categorizedOpportunitiesUnfiltered.values()).flat();
    const opportunityIds = supportedOpportunities.map((opportunity) => opportunity.id);
    const {
      suggestionsByOpportunityId,
      failedOpportunityIds,
    } = await loadSuggestionsByOpportunityIds(
      Suggestion,
      opportunityIds,
      log,
    );

    // Filter out opportunities where suggestion fetch failed or have pending validation
    const categorizedOpportunities = new Map();
    categorizedOpportunitiesUnfiltered.forEach((opportunities, category) => {
      categorizedOpportunities.set(
        category,
        opportunities.filter((opportunity) => {
          if (failedOpportunityIds.has(opportunity.id)) {
            return false;
          }
          const cached = suggestionsByOpportunityId.get(opportunity.id);
          return cached && !cached.hasPendingValidation;
        }),
      );
    });

    // Check if any opportunity types require Athena query
    const configsRequiringAthena = OPPORTUNITY_TYPE_CONFIGS.filter(
      (config) => config.requiresUrlMatching
        && categorizedOpportunities.get(config.category).length > 0,
    );

    let allEmailTrafficData = [];

    if (configsRequiringAthena.length > 0) {
      log.info(`Fetching email traffic data for site ${siteId}...`);
      const startTime = Date.now();
      const fetchContext = {
        ...ctx,
        env,
        data: context.data,
      };
      allEmailTrafficData = await fetchEmailTrafficData(fetchContext, site, log);
      const duration = Date.now() - startTime;
      log.info(`Email traffic data fetch completed in ${duration}ms - Retrieved ${allEmailTrafficData.length} URLs`);
    } else {
      const categoryNames = OPPORTUNITY_TYPE_CONFIGS
        .filter((config) => config.requiresUrlMatching)
        .map((config) => config.displayName)
        .join(', ');
      log.info(`No ${categoryNames} opportunities found for site ${siteId}, skipping Athena query`);
    }

    const { matchResults, emailUrlsMap } = await processOpportunityMatching(
      categorizedOpportunities,
      allEmailTrafficData,
      PAGE_VIEW_THRESHOLD,
      suggestionsByOpportunityId,
      log,
    );

    const filteredOpportunities = combineAndSortOpportunities(
      categorizedOpportunities,
      matchResults,
    );

    const topOpportunities = filteredOpportunities.slice(0, 8);

    const opportunitySummaries = topOpportunities.map((opportunity) => {
      const opportunityId = opportunity.getId();
      const emailUrlsData = emailUrlsMap.get(opportunityId);
      const cached = suggestionsByOpportunityId.get(opportunityId);
      const suggestions = emailUrlsData ? [] : cached.newSuggestions;
      return OpportunitySummaryDto.toJSON(opportunity, suggestions, emailUrlsData, TOP_URLS_LIMIT);
    });

    return ok(opportunitySummaries);
  };

  return {
    getTopEmailOpportunities,
  };
}

export default TopEmailOpportunitiesController;
