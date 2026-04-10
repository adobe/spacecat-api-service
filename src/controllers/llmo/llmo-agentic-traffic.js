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
const DEFAULT_BY_URL_LIMIT = 2000;
const MAX_BY_URL_LIMIT = 2000;
const FILTER_DIMENSIONS_PLATFORM_LIMIT = 500;
const FILTER_DIMENSIONS_CONTENT_TYPE_LIMIT = 500;

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
    platform: q.platform || null,
    categoryName: q.categoryName || q.category_name || null,
    agentType: q.agentType || q.agent_type || null,
    userAgent: q.userAgent || q.user_agent || null,
    contentType: q.contentType || q.content_type || null,
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
  };
}

/**
 * Shared wrapper for agentic traffic handlers: PostgREST check + site/org access validation.
 * @param {Object} context - Request context
 * @param {Function} getSiteAndValidateAccess - Async (context) => { site, organization }
 * @param {string} handlerName - For error logging
 * @param {Function} handlerFn - Async (context, client, siteId) => response
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

  try {
    await getSiteAndValidateAccess(context);
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

  return handlerFn(context, Site.postgrestService, siteId);
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
        const rawSortOrder = (ctx.data?.sortOrder || ctx.data?.sort_order || 'desc').toLowerCase();
        const sortOrder = VALID_SORT_ORDERS.has(rawSortOrder) ? rawSortOrder : 'desc';

        const rpcParams = {
          ...buildRpcParams(siteId, parsed),
          p_sort_by: rawSortBy,
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
        const rawSortOrder = (ctx.data?.sortOrder || ctx.data?.sort_order || 'desc').toLowerCase();
        const sortOrder = VALID_SORT_ORDERS.has(rawSortOrder) ? rawSortOrder : 'desc';
        const rawLimit = ctx.data?.limit;
        const parsedLimit = Number.parseInt(String(rawLimit), 10) || DEFAULT_BY_URL_LIMIT;
        const limit = rawLimit != null
          ? Math.min(parsedLimit, MAX_BY_URL_LIMIT)
          : DEFAULT_BY_URL_LIMIT;

        const rpcParams = {
          ...buildRpcParams(siteId, parsed),
          p_limit: limit,
          p_sort_by: rawSortBy,
          p_sort_order: sortOrder,
        };

        const { data, error } = await client.rpc('rpc_agentic_traffic_by_url', rpcParams);
        if (error) {
          ctx.log.error(`Agentic traffic by-url PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic by URL');
        }
        /* c8 ignore next */ return ok((data ?? []).map((row) => ({
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
        })));
      },
    );
  };
}

/**
 * GET /sites/:siteId/agentic-traffic/filter-dimensions
 *
 * Returns distinct filter values for agentic traffic dashboards by combining:
 *  - rpc_agentic_traffic_by_category    → distinct categories
 *  - rpc_agentic_traffic_by_user_agent  → distinct agent types
 *  - agentic_traffic table              → distinct platforms (bounded)
 *  - agentic_url_classifications table  → distinct content types (bounded)
 *
 * All calls are made in parallel.
 */
export function createAgenticTrafficFilterDimensionsHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficFilterDimensions(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'filter-dimensions',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const baseRpcParams = buildRpcParams(siteId, parsed);

        // by_user_agent does not accept p_user_agent
        const userAgentRpcParams = { ...baseRpcParams };
        delete userAgentRpcParams.p_user_agent;

        const [
          categoryResult,
          userAgentResult,
          platformResult,
          contentTypeResult,
        ] = await Promise.all([
          client.rpc('rpc_agentic_traffic_by_category', baseRpcParams),
          client.rpc('rpc_agentic_traffic_by_user_agent', userAgentRpcParams),
          client
            .from('agentic_traffic')
            .select('platform')
            .eq('site_id', siteId)
            .gte('traffic_date', parsed.startDate)
            .lte('traffic_date', parsed.endDate)
            .not('platform', 'is', null)
            .limit(FILTER_DIMENSIONS_PLATFORM_LIMIT),
          client
            .from('agentic_url_classifications')
            .select('content_type')
            .eq('site_id', siteId)
            .not('content_type', 'is', null)
            .neq('content_type', '')
            .limit(FILTER_DIMENSIONS_CONTENT_TYPE_LIMIT),
        ]);

        if (categoryResult.error) {
          ctx.log.error(`Agentic traffic filter-dimensions categories error: ${categoryResult.error.message}`);
        }
        if (userAgentResult.error) {
          ctx.log.error(`Agentic traffic filter-dimensions user-agents error: ${userAgentResult.error.message}`);
        }

        const categories = [...new Set(
          (categoryResult.data || []).map((r) => r.category_name).filter(Boolean),
        )].sort();
        const agentTypes = [...new Set(
          (userAgentResult.data || []).map((r) => r.agent_type).filter(Boolean),
        )].sort();
        const platforms = [...new Set(
          (platformResult.data || []).map((r) => r.platform).filter(Boolean),
        )].sort();
        const contentTypes = [...new Set(
          (contentTypeResult.data || []).map((r) => r.content_type).filter(Boolean),
        )].sort();

        return ok({
          categories,
          agentTypes,
          platforms,
          contentTypes,
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
