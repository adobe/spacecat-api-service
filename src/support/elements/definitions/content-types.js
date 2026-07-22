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
// llmo-brand-presence.js / cited-domains.js). Kept inline here so this definition
// stays pure and does not import controller code.
const DEFAULT_WINDOW_DAYS = 28;

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
 * Builds the payload for the Content Types filter-dimensions element (d1f9e6ec).
 * Returns the available `domain_type` values (Owned/Other/Social/Earned/Benchmark
 * Competitors) for the given model + date window — powers the Content Type filter
 * dropdown.
 *
 * @param {object} [params]
 * @param {string} [params.model] - AI model (Semrush engine name or SpaceCat/UI platform code).
 *   Translated to a Semrush model + validated via {@link resolveElementModel} (default search-gpt).
 * @param {string} [params.platform] - Legacy alias for `model`; `model` takes precedence.
 * @param {string} [params.startDate] - ISO date (YYYY-MM-DD). Defaults to 28 days ago.
 * @param {string} [params.endDate] - ISO date (YYYY-MM-DD). Defaults to today.
 */
export function buildContentTypesPayload({
  model, platform, startDate, endDate,
} = {}) {
  const resolvedModel = resolveElementModel(model || platform);
  const defaults = defaultDateRange();
  const start = startDate || defaults.startDate;
  const end = endDate || defaults.endDate;

  return {
    comparison_data_formatting: 'union',
    filters: {
      simple: {},
      advanced: {
        op: 'and',
        filters: [
          { op: 'eq', val: resolvedModel, col: 'CBF_model' },
          { op: 'gte', val: start, col: 'CBF_date__start' },
          { op: 'lte', val: end, col: 'CBF_date__end' },
        ],
      },
    },
  };
}

/**
 * Transforms the raw Semrush Content Types element response into URL Inspector
 * filter-dimension content types. `id` is derived from `label` (lowercased,
 * spaces → underscores) — Semrush has no stable content-type ID.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {Array<{id: string, label: string}>}
 */
export function transformContentTypesToFilterDimensions(raw) {
  return (raw?.blocks?.value ?? [])
    .map((item) => String(item.value ?? ''))
    .filter((label) => label !== '')
    .map((label) => ({
      id: label.toLowerCase().replace(/\s+/g, '_'),
      label,
    }));
}
