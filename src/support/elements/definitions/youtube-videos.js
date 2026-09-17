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
import { derivePreviousPeriod } from './kpi-headlines.js';

/* c8 ignore start -- SITES-POC youtube-videos endpoint; unit tests intentionally deferred */
/**
 * Builds the payload for the YouTube Videos element (05e624db). The element is a `table`
 * returning one row per video with channel/citations/prompts/views over the given window,
 * ranked by the caller (this endpoint sorts by `citations` descending).
 *
 * Same shape as the Reddit Threads element (5af96fd9):
 *  - Date range is `CBF_date__start`/`CBF_date__end` in the `advanced` block; `CBF_model`
 *    sits inside an `or` block within `advanced`.
 *  - Carries a comparison window (`CBF_date__start_comparison`/`CBF_date__end_comparison`)
 *    and `comparison_data_formatting: 'join'`, derived as the immediately-preceding period
 *    of equal length via {@link derivePreviousPeriod}.
 *  - `project_id` is OPTIONAL (set on BOTH the top-level and `filters.simple`). Omitted →
 *    `simple` stays `{}`.
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
export function buildYoutubeVideosPayload({
  model, startDate, endDate, projectId,
} = {}) {
  const resolvedModel = resolveElementModel(model);
  const { comparisonStartDate, comparisonEndDate } = derivePreviousPeriod(startDate, endDate);

  const advancedFilters = [
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
    { op: 'gte', val: startDate, col: 'CBF_date__start' },
    { op: 'lte', val: endDate, col: 'CBF_date__end' },
    { op: 'gte', val: comparisonStartDate, col: 'CBF_date__start_comparison' },
    { op: 'lte', val: comparisonEndDate, col: 'CBF_date__end_comparison' },
  ];

  return {
    ...(projectId && { project_id: projectId }),
    comparison_data_formatting: 'join',
    filters: {
      simple: { ...(projectId && { project_id: projectId }) },
      advanced: { op: 'and', filters: advancedFilters },
    },
  };
}

/**
 * Parses the pagination params (0-based `page`, `pageSize`), mirroring reddit-threads
 * (default 50, clamped to [1, 1000]).
 */
function parsePagination({ page, pageSize } = {}) {
  return {
    page: Math.max(0, Number.parseInt(page, 10) || 0),
    pageSize: Math.min(Math.max(1, Number.parseInt(pageSize, 10) || 50), 1000),
  };
}

/**
 * Transforms the raw YouTube Videos element response (`table`, rows in `blocks.data`) into
 * a normalized, camelCased contract:
 *   { videos: [{ channel, citations, link, prompts, video, views, urlCbf }],
 *     totalCount }
 *
 * Numeric fields (including `views`, which may be `null` upstream) use `Number(x) || 0`
 * (not `Number(x ?? 0)`) so a non-numeric or missing value coerces to 0 instead of NaN.
 * Rows are sorted by `citations` descending (the ranking metric for this endpoint),
 * tie-broken by `urlCbf` so pagination is deterministic when counts are equal, then
 * paginated client-side (Semrush has no server-side paging); `totalCount` is the
 * pre-slice row count.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @param {object} [params] - Query params (page, pageSize).
 * @returns {{ videos: Array<object>, totalCount: number }}
 */
export function transformYoutubeVideosResponse(raw, params = {}) {
  const rows = (raw?.blocks?.data ?? [])
    .filter((row) => row && row.link != null)
    .map((row) => ({
      channel: row.channel || '',
      citations: Number(row.citations) || 0,
      link: row.link || '',
      prompts: Number(row.prompts) || 0,
      video: row.video || '',
      views: Number(row.views) || 0,
      urlCbf: row.url_cbf || '',
    }))
    .sort((a, b) => b.citations - a.citations || a.urlCbf.localeCompare(b.urlCbf));

  const { page, pageSize } = parsePagination(params);
  const totalCount = rows.length;
  const offset = page * pageSize;
  return { videos: rows.slice(offset, offset + pageSize), totalCount };
}
/* c8 ignore stop */
