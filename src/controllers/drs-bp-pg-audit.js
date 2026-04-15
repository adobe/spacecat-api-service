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

/**
 * DRS Brand Presence PostgREST Audit Controller.
 *
 * Proxies queries from DRS monitoring workers to the `projection_audit` table in PostgREST.
 * DRS Lambdas run in a separate AWS account and cannot reach the private PostgREST endpoint
 * (`http://data-svc.internal`). This endpoint bridges the network gap.
 *
 * @returns {{ getProjectionAudit: Function }}
 */
export default function DrsBpPgAuditController() {
  /**
   * GET /tools/drs-bp-pg-audit
   *
   * Query parameters:
   *   siteId      {string}  required  - Site UUID (maps to scope_prefix in projection_audit)
   *   dateStart   {string}  required  - Start date YYYY-MM-DD (inclusive, as T00:00:00Z)
   *   dateEnd     {string}  required  - End date YYYY-MM-DD (exclusive, as T00:00:00Z)
   *   handlerName {string}  optional  - Handler name filter (default: wrpc_import_brand_presence)
   *   limit       {number}  optional  - Max rows to return (default + max: 500)
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
    const limit = Math.min(Number.isNaN(limitParam) ? MAX_LIMIT : limitParam, MAX_LIMIT);
    const offsetParam = parseInt(url.searchParams.get('offset') || '0', 10);
    const offset = Number.isNaN(offsetParam) || offsetParam < 0 ? 0 : offsetParam;

    if (!siteId) {
      return badRequest('siteId is required');
    }
    if (!dateStart) {
      return badRequest('dateStart is required');
    }
    if (!dateEnd) {
      return badRequest('dateEnd is required');
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
      return internalServerError(`projection_audit query failed: ${error.message}`);
    }

    return ok(data ?? []);
  };

  return { getProjectionAudit };
}
