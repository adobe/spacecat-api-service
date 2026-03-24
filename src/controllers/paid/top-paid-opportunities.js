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

    const allOpportunitiesUnfiltered = [...newOpportunities, ...inProgressOpportunities];

    // Fetch suggestions once per opportunity, then partition by status in memory.
    // This keeps the per-opportunity fail-closed behavior without doubling query count.
    const suggestionsByOpportunityId = new Map();
    const failedOpportunityIds = new Set();

    const results = await Promise.allSettled(
      allOpportunitiesUnfiltered.map(async (oppty) => {
        const allSuggestions = (await Suggestion.allByOpportunityId(oppty.getId())) ?? [];
        const newSuggs = allSuggestions.filter((sugg) => sugg.getStatus() === 'NEW');
        const pendingSuggs = allSuggestions.filter(
          (sugg) => sugg.getStatus() === 'PENDING_VALIDATION',
        );
        return { newSuggs, pendingSuggs };
      }),
    );
    allOpportunitiesUnfiltered.forEach((oppty, index) => {
      const result = results[index];
      if (result.status === 'fulfilled') {
        // Store only NEW suggestions — these are reused for URL matching and DTOs
        suggestionsByOpportunityId.set(oppty.getId(), {
          newSuggestions: result.value.newSuggs,
          hasPendingValidation: result.value.pendingSuggs.length > 0,
        });
      } else {
        log?.warn?.('Failed to fetch suggestions for opportunity, excluding from results', {
          opportunityId: oppty.getId(),
          error: result.reason?.message,
        });
        failedOpportunityIds.add(oppty.getId());
      }
    });

    // Filter out opportunities where suggestion fetch failed (fail-closed per-opportunity)
    // or where any suggestion has PENDING_VALIDATION status
    const allOpportunities = allOpportunitiesUnfiltered.filter((oppty) => {
      if (failedOpportunityIds.has(oppty.getId())) return false;
      const cached = suggestionsByOpportunityId.get(oppty.getId());
      return cached && !cached.hasPendingValidation;
    });

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

    // Process opportunity matching - pass the suggestions map to avoid refetching
    const { matchResults, paidUrlsMap } = await processOpportunityMatching(
      categorizedOpportunities,
      allPaidTrafficData,
      PAGE_VIEW_THRESHOLD,
      suggestionsByOpportunityId,
      log,
    );

    // Combine and sort opportunities
    const filteredOpportunities = combineAndSortOpportunities(
      categorizedOpportunities,
      matchResults,
    );

    // Limit to top 8 opportunities
    const topOpportunities = filteredOpportunities.slice(0, 8);

    // Convert to DTOs
    const opportunitySummaries = topOpportunities.map((opportunity) => {
      const opportunityId = opportunity.getId();
      const paidUrlsData = paidUrlsMap.get(opportunityId);
      const cached = suggestionsByOpportunityId.get(opportunityId);
      // For CWV/forms opportunities with paidUrlsData, URLs come from paid traffic, not suggestions
      const suggestions = paidUrlsData ? [] : cached.newSuggestions;
      return OpportunitySummaryDto.toJSON(opportunity, suggestions, paidUrlsData, TOP_URLS_LIMIT);
    });

    return ok(opportunitySummaries);
  };

  return {
    getTopPaidOpportunities,
  };
}

export default TopPaidOpportunitiesController;
