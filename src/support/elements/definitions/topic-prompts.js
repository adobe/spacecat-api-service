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
import { buildFacetedTagFilters } from './prompts.js';

/**
 * Definitions for the Data Insights "Prompts by Topic" element
 * (78864493-90a7-449a-89ab-1ba3d09a712e, PROMPTS_BY_TOPIC — wiki row 22).
 *
 * This single rich element carries, PER PROMPT: mentions, citations, visibility,
 * position, sentiment, volume, primary_intent and prompt_topic — enough to back
 * BOTH the per-prompt drill-down (this file) and, grouped by prompt_topic, the
 * per-topic table (see topics-insights.js). It is the element the live Brand Presence MFE
 * actually uses; the wiki's separate per-topic elements (0564b061/141adc88/324c9c6a)
 * are NOT used by the product (141adc88 currently 500s).
 *
 * CONTRACT VERIFIED live (2026-07-21, dev "Adobe" sub-workspace + the prod Lovesac
 * MFE network capture):
 *  - Topic scoping key is `CBF_topic` = the BARE topic NAME (e.g. "Video Generation"),
 *    inside an `or` block within `advanced`. NOT `topic:<name>`, NOT the `prompt_topic`
 *    column (a `prompt_topic` filter is silently ignored), NOT `CBF_tags`.
 *  - `CBF_model` (resolved via resolveElementModel) and `CBF_project` (region) both sit
 *    in their own `or` blocks within `advanced` and are honored.
 *  - Date range → `filters.simple.start_date`/`end_date` (YYYY-MM-DD) when provided;
 *    omitted → the element applies its own default window.
 *  - `comparison_data_formatting: 'join'` matches the live MFE (NOT 'union').
 *  - Brand scoping needs `CBF_brand` (the brand display name) — the sub-workspace ALONE
 *    is NOT enough. This file previously claimed the opposite ("the sub-workspace already
 *    scopes the brand, so CBF_brand is not duplicated here"); that premise is FALSE for
 *    this element and was disproven live: topic "3 ft Bean Bag" (Lovesac, chatgpt,
 *    2026-08-17..2026-08-23) scored visibility 14.29 / mentions 1 off a ChatGPT answer
 *    that named Pottery Barn and never mentioned Lovesac, while the Brand Presence MFE —
 *    which DOES send `CBF_brand` — correctly showed 0. Without the filter the element
 *    counts ANY tracked brand appearing in the topic's responses, so competitor mentions
 *    inflate the brand's mentions/visibility/citations. The column is `CBF_brand`, NOT
 *    `CBF_ws_brand`. `CBF_brand_urls` remains un-sent (it scopes URL lists, not mentions).
 *  - `CBF_brand` is an ATTRIBUTION filter, not a row filter: it changes each row's
 *    mentions/citations/visibility but never the row set. Verified twice — an all-topics
 *    probe returned the same 1520 rows with and without it, and the case/alias probe
 *    returned an identical 45-row set for a matching name, a non-matching name and an
 *    alias. So `totalCount`, `promptCount` and pagination are unaffected by brand scoping.
 */

/**
 * `position: -1` is the element's "not ranked / not answered" sentinel, and
 * `sentiment: null` means the prompt has no sentiment. Both are surfaced as `null`
 * so consumers (and the per-topic averages in topics-insights.js) can exclude them rather
 * than treat -1 as a real rank or null as 0.
 */
const NO_POSITION = -1;

function toNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Builds the payload for the PROMPTS_BY_TOPIC element (78864493).
 *
 * @param {object} [params]
 * @param {string} [params.topic] - Topic NAME to scope to (`CBF_topic`). When omitted,
 *   the element returns prompts across ALL topics (used by topics-insights.js to group).
 * @param {string} [params.model] - AI model filter (Semrush engine name or UI platform
 *   code). Translated + validated via {@link resolveElementModel}.
 * @param {string} [params.platform] - Legacy alias for `model`; `model` takes precedence.
 * @param {string} [params.startDate] - ISO date (YYYY-MM-DD). Optional.
 * @param {string} [params.endDate] - ISO date (YYYY-MM-DD). Optional.
 * @param {string} [params.projectId] - Single Semrush project id to scope to (`CBF_project`).
 * @param {string[]} [params.projectIds] - Multiple Semrush project ids to OR together
 *   (`CBF_project`); takes precedence over `projectId` when both are given.
 * @param {string} [params.brandName] - Brand display name to scope mentions/visibility/
 *   citations to this brand (`CBF_brand`). Omitted, blank or whitespace-only →
 *   brand-agnostic (counts any tracked brand in the topic's responses).
 *   VERIFIED live 2026-09-08 (Lovesac, topic "Lovesac Furniture and Accessories",
 *   2026-08-17..2026-08-23): matching is **exact and CASE-SENSITIVE**, and registered
 *   aliases are **NOT** resolved — `Lovesac` → 315 mentions, while `lovesac` → 0 and the
 *   registered alias `PillowSac` → 0, over an identical 45-row set. So this value must be
 *   the brand's exact Semrush-tracked name: any casing/rename/alias divergence between
 *   `brands.name` and Semrush silently zeroes the counts, which is indistinguishable from
 *   a genuine "no presence". That is why a blank name falls back to brand-agnostic rather
 *   than sending a value that cannot match.
 * @returns {object} Semrush element request payload.
 */
export function buildTopicPromptsPayload({
  topic, model, platform, startDate, endDate, tagPaths, category, projectId, projectIds,
  brandName,
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);

  const advancedFilters = [
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
  ];
  // Brand scoping: restrict mentions/visibility/citations to THIS brand via CBF_brand.
  // Without it the element counts ANY tracked brand in the topic's responses, so a
  // competitor mentioned in an answer where the brand is absent inflates the numbers
  // (verified live against the Brand Presence MFE, which sends this filter — see the
  // module header). Wrapped in a single-value `or` block to match the CBF_model/
  // CBF_topic/CBF_project shape below; functionally identical to the MFE's bare `eq`.
  //
  // Trimmed here, and treated as absent when the result is empty, so the invariant holds
  // for EVERY caller: a blank or whitespace-only name must fall back to brand-agnostic
  // rather than send `CBF_brand: "   "`, which matches no brand and would silently zero
  // the counts — indistinguishable from a real "no presence". Note `hasText` does NOT
  // trim (`!!str && isString(str)`), so guarding with it here would not catch "   ".
  const scopedBrand = typeof brandName === 'string' ? brandName.trim() : '';
  if (scopedBrand) {
    advancedFilters.push({ op: 'or', filters: [{ op: 'eq', val: scopedBrand, col: 'CBF_brand' }] });
  }
  // Topic scoping: the bare topic name on CBF_topic (verified live). Absent → all topics.
  if (topic) {
    advancedFilters.push({ op: 'or', filters: [{ op: 'eq', val: topic, col: 'CBF_topic' }] });
  }
  // Project scoping: CBF_project (one or more Semrush project ids), inside its own `or` block.
  const ids = Array.isArray(projectIds) && projectIds.length > 0
    ? projectIds
    : [projectId].filter(Boolean);
  if (ids.length > 0) {
    advancedFilters.push({
      op: 'or',
      filters: ids.map((id) => ({ op: 'eq', val: id, col: 'CBF_project' })),
    });
  }
  advancedFilters.push(...buildFacetedTagFilters({ tagPaths, category }));

  const filters = { advanced: { op: 'and', filters: advancedFilters } };
  // Only send a date window when the caller provided one; otherwise let the element
  // apply its own default (sending a half-open range risks an ignored filter).
  if (startDate && endDate) {
    filters.simple = { start_date: startDate, end_date: endDate };
  }

  return {
    comparison_data_formatting: 'join',
    filters,
  };
}

/**
 * Transforms the raw PROMPTS_BY_TOPIC response into a flat array of per-prompt rows in
 * our clean camelCase contract (the UI mapping layer adapts these onto `PromptDetail`).
 *
 * VERIFIED ROW SHAPE (live): each `blocks.data` row is
 *   { prompt, prompt_topic, primary_intent, mentions, citations, visibility, position,
 *     sentiment, volume, project_title, days, model, model_project_cbf }
 * where `citations`/`mentions` may be null, `position === -1` means unranked, and
 * `sentiment === null` means no sentiment. `config.data` is null (no column metadata).
 * `days` (the per-window execution count) is surfaced in the clean contract as `executions`.
 *
 * @param {object} raw - Raw element response.
 * @returns {Array<object>} One row per prompt.
 */
export function transformTopicPromptsResponse(raw) {
  const rows = Array.isArray(raw?.blocks?.data) ? raw.blocks.data : [];
  return rows.map((row) => {
    const position = toNumberOrNull(row?.position);
    return {
      prompt: typeof row?.prompt === 'string' ? row.prompt : '',
      topic: typeof row?.prompt_topic === 'string' ? row.prompt_topic : '',
      primaryIntent: typeof row?.primary_intent === 'string' ? row.primary_intent : '',
      region: typeof row?.project_title === 'string' ? row.project_title : '',
      mentions: Number(row?.mentions) || 0,
      citations: Number(row?.citations) || 0,
      visibility: Number(row?.visibility) || 0,
      // -1 is the "not ranked" sentinel → null so consumers don't treat it as a rank.
      position: position === NO_POSITION ? null : position,
      sentiment: toNumberOrNull(row?.sentiment),
      volume: Number(row?.volume) || 0,
      // `days` = the number of executions in the window (Semrush runs a prompt at most once
      // per model/date/project), surfaced as `executions` so consumers can compute a true
      // per-execution citation rate (citations / executions) rather than citations / mentions.
      // VERIFIED live 2026-09-07 (Lovesac, one topic, 30-day window, 100 rows): days <= window
      // with 0 violations, and mentions <= days universally.
      executions: Number(row?.days) || 0,
    };
  });
}
