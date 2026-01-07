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
import { getWeekInfo } from '@adobe/spacecat-shared-utils';
import {
  AWSAthenaClient,
  TrafficDataWithCWVDto,
  getTrafficAnalysisQuery,
  getTrafficAnalysisQueryPlaceholdersFilled,
} from '@adobe/spacecat-shared-athena-client';
import { OpportunitySummaryDto } from '../../dto/opportunity-summary.js';
import AccessControlUtil from '../../support/access-control-util.js';

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

function getCwvThresholds(cwvThresholds, log) {
  if (!cwvThresholds) {
    return {};
  }

  try {
    return typeof cwvThresholds === 'string'
      ? JSON.parse(cwvThresholds)
      : cwvThresholds;
  } catch (e) {
    log.warn(`Failed to parse CWV_THRESHOLDS: ${e.message}`);
    return {};
  }
}

async function fetchPaidTrafficData(athenaClient, siteId, baseURL, temporal, config, log) {
  const {
    rumMetricsDatabase,
    rumMetricsCompactTable,
    pageViewThreshold,
    thresholdConfig,
  } = config;
  const { yearInt, weekInt, monthInt } = temporal;

  const tableName = `${rumMetricsDatabase}.${rumMetricsCompactTable}`;
  const description = `Top Paid Opportunities - Site: ${siteId}, Year: ${yearInt}, Week: ${weekInt}, Month: ${monthInt}`;

  const queryParams = getTrafficAnalysisQueryPlaceholdersFilled({
    week: weekInt,
    month: monthInt,
    year: yearInt,
    siteId,
    dimensions: ['path'],
    tableName,
    pageTypes: null,
    pageTypeMatchColumn: 'path',
    trfTypes: ['paid'],
    pageViewThreshold,
    numTemporalSeries: 1,
  });

  const query = getTrafficAnalysisQuery(queryParams);

  log.debug(`Executing Athena query for site ${siteId}: database=${rumMetricsDatabase}, query=${query}`);

  const results = await athenaClient.query(query, rumMetricsDatabase, description);

  log.info(`Athena query returned ${results.length} rows`);

  return results.map((row) => TrafficDataWithCWVDto.toJSON(row, thresholdConfig, baseURL));
}

function filterHighTrafficPoorCwv(trafficData, pageViewThreshold, log) {
  const filtered = trafficData.filter((item) => {
    const pageViews = item.pageviews;
    const cwvScore = item.overall_cwv_score;
    return pageViews >= pageViewThreshold && (cwvScore === 'poor' || cwvScore === 'needs improvement');
  });

  if (filtered.length === 0) {
    log.info(`No high-traffic paid URLs with poor or needs-improvement CWV (pageviews >= ${pageViewThreshold})`);
    return [];
  }

  const sorted = filtered
    .sort((a, b) => (b.pageviews) - (a.pageviews));

  log.info(`Found ${sorted.length} high-traffic paid URLs with poor or needs-improvement CWV (pageviews >= ${pageViewThreshold})`);

  return sorted;
}

function shouldIncludeOpportunity(opportunity) {
  const title = opportunity.getTitle();
  const description = opportunity.getDescription();
  const data = opportunity.getData() || {};
  const projectedTrafficValue = data.projectedTrafficValue || 0;

  if (!description || title.toLowerCase().includes('report')) {
    return false;
  }

  if (projectedTrafficValue <= 0) {
    return false;
  }

  return true;
}

function normalizeUrl(url) {
  return url
    .replace(/^https?:\/\/www\./, 'https://')
    .replace(/\/$/, '');
}

async function matchOpportunitiesWithPaidUrls(
  opportunities,
  paidTrafficData,
  Suggestion,
  log,
  opportunityTypeName = 'opportunities',
) {
  if (opportunities.length === 0 || paidTrafficData.length === 0) {
    log.info(`No matching needed: ${opportunityTypeName}=${opportunities.length}, paidTrafficData=${paidTrafficData.length}`);
    return { matched: [], paidUrlsMap: new Map() };
  }

  const paidUrls = paidTrafficData.map((item) => item.url);
  log.info(`Matching ${opportunities.length} ${opportunityTypeName} against ${paidUrls.length} URLs from paid traffic`);

  // Create a map of normalized URL -> { url, pageviews } for fast lookup
  const normalizedUrlToDataMap = new Map();
  paidTrafficData.forEach((item) => {
    const normalized = normalizeUrl(item.url);
    const pageviews = parseInt(item.pageviews, 10);
    normalizedUrlToDataMap.set(normalized, { url: item.url, pageviews });
  });

  const suggestionsPromises = opportunities.map(
    (opportunity) => Suggestion.allByOpportunityIdAndStatus(opportunity.getId(), 'NEW'),
  );
  const allSuggestions = await Promise.all(suggestionsPromises);

  const matched = [];
  const paidUrlsMap = new Map();

  opportunities.forEach((opportunity, index) => {
    const suggestions = allSuggestions[index];
    const opportunityId = opportunity.getId();

    // Collect all URLs from paid traffic that match NEW suggestions only
    const matchedPaidUrlsMap = new Map();
    const urlFields = ['url', 'url_from', 'urlFrom', 'url_to', 'urlTo'];

    suggestions.forEach((suggestion) => {
      const suggestionData = suggestion.getData();
      urlFields.forEach((field) => {
        if (suggestionData[field]) {
          const suggestionUrl = suggestionData[field];
          const normalized = normalizeUrl(suggestionUrl);
          if (normalizedUrlToDataMap.has(normalized)) {
            const paidUrlData = normalizedUrlToDataMap.get(normalized);
            // Store suggestion URL with pageviews from paid traffic
            matchedPaidUrlsMap.set(suggestionUrl, paidUrlData.pageviews);
          }
        }
      });
    });

    if (matchedPaidUrlsMap.size > 0) {
      // Sort by pageviews descending
      const urlsWithPageviews = Array.from(matchedPaidUrlsMap.entries())
        .map(([url, pageviews]) => ({ url, pageviews }))
        .sort((a, b) => b.pageviews - a.pageviews);

      const sortedUrls = urlsWithPageviews.map((item) => item.url);
      const totalPageViews = urlsWithPageviews.reduce((sum, item) => sum + item.pageviews, 0);

      paidUrlsMap.set(opportunityId, { urls: sortedUrls, pageViews: totalPageViews });
      matched.push(opportunity);
    }
  });

  log.info(`Matched ${matched.length} ${opportunityTypeName} with URLs from paid traffic`);
  return { matched, paidUrlsMap };
}

/**
 * Configuration for opportunity type handlers.
 * Each handler defines how to categorize opportunities and what data filtering they need.
 */
const OPPORTUNITY_TYPE_CONFIGS = [
  {
    // Paid media opportunities - included directly without URL matching
    category: 'paidMedia',
    displayName: 'paid media',
    requiresUrlMatching: false,
    requiresAthenaQuery: false,
    matcher: (opportunity) => {
      const tags = opportunity.getTags() || [];
      const type = opportunity.getType();
      const opportunityData = opportunity.getData();

      // Has 'paid media' tag (case-insensitive)
      const hasPaidMediaTag = tags.some((tag) => tag.toLowerCase() === 'paid media');

      // Or is a specific type that should be treated as paid media
      const isPaidMediaType = type === 'consent-banner'
        || opportunityData.opportunityType === 'no-cta-above-the-fold';

      return hasPaidMediaTag || isPaidMediaType;
    },
  },
  {
    // CWV opportunities - require URL matching with poor CWV from paid traffic
    category: 'cwv',
    displayName: 'CWV',
    requiresUrlMatching: true,
    requiresAthenaQuery: true,
    matcher: (opportunity) => opportunity.getType() === 'cwv',
    // Custom data filter - only match URLs with poor CWV scores
    dataFilter: (trafficData, pageViewThreshold, log) => filterHighTrafficPoorCwv(
      trafficData,
      pageViewThreshold,
      log,
    ),
  },
  {
    // Forms opportunities - require URL matching with any paid traffic
    category: 'forms',
    displayName: 'forms',
    requiresUrlMatching: true,
    requiresAthenaQuery: true,
    matcher: (opportunity) => {
      const formTypes = [
        'high-form-views-low-conversions',
        'high-page-views-low-form-nav',
        'high-page-views-low-form-views',
        'form-accessibility',
      ];
      return formTypes.includes(opportunity.getType());
    },
    // No custom filter - use all paid traffic data
    dataFilter: null,
  },
];

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
    const categorizedOpportunities = new Map();
    OPPORTUNITY_TYPE_CONFIGS.forEach((config) => {
      categorizedOpportunities.set(config.category, []);
    });

    for (const opportunity of allOpportunities) {
      if (!shouldIncludeOpportunity(opportunity)) {
        // eslint-disable-next-line no-continue
        continue;
      }

      // Find the first matching category for this opportunity
      const matchingConfig = OPPORTUNITY_TYPE_CONFIGS.find(
        (config) => config.matcher(opportunity),
      );

      if (matchingConfig) {
        categorizedOpportunities.get(matchingConfig.category).push(opportunity);
      }
    }

    // Check if any opportunity types require Athena query
    const configsRequiringAthena = OPPORTUNITY_TYPE_CONFIGS.filter(
      (config) => config.requiresAthenaQuery
        && categorizedOpportunities.get(config.category).length > 0,
    );

    let allPaidTrafficData = [];

    // Query Athena if any opportunity types need it
    if (configsRequiringAthena.length > 0) {
      try {
        // Get temporal parameters with defaults
        const { month } = context.data || {};
        let { year, week } = context.data || {};

        if (!year || (!week && !month)) {
          const lastFullWeek = getWeekInfo();
          if (!year) {
            year = lastFullWeek.year;
            log.warn(`No year provided, using default: ${year}`);
          }
          if (!week && !month) {
            week = lastFullWeek.week;
            log.warn(`No week or month provided, using default week: ${week}`);
          }
        }

        const yearInt = year;
        const weekInt = week || 0;
        const monthInt = month || 0;
        const baseURL = await site.getBaseURL();
        const resultLocation = `s3://${env.S3_BUCKET_NAME}/athena-results/`;
        const thresholdConfig = getCwvThresholds(env.CWV_THRESHOLDS, log);

        const athenaClient = AWSAthenaClient.fromContext(context, resultLocation);

        const trafficData = await fetchPaidTrafficData(
          athenaClient,
          siteId,
          baseURL,
          { yearInt, weekInt, monthInt },
          {
            rumMetricsDatabase: env.RUM_METRICS_DATABASE,
            rumMetricsCompactTable: env.RUM_METRICS_COMPACT_TABLE,
            pageViewThreshold: PAGE_VIEW_THRESHOLD,
            thresholdConfig,
          },
          log,
        );

        allPaidTrafficData = trafficData;
      } catch (error) {
        log.error(`Failed to query Athena for paid traffic data: ${error.message}`);
        // Continue without filtering - will only return 'paid media' tagged opportunities
      }
    } else {
      const categoryNames = OPPORTUNITY_TYPE_CONFIGS
        .filter((config) => config.requiresAthenaQuery)
        .map((config) => config.displayName)
        .join(', ');
      log.info(`No ${categoryNames} opportunities found for site ${siteId}, skipping Athena query`);
    }

    // Process each opportunity type that requires URL matching
    const configsRequiringMatching = OPPORTUNITY_TYPE_CONFIGS.filter(
      (config) => config.requiresUrlMatching
        && categorizedOpportunities.get(config.category).length > 0,
    );

    const matchingPromises = configsRequiringMatching.map((config) => {
      const opportunities = categorizedOpportunities.get(config.category);

      // Apply custom data filter if defined, otherwise use all traffic data
      const filteredData = config.dataFilter
        ? config.dataFilter(allPaidTrafficData, PAGE_VIEW_THRESHOLD, log)
        : allPaidTrafficData;

      return matchOpportunitiesWithPaidUrls(
        opportunities,
        filteredData,
        Suggestion,
        log,
        `${config.displayName} opportunities`,
      ).then((result) => ({ config, result }));
    });

    const matchingResults = await Promise.all(matchingPromises);

    const matchResults = new Map();
    const paidUrlsMaps = [];

    matchingResults.forEach(({ config, result }) => {
      matchResults.set(config.category, result.matched);
      paidUrlsMaps.push(result.paidUrlsMap);
    });

    // Combine all paid URLs maps
    const paidUrlsMap = new Map(
      paidUrlsMaps.flatMap((map) => Array.from(map.entries())),
    );

    // Combine all opportunities: direct inclusion + matched from URL filtering
    const filteredOpportunities = [];

    for (const config of OPPORTUNITY_TYPE_CONFIGS) {
      if (config.requiresUrlMatching) {
        // Add matched opportunities from URL filtering
        const matched = matchResults.get(config.category) || [];
        filteredOpportunities.push(...matched);
      } else {
        // Add opportunities that don't require URL matching (e.g., paid media tag)
        filteredOpportunities.push(...categorizedOpportunities.get(config.category));
      }
    }

    // Sort by projectedTrafficValue descending
    filteredOpportunities.sort((a, b) => {
      const aValue = a.getData().projectedTrafficValue;
      const bValue = b.getData().projectedTrafficValue;
      return bValue - aValue;
    });

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
