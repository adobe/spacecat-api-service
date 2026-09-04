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

import { buildAdvancedFilters, resolveElementModel } from '../constants.js';

/**
 * Default page size for a Prompt Responses call.
 *
 * Measured live 2026-09-04 against the external route (Repsol ES workspace), timing and
 * payload per page:
 *
 *   |   limit | result                    |
 *   |--------:|---------------------------|
 *   |     400 | 200 —  6.8s,  1.3 MB      |
 *   |   1,500 | 200 —  8.3s,  4.9 MB      |
 *   |   5,000 | 200 — 12.4s, 14.7 MB      |
 *   |  20,000 | 200 — 44.6s, 60.6 MB      |
 *   |  50,000 | 504 Gateway Timeout       |
 *
 * 5,000 is the default: it is an order of magnitude fewer round trips than 400 while keeping
 * a page near ten seconds and well inside gateway timeouts. Raising `limit` is strongly
 * preferable to walking `offset`, because every call re-scans the whole rolling window.
 */
export const DEFAULT_RESPONSE_PAGE_SIZE = 5000;

/**
 * Hard ceiling on `limit`. 20,000 is the largest page observed to succeed; 50,000 returns a
 * `504` (see the table above). A caller asking for more is clamped rather than allowed to fail
 * upstream. An earlier revision of this file set the ceiling at 1,000 on the belief that the
 * element 504s above ~1,500 rows — that was wrong by more than a factor of ten, and it clamped
 * callers to twenty times below what the element actually serves.
 */
export const MAX_RESPONSE_PAGE_SIZE = 20000;

/**
 * Sort applied to every Prompt Responses call.
 *
 * `sort_columns` is REQUIRED for deterministic pagination: without it the element does not
 * guarantee a stable row order between calls, so a paginated walk can silently repeat or
 * skip rows across pages. Sorting by `prompt` gives a total order that is stable across the
 * two calls the day-difference in `response-feed.js` depends on.
 */
const RESPONSE_SORT_COLUMNS = Object.freeze(['prompt asc']);

/**
 * Clamps a caller-supplied page size into `[1, MAX_RESPONSE_PAGE_SIZE]`, falling back to
 * {@link DEFAULT_RESPONSE_PAGE_SIZE} for absent/non-numeric input.
 *
 * @param {number|string} [limit] - Requested page size.
 * Exported so {@link module:response-sources} shares one definition rather than duplicating
 * it — both elements page under the same per-workspace request budget.
 *
 * @param {number|string} [limit] - Requested page size.
 * @returns {number} Clamped page size.
 */
export function clampLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RESPONSE_PAGE_SIZE;
  }
  return Math.min(Math.max(1, parsed), MAX_RESPONSE_PAGE_SIZE);
}

/**
 * Floors a caller-supplied offset at 0, falling back to 0 for absent/non-numeric input.
 *
 * @param {number|string} [offset] - Requested row offset.
 * @returns {number} Non-negative offset.
 */
export function clampOffset(offset) {
  const parsed = Number.parseInt(offset, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Builds the payload for the Prompt Responses element (141adc88, a shared UUID that also
 * powers the Citations+Source Count and Executions rows — see `element-ids.js`). Returns
 * one row per AI response with the columns:
 *
 *   `model`, `model_name_cbf_value`, `position`, `project_id`, `prompt`, `response`, `tags`
 *
 * ⚠️ This element carries NO `date` column. That is the whole reason the response feed needs
 * a join: the answer text lives here, the date and the citation URLs live on SOURCES_DATES
 * (404fb017), and the two are paired on `(project_id, prompt, model, date)` — see
 * {@link module:response-feed}. The date for a row obtained here is therefore known only
 * from the window the caller requested, never from the row itself.
 *
 * ⚠️ DATE FILTER GRAMMAR — this element rejects the obvious spellings SILENTLY:
 *  - `CBF_date__start`/`CBF_date__end` must be duplicated in BOTH `filters.simple` AND
 *    `filters.advanced`. The element expects the duplication; `definitions/cited-domains.js`
 *    is the known-good precedent and this file follows it exactly.
 *  - `start_date`/`end_date`, a flat placement directly under `filters`, and a placement at
 *    the `render_data` top level are ALL SILENTLY IGNORED. An entirely invented key behaves
 *    identically — measured. This means a date filter written the obvious way FAILS OPEN:
 *    the call returns HTTP 200 with a full-width result that is indistinguishable from a
 *    successful narrow query. There is no error to catch and nothing in the response says
 *    the filter was dropped, so a wrong spelling here surfaces as silently wrong data
 *    downstream, not as a failure.
 *  - `CBF_date__start` is IGNORED by the element even in the correct position;
 *    `CBF_date__end` acts as an UPPER BOUND only. The returned window is ROLLING
 *    (~50 days observed), not cumulative, so as `end` advances rows both appear AND
 *    disappear. It is still sent, both because the element expects the key to be present
 *    and so that a future Semrush fix honouring it needs no change here.
 *
 * Because only the upper bound is honoured, a SINGLE day cannot be requested directly —
 * recover it with the two-call set difference in {@link module:response-feed.diffDayExecutions}.
 *
 * @param {object} [params]
 * @param {string} [params.projectId] - Semrush project id, sent as the top-level
 *   `project_id` (NOT a `CBF_*` filter — this element ignores those for project scoping).
 *   Omitted → every project in the workspace.
 * @param {string} [params.model] - AI model filter (Semrush engine name or UI platform
 *   code). Translated + validated via {@link resolveElementModel}.
 * @param {string} [params.platform] - Legacy alias for `model`; `model` takes precedence.
 * @param {string} [params.endDate] - ISO date (YYYY-MM-DD) upper bound. Required by the
 *   caller in practice; absent means "whatever the element's default window is".
 * @param {number} [params.limit] - Page size, clamped to [1, {@link MAX_RESPONSE_PAGE_SIZE}].
 * @param {number} [params.offset] - Row offset, floored at 0.
 * @returns {object} Elements API payload.
 */
export function buildPromptResponsesPayload({
  projectId, model, platform, endDate, limit, offset,
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);
  // `CBF_date__start` is ignored by the element (upper bound only), so the start value is
  // cosmetic — it is sent because the element expects the key, and mirrors `endDate` so the
  // payload never claims a window wider than the caller asked for.
  const start = endDate;
  const end = endDate;

  const advancedFilters = [
    { op: 'or', filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }] },
  ];
  if (end) {
    advancedFilters.push({ op: 'gte', val: start, col: 'CBF_date__start' });
    advancedFilters.push({ op: 'lte', val: end, col: 'CBF_date__end' });
  }

  return {
    ...(projectId && { project_id: projectId }),
    filters: {
      // Duplicated in simple AND advanced — see the grammar warning above.
      ...(end ? { simple: { CBF_date__start: start, CBF_date__end: end } } : {}),
      ...buildAdvancedFilters(advancedFilters),
    },
    pagination: {
      limit: clampLimit(limit),
      offset: clampOffset(offset),
      // Required for deterministic pagination — see RESPONSE_SORT_COLUMNS.
      // Wire format VERIFIED live 2026-09-04: `["prompt asc"]` and `["prompt desc"]` return
      // 200. A bare `["prompt"]` (no direction), the object form `[{col,dir}]`, and an unknown
      // column all return 400. So the direction suffix is required and the column must exist.
      sort_columns: [...RESPONSE_SORT_COLUMNS],
    },
  };
}

/**
 * Normalises a raw Prompt Responses element response into the row shape the join consumes.
 *
 * The element is a `table` (rows under `blocks.data`). Field mapping:
 *   `projectId` ← `project_id`
 *   `prompt`    ← `prompt`
 *   `model`     ← `model`
 *   `response`  ← `response`   (the answer text)
 *   `position`  ← `position`
 *   `tags`      ← `tags`
 *
 * Rows missing a `prompt` are dropped: `prompt` is one of the four join-key components, so a
 * row without one can never pair with a source row and would only add an unjoinable record.
 *
 * `date` is deliberately NOT set here — this element has no date column (see
 * {@link buildPromptResponsesPayload}). The join supplies it from the source side.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {Array<object>} Normalised response rows.
 */
export function transformPromptResponsesResponse(raw) {
  const rows = raw?.blocks?.data ?? [];
  return rows
    .filter((row) => row && row.prompt != null)
    .map((row) => ({
      projectId: row.project_id || '',
      prompt: row.prompt,
      model: row.model || '',
      modelNameCbfValue: row.model_name_cbf_value || '',
      response: row.response || '',
      // `Number(x) || 0` (not `Number(x ?? 0)`) so a non-numeric value coerces to 0 rather
      // than NaN, which would serialise as null and corrupt any ordering by this field.
      position: Number(row.position) || 0,
      tags: row.tags || '',
    }));
}
