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

import crypto from 'crypto';
import { getWeekInfo } from '@adobe/spacecat-shared-utils';
import {
  AWSAthenaClient,
  TrafficDataWithCWVDto,
  getTrafficAnalysisQuery,
  getTrafficAnalysisQueryPlaceholdersFilled,
} from '@adobe/spacecat-shared-athena-client';
import {
  fileExists,
  getCachedJsonData,
  addResultJsonToCache,
} from '../paid/caching-helper.js';

const EMAIL_TRF_TYPES = ['owned'];
const EMAIL_UTM_MEDIUM = 'email';
const DEFAULT_EMAIL_PAGEVIEW_THRESHOLD = 500;

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

function getTemporalParameters(contextData, log) {
  const { month } = contextData || {};
  let { year, week } = contextData || {};

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

  return {
    yearInt: year,
    weekInt: week || 0,
    monthInt: month || 0,
  };
}

function getCacheKey(siteId, query, cacheLocation, pageViewThreshold) {
  const outPrefix = crypto.createHash('md5').update(`${query}_${pageViewThreshold}_email`).digest('hex');
  const cacheKey = `${cacheLocation}/${siteId}/${outPrefix}.json`;
  return { cacheKey, outPrefix };
}

/**
 * Fetch email traffic data from Athena with caching support.
 * Filters for trfTypes=['owned'] and utm_medium='email'.
 * @param {Object} context - Request context containing s3, env, data
 * @param {Object} site - Site object
 * @param {Object} log - Logger instance
 * @returns {Promise<Array>} Array of traffic data with CWV metrics
 */
async function fetchEmailTrafficData(context, site, log) {
  const { env, s3, data: contextData } = context;
  const siteId = site.getId();
  const baseURL = await site.getBaseURL();

  const temporal = getTemporalParameters(contextData, log);
  const { yearInt, weekInt, monthInt } = temporal;

  const rumMetricsDatabase = env.RUM_METRICS_DATABASE;
  const rumMetricsCompactTable = env.RUM_METRICS_COMPACT_TABLE;
  const pageViewThreshold = env.EMAIL_DATA_THRESHOLD ?? DEFAULT_EMAIL_PAGEVIEW_THRESHOLD;
  const thresholdConfig = getCwvThresholds(env.CWV_THRESHOLDS, log);

  const resultLocation = `s3://${env.S3_BUCKET_NAME}/athena-results/`;
  const cacheLocation = s3 ? `s3://${env.S3_BUCKET_NAME}/rum-metrics-compact/cache` : null;
  const athenaClient = AWSAthenaClient.fromContext(context, resultLocation);

  const tableName = `${rumMetricsDatabase}.${rumMetricsCompactTable}`;
  const description = `Top Email Opportunities - Site: ${siteId}, Year: ${yearInt}, Week: ${weekInt}, Month: ${monthInt}`;

  const queryParams = getTrafficAnalysisQueryPlaceholdersFilled({
    week: weekInt,
    month: monthInt,
    year: yearInt,
    siteId,
    dimensions: ['path'],
    tableName,
    pageTypes: null,
    pageTypeMatchColumn: 'path',
    trfTypes: EMAIL_TRF_TYPES,
    pageViewThreshold,
    numTemporalSeries: 1,
  });

  const query = getTrafficAnalysisQuery(queryParams);

  // Try to get from cache first if S3 is available
  if (s3 && cacheLocation) {
    const { cacheKey } = getCacheKey(siteId, query, cacheLocation, pageViewThreshold);

    if (await fileExists(s3, cacheKey, log, 1)) {
      log.debug(`CACHE HIT - Email traffic data found in cache: ${cacheKey}`);
      const cachedData = await getCachedJsonData(s3, cacheKey, log);
      return cachedData;
    } else {
      log.debug(`CACHE MISS - No cached data found: ${cacheKey}. Will query Athena and cache result.`);
    }
  }

  log.debug(`ATHENA QUERY - Executing query for site ${siteId} (database: ${rumMetricsDatabase})`);

  const results = await athenaClient.query(query, rumMetricsDatabase, description);

  // Filter results to only email traffic (utm_medium='email')
  const emailResults = results.filter((row) => row.utm_medium === EMAIL_UTM_MEDIUM);

  log.debug(`ATHENA QUERY - Returned ${results.length} rows, ${emailResults.length} email rows`);

  const response = emailResults.map(
    (row) => TrafficDataWithCWVDto.toJSON(row, thresholdConfig, baseURL),
  );

  // Add to cache if S3 is available and we have results
  if (s3 && cacheLocation && response.length > 0) {
    const { cacheKey } = getCacheKey(siteId, query, cacheLocation, pageViewThreshold);
    await addResultJsonToCache(s3, cacheKey, response, log);
  }

  return response;
}

function filterHighTrafficPoorCwv(trafficData, pageViewThreshold, log) {
  const threshold = Number(pageViewThreshold);
  const filtered = trafficData.filter((item) => {
    const pageViews = Number(item.pageviews);
    const cwvScore = item.overall_cwv_score;
    return pageViews >= threshold && (cwvScore === 'poor' || cwvScore === 'needs improvement');
  });

  if (filtered.length === 0) {
    log.debug(`No high-traffic email URLs with poor or needs-improvement CWV (pageviews >= ${threshold})`);
    return [];
  }

  const sorted = filtered
    .sort((a, b) => Number(b.pageviews) - Number(a.pageviews));

  log.info(`Found ${sorted.length} high-traffic email URLs with poor or needs-improvement CWV (pageviews >= ${threshold})`);

  return sorted;
}

export {
  fetchEmailTrafficData,
  filterHighTrafficPoorCwv,
  getCacheKey,
  getCwvThresholds,
  getTemporalParameters,
};
