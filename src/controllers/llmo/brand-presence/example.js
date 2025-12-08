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

/**
 * Example endpoint for brand presence Aurora queries
 * Tests Aurora PostgreSQL database connectivity and retrieves brand presence data
 * @param {object} context - The request context
 * @param {Function} getSiteAndValidateLlmo - Function to validate site and LLMO access
 * @returns {Promise<Response>} The response with example data
 */
export async function exampleEndpoint(context, getSiteAndValidateLlmo) {
  const {
    log, env, aurora,
  } = context;
  const { siteId } = context.params;
  const startTime = Date.now();

  log.info(`[BRAND-PRESENCE-EXAMPLE] Starting request for siteId: ${siteId}`);

  try {
    // Validate LLMO access
    log.info(`[BRAND-PRESENCE-EXAMPLE] Validating LLMO access for siteId: ${siteId}`);
    const validationStart = Date.now();
    await getSiteAndValidateLlmo(context);
    const validationDuration = Date.now() - validationStart;
    log.info(`[BRAND-PRESENCE-EXAMPLE] LLMO access validation completed for siteId: ${siteId} - duration: ${validationDuration}ms`);

    // Test Aurora database connectivity
    let dbStats = null;
    let dbTestDuration = 0;
    if (aurora && env.ENABLE_AURORA_QUERIES) {
      try {
        log.info(`[BRAND-PRESENCE-EXAMPLE] Testing Aurora database connectivity for siteId: ${siteId}`);
        const dbTestStart = Date.now();

        // Test 1: Simple connectivity test
        const connected = await aurora.testConnection();

        // Test 2: Query brand presence data
        const brandPresenceData = await aurora.query(
          `SELECT id, site_id, date, model, category, prompt, region, url, sources, citations, mentions FROM public.brand_presence
           WHERE date = $1 AND category = $2`,
          ['2025-11-24', 'Adobe'],
        );

        // Test 3: Count citations where citations = true
        const citationCount = await aurora.queryOne(
          `SELECT COUNT(*) as total_citations
           FROM public.brand_presence
           WHERE date = $1 AND category = $2 AND citations = true`,
          ['2025-11-24', 'Adobe'],
        );

        dbTestDuration = Date.now() - dbTestStart;

        log.info(`[BRAND-PRESENCE-EXAMPLE] Brand presence data: ${JSON.stringify(brandPresenceData)}`);
        dbStats = {
          connected,
          brandPresence: {
            data: brandPresenceData,
            totalRecords: brandPresenceData.length,
            totalCitations: citationCount ? parseInt(citationCount.total_citations, 10) : 0,
          },
          poolStats: aurora.getPoolStats(),
        };

        log.info(`[BRAND-PRESENCE-EXAMPLE] Aurora database test completed for siteId: ${siteId} - duration: ${dbTestDuration}ms, connected: ${connected}, brand presence records: ${brandPresenceData.length}, total citations: ${dbStats.brandPresence.totalCitations}`);
      } catch (dbError) {
        log.warn(`[BRAND-PRESENCE-EXAMPLE] Aurora database test failed for siteId: ${siteId} - error: ${dbError.message}`);
        dbStats = {
          connected: false,
          error: dbError.message,
        };
      }
    } else {
      log.info(`[BRAND-PRESENCE-EXAMPLE] Aurora database not configured or disabled for siteId: ${siteId}`);
    }

    const totalDuration = Date.now() - startTime;
    log.info(`[BRAND-PRESENCE-EXAMPLE] Request completed for siteId: ${siteId} - total duration: ${totalDuration}ms`);

    return ok({
      siteId,
      auroraStats: dbStats,
      performance: {
        totalDuration,
        dbTestDuration,
        validationDuration: validationDuration || 0,
      },
    });
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    log.error(`[BRAND-PRESENCE-EXAMPLE] Request failed for siteId: ${siteId} - duration: ${totalDuration}ms, error: ${error.message}, stack: ${error.stack}`);
    return badRequest(error.message);
  }
}
