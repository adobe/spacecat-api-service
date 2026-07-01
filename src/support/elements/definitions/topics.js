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

import { DEFAULT_ELEMENT_MODEL, ELEMENT_MODELS } from '../constants.js';

/**
 * Builds the payload for the Topics (Tags) filter-dimensions element (row 3).
 * Returns all available topic and category tags — powers the Topics/Tags filter dropdown.
 *
 * @param {object} [params]
 * @param {string} [params.model] - AI model filter value. Must be one of {@link ELEMENT_MODELS};
 *   falls back to {@link DEFAULT_ELEMENT_MODEL} if omitted or unrecognised.
 * @param {string} [params.projectId] - Semrush project UUID to scope tags to a specific market.
 */
export function buildTopicsPayload({ model, projectId } = {}) {
  const resolvedModel = ELEMENT_MODELS.includes(model) ? model : DEFAULT_ELEMENT_MODEL;
  return {
    ...(projectId && { project_id: projectId }),
    comparison_data_formatting: 'union',
    filters: {
      advanced: {
        op: 'and',
        filters: [{ op: 'eq', val: resolvedModel, col: 'CBF_model' }],
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

/**
 * @typedef {object} FilterDimensionItem
 * @property {string|null} id - Dimension identifier (null when no stable ID exists).
 * @property {string} label - Human-readable label.
 */

function extractByPrefix(raw, prefix) {
  return (raw?.blocks?.value ?? [])
    .filter((item) => String(item.value ?? '').startsWith(prefix))
    .map((item) => String(item.value).substring(prefix.length));
}

/**
 * Extracts only "topic:"-prefixed entries → `{ id: null, label }`.
 * @param {object} raw - Raw response from the Elements API.
 * @returns {FilterDimensionItem[]}
 */
export function transformTopicsForFilterDimensions(raw) {
  return extractByPrefix(raw, 'topic:').map((label) => ({ id: null, label }));
}

/**
 * Extracts only "category:"-prefixed entries → `{ id: null, label }`.
 * @param {object} raw - Raw response from the Elements API.
 * @returns {FilterDimensionItem[]}
 */
export function transformCategoriesToFilterDimensions(raw) {
  return extractByPrefix(raw, 'category:').map((label) => ({ id: null, label }));
}

/**
 * Extracts only "intent:"-prefixed entries → `{ id: UPPERCASED, label: UPPERCASED }`.
 * @param {object} raw - Raw response from the Elements API.
 * @returns {FilterDimensionItem[]}
 */
export function transformIntentsToFilterDimensions(raw) {
  return extractByPrefix(raw, 'intent:').map((label) => ({ id: label.toUpperCase(), label }));
}

/**
 * Extracts only "source:"-prefixed entries → `{ id: value, label: value }`.
 * @param {object} raw - Raw response from the Elements API.
 * @returns {FilterDimensionItem[]}
 */
export function transformOriginsToFilterDimensions(raw) {
  return extractByPrefix(raw, 'source:').map((label) => ({ id: label, label }));
}
