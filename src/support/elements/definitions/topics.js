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
 * Builds the payload for the Topics (Tags) filter-dimensions element (row 3).
 * Returns all available topic and category tags — powers the Topics/Tags filter dropdown.
 *
 * @param {object} [params]
 * @param {string} [params.model] - AI model (Semrush engine name or SpaceCat/UI platform code).
 *   Translated to a Semrush model + validated via {@link resolveElementModel} (default search-gpt).
 * @param {string} [params.platform] - Legacy alias for `model`; `model` takes precedence.
 * @param {string} [params.projectId] - Semrush project UUID to scope tags to a specific market.
 */
export function buildTopicsPayload({ model, platform, projectId } = {}) {
  const resolvedModel = resolveElementModel(model || platform);
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
