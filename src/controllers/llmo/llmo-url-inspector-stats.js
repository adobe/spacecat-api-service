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

import { ok, badRequest } from '@adobe/spacecat-shared-http-utils';
import {
  withUrlInspectorAuth, parseUrlInspectorParams, shouldApplyFilter, requireSiteId,
} from './llmo-url-inspector.js';

function buildRpcParams(params) {
  return {
    p_site_id: params.siteId,
    p_start_date: params.startDate || null,
    p_end_date: params.endDate || null,
    p_category: shouldApplyFilter(params.category) ? params.category : null,
    p_region: shouldApplyFilter(params.region) ? params.region : null,
    p_platform: shouldApplyFilter(params.platform) ? params.platform : null,
    p_brand_id: params.brandId || null,
  };
}

function formatRow(row) {
  return {
    totalPromptsCited: Number(row.total_prompts_cited ?? 0),
    totalPrompts: Number(row.total_prompts ?? 0),
    uniqueUrls: Number(row.unique_urls ?? 0),
    totalCitations: Number(row.total_citations ?? 0),
  };
}

/**
 * GET /org/:spaceCatId/brands/:brandId/url-inspector/stats
 * Aggregate citation statistics and weekly sparkline trends.
 * Calls rpc_url_inspector_stats which returns an aggregate row (week IS NULL)
 * followed by per-week rows ordered chronologically.
 * @see elmo-ui/docs/api-specs/01-stats-cards.md
 */
export function createStatsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'stats',
    async (ctx, client) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      const rpcParams = buildRpcParams(params);
      const { data, error } = await client.rpc('rpc_url_inspector_stats', rpcParams);

      if (error) {
        ctx.log.error(`URL Inspector stats RPC error: ${error.message}`);
        return badRequest(error.message);
      }

      const rows = data || [];
      const aggRow = rows.find((r) => r.week === null);
      const weeklyRows = rows.filter((r) => r.week !== null);

      const agg = aggRow ? formatRow(aggRow) : formatRow({});

      const weeklyTrends = weeklyRows.map((row) => ({
        week: row.week,
        weekNumber: Number(row.week_number ?? 0),
        year: Number(row.year_val ?? 0),
        ...formatRow(row),
      }));

      return ok({
        ...agg,
        weeklyTrends,
      });
    },
  );
}
