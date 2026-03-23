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

const DEFAULT_LIMIT = 200;

function buildRpcParams(params) {
  return {
    p_site_id: params.siteId,
    p_start_date: params.startDate || null,
    p_end_date: params.endDate || null,
    p_category: shouldApplyFilter(params.category) ? params.category : null,
    p_region: shouldApplyFilter(params.region) ? params.region : null,
    p_channel: shouldApplyFilter(params.channel) ? params.channel : null,
    p_platform: shouldApplyFilter(params.platform) ? params.platform : null,
    p_brand_id: params.brandId || null,
  };
}

function mapRow(row) {
  return {
    domain: row.domain,
    totalCitations: Number(row.total_citations),
    totalUrls: Number(row.total_urls),
    promptsCited: Number(row.prompts_cited),
    contentType: row.content_type || 'unknown',
    categories: row.categories || '',
    regions: row.regions || '',
  };
}

/**
 * GET /org/:spaceCatId/brands/:brandId/url-inspector/cited-domains
 * Domain-level citation aggregations.
 * @see elmo-ui/docs/api-specs/04-cited-domains-table.md
 */
export function createCitedDomainsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'cited-domains',
    async (ctx, client) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      const rpcParams = buildRpcParams(params);
      const { data, error } = await client.rpc('rpc_url_inspector_cited_domains', rpcParams);

      if (error) {
        ctx.log.error(`URL Inspector cited-domains RPC error: ${error.message}`);
        return badRequest(error.message);
      }

      const allRows = (data || []).map(mapRow);
      const effectiveLimit = params.limit || DEFAULT_LIMIT;

      return ok({
        totalDomains: allRows.length,
        topDomains: allRows.slice(0, effectiveLimit),
        allDomains: params.includeAll ? allRows : [],
      });
    },
  );
}
