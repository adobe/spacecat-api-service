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

/**
 * Endpoint registry for the Brand24 proxy (POC — Offsite Visibility dashboard,
 * project-elmo-ui). Maps a friendly `endpoint` key to the real Brand24 REST
 * path, its path params, and the query params callers are allowed to pass
 * through. Deliberately narrow (only what the dashboard uses today) — ported
 * from the same-shaped registry in the brand24-project-explorer POC app
 * (src/lib/endpoints.ts, github.com/AndreiAlexandruParaschiv/brand24) so the
 * two stay easy to compare. Cross-checked against that reference repo again
 * on 2026-08-26 — see `daily-metrics`'s `rangeParamNames` below for the one
 * real divergence that turned up (a live date-range bug, not just a diff).
 */

const DATE_QUERY = ['date_from', 'date_to'];

function projectEndpoint(key, tail, extraQuery = [], maxRangeDays = null) {
  return {
    key,
    pathTemplate: `/api-data/v1/project/{project_id}/${tail}`,
    pathParams: ['project_id'],
    allowedQuery: [...DATE_QUERY, ...extraQuery],
    maxRangeDays,
    // Query param names actually used for the from/to range — defaults to `date_from`/
    // `date_to` (every other Brand24 endpoint), overridable per-entry (see `daily-metrics`).
    rangeParamNames: DATE_QUERY,
  };
}

export const BRAND24_ENDPOINTS = {
  'projects-list': {
    key: 'projects-list',
    pathTemplate: '/api-data/v1/account/{account_id}/projects_list/',
    pathParams: ['account_id'],
    allowedQuery: [],
    maxRangeDays: null,
    rangeParamNames: [],
  },
  'mentions-count': projectEndpoint('mentions-count', 'mentions/count', [], 31),
  'mentions-sentiment': projectEndpoint('mentions-sentiment', 'mentions/sentiment', [], 31),
  'mentions-reach': projectEndpoint('mentions-reach', 'mentions/reach', [], 31),
  // `sentiment`/`category` let the Mentions table filter server-side (comma-separated per the
  // OpenAPI spec, e.g. sentiment=positive,neutral / category=facebook,instagram,tiktok) instead
  // of only filtering the one already-fetched page client-side.
  mentions: projectEndpoint('mentions', 'mentions', ['limit', 'cursor', 'sentiment', 'category'], null),
  'ai-summary': projectEndpoint('ai-summary', 'ai-summary', [], 31),
  'ai-insights': projectEndpoint('ai-insights', 'ai-insights', [], 31),
  'most-active-sites': projectEndpoint('most-active-sites', 'most-active-sites', [], 31),
  'hot-hours': projectEndpoint('hot-hours', 'hot-hours', [], 31),
  // `includeBySource=true` adds a `by_source` breakdown (twitter/facebook/instagram/reddit/
  // youtube/tiktok/news) per day, each with its own mentions_count/reach/sentiment counts —
  // that's the only way the OpenAPI spec exposes a "mentions/sentiment by category" view.
  //
  // NOT a `projectEndpoint()` — unlike every other project-scoped call, this one's real
  // upstream range params are `from`/`to`, not `date_from`/`date_to` (confirmed against the
  // brand24-project-explorer reference repo's own bespoke entry for this same endpoint, and
  // live: Brand24 silently ignores `date_from`/`date_to` here and falls back to its own
  // default trailing window). Sending `date_from`/`date_to` — what every caller here did until
  // this fix — meant this endpoint always returned Brand24's default window and silently never
  // respected the dashboard's selected date range.
  'daily-metrics': {
    key: 'daily-metrics',
    pathTemplate: '/api-data/v1/project/{project_id}/daily-metrics',
    pathParams: ['project_id'],
    allowedQuery: ['from', 'to', 'source', 'includeBySource'],
    maxRangeDays: 31,
    rangeParamNames: ['from', 'to'],
  },
  // Per-topic mentions/reach/sentiment/share_of_voice + AI-generated description — confirmed
  // against the real OpenAPI spec's `ProjectTopic` schema (fetched from
  // api-data.brand24.com/static/js/api-data/apiDocs.json). No per-topic mention list/URLs and
  // no "emotions" field anywhere in the spec's 41 schemas — those aren't available.
  topics: projectEndpoint('topics', 'topics', [], 31),
  // Real per-mention URLs ranked by mention count — the closest the spec gets to "sources for
  // a topic" (there's no topic_id filter on /mentions, so per-topic mention lists aren't
  // derivable; this is project-wide instead).
  'trending-links': projectEndpoint('trending-links', 'trending-links', [], 31),
  'most-followers': projectEndpoint('most-followers', 'most-followers', ['sort_by', 'min_influencer_score'], 31),
  'project-events': projectEndpoint('project-events', 'project_events', ['sort_order', 'limit'], 31),
  'trending-hashtags': projectEndpoint('trending-hashtags', 'trending-hashtags', [], 31),
  demographics: projectEndpoint('demographics', 'demographics', [], 31),
  // Present in the reference repo's registry but not yet wired into any dashboard component —
  // added for parity so the proxy accepts them if/when a caller needs them.
  domains: projectEndpoint('domains', 'domains/', [], 31),
  keywords: {
    key: 'keywords',
    pathTemplate: '/api-data/v1/project/{project_id}/keywords',
    pathParams: ['project_id'],
    allowedQuery: [],
    maxRangeDays: null,
    rangeParamNames: [],
  },
  languages: {
    key: 'languages',
    pathTemplate: '/api-data/v1/languages',
    pathParams: [],
    allowedQuery: [],
    maxRangeDays: null,
    rangeParamNames: [],
  },
  'usage-estimation': {
    key: 'usage-estimation',
    pathTemplate: '/api-data/v1/account/mentions-usage-estimation',
    pathParams: [],
    allowedQuery: [],
    maxRangeDays: null,
    rangeParamNames: [],
  },
  // Reference endpoint (not project-scoped) — the canonical, complete category-token vocabulary
  // Brand24 supports on `/mentions`' own `category` filter, independent of any date range or
  // account data. Used as the Mentions table's category filter option list instead of deriving
  // options from whatever categories happen to appear in the selected range.
  'mentions-categories': {
    key: 'mentions-categories',
    pathTemplate: '/api-data/v1/mentions/categories',
    pathParams: [],
    allowedQuery: [],
    maxRangeDays: null,
    rangeParamNames: [],
  },
};

export function getBrand24Endpoint(key) {
  return BRAND24_ENDPOINTS[key];
}

export function buildBrand24Path(endpointDef, pathValues) {
  return endpointDef.pathTemplate
    .replace('{project_id}', String(pathValues.project_id ?? ''))
    .replace('{account_id}', String(pathValues.account_id ?? ''));
}
