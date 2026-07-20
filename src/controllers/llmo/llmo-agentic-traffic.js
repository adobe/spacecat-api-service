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
  accepted, badRequest, forbidden, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';
import { S3Client } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import { generateIsoWeekRange, getWeekDateRange } from './llmo-brand-presence.js';
import { parseAgentTypes } from './llmo-agent-types.js';
import { checkDateRange } from './traffic-date-range.js';
import { cachedOk } from '../../support/cached-response.js';
import {
  rotationContext,
  shouldRotate,
  rotatingPostgrest,
  computeWindow,
} from './traffic-rotation.js';

// Read-time rotation of the two frozen demo sites' agentic data lives entirely
// in the wrapped PostgREST client injected by withAgenticTrafficAuth; handlers
// call client.rpc(...) unaware of rotation. The one exception is /weeks, whose
// window is a pure function of now() (not a client fetch) — it still reads this.
const rotationCtx = (siteId) => rotationContext(siteId, 'agentic');

// Site-scoped agentic traffic handlers. Queries mysticat-data-service via PostgREST.

// String-match against getSiteAndValidateAccess errors until a shared error type exists.
const ERR_SITE_ACCESS = 'belonging to the organization';
const ERR_NOT_FOUND = 'not found';

const VALID_INTERVALS = new Set(['day', 'week', 'month']);
const VALID_SORT_ORDERS = new Set(['asc', 'desc']);
const VALID_SUCCESS_RATE_BUCKETS = new Set(['high', 'medium', 'low']);
const EXPORT_VERSION = 'v1';
const EXPORT_CANONICAL_VERSION = 1;
const EXPORT_KIND = 'agentic-traffic-urls';
const EXPORT_TYPE = `${EXPORT_KIND}-export`;
const EXPORT_FORMAT = 'csv';
const EXPORT_ID_PATTERN = /^[a-f0-9]{64}$/;
const VALID_SORT_COLUMNS_BY_URL = new Set([
  'host', 'url_path', 'total_hits', 'unique_agents',
  'success_rate', 'avg_ttfb_ms', 'category_name',
]);
const VALID_SORT_COLUMNS_BY_USER_AGENT = new Set([
  'page_type', 'agent_type', 'unique_agents', 'total_hits',
]);
const DEFAULT_BY_URL_LIMIT = 50;
const MAX_BY_URL_LIMIT = 200;
// Upper bound on the URL set accepted by the hits-by-urls endpoint. Must stay
// <= the matching cap in rpc_agentic_hits_for_urls (2000) so the handler
// rejects oversized input with a clean 400 before the RPC raises.
const MAX_HITS_BY_URLS = 2000;

// UI platform code → DB value. 'all' / unknown → null (no filter). Applied
// in parseAgenticTrafficParams, so it affects every site-scoped endpoint.
const PLATFORM_CODE_TO_DB = {
  openai: 'ChatGPT',
  chatgpt: 'ChatGPT',
  anthropic: 'Anthropic',
  mistral: 'MistralAI',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  google: 'Google',
  'google-ai-mode': 'Google AI Mode',
  copilot: 'Copilot',
  amazon: 'Amazon',
};

// Re-exported for existing imports.
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

// Filter values feed the exportId hash + SQS message — coerce non-strings to null
// and cap length to keep messages under SQS's 256 KiB limit.
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
    // Additive inclusion list, orthogonal to single-value `agentType`. Used by URL Inspector.
    agentTypes: parseAgentTypes(q.agentTypes ?? q.agent_types),
    userAgent: sanitizeFilterString(q.userAgent || q.user_agent),
    contentType: sanitizeFilterString(q.contentType || q.content_type),
    urlPathSearch: sanitizeFilterString(q.urlPathSearch || q.url_path_search),
    // Unknown buckets → null (prevents DB 500 on invalid input).
    successRate: VALID_SUCCESS_RATE_BUCKETS.has(q.successRate || q.success_rate)
      ? (q.successRate || q.success_rate)
      : null,
  };
}

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
    kind: EXPORT_KIND,
    v: 1,
    c: EXPORT_CANONICAL_VERSION,
    format: EXPORT_FORMAT,
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
  };
}

// RFC 8785 JCS — strict on string/number/boolean/null/array/object. NaN/Infinity throw.
export function jcsStringify(value) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('JCS: non-finite numbers are not permitted');
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(jcsStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcsStringify(value[k])}`).join(',')}}`;
  }
  /* c8 ignore next -- unreachable for our payload shape */
  throw new TypeError(`JCS: unsupported type ${typeof value}`);
}

function buildExportId(payload) {
  return crypto.createHash('sha256').update(jcsStringify(payload)).digest('hex');
}

// `v{N}c{M}` path matches the s3-export-framework ADR.
function buildExportPrefix(siteId, exportId) {
  return `agentic-traffic/url-exports/${siteId}/${EXPORT_VERSION}c${EXPORT_CANONICAL_VERSION}/${exportId}`;
}

function buildExportKeys(siteId, exportId) {
  const prefix = buildExportPrefix(siteId, exportId);
  return {
    csvKey: `${prefix}/urls.csv`,
    metadataKey: `${prefix}/metadata.json`,
  };
}

// Defense-in-depth on worker-written files[] — reject anything outside the
// deterministic prefix or not matching urls.csv[_partN].
function validateFilesAgainstPrefix(files, siteId, exportId) {
  const prefix = `${buildExportPrefix(siteId, exportId)}/`;
  const allowedFile = /^urls\.csv(?:_part\d+)?$/;
  return files.filter((k) => {
    if (typeof k !== 'string' || !k.startsWith(prefix)) {
      return false;
    }
    return allowedFile.test(k.slice(prefix.length));
  });
}

// Caps on status-polling against a pathological prefix.
const MAX_EXPORT_LIST_PAGES = 5;
const MAX_EXPORT_LIST_KEYS_PER_PAGE = 100;
const PART_SUFFIX_PATTERN = /_part(\d+)$/;
const REGEX_META_PATTERN = /[.*+?^${}()|[\]\\]/g;

function getExportConfig(ctx) {
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

// CAS write of processing metadata. `casOnly` uses IfNoneMatch:* so the PUT
// fails when the object exists (used on no-metadata path); stale/failed
// retries overwrite. Returns false on race-loss, true on win.
async function claimProcessingMetadata(ctx, bucket, metadataKey, exportId, siteId, casOnly) {
  const { s3 } = ctx;
  const body = JSON.stringify({
    status: 'processing',
    exportId,
    siteId,
    kind: EXPORT_KIND,
    format: EXPORT_FORMAT,
    createdAt: new Date().toISOString(),
  });
  const command = new s3.PutObjectCommand({
    Bucket: bucket,
    Key: metadataKey,
    Body: body,
    ContentType: 'application/json',
    ...(casOnly ? { IfNoneMatch: '*' } : {}),
  });
  try {
    await s3.s3Client.send(command);
    return true;
  } catch (error) {
    // 412 is the canonical IfNoneMatch race-loss; SDK error names vary across versions.
    if (error.$metadata?.httpStatusCode === 412 || error.name === 'PreconditionFailed') {
      ctx.log.info(`Agentic traffic export: CAS race-loss on metadata.json (exportId=${exportId})`);
      return false;
    }
    /* c8 ignore next 2 -- propagated to the route's catch-all */
    throw error;
  }
}

// Rolls back the CAS write when enqueue fails — otherwise a transient SQS
// failure blocks the cache key until stale-processing expires.
async function deleteProcessingMetadata(ctx, bucket, metadataKey) {
  const { s3 } = ctx;
  const command = new s3.DeleteObjectCommand({ Bucket: bucket, Key: metadataKey });
  await s3.s3Client.send(command);
}

async function getExportMetadata(ctx, bucket, metadataKey) {
  const { s3 } = ctx;
  let body;
  try {
    const command = new s3.GetObjectCommand({ Bucket: bucket, Key: metadataKey });
    const result = await s3.s3Client.send(command);
    body = await result.Body.transformToString();
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return null;
    }
    /* c8 ignore next 2 -- propagated to the route's catch-all; not exercised in unit tests */
    throw error;
  }
  try {
    return JSON.parse(body);
  } catch (parseError) {
    ctx.log.warn(`Agentic traffic export: metadata.json is not valid JSON; treating as absent (key=${metadataKey})`);
    return null;
  }
}

// Presigned URLs are bearer credentials — short TTL bounds leak blast radius.
const PRESIGNED_URL_TTL_SECONDS = 60 * 60;
const MAX_EXPORT_DOWNLOAD_URLS = 50;

// Sign customer URLs against s3-accelerate so the region is hidden, except
// in IT (AWS_ENDPOINT_URL_S3 set) where accelerate doesn't exist.
const acceleratedS3Clients = new Map();
function getSigningClient(ctx, region) {
  if (ctx.env?.AWS_ENDPOINT_URL_S3) {
    return ctx.s3.s3Client;
  }
  if (!acceleratedS3Clients.has(region)) {
    acceleratedS3Clients.set(region, new S3Client({ region, useAccelerateEndpoint: true }));
  }
  return acceleratedS3Clients.get(region);
}

async function buildExportReadyResponse(ctx, bucket, exportId, csvKeys, metadata = null) {
  const expiresIn = PRESIGNED_URL_TTL_SECONDS;
  const keysToSign = csvKeys.slice(0, MAX_EXPORT_DOWNLOAD_URLS);
  const { s3Region } = getExportConfig(ctx);
  const signingClient = getSigningClient(ctx, s3Region);
  const downloadUrls = await Promise.all(keysToSign.map(async (key) => {
    const command = new ctx.s3.GetObjectCommand({ Bucket: bucket, Key: key });
    return ctx.s3.getSignedUrl(signingClient, command, { expiresIn });
  }));
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

// Contract: worker writes CSV first, metadata.json last.
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
const EXPORT_PROCESSING_STALE_MS = 30 * 60 * 1000;

function isExportStaleProcessing(metadata) {
  if (!isExportProcessing(metadata) || !metadata.createdAt) {
    return false;
  }
  const ageMs = Date.now() - new Date(metadata.createdAt).getTime();
  return Number.isFinite(ageMs) && ageMs > EXPORT_PROCESSING_STALE_MS;
}

// Extra param for RPCs that accept `p_agent_types` (kpis-trend, by-url). Others would 500.
function buildAgentTypesRpcParam(parsed) {
  return parsed.agentTypes !== null
    ? { p_agent_types: parsed.agentTypes }
    : {};
}

// PostgREST availability + site/org access check; forwards siteContext so
// handlers needing org data avoid a second DB lookup.
async function withAgenticTrafficAuth(context, getSiteAndValidateAccess, handlerName, handlerFn) {
  const { log, dataAccess } = context;
  const { Site } = dataAccess;

  if (!Site?.postgrestService) {
    log.error('Agentic traffic APIs require PostgREST (DATA_SERVICE_PROVIDER=postgres)');
    return badRequest('Agentic traffic data is not available. PostgreSQL data service is required.');
  }

  const rangeError = checkDateRange(context.data);
  if (rangeError) {
    log.info(`Agentic traffic ${handlerName} rejected (date range guardrail): ${rangeError}`);
    return badRequest(rangeError);
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

  // Demo sites read through a rotating client (frozen data → rolling window);
  // every other site gets the real client unchanged (zero behavior change).
  const client = shouldRotate(siteId, 'agentic')
    ? rotatingPostgrest(Site.postgrestService, siteId, 'agentic')
    : Site.postgrestService;
  return handlerFn(context, client, siteId, siteContext);
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
        const rpcParams = buildRpcParams(siteId, parsed);
        const { data, error } = await client.rpc('rpc_agentic_traffic_kpis', rpcParams);
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
        const rpcParams = buildRpcParams(siteId, parsed);
        const { data, error } = await client.rpc('rpc_agentic_traffic_by_region', rpcParams);
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
        // by_category groups by category — no p_category_name parameter.
        const rpcParams = buildRpcParams(siteId, parsed);
        delete rpcParams.p_category_name;
        const { data, error } = await client.rpc('rpc_agentic_traffic_by_category', rpcParams);
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
        const rpcParams = buildRpcParams(siteId, parsed);
        const { data, error } = await client.rpc('rpc_agentic_traffic_by_page_type', rpcParams);
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
        const rpcParams = buildRpcParams(siteId, parsed);
        const { data, error } = await client.rpc('rpc_agentic_traffic_by_status', rpcParams);
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
            // [{ week_start, value }] from week_series CTE — drives URL Inspector sparklines.
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
 * POST /sites/:siteId/agentic-traffic/hits-by-urls
 *
 * Bounded keyed lookup of per-URL agentic totalHits + weekly hitsTrend for a
 * caller-supplied set of canonical URLs (LLMO-5586). Backs the per-URL
 * consumers (URL Inspector, opportunity sections, domain chart) that only need
 * hits, so they no longer eager-page the expensive ranked `by-url` grid.
 *
 * Body: {
 *   urls: [{ host, urlPath }],   // the URLs already on screen
 *   startDate, endDate,          // same shape as the other agentic endpoints
 *   platform?, agentType?, agentTypes?, userAgent?
 * }
 * Returns: { rows: [{ host, urlPath, totalHits, hitsTrend }] }
 *
 * Calls rpc_agentic_hits_for_urls, which matches rpc_agentic_traffic_by_url's
 * fact-derived totals/trend exactly without the full-site scan + ranking.
 */
export function createAgenticTrafficHitsByUrlsHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficHitsByUrls(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'hits-by-urls',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);

        const rawUrls = ctx.data?.urls;
        if (!Array.isArray(rawUrls)) {
          return badRequest('urls must be an array of { host, urlPath } objects');
        }
        if (rawUrls.length > MAX_HITS_BY_URLS) {
          return badRequest(`urls must contain at most ${MAX_HITS_BY_URLS} entries`);
        }

        // Normalise to the RPC's { host, url_path } shape; accept camelCase or
        // snake_case for url_path and drop entries missing host or path.
        const urls = rawUrls
          .map((u) => ({ host: u?.host, url_path: u?.urlPath ?? u?.url_path }))
          .filter((u) => hasText(u.host) && hasText(u.url_path));

        if (urls.length === 0) {
          // ok() not cachedOk(): this is a POST whose result varies by body,
          // and cachedOk is documented as GET-only.
          return ok({ rows: [] });
        }

        const rpcParams = {
          p_site_id: siteId,
          p_start_date: parsed.startDate,
          p_end_date: parsed.endDate,
          p_urls: urls,
          p_platform: parsed.platform,
          p_user_agent: parsed.userAgent,
          ...buildAgentTypesRpcParam(parsed),
        };

        const { data, error } = await client.rpc('rpc_agentic_hits_for_urls', rpcParams);
        if (error) {
          ctx.log.error(`Agentic traffic hits-by-urls PostgREST error: ${error.message}`);
          return internalServerError('Failed to fetch agentic hits by URLs');
        }
        /* c8 ignore next */
        const rows = data ?? [];
        // raw vs valid surfaces caller-side URL-list bugs (entries dropped for
        // missing host/path); returned is the RPC row count.
        ctx.log.info(`Agentic traffic hits-by-urls: raw=${rawUrls.length} valid=${urls.length} returned=${rows.length}`);
        return ok({
          rows: rows.map((row) => ({
            host: row.host || '',
            urlPath: row.url_path || '',
            totalHits: Number(row.total_hits ?? 0),
            hitsTrend: Array.isArray(row.hits_trend)
              ? row.hits_trend.map((point) => ({
                weekStart: point.week_start ?? null,
                value: Number(point.value ?? 0),
              }))
              : [],
          })),
        });
      },
    );
  };
}

// POST /sites/:siteId/agentic-traffic/urls/export — cache-check S3 → enqueue SQS on miss.
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
          || !s3?.PutObjectCommand || !s3?.getSignedUrl || !sqs?.sendMessage) {
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
          const metadata = await getExportMetadata(ctx, s3Bucket, metadataKey);

          // Fast path: sign worker-written files[] directly. Validated first.
          if (metadata?.status === 'success'
            && Array.isArray(metadata.files) && metadata.files.length > 0) {
            const safeFiles = validateFilesAgainstPrefix(metadata.files, siteId, exportId);
            if (safeFiles.length === metadata.files.length) {
              return buildExportReadyResponse(ctx, s3Bucket, exportId, safeFiles, metadata);
            }
            ctx.log.warn(`Agentic traffic export: metadata.files contained out-of-prefix keys; falling back to ListObjectsV2 (exportId=${exportId})`);
          }

          const csvKeys = await listExportCsvObjects(ctx, s3Bucket, csvKey);

          if (isExportReady(csvKeys, metadata)) {
            return buildExportReadyResponse(ctx, s3Bucket, exportId, csvKeys, metadata);
          }

          if (isExportProcessing(metadata) && !isExportStaleProcessing(metadata)) {
            return accepted({
              exportId,
              status: 'processing',
            });
          }

          // CAS-claim: protects against double-enqueue AND don't clobber success metadata
          // if CSVs were evicted. Stale/failed retries overwrite via casOnly=false.
          const casOnly = metadata === null || metadata.status === 'success';
          const claimed = await claimProcessingMetadata(
            ctx,
            s3Bucket,
            metadataKey,
            exportId,
            siteId,
            casOnly,
          );
          if (!claimed) {
            return accepted({ exportId, status: 'processing' });
          }

          try {
            await sqs.sendMessage(queueUrl, {
              type: EXPORT_TYPE,
              data: {
                siteId,
                exportId,
                filters: payload,
                s3Bucket,
                s3Key: csvKey,
                s3Region,
                /* c8 ignore next -- 'unknown' fallback when authInfo is absent */
                requestedBy: ctx.attributes?.authInfo?.profile?.email || 'unknown',
              },
            });
          } catch (enqueueError) {
            // Rollback so the next POST can retry instead of waiting for stale window.
            await deleteProcessingMetadata(ctx, s3Bucket, metadataKey).catch(() => {});
            throw enqueueError;
          }

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

// GET /sites/:siteId/agentic-traffic/urls/export/:exportId — polls S3 metadata.
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
          const metadata = await getExportMetadata(ctx, s3Bucket, metadataKey);

          // Fast path: sign worker-written files[] directly. Validated first.
          if (metadata?.status === 'success'
            && Array.isArray(metadata.files) && metadata.files.length > 0) {
            const safeFiles = validateFilesAgainstPrefix(metadata.files, siteId, exportId);
            if (safeFiles.length === metadata.files.length) {
              return buildExportReadyResponse(ctx, s3Bucket, exportId, safeFiles, metadata);
            }
            ctx.log.warn(`Agentic traffic export: metadata.files contained out-of-prefix keys; falling back to ListObjectsV2 (exportId=${exportId})`);
          }

          const csvKeys = await listExportCsvObjects(ctx, s3Bucket, csvKey);

          if (isExportReady(csvKeys, metadata)) {
            return buildExportReadyResponse(ctx, s3Bucket, exportId, csvKeys, metadata);
          }

          if (isExportFailed(metadata)) {
            return ok({
              exportId,
              status: 'failed',
              /* c8 ignore next 2 -- defaults for malformed worker metadata */
              failureReason: metadata.failureReason ?? 'unknown',
              failureMessage: metadata.failureMessage ?? 'Export failed',
            });
          }

          if (isExportStaleProcessing(metadata)) {
            return ok({
              exportId,
              status: 'failed',
              failureReason: 'timeout',
              failureMessage: 'Export timed out — please retry',
            });
          }

          // No metadata and no CSV → never POSTed (or evicted). Distinct from
          // "POSTed, worker hasn't started yet" because POST writes processing
          // metadata atomically before enqueueing.
          if (!metadata && csvKeys.length === 0) {
            return notFound(`No export found for exportId ${exportId}`);
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

// GET /sites/:siteId/agentic-traffic/filter-dimensions — cascading filter values in one RPC.
export function createAgenticTrafficFilterDimensionsHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficFilterDimensions(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'filter-dimensions',
      async (ctx, client, siteId) => {
        const parsed = parseAgenticTrafficParams(ctx);
        const rpcParams = buildRpcParams(siteId, parsed);
        const { data, error } = await client.rpc(
          'rpc_agentic_traffic_distinct_filters',
          rpcParams,
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

// GET /sites/:siteId/agentic-traffic/weeks → ISO weeks between min/max traffic_date.
// Returns: { weeks: [{ week, startDate, endDate }] }
export function createAgenticTrafficWeeksHandler(getSiteAndValidateAccess) {
  return async function getAgenticTrafficWeeks(context) {
    return withAgenticTrafficAuth(
      context,
      getSiteAndValidateAccess,
      'weeks',
      async (ctx, client, siteId) => {
        const rot = rotationCtx(siteId);
        if (rot.rotate) {
          // Rolling window is a pure function of now() — keeps /weeks consistent
          // with the relabeled trend without touching the frozen min/max dates.
          return cachedOk({ weeks: computeWindow(rot.now).weeks });
        }
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

// GET /sites/:siteId/agentic-traffic/has-data → { hasData: boolean }. Single limit(1) query.
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

// GET /sites/:siteId/agentic-traffic/url-brand-presence?url=&startDate=&endDate=&platform=
// URL resolved via source_urls.url_hash (md5); organisation_id derived from site.
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
