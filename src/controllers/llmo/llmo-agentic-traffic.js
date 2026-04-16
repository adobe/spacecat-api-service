/*
 * Copyright 2026 Adobe. All rights reserved.
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
  ok, badRequest, forbidden, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';
import { generateIsoWeekRange, getWeekDateRange } from './llmo-brand-presence.js';

/**
 * Site-scoped agentic traffic handler factories.
 * Queries mysticat-data-service PostgreSQL via PostgREST.
 *
 * All endpoints follow GET /sites/:siteId/agentic-traffic/:resource.
 * Access is validated by checking LLMO product entitlement on the site's organization.
 */

/**
 * Expected error message substrings from getSiteAndValidateAccess.
 * String matching is intentional until a shared error type exists.
 */
const ERR_SITE_ACCESS = 'belonging to the organization';
const ERR_NOT_FOUND = 'not found';

const VALID_INTERVALS = new Set(['day', 'week', 'month']);
const VALID_SORT_ORDERS = new Set(['asc', 'desc']);
// Allowlists mirror the CASE whitelists in the DB RPCs — unknown values are already
// rejected server-side, but we validate here too for defence-in-depth.
const VALID_SORT_COLUMNS_BY_URL = new Set([
  'host', 'url_path', 'total_hits', 'unique_agents',
  'success_rate', 'avg_ttfb_ms', 'category_name',
]);
const VALID_SORT_COLUMNS_BY_USER_AGENT = new Set([
  'page_type', 'agent_type', 'unique_agents', 'total_hits',
]);
const DEFAULT_BY_URL_LIMIT = 50;
const MAX_BY_URL_LIMIT = 500;

/**
 * Maps UI platform filter codes (PLATFORM_CODES) to the values stored in the
 * agentic_traffic.platform column. Both ChatGPT paid/free codes map to the
 * same DB value; 'all' and unknown codes resolve to null (no filter).
 *
 * NOTE: This mapping is applied in parseAgenticTrafficParams and therefore
 * affects ALL site-scoped agentic traffic endpoints (kpis, kpis-trend,
 * by-region, by-category, by-page-type, by-status, by-user-agent, by-url,
 * filter-dimensions, weeks, movers, url-brand-presence). Before this mapping
 * existed, the raw UI code (e.g. "openai") was passed to the DB verbatim,
 * which never matched any rows. This is the intentional behavioural fix.
 */
const PLATFORM_CODE_TO_DB = {
  openai: 'ChatGPT',
  chatgpt: 'ChatGPT',
  anthropic: 'Anthropic',
  mistral: 'MistralAI',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  google: 'Google',
  amazon: 'Amazon',
};

function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 28);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

/**
 * Parse common agentic traffic query params from context.data.
 * Supports camelCase and snake_case aliases.
 */
function parseAgenticTrafficParams(context) {
  const q = context.data || {};
  const defaults = defaultDateRange();
  return {
    startDate: q.startDate || q.start_date || defaults.startDate,
    endDate: q.endDate || q.end_date || defaults.endDate,
    platform: PLATFORM_CODE_TO_DB[q.platform] ?? null,
    categoryName: q.categoryName || q.category_name || null,
    agentType: q.agentType || q.agent_type || null,
    userAgent: q.userAgent || q.user_agent || null,
    contentType: q.contentType || q.content_type || null,
    successRate: q.successRate || q.success_rate || null,
  };
}

/**
 * Build the common RPC params object shared by all agentic traffic RPCs.
 */
function buildRpcParams(siteId, parsed) {
  return {
    p_site_id: siteId,
    p_start_date: parsed.startDate,
    p_end_date: parsed.endDate,
    p_platform: parsed.platform,
    p_category_name: parsed.categoryName,
    p_agent_type: parsed.agentType,
    p_user_agent: parsed.userAgent,
    p_content_type: parsed.contentType,
    p_success_rate: parsed.successRate,
  };
}

/**
 * Shared wrapper for agentic traffic handlers: PostgREST check + site/org access validation.
 * @param {Object} context - Request context
 * @param {Function} getSiteAndValidateAccess - Async (context) => { site, organization }
 * @param {string} handlerName - For error logging
 * @param {Function} handlerFn - Async (context, client, siteId, siteContext) => response
 *   siteContext = { site, organization } — forwarded from getSiteAndValidateAccess so
 *   handlers that need org data (e.g. url-brand-presence) avoid a second DB lookup.
 * @returns {Promise<Response>}
 */
async function withAgenticTrafficAuth(context, getSiteAndValidateAccess, handlerName, handlerFn) {
  const { log, dataAccess } = context;
  const { Site } = dataAccess;

  if (!Site?.postgrestService) {
    log.error('Agentic traffic APIs require PostgREST (DATA_SERVICE_PROVIDER=postgres)');
    return badRequest('Agentic traffic data is not available. PostgreSQL data service is required.');
  }

  const { siteId } = context.params;

  let siteContext;
  try {
    siteContext = await getSiteAndValidateAccess(context);
  } catch (error) {
    if (error.message?.includes(ERR_SITE_ACCESS)) {
      return forbidden('Only users belonging to the organization can view agentic traffic data');
    }
    if (error.message?.includes(ERR_NOT_FOUND)) {
      return badRequest(error.message);
    }
    log.error(`Agentic traffic ${handlerName} access error: ${error.message}`);
    return badRequest(error.message);
  }

  return handlerFn(context, Site.postgrestService, siteId, siteContext);
}

/**
 * POST /rpc/rpc_agentic_traffic_kpis
 * Returns: { total_hits, success_rate, avg_ttfb_ms, avg_citability_score }
 */
export function createAgenticTrafficKpisHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficKpis(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'kpis',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const { data, error } = await client.rpc('rpc_agentic_traffic_kpis', buildRpcParams(siteId, parsed));
        if (error) {
          ctx.log.error(`Agentic traffic kpis PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic KPIs');
        }
        /* c8 ignore next */ const row = (data || [])[0] || {};
        return ok({
          totalHits: Number(row.total_hits ?? 0),
          successRate: row.success_rate !== null && row.success_rate !== undefined
            ? Number(row.success_rate) : null,
          avgTtfbMs: row.avg_ttfb_ms !== null && row.avg_ttfb_ms !== undefined
            ? Number(row.avg_ttfb_ms) : null,
          avgCitabilityScore: row.avg_citability_score !== null
            && row.avg_citability_score !== undefined
            ? Number(row.avg_citability_score) : null,
        });
      },
    );
  };
}

/**
 * POST /rpc/rpc_agentic_traffic_kpis_trend
 * Returns: [{ period_start, total_hits, success_rate, avg_ttfb_ms, avg_citability_score }]
 */
export function createAgenticTrafficKpisTrendHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficKpisTrend(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'kpis-trend',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const rawInterval = (ctx.data?.interval || 'week').toLowerCase();
        const interval = VALID_INTERVALS.has(rawInterval) ? rawInterval : 'week';

        const rpcParams = {
          ...buildRpcParams(siteId, parsed),
          p_interval: interval,
        };
        const { data, error } = await client.rpc('rpc_agentic_traffic_kpis_trend', rpcParams);
        if (error) {
          ctx.log.error(`Agentic traffic kpis-trend PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic KPIs trend');
        }
        /* c8 ignore next */ return ok((data ?? []).map((row) => ({
          periodStart: row.period_start,
          totalHits: Number(row.total_hits ?? 0),
          successRate: row.success_rate !== null && row.success_rate !== undefined
            ? Number(row.success_rate) : null,
          avgTtfbMs: row.avg_ttfb_ms !== null && row.avg_ttfb_ms !== undefined
            ? Number(row.avg_ttfb_ms) : null,
          avgCitabilityScore: row.avg_citability_score !== null
            && row.avg_citability_score !== undefined
            ? Number(row.avg_citability_score) : null,
        })));
      },
    );
  };
}

/**
 * POST /rpc/rpc_agentic_traffic_by_region
 * Returns: [{ region, total_hits }]
 */
export function createAgenticTrafficByRegionHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficByRegion(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-region',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const { data, error } = await client.rpc(
          'rpc_agentic_traffic_by_region',
          buildRpcParams(siteId, parsed),
        );
        if (error) {
          ctx.log.error(`Agentic traffic by-region PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic by region');
        }
        /* c8 ignore next */ return ok((data ?? []).map((row) => ({
          region: row.region || '',
          totalHits: Number(row.total_hits ?? 0),
        })));
      },
    );
  };
}

/**
 * POST /rpc/rpc_agentic_traffic_by_category
 * Returns: [{ category_name, total_hits }]
 */
export function createAgenticTrafficByCategoryHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficByCategory(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-category',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        // rpc_agentic_traffic_by_category has no p_category_name parameter —
        // it groups by category, so filtering by it is not supported.
        const rpcParams = buildRpcParams(siteId, parsed);
        delete rpcParams.p_category_name;
        const { data, error } = await client.rpc(
          'rpc_agentic_traffic_by_category',
          rpcParams,
        );
        if (error) {
          ctx.log.error(`Agentic traffic by-category PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic by category');
        }
        /* c8 ignore next */ return ok((data ?? []).map((row) => ({
          categoryName: row.category_name || 'Uncategorized',
          totalHits: Number(row.total_hits ?? 0),
        })));
      },
    );
  };
}

/**
 * POST /rpc/rpc_agentic_traffic_by_page_type
 * Returns: [{ page_type, total_hits }]
 */
export function createAgenticTrafficByPageTypeHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficByPageType(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-page-type',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const { data, error } = await client.rpc(
          'rpc_agentic_traffic_by_page_type',
          buildRpcParams(siteId, parsed),
        );
        if (error) {
          ctx.log.error(`Agentic traffic by-page-type PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic by page type');
        }
        /* c8 ignore next */ return ok((data ?? []).map((row) => ({
          pageType: row.page_type || 'Other',
          totalHits: Number(row.total_hits ?? 0),
        })));
      },
    );
  };
}

/**
 * POST /rpc/rpc_agentic_traffic_by_status
 * Returns: [{ http_status, total_hits }]
 */
export function createAgenticTrafficByStatusHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficByStatus(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-status',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const { data, error } = await client.rpc(
          'rpc_agentic_traffic_by_status',
          buildRpcParams(siteId, parsed),
        );
        if (error) {
          ctx.log.error(`Agentic traffic by-status PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic by status');
        }
        /* c8 ignore next */ return ok((data ?? []).map((row) => ({
          httpStatus: row.http_status,
          totalHits: Number(row.total_hits ?? 0),
        })));
      },
    );
  };
}

/**
 * POST /rpc/rpc_agentic_traffic_by_user_agent
 * Returns: [{ page_type, agent_type, unique_agents, total_hits }]
 */
export function createAgenticTrafficByUserAgentHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficByUserAgent(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-user-agent',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const rawSortBy = ctx.data?.sortBy || ctx.data?.sort_by || 'total_hits';
        const sortBy = VALID_SORT_COLUMNS_BY_USER_AGENT.has(rawSortBy) ? rawSortBy : 'total_hits';
        const rawSortOrder = (ctx.data?.sortOrder || ctx.data?.sort_order || 'desc').toLowerCase();
        const sortOrder = VALID_SORT_ORDERS.has(rawSortOrder) ? rawSortOrder : 'desc';

        const rpcParams = {
          ...buildRpcParams(siteId, parsed),
          p_sort_by: sortBy,
          p_sort_order: sortOrder,
        };
        // by_user_agent does not accept p_user_agent — remove it
        delete rpcParams.p_user_agent;

        const { data, error } = await client.rpc('rpc_agentic_traffic_by_user_agent', rpcParams);
        if (error) {
          ctx.log.error(`Agentic traffic by-user-agent PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic by user agent');
        }
        /* c8 ignore next */ return ok((data ?? []).map((row) => ({
          pageType: row.page_type || '',
          agentType: row.agent_type || '',
          uniqueAgents: Number(row.unique_agents ?? 0),
          totalHits: Number(row.total_hits ?? 0),
        })));
      },
    );
  };
}

/**
 * POST /rpc/rpc_agentic_traffic_by_url
 * Returns: [{ host, url_path, total_hits, unique_agents, top_agent, top_agent_type,
 *             response_codes, success_rate, avg_ttfb_ms, category_name,
 *             avg_citability_score, deployed_at_edge }]
 */
export function createAgenticTrafficByUrlHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficByUrl(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-url',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const rawSortBy = ctx.data?.sortBy || ctx.data?.sort_by || 'total_hits';
        const sortBy = VALID_SORT_COLUMNS_BY_URL.has(rawSortBy) ? rawSortBy : 'total_hits';
        const rawSortOrder = (ctx.data?.sortOrder || ctx.data?.sort_order || 'desc').toLowerCase();
        const sortOrder = VALID_SORT_ORDERS.has(rawSortOrder) ? rawSortOrder : 'desc';
        // Accept both "pageSize" (documented name) and legacy "limit" alias
        const rawLimit = ctx.data?.pageSize || ctx.data?.page_size || ctx.data?.limit;
        const rawPageOffset = ctx.data?.pageOffset || ctx.data?.page_offset;
        const urlPathSearch = ctx.data?.urlPathSearch || ctx.data?.url_path_search || null;
        const parsedLimit = Number.parseInt(String(rawLimit), 10) || DEFAULT_BY_URL_LIMIT;
        const limit = rawLimit != null
          ? Math.min(parsedLimit, MAX_BY_URL_LIMIT)
          : DEFAULT_BY_URL_LIMIT;
        const pageOffset = rawPageOffset != null
          ? Math.max(Number.parseInt(String(rawPageOffset), 10) || 0, 0)
          : 0;

        const rpcParams = {
          ...buildRpcParams(siteId, parsed),
          p_page_limit: limit,
          p_page_offset: pageOffset,
          p_url_path_search: urlPathSearch,
          p_sort_by: sortBy,
          p_sort_order: sortOrder,
        };

        const { data, error } = await client.rpc('rpc_agentic_traffic_by_url', rpcParams);
        if (error) {
          ctx.log.error(`Agentic traffic by-url PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic by URL');
        }
        /* c8 ignore next */
        const rows = data ?? [];
        // total_count is returned in every row by the RPC; pick it from the first one
        /* c8 ignore next */
        const totalCount = rows.length > 0 ? Number(rows[0].total_count ?? 0) : 0;
        /* c8 ignore next */ return ok({
          totalCount,
          rows: rows.map((row) => ({
            host: row.host || '',
            urlPath: row.url_path || '',
            totalHits: Number(row.total_hits ?? 0),
            uniqueAgents: Number(row.unique_agents ?? 0),
            topAgent: row.top_agent || '',
            topAgentType: row.top_agent_type || '',
            responseCodes: Array.isArray(row.response_codes) ? row.response_codes.map(Number) : [],
            successRate: row.success_rate !== null && row.success_rate !== undefined
              ? Number(row.success_rate) : null,
            avgTtfbMs: row.avg_ttfb_ms !== null && row.avg_ttfb_ms !== undefined
              ? Number(row.avg_ttfb_ms) : null,
            categoryName: row.category_name || '',
            avgCitabilityScore: row.avg_citability_score !== null
              && row.avg_citability_score !== undefined
              ? Number(row.avg_citability_score) : null,
            deployedAtEdge: row.deployed_at_edge ?? false,
          })),
        });
      },
    );
  };
}

/**
 * GET /sites/:siteId/agentic-traffic/filter-dimensions
 *
 * Delegates to rpc_agentic_traffic_distinct_filters, which returns all five
 * filter dimensions in a single round-trip with cascading behaviour: each
 * dimension list respects the other active filters but ignores its own.
 */
export function createAgenticTrafficFilterDimensionsHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficFilterDimensions(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'filter-dimensions',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const { data, error } = await client.rpc(
          'rpc_agentic_traffic_distinct_filters',
          buildRpcParams(siteId, parsed),
        );
        if (error) {
          ctx.log.error(`Agentic traffic filter-dimensions PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic filter dimensions');
        }
        /* c8 ignore next */ const row = (data || [])[0] || {};
        return ok({
          categories: row.categories || [],
          agentTypes: row.agent_types || [],
          platforms: row.platforms || [],
          contentTypes: row.content_types || [],
          userAgents: row.user_agents || [],
        });
      },
    );
  };
}

/**
 * POST /rpc/rpc_agentic_traffic_movers
 * Returns top and bottom URL movers (biggest hits_change between oldest and newest date in range).
 * A single call returns both directions; direction='up' for top movers, 'down' for bottom.
 */
export function createAgenticTrafficMoversHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficMovers(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'movers',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const rawLimit = ctx.data?.limit;
        const limit = rawLimit != null
          ? Math.min(Math.max(Number.parseInt(String(rawLimit), 10) || 5, 1), 50)
          : 5;

        const { data, error } = await client.rpc('rpc_agentic_traffic_movers', {
          ...buildRpcParams(siteId, parsed),
          p_limit: limit,
        });
        if (error) {
          ctx.log.error(`Agentic traffic movers PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic movers');
        }
        /* c8 ignore next */ return ok((data ?? []).map((row) => ({
          host: row.host || '',
          urlPath: row.url_path || '',
          previousHits: Number(row.previous_hits ?? 0),
          currentHits: Number(row.current_hits ?? 0),
          hitsChange: Number(row.hits_change ?? 0),
          changePercent: row.change_percent !== null && row.change_percent !== undefined
            ? Number(row.change_percent) : null,
          direction: row.direction,
        })));
      },
    );
  };
}

/**
 * GET /sites/:siteId/agentic-traffic/weeks
 *
 * Returns the list of ISO weeks for which the site has agentic traffic data.
 * Powers the ContinuousWeekPicker (custom-weeks time range option).
 *
 * Queries agentic_traffic for the min and max traffic_date for the site,
 * then generates the full ISO week range between them.
 *
 * Returns: { weeks: [{ week: "2026-W10", startDate: "...", endDate: "..." }] }
 */
export function createAgenticTrafficWeeksHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficWeeks(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'weeks',
      async (ctx, client, siteId) => {
        const [minResult, maxResult] = await Promise.all([
          client
            .from('agentic_traffic')
            .select('traffic_date')
            .eq('site_id', siteId)
            .order('traffic_date', { ascending: true })
            .limit(1),
          client
            .from('agentic_traffic')
            .select('traffic_date')
            .eq('site_id', siteId)
            .order('traffic_date', { ascending: false })
            .limit(1),
        ]);

        if (minResult.error) {
          ctx.log.error(`Agentic traffic weeks min-date PostgREST error: ${minResult.error.message}`);
          return internalServerError('Failed to fetch agentic traffic date range');
        }
        if (maxResult.error) {
          ctx.log.error(`Agentic traffic weeks max-date PostgREST error: ${maxResult.error.message}`);
          return internalServerError('Failed to fetch agentic traffic date range');
        }

        /* c8 ignore next 2 — data is always an array when error is null */
        const minDate = (minResult.data || [])[0]?.traffic_date;
        const maxDate = (maxResult.data || [])[0]?.traffic_date;

        if (!minDate || !maxDate) {
          return ok({ weeks: [] });
        }

        const weeks = generateIsoWeekRange(minDate, maxDate).map((weekStr) => {
          const range = getWeekDateRange(weekStr);
          // range is non-null for all valid ISO weeks from generateIsoWeekRange
          /* c8 ignore next 4 */
          return {
            week: weekStr,
            startDate: range?.startDate ?? null,
            endDate: range?.endDate ?? null,
          };
        });

        return ok({ weeks });
      },
    );
  };
}

/**
 * GET /sites/:siteId/agentic-traffic/url-brand-presence?url=&startDate=&endDate=&platform=
 *
 * Brand presence citation detail for a specific URL. Returns citation stats,
 * weekly citation trends, and the top prompts that cite this URL as a source
 * in brand presence LLM executions.
 *
 * The URL is resolved via source_urls.url_hash (md5 fast-lookup) so the caller
 * must pass a full URL (e.g. "https://www.example.com/path").
 * The organisation_id is derived from the site to keep auth consistent with all
 * other site-scoped agentic traffic endpoints.
 */
export function createAgenticTrafficUrlBrandPresenceHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficUrlBrandPresence(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'url-brand-presence',
      async (ctx, client, siteId, siteContext) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const rawUrl = ctx.data?.url;

        if (!hasText(rawUrl)) {
          return badRequest('url parameter is required');
        }

        // organisationId comes from siteContext forwarded by withAgenticTrafficAuth —
        // getSiteAndValidateAccess already fetched the site, so no second DB roundtrip.
        const organizationId = siteContext?.site?.getOrganizationId();

        const rpcParams = {
          p_organization_id: organizationId,
          p_url: rawUrl,
          p_start_date: parsed.startDate,
          p_end_date: parsed.endDate,
          p_model: parsed.platform || null,
          p_site_id: siteId,
        };

        const { data, error } = await client.rpc(
          'rpc_brand_presence_url_detail',
          rpcParams,
        );

        if (error) {
          ctx.log.error(`Agentic traffic url-brand-presence PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch brand presence data for URL');
        }

        // RETURNS JSONB → PostgREST delivers the object directly, not wrapped in an array
        /* c8 ignore next */ const result = data ?? {};
        return ok({
          totalCitations: Number(result.totalCitations ?? 0),
          totalMentions: Number(result.totalMentions ?? 0),
          uniquePrompts: Number(result.uniquePrompts ?? 0),
          weeklyTrends: Array.isArray(result.weeklyTrends) ? result.weeklyTrends : [],
          prompts: Array.isArray(result.prompts) ? result.prompts : [],
        });
      },
    );
  };
}
