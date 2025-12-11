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

      // Query 1: Calculate overall visibility score
      // Group by unique prompt (prompt|region|topics) and average, then average all prompts
      const visibilityScoreQuery = `
        SELECT ROUND(AVG(avg_score)::numeric, 0) as visibility_score
        FROM (
          SELECT AVG(visibility_score) as avg_score
          FROM public.brand_presence
          WHERE ${whereClause}
            AND visibility_score IS NOT NULL
          GROUP BY prompt, region, topics
        ) as unique_prompts
      `;

      // Query 2: Count distinct brand mentions
      // Unique prompt = prompt + region + topics
      const brandMentionsQuery = `
        SELECT COUNT(DISTINCT (prompt || '|' || COALESCE(region, 'Unknown') || '|' || COALESCE(topics, 'Unknown'))) as brand_mentions
        FROM public.brand_presence
        WHERE ${whereClause}
          AND mentions = true
      `;

      // Query 3: Count distinct citations
      // Unique prompt = prompt + region + topics
      const citationsQuery = `
        SELECT COUNT(DISTINCT (prompt || '|' || COALESCE(region, 'Unknown') || '|' || COALESCE(topics, 'Unknown'))) as citations
        FROM public.brand_presence
        WHERE ${whereClause}
          AND citations = true
      `;

      // Query 4: Get weekly breakdown for mini charts
      // Extract ISO week from date and calculate metrics per week
      const weeklyDataQuery = `
        WITH weekly_stats AS (
          SELECT 
            TO_CHAR(date, 'IYYY-"W"IW') as week,
            prompt,
            region,
            topics,
            visibility_score,
            mentions,
            citations
          FROM public.brand_presence
          WHERE ${whereClause}
        )
        SELECT 
          week,
          ROUND(AVG(avg_visibility)::numeric, 0) as visibility_score,
          COUNT(DISTINCT CASE WHEN mentions = true THEN (prompt || '|' || COALESCE(region, 'Unknown') || '|' || COALESCE(topics, 'Unknown')) END) as mentions,
          COUNT(DISTINCT CASE WHEN citations = true THEN (prompt || '|' || COALESCE(region, 'Unknown') || '|' || COALESCE(topics, 'Unknown')) END) as citations
        FROM (
          SELECT 
            week,
            prompt,
            region,
            topics,
            AVG(visibility_score) as avg_visibility,
            BOOL_OR(mentions) as mentions,
            BOOL_OR(citations) as citations
          FROM weekly_stats
          WHERE visibility_score IS NOT NULL
          GROUP BY week, prompt, region, topics
        ) as unique_prompts_per_week
        GROUP BY week
        ORDER BY week ASC
      `;

      // Execute all queries in parallel
      const [
        visibilityScoreResult,
        brandMentionsResult,
        citationsResult,
        weeklyDataResult,
      ] = await Promise.all([
        aurora.queryOne(visibilityScoreQuery, params),
        aurora.queryOne(brandMentionsQuery, params),
        aurora.queryOne(citationsQuery, params),
        aurora.query(weeklyDataQuery, params),
      ]);

      const queryDuration = Date.now() - queryStart;

      // Extract stats
      const stats = {
        visibilityScore: parseInt(visibilityScoreResult?.visibility_score || 0, 10),
        brandMentions: parseInt(brandMentionsResult?.brand_mentions || 0, 10),
        citations: parseInt(citationsResult?.citations || 0, 10),
      };

      // Format weekly data
      const weeklyData = weeklyDataResult.map((row) => ({
        week: row.week,
        visibilityScore: parseInt(row.visibility_score || 0, 10),
        mentions: parseInt(row.mentions || 0, 10),
        citations: parseInt(row.citations || 0, 10),
      }));

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
