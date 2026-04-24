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

import {
  withBrandPresenceAuth,
  shouldApplyFilter,
  parseFilterDimensionsParams,
  defaultDateRange,
  parsePaginationParams,
  validateSiteBelongsToOrg,
  validateModel,
} from './llmo-brand-presence.js';

/**
 * URL Inspector handlers for org-based routes.
 * Queries mysticat-data-service PostgreSQL via PostgREST RPCs.
 *
 * All RPCs are site-scoped (p_site_id), so siteId is required.
 * Platform is optional — when absent, no model filter is applied (unlike brand-presence
 * endpoints which default to chatgpt-free).
 */

/**
 * Resolve platform/model from request. Returns null when absent (no default model).
 * When provided, validates against the llm_model enum.
 * @returns {{ model: string|null, error?: string }}
 */
function resolveUrlInspectorPlatform(params) {
  if (!shouldApplyFilter(params.model)) {
    return { model: null };
  }
  const result = validateModel(params.model);
  if (!result.valid) {
    return { model: null, error: result.error };
  }
  return { model: result.model };
}

/**
 * Stats card KPI → RPC name mapping. Each RPC returns rows shaped as
 * { week, week_number, year_val, value } where the week=null row is the
 * overall aggregate and the remaining rows are the per-week breakdown.
 *
 * The controller fans these four RPCs out in parallel (Promise.all) and
 * reassembles them into the response shape. See
 * mysticat-data-service/docs/plans/2026-04-02-url-inspector-performance.md
 * §6 Experiment 6 for why we split stats into four per-KPI RPCs instead of
 * a monolithic function (partition pruning, plan specialization per
 * brand_id branch, parallel fanout giving ~max-of-four latency).
 */
const URL_INSPECTOR_STATS_RPCS = [
  { key: 'totalPromptsCited', fn: 'rpc_url_inspector_total_prompts_cited' },
  { key: 'totalPrompts', fn: 'rpc_url_inspector_total_prompts' },
  { key: 'uniqueUrls', fn: 'rpc_url_inspector_unique_urls' },
  { key: 'totalCitations', fn: 'rpc_url_inspector_total_citations' },
];

/**
 * Creates the getUrlInspectorStats handler.
 * Aggregate citation statistics and weekly sparkline trends.
 * Returns an aggregate stats object plus per-week breakdown rows.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createUrlInspectorStatsHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'url-inspector-stats',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const defaults = defaultDateRange();

      if (!shouldApplyFilter(params.siteId)) {
        return badRequest('siteId is required for URL Inspector endpoints');
      }

      const siteBelongsToOrg = await validateSiteBelongsToOrg(
        client,
        spaceCatId,
        params.siteId,
      );
      if (!siteBelongsToOrg) {
        return forbidden('Site does not belong to the organization');
      }

      const { model, error: modelError } = resolveUrlInspectorPlatform(params);
      if (modelError) {
        return badRequest(modelError);
      }

      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;
      const rpcParams = {
        p_site_id: params.siteId,
        p_start_date: params.startDate || defaults.startDate,
        p_end_date: params.endDate || defaults.endDate,
        p_category: shouldApplyFilter(params.categoryId) ? params.categoryId : null,
        p_region: shouldApplyFilter(params.regionCode) ? params.regionCode : null,
        p_platform: model,
        p_brand_id: filterByBrandId,
      };

      let results;
      try {
        results = await Promise.all(
          URL_INSPECTOR_STATS_RPCS.map(({ fn }) => client.rpc(fn, rpcParams)),
        );
      } catch (e) {
        ctx.log.error(`URL Inspector stats RPC threw: ${e?.message || e}`);
        return internalServerError('Internal error processing URL Inspector stats');
      }

      const failedIndex = results.findIndex((r) => r.error);
      if (failedIndex !== -1) {
        const failedFn = URL_INSPECTOR_STATS_RPCS[failedIndex].fn;
        const { error: failedError } = results[failedIndex];
        const codePart = failedError.code ? ` [code=${failedError.code}]` : '';
        const detailsPart = failedError.details ? ` [details=${failedError.details}]` : '';
        const hintPart = failedError.hint ? ` [hint=${failedError.hint}]` : '';
        ctx.log.error(
          `URL Inspector stats RPC error (${failedFn}): ${failedError.message}${codePart}${detailsPart}${hintPart}`,
        );
        return internalServerError('Internal error processing URL Inspector stats');
      }

      const stats = {
        totalPromptsCited: 0,
        totalPrompts: 0,
        uniqueUrls: 0,
        totalCitations: 0,
      };
      const weeklyByKey = new Map();

      URL_INSPECTOR_STATS_RPCS.forEach(({ key }, idx) => {
        const rows = results[idx].data || [];
        rows.forEach((row) => {
          const value = Number(row.value ?? 0);
          if (row.week == null) {
            stats[key] = value;
            return;
          }
          let weekly = weeklyByKey.get(row.week);
          if (!weekly) {
            weekly = {
              week: row.week,
              totalPromptsCited: 0,
              totalPrompts: 0,
              uniqueUrls: 0,
              totalCitations: 0,
            };
            weeklyByKey.set(row.week, weekly);
          }
          weekly[key] = value;
        });
      });

      const weeklyTrends = [...weeklyByKey.values()].sort((a, b) => a.week.localeCompare(b.week));

      return ok({ stats, weeklyTrends });
    },
  );
}

/**
 * Creates the getUrlInspectorOwnedUrls handler.
 * Paginated per-URL citation aggregates with JSONB weekly arrays for WoW trends.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'url-inspector-owned-urls',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const pagination = parsePaginationParams(ctx, { defaultPageSize: 50 });
      const defaults = defaultDateRange();

      if (!shouldApplyFilter(params.siteId)) {
        return badRequest('siteId is required for URL Inspector endpoints');
      }

      const siteBelongsToOrg = await validateSiteBelongsToOrg(
        client,
        spaceCatId,
        params.siteId,
      );
      if (!siteBelongsToOrg) {
        return forbidden('Site does not belong to the organization');
      }

      const { model, error: modelError } = resolveUrlInspectorPlatform(params);
      if (modelError) {
        return badRequest(modelError);
      }

      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;
      const offset = pagination.page * pagination.pageSize;

      const { data, error } = await client.rpc('rpc_url_inspector_owned_urls', {
        p_site_id: params.siteId,
        p_start_date: params.startDate || defaults.startDate,
        p_end_date: params.endDate || defaults.endDate,
        p_category: shouldApplyFilter(params.categoryId) ? params.categoryId : null,
        p_region: shouldApplyFilter(params.regionCode) ? params.regionCode : null,
        p_platform: model,
        p_brand_id: filterByBrandId,
        p_limit: pagination.pageSize,
        p_offset: offset,
      });

      if (error) {
        ctx.log.error(`URL Inspector owned URLs RPC error: ${error.message}`);
        return internalServerError('Internal error processing URL Inspector owned URLs');
      }

      const rows = data || [];
      const totalCount = rows.length > 0 ? Number(rows[0].total_count ?? 0) : 0;

      const urls = rows.map((r) => ({
        url: r.url,
        citations: Number(r.citations ?? 0),
        promptsCited: Number(r.prompts_cited ?? 0),
        products: r.products || [],
        regions: r.regions || [],
        weeklyCitations: r.weekly_citations || [],
        weeklyPromptsCited: r.weekly_prompts_cited || [],
      }));

      return ok({ urls, totalCount });
    },
  );
}

/**
 * Creates the getUrlInspectorTrendingUrls handler.
 * Paginated non-owned URL citations with per-prompt breakdown.
 * The RPC returns flat rows (one per URL+prompt); this handler groups them by URL.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'url-inspector-trending-urls',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const pagination = parsePaginationParams(ctx, { defaultPageSize: 50 });
      const defaults = defaultDateRange();
      const q = ctx.data || /* c8 ignore next */ {};

      if (!shouldApplyFilter(params.siteId)) {
        return badRequest('siteId is required for URL Inspector endpoints');
      }

      const siteBelongsToOrg = await validateSiteBelongsToOrg(
        client,
        spaceCatId,
        params.siteId,
      );
      if (!siteBelongsToOrg) {
        return forbidden('Site does not belong to the organization');
      }

      const { model, error: modelError } = resolveUrlInspectorPlatform(params);
      if (modelError) {
        return badRequest(modelError);
      }

      const filterByBrandId = brandId && brandId !== 'all' ? brandId : null;
      const channel = q.channel || q.selectedChannel;
      const offset = pagination.page * pagination.pageSize;

      const { data, error } = await client.rpc('rpc_url_inspector_trending_urls', {
        p_site_id: params.siteId,
        p_start_date: params.startDate || defaults.startDate,
        p_end_date: params.endDate || defaults.endDate,
        p_category: shouldApplyFilter(params.categoryId) ? params.categoryId : null,
        p_region: shouldApplyFilter(params.regionCode) ? params.regionCode : null,
        p_channel: shouldApplyFilter(channel) ? channel : null,
        p_platform: model,
        p_limit: pagination.pageSize,
        p_brand_id: filterByBrandId,
        p_offset: offset,
      });

      if (error) {
        ctx.log.error(`URL Inspector trending URLs RPC error: ${error.message}`);
        return internalServerError('Internal error processing URL Inspector trending URLs');
      }

      const rows = (data || []).filter((row) => row.url != null);
      const totalNonOwnedUrls = rows.length > 0
        ? Number(rows[0].total_non_owned_urls ?? 0) : 0;

      const urlMap = new Map();
      for (const row of rows) {
        if (!urlMap.has(row.url)) {
          urlMap.set(row.url, {
            url: row.url,
            contentType: row.content_type || '',
            prompts: [],
          });
        }
        urlMap.get(row.url).prompts.push({
          prompt: row.prompt || '',
          category: row.category || '',
          region: row.region || '',
          topics: row.topics || '',
          citationCount: Number(row.citation_count ?? 0),
          executionCount: Number(row.execution_count ?? 0),
        });
      }

      // Calculate totalCitations per URL from its prompts
      const urls = Array.from(urlMap.values()).map((entry) => ({
        ...entry,
        totalCitations: entry.prompts.reduce((sum, p) => sum + p.citationCount, 0),
      }));

      return ok({ urls, totalNonOwnedUrls });
    },
  );
}

/**
 * Creates the getUrlInspectorCitedDomains handler.
 * Paginated domain-level citation aggregations with dominant content type.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createUrlInspectorCitedDomainsHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'url-inspector-cited-domains',
    async (ctx, client) => {
      const { spaceCatId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const pagination = parsePaginationParams(ctx, { defaultPageSize: 50 });
      const defaults = defaultDateRange();
      const q = ctx.data || /* c8 ignore next */ {};

      if (!shouldApplyFilter(params.siteId)) {
        return badRequest('siteId is required for URL Inspector endpoints');
      }

      const siteBelongsToOrg = await validateSiteBelongsToOrg(
        client,
        spaceCatId,
        params.siteId,
      );
      if (!siteBelongsToOrg) {
        return forbidden('Site does not belong to the organization');
      }

      const { model, error: modelError } = resolveUrlInspectorPlatform(params);
      if (modelError) {
        return badRequest(modelError);
      }

      const channel = q.channel || q.selectedChannel;
      const offset = pagination.page * pagination.pageSize;

      const { data, error } = await client.rpc('rpc_url_inspector_cited_domains', {
        p_site_id: params.siteId,
        p_start_date: params.startDate || defaults.startDate,
        p_end_date: params.endDate || defaults.endDate,
        p_category: shouldApplyFilter(params.categoryId) ? params.categoryId : null,
        p_region: shouldApplyFilter(params.regionCode) ? params.regionCode : null,
        p_channel: shouldApplyFilter(channel) ? channel : null,
        p_platform: model,
        p_limit: pagination.pageSize,
        p_offset: offset,
      });

      if (error) {
        ctx.log.error(`URL Inspector cited domains RPC error: ${error.message}`);
        return internalServerError('Internal error processing URL Inspector cited domains');
      }

      const rows = data || [];
      const totalCount = rows.length > 0
        ? Number(rows[0].total_count ?? 0) : 0;
      const domains = rows.map((r) => ({
        domain: r.domain || '',
        totalCitations: Number(r.total_citations ?? 0),
        totalUrls: Number(r.total_urls ?? 0),
        promptsCited: Number(r.prompts_cited ?? 0),
        contentType: r.content_type || '',
        categories: r.categories || '',
        regions: r.regions || '',
      }));

      return ok({ domains, totalCount });
    },
  );
}

/**
 * Creates the getUrlInspectorDomainUrls handler.
 * Phase 2 drilldown: paginated URLs within a specific domain.
 *
 * Note: the underlying RPC does not accept p_brand_id, p_category, or p_region.
 * Domain-level drilldown is already scoped by hostname; brand/category/region
 * filtering is applied at the parent level (cited-domains, stats).
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createUrlInspectorDomainUrlsHandler(
  getOrgAndValidateAccess,
) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'url-inspector-domain-urls',
    async (ctx, client) => {
      const { spaceCatId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const pagination = parsePaginationParams(ctx, { defaultPageSize: 50 });
      const defaults = defaultDateRange();
      const q = ctx.data || /* c8 ignore next */ {};

      if (!shouldApplyFilter(params.siteId)) {
        return badRequest('siteId is required for URL Inspector endpoints');
      }

      const hostname = q.hostname || q.domain;
      if (!hostname) {
        return badRequest('hostname is required for domain URL drilldown');
      }

      const siteBelongsToOrg = await validateSiteBelongsToOrg(
        client,
        spaceCatId,
        params.siteId,
      );
      if (!siteBelongsToOrg) {
        return forbidden('Site does not belong to the organization');
      }

      const { model, error: modelError } = resolveUrlInspectorPlatform(params);
      if (modelError) {
        return badRequest(modelError);
      }

      const channel = q.channel || q.selectedChannel;
      const offset = pagination.page * pagination.pageSize;

      const { data, error } = await client.rpc('rpc_url_inspector_domain_urls', {
        p_site_id: params.siteId,
        p_start_date: params.startDate || defaults.startDate,
        p_end_date: params.endDate || defaults.endDate,
        p_hostname: hostname,
        p_channel: shouldApplyFilter(channel) ? channel : null,
        p_platform: model,
        p_limit: pagination.pageSize,
        p_offset: offset,
      });

      if (error) {
        ctx.log.error(`URL Inspector domain URLs RPC error: ${error.message}`);
        return internalServerError('Internal error processing URL Inspector domain URLs');
      }

      const rows = data || [];
      const totalCount = rows.length > 0
        ? Number(rows[0].total_count ?? 0) : 0;

      const urls = rows.map((r) => ({
        urlId: r.url_id || '',
        url: r.url || '',
        contentType: r.content_type || '',
        citations: Number(r.citations ?? 0),
        promptsCited: Number(r.prompts_cited ?? 0),
        categories: r.categories || '',
        regions: r.regions || '',
      }));

      return ok({ urls, totalCount });
    },
  );
}

/**
 * Creates the getUrlInspectorUrlPrompts handler.
 * Phase 3 drilldown: prompts that cited a specific URL.
 *
 * Note: the underlying RPC does not accept p_brand_id, p_category, or p_region.
 * URL-level drilldown is scoped by url_id; broader filters are applied at
 * the parent level (cited-domains, stats).
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createUrlInspectorUrlPromptsHandler(
  getOrgAndValidateAccess,
) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'url-inspector-url-prompts',
    async (ctx, client) => {
      const { spaceCatId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const defaults = defaultDateRange();
      const q = ctx.data || /* c8 ignore next */ {};

      if (!shouldApplyFilter(params.siteId)) {
        return badRequest('siteId is required for URL Inspector endpoints');
      }

      const urlId = q.urlId || q.url_id;
      if (!urlId) {
        return badRequest('urlId is required for URL prompt breakdown');
      }

      const siteBelongsToOrg = await validateSiteBelongsToOrg(
        client,
        spaceCatId,
        params.siteId,
      );
      if (!siteBelongsToOrg) {
        return forbidden('Site does not belong to the organization');
      }

      const { model, error: modelError } = resolveUrlInspectorPlatform(params);
      if (modelError) {
        return badRequest(modelError);
      }

      const { data, error } = await client.rpc('rpc_url_inspector_url_prompts', {
        p_site_id: params.siteId,
        p_start_date: params.startDate || defaults.startDate,
        p_end_date: params.endDate || defaults.endDate,
        p_url_id: urlId,
        p_platform: model,
      });

      if (error) {
        ctx.log.error(`URL Inspector URL prompts RPC error: ${error.message}`);
        return internalServerError('Internal error processing URL Inspector URL prompts');
      }

      const rows = data || [];
      const prompts = rows.map((r) => ({
        prompt: r.prompt || '',
        category: r.category || '',
        region: r.region || '',
        topics: r.topics || '',
        citations: Number(r.citations ?? 0),
      }));

      return ok({ prompts });
    },
  );
}

/**
 * Creates the getUrlInspectorFilterDimensions handler.
 * Returns the distinct set of categories, regions, and content types present in
 * url_inspector_domain_stats for the given site and date range. Used to hydrate
 * the top-of-page Category, Region, and Channel filter dropdowns on the URL
 * Inspector PG dashboard.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'url-inspector-filter-dimensions',
    async (ctx, client) => {
      const { spaceCatId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const defaults = defaultDateRange();

      if (!shouldApplyFilter(params.siteId)) {
        return badRequest('siteId is required for URL Inspector endpoints');
      }

      const siteBelongsToOrg = await validateSiteBelongsToOrg(
        client,
        spaceCatId,
        params.siteId,
      );
      if (!siteBelongsToOrg) {
        return forbidden('Site does not belong to the organization');
      }

      const { model, error: modelError } = resolveUrlInspectorPlatform(params);
      if (modelError) {
        return badRequest(modelError);
      }

      const { data, error } = await client.rpc('rpc_url_inspector_filter_dimensions', {
        p_site_id: params.siteId,
        p_start_date: params.startDate || defaults.startDate,
        p_end_date: params.endDate || defaults.endDate,
        p_platform: model,
        p_brand_id: shouldApplyFilter(params.brandId) ? params.brandId : null,
      });

      if (error) {
        ctx.log.error(`URL Inspector filter dimensions RPC error: ${error.message}`);
        return internalServerError('Internal error processing URL Inspector filter dimensions');
      }

      return ok(data);
    },
  );
}
