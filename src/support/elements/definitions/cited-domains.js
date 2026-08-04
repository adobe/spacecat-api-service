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

// Legacy default window is a rolling 28 days (see defaultDateRange in
// llmo-brand-presence.js). Kept inline here so this definition stays pure and does
// not import controller code (support/elements must never depend on controllers).
const DEFAULT_WINDOW_DAYS = 28;

/* c8 ignore start -- LLMO-6020 POC endpoint; unit tests intentionally deferred */
function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - DEFAULT_WINDOW_DAYS);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

/**
 * Builds the payload for the Cited Domains element (98b91d00, "Stats per Domain").
 * The element is a `table` returning one row per domain cited in the workspace over
 * the given window.
 *
 * Quirks encoded here (confirmed against the migration wiki row + live testing):
 *  - The date range is expressed as `CBF_date__start`/`CBF_date__end` and is passed in
 *    BOTH the `simple` and `advanced` blocks — the element expects the duplication.
 *  - `CBF_model` sits inside an `or` block within `advanced`.
 *  - Brand scoping is NOT a filter on this element (`CBF_ws_brand` is a confirmed no-op);
 *    it comes from the request targeting the brand's sub-workspace (resolved in the
 *    controller). So no brand filter is added here.
 *
 * @param {object} [params]
 * @param {string} [params.model] - AI model filter value (Semrush engine name or UI
 *   platform code). Translated + validated via {@link resolveElementModel}.
 * @param {string} [params.platform] - Legacy alias for `model`; `model` takes precedence.
 * @param {string} [params.startDate] - ISO date (YYYY-MM-DD). Defaults to 28 days ago.
 * @param {string} [params.endDate] - ISO date (YYYY-MM-DD). Defaults to today.
 * @param {string} [params.category] - Full `category__<label>` tag value, sent
 *   as-is (callers already include the `category__` prefix).
 * @param {string} [params.projectId] - Semrush project id to scope to (top-level).
 *   This element only accepts ONE project per call (no OR-list equivalent) —
 *   {@link transformCitedDomainsResponses} fans out one call per id and merges
 *   when a caller selects more than one project.
 */
export function buildCitedDomainsPayload({
  model, platform, startDate, endDate, category, projectId,
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);
  const defaults = defaultDateRange();
  const start = startDate || defaults.startDate;
  const end = endDate || defaults.endDate;

  const advancedFilters = [
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
    { op: 'gte', val: start, col: 'CBF_date__start' },
    { op: 'lte', val: end, col: 'CBF_date__end' },
  ];
  // Category is a namespaced Semrush tag (`category__<label>`). Verified honored by this
  // element (unlike region/brand/content-type filters, which it ignores). Callers already
  // include the `category__` prefix, so the value is sent straight through unmodified.
  if (category) {
    advancedFilters.push({ op: 'eq', val: category, col: 'CBF_tags' });
  }

  return {
    // Project scoping: a Semrush project == one (brand, market). Selecting it via the
    // top-level `project_id` (NOT a CBF_* filter — the element ignores those) scopes results to
    // that project. Supplied by the caller via the `projectId` query param. Omitted → all of
    // the workspace's projects.
    ...(projectId && { project_id: projectId }),
    comparison_data_formatting: 'union',
    filters: {
      simple: { CBF_date__start: start, CBF_date__end: end },
      advanced: { op: 'and', filters: advancedFilters },
    },
  };
}

/**
 * Parses the pagination params (0-based `page`, `pageSize`) mirroring the legacy
 * parsePaginationParams (defaultPageSize 50 for cited-domains, clamped to [1, 1000]).
 */
function parsePagination({ page, pageSize } = {}) {
  return {
    page: Math.max(0, Number.parseInt(page, 10) || 0),
    pageSize: Math.min(Math.max(1, Number.parseInt(pageSize, 10) || 50), 1000),
  };
}

/**
 * Transforms the raw Cited Domains element response into the legacy URL Inspector
 * `cited-domains` contract so the panel is drop-in compatible:
 *   { domains: [{ domain, totalCitations, totalUrls, promptsCited,
 *                 contentType, categories, regions }], totalCount }
 *
 * The element is a `table` (rows in `blocks.data`). Field mapping:
 *   domain          ← domain
 *   totalCitations  ← mentions_end
 *   totalUrls       ← urls_count
 *   promptsCited    ← prompts_with_citations
 *   contentType     ← domain_type  (Owned/Other/Social/Earned/Benchmark Competitors)
 * `contentType` is load-bearing: the UI's Third-Party table filters it with
 * `contentType?.toLowerCase() !== 'owned'`, so a domain classified `Owned` by Semrush
 * (`domain_type`) is correctly excluded there. `categories` and `regions` have NO source
 * on this element (Semrush gap) — returned as `''` to match the legacy handler's own
 * `|| ''` defaulting and the UI's non-nullable `string` contract.
 *
 * The `channel` filter maps to the content-type/`domain_type` dimension. The element does
 * NOT honor a server-side content-type filter (verified), so we apply it client-side over
 * the returned rows (case-insensitive on `contentType`) — cheap, since the element returns
 * the full table anyway. Semrush has no server-side pagination, so after filtering we sort
 * by citation count descending and slice client-side; `totalCount` is the post-filter,
 * pre-slice row count.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {Array<object>} Unpaginated, unsorted domain rows.
 */
function extractDomainRows(raw) {
  const rows = (raw?.blocks?.data ?? [])
    .filter((row) => row && row.domain != null);

  return rows.map((row) => ({
    domain: row.domain || '',
    // `Number(x) || 0` (not `Number(x ?? 0)`) so a non-numeric value coerces to 0 instead
    // of NaN — NaN would corrupt the totalCitations sort and serialize as null.
    totalCitations: Number(row.mentions_end) || 0,
    totalUrls: Number(row.urls_count) || 0,
    promptsCited: Number(row.prompts_with_citations) || 0,
    // Semrush ownership classification; drives the UI's owned-vs-third-party filter.
    contentType: row.domain_type || '',
    // No source on element 98b91d00 (Semrush gap) — '' matches the legacy handler.
    categories: '',
    regions: '',
  }));
}

/**
 * Merges domain rows from multiple per-project Cited Domains calls (one call per
 * selected `projectId` — this element accepts only one project per call, see
 * {@link buildCitedDomainsPayload}), summing the numeric fields for domains cited
 * under more than one project.
 *
 * @param {Array<Array<object>>} rowsByProject - One row array per project (from
 *   {@link extractDomainRows}).
 * @returns {Array<object>} Merged domain rows.
 */
function mergeDomainRows(rowsByProject) {
  const byDomain = new Map();
  for (const rows of rowsByProject) {
    for (const row of rows) {
      const existing = byDomain.get(row.domain);
      if (!existing) {
        byDomain.set(row.domain, { ...row });
      } else {
        existing.totalCitations += row.totalCitations;
        existing.totalUrls += row.totalUrls;
        existing.promptsCited += row.promptsCited;
        existing.contentType = existing.contentType || row.contentType;
      }
    }
  }
  return [...byDomain.values()];
}

/**
 * Applies the client-side `channel` (content-type) filter, citations-desc sort, and
 * pagination shared by both the single- and multi-project entry points.
 *
 * @param {Array<object>} domainsIn - Rows from {@link extractDomainRows} or
 *   {@link mergeDomainRows}.
 * @param {object} [params] - Query params (page, pageSize, channel).
 * @returns {{ domains: Array<object>, totalCount: number }}
 */
function paginateDomains(domainsIn, params = {}) {
  const { page, pageSize } = parsePagination(params);
  const channel = typeof params.channel === 'string' ? params.channel.trim() : '';

  let domains = domainsIn;
  // `channel` = content-type filter, applied client-side (element ignores it server-side).
  if (channel) {
    const wanted = channel.toLowerCase();
    domains = domains.filter((d) => d.contentType.toLowerCase() === wanted);
  }

  domains = [...domains].sort((a, b) => b.totalCitations - a.totalCitations);

  const totalCount = domains.length;
  const offset = page * pageSize;
  return { domains: domains.slice(offset, offset + pageSize), totalCount };
}

/**
 * Transforms a single raw Cited Domains element response into the legacy URL
 * Inspector `cited-domains` contract (see module doc above for field mapping).
 *
 * @param {object} raw - Raw response from the Elements API.
 * @param {object} [params] - Query params (page, pageSize, channel).
 * @returns {{ domains: Array<object>, totalCount: number }}
 */
export function transformCitedDomainsResponse(raw, params = {}) {
  return paginateDomains(extractDomainRows(raw), params);
}

/**
 * Transforms and merges raw Cited Domains responses from multiple per-project
 * calls (one per caller-selected `projectId`) into the same legacy contract as
 * {@link transformCitedDomainsResponse}, summing counts for domains cited under
 * more than one project before sorting/paginating once over the merged set.
 *
 * @param {Array<object>} rawList - One raw element response per project.
 * @param {object} [params] - Query params (page, pageSize, channel).
 * @returns {{ domains: Array<object>, totalCount: number }}
 */
export function transformCitedDomainsResponses(rawList, params = {}) {
  return paginateDomains(mergeDomainRows(rawList.map(extractDomainRows)), params);
}
/* c8 ignore stop */
