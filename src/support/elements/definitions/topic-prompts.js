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
 * Definitions for the Data Insights "Prompts by Topic" element
 * (78864493-90a7-449a-89ab-1ba3d09a712e, PROMPTS_BY_TOPIC — wiki row 22).
 *
 * This single rich element carries, PER PROMPT: mentions, citations, visibility,
 * position, sentiment, volume, primary_intent and prompt_topic — enough to back
 * BOTH the per-prompt drill-down (this file) and, grouped by prompt_topic, the
 * per-topic table (see topics.js). It is the element the live Brand Presence MFE
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
 *  - Brand scoping comes from targeting the brand's sub-workspace (resolved in the
 *    controller), so `CBF_brand`/`CBF_brand_urls` (which the MFE also sends) are not
 *    duplicated here.
 */

/**
 * `position: -1` is the element's "not ranked / not answered" sentinel, and
 * `sentiment: null` means the prompt has no sentiment. Both are surfaced as `null`
 * so consumers (and the per-topic averages in topics.js) can exclude them rather
 * than treat -1 as a real rank or null as 0.
 */
const NO_POSITION = -1;

/* c8 ignore start -- LLMO-6418 POC endpoint; excluded from coverage % (has unit tests) */
function toNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Builds the payload for the PROMPTS_BY_TOPIC element (78864493).
 *
 * @param {object} [params]
 * @param {string} [params.topic] - Topic NAME to scope to (`CBF_topic`). When omitted,
 *   the element returns prompts across ALL topics (used by topics.js to group).
 * @param {string} [params.model] - AI model filter (Semrush engine name or UI platform
 *   code). Translated + validated via {@link resolveElementModel}.
 * @param {string} [params.platform] - Legacy alias for `model`; `model` takes precedence.
 * @param {string} [params.startDate] - ISO date (YYYY-MM-DD). Optional.
 * @param {string} [params.endDate] - ISO date (YYYY-MM-DD). Optional.
 * @param {string} [params.projectId] - Semrush project id for region scoping (`CBF_project`).
 * @returns {object} Semrush element request payload.
 */
export function buildTopicPromptsPayload({
  topic, model, platform, startDate, endDate, projectId,
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);

  const advancedFilters = [
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
  ];
  // Topic scoping: the bare topic name on CBF_topic (verified live). Absent → all topics.
  if (topic) {
    advancedFilters.push({ op: 'or', filters: [{ op: 'eq', val: topic, col: 'CBF_topic' }] });
  }
  // Region: CBF_project (a Semrush project id), inside its own `or` block.
  if (projectId) {
    advancedFilters.push({ op: 'or', filters: [{ op: 'eq', val: projectId, col: 'CBF_project' }] });
  }

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
    };
  });
}
/* c8 ignore stop */
