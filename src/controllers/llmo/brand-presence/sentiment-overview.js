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
 * Handles requests to get weekly sentiment overview from brand_presence table
 * Returns aggregated sentiment data by week with optional filters
 * @param {object} context - The request context
 * @param {Function} getSiteAndValidateLlmo - Function to validate site and LLMO access
 * @returns {Promise<Response>} The response with sentiment overview data
 */
export async function getSentimentOverview(context, getSiteAndValidateLlmo) {
  const {
    log, env, aurora,
  } = context;
  const { siteId } = context.params;
  const {
    startDate,
    endDate,
    category,
    topic,
    region,
    origin,
    model,
    promptBranding,
    brandName,
  } = context.data || {};
  const startTime = Date.now();

  log.info(`[SENTIMENT-OVERVIEW] Starting request for siteId: ${siteId}`);

  // Validate required params
  if (!startDate || !endDate) {
    log.warn(`[SENTIMENT-OVERVIEW] Missing required params for siteId: ${siteId} - startDate: ${startDate}, endDate: ${endDate}`);
    return badRequest('startDate and endDate are required', BRAND_PRESENCE_CORS_HEADERS);
  }

  // Validate promptBranding requires brandName
  if (promptBranding && promptBranding !== 'all' && !brandName) {
    log.warn(`[SENTIMENT-OVERVIEW] brandName required when promptBranding filter is set for siteId: ${siteId}`);
    return badRequest('brandName is required when promptBranding filter is set', BRAND_PRESENCE_CORS_HEADERS);
  }

  try {
    // Validate LLMO access
    log.info(`[SENTIMENT-OVERVIEW] Validating LLMO access for siteId: ${siteId}`);
    const validationStart = Date.now();
    await getSiteAndValidateLlmo(context);
    const validationDuration = Date.now() - validationStart;
    log.info(`[SENTIMENT-OVERVIEW] LLMO access validation completed for siteId: ${siteId} - duration: ${validationDuration}ms`);

    // Check if Aurora is configured and enabled
    if (!aurora || !env.ENABLE_AURORA_QUERIES) {
      log.warn(`[SENTIMENT-OVERVIEW] Aurora database not configured or disabled for siteId: ${siteId}`);
      return badRequest('Aurora database is not configured or queries are not enabled', BRAND_PRESENCE_CORS_HEADERS);
    }

    let sentimentData = null;
    let queryDuration = 0;

    try {
      log.info(`[SENTIMENT-OVERVIEW] Querying sentiment overview for siteId: ${siteId}, dateRange: ${startDate} to ${endDate}`);
      const queryStart = Date.now();

      // Build dynamic WHERE conditions
      const conditions = ['site_id = $1', 'date >= $2', 'date <= $3'];
      const params = [siteId, startDate, endDate];
      let idx = 4;

      if (category && category !== 'all') {
        conditions.push(`category = $${idx}`);
        params.push(category);
        idx += 1;
      }
      if (topic && topic !== 'all') {
        conditions.push(`topics = $${idx}`);
        params.push(topic);
        idx += 1;
      }
      if (region && region !== 'all') {
        conditions.push(`region = $${idx}`);
        params.push(region);
        idx += 1;
      }
      if (origin && origin !== 'all') {
        conditions.push(`origin = $${idx}`);
        params.push(origin);
        idx += 1;
      }
      if (model && model !== 'all') {
        conditions.push(`model = $${idx}`);
        params.push(model);
        idx += 1;
      }

      // Handle promptBranding filter (branded/non-branded)
      if (promptBranding && promptBranding !== 'all' && brandName) {
        if (promptBranding === 'branded') {
          conditions.push(`prompt ILIKE $${idx}`);
          params.push(`%${brandName}%`);
          idx += 1;
        } else if (promptBranding === 'non-branded') {
          conditions.push(`prompt NOT ILIKE $${idx}`);
          params.push(`%${brandName}%`);
          idx += 1;
        }
      }

      const sql = `
          WITH distinct_prompts AS (
            SELECT 
              TO_CHAR(date, 'IYYY-"W"IW') AS week,
              prompt,
              region,
              topics,
              category,
              -- Check if this prompt instance has sentiment
              BOOL_OR(sentiment IS NOT NULL AND TRIM(sentiment) != '') AS has_sentiment,
              -- Count sentiments for this specific prompt group
              COUNT(*) FILTER (WHERE LOWER(sentiment) = 'positive') AS pos,
              COUNT(*) FILTER (WHERE LOWER(sentiment) = 'neutral') AS neu,
              COUNT(*) FILTER (WHERE LOWER(sentiment) = 'negative') AS neg,
              COUNT(*) FILTER (WHERE sentiment IS NOT NULL AND TRIM(sentiment) != '') AS total_sent
            FROM public.brand_presence
            WHERE ${conditions.join(' AND ')}
            GROUP BY 1, 2, 3, 4, 5
          ),
          weekly_stats AS (
            SELECT 
              week,
              COUNT(*) AS total_prompts,
              COUNT(*) FILTER (WHERE has_sentiment) AS prompts_with_sentiment,
              SUM(pos) AS positive_count,
              SUM(neu) AS neutral_count,
              SUM(neg) AS negative_count,
              SUM(total_sent) AS sentiment_total
            FROM distinct_prompts
            GROUP BY week
          )
          SELECT 
            week,
            total_prompts::int AS "totalPrompts",
            prompts_with_sentiment::int AS "promptsWithSentiment",
            json_build_object(
              'positive', CASE WHEN sentiment_total > 0 THEN ROUND((positive_count::numeric / sentiment_total) * 100) ELSE 0 END,
              'neutral', CASE WHEN sentiment_total > 0 THEN 
                100 - (ROUND((positive_count::numeric / sentiment_total) * 100) + ROUND((negative_count::numeric / sentiment_total) * 100))
              ELSE 0 END,
              'negative', CASE WHEN sentiment_total > 0 THEN ROUND((negative_count::numeric / sentiment_total) * 100) ELSE 0 END
            ) AS sentiment
          FROM weekly_stats
          ORDER BY week
        `;

      const result = await aurora.query(sql, params);
      queryDuration = Date.now() - queryStart;

      sentimentData = result;

      log.info(`[SENTIMENT-OVERVIEW] Sentiment data retrieved for siteId: ${siteId} - weeks: ${sentimentData.length}, queryDuration: ${queryDuration}ms`);
    } catch (dbError) {
      log.error(`[SENTIMENT-OVERVIEW] Database query failed for siteId: ${siteId} - error: ${dbError.message}`);
      return badRequest(`Failed to fetch sentiment overview: ${dbError.message}`, BRAND_PRESENCE_CORS_HEADERS);
    }

    const totalDuration = Date.now() - startTime;
    log.info(`[SENTIMENT-OVERVIEW] Request completed for siteId: ${siteId} - total duration: ${totalDuration}ms`);

    return ok({
      siteId,
      data: sentimentData,
      performance: {
        totalDuration,
        queryDuration,
        validationDuration,
      },
    }, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'x-api-key, authorization, content-type',
    });
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    log.error(`[SENTIMENT-OVERVIEW] Request failed for siteId: ${siteId} - duration: ${totalDuration}ms, error: ${error.message}`);
    return badRequest(error.message);
  }
}
