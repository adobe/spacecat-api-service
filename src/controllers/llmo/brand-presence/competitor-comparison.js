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
 * Parse week string (YYYY-WNN) to extract year and week number
 * @param {string} week - Week string in format YYYY-WNN
 * @returns {Object} Object with year and weekNumber
 */
function parseWeek(week) {
  const match = week.match(/(\d{4})-W(\d{2})/);
  if (match) {
    return {
      year: parseInt(match[1], 10),
      weekNumber: parseInt(match[2], 10),
    };
  }
  return { year: 0, weekNumber: 0 };
}
/**
 * Build dynamic WHERE clause and params for brand_vs_competitors table
 * @param {string} siteId - Site ID
 * @param {string} startDate - Start date
 * @param {string} endDate - End date
 * @param {Object} filters - Optional filters (category, region, model)
 * @returns {Object} Object with conditions array and params array
 */
function buildCompetitorFilters(siteId, startDate, endDate, filters) {
  const conditions = ['site_id = $1', 'date >= $2', 'date <= $3'];
  const params = [siteId, startDate, endDate];
  let idx = 4;

  if (filters.category && filters.category !== 'all') {
    conditions.push(`category = $${idx}`);
    params.push(filters.category);
    idx += 1;
  }
  if (filters.region && filters.region !== 'all') {
    conditions.push(`region = $${idx}`);
    params.push(filters.region);
    idx += 1;
  }
  if (filters.model && filters.model !== 'all') {
    conditions.push(`model = $${idx}`);
    params.push(filters.model);
    idx += 1;
  }

  return { conditions, params };
}

/**
 * Merge weekly brand data with competitor data
 * @param {Array} brandData - Weekly brand metrics
 * @param {Array} competitorData - Weekly competitor metrics
 * @returns {Array} Merged weekly trends
 */
function mergeWeeklyData(brandData, competitorData) {
  // Group competitor data by week
  const competitorsByWeek = {};
  competitorData.forEach((row) => {
    if (!competitorsByWeek[row.week]) {
      competitorsByWeek[row.week] = [];
    }
    competitorsByWeek[row.week].push({
      name: row.competitor,
      mentions: parseInt(row.mentions || 0, 10),
      citations: parseInt(row.citations || 0, 10),
    });
  });

  // Merge brand data with competitor data
  return brandData.map((brandRow) => {
    const { year, weekNumber } = parseWeek(brandRow.week);
    return {
      week: brandRow.week,
      weekNumber,
      year,
      mentions: parseInt(brandRow.mentions || 0, 10),
      citations: parseInt(brandRow.citations || 0, 10),
      competitors: competitorsByWeek[brandRow.week] || [],
    };
  });
}

/**
 * Calculate share of voice per topic
 * @param {Array} topicData - Topic data with brand mentions and competitors
 * @returns {Array} Share of voice data
 */
function calculateShareOfVoice(topicData) {
  return topicData.map((row) => {
    const brandMentions = parseInt(row.brand_mentions || 0, 10);

    // Parse competitors from semicolon-separated string
    const competitorCounts = {};
    if (row.all_competitors) {
      const competitors = row.all_competitors.split(';').filter((c) => c.trim());
      competitors.forEach((competitor) => {
        const name = competitor.trim().toLowerCase();
        if (name) {
          competitorCounts[name] = (competitorCounts[name] || 0) + 1;
        }
      });
    }

    // Calculate total mentions (brand + all competitors)
    const totalCompetitorMentions = Object.values(competitorCounts)
      .reduce((sum, count) => sum + count, 0);
    const totalMentions = brandMentions + totalCompetitorMentions;

    // Calculate share of voice for brand
    const shareOfVoice = totalMentions > 0
      ? parseFloat(((brandMentions / totalMentions) * 100).toFixed(2))
      : 0;

    // Calculate share of voice for each competitor
    const allCompetitors = Object.entries(competitorCounts)
      .map(([name, mentions]) => ({
        name,
        mentions,
        shareOfVoice: totalMentions > 0
          ? parseFloat(((mentions / totalMentions) * 100).toFixed(2))
          : 0,
      }))
      .sort((a, b) => b.mentions - a.mentions);

    // Top competitors are top 3
    const topCompetitors = allCompetitors.slice(0, 3);

    return {
      topic: row.topic,
      brandMentions,
      totalMentions,
      shareOfVoice,
      topCompetitors,
      allCompetitors,
    };
  });
}

/**
 * Handles requests to get competitor comparison data for brand presence dashboard
 * Returns weekly trends with brand and competitor metrics, plus share of voice per topic
 * @param {object} context - The request context
 * @param {Function} getSiteAndValidateLlmo - Function to validate site and LLMO access
 * @returns {Promise<Response>} The response with competitor comparison data
 */
export async function getCompetitorComparison(context, getSiteAndValidateLlmo) {
  const {
    log, env, aurora,
  } = context;
  const { siteId } = context.params;
  const {
    startDate,
    endDate,
    category,
    region,
    model,
  } = context.data || {};
  const startTime = Date.now();

  log.info(`[COMPETITOR-COMPARISON] Starting request for siteId: ${siteId}`);

  // Validate required params
  if (!startDate || !endDate) {
    log.warn(`[COMPETITOR-COMPARISON] Missing required params for siteId: ${siteId} - startDate: ${startDate}, endDate: ${endDate}`);
    return badRequest('startDate and endDate are required');
  }

  try {
    // Validate LLMO access
    log.info(`[COMPETITOR-COMPARISON] Validating LLMO access for siteId: ${siteId}`);
    const validationStart = Date.now();
    await getSiteAndValidateLlmo(context);
    const validationDuration = Date.now() - validationStart;
    log.info(`[COMPETITOR-COMPARISON] LLMO access validation completed for siteId: ${siteId} - duration: ${validationDuration}ms`);

    // Check if Aurora is configured and enabled
    if (!aurora || !env.ENABLE_AURORA_QUERIES) {
      log.warn(`[COMPETITOR-COMPARISON] Aurora database not configured or disabled for siteId: ${siteId}`);
      return badRequest('Aurora database is not configured or queries are not enabled');
    }

    const filters = { category, region, model };

    try {
      log.info(`[COMPETITOR-COMPARISON] Querying competitor comparison for siteId: ${siteId}, dateRange: ${startDate} to ${endDate}`);
      const queryStart = Date.now();

      // Build filters for both tables
      const competitorFilters = buildCompetitorFilters(siteId, startDate, endDate, filters);

      // Build filters for Query 1 (using brand_metrics_weekly)
      const weeklyConditions = [
        'site_id = $1',
        'week >= TO_CHAR($2::date, \'IYYY-"W"IW\')',
        'week <= TO_CHAR($3::date, \'IYYY-"W"IW\')',
      ];
      const weeklyParams = [siteId, startDate, endDate];
      let wIdx = 4;

      if (filters.category && filters.category !== 'all') {
        weeklyConditions.push(`category = $${wIdx}`);
        weeklyParams.push(filters.category);
        wIdx += 1;
      }
      if (filters.region && filters.region !== 'all') {
        weeklyConditions.push(`region = $${wIdx}`);
        weeklyParams.push(filters.region);
        wIdx += 1;
      }
      if (filters.model && filters.model !== 'all') {
        weeklyConditions.push(`model = $${wIdx}`);
        weeklyParams.push(filters.model);
        wIdx += 1;
      }

      // Query 1: Weekly brand data from brand_metrics_weekly (pre-aggregated)
      const weeklyBrandQuery = `
        SELECT
          week,
          SUM(mentions_count)::int AS mentions,
          SUM(citations_count)::int AS citations
        FROM public.brand_metrics_weekly
        WHERE ${weeklyConditions.join(' AND ')}
        GROUP BY 1
        ORDER BY 1
      `;

      // Query 2: Weekly competitor data from brand_vs_competitors
      // Pre-aggregate totals and sort by activity for sensible default order
      const weeklyCompetitorQuery = `
        WITH competitor_totals AS (
          SELECT
            competitor,
            SUM(mentions)::int AS total_mentions,
            SUM(citations)::int AS total_citations
          FROM public.brand_vs_competitors
          WHERE ${competitorFilters.conditions.join(' AND ')}
          GROUP BY competitor
        ),
        weekly_competitors AS (
          SELECT
            TO_CHAR(date, 'IYYY-"W"IW') AS week,
            competitor,
            SUM(mentions)::int AS mentions,
            SUM(citations)::int AS citations
          FROM public.brand_vs_competitors
          WHERE ${competitorFilters.conditions.join(' AND ')}
          GROUP BY 1, 2
        )
        SELECT 
          w.week,
          w.competitor,
          w.mentions,
          w.citations,
          t.total_mentions + t.total_citations AS total_activity
        FROM weekly_competitors w
        JOIN competitor_totals t ON w.competitor = t.competitor
        ORDER BY t.total_mentions + t.total_citations DESC, w.week
      `;

      // Query 3: Share of Voice per Topic from brand_metrics_weekly
      // Optimized: Uses pre-aggregated data
      const shareOfVoiceQuery = `
        SELECT
          COALESCE(topics, 'Unknown') AS topic,
          SUM(mentions_count)::int AS brand_mentions,
          SUM(prompt_count)::int AS total_prompts,
          STRING_AGG(competitors, ';') AS all_competitors
        FROM public.brand_metrics_weekly
        WHERE ${weeklyConditions.join(' AND ')}
        GROUP BY 1
        ORDER BY 2 DESC
      `;

      // Helper to time a promise
      const timePromise = async (promise, name) => {
        const start = Date.now();
        const result = await promise;
        log.warn(`[COMPETITOR-COMPARISON] ${name} took ${Date.now() - start}ms`);
        return result;
      };

      // Execute all 3 queries in parallel with individual timing
      const [
        weeklyBrandResult,
        weeklyCompetitorResult,
        shareOfVoiceResult,
      ] = await Promise.all([
        timePromise(aurora.query(weeklyBrandQuery, weeklyParams), 'Query 1 (Brand Weekly)'),
        timePromise(aurora.query(weeklyCompetitorQuery, competitorFilters.params), 'Query 2 (Competitor)'),
        timePromise(aurora.query(shareOfVoiceQuery, weeklyParams), 'Query 3 (SOV)'),
      ]);

      const queryDuration = Date.now() - queryStart;

      // Merge weekly brand and competitor data
      const weeklyTrends = mergeWeeklyData(weeklyBrandResult, weeklyCompetitorResult);

      // Calculate share of voice
      const shareOfVoice = calculateShareOfVoice(shareOfVoiceResult);

      log.info(`[COMPETITOR-COMPARISON] Data retrieved for siteId: ${siteId} - weeks: ${weeklyTrends.length}, topics: ${shareOfVoice.length}, queryDuration: ${queryDuration}ms`);

      const totalDuration = Date.now() - startTime;
      log.info(`[COMPETITOR-COMPARISON] Request completed for siteId: ${siteId} - total duration: ${totalDuration}ms`);

      return ok({
        siteId,
        weeklyTrends,
        shareOfVoice,
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
      log.error(`[COMPETITOR-COMPARISON] Database query failed for siteId: ${siteId} - error: ${dbError.message}`);
      return badRequest(`Failed to fetch competitor comparison data: ${dbError.message}`);
    }
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    log.error(`[COMPETITOR-COMPARISON] Request failed for siteId: ${siteId} - duration: ${totalDuration}ms, error: ${error.message}`);
    return badRequest(error.message);
  }
}
