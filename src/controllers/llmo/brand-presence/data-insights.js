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

// Helper to build WHERE clause from filters
// Optional tableAlias parameter to prefix column names (e.g., 'bp' -> 'bp.site_id')
const buildBrandPresenceWhereClause = (params, siteId, tableAlias = '') => {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const conditions = [`${prefix}site_id = $1`];
  const values = [siteId];
  let paramIndex = 2;

  if (params.startDate) {
    conditions.push(`${prefix}date >= $${paramIndex}`);
    values.push(params.startDate);
    paramIndex += 1;
  }
  if (params.endDate) {
    conditions.push(`${prefix}date <= $${paramIndex}`);
    values.push(params.endDate);
    paramIndex += 1;
  }
  if (params.model && params.model !== 'all') {
    conditions.push(`${prefix}model = $${paramIndex}`);
    values.push(params.model);
    paramIndex += 1;
  }
  if (params.category && params.category !== 'all') {
    conditions.push(`${prefix}category = $${paramIndex}`);
    values.push(params.category);
    paramIndex += 1;
  }
  if (params.region && params.region !== 'all') {
    conditions.push(`${prefix}region = $${paramIndex}`);
    values.push(params.region);
    paramIndex += 1;
  }
  if (params.origin && params.origin !== 'all') {
    conditions.push(`${prefix}origin = $${paramIndex}`);
    values.push(params.origin);
    paramIndex += 1;
  }

  return { whereClause: conditions.join(' AND '), values, paramIndex };
};

// Valid sort columns for topics
const VALID_TOPIC_SORT_COLUMNS = {
  topics: 'topics',
  visibility: 'visibility',
  mentions: 'mentions',
  sentiment: 'sentiment',
  position: 'position',
  sources: 'sources',
  volume: 'volume',
  executions: 'executions',
  citations: 'citations',
};

// Valid sort columns for prompts
const VALID_PROMPT_SORT_COLUMNS = {
  prompt: 'prompt',
  region: 'region',
  origin: 'origin',
  category: 'category',
  executions: 'executions',
  mentions: 'mentions',
  citations: 'citations',
  visibility: 'visibility',
  sentiment: 'sentiment',
  position: 'position',
  sources: 'sources',
};

/**
 * GET /sites/:siteId/llmo/brand-presence/topics
 * Returns paginated, filtered, sorted list of topics from brand_presence_topics_by_date view
 *
 * Query parameters:
 * - startDate: Start date for filtering (YYYY-MM-DD)
 * - endDate: End date for filtering (YYYY-MM-DD)
 * - model: Platform/model filter (e.g., 'chatgpt', 'gemini')
 * - category: Category filter
 * - region: Region filter
 * - origin: Origin filter
 * - sortBy: Column to sort by (default: 'mentions')
 * - sortOrder: 'asc' or 'desc' (default: 'asc')
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 25)
 *
 * @param {object} context - The request context
 * @param {Function} getSiteAndValidateLlmo - Function to validate site and LLMO access
 * @returns {Promise<Response>} The response with topics data
 */
export async function getBrandPresenceTopics(context, getSiteAndValidateLlmo) {
  const { log, env, aurora } = context;
  const { siteId } = context.params;
  const startTime = Date.now();

  log.info(`[BRAND-PRESENCE-TOPICS] Starting request for siteId: ${siteId}`);

  try {
    // Validate LLMO access
    log.info(`[BRAND-PRESENCE-TOPICS] Validating LLMO access for siteId: ${siteId}`);
    const validationStart = Date.now();
    await getSiteAndValidateLlmo(context);
    const validationDuration = Date.now() - validationStart;
    log.info(`[BRAND-PRESENCE-TOPICS] LLMO access validation completed for siteId: ${siteId} - duration: ${validationDuration}ms`);

    if (!aurora || !env.ENABLE_AURORA_QUERIES) {
      return badRequest('Aurora database is not configured or queries are not enabled');
    }

    // Extract query parameters
    const {
      startDate,
      endDate,
      model,
      category,
      region,
      origin,
      sortBy = 'mentions',
      sortOrder = 'asc',
      page = 1,
      pageSize = 25,
    } = context.data || {};

    // Validate sort column
    const sortColumn = VALID_TOPIC_SORT_COLUMNS[sortBy] || 'mentions';
    const sortDirection = sortOrder.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const filterParams = {
      startDate, endDate, model, category, region, origin,
    };

    // Build WHERE clause for materialized view (no table alias)
    const { whereClause, values, paramIndex } = buildBrandPresenceWhereClause(
      filterParams,
      siteId,
    );

    // Build WHERE clause for raw brand_presence table (with 'bp' alias)
    const { whereClause: rawWhereClause } = buildBrandPresenceWhereClause(
      filterParams,
      siteId,
      'bp',
    );

    // Calculate offset
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);

    // Count query for pagination (same for both strategies)
    const countQuery = `
      SELECT COUNT(DISTINCT topics) AS total
      FROM brand_presence_topics_by_date
      WHERE ${whereClause}
    `;

    const queryStart = Date.now();
    let topicsResult;
    let countResult;

    // Use different query strategies based on sort column
    // When sorting by 'sources', we need to scan all topics to determine sort order
    // For all other columns, we can optimize by first determining paginated topics,
    // then only calculating sources for those specific topics (~40x fewer rows scanned)
    if (sortColumn === 'sources') {
      // FULL SCAN STRATEGY: Required when sorting by sources
      // Must calculate source counts for ALL topics to determine sort order
      log.info('[BRAND-PRESENCE-TOPICS] Using full-scan strategy (sorting by sources)');

      const topicsQuery = `
        WITH topic_metrics AS (
          SELECT
            topics,
            ROUND(AVG(avg_visibility_score)) AS visibility,
            SUM(mentions_count) AS mentions,
            CASE
              WHEN SUM(sentiment_positive) + SUM(sentiment_neutral) + SUM(sentiment_negative) = 0 THEN 'N/A'
              WHEN (
                SUM(sentiment_positive) * 100 + SUM(sentiment_neutral) * 50
              )::NUMERIC / (
                SUM(sentiment_positive) + SUM(sentiment_neutral) + SUM(sentiment_negative)
              ) < 40 THEN 'Negative'
              WHEN (
                SUM(sentiment_positive) * 100 + SUM(sentiment_neutral) * 50
              )::NUMERIC / (
                SUM(sentiment_positive) + SUM(sentiment_neutral) + SUM(sentiment_negative)
              ) <= 65 THEN 'Neutral'
              ELSE 'Positive'
            END AS sentiment,
            ROUND(AVG(avg_position), 2) AS position,
            AVG(avg_volume) AS volume,
            SUM(executions_count) AS executions,
            SUM(citations_count) AS citations,
            COUNT(DISTINCT category) AS category_count,
            COUNT(DISTINCT region) AS region_count
          FROM brand_presence_topics_by_date
          WHERE ${whereClause}
          GROUP BY topics
        ),
        source_counts AS (
          SELECT
            bp.topics,
            COUNT(DISTINCT bps.url) AS sources
          FROM brand_presence bp
          JOIN brand_presence_sources bps ON bp.id = bps.brand_presence_id
          WHERE ${rawWhereClause}
          GROUP BY bp.topics
        )
        SELECT
          tm.topics,
          tm.visibility,
          tm.mentions,
          tm.sentiment,
          tm.position,
          COALESCE(sc.sources, 0) AS sources,
          tm.volume,
          tm.executions,
          tm.citations,
          tm.category_count,
          tm.region_count
        FROM topic_metrics tm
        LEFT JOIN source_counts sc ON tm.topics = sc.topics
        ORDER BY sources ${sortDirection} NULLS LAST
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      [topicsResult, countResult] = await Promise.all([
        aurora.query(topicsQuery, [...values, parseInt(pageSize, 10), offset]),
        aurora.query(countQuery, values),
      ]);
    } else {
      // OPTIMIZED STRATEGY: First get paginated topics, then only calculate sources for those
      // This dramatically reduces the rows scanned in brand_presence/brand_presence_sources
      log.info(`[BRAND-PRESENCE-TOPICS] Using optimized strategy (sorting by ${sortColumn})`);

      const topicsQuery = `
        WITH paginated_topics AS (
          -- First: determine which topics will be on this page (from materialized view - fast)
          SELECT
            topics,
            ROUND(AVG(avg_visibility_score)) AS visibility,
            SUM(mentions_count) AS mentions,
            CASE
              WHEN SUM(sentiment_positive) + SUM(sentiment_neutral) + SUM(sentiment_negative) = 0 THEN 'N/A'
              WHEN (
                SUM(sentiment_positive) * 100 + SUM(sentiment_neutral) * 50
              )::NUMERIC / (
                SUM(sentiment_positive) + SUM(sentiment_neutral) + SUM(sentiment_negative)
              ) < 40 THEN 'Negative'
              WHEN (
                SUM(sentiment_positive) * 100 + SUM(sentiment_neutral) * 50
              )::NUMERIC / (
                SUM(sentiment_positive) + SUM(sentiment_neutral) + SUM(sentiment_negative)
              ) <= 65 THEN 'Neutral'
              ELSE 'Positive'
            END AS sentiment,
            ROUND(AVG(avg_position), 2) AS position,
            AVG(avg_volume) AS volume,
            SUM(executions_count) AS executions,
            SUM(citations_count) AS citations,
            COUNT(DISTINCT category) AS category_count,
            COUNT(DISTINCT region) AS region_count
          FROM brand_presence_topics_by_date
          WHERE ${whereClause}
          GROUP BY topics
          ORDER BY ${sortColumn === 'topics' ? 'topics' : sortColumn} ${sortDirection} NULLS LAST
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        ),
        source_counts AS (
          -- Only calculate sources for the topics on this page (optimized)
          SELECT
            bp.topics,
            COUNT(DISTINCT bps.url) AS sources
          FROM brand_presence bp
          JOIN brand_presence_sources bps ON bp.id = bps.brand_presence_id
          WHERE ${rawWhereClause}
            AND bp.topics IN (SELECT topics FROM paginated_topics)
          GROUP BY bp.topics
        )
        SELECT
          pt.topics,
          pt.visibility,
          pt.mentions,
          pt.sentiment,
          pt.position,
          COALESCE(sc.sources, 0) AS sources,
          pt.volume,
          pt.executions,
          pt.citations,
          pt.category_count,
          pt.region_count
        FROM paginated_topics pt
        LEFT JOIN source_counts sc ON pt.topics = sc.topics
        ORDER BY ${sortColumn === 'topics' ? 'pt.topics' : sortColumn} ${sortDirection} NULLS LAST
      `;

      [topicsResult, countResult] = await Promise.all([
        aurora.query(topicsQuery, [...values, parseInt(pageSize, 10), offset]),
        aurora.query(countQuery, values),
      ]);
    }

    const queryDuration = Date.now() - queryStart;
    const totalItems = parseInt(countResult[0]?.total || 0, 10);
    const totalPages = Math.ceil(totalItems / parseInt(pageSize, 10));

    log.info(`[BRAND-PRESENCE-TOPICS] Query completed for siteId: ${siteId} - ${topicsResult.length} topics, total: ${totalItems}, duration: ${queryDuration}ms`);

    return ok({
      siteId,
      topics: topicsResult.map((row) => ({
        topic: row.topics,
        visibility: parseFloat(row.visibility) || 0,
        mentions: parseInt(row.mentions, 10) || 0,
        sentiment: row.sentiment,
        position: parseFloat(row.position) || 0,
        sources: parseInt(row.sources, 10) || 0,
        volume: parseFloat(row.volume) || 0,
        executions: parseInt(row.executions, 10) || 0,
        citations: parseInt(row.citations, 10) || 0,
      })),
      pagination: {
        page: parseInt(page, 10),
        pageSize: parseInt(pageSize, 10),
        totalItems,
        totalPages,
      },
      filters: {
        startDate, endDate, model, category, region, origin,
      },
      sort: {
        sortBy: sortColumn,
        sortOrder: sortDirection.toLowerCase(),
      },
      performance: {
        totalDuration: Date.now() - startTime,
        queryDuration,
      },
    }, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'x-api-key, authorization, content-type',
    });
  } catch (error) {
    log.error(`[BRAND-PRESENCE-TOPICS] Request failed for siteId: ${siteId} - error: ${error.message}`);
    return badRequest(error.message);
  }
}

/**
 * GET /sites/:siteId/llmo/brand-presence/topics/:topic/prompts
 * Returns all prompts for a specific topic (when user expands a topic row)
 *
 * Query parameters:
 * - startDate, endDate, model, category, region, origin: Same filters as topics endpoint
 * - sortBy: Column to sort by (default: 'mentions')
 *   Valid columns: prompt, region, origin, category, executions, mentions, citations,
 *                  visibility, sentiment, position, sources
 * - sortOrder: 'asc' or 'desc' (default: 'desc')
 * - q: Optional search query to filter prompts (searches in prompt text)
 *
 * @param {object} context - The request context
 * @param {Function} getSiteAndValidateLlmo - Function to validate site and LLMO access
 * @returns {Promise<Response>} The response with prompts data
 */
export async function getBrandPresencePrompts(context, getSiteAndValidateLlmo) {
  const { log, env, aurora } = context;
  const { siteId, topic } = context.params;
  const startTime = Date.now();

  log.info(`[BRAND-PRESENCE-PROMPTS] Starting request for siteId: ${siteId}, topic: ${topic}`);

  try {
    await getSiteAndValidateLlmo(context);

    if (!aurora || !env.ENABLE_AURORA_QUERIES) {
      return badRequest('Aurora database is not configured or queries are not enabled');
    }

    const {
      startDate,
      endDate,
      model,
      category,
      region,
      origin,
      sortBy = 'mentions',
      sortOrder = 'desc',
      q: searchQuery,
    } = context.data || {};

    // Validate sort column
    const sortColumn = VALID_PROMPT_SORT_COLUMNS[sortBy] || 'mentions';
    const sortDirection = sortOrder.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const filterParams = {
      startDate, endDate, model, category, region, origin,
    };

    // Build WHERE clause for materialized view (no table alias)
    const { whereClause, values, paramIndex } = buildBrandPresenceWhereClause(
      filterParams,
      siteId,
    );

    // Build WHERE clause for raw brand_presence table (with 'bp' alias)
    const { whereClause: rawWhereClause } = buildBrandPresenceWhereClause(
      filterParams,
      siteId,
      'bp',
    );

    // Decode the topic (it's URL-encoded)
    const decodedTopic = decodeURIComponent(topic);

    // Build search condition if search query is provided
    let searchCondition = '';
    let rawSearchCondition = '';
    let currentParamIndex = paramIndex;
    const queryParams = [...values, decodedTopic];
    currentParamIndex += 1;

    if (searchQuery && searchQuery.trim().length >= 2) {
      const searchPattern = `%${searchQuery.trim().toLowerCase()}%`;
      searchCondition = ` AND LOWER(prompt) LIKE $${currentParamIndex}`;
      rawSearchCondition = ` AND LOWER(bp.prompt) LIKE $${currentParamIndex}`;
      queryParams.push(searchPattern);
      currentParamIndex += 1;
    }

    // Query prompts from the prompts view with separate source count from raw tables
    // Sentiment is calculated using avg_sentiment_score converted to 0-100 scale:
    // (avg_sentiment_score + 1) * 50, then apply same thresholds as topics endpoint
    const promptsQuery = `
      WITH prompt_metrics AS (
        SELECT
          prompt,
          region,
          origin,
          category,
          SUM(executions_count) AS executions,
          SUM(mentions_count) AS mentions,
          SUM(citations_count) AS citations,
          ROUND(AVG(avg_visibility_score), 2) AS visibility,
          CASE
            WHEN AVG(avg_sentiment_score) IS NULL THEN 'N/A'
            WHEN (AVG(avg_sentiment_score) + 1) * 50 < 40 THEN 'Negative'
            WHEN (AVG(avg_sentiment_score) + 1) * 50 <= 65 THEN 'Neutral'
            ELSE 'Positive'
          END AS sentiment,
          ROUND(AVG(avg_position), 2) AS position,
          MAX(latest_answer) AS answer
        FROM brand_presence_prompts_by_date
        WHERE ${whereClause} AND topics = $${paramIndex}${searchCondition}
        GROUP BY prompt, region, origin, category
      ),
      source_counts AS (
        SELECT
          bp.prompt,
          bp.region,
          bp.origin,
          bp.category,
          COUNT(DISTINCT bps.url) AS sources
        FROM brand_presence bp
        JOIN brand_presence_sources bps ON bp.id = bps.brand_presence_id
        WHERE ${rawWhereClause} AND bp.topics = $${paramIndex}${rawSearchCondition}
        GROUP BY bp.prompt, bp.region, bp.origin, bp.category
      )
      SELECT
        pm.prompt,
        pm.region,
        pm.origin,
        pm.category,
        pm.executions,
        pm.mentions,
        pm.citations,
        pm.visibility,
        pm.sentiment,
        pm.position,
        COALESCE(sc.sources, 0) AS sources,
        pm.answer
      FROM prompt_metrics pm
      LEFT JOIN source_counts sc ON pm.prompt = sc.prompt AND pm.region = sc.region AND pm.origin = sc.origin AND pm.category = sc.category
      ORDER BY ${sortColumn === 'prompt' ? 'pm.prompt' : sortColumn} ${sortDirection} NULLS LAST
    `;

    const queryStart = Date.now();
    log.info(`[BRAND-PRESENCE-PROMPTS] Executing query for siteId: ${siteId}, topic: ${topic}${searchQuery ? `, search: ${searchQuery}` : ''} - query: ${promptsQuery.replace(/\s+/g, ' ').trim()}, params: ${JSON.stringify(queryParams)}`);
    const promptsResult = await aurora.query(promptsQuery, queryParams);
    const queryDuration = Date.now() - queryStart;

    log.info(`[BRAND-PRESENCE-PROMPTS] Query completed for siteId: ${siteId}, topic: ${topic} - ${promptsResult.length} prompts, duration: ${queryDuration}ms`);

    return ok({
      siteId,
      topic: decodedTopic,
      searchQuery: searchQuery || null,
      prompts: promptsResult.map((row) => ({
        prompt: row.prompt,
        region: row.region,
        origin: row.origin,
        category: row.category,
        executions: parseInt(row.executions, 10) || 0,
        mentions: parseInt(row.mentions, 10) || 0,
        citations: parseInt(row.citations, 10) || 0,
        visibility: parseFloat(row.visibility) || 0,
        sentiment: row.sentiment || 'N/A',
        position: parseFloat(row.position) || 0,
        sources: parseInt(row.sources, 10) || 0,
        answer: row.answer || '',
      })),
      totalPrompts: promptsResult.length,
      filters: {
        startDate, endDate, model, category, region, origin,
      },
      sort: {
        sortBy: sortColumn,
        sortOrder: sortDirection.toLowerCase(),
      },
      performance: {
        totalDuration: Date.now() - startTime,
        queryDuration,
      },
    }, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'x-api-key, authorization, content-type',
    });
  } catch (error) {
    log.error(`[BRAND-PRESENCE-PROMPTS] Request failed for siteId: ${siteId}, topic: ${topic} - error: ${error.message}`);
    return badRequest(error.message);
  }
}

/**
 * GET /sites/:siteId/llmo/brand-presence/search
 * Search for topics and prompts matching a search term
 *
 * Query parameters:
 * - q: Search query (searches in topics and prompt columns)
 * - startDate, endDate, model, category, region, origin: Same filters as topics endpoint
 * - page, pageSize: Pagination
 *
 * @param {object} context - The request context
 * @param {Function} getSiteAndValidateLlmo - Function to validate site and LLMO access
 * @returns {Promise<Response>} The response with search results
 */
export async function searchBrandPresence(context, getSiteAndValidateLlmo) {
  const { log, env, aurora } = context;
  const { siteId } = context.params;
  const startTime = Date.now();

  log.info(`[BRAND-PRESENCE-SEARCH] Starting request for siteId: ${siteId}`);

  try {
    await getSiteAndValidateLlmo(context);

    if (!aurora || !env.ENABLE_AURORA_QUERIES) {
      return badRequest('Aurora database is not configured or queries are not enabled');
    }

    const {
      q: searchQuery,
      startDate,
      endDate,
      model,
      category,
      region,
      origin,
      page = 1,
      pageSize = 25,
    } = context.data || {};

    if (!searchQuery || searchQuery.trim().length < 2) {
      return badRequest('Search query must be at least 2 characters');
    }

    const filterParams = {
      startDate, endDate, model, category, region, origin,
    };

    // Build WHERE clause for materialized view (no table alias)
    const { whereClause, values, paramIndex } = buildBrandPresenceWhereClause(
      filterParams,
      siteId,
    );

    // Build WHERE clause for raw brand_presence table (with 'bp' alias)
    const { whereClause: rawWhereClause } = buildBrandPresenceWhereClause(
      filterParams,
      siteId,
      'bp',
    );

    const searchPattern = `%${searchQuery.trim().toLowerCase()}%`;
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);

    // Search in both topics and prompts, return topics that match
    // Uses CTE to calculate true unique source counts from raw tables
    const searchQuerySql = `
      WITH topic_metrics AS (
        SELECT
          topics,
          ROUND(AVG(avg_visibility_score)) AS visibility,
          SUM(mentions_count) AS mentions,
          CASE
            WHEN SUM(sentiment_positive) + SUM(sentiment_neutral) + SUM(sentiment_negative) = 0 THEN 'N/A'
            WHEN (
              SUM(sentiment_positive) * 100 + SUM(sentiment_neutral) * 50
            )::NUMERIC / (
              SUM(sentiment_positive) + SUM(sentiment_neutral) + SUM(sentiment_negative)
            ) < 40 THEN 'Negative'
            WHEN (
              SUM(sentiment_positive) * 100 + SUM(sentiment_neutral) * 50
            )::NUMERIC / (
              SUM(sentiment_positive) + SUM(sentiment_neutral) + SUM(sentiment_negative)
            ) <= 65 THEN 'Neutral'
            ELSE 'Positive'
          END AS sentiment,
          ROUND(AVG(avg_position), 2) AS position,
          AVG(avg_volume) AS volume,
          SUM(executions_count) AS executions,
          SUM(citations_count) AS citations,
          BOOL_OR(LOWER(topics) LIKE $${paramIndex}) AS topic_match,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM brand_presence_prompts_by_date p
            WHERE p.topics = brand_presence_topics_by_date.topics
              AND p.site_id = brand_presence_topics_by_date.site_id
              AND LOWER(p.prompt) LIKE $${paramIndex}
          )) > 0 AS has_prompt_match
        FROM brand_presence_topics_by_date
        WHERE ${whereClause}
          AND (LOWER(topics) LIKE $${paramIndex} OR EXISTS (
            SELECT 1 FROM brand_presence_prompts_by_date p
            WHERE p.topics = brand_presence_topics_by_date.topics
              AND p.site_id = brand_presence_topics_by_date.site_id
              AND LOWER(p.prompt) LIKE $${paramIndex}
          ))
        GROUP BY topics
      ),
      source_counts AS (
        SELECT
          bp.topics,
          COUNT(DISTINCT bps.url) AS sources
        FROM brand_presence bp
        JOIN brand_presence_sources bps ON bp.id = bps.brand_presence_id
        WHERE ${rawWhereClause}
        GROUP BY bp.topics
      )
      SELECT
        tm.topics,
        tm.visibility,
        tm.mentions,
        tm.sentiment,
        tm.position,
        COALESCE(sc.sources, 0) AS sources,
        tm.volume,
        tm.executions,
        tm.citations,
        tm.topic_match,
        tm.has_prompt_match
      FROM topic_metrics tm
      LEFT JOIN source_counts sc ON tm.topics = sc.topics
      ORDER BY tm.mentions DESC
      LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}
    `;

    // Count query
    const countQuerySql = `
      SELECT COUNT(DISTINCT topics) AS total
      FROM brand_presence_topics_by_date
      WHERE ${whereClause}
        AND (LOWER(topics) LIKE $${paramIndex} OR EXISTS (
          SELECT 1 FROM brand_presence_prompts_by_date p
          WHERE p.topics = brand_presence_topics_by_date.topics
            AND p.site_id = brand_presence_topics_by_date.site_id
            AND LOWER(p.prompt) LIKE $${paramIndex}
        ))
    `;

    log.info(`[BRAND-PRESENCE-SEARCH] Executing query: ${searchQuerySql}, params: ${JSON.stringify([...values, searchPattern, parseInt(pageSize, 10), offset])}`);

    const queryStart = Date.now();

    const [searchResult, countResult] = await Promise.all([
      aurora.query(searchQuerySql, [...values, searchPattern, parseInt(pageSize, 10), offset]),
      aurora.query(countQuerySql, [...values, searchPattern]),
    ]);

    const queryDuration = Date.now() - queryStart;
    const totalItems = parseInt(countResult[0]?.total || 0, 10);
    const totalPages = Math.ceil(totalItems / parseInt(pageSize, 10));

    log.info(`[BRAND-PRESENCE-SEARCH] Query completed for siteId: ${siteId}, query: "${searchQuery}" - ${searchResult.length} results, total: ${totalItems}, duration: ${queryDuration}ms`);

    return ok({
      siteId,
      searchQuery,
      topics: searchResult.map((row) => ({
        topic: row.topics,
        visibility: parseFloat(row.visibility) || 0,
        mentions: parseInt(row.mentions, 10) || 0,
        sentiment: row.sentiment,
        position: parseFloat(row.position) || 0,
        sources: parseInt(row.sources, 10) || 0,
        volume: parseFloat(row.volume) || 0,
        executions: parseInt(row.executions, 10) || 0,
        citations: parseInt(row.citations, 10) || 0,
        matchType: row.topic_match ? 'topic' : 'prompt',
      })),
      pagination: {
        page: parseInt(page, 10),
        pageSize: parseInt(pageSize, 10),
        totalItems,
        totalPages,
      },
      filters: {
        startDate, endDate, model, category, region, origin,
      },
      performance: {
        totalDuration: Date.now() - startTime,
        queryDuration,
      },
    }, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'x-api-key, authorization, content-type',
    });
  } catch (error) {
    log.error(`[BRAND-PRESENCE-SEARCH] Request failed for siteId: ${siteId} - error: ${error.message}`);
    return badRequest(error.message);
  }
}
