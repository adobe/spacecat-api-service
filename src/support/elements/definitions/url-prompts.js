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
 */

/**
 * Builds the payload for the URL_PROMPTS element (b4f1ead7).
 *
 * @param {object} params
 * @param {string} params.url - The cited URL to drill into (`CBF_source`).
 * @param {string} [params.model] - AI model filter (Semrush engine name or UI platform
 *   code). Translated + validated via {@link resolveElementModel}.
 * @param {string} [params.platform] - Legacy alias for `model`; `model` takes precedence.
 * @param {string} params.startDate - ISO date (YYYY-MM-DD).
 * @param {string} params.endDate - ISO date (YYYY-MM-DD).
 * @returns {object} Semrush element request payload.
 */
export function buildUrlPromptsPayload({
  url, model, platform, startDate, endDate,
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);
  return {
    filters: {
      simple: { CBF_source: url },
      advanced: {
        op: 'and',
        filters: [
          { op: 'eq', val: resolvedModel, col: 'CBF_model' },
          { op: 'eq', val: url, col: 'CBF_source' },
          { op: 'gte', val: startDate, col: 'CBF_date__start' },
          { op: 'lte', val: endDate, col: 'CBF_date__end' },
        ],
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
    sourceTitle: typeof row?.source_title === 'string' ? row.source_title : '',
    brandMentioned: typeof row?.brand_mentioned === 'string' ? row.brand_mentioned : '',
    brands: typeof row?.brands_string === 'string' && row.brands_string
      ? row.brands_string.split(',').map((b) => b.trim()).filter(Boolean)
      : [],
    closestDate: typeof row?.closest_date === 'string' ? row.closest_date : null,
  }));
}
