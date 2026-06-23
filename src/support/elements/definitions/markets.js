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
 * Builds the payload for the Markets filter-dimensions element (row 2).
 * Returns available markets (Semrush projects) for a selected brand.
 * Each market corresponds to one location + language combination.
 *
 * @param {object} params
 * @param {string} params.brand - Brand name to scope the lookup (e.g. "Adobe").
 */
export function buildMarketsPayload({ brand } = {}) {
  return {
    comparison_data_formatting: 'union',
    filters: {
      simple: {},
      advanced: {
        op: 'and',
        filters: [{ op: 'eq', val: brand, col: 'CBF_ws_brand' }],
      },
    },
  };
}

/**
 * @typedef {object} Market
 * @property {string} id - Semrush project UUID (pass as projectId in subsequent calls).
 * @property {string} label - Human-readable market label (e.g. "US-en").
 * @property {string} iconName - Country/region code used for the flag icon (e.g. "US").
 * @property {boolean} defaultSelected - Whether the market is pre-selected in the UI.
 */

/**
 * Transforms the raw Semrush Markets element response into typed Market objects.
 * The `id` value is the Semrush project UUID — clients use these as `projectIds`
 * in subsequent brand-scoped element calls.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {Market[]}
 */
export function transformMarketsResponse(raw) {
  return (raw?.blocks?.value ?? []).map((item) => ({
    id: item.value,
    label: item.label ?? '',
    iconName: item.iconName ?? '',
    defaultSelected: item.defaultSelected === 1,
  }));
}
