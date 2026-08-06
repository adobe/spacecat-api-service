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
  badRequest, forbidden, internalServerError,
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
import { parseAgentTypes } from './llmo-agent-types.js';
import { cachedOk } from '../../support/cached-response.js';
import { resolveBrandUuid } from '../../support/prompts-storage.js';
import { resolveBrandWorkspace } from '../../support/serenity/workspace-resolver.js';
import { createElementsTransport } from '../../support/elements/elements-transport.js';
import { createElementsService } from '../../support/elements/elements-service.js';
import { resolveSemrushImsToken } from '../../support/utils.js';

/**
 * URL Inspector handlers for org-based routes.
 * Queries mysticat-data-service PostgreSQL via PostgREST RPCs.
 *
 * All RPCs are site-scoped (p_site_id), so siteId is required.
 *
 * Platform handling (LLMO-4525 review clarification):
 *   - The caller may send `platform`/`model` as a query parameter. If absent
 *     (or set to one of the `shouldApplyFilter` "no filter" sentinels), the
 *     RPC is called with `p_platform = NULL`, which means
 *     "do not filter by model". This differs from brand-presence endpoints
 *     which default to `chatgpt-free`.
 *   - When provided, the value is normalised via `validateModel`
 *     (see llmo-brand-presence.js → MODEL_QUERY_ALIASES), so alias strings
 *     like `'openai'` are mapped to the canonical enum
 *     (`'chatgpt-paid'`). Unknown values return 400.
 *
 * Brand scoping:
 *   - `brandId` is read from ctx.params (path segment), NOT from query string.
 *   - `brandId === 'all'` or missing → no brand filter (`p_brand_id = NULL`).
 */

// Mirror the referral controller's source whitelist (LLMO-4261).
// Used by the owned-urls handler to forward `p_referral_source` to
// `rpc_url_inspector_owned_urls` (LLMO-4729 Decision A pull-in). When the
// caller supplies an unknown value we collapse it to `'optel'` for parity
// with /url-inspector. When the caller does not supply a value at all we
// return `undefined` so the handler can OMIT the parameter entirely — this
// keeps the RPC contract back-compat with mysticat builds that pre-date
// LLMO-4729 (the older 8/9-arg signature would 404 with PGRST202 on an
// unknown 10th positional parameter), and PostgREST then applies the
// function's own `DEFAULT 'optel'` on the new build. Mirrors the same
// "omit when absent" pattern used for `p_agent_types` (LLMO-4526).
const VALID_REFERRAL_SOURCES = new Set(['optel', 'cdn', 'adobe_analytics', 'ga4', 'cja']);
const DEFAULT_REFERRAL_SOURCE = 'optel';

function parseReferralSource(q) {
  const raw = q.referralSource ?? q.referral_source;
  if (!raw) {
    return undefined;
  }
  return VALID_REFERRAL_SOURCES.has(raw) ? raw : DEFAULT_REFERRAL_SOURCE;
}

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

      return cachedOk({ stats, weeklyTrends });
    },
  );
}

/**
 * Creates the getUrlInspectorOwnedUrls handler.
 * Paginated per-URL citation aggregates with JSONB weekly arrays for WoW trends.
 *
 * Server-side agentic merge (LLMO-4526 multi-persona PR review M2): each row
 * carries `agenticHits` and `agenticHitsTrend` joined from
 * `agentic_traffic_weekly` for the same site / date range, scoped by an
 * optional `agentTypes` inclusion list. Before this lived in the UI, the
 * dashboard merged a separate by-URL agentic call that capped at 500 rows,
 * so owned URLs ranked beyond the top 500 silently showed `agenticHits = 0`.
 * Doing the JOIN in the RPC means the table can paginate 50 owned URLs at a
 * time without losing fidelity.
 *
 * Server-side referral merge (LLMO-4729 Decision A pull-in): each row also
 * carries `referralHits` and `referralHitsTrend` joined from
 * `referral_traffic_<source>` for the same site / date range, scoped by the
 * `referralSource` query param (default `'optel'`). Replaces the always-N/A
 * Referral Hits column the table used to render before this work landed.
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
      const offset = pagination.page * pagination.pageSize;
      const agentTypes = parseAgentTypes(q.agentTypes ?? q.agent_types);
      const referralSource = parseReferralSource(q);

      // Only forward p_agent_types and p_referral_source when the caller
      // actually supplied a value. Omitting them keeps the RPC contract
      // compatible with internal tooling (and the integration-test image)
      // that pre-dates the additive parameters (LLMO-4526 added
      // p_agent_types; LLMO-4729 added p_referral_source). The new RPC has
      // DEFAULT 'optel' on p_referral_source, so the omitted-param path
      // still reads from referral_traffic_optel server-side.
      const rpcParams = {
        p_site_id: params.siteId,
        p_start_date: params.startDate || defaults.startDate,
        p_end_date: params.endDate || defaults.endDate,
        p_category: shouldApplyFilter(params.categoryId) ? params.categoryId : null,
        p_region: shouldApplyFilter(params.regionCode) ? params.regionCode : null,
        p_platform: model,
        p_brand_id: filterByBrandId,
        p_limit: pagination.pageSize,
        p_offset: offset,
      };
      if (agentTypes) {
        rpcParams.p_agent_types = agentTypes;
      }
      if (referralSource !== undefined) {
        rpcParams.p_referral_source = referralSource;
      }

      const { data, error } = await client.rpc('rpc_url_inspector_owned_urls', rpcParams);

      if (error) {
        ctx.log.error(`URL Inspector owned URLs RPC error: ${error.message}`);
        return internalServerError('Internal error processing URL Inspector owned URLs');
      }

      const rows = data || [];
      const totalCount = rows.length > 0 ? Number(rows[0].total_count ?? 0) : 0;

      const urls = rows.map((r) => ({
        // url_id is the real source_urls.id (LLMO-5992). The URL Details
        // "Prompt Analysis" drilldown forwards it as p_url_id to
        // rpc_url_inspector_url_prompts; without it the dashboard synthesised a
        // fake id that failed the uuid parse and returned no prompts. Mirrors
        // getUrlInspectorDomainUrls. Empty-string fallback keeps the shape
        // stable if an older RPC build (pre-url_id) is deployed.
        urlId: r.url_id || '',
        url: r.url,
        citations: Number(r.citations ?? 0),
        promptsCited: Number(r.prompts_cited ?? 0),
        products: r.products || [],
        regions: r.regions || [],
        weeklyCitations: r.weekly_citations || [],
        weeklyPromptsCited: r.weekly_prompts_cited || [],
        agenticHits: Number(r.agentic_hits ?? 0),
        agenticHitsTrend: Array.isArray(r.agentic_hits_trend)
          ? r.agentic_hits_trend.map((point) => ({
            weekStart: point.week_start ?? null,
            value: Number(point.value ?? 0),
          }))
          : [],
        referralHits: Number(r.referral_hits ?? 0),
        referralHitsTrend: Array.isArray(r.referral_hits_trend)
          ? r.referral_hits_trend.map((point) => ({
            weekStart: point.week_start ?? null,
            value: Number(point.value ?? 0),
          }))
          : [],
      }));

      return cachedOk({ urls, totalCount });
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

      return cachedOk({ urls, totalNonOwnedUrls });
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

      return cachedOk({ domains, totalCount });
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

      return cachedOk({ urls, totalCount });
    },
  );
}

/**
 * Fetches prompts that cited `urlId` via rpc_url_inspector_url_prompts.
 * Shared by createUrlInspectorUrlPromptsHandler and
 * createUrlInspectorPromptsByUrlHandler.
 * @param {object} client - PostgREST client.
 * @param {object} log - Logger.
 * @param {{siteId: string, urlId: string, startDate: string, endDate: string,
 *   model: string|null}} rpcInputs
 * @returns {Promise<{prompts: Array<object>}|{error: object}>}
 */
async function fetchUrlPromptsViaMysticat(client, log, {
  siteId, urlId, startDate, endDate, model,
}) {
  const { data, error } = await client.rpc('rpc_url_inspector_url_prompts', {
    p_site_id: siteId,
    p_start_date: startDate,
    p_end_date: endDate,
    p_url_id: urlId,
    p_platform: model,
  });

  if (error) {
    // 22P02 (invalid uuid) happens with synthetic url_ids from the owned-urls
    // dashboard fallback (LLMO-4526) — treat as empty, not an error.
    if (error.code === '22P02' || /invalid input syntax for( type)? uuid/i.test(error.message)) {
      log.info(`URL Inspector URL prompts: invalid url_id "${urlId}" — returning empty prompt list`);
      return { prompts: [] };
    }
    log.error(`URL Inspector URL prompts RPC error: ${error.message}`);
    return { error: internalServerError('Internal error processing URL Inspector URL prompts') };
  }

  const rows = data || [];
  const prompts = rows.map((r) => ({
    prompt: r.prompt || '',
    category: r.category || '',
    region: r.region || '',
    topics: r.topics || '',
    citations: Number(r.citations ?? 0),
  }));

  return { prompts };
}

/**
 * Fetches prompts that cited `url` via rpc_url_inspector_prompts_by_url,
 * which resolves the URL to a source_urls.id internally (no domain-urls
 * pagination needed).
 * @param {object} client - PostgREST client.
 * @param {object} log - Logger.
 * @param {{siteId: string, url: string, startDate: string, endDate: string,
 *   model: string|null}} rpcInputs
 * @returns {Promise<{prompts: Array<object>}|{error: object}>}
 */
async function fetchUrlPromptsByUrlViaMysticat(client, log, {
  siteId, url, startDate, endDate, model,
}) {
  const { data, error } = await client.rpc('rpc_url_inspector_prompts_by_url', {
    p_site_id: siteId,
    p_url: url,
    p_start_date: startDate,
    p_end_date: endDate,
    p_platform: model,
  });

  if (error) {
    log.error(`URL Inspector prompts-by-url RPC error: ${error.message}`);
    return { error: internalServerError('Internal error processing URL Inspector prompts') };
  }

  const rows = data || [];
  const prompts = rows.map((r) => ({
    prompt: r.prompt || '',
    category: r.category || '',
    region: r.region || '',
    topics: r.topics || '',
    citations: Number(r.citations ?? 0),
  }));

  return { prompts };
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

      const result = await fetchUrlPromptsViaMysticat(client, ctx.log, {
        siteId: params.siteId,
        urlId,
        startDate: params.startDate || defaults.startDate,
        endDate: params.endDate || defaults.endDate,
        model,
      });
      if (result.error) {
        return result.error;
      }
      return cachedOk({ prompts: result.prompts });
    },
  );
}

/**
 * True only when brandId resolves to a real brand with its own active
 * Semrush sub-workspace — a flat-mode brand (shared parent workspace) is
 * never eligible, since prompts/projects live only in a brand's own
 * sub-workspace.
 * @param {object} ctx - Request context.
 * @param {string} spaceCatId - SpaceCat organization UUID.
 * @param {string} brandId - Brand id/name from the route (path param).
 * @param {object} client - PostgREST client (also usable as postgrestClient).
 * @returns {Promise<{eligible: boolean, workspaceId?: string}>}
 */
async function resolveSemrushEligibility(ctx, spaceCatId, brandId, client) {
  if (!brandId || brandId === 'all') {
    return { eligible: false };
  }
  const brandUuid = await resolveBrandUuid(spaceCatId, brandId, client);
  if (!brandUuid) {
    return { eligible: false };
  }
  const { mode, workspaceId, parentWorkspaceId } = await resolveBrandWorkspace(
    ctx,
    spaceCatId,
    brandUuid,
  );
  if (mode !== 'subworkspace') {
    return { eligible: false };
  }
  if (workspaceId === parentWorkspaceId) {
    ctx.log.error('url-inspector-prompts-by-url: brand sub-workspace equals org parent workspace - refusing', {
      brandUuid, spaceCatId, workspaceId,
    });
    return { eligible: false };
  }
  return { eligible: true, workspaceId };
}

/**
 * "Prompts that cited this URL", routed to Semrush (if eligible and `url`
 * given), else the urlId-based RPC (if `urlId` given), else the single-hop
 * by-url RPC. Both RPC branches share the same 28-day default date range.
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 */
export function createUrlInspectorPromptsByUrlHandler(
  getOrgAndValidateAccess,
) {
  return (context) => withBrandPresenceAuth(
    context,
    getOrgAndValidateAccess,
    'url-inspector-prompts-by-url',
    async (ctx, client) => {
      const { spaceCatId, brandId } = ctx.params;
      const params = parseFilterDimensionsParams(ctx);
      const defaults = defaultDateRange();
      const q = ctx.data || /* c8 ignore next */ {};

      if (!shouldApplyFilter(params.siteId)) {
        return badRequest('siteId is required for URL Inspector endpoints');
      }

      const { url } = q;
      const urlId = q.urlId || q.url_id;
      if (!url && !urlId) {
        return badRequest('Either url or urlId is required for URL prompt breakdown');
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

      const startDate = params.startDate || defaults.startDate;
      const endDate = params.endDate || defaults.endDate;

      const { eligible, workspaceId } = url
        ? await resolveSemrushEligibility(ctx, spaceCatId, brandId, client)
        : { eligible: false };

      if (eligible) {
        try {
          const imsToken = await resolveSemrushImsToken(ctx, ctx.log, 'url-inspector-prompts-by-url');
          const service = createElementsService(
            createElementsTransport({ env: ctx.env, imsToken }),
            ctx.log,
          );
          const prompts = await service.getUrlPrompts(workspaceId, {
            url, model, startDate, endDate, projectIds: [],
          });
          return cachedOk({ prompts });
        } catch (e) {
          ctx.log.error(`URL Inspector prompts-by-url Semrush error: ${e?.message || e}`);
          return internalServerError('Internal error processing URL Inspector prompts');
        }
      }

      const result = urlId
        ? await fetchUrlPromptsViaMysticat(client, ctx.log, {
          siteId: params.siteId, urlId, startDate, endDate, model,
        })
        : await fetchUrlPromptsByUrlViaMysticat(client, ctx.log, {
          siteId: params.siteId, url, startDate, endDate, model,
        });
      if (result.error) {
        return result.error;
      }
      return cachedOk({ prompts: result.prompts });
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
      // NOTE (LLMO-4525 review — major finding):
      // Previously this handler pulled `params.brandId` from
      // `parseFilterDimensionsParams(ctx)`, which reads ctx.data (query string)
      // and does NOT include brandId. The path parameter `:brandId` was
      // silently dropped, so `p_brand_id` was always `null` regardless of
      // whether the caller hit `/brands/:brandId/...` or `/brands/all/...`.
      // Align with the other URL Inspector handlers (stats, owned-urls,
      // trending-urls, etc.) which read `brandId` from `ctx.params` and
      // treat `'all'` as "no filter".
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
        p_platform: model,
        p_brand_id: filterByBrandId,
      };

      let response;
      try {
        response = await client.rpc('rpc_url_inspector_filter_dimensions', rpcParams);
      } catch (e) {
        // Defence in depth (LLMO-4525 review — security/junior-dev):
        // the PostgREST client is expected to return `{ data, error }` rather
        // than throw, but if the transport layer itself fails (TCP reset,
        // JSON parse, etc.) we must not leak a raw error to the caller.
        ctx.log.error(
          `URL Inspector filter dimensions RPC threw: ${e?.message || e}`,
          {
            route: 'url-inspector-filter-dimensions',
            siteId: params.siteId,
            startDate: rpcParams.p_start_date,
            endDate: rpcParams.p_end_date,
            platform: rpcParams.p_platform,
            hasBrandIdFilter: filterByBrandId !== null,
          },
        );
        return internalServerError('Internal error processing URL Inspector filter dimensions');
      }

      const { data, error } = response;

      if (error) {
        // LLMO-4525 review — tester/architect finding:
        // log code/details/hint so we can triage PostgREST errors
        // (invalid enum values, missing grants, etc.) without shell access
        // to the DB. Mirrors the stats handler's enriched error shape.
        const codePart = error.code ? ` [code=${error.code}]` : '';
        const detailsPart = error.details ? ` [details=${error.details}]` : '';
        const hintPart = error.hint ? ` [hint=${error.hint}]` : '';
        ctx.log.error(
          `URL Inspector filter dimensions RPC error: ${error.message}${codePart}${detailsPart}${hintPart}`,
          {
            route: 'url-inspector-filter-dimensions',
            siteId: params.siteId,
            startDate: rpcParams.p_start_date,
            endDate: rpcParams.p_end_date,
            platform: rpcParams.p_platform,
            hasBrandIdFilter: filterByBrandId !== null,
          },
        );
        return internalServerError('Internal error processing URL Inspector filter dimensions');
      }

      return cachedOk(data);
    },
  );
}
