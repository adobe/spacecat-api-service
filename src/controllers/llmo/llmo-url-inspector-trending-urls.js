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

const DEFAULT_LIMIT = 50;

const CONTENT_TYPE_MAP = {
  competitor: 'others',
};

const CHANNEL_TO_DB = {
  others: 'competitor',
};

function mapContentType(dbValue) {
  return CONTENT_TYPE_MAP[dbValue] || dbValue;
}

/**
 * Transforms flat prompt-level RPC rows into the nested trending-URLs response.
 * Each row has: total_non_owned_urls, url, content_type, prompt, category, region,
 * topics, citation_count, execution_count.
 */
export function assembleResponse(rows) {
  if (!rows || rows.length === 0) {
    return { totalNonOwnedUrls: 0, urls: [] };
  }

  const totalNonOwnedUrls = Number(rows[0].total_non_owned_urls) || 0;

  const urlMap = new Map();

  for (const row of rows) {
    const { url, content_type: ct } = row;
    if (!urlMap.has(url)) {
      urlMap.set(url, {
        url,
        contentType: mapContentType(ct),
        citations: 0,
        promptsSet: new Set(),
        productsSet: new Set(),
        regionsSet: new Set(),
        promptCitations: [],
      });
    }

    const entry = urlMap.get(url);
    const count = Number(row.citation_count) || 0;
    entry.citations += count;

    const promptKey = `${row.prompt}|${row.region}|${row.topics}`;
    entry.promptsSet.add(promptKey);

    if (row.category) entry.productsSet.add(row.category);
    if (row.region) entry.regionsSet.add(row.region);

    entry.promptCitations.push({
      prompt: row.prompt,
      count,
      id: `${row.category || ''}_${row.prompt || ''}_${row.region || ''}`,
      products: row.category ? [row.category] : [],
      topics: row.topics || '',
      region: row.region || '',
      executionCount: Number(row.execution_count) || 0,
    });
  }

  const urls = Array.from(urlMap.values())
    .map(({
      promptsSet, productsSet, regionsSet, ...rest
    }) => ({
      ...rest,
      promptsCited: promptsSet.size,
      products: Array.from(productsSet),
      regions: Array.from(regionsSet),
    }))
    .sort((a, b) => b.citations - a.citations);

  return { totalNonOwnedUrls, urls };
}

/**
 * GET /org/:spaceCatId/brands/:brandId/url-inspector/trending-urls
 * Non-owned URL citations sorted by citation count.
 * @see elmo-ui/docs/api-specs/03-trending-urls-table.md
 */
export function createTrendingUrlsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'trending-urls',
    async (ctx, client) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      const limit = params.limit || DEFAULT_LIMIT;
      const offset = params.offset || 0;

      const rpcParams = {
        p_site_id: params.siteId,
        p_start_date: params.startDate,
        p_end_date: params.endDate,
        p_category: shouldApplyFilter(params.category) ? params.category : null,
        p_region: shouldApplyFilter(params.region) ? params.region : null,
        p_channel: shouldApplyFilter(params.channel)
          ? (CHANNEL_TO_DB[params.channel] || params.channel)
          : null,
        p_platform: shouldApplyFilter(params.platform) ? params.platform : null,
        p_limit: limit,
        p_brand_id: params.brandId || null,
        p_offset: offset,
      };

      const { data, error } = await client.rpc('rpc_url_inspector_trending_urls', rpcParams);

      if (error) {
        ctx.log.error(`URL Inspector trending-urls RPC error: ${error.message}`);
        return badRequest(error.message);
      }

      const { totalNonOwnedUrls, urls } = assembleResponse(data);
      return ok({
        totalNonOwnedUrls,
        urls,
        pagination: { limit, offset, total: totalNonOwnedUrls },
      });
    },
  );
}
