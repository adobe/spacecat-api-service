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

import { hasText } from '@adobe/spacecat-shared-utils';
import { ELEMENT_IDS } from './element-ids.js';
import { SEP } from './constants.js';
import { mapWithConcurrency } from './concurrency.js';
import { splitDateRangeIntoWeeksBackward } from './week-utils.js';
import {
  DIMENSION,
  INTENT_VALUE,
  INTENT_ROOT_NAME,
} from '../serenity/prompt-tags.js';
import {
  buildBrandsPayload,
  transformBrandsToFilterDimensions,
  buildMarketsPayload,
  transformMarketsToFilterDimensions,
  buildContentTypesPayload,
  transformContentTypesToFilterDimensions,
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
  INTENT_ENRICH_CONCURRENCY,
  buildCitedDomainsPayload,
  transformCitedDomainsResponse,
  transformCitedDomainsResponses,
  buildTopicPromptsPayload,
  transformTopicPromptsResponse,
  aggregateTopicsFromPrompts,
  buildSentimentOverviewPayload,
  transformSentimentOverviewResponse,
  buildOwnedUrlsStatsPayload,
  buildOwnedUrlsTrendPayload,
  transformOwnedUrlsResponse,
  buildDomainUrlsPayload,
  transformDomainUrlsResponse,
  buildUrlPromptsPayload,
  transformUrlPromptsResponse,
  mergeUrlPromptsResponses,
  buildMarketMentionsTrendPayload,
  buildMarketCitationsTrendPayload,
  transformMarketTrackingTrends,
  transformCompetitorSummary,
  buildStatsTotalExecutionsPayload,
  transformStatsTotalExecutionsResponse,
  buildStatsMentionsPayload,
  transformStatsMentionsResponse,
  buildStatsVisibilityPayload,
  transformStatsVisibilityResponse,
  buildStatsCitationsPayload,
  transformStatsCitationsResponse,
  aggregateUrlInspectorStats,
  buildKpiHeadlinePayload,
  buildBrandUrlsPayload,
  transformBrandUrlsResponse,
  buildSourceVisibilityPayload,
  transformKpiHeadlineResponse,
} from './definitions/index.js';

// Tightened per-call budget for getSourceVisibilityHeadline's two SEQUENTIAL
// calls (brand-URL-list, then the KPI itself) — the transport's normal 30s x 2
// retries would blow the API-Gateway's ~30s hard integration timeout ceiling on
// its own (see elements-transport.js's DEFAULT_TIMEOUT_MS doc), regardless of
// what else shares the endpoint. 1 retry max per call keeps the worst case
// (~12s + one jittered backoff) x 2 safely under that ceiling.
const SOURCE_VISIBILITY_CALL_TIMEOUT_MS = 12_000;
const SOURCE_VISIBILITY_CALL_MAX_RETRIES = 1;

// Bounds parallel per-week upstream fan-out for the /stats trends array (up to
// TRENDS_MAX_WEEKS=8 weeks x 4 element calls each) so a wide date range can't
// spawn an unbounded number of parallel Semrush requests.
const STATS_TRENDS_WEEK_CONCURRENCY = 4;

/**
 * Creates the Elements service that composes transport calls with per-element
 * payload builders and response transformers.
 *
 * @param {object} transport - Elements transport created by createElementsTransport().
 * @param {object} [log] - Optional logger (`{ warn }`) for non-fatal degradation paths.
 */
export function createElementsService(transport, log) {
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
      const [rawTopics, rawBrands, rawMarkets, rawContentTypes] = await Promise.all([
        transport.fetchElement(workspaceId, ELEMENT_IDS.TOPICS, buildTopicsPayload(params)),
        transport.fetchElement(workspaceId, ELEMENT_IDS.BRANDS, buildBrandsPayload(params)),
        transport.fetchElement(workspaceId, ELEMENT_IDS.MARKETS, buildMarketsPayload({})),
        transport.fetchElement(
          workspaceId,
          ELEMENT_IDS.CONTENT_TYPES,
          buildContentTypesPayload(params),
        ),
      ]);
      const result = {
        brands: transformBrandsToFilterDimensions(rawBrands, spacecatBrands),
        regions: transformMarketsToFilterDimensions(rawMarkets, brandSemrushProjects),
        topics: transformTopicsForFilterDimensions(rawTopics),
        categories: transformCategoriesToFilterDimensions(rawTopics),
        page_intents: transformIntentsToFilterDimensions(rawTopics),
        origins: transformOriginsToFilterDimensions(rawTopics),
        content_types: transformContentTypesToFilterDimensions(rawContentTypes),
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
      //
      // `intent` is reserved explicitly because it is NOT one of `result`'s keys —
      // the intent dimension surfaces as `page_intents`. Without it, a project the
      // intent rename has not reached would have its pre-rename `intent__` tags
      // caught by the catch-all and published as a dynamic, customer-visible
      // `intent` filter group — the exposure the `$abv_tags$` marker exists to
      // prevent. Reserving it routes them to the generic `tags` array instead.
      // This is a blast-radius bound on an un-swept project, not a tolerance: the
      // tags are still not read as intents.
      const reservedResultKeys = [
        ...Object.keys(result), DIMENSION.INTENT, 'tags', '__proto__', 'constructor', 'prototype',
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
     * When `params.enrichUserIntent` is set (and the query is scoped to exactly
     * one `projectId` — see below), each returned row also carries its OWN intent
     * (`userIntent`). The intent isn't a column on the PROMPTS element, so it's
     * derived with one `<intentRoot>__<value>`-filtered call per Semrush intent, run
     * in parallel and joined back to the base rows.
     *
     * An Elements tag filter is the `__`-joined tag PATH, so the intent root's name
     * IS the prefix every one of those five filters carries: `$abv_tags$intent__`
     * ({@link INTENT_ROOT_NAME}). A filter carrying any other spelling matches
     * nothing and answers 200 with an empty `userIntent` on every row, so the
     * prefix is taken from the constant rather than written out here.
     *
     * Enrichment is non-fatal per intent value: each call catches its own failure
     * and contributes nothing, so one failing intent drops only that intent's rows.
     * The base call still propagates on failure. Without the flag, response shape
     * and upstream call count are unchanged.
     *
     * SINGLE-SLICE ONLY: the join key is `(prompt, prompt_topic)` — the strongest
     * identifier the element row exposes (it carries no `semrushPromptId`, geo, or
     * language). That tuple is unique only WITHIN one project (= one geo+language
     * slice), so enrichment is skipped unless exactly one `projectId` is requested;
     * across markets the same text could map to different intents and no row field
     * could disambiguate it. (A stable per-row id from upstream would lift this.)
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Filter parameters (model/platform, tags, projectIds,
     *   and `enrichUserIntent`).
     * @returns {Promise<{count: number, prompts: object[]}>} `{ count, prompts }`.
     */
    async getPrompts(workspaceId, params) {
      const { enrichUserIntent, ...promptParams } = params ?? {};
      const basePromise = transport
        .fetchElement(workspaceId, ELEMENT_IDS.PROMPTS, buildPromptsPayload(promptParams))
        .then(transformPromptsResponse);

      // Enrich only when opted in AND scoped to a single slice (see the join-key
      // note above); otherwise return the base rows unchanged.
      if (!enrichUserIntent || (promptParams.projectIds ?? []).length !== 1) {
        return basePromise;
      }

      // `(prompt, prompt_topic)` join key — unique within the single requested slice.
      const rowKey = (row) => `${row?.prompt ?? ''} ${row?.prompt_topic ?? ''}`;

      // One intent-filtered call per intent value, in parallel (~one extra
      // round-trip). Each call degrades independently.
      const fetchIntentRound = () => mapWithConcurrency(
        Object.values(INTENT_VALUE),
        INTENT_ENRICH_CONCURRENCY,
        async (value) => {
          const key = value.toLowerCase();
          try {
            const raw = await transport.fetchElement(
              workspaceId,
              ELEMENT_IDS.PROMPTS,
              buildPromptsPayload({
                ...promptParams,
                tags: [...(promptParams.tags ?? []), `${INTENT_ROOT_NAME}${SEP}${value}`],
              }),
            );
            return { key, rows: transformPromptsResponse(raw).prompts };
          } catch (e) {
            // A failed call contributes an empty round, so it reaches the caller as a
            // blank `userIntent` — indistinguishable in the response from a prompt that
            // genuinely carries no intent tag. This warn is the only thing that tells
            // the two apart, so it carries an `event` key to stay queryable.
            log?.warn?.(
              `serenity userIntent enrichment: intent-filtered PROMPTS call failed for '${value}'`,
              { workspaceId, error: e?.message, event: 'intent-enrichment-call-failed' },
            );
            return { key, rows: [] };
          }
        },
      );

      // Base call runs alongside the intent round rather than after it.
      const [base, intentResults] = await Promise.all([basePromise, fetchIntentRound()]);

      // (prompt, prompt_topic) → own intent. A prompt carries exactly one intent
      // tag, so within a single slice it appears in at most one filtered result.
      const intentByRow = new Map();
      for (const { key, rows } of intentResults) {
        for (const row of rows) {
          intentByRow.set(rowKey(row), key);
        }
      }

      const prompts = base.prompts.map((p) => ({
        ...p,
        userIntent: intentByRow.get(rowKey(p)) ?? '',
      }));
      // `count` mirrors the base response (currently equals the row count).
      return { count: base.count, prompts };
    },

    /**
     * Fetches domains most frequently cited alongside owned URLs (URL Inspector
     * Cited Domains panel), backed by element 98b91d00 ("Stats per Domain").
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query params (model/platform, brand, startDate, endDate,
     *   page, pageSize).
     * @param {string[]} [params.projectIds] - Semrush project ids to scope to. The
     *   element only accepts one project per call, so more than one id fans out a
     *   call per project (bounded concurrency) and merges the results. Deduplicated
     *   here as a safety net — a repeated id would otherwise double-count that
     *   project's citations in the merge (the controller already dedupes, but this
     *   fan-out is where a duplicate would actually corrupt counts, so it dedupes
     *   independently rather than relying solely on the caller).
     * @returns {Promise<object>} Legacy contract `{ domains: [...], totalCount }`.
     */
    /* c8 ignore start -- LLMO-6020 POC endpoint; unit tests intentionally deferred */
    async getCitedDomains(workspaceId, params) {
      const { projectIds, ...rest } = params;
      const ids = Array.isArray(projectIds)
        ? [...new Set(projectIds.filter(hasText))]
        : [];
      if (ids.length > 1) {
        const CITED_DOMAINS_PROJECT_CONCURRENCY = 8;
        const rawList = await mapWithConcurrency(
          ids,
          CITED_DOMAINS_PROJECT_CONCURRENCY,
          (projectId) => transport.fetchElement(
            workspaceId,
            ELEMENT_IDS.CITED_DOMAINS,
            buildCitedDomainsPayload({ ...rest, projectId }),
          ),
        );
        return transformCitedDomainsResponses(rawList, rest);
      }
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.CITED_DOMAINS,
        buildCitedDomainsPayload({ ...rest, projectId: ids[0] }),
      );
      return transformCitedDomainsResponse(raw, rest);
    },

    /**
     * Fetches per-week brand sentiment (positive/neutral/negative) from the Sentiment
     * element (f4153af8…), transformed into the legacy Brand Presence
     * `sentiment-overview` contract `{ weeklyTrends: [...] }`.
     *
     * Single call (like getCitedDomains, not a per-project fan-out): with
     * `auto_bucketing: 'week'` the element returns weekly sentiment buckets directly
     * (server-side, honoring the requested date range) — no daily→weekly rollup here.
     * Project scoping, when requested, is a `CBF_project` (Semrush project id) advanced
     * filter built from the caller-supplied `projectId`/`projectIds`; absent → the brand's
     * whole sub-workspace.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params - Query params (model/platform, startDate, endDate, category,
     *   projectId, projectIds).
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
     * Fetches the per-prompt drill-down for a single topic from the rich
     * PROMPTS_BY_TOPIC element (78864493), scoped by `CBF_topic` (the topic name).
     * Single call (no fan-out); returns a flat array of per-prompt rows. Pagination
     * is applied client-side by the controller (Semrush has no server-side paging).
     *
     * @param {string} workspaceId - Semrush sub-workspace UUID (projects/prompts live here).
     * @param {object} params - Query params (topic, model/platform, startDate, endDate, projectId).
     * @returns {Promise<Array<object>>} Per-prompt rows (see transformTopicPromptsResponse).
     */
    /* c8 ignore start -- LLMO-6418 POC endpoint; unit tests intentionally deferred */
    async getTopicPrompts(workspaceId, params) {
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.PROMPTS_BY_TOPIC,
        buildTopicPromptsPayload(params),
      );
      // Sort by volume desc so the drill-down matches the order of the same topic's
      // prompts embedded in getTopics (aggregateTopicsFromPrompts) — the element itself
      // returns rows in an unspecified order.
      return transformTopicPromptsResponse(raw)
        .sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0));
    },
    /* c8 ignore stop */

    /**
     * Fetches the URL Inspector details drill-down: the prompts that cited a specific
     * URL, from the URL_PROMPTS element (b4f1ead7), scoped by `CBF_source` (the URL).
     * Returns a flat array of per-prompt rows. Pagination is applied client-side by the
     * controller (Semrush has no server-side paging).
     *
     * Market scope: the element takes ONE top-level `project_id` per call (a `CBF_project`
     * advanced filter is a no-op — verified live LLMO-6674). So when the caller selects
     * markets, this fans out one call per project id (bounded concurrency, mirroring
     * owned-urls) and UNIONS the results, deduped by prompt text via
     * {@link mergeUrlPromptsResponses} (which documents the dedupe/collision rules). No
     * `projectIds` → one unscoped call across the whole sub-workspace (unchanged behavior).
     * Category is a `CBF_tags` filter applied on every per-project call.
     *
     * @param {string} workspaceId - Semrush sub-workspace UUID (projects/prompts live here).
     * @param {object} params - Query params (url, model/platform, startDate, endDate,
     *   category, projectIds).
     * @param {string[]} [params.projectIds] - Semrush project ids to scope to. Empty → one
     *   unscoped (sub-workspace-wide) fetch.
     * @returns {Promise<Array<object>>} Per-prompt rows (see transformUrlPromptsResponse).
     */
    /* c8 ignore start -- LLMO-6620 POC endpoint; unit tests deferred (see url-prompts.js tests) */
    async getUrlPrompts(workspaceId, {
      url, model, platform, startDate, endDate, category, projectIds = [],
    }) {
      const ids = Array.isArray(projectIds)
        ? [...new Set(projectIds.filter(hasText))]
        : [];
      // One top-level project_id per call; `undefined` = the unscoped aggregate.
      const scopes = ids.length > 0 ? ids : [undefined];
      // Bound the per-market fan-out (mirrors owned-urls) so a brand with many markets
      // can't spawn unbounded parallel Semrush requests (429 / pool risk).
      const URL_PROMPTS_PROJECT_CONCURRENCY = 8;
      const perProject = await mapWithConcurrency(
        scopes,
        URL_PROMPTS_PROJECT_CONCURRENCY,
        async (projectId) => {
          const raw = await transport.fetchElement(
            workspaceId,
            ELEMENT_IDS.URL_PROMPTS,
            buildUrlPromptsPayload({
              url, model, platform, startDate, endDate, category, projectId,
            }),
          );
          return transformUrlPromptsResponse(raw);
        },
      );

      // Single scope → nothing to merge; return the transformed rows as-is.
      if (scopes.length === 1) {
        return perProject[0];
      }
      // Multi-market: union + dedupe by prompt text (see mergeUrlPromptsResponses).
      return mergeUrlPromptsResponses(perProject);
    },
    /* c8 ignore stop */

    /**
     * Fetches the Data Insights per-TOPIC table. Uses the SAME PROMPTS_BY_TOPIC element
     * (78864493) as getTopicPrompts but with NO topic filter (all topics), then groups
     * the per-prompt rows by topic and aggregates server-side (see aggregateTopicsFromPrompts).
     * Single upstream call; no fan-out.
     *
     * @param {string} workspaceId - Semrush sub-workspace UUID.
     * @param {object} params - Query params (model/platform, startDate, endDate, projectId).
     * @returns {Promise<Array<object>>} Per-topic aggregate rows.
     */
    /* c8 ignore start -- LLMO-6418 POC endpoint; unit tests intentionally deferred */
    async getTopics(workspaceId, params) {
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.PROMPTS_BY_TOPIC,
        // Omit `topic` so the element returns prompts across ALL topics to group.
        buildTopicPromptsPayload({ ...params, topic: undefined }),
      );
      return aggregateTopicsFromPrompts(transformTopicPromptsResponse(raw));
    },
    /* c8 ignore stop */

    /**
     * Resolves every (region, projectId) pair for the workspace, used as the
     * aggregate ("all projects") fallback when the caller doesn't supply a
     * `projectId` filter, and to fan the owned-urls query out per-project.
     * Per-project scoping keeps each element call under the Semrush 50k-row cap
     * (a workspace-wide call hit it) and lets the transform tag each URL with the
     * region it was cited in. Reuses the Markets element + transform.
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
    /* c8 ignore start -- market-tracking-trends POC endpoint; unit tests intentionally deferred */
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
    /* c8 ignore stop */

    /**
     * Fetches aggregate per-competitor mentions/citations totals (no weekly breakdown)
     * for the Overview Competitor Comparison bar chart
     * (`GET .../brand-presence/competitor-summary`) — the lightweight counterpart to
     * {@link getMarketTrackingTrends}, reusing the exact same two elements (TRENDS_MV +
     * MARKET_CITATIONS_TREND) but summed into one row per competitor instead of a
     * weekly series.
     *
     * `projectId` (a single selected region) takes precedence over `projectIds` (the
     * aggregate "all regions" view). Both are OR-ed into one call per element.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params
     * @param {string} [params.model] / [params.platform] - AI model filter.
     * @param {string} params.startDate / params.endDate - YYYY-MM-DD.
     * @param {string} [params.projectId] - Single Semrush project UUID (one region).
     * @param {string[]} [params.projectIds] - All the brand's project UUIDs (aggregate).
     * @param {string} params.brandName - Tracked brand display name (excluded from the result).
     * @returns {Promise<{competitors: Array<{name: string, mentions: number, citations: number}>}>}
     */
    /* c8 ignore start -- competitor-summary POC endpoint; unit tests intentionally deferred */
    async getCompetitorSummary(workspaceId, {
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
      return transformCompetitorSummary(mentions, citations, brandName);
    },
    /* c8 ignore stop */

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

    /**
     * Fetches 3 of the 4 URL Inspector stats KPI cards
     * (`GET .../url-inspector/stats`) — `uniqueUrls`, `totalCitations`,
     * `totalPromptsCited` — plus a per-week breakdown, matching the response
     * shape of the Aurora/Postgres reference endpoint
     * (`docs/llmo-brandalf-apis/url-inspector-stats-api.md`) minus its
     * `totalPrompts` field. The 4th card (`totalPrompts`) is served by
     * {@link getPrompts} via the separate `/url-inspector/prompts/count`
     * endpoint — split out because it has no per-project Stats-per-URL
     * fan-out (this method's actual timeout/rate-limit cost) and no date
     * scoping, so bundling it here only made the fast card wait on the slow
     * ones. Known approximation gap: `totalPromptsCited` overcounts (see
     * {@link aggregateUrlInspectorStats}).
     *
     * `uniqueUrls`/`totalCitations`/`totalPromptsCited` reuse the same
     * Stats-per-URL element (9af5ed83) as `getOwnedUrls`, fanned out per project
     * (region) like it — but WITHOUT the URL_TRENDS element (no per-URL trend
     * needed here), via {@link aggregateUrlInspectorStats}.
     *
     * `weeklyTrends` reuses `splitDateRangeIntoWeeksBackward`, but with an
     * ADAPTIVE week cap — `floor(STATS_FANOUT_CONCURRENCY / scopes.length)`,
     * not the fixed 8-week cap `getBrandPresenceStats` uses — so the
     * `(week x scope)` fan-out always fits in a single concurrency-bounded
     * batch (one round-trip's worth of wall time) instead of needing multiple
     * sequential batches on a brand with several markets. A single-project
     * request still gets the full 8 weeks (8/1 = 8); a 3-project aggregate
     * view gets only 2. `stats` (the aggregate card values) always covers the
     * full requested range regardless — only the per-week breakdown narrows.
     *

     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params
     * @param {Array<{region?: string, projectId?: string}>} [params.projects] -
     *   Projects to query for the citation KPIs. Empty → one unscoped
     *   (workspace-wide) fetch.
     * @param {string} [params.model] / [params.platform] - AI model filter.
     * @param {string} params.startDate / params.endDate - Required YYYY-MM-DD.
     * @param {string} [params.category] - Category tag filter.
     * @returns {Promise<{stats: object, weeklyTrends: object[]}>} `stats` and
     *   each `weeklyTrends` entry also carry `partial: boolean` — true when at
     *   least one of the underlying Stats-per-URL calls for that
     *   range/scope failed (see {@link fetchScopeStats}); the aggregate is
     *   still returned, computed from whichever scopes succeeded.
     */
    async getUrlInspectorStats(workspaceId, {
      projects = [], model, platform, startDate, endDate, category,
    }) {
      // Only fan out over scopes that actually resolved to a Semrush project
      // id. A `projects` entry without one (e.g. a mixed array where one
      // region failed to resolve upstream) would otherwise reach
      // buildOwnedUrlsStatsPayload as `projectId: undefined` — an unscoped,
      // workspace-wide (cross-brand) Stats-per-URL call — even though the
      // caller's own empty-scope guard runs against a separately filtered
      // list and would not catch it. `[{}]` (the deliberate unscoped
      // single-call fallback) is untouched: it only applies when no
      // `projects` were requested at all.
      const scopes = projects.length > 0
        ? projects.filter((p) => hasText(p?.projectId))
        : [{}];
      // Single flat bound across the WHOLE (week x project) fan-out. Nesting
      // a per-week bound around a per-project bound (as an earlier version
      // did) multiplies the two — weekConcurrency x projectConcurrency
      // in-flight calls at once — well past what either constant alone
      // documents, on the very endpoint that was split out because of
      // Semrush timeouts/rate-limits (see this method's docstring).
      const STATS_FANOUT_CONCURRENCY = 8;

      // Per-scope, non-fatal: one failing project/week must not fail the
      // whole KPI response — failure probability scales with markets x weeks
      // on this fan-out (up to 9 ranges x N projects). Skip the failed scope
      // and flag the aggregate as `partial` instead of rejecting.
      const fetchScopeStats = async (rangeStart, rangeEnd, projectId) => {
        try {
          const stats = await transport.fetchElement(
            workspaceId,
            ELEMENT_IDS.STATS_PER_URL,
            buildOwnedUrlsStatsPayload({
              model, platform, startDate: rangeStart, endDate: rangeEnd, category, projectId,
            }),
          );
          return { stats };
        } catch (e) {
          log?.warn?.('url-inspector-stats: Stats-per-URL fetch failed, skipping scope', {
            workspaceId, projectId, rangeStart, rangeEnd, error: e?.message,
          });
          return { stats: null, failed: true };
        }
      };

      const aggregate = (results) => ({
        ...aggregateUrlInspectorStats(results),
        partial: results.some((r) => r.failed),
      });

      // This endpoint sits behind an API-Gateway-fronted route with a hard
      // ~29-30s integration timeout that no Lambda-side setting can raise
      // (the Lambda's own 900s timeout is irrelevant if the gateway kills the
      // client-facing response first) — and a real measured Semrush
      // Stats-per-URL call is already close to that ceiling on its own (see
      // elements-transport.js's DEFAULT_TIMEOUT_MS). So a SECOND sequential
      // round of concurrent calls (i.e. `weeks.length * scopes.length` tasks
      // needing more than one `STATS_FANOUT_CONCURRENCY`-wide batch) reliably
      // blows the budget. Cap the trended weeks so the fan-out below always
      // fits in exactly one batch/round-trip: full 8-week trends for the
      // common single-project case (8/1 = 8, unchanged), fewer weeks for a
      // brand with more markets (e.g. 3 projects -> 2 weeks) rather than more
      // sequential batches. This is narrower than the fixed 8-week cap used
      // by getBrandPresenceStats, which has no per-project fan-out to compound.
      const maxTrendWeeks = Math.max(
        1,
        Math.floor(STATS_FANOUT_CONCURRENCY / Math.max(scopes.length, 1)),
      );
      const weeks = splitDateRangeIntoWeeksBackward(startDate, endDate, undefined, maxTrendWeeks);

      // The aggregate `stats` fetch and the weekly `weeklyTrends` fan-out are
      // independent Semrush calls — run them CONCURRENTLY (not one after the
      // other) so this endpoint costs one round-trip's worth of wall time,
      // not two, against the same gateway ceiling.
      const [stats, weekScopeResults] = await Promise.all([
        mapWithConcurrency(
          scopes,
          STATS_FANOUT_CONCURRENCY,
          ({ projectId }) => fetchScopeStats(startDate, endDate, projectId),
        ).then(aggregate),
        // Flattened (week, scope) task list under the ONE bound above — not a
        // per-week map of per-project maps — so the fan-out cost is exactly
        // `weeks.length * scopes.length` in-flight-bounded calls, never more.
        mapWithConcurrency(
          weeks.flatMap((week) => scopes.map((scope) => ({ week, scope }))),
          STATS_FANOUT_CONCURRENCY,
          ({ week, scope }) => fetchScopeStats(week.startDate, week.endDate, scope.projectId),
        ),
      ]);
      // `weekScopeResults` is in (week, scope) order (flatMap preserves it),
      // so each week's `scopes.length`-sized slice is contiguous.
      //
      // `weekStart`/`weekEnd` are the actual fetched window boundaries — NOT
      // calendar-ISO-week-aligned (they're 7-day windows built backward from
      // `endDate`, same as `getBrandPresenceStats`'s trends), so no `week`
      // ("YYYY-Www") label is attached; that would misrepresent the boundary as
      // Monday-Sunday when it may not be.
      const weeklyTrends = weeks.map((week, i) => ({
        weekStart: week.startDate,
        weekEnd: week.endDate,
        ...aggregate(weekScopeResults.slice(i * scopes.length, (i + 1) * scopes.length)),
      }));

      return { stats, weeklyTrends };
    },

    /**
     * Fetches the Overview-SR Share of Voice + Brand Visibility KPI headline
     * cards (`GET .../brand-presence/kpi-headlines`) — the MFE's own per-brand
     * `kpiLineChart` elements (`KPI_SHARE_OF_VOICE`, `KPI_BRAND_VISIBILITY`),
     * NOT derived from `market-tracking-trends`'s weekly series (LLMO-6516
     * follow-up, exact MFE parity — see docs/elements/kpi-headlines-plan.md).
     *
     * Both calls are brand-NAME scoped (`CBF_ws_brand`) and independent of each
     * other, so they run in parallel — this endpoint's own worst-case wall time
     * stays a single call's worth. Deliberately split from Source Visibility
     * (below): that one needs a SEQUENTIAL brand-URL-list lookup first, which
     * would double this endpoint's worst case against the API-Gateway's ~30s
     * ceiling if bundled in here.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params
     * @param {string} params.brandName - Brand display name (`CBF_ws_brand` value).
     * @param {string} [params.model] / [params.platform] - AI model filter.
     * @param {string} params.startDate / params.endDate - Required YYYY-MM-DD (main period).
     * @param {string} [params.projectId] - Single Semrush project UUID (one region).
     * @param {string[]} [params.projectIds] - All the brand's project UUIDs (aggregate).
     * @param {string} [params.category] - Full `category__<label>` tag value (caller
     *   includes the `category__` prefix), sent as-is.
     * @returns {Promise<{
     *   shareOfVoice: {value: number, comparisonValue: number | null},
     *   brandVisibility: {value: number, comparisonValue: number | null},
     * }>}
     */
    async getKpiHeadlines(workspaceId, {
      brandName, model, platform, startDate, endDate, projectId, projectIds, category,
    }) {
      const resolvedProjectIds = projectId ? [projectId] : (projectIds ?? []);
      const [sov, brandVis] = await Promise.all([
        transport.fetchElement(
          workspaceId,
          ELEMENT_IDS.KPI_SHARE_OF_VOICE,
          buildKpiHeadlinePayload({
            brandName,
            model,
            platform,
            startDate,
            endDate,
            projectIds: resolvedProjectIds,
            category,
          }),
        ),
        transport.fetchElement(
          workspaceId,
          ELEMENT_IDS.KPI_BRAND_VISIBILITY,
          buildKpiHeadlinePayload({
            brandName,
            model,
            platform,
            startDate,
            endDate,
            projectIds: resolvedProjectIds,
            category,
          }),
        ),
      ]);
      return {
        shareOfVoice: transformKpiHeadlineResponse(sov),
        brandVisibility: transformKpiHeadlineResponse(brandVis),
      };
    },

    /**
     * Fetches the Overview-SR Source Visibility KPI headline card
     * (`GET .../brand-presence/source-visibility-headline`) — split into its
     * OWN endpoint from Share of Voice/Brand Visibility because it needs a
     * SEQUENTIAL two-hop fetch (the brand's URL list via `BRAND_URLS`, then
     * `KPI_SOURCE_VISIBILITY` scoped by that list's `CBF_brand_urls`), unlike
     * the other two brand-NAME-scoped, single-hop calls. Each hop uses a
     * tightened per-call timeout ({@link SOURCE_VISIBILITY_CALL_TIMEOUT_MS}) so
     * the worst case stays under the API-Gateway's ~30s hard ceiling — the
     * transport's normal 30s-per-call default x 2 sequential calls would blow
     * it on its own, independent of what else shares the endpoint.
     *
     * A brand with no registered URLs has nothing to scope
     * `KPI_SOURCE_VISIBILITY` by (an empty `CBF_brand_urls` OR-filter is
     * unscoped/undefined behavior upstream) — returns `{ value: 0, comparisonValue: null }`
     * rather than issuing that call (no real measurement exists either period,
     * so `comparisonValue` stays `null` — same "no data" convention as
     * {@link transformKpiHeadlineResponse}), mirroring the empty-projects
     * guards elsewhere in this service.
     *
     * @param {string} workspaceId - Semrush workspace UUID.
     * @param {object} params
     * @param {string} params.brandName - Brand display name (`CBF_brand` value, for the URL list).
     * @param {string} [params.model] / [params.platform] - AI model filter.
     * @param {string} params.startDate / params.endDate - Required YYYY-MM-DD (main period).
     * @param {string} [params.projectId] - Single Semrush project UUID (one region).
     * @param {string[]} [params.projectIds] - All the brand's project UUIDs (aggregate).
     * @param {string} [params.category] - Full `category__<label>` tag value (caller
     *   includes the `category__` prefix), sent as-is.
     * @returns {Promise<{value: number, comparisonValue: number | null}>}
     */
    async getSourceVisibilityHeadline(workspaceId, {
      brandName, model, platform, startDate, endDate, projectId, projectIds, category,
    }) {
      const resolvedProjectIds = projectId ? [projectId] : (projectIds ?? []);
      const callOpts = {
        timeoutMs: SOURCE_VISIBILITY_CALL_TIMEOUT_MS,
        maxRetries: SOURCE_VISIBILITY_CALL_MAX_RETRIES,
      };
      const brandUrlsRaw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.BRAND_URLS,
        buildBrandUrlsPayload({ brandName }),
        callOpts,
      );
      const brandUrls = transformBrandUrlsResponse(brandUrlsRaw);
      if (brandUrls.length === 0) {
        return { value: 0, comparisonValue: null };
      }
      const raw = await transport.fetchElement(
        workspaceId,
        ELEMENT_IDS.KPI_SOURCE_VISIBILITY,
        buildSourceVisibilityPayload({
          brandUrls, model, platform, startDate, endDate, projectIds: resolvedProjectIds, category,
        }),
        callOpts,
      );
      return transformKpiHeadlineResponse(raw);
    },
  };
}
