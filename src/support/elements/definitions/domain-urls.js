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

import { isAllPlatforms, resolveElementModel } from '../constants.js';
import { createScopeMatcher, parseCandidateUrl, splitScope } from '../url-scope.js';

/**
 * Builds the payload for the Stats-per-URL element (9af5ed83, `table`) scoped to a
 * single (project, date, model). Identical shape to the owned-urls stats payload
 * (date in BOTH simple + advanced, `CBF_model` in an `or` block, `category__<label>`
 * tag, region via top-level `project_id`). `startDate`/`endDate` are required
 * (validated in the controller).
 *
 * The domain filter is NOT expressed here: the element ignores a server-side domain
 * filter (verified live — `CBF_domain`/`cbf_domain`/`CBF_source`, eq + contains, all
 * returned the full project table unchanged), so `hostname` is applied client-side in
 * the transform. This mirrors how owned-urls filters `domain_type='Owned'` client-side.
 *
 * @param {object} params
 * @param {string} [params.model] - AI model (Semrush engine or UI platform code).
 * @param {string} [params.platform] - Legacy alias for `model`; `model` wins.
 * @param {string} params.startDate - ISO date (YYYY-MM-DD).
 * @param {string} params.endDate - ISO date (YYYY-MM-DD).
 * @param {string} [params.category] - Full `category__<label>` tag value, sent
 *   as-is (callers already include the `category__` prefix).
 * @param {string} [params.projectId] - Semrush project id (region scope, top-level).
 */
export function buildDomainUrlsPayload({
  model, platform, startDate, endDate, category, projectId,
} = {}) {
  const requestedModel = model || platform;
  const advancedFilters = [
    { op: 'gte', val: startDate, col: 'CBF_date__start' },
    { op: 'lte', val: endDate, col: 'CBF_date__end' },
  ];
  if (!isAllPlatforms(requestedModel)) {
    const resolvedModel = resolveElementModel(requestedModel);
    advancedFilters.unshift({ op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] });
  }
  if (category) {
    advancedFilters.push({ op: 'eq', val: category, col: 'CBF_tags' });
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
 * Parses the pagination params (0-based `page`, `pageSize`) mirroring the legacy
 * parsePaginationParams (defaultPageSize 50, clamped to [1, 1000]).
 */
function parsePagination({ page, pageSize } = {}) {
  return {
    page: Math.max(0, Number.parseInt(page, 10) || 0),
    pageSize: Math.min(Math.max(1, Number.parseInt(pageSize, 10) || 50), 1000),
  };
}

/**
 * Merges per-project Stats-per-URL responses into the legacy URL Inspector
 * `domain-urls` contract (Phase 2 drilldown):
 *   { urls: [{ urlId, url, contentType, citations, promptsCited, categories,
 *              regions }], totalCount }
 *
 * Field mapping (verified against live element rows):
 *   url          ← stats.source
 *   citations    ← stats.citations                (summed across a URL's projects)
 *   promptsCited ← stats.prompts_with_citation    (summed)
 *   contentType  ← stats.domain_type
 *   regions      ← the region code(s) of each project the URL appears in, joined
 * Gaps with NO Semrush source (stubbed, see LLMO-6160 notes / cf LLMO-6086):
 *   urlId ('' — Semrush has no source_urls.id), categories ('' — no per-URL tag source).
 * `regions`/`categories` are STRINGS here (the legacy contract + the UI `DomainUrlRow`
 * type), NOT arrays like owned-urls.
 *
 * When `hostname` is supplied it is parsed as a `{host, pathPrefix}` scope
 * (`intuit.com`, `quickbooks.intuit.com`, `nba.com/kings` are all expressible)
 * and only rows within that scope are kept — the eTLD+1 fold for host-only
 * scopes, narrowed by the path prefix when one is given. When `siteBaseUrl`
 * (the brand's own site anchor) is supplied and the requested scope is a
 * proper ancestor of it, rows in the site's own subtree are excluded from the
 * fold — the site's own URLs are addressable by requesting the site scope
 * itself (see {@link createScopeMatcher}). When `hostname` is omitted, all
 * source hosts are kept. An optional `channel` (content-type) filter is then applied
 * client-side on `contentType` (case-insensitive) — the element has no server-side
 * content-type filter, so this mirrors cited-domains + the legacy RPC's `p_channel`.
 * Semrush has no server-side pagination, so after filtering we sort by citations
 * desc and slice client-side; `totalCount` is the post-filter, pre-slice count.
 *
 * @param {Array<{region?: string, stats: object}>} projectResults
 * @param {object} params - { hostname, siteBaseUrl, channel, page, pageSize }.
 * @returns {{ urls: Array<object>, totalCount: number }}
 */
export function transformDomainUrlsResponse(projectResults = [], params = {}) {
  const { page, pageSize } = parsePagination(params);
  const rawHostname = String(params.hostname ?? '').trim();
  const requestedScope = splitScope(rawHostname);
  // A non-empty hostname that parses to no host (e.g. a bare path) can match
  // nothing — return empty rather than silently dropping the filter.
  if (rawHostname !== '' && !requestedScope) {
    return { urls: [], totalCount: 0 };
  }
  const siteScope = splitScope(params.siteBaseUrl);
  const matchesScope = requestedScope && createScopeMatcher(requestedScope, siteScope);
  const channel = typeof params.channel === 'string' ? params.channel.trim() : '';
  const byUrl = new Map();

  for (const { region, stats } of projectResults) {
    for (const row of (stats?.blocks?.data ?? [])) {
      if (!row || row.source == null) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const candidate = parseCandidateUrl(row.source);
      if (!candidate || (matchesScope && !matchesScope(candidate))) {
        // eslint-disable-next-line no-continue
        continue;
      }
      let entry = byUrl.get(row.source);
      if (!entry) {
        entry = {
          url: row.source,
          contentType: row.domain_type || '',
          citations: 0,
          promptsCited: 0,
          regions: new Set(),
        };
        byUrl.set(row.source, entry);
      }
      // `Number(x) || 0` (not `?? 0`) so a non-numeric value coerces to 0, not NaN.
      entry.citations += Number(row.citations) || 0;
      entry.promptsCited += Number(row.prompts_with_citation) || 0;
      if (region) {
        entry.regions.add(region);
      }
    }
  }

  let urls = [...byUrl.values()].map((e) => ({
    urlId: '', // no Semrush source_urls.id (gap — see LLMO-6160 / cf LLMO-6086)
    url: e.url,
    contentType: e.contentType,
    citations: e.citations,
    promptsCited: e.promptsCited,
    categories: '', // no per-URL category source on the element (Semrush gap)
    // Legacy `regions` was a comma-joined string_agg with NO space — match it for
    // exact drop-in parity. Sorted for determinism (string_agg order is arbitrary).
    regions: [...e.regions].sort().join(','),
  }));

  // `channel` = content-type filter, applied client-side (element ignores it
  // server-side), mirroring cited-domains + the legacy RPC's `p_channel`.
  if (channel) {
    const wanted = channel.toLowerCase();
    urls = urls.filter((u) => u.contentType.toLowerCase() === wanted);
  }

  urls.sort((a, b) => b.citations - a.citations);

  const totalCount = urls.length;
  const offset = page * pageSize;
  return { urls: urls.slice(offset, offset + pageSize), totalCount };
}
