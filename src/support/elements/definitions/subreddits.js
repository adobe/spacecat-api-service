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

import { resolveElementModel } from '../constants.js';

/* c8 ignore start -- SITES-POC subreddits endpoint; unit tests intentionally deferred */
/**
 * Builds the payload for the Subreddits element (faf56e29). The element is a `table`
 * returning one row per (subreddit, project) with mentions/prompts/threads/
 * responses_with_citations/visibility over the given window.
 *
 * Quirks (verified against a live call, 2026-08-25):
 *  - Date range is `CBF_date__start`/`CBF_date__end` in the `advanced` block; `CBF_model`
 *    sits inside an `or` block within `advanced`.
 *  - `project_id` is OPTIONAL. Supplied → scope to that one project (set on BOTH the
 *    top-level and `filters.simple`, mirroring the discovery payload). Omitted → the
 *    element aggregates across ALL of the workspace's projects (so no per-project fan-out
 *    is needed here, unlike cited-domains). An absent project leaves `simple` as `{}`,
 *    which the element accepts.
 *  - The comparison-date columns (`CBF_date__*_comparison`) are a no-op for this element
 *    (byte-identical output with and without) — deliberately omitted.
 *  - Brand scoping is via the request's sub-workspace, not a filter.
 *
 * @param {object} [params]
 * @param {string} [params.model] - AI model filter (Semrush engine name or UI platform
 *   code), translated + validated via {@link resolveElementModel}. Omitted or unknown →
 *   defaults to `search-gpt` (the resolver's fallback), consistent with sibling definitions.
 * @param {string} params.startDate - ISO date (YYYY-MM-DD). Required — the controller
 *   validates it and rejects a missing/invalid range with 400, so there is no default here.
 * @param {string} params.endDate - ISO date (YYYY-MM-DD). Required (see startDate).
 * @param {string} [params.projectId] - Semrush project id to scope to (top-level +
 *   simple). Omitted → all of the workspace's projects.
 */
export function buildSubredditsPayload({
  model, startDate, endDate, projectId,
} = {}) {
  const resolvedModel = resolveElementModel(model);

  const advancedFilters = [
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
    { op: 'gte', val: startDate, col: 'CBF_date__start' },
    { op: 'lte', val: endDate, col: 'CBF_date__end' },
  ];

  return {
    ...(projectId && { project_id: projectId }),
    comparison_data_formatting: 'union',
    filters: {
      simple: { ...(projectId && { project_id: projectId }) },
      advanced: { op: 'and', filters: advancedFilters },
    },
  };
}

/**
 * Parses the pagination params (0-based `page`, `pageSize`), mirroring cited-domains
 * (default 50, clamped to [1, 1000]).
 */
function parsePagination({ page, pageSize } = {}) {
  return {
    page: Math.max(0, Number.parseInt(page, 10) || 0),
    pageSize: Math.min(Math.max(1, Number.parseInt(pageSize, 10) || 50), 1000),
  };
}

/**
 * Transforms the raw Subreddits element response (`table`, rows in `blocks.data`) into a
 * normalized, camelCased contract:
 *   { subreddits: [{ subreddit, subredditKey, link, mentions, prompts,
 *                    responsesWithCitations, threads, visibility, projectId }], totalCount }
 *
 * Numeric fields use `Number(x) || 0` (not `Number(x ?? 0)`) so a non-numeric value coerces
 * to 0 instead of NaN. Rows are sorted by `mentions` descending, tie-broken by `subredditKey`
 * so pagination is deterministic when counts are equal, then paginated client-side (Semrush
 * has no server-side paging); `totalCount` is the pre-slice row count.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @param {object} [params] - Query params (page, pageSize).
 * @returns {{ subreddits: Array<object>, totalCount: number }}
 */
export function transformSubredditsResponse(raw, params = {}) {
  const rows = (raw?.blocks?.data ?? [])
    .filter((row) => row && row.subreddit != null)
    .map((row) => ({
      subreddit: row.subreddit || '',
      subredditKey: row.subreddit_key || '',
      link: row.link || '',
      mentions: Number(row.mentions) || 0,
      prompts: Number(row.prompts) || 0,
      responsesWithCitations: Number(row.responses_with_citations) || 0,
      threads: Number(row.threads) || 0,
      visibility: Number(row.visibility) || 0,
      projectId: row.project_id || '',
    }))
    .sort((a, b) => b.mentions - a.mentions || a.subredditKey.localeCompare(b.subredditKey));

  const { page, pageSize } = parsePagination(params);
  const totalCount = rows.length;
  const offset = page * pageSize;
  return { subreddits: rows.slice(offset, offset + pageSize), totalCount };
}
/* c8 ignore stop */
