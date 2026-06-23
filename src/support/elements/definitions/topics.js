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
 * Builds the payload for the Topics (Tags) filter-dimensions element (row 3).
 * Returns all available topic and category tags — powers the Topics/Tags filter dropdown.
 *
 * @param {object} params
 * @param {string} params.startDate - ISO date string (YYYY-MM-DD).
 * @param {string} params.endDate - ISO date string (YYYY-MM-DD).
 * @param {string} [params.comparisonStartDate] - Comparison period start (YYYY-MM-DD).
 * @param {string} [params.comparisonEndDate] - Comparison period end (YYYY-MM-DD).
 * @param {string} [params.model='search-gpt'] - AI model filter value.
 */
export function buildTopicsPayload({
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
 * @typedef {object} Topic
 * @property {string} value - Raw tag value from Semrush (e.g. "category:Firefly").
 * @property {string} type - Tag type prefix (e.g. "category", "intent", "source").
 * @property {string} name - Tag name after the colon (e.g. "Firefly").
 */

/**
 * Transforms the raw Semrush Topics element response into typed Topic objects.
 * Splits the colon-separated `value` field into `type` and `name`.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {Topic[]}
 */
export function transformTopicsResponse(raw) {
  return (raw?.blocks?.value ?? []).map((item) => {
    const colonIdx = (item.value ?? '').indexOf(':');
    const type = colonIdx >= 0 ? item.value.substring(0, colonIdx) : '';
    const name = colonIdx >= 0 ? item.value.substring(colonIdx + 1) : (item.value ?? '');
    return { value: item.value ?? '', type, name };
  });
}
