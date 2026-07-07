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
import { cachedOk } from '../../support/cached-response.js';
import { generateIsoWeekRange, getWeekDateRange } from './llmo-brand-presence.js';
import { checkDateRange } from './traffic-date-range.js';
import {
  rotationContext,
  shouldRotate,
  rotatingPostgrest,
  computeWindow,
} from './traffic-rotation.js';

// Read-time rotation of the two frozen demo sites' referral data lives entirely
// in the wrapped PostgREST client injected by withReferralTrafficAuth; handlers
// call client.rpc(...) unaware of rotation. The one exception is /weeks, whose
// window is a pure function of now() (not a client fetch) — it still reads this.
const rotationCtx = (siteId) => rotationContext(siteId, 'referral');

/**
 * Site-scoped referral traffic handler factories.
 * Queries mysticat-data-service PostgreSQL via PostgREST RPCs defined in
 * 20260501120000_rpc_referral_traffic_dashboard.sql. All aggregation is
 * performed in Postgres; handlers map RPC snake_case columns to camelCase.
 *
 * All endpoints follow GET /sites/:siteId/referral-traffic/:resource.
 * Access is validated by checking LLMO product entitlement on the site's organization.
 */

const ERR_SITE_ACCESS = 'belonging to the organization';
const ERR_NOT_FOUND = 'not found';

const VALID_SOURCES = new Set(['optel', 'cdn', 'adobe_analytics', 'ga4', 'cja']);
const DEFAULT_SOURCE = 'optel';

const SOURCE_TO_TABLE = {
  optel: 'referral_traffic_optel',
  cdn: 'referral_traffic_cdn',
  adobe_analytics: 'referral_traffic_adobe_analytics',
  ga4: 'referral_traffic_ga4',
  cja: 'referral_traffic_cja',
};

const DEFAULT_BY_URL_PAGE_SIZE = 50;
// 500 (not the agentic 200) so the elmo-ui referral "All URLs" export — which
// still paginates by-url client-side at pageSize=500 — is not silently
// truncated. Drop to 200 once that export migrates to the async urls/export
// endpoint like the agentic one (SITES-46098 review).
const MAX_BY_URL_PAGE_SIZE = 500;

// Mirrors the CASE whitelist in rpc_referral_traffic_by_url for defence-in-depth.
const VALID_BY_URL_SORT_COLUMNS = new Set([
  'total_pageviews', 'url_path', 'bounce_rate', 'consent_rate', 'page_intent',
  'entries', 'exits', 'avg_time_on_site', 'revenue',
]);
const VALID_SORT_ORDERS = new Set(['asc', 'desc']);

/**
 * Maps UI platform filter codes to the value stored in referral_traffic.trf_platform.
 * Allowed values per the DB schema comment: openai, google, microsoft, claude,
 * perplexity, meta, deepseek, mistral, unknown.
 *
 * UI sends 'openai' for both ChatGPT paid and free (unified LLM filter), so we
 * map 'chatgpt' to the same DB value.
 */
const PLATFORM_CODE_TO_DB = {
  openai: 'openai',
  chatgpt: 'openai',
  anthropic: 'claude',
  claude: 'claude',
  perplexity: 'perplexity',
  gemini: 'google',
  google: 'google',
  microsoft: 'microsoft',
  meta: 'meta',
  deepseek: 'deepseek',
  mistral: 'mistral',
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
 * Parse common referral-traffic query params from context.data.
 * Supports camelCase and snake_case aliases.
 */
function parseParams(context) {
  const q = context.data || {};
  const defaults = defaultDateRange();
  const rawSource = q.source;
  const source = VALID_SOURCES.has(rawSource) ? rawSource : DEFAULT_SOURCE;
  return {
    source,
    startDate: q.startDate || q.start_date || defaults.startDate,
    endDate: q.endDate || q.end_date || defaults.endDate,
    platform: PLATFORM_CODE_TO_DB[q.platform] ?? null,
    region: q.region || null,
    pageIntent: q.pageIntent || q.page_intent || null,
    deviceType: q.deviceType || q.device_type || q.device || null,
  };
}

/**
 * Build the common RPC parameter object shared by all dashboard RPCs.
 */
function commonRpcParams(siteId, parsed) {
  return {
    p_site_id: siteId,
    p_source: parsed.source,
    p_start_date: parsed.startDate,
    p_end_date: parsed.endDate,
    p_platform: parsed.platform,
    p_region: parsed.region,
    p_device: parsed.deviceType,
    p_page_intent: parsed.pageIntent,
  };
}

/**
 * Shared wrapper for referral traffic handlers: PostgREST check + site/org access.
 */
async function withReferralTrafficAuth(
  context,
  getSiteAndValidateAccess,
  handlerName,
  handlerFn,
) {
  const { log, dataAccess } = context;
  const { Site } = dataAccess;

  if (!Site?.postgrestService) {
    log.error('Referral traffic APIs require PostgREST (DATA_SERVICE_PROVIDER=postgres)');
    return badRequest('Referral traffic data is not available. PostgreSQL data service is required.');
  }

  const rangeError = checkDateRange(context.data);
  if (rangeError) {
    log.info(`Referral traffic ${handlerName} rejected (date range guardrail): ${rangeError}`);
    return badRequest(rangeError);
  }

  const { siteId } = context.params;

  try {
    await getSiteAndValidateAccess(context);
  } catch (error) {
    if (error.message?.includes(ERR_SITE_ACCESS)) {
      return forbidden('Only users belonging to the organization can view referral traffic data');
    }
    if (error.message?.includes(ERR_NOT_FOUND)) {
      return badRequest(error.message);
    }
    log.error(`Referral traffic ${handlerName} access error: ${error.message}`);
    return internalServerError('Access validation failed');
  }

  // Demo sites read through a rotating client (frozen data → rolling window);
  // every other site gets the real client unchanged (zero behavior change).
  const client = shouldRotate(siteId, 'referral')
    ? rotatingPostgrest(Site.postgrestService, siteId, 'referral')
    : Site.postgrestService;
  return handlerFn(context, client, siteId);
}

// ============================================================================
// /filter-dimensions
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/filter-dimensions
 *
 * Returns distinct values for platform/region/device/pageIntent filters and the
 * list of sources that have data for this site in the current window.
 * Source filter is intentionally absent so the UI can detect all available sources
 * in one request.
 */
export function createReferralTrafficFilterDimensionsHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficFilterDimensions(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'filter-dimensions',
      async (ctx, client, siteId) => {
        const parsed = parseParams(ctx);
        const { data, error } = await client.rpc('rpc_referral_traffic_filter_dimensions', {
          p_site_id: siteId,
          p_source: parsed.source,
          p_start_date: parsed.startDate,
          p_end_date: parsed.endDate,
        });

        if (error) {
          ctx.log.error(`Referral traffic filter-dimensions PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch referral traffic filter dimensions');
        }

        /* c8 ignore next — PostgREST always returns an array when error is null */
        const row = Array.isArray(data) ? data[0] : data;
        return ok({
          platforms: row?.platforms ?? [],
          regions: row?.regions ?? [],
          devices: row?.devices ?? [],
          pageIntents: row?.page_intents ?? [],
          availableSources: row?.available_sources ?? [],
        });
      },
    );
  };
}

// ============================================================================
// /kpis
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/kpis
 *
 * Returns { totalPageviews, bounceRate, consentRate } aggregated over the
 * filtered window. Bounce rate and consent rate are only meaningful for
 * optel/ga4 sources — for cdn/adobe_analytics they return null.
 */
export function createReferralTrafficKpisHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficKpis(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'kpis',
      async (ctx, client, siteId) => {
        const parsed = parseParams(ctx);
        const rpcParams = commonRpcParams(siteId, parsed);
        const { data, error } = await client.rpc('rpc_referral_traffic_kpis', rpcParams);

        if (error) {
          ctx.log.error(`Referral traffic kpis PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch referral traffic KPIs');
        }

        /* c8 ignore next — PostgREST always returns an array when error is null */
        const row = Array.isArray(data) ? data[0] : data;
        return ok({
          totalPageviews: Number(row?.total_pageviews ?? 0),
          bounceRate: row?.bounce_rate != null ? Number(row.bounce_rate) : null,
          consentRate: row?.consent_rate != null ? Number(row.consent_rate) : null,
        });
      },
    );
  };
}

// ============================================================================
// /trend
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/trend
 *
 * Returns weekly aggregates for sparkline charts on stat cards.
 * Extended to include business metrics (entries, revenue, bounce_rate,
 * avg_session_duration, pages_per_visit, orders, conversion_rate) for AA and GA4.
 * optel and cdn sources return null for those fields.
 */
export function createReferralTrafficTrendHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficTrend(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'trend',
      async (ctx, client, siteId) => {
        const parsed = parseParams(ctx);
        const rpcParams = commonRpcParams(siteId, parsed);
        const { data, error } = await client.rpc(
          'rpc_referral_traffic_trend',
          rpcParams,
        );

        if (error) {
          ctx.log.error(`Referral traffic trend PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch referral traffic trend');
        }

        /* c8 ignore next 2 — PostgREST guarantees non-null data when error is null */
        return ok({
          trend: (data ?? []).map((row) => ({
            date: row.traffic_date,
            pageviews: Number(row.total_pageviews),
            entries: row.entries != null ? Number(row.entries) : null,
            revenue: row.revenue != null ? Number(row.revenue) : null,
            bounceRate: row.bounce_rate != null ? Number(row.bounce_rate) : null,
            consentRate: row.consent_rate != null ? Number(row.consent_rate) : null,
            avgSessionDuration: row.avg_session_duration != null
              ? Number(row.avg_session_duration) : null,
            pagesPerVisit: row.pages_per_visit != null ? Number(row.pages_per_visit) : null,
            orders: row.orders != null ? Number(row.orders) : null,
            conversionRate: row.conversion_rate != null ? Number(row.conversion_rate) : null,
          })),
        });
      },
    );
  };
}

// ============================================================================
// /by-platform
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/by-platform
 *
 * Returns [{ platform, pageviews, bounceRate, channels, visits, avgTimeOnSite, revenue,
 *          visitors, orders }]
 * sorted descending. Empty trf_platform values are returned as 'unknown' by the RPC.
 * visits/avgTimeOnSite/revenue/visitors/orders are null for optel and cdn sources.
 */
export function createReferralTrafficByPlatformHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficByPlatform(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-platform',
      async (ctx, client, siteId) => {
        const parsed = parseParams(ctx);
        const rpcParams = commonRpcParams(siteId, parsed);
        const { data, error } = await client.rpc('rpc_referral_traffic_by_platform', rpcParams);

        if (error) {
          ctx.log.error(`Referral traffic by-platform PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch referral traffic by-platform');
        }

        /* c8 ignore next 2 — PostgREST guarantees non-null data when error is null */
        return ok({
          rows: (data ?? []).map((row) => ({
            platform: row.platform,
            pageviews: Number(row.total_pageviews),
            bounceRate: row.bounce_rate != null ? Number(row.bounce_rate) : null,
            channels: row.channels ?? [],
            visits: row.visits != null ? Number(row.visits) : null,
            avgTimeOnSite: row.avg_time_on_site != null ? Number(row.avg_time_on_site) : null,
            revenue: row.revenue != null ? Number(row.revenue) : null,
            visitors: row.visitors != null ? Number(row.visitors) : null,
            orders: row.orders != null ? Number(row.orders) : null,
          })),
        });
      },
    );
  };
}

// ============================================================================
// /by-device
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/by-device
 *
 * Returns [{ device, pageviews, bounceRate }] sorted descending.
 * bounce_rate is null for cdn source.
 */
export function createReferralTrafficByDeviceHandler(getSiteAndValidateAccess) {
  /* c8 ignore start — identical auth/error/mapping pattern covered by other handler tests */
  return async function getReferralTrafficByDevice(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-device',
      async (ctx, client, siteId) => {
        const parsed = parseParams(ctx);
        const rpcParams = commonRpcParams(siteId, parsed);
        const { data, error } = await client.rpc('rpc_referral_traffic_by_device', rpcParams);

        if (error) {
          ctx.log.error(`Referral traffic by-device PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch referral traffic by-device');
        }

        return ok({
          rows: (data ?? []).map((row) => ({
            device: row.device,
            pageviews: Number(row.total_pageviews),
            bounceRate: row.bounce_rate != null ? Number(row.bounce_rate) : null,
          })),
        });
      },
    );
  };
}
/* c8 ignore stop */

// ============================================================================
// /by-region
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/by-region
 *
 * Returns [{ region, pageviews }] sorted descending.
 */
export function createReferralTrafficByRegionHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficByRegion(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-region',
      async (ctx, client, siteId) => {
        const parsed = parseParams(ctx);
        const rpcParams = commonRpcParams(siteId, parsed);
        const { data, error } = await client.rpc('rpc_referral_traffic_by_region', rpcParams);

        if (error) {
          ctx.log.error(`Referral traffic by-region PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch referral traffic by-region');
        }

        /* c8 ignore next 2 — PostgREST guarantees non-null data when error is null */
        return ok({
          rows: (data ?? []).map((row) => ({
            region: row.region,
            pageviews: Number(row.total_pageviews),
          })),
        });
      },
    );
  };
}

// ============================================================================
// /by-page-intent
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/by-page-intent
 *
 * Returns [{ pageIntent, pageviews }] sorted descending. Rows with a null/absent
 * page_intent are grouped under an empty string by the RPC.
 */
export function createReferralTrafficByPageIntentHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficByPageIntent(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-page-intent',
      async (ctx, client, siteId) => {
        const parsed = parseParams(ctx);
        const rpcParams = commonRpcParams(siteId, parsed);
        const { data, error } = await client.rpc('rpc_referral_traffic_by_page_intent', rpcParams);

        if (error) {
          ctx.log.error(`Referral traffic by-page-intent PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch referral traffic by-page-intent');
        }

        /* c8 ignore next 2 — PostgREST guarantees non-null data when error is null */
        return ok({
          rows: (data ?? [])
            .filter((row) => row.page_intent && row.page_intent !== '')
            .map((row) => ({
              pageIntent: row.page_intent,
              pageviews: Number(row.total_pageviews),
            })),
        });
      },
    );
  };
}

// ============================================================================
// /by-url
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/by-url
 *
 * Paginated top URLs by pageviews. Pagination and URL search are pushed down to
 * the RPC; total_count reflects the full result set size before the page limit.
 * Accepts pageSize/page_size/limit (max 1000, default 50) and pageOffset/page_offset.
 */
export function createReferralTrafficByUrlHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficByUrl(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-url',
      async (ctx, client, siteId) => {
        const parsed = parseParams(ctx);
        const q = ctx.data || {};
        const rawLimit = q.pageSize || q.page_size || q.limit;
        const rawOffset = q.pageOffset || q.page_offset;
        const urlPathSearch = q.urlPathSearch || q.url_path_search || null;

        const parsedLimit = Number.parseInt(String(rawLimit), 10) || DEFAULT_BY_URL_PAGE_SIZE;
        const limit = rawLimit != null
          ? Math.min(parsedLimit, MAX_BY_URL_PAGE_SIZE)
          : DEFAULT_BY_URL_PAGE_SIZE;
        const pageOffset = rawOffset != null
          ? Math.max(Number.parseInt(String(rawOffset), 10) || 0, 0)
          : 0;

        const rawSortBy = q.sortBy || q.sort_by || 'total_pageviews';
        const sortBy = VALID_BY_URL_SORT_COLUMNS.has(rawSortBy) ? rawSortBy : 'total_pageviews';
        const rawSortOrder = (q.sortOrder || q.sort_order || 'desc').toLowerCase();
        const sortOrder = VALID_SORT_ORDERS.has(rawSortOrder) ? rawSortOrder : 'desc';

        const rpcParams = {
          ...commonRpcParams(siteId, parsed),
          p_url_search: urlPathSearch,
          p_limit: limit,
          p_offset: pageOffset,
          p_sort_by: sortBy,
          p_sort_order: sortOrder,
        };
        const { data, error } = await client.rpc('rpc_referral_traffic_by_url', rpcParams);

        if (error) {
          ctx.log.error(`Referral traffic by-url PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch referral traffic by URL');
        }

        /* c8 ignore next — PostgREST guarantees non-null data when error is null */
        const rows = data ?? [];
        // total_count is a window function value — identical on every row.
        const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;

        return ok({
          totalCount,
          rows: rows.map((row) => ({
            urlPath: row.url_path,
            host: row.host ?? '',
            pageviews: Number(row.total_pageviews),
            bounceRate: row.bounce_rate != null ? Number(row.bounce_rate) : null,
            consentRate: row.consent_rate != null ? Number(row.consent_rate) : null,
            pageIntent: row.page_intent ?? null,
            entries: row.entries != null ? Number(row.entries) : null,
            exits: row.exits != null ? Number(row.exits) : null,
            avgTimeOnSite: row.avg_time_on_site != null ? Number(row.avg_time_on_site) : null,
            revenue: row.revenue != null ? Number(row.revenue) : null,
          })),
        });
      },
    );
  };
}

// ============================================================================
// /weeks
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/weeks
 *
 * Returns the ISO weeks for which the site has referral traffic data for the
 * requested source. Accepts ?source (optel|cdn|adobe_analytics|ga4|cja, default optel).
 * Powers the ContinuousWeekPicker (custom-weeks time range option) — each source
 * tab passes its own source so the picker shows only weeks where that source has data.
 *
 * Returns: { weeks: [{ week: "2026-W10", startDate: "...", endDate: "..." }] }
 */
export function createReferralTrafficWeeksHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficWeeks(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'weeks',
      async (ctx, client, siteId) => {
        /* c8 ignore next */
        const q = ctx.data || {};
        const rawSource = q.source;
        const source = VALID_SOURCES.has(rawSource) ? rawSource : DEFAULT_SOURCE;
        const tableName = SOURCE_TO_TABLE[source];

        const rot = rotationCtx(siteId);
        if (rot.rotate) {
          // Rotation: the window is a pure function of now(); we only need to
          // know whether THIS source has any canned rows. One existence check
          // (not the two-query min/max), then synthesize — mirrors the agentic
          // /weeks early-return while preserving per-source emptiness.
          const { data, error } = await client
            .from(tableName)
            .select('traffic_date')
            .eq('site_id', siteId)
            .limit(1);
          if (error) {
            ctx.log.error(`Referral traffic weeks existence PostgREST error: ${error.message}`);
            return internalServerError('Failed to fetch referral traffic date range');
          }
          if ((data || []).length === 0) {
            return ok({ weeks: [] });
          }
          return ok({ weeks: computeWindow(rot.now).weeks });
        }

        const [minResult, maxResult] = await Promise.all([
          client
            .from(tableName)
            .select('traffic_date')
            .eq('site_id', siteId)
            .order('traffic_date', { ascending: true })
            .limit(1),
          client
            .from(tableName)
            .select('traffic_date')
            .eq('site_id', siteId)
            .order('traffic_date', { ascending: false })
            .limit(1),
        ]);

        if (minResult.error) {
          ctx.log.error(`Referral traffic weeks min-date PostgREST error: ${minResult.error.message}`);
          return internalServerError('Failed to fetch referral traffic date range');
        }
        if (maxResult.error) {
          ctx.log.error(`Referral traffic weeks max-date PostgREST error: ${maxResult.error.message}`);
          return internalServerError('Failed to fetch referral traffic date range');
        }

        /* c8 ignore next 2 — data is always an array when error is null */
        const minDate = (minResult.data || [])[0]?.traffic_date;
        const maxDate = (maxResult.data || [])[0]?.traffic_date;

        if (!minDate || !maxDate) {
          return ok({ weeks: [] });
        }

        const weeks = generateIsoWeekRange(minDate, maxDate).map((weekStr) => {
          const range = getWeekDateRange(weekStr);
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

// ============================================================================
// /business-impact
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/business-impact
 *
 * Aggregates business metrics from adobe_analytics, ga4 or cja sources. Returns a
 * normalized shape so the UI can render the same metric cards regardless of
 * provider. Defaults to source=adobe_analytics; caller passes ?source=ga4 or
 * ?source=cja for the other providers. CJA mirrors adobe_analytics one-for-one.
 * Passing any other source (optel, cdn) returns a 400 — those sources do not
 * carry the business metric columns required by this endpoint.
 *
 * bounce_rate is computed server-side as SUM(bounces) / SUM(visits); null when
 * visits = 0.
 */
const VALID_BUSINESS_IMPACT_SOURCES = new Set(['ga4', 'adobe_analytics', 'cja']);
const DEFAULT_BUSINESS_IMPACT_SOURCE = 'adobe_analytics';

// ============================================================================
// /by-url-trend
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/by-url-trend
 *
 * Weekly pageview totals for a single URL path.
 * Required query param: urlPath (exact path, e.g. /blog/my-post).
 * Returns: { trend: [{ weekStart: "YYYY-MM-DD", pageviews: N }, ...] }
 */
export function createReferralTrafficUrlTrendHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficUrlTrend(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'by-url-trend',
      async (ctx, client, siteId) => {
        const q = ctx.data || {};
        const urlPath = (q.urlPath || '').trim() || null;

        if (!urlPath) {
          return badRequest('urlPath query parameter is required');
        }

        const parsed = parseParams(ctx);

        const { data, error } = await client.rpc('rpc_referral_traffic_url_trend', {
          ...commonRpcParams(siteId, parsed),
          p_url_path: urlPath,
        });

        if (error) {
          ctx.log.error(`Referral traffic by-url-trend PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch referral traffic URL trend');
        }

        /* c8 ignore next 2 — same null-safety pattern as sibling handlers */
        return ok({
          trend: (data ?? []).map((row) => ({
            weekStart: row.week_start,
            pageviews: Number(row.total_pageviews),
          })),
        });
      },
    );
  };
}

// ============================================================================
// /business-impact
// ============================================================================

export function createReferralTrafficBusinessImpactHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficBusinessImpact(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'business-impact',
      async (ctx, client, siteId) => {
        const q = ctx.data || {};
        const rawSource = q.source;
        if (rawSource != null && !VALID_BUSINESS_IMPACT_SOURCES.has(rawSource)) {
          return badRequest('Business impact is only available for adobe_analytics, ga4 and cja sources');
        }
        const source = rawSource != null ? rawSource : DEFAULT_BUSINESS_IMPACT_SOURCE;
        const parsed = { ...parseParams(ctx), source };
        const rpcParams = commonRpcParams(siteId, parsed);
        const { data, error } = await client.rpc('rpc_referral_traffic_business_impact', rpcParams);

        if (error) {
          ctx.log.error(`Referral traffic business-impact PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch referral traffic business impact');
        }

        /* c8 ignore next — PostgREST always returns an array when error is null */
        const row = Array.isArray(data) ? data[0] : data;
        return ok({
          source,
          totalPageviews: Number(row?.total_pageviews ?? 0),
          metrics: {
            visits: Number(row?.visits ?? 0),
            bounceRate: row?.bounce_rate != null ? Number(row.bounce_rate) : null,
            entries: row?.entries != null ? Number(row.entries) : null,
            avgSessionDuration: row?.avg_session_duration != null
              ? Number(row.avg_session_duration) : null,
            pagesPerVisit: row?.pages_per_visit != null ? Number(row.pages_per_visit) : null,
            conversionRate: row?.conversion_rate != null ? Number(row.conversion_rate) : null,
            orders: Number(row?.orders ?? 0),
            revenue: Number(row?.revenue ?? 0),
          },
        });
      },
    );
  };
}

/**
 * All referral sources probed by has-data, in resolution-priority order.
 *
 * Business Impact sources (adobe_analytics, cja, ga4) rank ABOVE the Traffic
 * Insights sources (cdn, optel): a site connected to an analytics provider
 * should resolve to it first. The has-data response preserves this order in
 * availableSources so callers pick the first entry as the active source.
 *
 * NOTE: this list is intentionally broader than the Traffic Insights tab
 * (optel/cdn). Consumers that only care about Traffic Insights must filter
 * availableSources down to those two sources themselves.
 */
export const REFERRAL_HAS_DATA_SOURCES = ['adobe_analytics', 'cja', 'ga4', 'cdn', 'optel'];
export const REFERRAL_HAS_DATA_TABLES = REFERRAL_HAS_DATA_SOURCES.map((s) => SOURCE_TO_TABLE[s]);

/**
 * GET /sites/:siteId/referral-traffic/has-data
 *
 * Fast existence check across ALL referral sources (adobe_analytics, cja, ga4,
 * cdn, optel).
 *
 * Response:
 *   { hasData: boolean,
 *     availableSources: Array<'adobe_analytics'|'cja'|'ga4'|'cdn'|'optel'> }
 *
 * availableSources lists whichever sources have at least one row for the site,
 * in resolution-priority order (adobe_analytics > cja > ga4 > cdn > optel).
 * Callers use the first entry as the active source. hasData is true iff
 * availableSources is non-empty.
 *
 * All source tables are checked in parallel with limit(1) — no RPC required.
 * Fails closed: if any query errors, returns 500 rather than a partial result.
 */
export function createReferralTrafficHasDataHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficHasData(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'has-data',
      async (ctx, client, siteId) => {
        let results;
        try {
          results = await Promise.all(
            REFERRAL_HAS_DATA_TABLES.map((table) => client.from(table).select('traffic_date').eq('site_id', siteId).limit(1)),
          );
        } catch (err) {
          ctx.log.error(`Referral traffic has-data PostgREST error: ${err.message} (siteId=${siteId})`);
          return internalServerError('Failed to check referral traffic data');
        }

        for (const [i, result] of results.entries()) {
          if (result.error) {
            ctx.log.error(`Referral traffic has-data ${REFERRAL_HAS_DATA_TABLES[i]} PostgREST error: ${result.error.message} (siteId=${siteId})`);
            return internalServerError('Failed to check referral traffic data');
          }
        }

        const availableSources = REFERRAL_HAS_DATA_SOURCES.filter(
          (_, i) => (results[i].data || []).length > 0,
        );
        return cachedOk({ hasData: availableSources.length > 0, availableSources });
      },
    );
  };
}
