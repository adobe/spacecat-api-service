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
import { dateToIsoWeek } from '../week-utils.js';

/* c8 ignore start -- LLMO-6086 POC endpoint; unit tests intentionally deferred */

/**
 * Builds the payload for the Stats-per-URL element (9af5ed83, "Stats per URL",
 * `table`). One row per cited URL in the (project, date, model) scope.
 *
 * Same filter shape as cited-domains (date in BOTH simple + advanced, CBF_model
 * in an `or` block, category as a `category:<label>` tag, region via top-level
 * `project_id`). `startDate`/`endDate` are required (validated in the controller).
 * The element does NOT honor a server-side content-type filter, so the
 * `domain_type='Owned'` selection is applied client-side in the transform.
 *
 * @param {object} params
 * @param {string} [params.model] - AI model (Semrush engine or UI platform code).
 * @param {string} [params.platform] - Legacy alias for `model`; `model` wins.
 * @param {string} params.startDate - ISO date (YYYY-MM-DD).
 * @param {string} params.endDate - ISO date (YYYY-MM-DD).
 * @param {string} [params.category] - Category label → tag `category:<label>`.
 * @param {string} [params.projectId] - Semrush project id (region scope, top-level).
 */
export function buildOwnedUrlsStatsPayload({
  model, platform, startDate, endDate, category, projectId,
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);
  const advancedFilters = [
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
    { op: 'gte', val: startDate, col: 'CBF_date__start' },
    { op: 'lte', val: endDate, col: 'CBF_date__end' },
  ];
  if (category) {
    advancedFilters.push({ op: 'eq', val: `category:${category}`, col: 'CBF_tags' });
  }
  return {
    ...(projectId && { project_id: projectId }),
    comparison_data_formatting: 'union',
    filters: {
      simple: { CBF_date__start: startDate, CBF_date__end: endDate },
      advanced: { op: 'and', filters: advancedFilters },
    },
  };
}

/**
 * Builds the payload for the URL trend element (afb2e5d3, `line`). Verified to
 * return ALL URLs' weekly trends in ONE call when scoped by `project_id` + date
 * + model (no per-URL filter — the wiki's "one call per URL" claim is wrong).
 * Category is intentionally omitted (the line element's tag support is
 * unverified; date+model+project is the confirmed-working scope).
 */
export function buildOwnedUrlsTrendPayload({
  model, platform, startDate, endDate, projectId,
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);
  return {
    ...(projectId && { project_id: projectId }),
    comparison_data_formatting: 'union',
    filters: {
      simple: { CBF_date__start: startDate, CBF_date__end: endDate },
      advanced: {
        op: 'and',
        filters: [
          { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
          { op: 'gte', val: startDate, col: 'CBF_date__start' },
          { op: 'lte', val: endDate, col: 'CBF_date__end' },
        ],
      },
    },
  };
}

/**
 * Merges per-project Stats-per-URL + URL-trend responses into the legacy URL
 * Inspector `owned-urls` row shape (traffic fields defaulted here; the controller
 * fills agentic/referral from Postgres for the paginated slice).
 *
 * Field mapping (verified against live element rows):
 *   url             ← stats.source
 *   citations       ← stats.citations           (summed across a URL's projects)
 *   promptsCited    ← stats.prompts_with_citation
 *   contentType     ← stats.domain_type         (used only for the owned filter)
 *   regions         ← the region code of each project the URL appears in
 *   weeklyCitations ← trend rows grouped by legend(=url): { week: ISO, value: y__mentions }
 * Gaps with NO Semrush source (stubbed, see LLMO-6086 notes / cf LLMO-6071):
 *   urlId ('' — Semrush has no source_urls.id), products ([]), weeklyPromptsCited ([]).
 *
 * Only `domain_type='Owned'` rows are kept (client-side; the element ignores a
 * server-side content-type filter). Returns the FULL owned list sorted by
 * citations desc — the controller applies client-side pagination and then joins
 * traffic for just the page's URLs (Semrush has no server-side pagination).
 *
 * @param {Array<{region?: string, stats: object, trend: object}>} projectResults
 * @returns {Array<object>} Full owned-URL list, sorted by citations desc.
 */
export function transformOwnedUrlsResponse(projectResults = []) {
  const byUrl = new Map();

  const ensure = (url) => {
    let entry = byUrl.get(url);
    if (!entry) {
      entry = {
        url, citations: 0, promptsCited: 0, regions: new Set(), weekly: new Map(),
      };
      byUrl.set(url, entry);
    }
    return entry;
  };

  for (const { region, stats, trend } of projectResults) {
    for (const row of (stats?.blocks?.data ?? [])) {
      // Owned filter is client-side: the element ignores a server-side
      // content-type filter (verified on cited-domains).
      if (!row || row.source == null) {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (String(row.domain_type ?? '').toLowerCase() !== 'owned') {
        // eslint-disable-next-line no-continue
        continue;
      }
      const entry = ensure(row.source);
      // `Number(x) || 0` (not `?? 0`) so a non-numeric value coerces to 0, not NaN.
      entry.citations += Number(row.citations) || 0;
      entry.promptsCited += Number(row.prompts_with_citation) || 0;
      if (region) {
        entry.regions.add(region);
      }
    }

    for (const line of (trend?.blocks?.lines ?? [])) {
      const url = line?.legend;
      // Only accumulate trends for URLs we kept as owned above.
      if (url == null || !byUrl.has(url) || typeof line.x !== 'string') {
        // eslint-disable-next-line no-continue
        continue;
      }
      const week = dateToIsoWeek(line.x.slice(0, 10));
      const entry = byUrl.get(url);
      entry.weekly.set(week, (entry.weekly.get(week) || 0) + (Number(line.y__mentions) || 0));
    }
  }

  const urls = [...byUrl.values()].map((e) => ({
    urlId: '', // no Semrush source_urls.id (gap — see LLMO-6086)
    url: e.url,
    citations: e.citations,
    promptsCited: e.promptsCited,
    products: [], // no per-URL product source on the element (Semrush gap)
    regions: [...e.regions],
    weeklyCitations: [...e.weekly.entries()]
      .map(([week, value]) => ({ week, value }))
      .sort((a, b) => a.week.localeCompare(b.week)),
    weeklyPromptsCited: [], // trend exposes mentions + positions only (Semrush gap)
    agenticHits: 0,
    agenticHitsTrend: [],
    referralHits: 0,
    referralHitsTrend: [],
  }));

  urls.sort((a, b) => b.citations - a.citations);
  return urls;
}
/* c8 ignore stop */
