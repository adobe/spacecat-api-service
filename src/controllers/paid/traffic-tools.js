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
  ok,
  notFound,
  forbidden,
  badRequest,
} from '@adobe/spacecat-shared-http-utils';
import {
  AWSAthenaClient,
  getTrafficTypeAnalysisTemplate,
} from '@adobe/spacecat-shared-athena-client';
import {
  startOfWeek, subWeeks, getYear, getISOWeek,
} from 'date-fns';
import crypto from 'crypto';
import AccessControlUtil from '../../support/access-control-util.js';

/**
 * Generates an output prefix for the Athena result location
 * @param {string} query - The SQL query
 * @returns {string} MD5 hash of the query
 */
function getOutPrefix(query) {
  return crypto.createHash('md5').update(query).digest('hex');
}

/**
 * Validates the request data for predominant traffic endpoint
 * @param {object} data - Request body data
 * @returns {object} Validation result with ok flag and optional error message
 */
function validateRequestData(data) {
  // Check if data exists
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Request body is required' };
  }

  // Validate urls array
  if (!Array.isArray(data.urls)) {
    return { ok: false, error: 'urls must be an array' };
  }

  if (data.urls.length === 0) {
    return { ok: false, error: 'urls array cannot be empty' };
  }

  // Validate each URL is a string
  for (let i = 0; i < data.urls.length; i += 1) {
    if (typeof data.urls[i] !== 'string' || data.urls[i].trim() === '') {
      return { ok: false, error: `Invalid URL at index ${i}` };
    }
  }

  // Validate predominantTrafficPct if provided
  if (data.predominantTrafficPct !== undefined) {
    const pct = Number(data.predominantTrafficPct);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      return { ok: false, error: 'predominantTrafficPct must be a number between 0 and 100' };
    }
  }

  return { ok: true };
}

/**
 * Generates temporal condition for the last 4 weeks (current week and previous 3)
 * @returns {string} SQL temporal condition string
 */
function generateTemporalCondition() {
  const today = new Date();
  const conditions = [];

  // Get current week and previous 3 weeks (total 4 weeks)
  for (let weekOffset = 0; weekOffset < 4; weekOffset += 1) {
    const weekStart = subWeeks(startOfWeek(today, { weekStartsOn: 1 }), weekOffset);
    const week = getISOWeek(weekStart);
    const year = getYear(weekStart);
    conditions.push(`(week=${week} AND year=${year})`);
  }

  return conditions.join(' OR ');
}

/**
 * Calculates predominant traffic type based on percentage threshold
 * @param {object} trafficDetails - Traffic percentages by type
 * @param {number} trafficDetails.paid - Paid traffic percentage
 * @param {number} trafficDetails.earned - Earned traffic percentage
 * @param {number} trafficDetails.owned - Owned traffic percentage
 * @param {number} predominantTrafficPct - Minimum percentage for predominance
 * @returns {string} Predominant traffic type: 'paid', 'earned', 'owned', or 'mixed'
 */
function calculatePredominantTraffic(trafficDetails, predominantTrafficPct) {
  const { paid = 0, earned = 0, owned = 0 } = trafficDetails;

  // Check if any single traffic type meets or exceeds the threshold
  if (paid >= predominantTrafficPct) return 'paid';
  if (earned >= predominantTrafficPct) return 'earned';
  if (owned >= predominantTrafficPct) return 'owned';

  return 'mixed';
}

/**
 * Extracts path from URL
 * @param {string} url - URL string
 * @returns {string} Path portion of URL
 */
function extractPathFromUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.pathname;
  } catch {
    // If URL is malformed, treat it as a path
    return url.startsWith('/') ? url : `/${url}`;
  }
}

function TrafficToolsController(context, log, env) {
  const { dataAccess } = context;
  const { Site } = dataAccess;

  const {
    RUM_METRICS_DATABASE: rumMetricsDatabase,
    RUM_METRICS_COMPACT_TABLE: rumMetricsCompactTable,
    S3_BUCKET_NAME: bucketName,
  } = env;

  // constants
  const ATHENA_TEMP_FOLDER = `s3://${bucketName}/rum-metrics-compact/temp/out`;

  async function getPredominantTraffic() {
    /* c8 ignore next 1 */
    const siteId = context.params?.siteId;
    const { data } = context;

    // Validate request data
    const validation = validateRequestData(data);
    if (!validation.ok) {
      return badRequest(validation.error);
    }

    const { urls, predominantTrafficPct = 80 } = data;

    // Validate site exists
    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    // Check access control
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view paid traffic metrics');
    }

    try {
      // Generate temporal condition for last 4 weeks
      const temporalCondition = generateTemporalCondition();

      log.info(`Determining predominant traffic for ${urls.length} URLs with threshold ${predominantTrafficPct}%`);
      log.debug(`Temporal condition: ${temporalCondition}`);

      // Build Athena query
      const tableName = `${rumMetricsDatabase}.${rumMetricsCompactTable}`;
      const dimensions = ['trf_type', 'path'];
      const dimensionColumns = dimensions.join(', ');
      const dimensionColumnsPrefixed = dimensions.map((col) => `a.${col}`).join(', ');

      const query = getTrafficTypeAnalysisTemplate({
        siteId,
        tableName,
        temporalCondition,
        dimensionColumns,
        groupBy: dimensionColumns,
        dimensionColumnsPrefixed,
        pageViewThreshold: 1000,
        limit: null,
      });

      const description = `fetch traffic data for predominant traffic analysis | siteId: ${siteId} | temporalCondition: ${temporalCondition}`;

      log.debug(`Traffic Tools Query: ${query}`);

      // Execute Athena query
      const outPrefix = getOutPrefix(query);
      const resultLocation = `${ATHENA_TEMP_FOLDER}/${outPrefix}`;
      const athenaClient = AWSAthenaClient.fromContext(context, resultLocation);

      const rawResults = await athenaClient.query(query, rumMetricsDatabase, description);

      log.info(`Athena query returned ${rawResults.length} rows`);

      // Create a map to organize data by path
      const pathTrafficMap = new Map();

      rawResults.forEach((row) => {
        const { path, trf_type: trfType } = row;
        const pageviews = Number.parseInt(row.pageviews || '0', 10);

        if (!pathTrafficMap.has(path)) {
          pathTrafficMap.set(path, {
            paid: 0,
            earned: 0,
            owned: 0,
            total: 0,
          });
        }

        const pathData = pathTrafficMap.get(path);
        if (trfType === 'paid' || trfType === 'earned' || trfType === 'owned') {
          pathData[trfType] = pageviews;
          pathData.total += pageviews;
        }
      });

      // Build result array
      const result = urls.map((url) => {
        // Extract path from URL
        const path = extractPathFromUrl(url);

        log.debug(`Processing URL: ${url}, Path: ${path}`);

        const trafficData = pathTrafficMap.get(path);

        if (!trafficData || trafficData.total === 0) {
          log.debug(`No traffic data found for path: '${path}'`);
          return {
            url,
            predominantTraffic: 'no traffic',
            details: {
              paid: 0,
              earned: 0,
              owned: 0,
            },
          };
        }

        // Calculate percentages
        const details = {
          paid: (trafficData.paid / trafficData.total) * 100,
          earned: (trafficData.earned / trafficData.total) * 100,
          owned: (trafficData.owned / trafficData.total) * 100,
        };

        const predominantTraffic = calculatePredominantTraffic(details, predominantTrafficPct);

        return {
          url,
          predominantTraffic,
          details,
        };
      });

      log.info(`Predominant traffic analysis complete for ${urls.length} URLs`);

      return ok(result, {
        'content-encoding': 'gzip',
      });
    } catch (error) {
      log.error(`Error processing predominant traffic request: ${error.message}`, error);
      throw error;
    }
  }

  return {
    getPredominantTraffic,
  };
}

export default TrafficToolsController;
