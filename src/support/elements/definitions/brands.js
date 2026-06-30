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

/**
 * Builds the payload for the Brands filter-dimensions element (row 1).
 * Returns the list of all available brands in the workspace — powers the brand selector dropdown.
 *
 * @param {object} params
 * @param {string} params.startDate - ISO date string (YYYY-MM-DD).
 * @param {string} params.endDate - ISO date string (YYYY-MM-DD).
 * @param {string} [params.comparisonStartDate] - Comparison period start (YYYY-MM-DD).
 * @param {string} [params.comparisonEndDate] - Comparison period end (YYYY-MM-DD).
 * @param {string} [params.model='search-gpt'] - AI model filter value.
 */
export function buildBrandsPayload({
  startDate,
  endDate,
  comparisonStartDate,
  comparisonEndDate,
  model = 'search-gpt',
} = {}) {
  return {
    comparison_data_formatting: 'union',
    filters: {
      simple: {
        start_date: startDate,
        end_date: endDate,
        ...(comparisonStartDate && { comparison_start_date: comparisonStartDate }),
        ...(comparisonEndDate && { comparison_end_date: comparisonEndDate }),
      },
      advanced: {
        op: 'and',
        filters: [{ op: 'eq', val: model, col: 'CBF_model' }],
      },
    },
  };
}

/**
 * @typedef {object} Brand
 * @property {string} name - Brand display name (e.g. "Adobe").
 * @property {number} count - Total mention count across the workspace.
 * @property {string} faviconDomain - Domain used for the brand favicon.
 * @property {boolean} defaultSelected - Whether the brand is pre-selected in the UI.
 */

/**
 * Transforms the raw Semrush Brands element response into typed Brand objects.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {Brand[]}
 */
export function transformBrandsResponse(raw) {
  return (raw?.blocks?.value ?? []).map((item) => ({
    name: item.value,
    count: item.brand_count ?? 0,
    faviconDomain: item.faviconDomain ?? '',
    defaultSelected: item.defaultSelected === 1,
  }));
}

/**
 * Transforms the raw Semrush Brands element response into URL Inspector filter-dimension brands.
 * Both `id` and `label` are set to the brand name.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {import('./topics.js').FilterDimensionItem[]}
 */
export function transformBrandsToFilterDimensions(raw) {
  return (raw?.blocks?.value ?? []).map((item) => ({
    id: item.value ?? null,
    label: item.value ?? '',
  }));
}
