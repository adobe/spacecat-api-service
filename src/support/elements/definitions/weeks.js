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
// Reused for exact parity with the legacy Brand Presence `weeks` endpoint. These are
// pure, side-effect-free ISO-week helpers exported by the legacy controller; importing
// them guarantees identical week boundaries (incl. year-edge cases like 2026-W01 →
// 2025-12-29) without re-deriving the math here.
// TODO(LLMO-6011, productization): extract these to a shared date util so the elements
// layer no longer imports from the controller layer.
import {
  generateIsoWeekRange,
  getWeekDateRange,
} from '../../../controllers/llmo/llmo-brand-presence.js';

/**
 * Builds the payload for the Weeks filter-dimensions element (row 5).
 * The element is a `table` — it returns one row per day that has Brand Presence
 * data (`blocks.data[] = { date, models }`), which we roll up into ISO weeks.
 *
 * @param {object} [params]
 * @param {string} [params.model] - AI model filter value (Semrush engine name or UI
 *   platform code). Translated + validated via {@link resolveElementModel}.
 * @param {string} [params.platform] - Legacy alias for `model`; the URL Inspector week
 *   filter sends the value under this key. `model` takes precedence when both are present.
 * @param {string} [params.brand] - Brand NAME to scope the weeks to (added as a
 *   `CBF_ws_brand` filter, mirroring the Markets element). Resolved from `siteId` by the
 *   controller. Omitted → workspace-wide weeks.
 */
/* c8 ignore start -- LLMO-6011 POC endpoint; unit tests intentionally deferred */
export function buildWeeksPayload({ model, platform, brand } = {}) {
  const resolvedModel = resolveElementModel(model || platform);
  const filters = [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }];
  if (brand) {
    filters.push({ op: 'eq', val: brand, col: 'CBF_ws_brand' });
  }
  return {
    comparison_data_formatting: 'union',
    filters: {
      advanced: { op: 'and', filters },
    },
  };
}

/**
 * Transforms the raw Semrush Weeks element response into the legacy Brand Presence
 * `weeks` contract so the URL Inspector week filter is drop-in compatible:
 *   [{ week: 'YYYY-Wnn', startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }]
 * ordered newest-first.
 *
 * The element returns a `table` of daily rows (`blocks.data[] = { date, models }`).
 * We take the min/max day present and expand to every ISO week in that span —
 * matching the legacy handler, which derives weeks from an execution-date range.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {Array<{ week: string, startDate: string, endDate: string }>}
 */
export function transformWeeksResponse(raw) {
  const dates = (raw?.blocks?.data ?? [])
    .map((row) => (typeof row?.date === 'string' ? row.date.slice(0, 10) : null))
    .filter(Boolean)
    .sort();
  if (dates.length === 0) {
    return [];
  }
  return generateIsoWeekRange(dates[0], dates[dates.length - 1]).map((week) => {
    const { startDate, endDate } = getWeekDateRange(week);
    return { week, startDate, endDate };
  });
}
/* c8 ignore stop */
