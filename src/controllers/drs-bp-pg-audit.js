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

const MAX_LIMIT = 500;
const DEFAULT_HANDLER_NAME = 'wrpc_import_brand_presence';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
 * DB note: the PostgREST query filters on (scope_prefix, handler_name, projected_at, skipped).
 * A composite index on these columns is required for acceptable query performance on large tables.
 *
 * @returns {{ getProjectionAudit: Function }}
 */
export default function DrsBpPgAuditController() {
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
   * @param {object} reqContext - Request context with params, url, dataAccess.
   * @returns {Response} JSON array of projection_audit rows.
   */
  const getProjectionAudit = async (reqContext) => {
    const postgrestClient = reqContext.dataAccess?.services?.postgrestClient;
    if (!postgrestClient?.from) {
      return internalServerError('PostgREST client not available');
    }

    const url = new URL(reqContext.url);
    const siteId = url.searchParams.get('siteId');
    const dateStart = url.searchParams.get('dateStart');
    const dateEnd = url.searchParams.get('dateEnd');
    const handlerName = url.searchParams.get('handlerName') || DEFAULT_HANDLER_NAME;
    const limitParam = parseInt(url.searchParams.get('limit') || String(MAX_LIMIT), 10);
    const clampedLimit = Math.min(Number.isNaN(limitParam) ? MAX_LIMIT : limitParam, MAX_LIMIT);
    const limit = Math.max(1, clampedLimit);
    const offsetParam = parseInt(url.searchParams.get('offset') || '0', 10);
    const offset = Number.isNaN(offsetParam) || offsetParam < 0 ? 0 : offsetParam;

    if (!siteId) {
      return badRequest('siteId is required');
    }
    if (!UUID_RE.test(siteId)) {
      return badRequest('siteId must be a valid UUID');
    }
    if (!dateStart) {
      return badRequest('dateStart is required');
    }
    if (!DATE_RE.test(dateStart)) {
      return badRequest('dateStart must be a valid date in YYYY-MM-DD format');
    }
    if (!dateEnd) {
      return badRequest('dateEnd is required');
    }
    if (!DATE_RE.test(dateEnd)) {
      return badRequest('dateEnd must be a valid date in YYYY-MM-DD format');
    }
    if (dateEnd <= dateStart) {
      return badRequest('dateEnd must be after dateStart');
    }

    const { data, error } = await postgrestClient
      .from('projection_audit')
      .select('correlation_id,scope_prefix,output_count,metadata,projected_at')
      .eq('scope_prefix', siteId)
      .eq('handler_name', handlerName)
      .gte('projected_at', `${dateStart}T00:00:00Z`)
      .lt('projected_at', `${dateEnd}T00:00:00Z`)
      .eq('skipped', false)
      .order('projected_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      reqContext.log?.error('projection_audit query failed', { errorMessage: error.message });
      return internalServerError('projection_audit query failed');
    }

    const rows = data ?? [];
    return ok({ rows, hasMore: rows.length >= limit });
  };

  return { getProjectionAudit };
}
