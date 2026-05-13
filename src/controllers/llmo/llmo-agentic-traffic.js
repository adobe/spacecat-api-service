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
  accepted, badRequest, forbidden, internalServerError, ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';
import crypto from 'crypto';
import { generateIsoWeekRange, getWeekDateRange } from './llmo-brand-presence.js';
import { parseAgentTypes } from './llmo-agent-types.js';
import { cachedOk } from '../../support/cached-response.js';

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
const VALID_SUCCESS_RATE_BUCKETS = new Set(['high', 'medium', 'low']);
const EXPORT_VERSION = 'v1';
const EXPORT_TYPE = 'agentic-traffic-urls-export';
const EXPORT_ID_PATTERN = /^[a-f0-9]{64}$/;
// Allowlists mirror the CASE whitelists in the DB RPCs — unknown values are already
// rejected server-side, but we validate here too for defence-in-depth.
// `parseAgentTypes` and the canonical agent-type list now live in
// `./llmo-agent-types.js` so the URL Inspector handler can share them
// without cross-controller imports.
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

// Re-exported from `./llmo-agent-types.js` so existing imports (the test
// suite, the URL Inspector handler before it was switched to import the
// shared module directly) keep working without churn.
export { parseAgentTypes };

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
// Filter values reach the exportId hash + SQS message; coerce non-strings
// to null and bound length (SQS limit is 256 KiB).
const FILTER_STRING_MAX = 512;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeFilterString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  /* c8 ignore next 3 -- empty/oversized length hygiene; not security-critical */
  if (value.length === 0 || value.length > FILTER_STRING_MAX) {
    return null;
  }
  return value;
}

function sanitizeDateString(value, fallback) {
  return typeof value === 'string' && DATE_PATTERN.test(value) ? value : fallback;
}

function parseAgenticTrafficParams(context) {
  const q = context.data || {};
  const defaults = defaultDateRange();
  return {
    startDate: sanitizeDateString(q.startDate || q.start_date, defaults.startDate),
    endDate: sanitizeDateString(q.endDate || q.end_date, defaults.endDate),
    platform: PLATFORM_CODE_TO_DB[q.platform] ?? null,
    categoryName: sanitizeFilterString(q.categoryName || q.category_name),
    agentType: sanitizeFilterString(q.agentType || q.agent_type),
    // Additive inclusion list orthogonal to the single-value `agentType`. Used by the
    // URL Inspector PG page to enforce `Agent Type ∈ {Chatbots, Research}`. Existing
    // callers omit this and continue to receive the same data.
    agentTypes: parseAgentTypes(q.agentTypes ?? q.agent_types),
    userAgent: sanitizeFilterString(q.userAgent || q.user_agent),
    contentType: sanitizeFilterString(q.contentType || q.content_type),
    urlPathSearch: sanitizeFilterString(q.urlPathSearch || q.url_path_search),
    // Normalise to null for unknown buckets — mirrors how PLATFORM_CODE_TO_DB handles
    // unknown platform codes, preventing a DB exception (500) for invalid input.
    successRate: VALID_SUCCESS_RATE_BUCKETS.has(q.successRate || q.success_rate)
      ? (q.successRate || q.success_rate)
      : null,
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

function canonicalizeExportPayload(siteId, parsed) {
  return {
    version: EXPORT_VERSION,
    siteId,
    startDate: parsed.startDate,
    endDate: parsed.endDate,
    platform: parsed.platform,
    categoryName: parsed.categoryName,
    agentType: parsed.agentType,
    userAgent: parsed.userAgent,
    contentType: parsed.contentType,
    successRate: parsed.successRate,
    urlPathSearch: parsed.urlPathSearch,
    format: 'csv',
  };
}

// Order-stable JSON serialisation. The canonical export payload is a flat
// object of primitives, so the recursive object branch is enough — no array
// handling needed.
function stableStringify(value) {
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildExportId(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

// EXPORT_VERSION is intentionally in both the key prefix (physical isolation)
// and the canonical payload (forces hash invalidation on bump). Keep both.
function buildExportKeys(siteId, exportId) {
  const prefix = `agentic-traffic/url-exports/${siteId}/${EXPORT_VERSION}/${exportId}`;
  return {
    csvKey: `${prefix}/urls.csv`,
    metadataKey: `${prefix}/metadata.json`,
  };
}

// Caps defend status-polling against a pathological prefix (malicious
// continuation token, misbehaving worker).
const MAX_EXPORT_LIST_PAGES = 5;
const MAX_EXPORT_LIST_KEYS_PER_PAGE = 100;
const PART_SUFFIX_PATTERN = /_part(\d+)$/;
const REGEX_META_PATTERN = /[.*+?^${}()|[\]\\]/g;

function getExportConfig(ctx) {
  // S3_REPORT_BUCKET is the API service's existing env var name; the worker
  // uses S3_REPORTING_BUCKET_NAME in its own Lambda env — both resolve to
  // the same spacecat-{env}-reports bucket at deploy time.
  const s3Bucket = ctx.env?.S3_REPORT_BUCKET;
  const queueUrl = ctx.env?.REPORT_JOBS_QUEUE_URL;
  /* c8 ignore next -- default region when ctx.runtime is unset */
  const s3Region = ctx.runtime?.region || 'us-east-1';
  return { s3Bucket, queueUrl, s3Region };
}

async function listExportCsvObjects(ctx, bucket, csvKey) {
  const { s3 } = ctx;
  const objects = [];
  const partMatcher = new RegExp(`^${csvKey.replace(REGEX_META_PATTERN, '\\$&')}_part\\d+$`);
  let ContinuationToken;
  let pages = 0;
  do {
    const command = new s3.ListObjectsV2Command({
      Bucket: bucket,
      Prefix: csvKey,
      MaxKeys: MAX_EXPORT_LIST_KEYS_PER_PAGE,
      ContinuationToken,
    });
    // eslint-disable-next-line no-await-in-loop
    const result = await s3.s3Client.send(command);
    objects.push(...(result.Contents || [])
      .filter((item) => item.Key === csvKey || item.Key?.match(partMatcher))
      .map((item) => item.Key));
    ContinuationToken = result.NextContinuationToken;
    pages += 1;
  } while (ContinuationToken && pages < MAX_EXPORT_LIST_PAGES);

  return [...new Set(objects)].sort((left, right) => {
    // `|| 1` is unreachable: filter above guarantees `_part\d+$` matches.
    /* c8 ignore next */
    const part = (key) => (key === csvKey ? 1 : Number(key.match(PART_SUFFIX_PATTERN)?.[1] || 1));
    return part(left) - part(right);
  });
}

async function getExportMetadata(ctx, bucket, metadataKey) {
  const { s3 } = ctx;
  try {
    const command = new s3.GetObjectCommand({ Bucket: bucket, Key: metadataKey });
    const result = await s3.s3Client.send(command);
    const body = await result.Body.transformToString();
    return JSON.parse(body);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return null;
    }
    /* c8 ignore next 2 -- propagated to the route's catch-all; not exercised in unit tests */
    throw error;
  }
}

// Presigned URLs are bearer credentials — short TTL bounds leak blast radius.
const PRESIGNED_URL_TTL_SECONDS = 60 * 60;
const MAX_EXPORT_DOWNLOAD_URLS = 50;

async function buildExportReadyResponse(ctx, bucket, exportId, csvKeys, metadata = null) {
  const expiresIn = PRESIGNED_URL_TTL_SECONDS;
  const keysToSign = csvKeys.slice(0, MAX_EXPORT_DOWNLOAD_URLS);
  const downloadUrls = await Promise.all(keysToSign.map(async (key) => {
    const command = new ctx.s3.GetObjectCommand({ Bucket: bucket, Key: key });
    return ctx.s3.getSignedUrl(ctx.s3.s3Client, command, { expiresIn });
  }));
  // Computed after signing so callers see the floor of the URL window.
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  return ok({
    exportId,
    status: 'ready',
    downloadUrls,
    expiresAt,
    rowCount: metadata?.rowCount ?? null,
    filesUploaded: metadata?.filesUploaded ?? csvKeys.length,
    bytesUploaded: metadata?.bytesUploaded ?? null,
  });
}

// Contract: worker writes CSV first, metadata.json last. Tighten to require
// `metadata.status === 'success'` if that order ever changes.
function isExportReady(csvKeys, metadata) {
  return csvKeys.length > 0 && (!metadata || metadata.status === 'success');
}

function isExportFailed(metadata) {
  return metadata?.status === 'failed';
}

function isExportProcessing(metadata) {
  return metadata?.status === 'processing';
}

// 30 min covers Aurora's 840s statement_timeout + Lambda overhead.
// Older `processing` metadata is treated as abandoned so the cache key unblocks.
const EXPORT_PROCESSING_STALE_MS = 30 * 60 * 1000;

function isExportStaleProcessing(metadata) {
  if (!isExportProcessing(metadata) || !metadata.createdAt) {
    return false;
  }
  const ageMs = Date.now() - new Date(metadata.createdAt).getTime();
  return Number.isFinite(ageMs) && ageMs > EXPORT_PROCESSING_STALE_MS;
}

/**
 * Extra params for RPCs that accept the additive `p_agent_types TEXT[]` input
 * (currently `rpc_agentic_traffic_kpis_trend` and `rpc_agentic_traffic_by_url`).
 *
 * Returned as its own object so we don't accidentally send `p_agent_types` to
 * the other RPCs — PostgREST rejects calls with unknown named arguments, which
 * would 500 every dashboard whose RPC signature we haven't extended.
 */
function buildAgentTypesRpcParam(parsed) {
  return parsed.agentTypes !== null
    ? { p_agent_types: parsed.agentTypes }
    : {};
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
        return cachedOk({
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
          ...buildAgentTypesRpcParam(parsed),
          p_interval: interval,
        };
        const { data, error } = await client.rpc('rpc_agentic_traffic_kpis_trend', rpcParams);
        if (error) {
          ctx.log.error(`Agentic traffic kpis-trend PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic KPIs trend');
        }
        /* c8 ignore next */ return cachedOk((data ?? []).map((row) => ({
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
        /* c8 ignore next */ return cachedOk((data ?? []).map((row) => ({
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
        /* c8 ignore next */ return cachedOk((data ?? []).map((row) => ({
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
        /* c8 ignore next */ return cachedOk((data ?? []).map((row) => ({
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
        /* c8 ignore next */ return cachedOk((data ?? []).map((row) => ({
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
        /* c8 ignore next */ return cachedOk((data ?? []).map((row) => ({
          pageType: row.page_type || '',
          agentType: row.agent_type || '',
          uniqueAgents: Number(row.unique_agents ?? 0),
          uniqueAgentNames: Array.isArray(row.unique_agent_names) ? row.unique_agent_names : [],
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
          ...buildAgentTypesRpcParam(parsed),
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
        /* c8 ignore next */ return cachedOk({
          totalCount,
          rows: rows.map((row) => ({
            host: row.host || '',
            urlPath: row.url_path || '',
            totalHits: Number(row.total_hits ?? 0),
            uniqueAgents: Number(row.unique_agents ?? 0),
            uniqueAgentNames: Array.isArray(row.unique_agent_names) ? row.unique_agent_names : [],
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
            // hits_trend is the [{ week_start, value }] payload generated by
            // rpc_agentic_traffic_by_url's week_series CTE — forwarded as-is
            // so the URL Inspector PG dashboard can derive its Owned-table
            // sparkline + WoW direction from the same per-URL series the
            // single-URL chart in URLDetailsPgDialog consumes.
            hitsTrend: Array.isArray(row.hits_trend)
              ? row.hits_trend.map((point) => ({
                weekStart: point.week_start,
                value: Number(point.value ?? 0),
              }))
              : [],
          })),
        });
      },
    );
  };
}

/**
 * POST /sites/:siteId/agentic-traffic/urls/export
 *
 * Creates or reuses a deterministic S3-backed URL export. The API does not run
 * the database export inline; it returns a cached download URL when present or
 * queues a reporting-worker job that calls the data-service DB-to-S3 RPC.
 */
export function createAgenticTrafficUrlsExportHandler(getSiteAndValidateAccess) {
  return async function exportAgenticTrafficUrls(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'urls-export',
      async (ctx, _client, siteId) => {
        const { s3, sqs } = ctx;
        /* c8 ignore start -- deploy-time misconfig guard, not exercised in unit tests */
        if (!s3?.s3Client || !s3?.ListObjectsV2Command || !s3?.GetObjectCommand
          || !s3?.getSignedUrl || !sqs?.sendMessage) {
          return badRequest('Agentic traffic export requires S3 and SQS configuration');
        }

        const { s3Bucket, queueUrl, s3Region } = getExportConfig(ctx);
        if (!hasText(s3Bucket) || !hasText(queueUrl)) {
          return badRequest('Agentic traffic export is not configured');
        }
        /* c8 ignore stop */

        const parsed = parseAgenticTrafficParams(ctx);
        const payload = canonicalizeExportPayload(siteId, parsed);
        const exportId = buildExportId(payload);
        const { csvKey, metadataKey } = buildExportKeys(siteId, exportId);

        try {
          const [csvKeys, metadata] = await Promise.all([
            listExportCsvObjects(ctx, s3Bucket, csvKey),
            getExportMetadata(ctx, s3Bucket, metadataKey),
          ]);

          if (isExportReady(csvKeys, metadata)) {
            return buildExportReadyResponse(ctx, s3Bucket, exportId, csvKeys, metadata);
          }

          if (isExportProcessing(metadata) && !isExportStaleProcessing(metadata)) {
            return accepted({
              exportId,
              status: 'processing',
            });
          }

          // Failed / stale-processing / no-metadata → re-enqueue. The worker
          // overwrites metadata on retry; GET reports `failed` to the UI.
          await sqs.sendMessage(queueUrl, {
            type: EXPORT_TYPE,
            data: {
              siteId,
              exportId,
              filters: payload,
              s3Bucket,
              s3Key: csvKey,
              metadataKey,
              s3Region,
              /* c8 ignore next -- 'unknown' fallback when authInfo is absent */
              requestedBy: ctx.attributes?.authInfo?.profile?.email || 'unknown',
            },
          });

          return accepted({
            exportId,
            status: 'processing',
          });
        /* c8 ignore start -- generic safety net; specific failure modes return earlier */
        } catch (error) {
          ctx.log.error(`Agentic traffic URLs export error: ${error.message}`);
          return internalServerError('Failed to start agentic traffic URL export');
        }
        /* c8 ignore stop */
      },
    );
  };
}

/**
 * GET /sites/:siteId/agentic-traffic/urls/export/:exportId
 *
 * Polls S3 metadata and export objects for a deterministic export id.
 */
export function createAgenticTrafficUrlsExportStatusHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficUrlsExportStatus(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'urls-export-status',
      async (ctx, _client, siteId) => {
        const { exportId } = ctx.params;
        if (!EXPORT_ID_PATTERN.test(exportId || '')) {
          return badRequest('Valid exportId is required');
        }

        const { s3 } = ctx;
        /* c8 ignore start -- deploy-time misconfig guard, not exercised in unit tests */
        if (!s3?.s3Client || !s3?.ListObjectsV2Command || !s3?.GetObjectCommand
          || !s3?.getSignedUrl) {
          return badRequest('Agentic traffic export requires S3 configuration');
        }

        const { s3Bucket } = getExportConfig(ctx);
        if (!hasText(s3Bucket)) {
          return badRequest('Agentic traffic export is not configured');
        }
        /* c8 ignore stop */

        const { csvKey, metadataKey } = buildExportKeys(siteId, exportId);

        try {
          const [csvKeys, metadata] = await Promise.all([
            listExportCsvObjects(ctx, s3Bucket, csvKey),
            getExportMetadata(ctx, s3Bucket, metadataKey),
          ]);

          if (isExportReady(csvKeys, metadata)) {
            return buildExportReadyResponse(ctx, s3Bucket, exportId, csvKeys, metadata);
          }

          if (isExportFailed(metadata)) {
            return ok({
              exportId,
              status: 'failed',
              failureReason: metadata.failureReason ?? 'Export failed',
            });
          }

          if (isExportStaleProcessing(metadata)) {
            return ok({
              exportId,
              status: 'failed',
              failureReason: 'Export timed out — please retry',
            });
          }

          return ok({
            exportId,
            status: 'processing',
          });
        /* c8 ignore start -- generic safety net; specific failure modes return earlier */
        } catch (error) {
          ctx.log.error(`Agentic traffic URLs export status error: ${error.message}`);
          return internalServerError('Failed to fetch agentic traffic URL export status');
        }
        /* c8 ignore stop */
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
        return cachedOk({
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
        /* c8 ignore next */ return cachedOk((data ?? []).map((row) => ({
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
          return cachedOk({ weeks: [] });
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

        return cachedOk({ weeks });
      },
    );
  };
}

/**
 * GET /sites/:siteId/agentic-traffic/has-data
 *
 * Fast existence check — returns { hasData: boolean } indicating whether any
 * agentic traffic records exist for the site. Used by the PG dashboard to
 * decide whether to show the no-data overlay without waiting for all parallel
 * queries to settle.
 *
 * Runs a single PostgREST table query with limit(1) — no RPC required.
 */
export function createAgenticTrafficHasDataHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficHasData(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'has-data',
      async (ctx, client, siteId) => {
        const { data, error } = await client
          .from('agentic_traffic')
          .select('traffic_date')
          .eq('site_id', siteId)
          .limit(1);

        if (error) {
          ctx.log.error(`Agentic traffic has-data PostgREST error: ${error.message}`);
          return internalServerError('Failed to check agentic traffic data');
        }

        /* c8 ignore next */
        return cachedOk({ hasData: (data || []).length > 0 });
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
        return cachedOk({
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
