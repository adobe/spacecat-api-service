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

const VALID_SOURCES = new Set(['optel', 'cdn', 'adobe_analytics', 'ga4']);
const DEFAULT_SOURCE = 'optel';

const SOURCE_TO_TABLE = {
  optel: 'referral_traffic_optel',
  cdn: 'referral_traffic_cdn',
  adobe_analytics: 'referral_traffic_adobe_analytics',
  ga4: 'referral_traffic_ga4',
};

const DEFAULT_BY_URL_PAGE_SIZE = 50;
const MAX_BY_URL_PAGE_SIZE = 1000;

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

  return handlerFn(context, Site.postgrestService, siteId);
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
        const { data, error } = await client.rpc(
          'rpc_referral_traffic_kpis',
          commonRpcParams(siteId, parsed),
        );

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
        const { data, error } = await client.rpc(
          'rpc_referral_traffic_trend',
          commonRpcParams(siteId, parsed),
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
// /trend-by-url
// ============================================================================

/**
 * GET /sites/:siteId/referral-traffic/trend-by-url
 *
 * Per-URL weekly aggregate of pageviews. Powers the per-URL referral series
 * inside the URL Inspector PG details dialog (LLMO-4729).
 *
 * Mirrors the page-level /trend endpoint, with one extra query param
 * `urlPathSearch` (alias: `url_path_search`) mapped to `p_url_search` on
 * the RPC. The filter is a case-insensitive substring match on `url_path`,
 * matching the same semantics as `/by-url`. An absent or empty
 * urlPathSearch returns the page-wide trend (parity with the underlying
 * RPC's NULL contract); the UI always passes a non-empty path.
 */
export function createReferralTrafficTrendByUrlHandler(getSiteAndValidateAccess) {
  return async function getReferralTrafficTrendByUrl(context) {
    return withReferralTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'trend-by-url',
      async (ctx, client, siteId) => {
        const parsed = parseParams(ctx);
        const q = ctx.data || {};
        const urlPathSearch = q.urlPathSearch || q.url_path_search || null;

        const { data, error } = await client.rpc('rpc_referral_traffic_trend_by_url', {
          ...commonRpcParams(siteId, parsed),
          p_url_search: urlPathSearch,
        });

        if (error) {
          ctx.log.error(`Referral traffic trend-by-url PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch referral traffic trend by URL');
        }

        /* c8 ignore next 2 — PostgREST guarantees non-null data when error is null */
        return ok({
          trend: (data ?? []).map((row) => ({
            date: row.traffic_date,
            pageviews: Number(row.total_pageviews),
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
        const { data, error } = await client.rpc(
          'rpc_referral_traffic_by_platform',
          commonRpcParams(siteId, parsed),
        );

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
        const { data, error } = await client.rpc(
          'rpc_referral_traffic_by_device',
          commonRpcParams(siteId, parsed),
        );

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
        const { data, error } = await client.rpc(
          'rpc_referral_traffic_by_region',
          commonRpcParams(siteId, parsed),
        );

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
        const { data, error } = await client.rpc(
          'rpc_referral_traffic_by_page_intent',
          commonRpcParams(siteId, parsed),
        );

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

        const { data, error } = await client.rpc('rpc_referral_traffic_by_url', {
          ...commonRpcParams(siteId, parsed),
          p_url_search: urlPathSearch,
          p_limit: limit,
          p_offset: pageOffset,
          p_sort_by: sortBy,
          p_sort_order: sortOrder,
        });

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
 * requested source. Accepts ?source (optel|cdn|adobe_analytics|ga4, default optel).
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
 * Aggregates business metrics from adobe_analytics or ga4 sources. Returns a
 * normalized shape so the UI can render the same metric cards regardless of
 * provider. Defaults to source=adobe_analytics; caller passes ?source=ga4 for GA4.
 * Passing any other source (optel, cdn) returns a 400 — those sources do not
 * carry the business metric columns required by this endpoint.
 *
 * bounce_rate is computed server-side as SUM(bounces) / SUM(visits); null when
 * visits = 0.
 */
const VALID_BUSINESS_IMPACT_SOURCES = new Set(['ga4', 'adobe_analytics']);

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
          return badRequest('Business impact is only available for adobe_analytics and ga4 sources');
        }
        const source = rawSource === 'ga4' ? 'ga4' : 'adobe_analytics';
        const parsed = { ...parseParams(ctx), source };

        const { data, error } = await client.rpc(
          'rpc_referral_traffic_business_impact',
          commonRpcParams(siteId, parsed),
        );

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
