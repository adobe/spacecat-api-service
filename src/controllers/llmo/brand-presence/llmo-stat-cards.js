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
      return badRequest('Aurora database is not configured or queries are not enabled');
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
      return badRequest('start_date and end_date are required query parameters');
    }

    log.info(`[BRAND-PRESENCE-STATS] Query parameters - siteId: ${siteId}, startDate: ${startDate}, endDate: ${endDate}, topic: ${topic}, category: ${category}, region: ${region}, origin: ${origin}, promptBranding: ${promptBranding}, model: ${model}`);

    // --- Build WHERE conditions for different query types ---

    // 1. Joined conditions (aliased with 'bp.')
    const joinedConditions = ['bp.site_id = $1', 'bp.date >= $2', 'bp.date <= $3'];
    const joinedParams = [siteId, startDate, endDate];
    let jIdx = 4;

    // 2. Single table conditions (unaliased)
    const singleConditions = ['site_id = $1', 'date >= $2', 'date <= $3'];
    const singleParams = [siteId, startDate, endDate];
    let sIdx = 4;

    // 3. Metrics table conditions (week-based, unaliased)
    const metricsConditions = [
      'site_id = $1',
      'week >= TO_CHAR($2::date, \'IYYY-"W"IW\')',
      'week <= TO_CHAR($3::date, \'IYYY-"W"IW\')',
    ];
    const metricsParams = [siteId, startDate, endDate];
    let mIdx = 4;

    // Apply Filters
    if (topic && topic !== 'all') {
      joinedConditions.push(`bp.topics ILIKE $${jIdx}`);
      jIdx += 1;
      joinedParams.push(`%${topic}%`);

      singleConditions.push(`topics ILIKE $${sIdx}`);
      sIdx += 1;
      singleParams.push(`%${topic}%`);

      metricsConditions.push(`topics ILIKE $${mIdx}`);
      mIdx += 1;
      metricsParams.push(`%${topic}%`);
    }

    if (category && category !== 'all') {
      joinedConditions.push(`bp.category = $${jIdx}`);
      jIdx += 1;
      joinedParams.push(category);

      singleConditions.push(`category = $${sIdx}`);
      sIdx += 1;
      singleParams.push(category);

      metricsConditions.push(`category = $${mIdx}`);
      mIdx += 1;
      metricsParams.push(category);
    }

    if (region && region !== 'all') {
      joinedConditions.push(`bp.region = $${jIdx}`);
      jIdx += 1;
      joinedParams.push(region);

      singleConditions.push(`region = $${sIdx}`);
      sIdx += 1;
      singleParams.push(region);

      metricsConditions.push(`region = $${mIdx}`);
      mIdx += 1;
      metricsParams.push(region);
    }

    if (origin && origin !== 'all') {
      joinedConditions.push(`bp.origin = $${jIdx}`);
      jIdx += 1;
      joinedParams.push(origin);

      singleConditions.push(`origin = $${sIdx}`);
      sIdx += 1;
      singleParams.push(origin);
      // origin not supported in metrics table
    }

    if (model && model !== 'all') {
      joinedConditions.push(`bp.model = $${jIdx}`);
      jIdx += 1;
      joinedParams.push(model);

      singleConditions.push(`model = $${sIdx}`);
      sIdx += 1;
      singleParams.push(model);

      metricsConditions.push(`model = $${mIdx}`);
      mIdx += 1;
      metricsParams.push(model);
    }

    // Handle prompt branding filter
    if (promptBranding && promptBranding !== 'all' && brandName) {
      if (promptBranding === 'branded') {
        joinedConditions.push(`bp.prompt ILIKE $${jIdx}`);
        jIdx += 1;
        joinedParams.push(`%${brandName}%`);

        singleConditions.push(`prompt ILIKE $${sIdx}`);
        sIdx += 1;
        singleParams.push(`%${brandName}%`);
      } else if (promptBranding === 'non-branded') {
        joinedConditions.push(`bp.prompt NOT ILIKE $${jIdx}`);
        jIdx += 1;
        joinedParams.push(`%${brandName}%`);

        singleConditions.push(`prompt NOT ILIKE $${sIdx}`);
        sIdx += 1;
        singleParams.push(`%${brandName}%`);
      }
      // prompt_branding not supported in metrics table
    }

    const joinedWhereClause = joinedConditions.join(' AND ');
    const singleWhereClause = singleConditions.join(' AND ');
    // const metricsWhereClause = metricsConditions.join(' AND ');

    // Determine if we can use the fast metrics table
    const useFastMetrics = !origin && !promptBranding;

    try {
      const queryStart = Date.now();

      // Query 1: Calculate overall visibility score (from brand_presence_prompts_by_date view)
      // Matches frontend logic: Group by unique prompt first, calculate weighted average
      // visibility per prompt, then average across all prompts.
      // Using the materialized view is faster and matches the data source user requested.
      const visibilityScoreQuery = `
        WITH unique_prompts AS (
          SELECT
            SUM(avg_visibility_score * executions_count) / NULLIF(SUM(executions_count), 0) as avg_score
          FROM brand_presence_prompts_by_date
          WHERE ${singleWhereClause}
          GROUP BY 
            COALESCE(NULLIF(prompt, ''), 'Unknown'),
            COALESCE(NULLIF(region, ''), 'Unknown'),
            COALESCE(NULLIF(topics, ''), 'Unknown')
        )
        SELECT ROUND(AVG(avg_score)::numeric, 0) as visibility_score
        FROM unique_prompts
      `;

      // Query 2: Calculate brand mentions and citations
      // Matches frontend logic:
      // 1. Group by unique prompt (prompt + region + topics)
      // 2. A prompt counts as a mention if 'mentions' is true in ANY record for that prompt
      // 3. A prompt counts as a citation if it has ANY owned source in ANY record for that prompt
      // 4. Count unique prompts that satisfy the conditions
      let mentionsCitationsQuery;
      let mentionsCitationsParams;

      if (useFastMetrics) {
        // FAST PATH: Use brand_presence_prompts_by_date view
        // The view already pre-calculates mentions_count and citations_count per prompt/date.
        // To match frontend "unique prompt" logic:
        // - A prompt is a mention if SUM(mentions_count) > 0 across the period
        // - A prompt is a citation if SUM(citations_count) > 0 across the period
        mentionsCitationsQuery = `
          SELECT
            COUNT(CASE WHEN total_mentions > 0 THEN 1 END)::int as brand_mentions,
            COUNT(CASE WHEN total_citations > 0 THEN 1 END)::int as citations
          FROM (
            SELECT
              SUM(mentions_count) as total_mentions,
              SUM(citations_count) as total_citations
            FROM brand_presence_prompts_by_date
            WHERE ${singleWhereClause}
            GROUP BY 
              COALESCE(NULLIF(prompt, ''), 'Unknown'),
              COALESCE(NULLIF(region, ''), 'Unknown'),
              COALESCE(NULLIF(topics, ''), 'Unknown')
          ) as prompt_stats
        `;
        mentionsCitationsParams = singleParams;
      } else {
        // SLOW PATH: Fallback to brand_presence + sources join
        // Using aliased joined conditions to fix ambiguity
        mentionsCitationsQuery = `
          SELECT
            COUNT(CASE WHEN mentions THEN 1 END) as brand_mentions,
            COUNT(CASE WHEN citations THEN 1 END) as citations
          FROM (
            SELECT
              BOOL_OR(bp.mentions) as mentions,
              BOOL_OR(bps.id IS NOT NULL) as citations
            FROM public.brand_presence bp
            LEFT JOIN public.brand_presence_sources bps 
              ON bp.id = bps.brand_presence_id 
              AND bps.is_owned = true
              AND bps.site_id = $1
            WHERE ${joinedWhereClause}
            GROUP BY 
              COALESCE(NULLIF(bp.prompt, ''), 'Unknown'),
              COALESCE(NULLIF(bp.region, ''), 'Unknown'),
              COALESCE(NULLIF(bp.topics, ''), 'Unknown')
          ) as sub
        `;
        mentionsCitationsParams = joinedParams;
      }

      // Query 3: Get weekly breakdown for mini charts
      let weeklyDataQuery;
      let weeklyDataParams;
      let weeklyVisibilityQuery; // Needed for Fast Path to fill in the missing visibility score

      if (useFastMetrics) {
        // FAST PATH: Use brand_presence_prompts_by_date for correct deduplication per week
        weeklyDataQuery = `
          SELECT
            week,
            0 as visibility_score, -- Placeholder, filled by separate query
            COUNT(CASE WHEN week_mentions > 0 THEN 1 END)::int as mentions,
            COUNT(CASE WHEN week_citations > 0 THEN 1 END)::int as citations
          FROM (
            SELECT
              TO_CHAR(date, 'IYYY-"W"IW') as week,
              prompt,
              region,
              topics,
              SUM(mentions_count) as week_mentions,
              SUM(citations_count) as week_citations
            FROM brand_presence_prompts_by_date
            WHERE ${singleWhereClause}
            GROUP BY 1, 2, 3, 4
          ) as weekly_prompt_stats
          GROUP BY week
          ORDER BY week ASC
        `;
        weeklyDataParams = singleParams;

        // Fetch visibility score trend separately from view (fast enough as materialized)
        weeklyVisibilityQuery = `
          SELECT
            week,
            ROUND(AVG(week_prompt_avg)::numeric, 0) as visibility_score
          FROM (
            SELECT
              TO_CHAR(date, 'IYYY-"W"IW') as week,
              prompt,
              region,
              topics,
              SUM(avg_visibility_score * executions_count) / NULLIF(SUM(executions_count), 0) as week_prompt_avg
            FROM brand_presence_prompts_by_date
            WHERE ${singleWhereClause}
            GROUP BY 1, 2, 3, 4
          ) sub
          GROUP BY 1
          ORDER BY 1 ASC
        `;
      } else {
        // Fallback slow weekly query
        weeklyDataQuery = `
          WITH filtered_bp AS (
            SELECT id, date, prompt, region, topics, visibility_score, mentions
            FROM public.brand_presence bp
            WHERE ${joinedWhereClause}
          ),
          cited_bp_ids AS (
            SELECT DISTINCT brand_presence_id
            FROM public.brand_presence_sources
            WHERE site_id = $1
              AND date >= $2 AND date <= $3
              AND is_owned = true
          ),
          weekly_stats AS (
            SELECT
              TO_CHAR(bp.date, 'IYYY-"W"IW') as week,
              bp.prompt,
              bp.region,
              bp.topics,
              bp.visibility_score,
              bp.mentions,
              (c.brand_presence_id IS NOT NULL) as has_citation
            FROM filtered_bp bp
            LEFT JOIN cited_bp_ids c ON bp.id = c.brand_presence_id
          )
          SELECT
            week,
            ROUND(AVG(avg_visibility)::numeric, 0) as visibility_score,
            COUNT(CASE WHEN mentions THEN 1 END) as mentions,
            COUNT(CASE WHEN citations THEN 1 END) as citations
          FROM (
            SELECT
              week,
              prompt,
              region,
              topics,
              AVG(visibility_score) as avg_visibility,
              BOOL_OR(mentions) as mentions,
              BOOL_OR(has_citation) as citations
            FROM weekly_stats
            GROUP BY week, prompt, region, topics
          ) as unique_prompts_per_week
          GROUP BY week
          ORDER BY week ASC
        `;
        weeklyDataParams = joinedParams;
      }

      // Execute queries in parallel
      const queries = [
        aurora.queryOne(visibilityScoreQuery, singleParams),
        aurora.queryOne(mentionsCitationsQuery, mentionsCitationsParams),
        aurora.query(weeklyDataQuery, weeklyDataParams),
      ];

      if (useFastMetrics && weeklyVisibilityQuery) {
        queries.push(aurora.query(weeklyVisibilityQuery, singleParams));
      }

      const results = await Promise.all(queries);

      const visibilityScoreResult = results[0];
      const mentionsCitationsResult = results[1];
      const weeklyCounts = results[2];
      const weeklyVis = (useFastMetrics && results.length > 3) ? results[3] : null;

      let weeklyDataResult;

      if (useFastMetrics && weeklyVis) {
        // Merge metrics and visibility
        const visMap = new Map(weeklyVis.map((r) => [r.week, r.visibility_score]));
        weeklyDataResult = weeklyCounts.map((row) => ({
          week: row.week,
          mentions: parseInt(row.mentions || 0, 10),
          citations: parseInt(row.citations || 0, 10),
          visibilityScore: parseInt(visMap.get(row.week) || 0, 10),
        }));
      } else {
        weeklyDataResult = weeklyCounts.map((row) => ({
          week: row.week,
          mentions: parseInt(row.mentions || 0, 10),
          citations: parseInt(row.citations || 0, 10),
          visibilityScore: parseInt(row.visibility_score || 0, 10),
        }));
      }

      const queryDuration = Date.now() - queryStart;

      // Extract stats
      const stats = {
        visibilityScore: parseInt(visibilityScoreResult?.visibility_score || 0, 10),
        brandMentions: parseInt(mentionsCitationsResult?.brand_mentions || 0, 10),
        citations: parseInt(mentionsCitationsResult?.citations || 0, 10),
      };

      // Calculate WoW trends
      const wowTrends = {
        visibilityScore: calculateWoWTrend(weeklyDataResult, 'visibilityScore'),
        mentions: calculateWoWTrend(weeklyDataResult, 'mentions'),
        citations: calculateWoWTrend(weeklyDataResult, 'citations'),
      };

      log.info(`[BRAND-PRESENCE-STATS] Stats calculated for siteId: ${siteId} - visibilityScore: ${stats.visibilityScore}, brandMentions: ${stats.brandMentions}, citations: ${stats.citations}, weeks: ${weeklyDataResult.length}, queryDuration: ${queryDuration}ms`);

      const totalDuration = Date.now() - startTime;
      log.info(`[BRAND-PRESENCE-STATS] Request completed for siteId: ${siteId} - total duration: ${totalDuration}ms`);

      return ok({
        siteId,
        stats,
        wowTrends,
        weeklyData: weeklyDataResult,
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
      return badRequest(`Failed to fetch brand presence stats: ${dbError.message}`);
    }
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    log.error(`[BRAND-PRESENCE-STATS] Request failed for siteId: ${siteId} - duration: ${totalDuration}ms, error: ${error.message}, stack: ${error.stack}`);
    return badRequest(error.message);
  }
}
