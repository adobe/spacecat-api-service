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
  withUrlInspectorAuth, parseUrlInspectorParams, requireSiteId, shouldApplyFilter,
} from './llmo-url-inspector.js';

/**
 * Computes a WoW trend from a sorted array of { week, value } objects.
 * Compares the last two entries to determine direction.
 * @param {Array<{week: string, value: number}>} weeklyValues
 * @returns {{ direction: string, hasValidComparison: boolean, weeklyValues: Array }}
 */
export function computeTrend(weeklyValues) {
  const sorted = [...(weeklyValues || [])].sort((a, b) => a.week.localeCompare(b.week));

  if (sorted.length < 2) {
    return { direction: 'neutral', hasValidComparison: false, weeklyValues: sorted };
  }

  const prev = sorted[sorted.length - 2].value;
  const latest = sorted[sorted.length - 1].value;

  let direction = 'neutral';
  if (latest > prev) direction = 'up';
  else if (latest < prev) direction = 'down';

  return { direction, hasValidComparison: true, weeklyValues: sorted };
}

/**
 * GET /org/:spaceCatId/brands/:brandId/url-inspector/owned-urls
 * Owned URL citation data with per-URL WoW trend indicators.
 * @see elmo-ui/docs/api-specs/02-owned-urls-table.md
 */
export function createOwnedUrlsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'owned-urls',
    async (ctx, client) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      const rpcParams = {
        p_site_id: params.siteId,
        p_start_date: params.startDate || null,
        p_end_date: params.endDate || null,
        p_category: shouldApplyFilter(params.category) ? params.category : null,
        p_region: shouldApplyFilter(params.region) ? params.region : null,
        p_platform: shouldApplyFilter(params.platform) ? params.platform : null,
        p_brand_id: params.brandId || null,
      };

      const { data, error } = await client.rpc('rpc_url_inspector_owned_urls', rpcParams);

      if (error) {
        ctx.log.error(`URL Inspector owned-urls RPC error: ${error.message}`);
        return badRequest(error.message);
      }

      const rows = data || [];

      const urls = rows.map((row) => ({
        url: row.url,
        citations: Number(row.citations),
        promptsCited: Number(row.prompts_cited),
        products: row.products || [],
        regions: row.regions || [],
        contentType: 'owned',
        citationsTrend: computeTrend(row.weekly_citations),
        promptsCitedTrend: computeTrend(row.weekly_prompts_cited),
      }));

      return ok({ urls });
    },
  );
}
