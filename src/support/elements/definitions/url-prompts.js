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

import { resolveElementModel, isAllPlatforms } from '../constants.js';

/**
 * Definitions for the URL Inspector "URL Prompts" element
 * (b4f1ead7-4aea-41ea-b1ce-311004715d63 — wiki Part 2 row 10). Powers the URL
 * details drill-down: the prompts for which a specific URL was cited as a source.
 *
 * CONTRACT VERIFIED live (2026-07-29, prod Lovesac sub-workspace
 * 3cbb3c36-4985-4650-8b0a-bd87969af6f2): for `https://www.lovesac.com/sactionals`
 * over a 4-week window it returned 516 prompt rows.
 *  - URL scoping key is `CBF_source` = the FULL URL string. This element is unique
 *    in placing `CBF_source` in BOTH `filters.simple` and `filters.advanced` (an
 *    `eq`); both are sent to match the verified-working payload.
 *  - Date range → `advanced` `CBF_date__start` (gte) / `CBF_date__end` (lte)
 *    (NOT `simple.start_date`, which is what the topic-prompts element uses).
 *  - `CBF_model` (resolved via resolveElementModel) sits in `advanced` as a bare `eq`.
 *  - Brand scoping comes from targeting the brand's sub-workspace (resolved in the
 *    controller). The live MFE also sends `CBF_brand`, but the url-inspector sibling
 *    definitions (owned-urls / domain-urls / cited-domains) do not duplicate it —
 *    the sub-workspace already scopes the brand — so it is omitted here too.
 *  - Market scope → the element's TOP-LEVEL `project_id` (like owned-urls), NOT a
 *    `CBF_project` advanced filter (verified live 2026-07-30: `CBF_project` is a silent
 *    no-op; a bogus top-level `project_id` → HTTP 422). The element takes ONE project id
 *    per call, so the service fans out per selected market and unions the results.
 *  - Category scope → `CBF_tags` (op eq) in the `advanced` block (NOT `simple`, which is a
 *    no-op), value = the full `category__<label>` tag — same mechanism as owned-urls
 *    ({@link buildOwnedUrlsStatsPayload}).
 */

/**
 * Builds the payload for the URL_PROMPTS element (b4f1ead7).
 *
 * @param {object} params
 * @param {string} params.url - The cited URL to drill into (`CBF_source`).
 * @param {string} [params.model] - AI model filter (Semrush engine name or UI platform
 *   code). Translated + validated via {@link resolveElementModel}. The `all` sentinel
 *   ({@link isAllPlatforms}) OMITS the `CBF_model` filter → deduped cross-model union.
 * @param {string} [params.platform] - Legacy alias for `model`; `model` takes precedence.
 * @param {string} params.startDate - ISO date (YYYY-MM-DD).
 * @param {string} params.endDate - ISO date (YYYY-MM-DD).
 * @param {string} [params.category] - Full `category__<label>` tag value, sent as-is as a
 *   `CBF_tags` eq in `advanced` (callers already include the `category__` prefix).
 * @param {string} [params.projectId] - Semrush project id (market scope, top-level).
 * @returns {object} Semrush element request payload.
 */
export function buildUrlPromptsPayload({
  url, model, platform, startDate, endDate, category, projectId,
} = {}) {
  const requestedModel = model || platform;
  const advancedFilters = [
    { op: 'eq', val: url, col: 'CBF_source' },
    { op: 'gte', val: startDate, col: 'CBF_date__start' },
    { op: 'lte', val: endDate, col: 'CBF_date__end' },
  ];
  // `all` sentinel → omit CBF_model entirely (deduped cross-model union). Checked BEFORE
  // resolveElementModel, which would otherwise coerce 'all' to DEFAULT_ELEMENT_MODEL.
  // Kept as the FIRST advanced filter for the single-model case (unchanged payload shape).
  if (!isAllPlatforms(requestedModel)) {
    advancedFilters.unshift({ op: 'eq', val: resolveElementModel(requestedModel), col: 'CBF_model' });
  }
  if (category) {
    advancedFilters.push({ op: 'eq', val: category, col: 'CBF_tags' });
  }
  return {
    ...(projectId && { project_id: projectId }),
    filters: {
      simple: { CBF_source: url },
      advanced: {
        op: 'and',
        filters: advancedFilters,
      },
    },
  };
}

/**
 * Transforms the raw URL_PROMPTS response into a flat array of per-prompt rows in our
 * clean camelCase contract.
 *
 * VERIFIED ROW SHAPE (live): each `blocks.data` row is
 *   { prompt, source, source_title, brand_mentioned, brands_string, closest_date, url_cbf }
 * where `brands_string` is a comma-separated brand list. The element returns one row per
 * distinct prompt (rowCount === distinct prompts in the live probe). `category`, `topic`
 * and `region` are NOT returned by this element (documented gap).
 *
 * @param {object} raw - Raw element response.
 * @returns {Array<object>} One row per prompt.
 */
export function transformUrlPromptsResponse(raw) {
  const rows = Array.isArray(raw?.blocks?.data) ? raw.blocks.data : [];
  return rows.map((row) => ({
    prompt: typeof row?.prompt === 'string' ? row.prompt : '',
    // PG url-prompts contract (this endpoint will replace it). The Semrush element
    // exposes none of these, so they are empty/0 — kept for shape parity so the swap
    // is a no-op for consumers. `citations` is 0, not a real count: the element
    // returns one row per distinct prompt with no per-prompt citation count.
    category: '',
    region: '',
    topics: '',
    citations: 0,
    // SR-only extras (additional keys; harmless to a PG consumer): power the SR
    // details dialog's Prompt / Brands mentioned / Last cited columns.
    sourceTitle: typeof row?.source_title === 'string' ? row.source_title : '',
    brandMentioned: typeof row?.brand_mentioned === 'string' ? row.brand_mentioned : '',
    brands: typeof row?.brands_string === 'string' && row.brands_string
      ? row.brands_string.split(',').map((b) => b.trim()).filter(Boolean)
      : [],
    closestDate: typeof row?.closest_date === 'string' ? row.closest_date : null,
  }));
}

/**
 * Merges the per-market URL_PROMPTS responses (each already run through
 * {@link transformUrlPromptsResponse}) into one deduped list. The element takes ONE
 * top-level `project_id` per call, so a multi-market selection fans out one call per
 * project (see `getUrlPrompts`) and this unions the transformed results. Extracted here
 * (rather than inlined in the service) to match the sibling merge helpers in
 * `owned-urls.js` / `cited-domains.js` and to keep the merge unit-testable.
 *
 * Dedupe is EXACT-STRING on `prompt` — NO case/whitespace normalization. Distinct
 * markets are distinct geo+language slices, so a case- or space-differing prompt is a
 * genuinely different prompt, not a variant to fold together. Rows with an empty
 * `prompt` are malformed (the element returns one row per real prompt) and are DROPPED,
 * not collapsed into a single bogus `''` entry that would hide a market's data.
 *
 * On collision the FIRST occurrence wins for scalar fields (`sourceTitle`,
 * `brandMentioned`, ...). This is non-deterministic across markets by design: a URL's
 * prompt text is the same everywhere, only per-market citation metadata differs, and the
 * SR dialog shows a single row per prompt. `brands` are unioned and the latest
 * `closestDate` is kept so "Brands mentioned" / "Last cited" reflect ALL selected markets.
 *
 * @param {Array<Array<object>>} perProjectRows - Transformed rows, one array per market.
 * @returns {Array<object>} Deduped union, in first-seen order.
 */
export function mergeUrlPromptsResponses(perProjectRows = []) {
  const byPrompt = new Map();
  for (const rows of (Array.isArray(perProjectRows) ? perProjectRows : [])) {
    for (const row of (Array.isArray(rows) ? rows : [])) {
      // Drop malformed/blank-prompt rows so multiple markets' blanks don't collapse
      // into one bogus '' entry (see docstring).
      if (!row?.prompt) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const existing = byPrompt.get(row.prompt);
      if (!existing) {
        byPrompt.set(row.prompt, { ...row, brands: [...(row.brands ?? [])] });
        // eslint-disable-next-line no-continue
        continue;
      }
      // Union brands (dedupe); keep the latest closestDate across markets.
      existing.brands = [...new Set([...existing.brands, ...(row.brands ?? [])])];
      if (row.closestDate && (!existing.closestDate || row.closestDate > existing.closestDate)) {
        existing.closestDate = row.closestDate;
      }
    }
  }
  return [...byPrompt.values()];
}
