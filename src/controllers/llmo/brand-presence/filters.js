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

import { ok, badRequest } from '@adobe/spacecat-shared-http-utils';
import { BRAND_PRESENCE_CORS_HEADERS } from './cors.js';

/**
 * Handles requests to get distinct filter values from brand_presence table
 * Returns available values for each filter dimension to populate UI dropdowns
 * @param {object} context - The request context
 * @param {Function} getSiteAndValidateLlmo - Function to validate site and LLMO access
 * @returns {Promise<Response>} The response with filter values
 */
export async function getBrandPresenceFilters(context, getSiteAndValidateLlmo) {
  const {
    log, env, aurora,
  } = context;
  const { siteId } = context.params;
  const startTime = Date.now();

  log.info(`[BRAND-PRESENCE-FILTERS] Starting request for siteId: ${siteId}`);

  try {
    // Validate LLMO access
    log.info(`[BRAND-PRESENCE-FILTERS] Validating LLMO access for siteId: ${siteId}`);
    const validationStart = Date.now();
    await getSiteAndValidateLlmo(context);
    const validationDuration = Date.now() - validationStart;
    log.info(`[BRAND-PRESENCE-FILTERS] LLMO access validation completed for siteId: ${siteId} - duration: ${validationDuration}ms`);

    // Check if Aurora is configured and enabled
    if (!aurora) {
      log.error(`[BRAND-PRESENCE-FILTERS] Aurora client is NOT initialized for siteId: ${siteId}`);
      return badRequest('Aurora client is not initialized - check AURORA_HOST environment variable', BRAND_PRESENCE_CORS_HEADERS);
    }
    if (!env.ENABLE_AURORA_QUERIES) {
      log.error(`[BRAND-PRESENCE-FILTERS] ENABLE_AURORA_QUERIES is: ${env.ENABLE_AURORA_QUERIES} for siteId: ${siteId}`);
      return badRequest('Aurora queries are not enabled - check ENABLE_AURORA_QUERIES environment variable', BRAND_PRESENCE_CORS_HEADERS);
    }

    log.info(`[BRAND-PRESENCE-FILTERS] Aurora check passed - aurora client exists: ${!!aurora}, ENABLE_AURORA_QUERIES: ${env.ENABLE_AURORA_QUERIES}`);

    let filterValues = null;
    let queryDuration = 0;

    try {
      log.info(`[BRAND-PRESENCE-FILTERS] Querying brand presence filter values for siteId: ${siteId}`);
      const queryStart = Date.now();

      // Query for distinct values of each filter dimension
      // Using a single query with DISTINCT ON each column is more efficient than multiple queries
      const [
        categories,
        topics,
        models,
        regions,
        origins,
      ] = await Promise.all([
        // Get distinct categories
        aurora.query(
          `SELECT DISTINCT category 
           FROM public.brand_presence 
           WHERE category IS NOT NULL 
             AND category != '' 
           ORDER BY category`,
        ),
        // Get distinct topics (split comma-separated values)
        // Use materialized view for performance
        aurora.query(
          `SELECT DISTINCT TRIM(unnest(string_to_array(topics, ','))) as topic
           FROM brand_presence_topics_by_date
           WHERE topics IS NOT NULL 
             AND topics != '' 
           ORDER BY topic`,
        ),
        // Get distinct models (platforms)
        aurora.query(
          `SELECT DISTINCT model 
           FROM public.brand_presence 
           WHERE model IS NOT NULL 
             AND model != '' 
           ORDER BY model`,
        ),
        // Get distinct regions
        aurora.query(
          `SELECT DISTINCT region 
           FROM public.brand_presence 
           WHERE region IS NOT NULL 
             AND region != '' 
           ORDER BY region`,
        ),
        // Get distinct origins
        aurora.query(
          `SELECT DISTINCT origin 
           FROM public.brand_presence 
           WHERE origin IS NOT NULL 
             AND origin != '' 
           ORDER BY origin`,
        ),
      ]);

      queryDuration = Date.now() - queryStart;

      // Extract values from query results
      filterValues = {
        categories: categories.map((row) => row.category),
        topics: topics.map((row) => row.topic),
        models: models.map((row) => row.model),
        regions: regions.map((row) => row.region),
        origins: origins.map((row) => row.origin),
      };

      log.info(`[BRAND-PRESENCE-FILTERS] Filter values retrieved for siteId: ${siteId} - categories: ${filterValues.categories.length}, topics: ${filterValues.topics.length}, models: ${filterValues.models.length}, regions: ${filterValues.regions.length}, origins: ${filterValues.origins.length}`);
    } catch (dbError) {
      log.error(`[BRAND-PRESENCE-FILTERS] Database query failed for siteId: ${siteId} - error: ${dbError.message}`);
      return badRequest(`Failed to fetch filter values: ${dbError.message}`, BRAND_PRESENCE_CORS_HEADERS);
    }

    const totalDuration = Date.now() - startTime;
    log.info(`[BRAND-PRESENCE-FILTERS] Request completed for siteId: ${siteId} - total duration: ${totalDuration}ms`);

    return ok({
      siteId,
      filters: filterValues,
      performance: {
        totalDuration,
        queryDuration,
        validationDuration: validationDuration || 0,
      },
    }, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'x-api-key, authorization, content-type',
    });
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    log.error(`[BRAND-PRESENCE-FILTERS] Request failed for siteId: ${siteId} - duration: ${totalDuration}ms, error: ${error.message}`);
    return badRequest(error.message, BRAND_PRESENCE_CORS_HEADERS);
  }
}
