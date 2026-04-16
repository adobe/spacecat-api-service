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

import { badRequest, internalServerError, ok } from '@adobe/spacecat-shared-http-utils';

import { isValidDateInterval } from '../utils/date-utils.js';

const MAX_LIMIT = 500;
const MAX_DATE_RANGE_DAYS = 90;
const DEFAULT_HANDLER_NAME = 'wrpc_import_brand_presence';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLER_RE = /^[a-z][a-z0-9_]{0,99}$/;

/**
 * Maps a projection_audit row from PostgREST to the API response shape.
 * Decouples the API contract from the database schema.
 */
function toAuditDto(row) {
  return {
    correlationId: row.correlation_id,
    siteId: row.scope_prefix,
    outputCount: row.output_count,
    projectedAt: row.projected_at,
  };
}

/**
 * DRS Brand Presence PostgREST Audit Controller.
 *
 * Proxies queries from DRS monitoring workers to the `projection_audit` table in PostgREST.
 * DRS Lambdas run in a separate AWS account and cannot reach the private PostgREST endpoint
 * (`http://data-svc.internal`). This endpoint bridges the network gap.
 *
 * Auth note: DRS workers authenticate via admin x-api-key (not scoped S2S JWT). The
 * `drsBpPgAudit:read` capability in routeRequiredCapabilities gates the S2S JWT path only;
 * admin key callers bypass capability checks via LegacyApiKeyHandler. This is intentional —
 * DRS runs in a separate AWS account and does not hold an S2S consumer registration.
 *
 * TODO: When S2S JWT callers are onboarded, the `drsBpPgAudit:read` capability grants access
 * to query any siteId (cross-tenant). Implement site-scoped authorization before the S2S
 * transition so JWT callers can only access their own sites.
 *
 * DB note: the PostgREST query filters on (scope_prefix, handler_name, projected_at, skipped).
 * A composite index on these columns is required for acceptable query performance on large tables.
 *
 * @param {object} context - Application context with dataAccess, log, etc.
 * @returns {{ getProjectionAudit: Function }}
 */
export default function DrsBpPgAuditController(context) {
  const postgrestClient = context?.dataAccess?.services?.postgrestClient;

  /**
   * GET /monitoring/drs-bp-pg-audit
   *
   * Query parameters:
   *   siteId      {string}  required  - Site UUID (maps to scope_prefix in projection_audit)
   *   dateStart   {string}  required  - Start date YYYY-MM-DD (inclusive, as T00:00:00Z)
   *   dateEnd     {string}  required  - End date YYYY-MM-DD (exclusive, as T00:00:00Z)
   *   handlerName {string}  optional  - Handler name filter (default: wrpc_import_brand_presence)
   *   limit       {number}  optional  - Page size (default + max: 500)
   *   offset      {number}  optional  - Row offset for pagination (default: 0)
   *
   * @param {object} reqContext - Request context with params, url, log.
   * @returns {Response} JSON array of projection_audit rows.
   */
  const getProjectionAudit = async (reqContext) => {
    if (!postgrestClient?.from) {
      return internalServerError('PostgREST client not available');
    }

    // Merge path params with URL query string params (query string takes precedence).
    // Framework only puts path params in reqContext.params; query string comes from request.url.
    const queryParams = reqContext.request?.url
      ? Object.fromEntries(new URL(reqContext.request.url).searchParams)
      : {};
    const params = { ...(reqContext.params ?? {}), ...queryParams };

    const {
      siteId,
      dateStart,
      dateEnd,
      handlerName: handlerNameParam,
    } = params;
    const handlerName = handlerNameParam || DEFAULT_HANDLER_NAME;
    const limitParam = parseInt(params.limit || String(MAX_LIMIT), 10);
    const clampedLimit = Math.min(Number.isNaN(limitParam) ? MAX_LIMIT : limitParam, MAX_LIMIT);
    const limit = Math.max(1, clampedLimit);
    const offsetParam = parseInt(params.offset || '0', 10);
    const offset = Number.isNaN(offsetParam) || offsetParam < 0 ? 0 : offsetParam;

    if (!siteId) {
      return badRequest('siteId is required');
    }
    if (!UUID_RE.test(siteId)) {
      return badRequest('siteId must be a valid UUID');
    }
    if (!dateStart || !dateEnd) {
      return badRequest('dateStart and dateEnd are required');
    }
    if (!isValidDateInterval(dateStart, dateEnd)) {
      return badRequest('Invalid date interval: dates must be valid YYYY-MM-DD, dateEnd must be after dateStart');
    }

    const daysDiff = (new Date(dateEnd) - new Date(dateStart)) / (1000 * 60 * 60 * 24);
    if (daysDiff > MAX_DATE_RANGE_DAYS) {
      return badRequest(`Date range must not exceed ${MAX_DATE_RANGE_DAYS} days`);
    }

    if (handlerNameParam && !HANDLER_RE.test(handlerNameParam)) {
      return badRequest('Invalid handlerName');
    }

    // Fetch limit + 1 to detect whether more rows exist without false positives
    // on exact page boundaries.
    const fetchCount = limit + 1;

    const { data, error } = await postgrestClient
      .from('projection_audit')
      // metadata excluded: contains internal S3 paths (resultLocation) — safe for admin-key
      // callers but should be reviewed before exposing to S2S JWT consumers.
      .select('correlation_id,scope_prefix,output_count,projected_at')
      .eq('scope_prefix', siteId)
      .eq('handler_name', handlerName)
      .gte('projected_at', `${dateStart}T00:00:00Z`)
      .lt('projected_at', `${dateEnd}T00:00:00Z`)
      .eq('skipped', false)
      .order('projected_at', { ascending: false })
      .range(offset, offset + fetchCount - 1);

    if (error) {
      reqContext.log?.error('projection_audit query failed', { errorMessage: error.message });
      return internalServerError('projection_audit query failed');
    }

    const fetched = data ?? [];
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;

    return ok({ rows: rows.map(toAuditDto), hasMore });
  };

  return { getProjectionAudit };
}
