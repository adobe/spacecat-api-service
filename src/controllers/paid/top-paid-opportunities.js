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

function filterHighTrafficPoorCwv(trafficData, pageViewThreshold, topUrlsLimit, log) {
  const filtered = trafficData.filter((item) => {
    const pageViews = item.pageviews || 0;
    const cwvScore = item.overall_cwv_score;
    return pageViews >= pageViewThreshold && (cwvScore === 'poor' || cwvScore === 'needs improvement');
  });

  if (filtered.length === 0) {
    log.info(`No high-traffic paid URLs with poor or needs-improvement CWV (pageviews >= ${pageViewThreshold})`);
    return [];
  }

  const sorted = filtered
    .sort((a, b) => (b.pageviews || 0) - (a.pageviews || 0))
    .slice(0, topUrlsLimit);

  log.info(`Found ${sorted.length} high-traffic paid URLs with poor or needs-improvement CWV (pageviews >= ${pageViewThreshold})`);

  return sorted;
}

function shouldIncludeOpportunity(opportunity) {
  const title = opportunity.getTitle() || '';
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
  if (!url) return '';
  return url
    .replace(/^https?:\/\/www\./, 'https://')
    .replace(/\/$/, '');
}

async function matchCwvOpportunitiesWithUrls(cwvOpportunities, topPoorCwvData, Suggestion, log) {
  if (cwvOpportunities.length === 0 || topPoorCwvData.length === 0) {
    log.info(`No matching needed: cwvOpportunities=${cwvOpportunities.length}, topPoorCwvData=${topPoorCwvData.length}`);
    return { matched: [], paidUrlsMap: new Map() };
  }

  const topPoorCwvUrls = topPoorCwvData.map((item) => item.url);
  log.info(`Matching ${cwvOpportunities.length} CWV opportunities against ${topPoorCwvUrls.length} poor CWV URLs from paid traffic`);

  // Create a map of normalized URL -> pageviews for fast lookup
  const normalizedUrlToPageViewsMap = new Map();
  topPoorCwvData.forEach((item) => {
    const normalized = normalizeUrl(item.url);
    const pageviews = parseInt(item.pageviews, 10) || 0;
    normalizedUrlToPageViewsMap.set(normalized, pageviews);
  });

  const suggestionsPromises = cwvOpportunities.map(
    (opportunity) => Suggestion.allByOpportunityId(opportunity.getId()),
  );
  const allSuggestions = await Promise.all(suggestionsPromises);

  const matched = [];
  const paidUrlsMap = new Map();

  cwvOpportunities.forEach((opportunity, index) => {
    const suggestions = allSuggestions[index];
    const opportunityId = opportunity.getId();

    // Collect all URLs from suggestions that match poor CWV from paid traffic
    const paidUrls = [];
    let totalPageViews = 0;
    const urlFields = ['url', 'url_from', 'urlFrom', 'url_to', 'urlTo'];

    suggestions.forEach((suggestion) => {
      const suggestionData = suggestion.getData() || {};
      urlFields.forEach((field) => {
        if (suggestionData[field]) {
          const normalized = normalizeUrl(suggestionData[field]);
          if (normalizedUrlToPageViewsMap.has(normalized)) {
            paidUrls.push(suggestionData[field]);
            totalPageViews += normalizedUrlToPageViewsMap.get(normalized);
          }
        }
      });
    });

    if (paidUrls.length > 0) {
      paidUrlsMap.set(opportunityId, { urls: paidUrls, pageViews: totalPageViews });
      matched.push(opportunity);
    }
  });

  log.info(`Matched ${matched.length} CWV opportunities with poor CWV URLs from paid traffic`);
  return { matched, paidUrlsMap };
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
    const TARGET_TAG = 'paid media';
    const CWV_TYPE = 'cwv';

    // Fetch all opportunities with NEW or IN_PROGRESS status first
    const [newOpportunities, inProgressOpportunities] = await Promise.all([
      Opportunity.allBySiteIdAndStatus(siteId, 'NEW'),
      Opportunity.allBySiteIdAndStatus(siteId, 'IN_PROGRESS'),
    ]);

    const allOpportunities = [...newOpportunities, ...inProgressOpportunities];

    const paidMediaOpportunities = [];
    const cwvOpportunities = [];

    for (const opportunity of allOpportunities) {
      if (!shouldIncludeOpportunity(opportunity)) {
        // eslint-disable-next-line no-continue
        continue;
      }

      const tags = opportunity.getTags() || [];
      const type = opportunity.getType();
      const opportunityData = opportunity.getData();

      // Check if has 'paid media' tag (case-insensitive)
      const hasPaidMediaTag = tags.some((tag) => tag.toLowerCase() === TARGET_TAG);

      // Check if type is one that should be treated as paid media
      const isPaidMediaType = type === 'consent-banner'
        || opportunityData.opportunityType === 'no-cta-above-the-fold';

      if (hasPaidMediaTag || isPaidMediaType) {
        paidMediaOpportunities.push(opportunity);
      } else if (type === CWV_TYPE) {
        cwvOpportunities.push(opportunity);
      }
    }

    let topPoorCwvData = [];

    // if there are cwv opportunities, find which of them are from paid traffic by querying Athena
    if (cwvOpportunities.length > 0) {
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
            pageViewThreshold: env.PAID_DATA_THRESHOLD ?? 1000,
            thresholdConfig,
          },
          log,
        );

        topPoorCwvData = filterHighTrafficPoorCwv(
          trafficData,
          PAGE_VIEW_THRESHOLD,
          TOP_URLS_LIMIT,
          log,
        );
      } catch (error) {
        log.error(`Failed to query Athena for paid traffic CWV data: ${error.message}`);
        // Continue without CWV filtering - will only return 'paid media' tagged opportunities
      }
    } else {
      log.info(`No CWV opportunities found for site ${siteId}, skipping Athena query for paid traffic`);
    }

    // Match CWV opportunities with poor CWV URLs from paid traffic
    const matchResult = await matchCwvOpportunitiesWithUrls(
      cwvOpportunities,
      topPoorCwvData,
      Suggestion,
      log,
    );
    const { matched: matchedCwvOpportunities, paidUrlsMap } = matchResult;

    // Combine all filtered opportunities: paid media tag OR matched CWV from paid traffic
    const filteredOpportunities = [...paidMediaOpportunities, ...matchedCwvOpportunities];

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
        // Only fetch suggestions if not a CWV opportunity (no paidUrlsData)
        const suggestions = paidUrlsData ? [] : await Suggestion.allByOpportunityId(opportunityId);
        return OpportunitySummaryDto.toJSON(opportunity, suggestions, paidUrlsData);
      }),
    );

    return ok(opportunitySummaries);
  };

  return {
    getTopPaidOpportunities,
  };
}

export default TopPaidOpportunitiesController;
