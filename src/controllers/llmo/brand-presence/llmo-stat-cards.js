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
 * Calculate Week-over-Week trend from weekly data
 * Compares the last two complete weeks
 * @param {Array} weeklyData - Array of weekly stats
 * @param {string} metric - Metric name ('visibilityScore', 'mentions', 'citations')
 * @returns {Object} Trend object with direction and hasValidComparison
 */
function calculateWoWTrend(weeklyData, metric) {
  if (!weeklyData || weeklyData.length < 2) {
    return { direction: 'neutral', hasValidComparison: false };
  }

  // Get last two weeks (already sorted by week ASC)
  const lastWeek = weeklyData[weeklyData.length - 1];
  const previousWeek = weeklyData[weeklyData.length - 2];

  const lastValue = lastWeek[metric] || 0;
  const previousValue = previousWeek[metric] || 0;

  // Calculate percentage change
  if (previousValue === 0) {
    if (lastValue > 0) {
      return { direction: 'positive', hasValidComparison: true };
    }
    return { direction: 'neutral', hasValidComparison: false };
  }

  const percentChange = ((lastValue - previousValue) / previousValue) * 100;

  // Threshold for "neutral" is 5% change
  if (Math.abs(percentChange) < 5) {
    return { direction: 'neutral', hasValidComparison: true };
  }

  return {
    direction: percentChange > 0 ? 'positive' : 'negative',
    hasValidComparison: true,
  };
}

/**
 * Handles requests to get brand presence stats for stats cards
 * Calculates visibility score, brand mentions, and citations with WoW trends
 * @param {object} context - The request context
 * @param {Function} getSiteAndValidateLlmo - Function to validate site and LLMO access
 * @returns {Promise<Response>} The response with stats data
 */
export async function getBrandPresenceStats(context, getSiteAndValidateLlmo) {
  const {
    log, env, aurora,
  } = context;
  const { siteId } = context.params;
  const startTime = Date.now();

  log.info(`[BRAND-PRESENCE-STATS] Starting request for siteId: ${siteId}`);

  try {
    // Validate LLMO access and get site config
    log.info(`[BRAND-PRESENCE-STATS] Validating LLMO access for siteId: ${siteId}`);
    const validationStart = Date.now();
    const { site, llmoConfig } = await getSiteAndValidateLlmo(context);
    const validationDuration = Date.now() - validationStart;
    log.info(`[BRAND-PRESENCE-STATS] LLMO access validation completed for siteId: ${siteId} - duration: ${validationDuration}ms`);

    // Get brand name from site config for prompt branding filter
    const brandName = llmoConfig?.brand || site?.getConfig()?.getLlmoConfig()?.brand;

    // Check if Aurora is configured and enabled
    if (!aurora || !env.ENABLE_AURORA_QUERIES) {
      log.warn(`[BRAND-PRESENCE-STATS] Aurora database not configured or disabled for siteId: ${siteId}`);
      return badRequest('Aurora database is not configured or queries are not enabled', BRAND_PRESENCE_CORS_HEADERS);
    }

    // Parse query parameters
    const {
      start_date: startDate,
      end_date: endDate,
      topic,
      category,
      region,
      origin,
      prompt_branding: promptBranding,
      model,
    } = context.data || {};

    // Validate required parameters
    if (!startDate || !endDate) {
      return badRequest('start_date and end_date are required query parameters', BRAND_PRESENCE_CORS_HEADERS);
    }

    log.info(`[BRAND-PRESENCE-STATS] Query parameters - siteId: ${siteId}, startDate: ${startDate}, endDate: ${endDate}, topic: ${topic}, category: ${category}, region: ${region}, origin: ${origin}, promptBranding: ${promptBranding}, model: ${model}`);

    // Build WHERE clause for filters
    const whereConditions = ['site_id = $1', 'date >= $2', 'date <= $3'];
    const params = [siteId, startDate, endDate];
    let paramIndex = 4;

    if (topic && topic !== 'all') {
      whereConditions.push(`topics ILIKE $${paramIndex}`);
      params.push(`%${topic}%`);
      paramIndex += 1;
    }

    if (category && category !== 'all') {
      whereConditions.push(`category = $${paramIndex}`);
      params.push(category);
      paramIndex += 1;
    }

    if (region && region !== 'all') {
      whereConditions.push(`region = $${paramIndex}`);
      params.push(region);
      paramIndex += 1;
    }

    if (origin && origin !== 'all') {
      whereConditions.push(`origin = $${paramIndex}`);
      params.push(origin);
      paramIndex += 1;
    }

    if (model && model !== 'all') {
      whereConditions.push(`model = $${paramIndex}`);
      params.push(model);
      paramIndex += 1;
    }

    // Handle prompt branding filter
    if (promptBranding && promptBranding !== 'all' && brandName) {
      if (promptBranding === 'branded') {
        whereConditions.push(`prompt ILIKE $${paramIndex}`);
        params.push(`%${brandName}%`);
        paramIndex += 1;
      } else if (promptBranding === 'non-branded') {
        whereConditions.push(`prompt NOT ILIKE $${paramIndex}`);
        params.push(`%${brandName}%`);
        paramIndex += 1;
      }
    }

    const whereClause = whereConditions.join(' AND ');

    try {
      const queryStart = Date.now();

      // Optimized single query using materialized view brand_presence_prompts_by_date
      // This combines all 4 previous queries into one efficient query
      const combinedQuery = `
        WITH filtered_data AS (
          -- Apply all filters to the materialized view
          SELECT
            date,
            prompt,
            region,
            topics,
            avg_visibility_score,
            mentions_count,
            citations_count
          FROM brand_presence_prompts_by_date
          WHERE ${whereClause}
        ),
        unique_prompts AS (
          -- Calculate unique prompt metrics (prompt|region|topics)
          -- Group by unique prompt to get average visibility and presence of mentions/citations
          SELECT
            prompt || '|' || COALESCE(region, 'Unknown') || '|' || COALESCE(topics, 'Unknown') AS unique_prompt,
            AVG(avg_visibility_score) AS avg_visibility,
            BOOL_OR(mentions_count > 0) AS has_mentions,
            BOOL_OR(citations_count > 0) AS has_citations
          FROM filtered_data
          GROUP BY prompt, region, topics
        ),
        weekly_breakdown AS (
          -- Calculate weekly metrics per unique prompt
          SELECT
            TO_CHAR(date, 'IYYY-"W"IW') AS week,
            prompt || '|' || COALESCE(region, 'Unknown') || '|' || COALESCE(topics, 'Unknown') AS unique_prompt,
            AVG(avg_visibility_score) AS avg_visibility,
            BOOL_OR(mentions_count > 0) AS has_mentions,
            BOOL_OR(citations_count > 0) AS has_citations
          FROM filtered_data
          GROUP BY week, prompt, region, topics
        ),
        weekly_aggregated AS (
          -- Aggregate weekly data across all unique prompts
          SELECT
            week,
            ROUND(AVG(avg_visibility)::numeric, 0) AS visibility_score,
            COUNT(DISTINCT CASE WHEN has_mentions THEN unique_prompt END) AS mentions,
            COUNT(DISTINCT CASE WHEN has_citations THEN unique_prompt END) AS citations
          FROM weekly_breakdown
          GROUP BY week
        ),
        overall_stats AS (
          -- Calculate overall stats from unique prompts
          SELECT
            ROUND(AVG(avg_visibility)::numeric, 0) AS visibility_score,
            COUNT(*) FILTER (WHERE has_mentions) AS brand_mentions,
            COUNT(*) FILTER (WHERE has_citations) AS citations
          FROM unique_prompts
        )
        SELECT
          -- Overall metrics
          (SELECT visibility_score FROM overall_stats) AS visibility_score,
          (SELECT brand_mentions FROM overall_stats) AS brand_mentions,
          (SELECT citations FROM overall_stats) AS citations,
          -- Weekly breakdown as JSON array
          COALESCE(
            (SELECT JSON_AGG(
              JSON_BUILD_OBJECT(
                'week', week,
                'visibilityScore', visibility_score,
                'mentions', mentions,
                'citations', citations
              ) ORDER BY week
            ) FROM weekly_aggregated),
            '[]'::json
          ) AS weekly_data;
      `;

      log.info(`[BRAND-PRESENCE-STATS] Combined query: ${combinedQuery} with params: ${JSON.stringify(params)}`);

      const queryResult = await aurora.queryOne(combinedQuery, params);
      const queryDuration = Date.now() - queryStart;

      // Extract stats
      const stats = {
        visibilityScore: parseInt(queryResult?.visibility_score || 0, 10),
        brandMentions: parseInt(queryResult?.brand_mentions || 0, 10),
        citations: parseInt(queryResult?.citations || 0, 10),
      };

      // Parse weekly data from JSON array
      let weeklyData = [];
      if (queryResult?.weekly_data) {
        try {
          const parsedWeekly = Array.isArray(queryResult.weekly_data)
            ? queryResult.weekly_data
            : JSON.parse(queryResult.weekly_data);
          weeklyData = parsedWeekly.map((row) => ({
            week: row.week,
            visibilityScore: parseInt(row.visibilityScore || 0, 10),
            mentions: parseInt(row.mentions || 0, 10),
            citations: parseInt(row.citations || 0, 10),
          }));
        } catch (parseError) {
          log.warn(`[BRAND-PRESENCE-STATS] Failed to parse weekly_data JSON for siteId: ${siteId} - error: ${parseError.message}`);
          weeklyData = [];
        }
      }

      // Calculate WoW trends
      const wowTrends = {
        visibilityScore: calculateWoWTrend(weeklyData, 'visibilityScore'),
        mentions: calculateWoWTrend(weeklyData, 'mentions'),
        citations: calculateWoWTrend(weeklyData, 'citations'),
      };

      log.info(`[BRAND-PRESENCE-STATS] Stats calculated for siteId: ${siteId} - visibilityScore: ${stats.visibilityScore}, brandMentions: ${stats.brandMentions}, citations: ${stats.citations}, weeks: ${weeklyData.length}, queryDuration: ${queryDuration}ms`);

      const totalDuration = Date.now() - startTime;
      log.info(`[BRAND-PRESENCE-STATS] Request completed for siteId: ${siteId} - total duration: ${totalDuration}ms`);

      return ok({
        siteId,
        stats,
        wowTrends,
        weeklyData,
        filters: {
          startDate,
          endDate,
          topic: topic || 'all',
          category: category || 'all',
          region: region || 'all',
          origin: origin || 'all',
          promptBranding: promptBranding || 'all',
        },
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
    } catch (dbError) {
      log.error(`[BRAND-PRESENCE-STATS] Database query failed for siteId: ${siteId} - error: ${dbError.message}, stack: ${dbError.stack}`);
      return badRequest(`Failed to fetch brand presence stats: ${dbError.message}`, BRAND_PRESENCE_CORS_HEADERS);
    }
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    log.error(`[BRAND-PRESENCE-STATS] Request failed for siteId: ${siteId} - duration: ${totalDuration}ms, error: ${error.message}, stack: ${error.stack}`);
    return badRequest(error.message);
  }
}
