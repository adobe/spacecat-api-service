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

import { ELEMENT_IDS } from './element-ids.js';
import { mapWithConcurrency } from './concurrency.js';
import { splitDateRangeIntoWeeksBackward } from './week-utils.js';
import {
  buildBrandsPayload,
  transformBrandsToFilterDimensions,
  buildMarketsPayload,
  transformMarketsToFilterDimensions,
  buildTopicsPayload,
  transformTopicsForFilterDimensions,
  transformCategoriesToFilterDimensions,
  transformIntentsToFilterDimensions,
  transformOriginsToFilterDimensions,
  transformOtherTagsForFilterDimensions,
  buildWeeksPayload,
  transformWeeksResponse,
  buildPromptsPayload,
  transformPromptsResponse,
  buildCitedDomainsPayload,
  transformCitedDomainsResponse,
  buildSentimentOverviewPayload,
  transformSentimentOverviewResponse,
  buildOwnedUrlsStatsPayload,
  buildOwnedUrlsTrendPayload,
  transformOwnedUrlsResponse,
  buildDomainUrlsPayload,
  transformDomainUrlsResponse,
  buildMarketMentionsTrendPayload,
  buildMarketCitationsTrendPayload,
  transformMarketTrackingTrends,
  buildStatsTotalExecutionsPayload,
  transformStatsTotalExecutionsResponse,
  buildStatsMentionsPayload,
  transformStatsMentionsResponse,
  buildStatsVisibilityPayload,
  transformStatsVisibilityResponse,
  buildStatsCitationsPayload,
  transformStatsCitationsResponse,
} from './definitions/index.js';

// Bounds parallel per-week upstream fan-out for the /stats trends array (up to
// TRENDS_MAX_WEEKS=8 weeks x 4 element calls each) so a wide date range can't
// spawn an unbounded number of parallel Semrush requests.
const STATS_TRENDS_WEEK_CONCURRENCY = 4;

/**
 * Creates the Elements service that composes transport calls with per-element
 * payload builders and response transformers.
 *
 * @param {object} transport - Elements transport created by createElementsTransport().
 */
export function createElementsService(transport) {
  return {
    /**
     * Fetches filter dimensions for the URL Inspector dashboard.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query parameters (startDate, endDate, model, etc.).
     * @param {Array<{id: string, name: string}>} [spacecatBrands=[]] - SpaceCat brands for the org,
     *   used to resolve `spacecat_brand_id` on each brand entry by name match.
     * @returns {Promise<object>}
     */
    async getUrlInspectorFilterDimensions(
      workspaceId,
      params,
      spacecatBrands = [],
      brandSemrushProjects = [],
    ) {
      const [rawTopics, rawBrands, rawMarkets] = await Promise.all([
        transport.fetchElement(workspaceId, ELEMENT_IDS.TOPICS, buildTopicsPayload(params)),
        transport.fetchElement(workspaceId, ELEMENT_IDS.BRANDS, buildBrandsPayload(params)),
        transport.fetchElement(workspaceId, ELEMENT_IDS.MARKETS, buildMarketsPayload({})),
      ]);
      const result = {
        brands: transformBrandsToFilterDimensions(rawBrands, spacecatBrands),
        regions: transformMarketsToFilterDimensions(rawMarkets, brandSemrushProjects),
        topics: transformTopicsForFilterDimensions(rawTopics),
        categories: transformCategoriesToFilterDimensions(rawTopics),
        page_intents: transformIntentsToFilterDimensions(rawTopics),
        origins: transformOriginsToFilterDimensions(rawTopics),
      };
      // Merge any tag types not covered above (e.g. `type:branded`) under their own
      // prefix key, and plain prefix-less tags under `tags` — see
      // transformOtherTagsForFilterDimensions. The reserved-key list is derived
      // from `result`'s own keys (not hand-duplicated) so it can't drift out of
      // sync if a key here is ever renamed or a new fixed dimension is added.
      // `__proto__`/`constructor`/`prototype` are added on top: `result[key] = ...`
      // below would repoint result's prototype instead of adding a property for
      // those (rather than dropping such tags, routing them as "reserved" sends
      // them into the generic `tags` array, same as any other collision).
      const reservedResultKeys = [
        ...Object.keys(result), 'tags', '__proto__', 'constructor', 'prototype',
      ];
      const { tags, ...otherGroups } = transformOtherTagsForFilterDimensions(
        rawTopics,
        reservedResultKeys,
      );
      Object.entries(otherGroups).forEach(([key, items]) => {
        result[key] = items;
      });
      result.tags = tags;
      return result;
    },

    /**
     * Fetches the list of weeks that have Brand Presence data (week filter dropdown).
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query parameters (model, etc.).
     * @returns {Promise<object>} `{ weeks: [{ week, startDate, endDate }] }`.
     */
    /* c8 ignore start -- LLMO-6011 POC endpoint; unit tests intentionally deferred */
    async getWeeks(workspaceId, params) {
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.WEEKS,
        buildWeeksPayload(params),
      );
      return { weeks: transformWeeksResponse(raw) };
    },
    /* c8 ignore stop */

    /**
     * Fetches the prompts matching the given filters, plus their count.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Filter parameters (model/platform, topics, projectIds).
     * @returns {Promise<{count: number, prompts: object[]}>} `{ count, prompts }`.
     */
    async getPrompts(workspaceId, params) {
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.PROMPTS,
        buildPromptsPayload(params),
      );
      return transformPromptsResponse(raw);
    },

    /**
     * Fetches domains most frequently cited alongside owned URLs (URL Inspector
     * Cited Domains panel), backed by element 98b91d00 ("Stats per Domain").
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query params (model/platform, brand, startDate, endDate,
     *   page, pageSize).
     * @returns {Promise<object>} Legacy contract `{ domains: [...], totalCount }`.
     */
    /* c8 ignore start -- LLMO-6020 POC endpoint; unit tests intentionally deferred */
    async getCitedDomains(workspaceId, params) {
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.CITED_DOMAINS,
        buildCitedDomainsPayload(params),
      );
      return transformCitedDomainsResponse(raw, params);
    },

    /**
     * Fetches per-week brand sentiment (positive/neutral/negative) from the Sentiment
     * element (f4153af8…), transformed into the legacy Brand Presence
     * `sentiment-overview` contract `{ weeklyTrends: [...] }`.
     *
     * Single call (like getCitedDomains, not a per-project fan-out): the element returns
     * an aggregate daily sentiment breakdown that we roll up to ISO weeks. Region scoping,
     * when requested, is a top-level `project_id` on the payload (resolved by the controller
     * via resolveRegionProjectId); region=all/absent → the brand's whole sub-workspace.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query params (model/platform, startDate, endDate, category,
     *   projectId).
     * @returns {Promise<{ weeklyTrends: object[] }>} Legacy contract.
     */
    async getSentimentOverview(workspaceId, params) {
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.SENTIMENT,
        buildSentimentOverviewPayload(params),
      );
      return transformSentimentOverviewResponse(raw);
    },

    /**
     * Resolves a URL Inspector `region` code (e.g. `US`) to its Semrush `project_id` for the
     * given brand, by fetching the Markets element and matching the region label + brand.
     * Semrush projects are unique per (brand, market), so the resulting project_id scopes
     * subsequent element calls to that brand + region via a top-level `project_id`.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} opts
     * @param {string} [opts.brandId] - SpaceCat brand UUID for the site; used only as a
     *   tiebreaker when several brands have a project for the same region.
     * @param {string} opts.region - UI region code (e.g. `US`).
     * @param {object[]} [opts.brandSemrushProjects] - Flattened BrandSemrushProject rows for
     *   ALL org brands (the site's own brand may not own any Semrush projects), used to
     *   enrich/match the Markets response.
     * @returns {Promise<string|null>} The matching `semrush_project_id`, or null if none.
     */
    async resolveRegionProjectId(workspaceId, {
      brandId, region, brandSemrushProjects = [],
    }) {
      // Fetch markets workspace-wide (mirrors getUrlInspectorFilterDimensions) — a
      // brand-scoped Markets call (CBF_ws_brand) can come back empty when the Semrush
      // brand value differs from our brand name.
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.MARKETS,
        buildMarketsPayload({}),
      );
      const regions = transformMarketsToFilterDimensions(raw, brandSemrushProjects);
      const wanted = String(region).toLowerCase();
      const matches = regions.filter((r) => r.semrush_project_id
        && String(r.id ?? '').toLowerCase() === wanted);
      if (matches.length === 0) {
        return null;
      }
      // Prefer the site's brand when it owns a project for this region; else first match.
      const preferred = matches.find((r) => r.spacecat_brand_id === brandId);
      return (preferred ?? matches[0]).semrush_project_id;
    },

    /**
     * Resolves every (region, projectId) pair for the workspace, used to fan the
     * owned-urls query out per-project. Per-project scoping keeps each element
     * call under the Semrush 50k-row cap (a workspace-wide call hit it) and lets
     * the transform tag each URL with the region it was cited in. Reuses the
     * Markets element + transform (same as resolveRegionProjectId).
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} [opts]
     * @param {object[]} [opts.brandSemrushProjects] - Flattened BrandSemrushProject
     *   rows, to enrich/match the Markets response.
     * @returns {Promise<Array<{region: string, projectId: string}>>}
     */
    async getOwnedUrlProjects(workspaceId, { brandSemrushProjects = [] } = {}) {
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.MARKETS,
        buildMarketsPayload({}),
      );
      return transformMarketsToFilterDimensions(raw, brandSemrushProjects)
        .filter((r) => r.semrush_project_id)
        .map((r) => ({ region: r.id, projectId: r.semrush_project_id }));
    },

    /**
     * Fetches the URL Inspector Owned URLs table (citations + weekly trends) from
     * Semrush, backed by Stats-per-URL (9af5ed83) + URL trend (afb2e5d3). Fans out
     * per project (region) — each project stays under the 50k-row cap and carries
     * its region — fetching both elements in parallel, then merges to the legacy
     * shape. Returns the FULL owned list sorted by citations desc; the controller
     * paginates client-side and joins agentic/referral traffic for the page.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params
     * @param {Array<{region?: string, projectId?: string}>} [params.projects] -
     *   Projects to query. Empty → one unscoped (workspace-wide) fetch.
     * @param {string} [params.model] / [params.platform] - AI model filter.
     * @param {string} params.startDate / params.endDate - Required YYYY-MM-DD.
     * @param {string} [params.category] - Category tag filter.
     * @returns {Promise<object[]>} Full owned-URL list (no traffic, no slice).
     */
    async getOwnedUrls(workspaceId, {
      projects = [], model, platform, startDate, endDate, category,
    }) {
      const scopes = projects.length > 0 ? projects : [{}];
      // Bound the per-project fan-out (2 element calls each) so a brand with many
      // markets can't spawn unbounded parallel Semrush requests (429 / pool risk).
      const OWNED_URLS_PROJECT_CONCURRENCY = 8;
      const projectResults = await mapWithConcurrency(
        scopes,
        OWNED_URLS_PROJECT_CONCURRENCY,
        async ({ region, projectId }) => {
          const [stats, trend] = await Promise.all([
            transport.fetchElement(
              workspaceId,
              ELEMENT_IDS.STATS_PER_URL,
              buildOwnedUrlsStatsPayload({
                model, platform, startDate, endDate, category, projectId,
              }),
            ),
            transport.fetchElement(
              workspaceId,
              ELEMENT_IDS.URL_TRENDS,
              // category applied here too (mirrors stats) so weekly sparklines and
              // aggregate totals share the same filter set.
              buildOwnedUrlsTrendPayload({
                model, platform, startDate, endDate, category, projectId,
              }),
            ),
          ]);
          return { region, stats, trend };
        },
      );
      return transformOwnedUrlsResponse(projectResults);
    },
    /* c8 ignore stop */

    /**
     * Fetches the URL Inspector Domain URLs table (Phase 2 drilldown: the URLs
     * within one cited domain), backed by the same Stats-per-URL element (9af5ed83)
     * as owned-urls — but with NO trend element and NO Postgres traffic hybrid, and
     * filtered to a single domain instead of `domain_type='Owned'`.
     *
     * Fans out per project (region) — each project stays under the 50k-row cap and
     * carries its region — then merges + host-filters to the legacy shape. The
     * `hostname` filter is applied client-side in the transform (the element ignores
     * a server-side domain filter — verified live). Returns the paginated slice +
     * post-filter totalCount.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params
     * @param {Array<{region?: string, projectId?: string}>} [params.projects] -
     *   Projects to query. Empty → one unscoped (workspace-wide) fetch.
     * @param {string} params.hostname - Registered domain to drill into (required).
     * @param {string} [params.channel] - Content-type filter, applied client-side.
     * @param {string} [params.model] / [params.platform] - AI model filter.
     * @param {string} params.startDate / params.endDate - Required YYYY-MM-DD.
     * @param {string} [params.category] - Category tag filter.
     * @param {string|number} [params.page] / [params.pageSize] - Client-side slice.
     * @returns {Promise<{ urls: object[], totalCount: number }>} Legacy contract.
     */
    /* c8 ignore start -- LLMO-6160 POC endpoint; unit tests intentionally deferred */
    async getDomainUrls(workspaceId, {
      projects = [], hostname, channel, model, platform, startDate, endDate, category,
      page, pageSize,
    }) {
      const scopes = projects.length > 0 ? projects : [{}];
      // Bound the per-project fan-out (mirrors owned-urls) so a brand with many
      // markets can't spawn unbounded parallel Semrush requests (429 / pool risk).
      const DOMAIN_URLS_PROJECT_CONCURRENCY = 8;
      const projectResults = await mapWithConcurrency(
        scopes,
        DOMAIN_URLS_PROJECT_CONCURRENCY,
        async ({ region, projectId }) => {
          const stats = await transport.fetchElement(
            workspaceId,
            ELEMENT_IDS.STATS_PER_URL,
            buildDomainUrlsPayload({
              model, platform, startDate, endDate, category, projectId,
            }),
          );
          return { region, stats };
        },
      );
      return transformDomainUrlsResponse(projectResults, {
        hostname, channel, page, pageSize,
      });
    },
    /* c8 ignore stop */

    /**
     * Fetches weekly per-competitor mentions + citations for the Competitor
     * Comparison chart (`GET .../brand-presence/market-tracking-trends`), backed by
     * two weekly `line` elements fetched in parallel — TRENDS_MV (b5281393, mentions)
     * and MARKET_CITATIONS_TREND (2e5a6f4e, citations). Both return one series per
     * market participant keyed by `legend` = name; the transform splits the tracked
     * brand from its competitors and merges the two metrics per ISO week. No per-week
     * fan-out: the elements are already `auto_bucketing: "week"`.
     *
     * `projectId` (a single selected region) takes precedence over `projectIds` (the
     * aggregate "all regions" view — every project the brand owns). Both are OR-ed into
     * one call per element, so neither path fans out.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params
     * @param {string} [params.model] / [params.platform] - AI model filter.
     * @param {string} params.startDate / params.endDate - YYYY-MM-DD.
     * @param {string} [params.projectId] - Single Semrush project UUID (one region).
     * @param {string[]} [params.projectIds] - All the brand's project UUIDs (aggregate).
     * @param {string} params.brandName - Tracked brand display name (matches its legend).
     * @returns {Promise<{weeklyTrends: object[]}>}
     */
    async getMarketTrackingTrends(workspaceId, {
      model, platform, startDate, endDate, projectId, projectIds, brandName,
    }) {
      const resolvedProjectIds = projectId ? [projectId] : (projectIds ?? []);
      const [mentions, citations] = await Promise.all([
        transport.fetchElement(
          workspaceId,
          ELEMENT_IDS.TRENDS_MV,
          buildMarketMentionsTrendPayload({
            model, platform, startDate, endDate, projectIds: resolvedProjectIds,
          }),
        ),
        transport.fetchElement(
          workspaceId,
          ELEMENT_IDS.MARKET_CITATIONS_TREND,
          buildMarketCitationsTrendPayload({
            model, platform, startDate, endDate, projectIds: resolvedProjectIds,
          }),
        ),
      ]);
      return { weeklyTrends: transformMarketTrackingTrends(mentions, citations, brandName) };
    },

    /**
     * Fetches the Brand Presence Stats KPI cards (`GET .../brand-presence/stats`),
     * backed by Total Executions (601590e0), Mentions (e1a6811b), Visibility
     * (2724878e), and Citations (588054fe) — see
     * docs/elements/brand-presence-stats-plan.md for the full design.
     *
     * `projectId` (single region selected) takes precedence over `projectIds`
     * (aggregate "all regions" view, every project the brand owns). Exactly one
     * should be populated by the caller.
     *
     * When `showTrends` is true, also fetches all four stats per week (up to 8
     * weeks, built backward from `endDate`, bounded concurrency) — there is no
     * Semrush element that returns all four metrics pre-bucketed by week, so each
     * week reuses the same four element calls scoped to that week's date range.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params
     * @param {string} [params.model] / [params.platform] - AI model filter.
     * @param {string} params.startDate / params.endDate - Required YYYY-MM-DD.
     * @param {string} [params.projectId] - Single Semrush project UUID (one region selected).
     * @param {string[]} [params.projectIds] - All of the brand's project UUIDs (aggregate view).
     * @param {string} params.brandName - Brand display name (Semrush brand filter value).
     * @param {boolean} [params.showTrends] - Whether to include the `trends` array.
     * @returns {Promise<{stats: object, trends?: object[]}>}
     */
    async getBrandPresenceStats(workspaceId, {
      model, platform, startDate, endDate, projectId, projectIds, brandName, showTrends,
    }) {
      const resolvedProjectIds = projectId ? [projectId] : projectIds;

      const fetchStatsForRange = async (rangeStart, rangeEnd) => {
        const totalExecutionsPayload = buildStatsTotalExecutionsPayload({
          model,
          platform,
          startDate: rangeStart,
          endDate: rangeEnd,
          projectIds: resolvedProjectIds,
          brandName,
        });
        const mentionsPayload = buildStatsMentionsPayload({
          model,
          platform,
          startDate: rangeStart,
          endDate: rangeEnd,
          projectIds: resolvedProjectIds,
          brandName,
        });
        const visibilityPayload = buildStatsVisibilityPayload({
          model,
          platform,
          startDate: rangeStart,
          endDate: rangeEnd,
          projectIds: resolvedProjectIds,
          brandName,
        });
        const citationsPayload = buildStatsCitationsPayload({
          model,
          platform,
          startDate: rangeStart,
          endDate: rangeEnd,
          projectIds: resolvedProjectIds,
          brandName,
        });
        const [totalExec, mentions, visibility, citations] = await Promise.all([
          transport.fetchElement(workspaceId, ELEMENT_IDS.TOTAL_EXECUTIONS, totalExecutionsPayload),
          transport.fetchElement(workspaceId, ELEMENT_IDS.MENTIONS, mentionsPayload),
          transport.fetchElement(workspaceId, ELEMENT_IDS.VISIBILITY, visibilityPayload),
          transport.fetchElement(workspaceId, ELEMENT_IDS.CITATIONS_KPI, citationsPayload),
        ]);
        return {
          total_executions: transformStatsTotalExecutionsResponse(totalExec),
          total_mentions: transformStatsMentionsResponse(mentions),
          average_visibility_score: transformStatsVisibilityResponse(visibility),
          total_citations: transformStatsCitationsResponse(citations),
        };
      };

      const stats = await fetchStatsForRange(startDate, endDate);
      const response = { stats };

      if (showTrends) {
        const weeks = splitDateRangeIntoWeeksBackward(startDate, endDate);
        const weekStats = await mapWithConcurrency(
          weeks,
          STATS_TRENDS_WEEK_CONCURRENCY,
          (week) => fetchStatsForRange(week.startDate, week.endDate),
        );
        response.trends = weeks.map((week, i) => ({
          startDate: week.startDate,
          endDate: week.endDate,
          data: { stats: weekStats[i] },
        }));
      }

      return response;
    },
  };
}
