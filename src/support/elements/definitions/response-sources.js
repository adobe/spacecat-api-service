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
import {
  DEFAULT_RESPONSE_PAGE_SIZE,
  MAX_RESPONSE_PAGE_SIZE,
} from './prompt-responses.js';

/**
 * Sort applied to every Response Sources call.
 *
 * `sort_columns` is REQUIRED for deterministic pagination (see the same note in
 * `prompt-responses.js`). `prompt asc` is the primary key of the walk; `position asc` keeps
 * the citation rows of one answer contiguous and in the element's own ranking order, which
 * is what {@link transformResponseSourcesResponse} preserves.
 */
const SOURCE_SORT_COLUMNS = Object.freeze(['prompt asc', 'position asc']);

/**
 * Clamps a caller-supplied page size into `[1, MAX_RESPONSE_PAGE_SIZE]`, falling back to
 * {@link DEFAULT_RESPONSE_PAGE_SIZE} for absent/non-numeric input.
 *
 * @param {number|string} [limit] - Requested page size.
 * @returns {number} Clamped page size.
 */
function clampLimit(limit) {
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
function clampOffset(offset) {
  const parsed = Number.parseInt(offset, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Builds the payload for the Response Sources element (404fb017, `SOURCES_DATES`). Returns
 * one row per CITATION with the columns:
 *
 *   `execution_id`, `prompt`, `date`, `model`, `source`, `url_cbf`, `position`,
 *   `domain_type`, `project_id`, `tags`
 *
 * ⚠️ This element carries NO answer text. It is the other half of the response feed: it
 * supplies the `date` and the cited URLs that PROMPT_RESPONSES (141adc88) lacks, and the two
 * are paired on `(project_id, prompt, model, date)` — see {@link module:response-feed}.
 *
 * `execution_id` is a COMPOSITE STRING (`project_id` + `date` + `model` + `prompt`), so it is
 * day-granular and adds nothing beyond the join tuple already assembled from the individual
 * columns. It is normalised through for traceability, not used as a key.
 *
 * ⚠️ The same silently-failing date grammar as `prompt-responses.js` applies here verbatim —
 * `CBF_date__start`/`CBF_date__end` duplicated across `filters.simple` and `filters.advanced`;
 * `start_date`/`end_date` and any flat or top-level placement IGNORED WITHOUT ERROR (the call
 * FAILS OPEN, returning a full-width result that looks like a successful narrow query);
 * `CBF_date__start` ignored even when correctly placed, `CBF_date__end` honoured as an upper
 * bound only, over a ROLLING (~50 day) window. See {@link module:prompt-responses} for the
 * full description and the measurements behind it.
 *
 * @param {object} [params]
 * @param {string} [params.projectId] - Semrush project id, sent as the top-level
 *   `project_id`. Omitted → every project in the workspace.
 * @param {string} [params.model] - AI model filter (Semrush engine name or UI platform
 *   code). Translated + validated via {@link resolveElementModel}.
 * @param {string} [params.platform] - Legacy alias for `model`; `model` takes precedence.
 * @param {string} [params.endDate] - ISO date (YYYY-MM-DD) upper bound.
 * @param {number} [params.limit] - Page size, clamped to [1, {@link MAX_RESPONSE_PAGE_SIZE}].
 * @param {number} [params.offset] - Row offset, floored at 0.
 * @returns {object} Elements API payload.
 */
export function buildResponseSourcesPayload({
  projectId, model, platform, endDate, limit, offset,
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);
  // `CBF_date__start` is ignored (upper bound only) — mirrored from `endDate` for the same
  // reason as in `prompt-responses.js`.
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
      advanced: { op: 'and', filters: advancedFilters },
    },
    pagination: {
      limit: clampLimit(limit),
      offset: clampOffset(offset),
      // Required for deterministic pagination — see SOURCE_SORT_COLUMNS.
      sort_columns: [...SOURCE_SORT_COLUMNS],
    },
  };
}

/**
 * Normalises a raw Response Sources element response into the row shape the join consumes.
 *
 * The element is a `table` (rows under `blocks.data`). Field mapping:
 *   `projectId`   ← `project_id`
 *   `prompt`      ← `prompt`
 *   `model`       ← `model`
 *   `date`        ← `date`         (the join component PROMPT_RESPONSES cannot supply)
 *   `url`         ← `url_cbf`, falling back to `source`
 *   `source`      ← `source`
 *   `position`    ← `position`
 *   `domainType`  ← `domain_type`
 *   `executionId` ← `execution_id` (composite; carried for traceability only)
 *
 * Rows missing a `prompt` or a `date` are dropped — both are join-key components, so such a
 * row can never pair with an answer.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {Array<object>} Normalised source rows.
 */
export function transformResponseSourcesResponse(raw) {
  const rows = raw?.blocks?.data ?? [];
  return rows
    .filter((row) => row && row.prompt != null && row.date != null)
    .map((row) => ({
      projectId: row.project_id || '',
      prompt: row.prompt,
      model: row.model || '',
      date: row.date,
      // `url_cbf` is the citation target; `source` is the display/domain form. Prefer the
      // former and fall back so a row with only one populated still yields a usable URL.
      url: row.url_cbf || row.source || '',
      source: row.source || '',
      position: Number(row.position) || 0,
      domainType: row.domain_type || '',
      executionId: row.execution_id || '',
      tags: row.tags || '',
    }));
}
