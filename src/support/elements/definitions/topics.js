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
 * Splits a "Parent__Child" value into its child label and parent label.
 * Splits on the first "__" only, so a label containing further "__" occurrences
 * is preserved intact in the child label.
 * @param {string} value - Raw stripped tag value.
 * @returns {{label: string, parent_id?: null, parent_label?: string}}
 */
function splitParent(value) {
  const sep = '__';
  const idx = value.indexOf(sep);
  if (idx === -1) {
    return { label: value };
  }
  return {
    label: value.slice(idx + sep.length),
    parent_id: null,
    parent_label: value.slice(0, idx),
  };
}

/**
 * Extracts only "topic:"-prefixed entries → `{ id: null, label }`, plus
 * `parent_id`/`parent_label` when the tag encodes a "Parent__Child" hierarchy.
 * @param {object} raw - Raw response from the Elements API.
 * @returns {FilterDimensionItem[]}
 */
export function transformTopicsForFilterDimensions(raw) {
  return extractByPrefix(raw, 'topic:').map((value) => ({ id: null, ...splitParent(value) }));
}

/**
 * Extracts only "category:"-prefixed entries → `{ id: null, label }`, plus
 * `parent_id`/`parent_label` when the tag encodes a "Parent__Child" hierarchy.
 * @param {object} raw - Raw response from the Elements API.
 * @returns {FilterDimensionItem[]}
 */
export function transformCategoriesToFilterDimensions(raw) {
  return extractByPrefix(raw, 'category:').map((value) => ({ id: null, ...splitParent(value) }));
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

const KNOWN_TAG_PREFIXES = ['topic:', 'category:', 'intent:', 'source:'];

/**
 * Keys already populated on the filter-dimensions result before the dynamic
 * groups are merged in (see `getUrlInspectorFilterDimensions`). A raw tag whose
 * `prefix:` matches one of these verbatim (e.g. `brands:foo`, `regions:APAC`)
 * would otherwise be grouped under that same key and merged into the
 * pre-existing array, corrupting it — so such tags are routed to the generic
 * `tags` bucket instead.
 */
const RESERVED_RESULT_KEYS = ['brands', 'regions', 'topics', 'categories', 'page_intents', 'origins', 'tags'];

/**
 * Extracts every tag NOT already covered by the known `topic:`/`category:`/
 * `intent:`/`source:` prefixes, so newly-introduced Semrush tag types (e.g.
 * `type:branded`) surface in the response without a code change per prefix.
 *
 * - `prefix:value` tags are grouped by their prefix into a dynamic key
 *   (e.g. `{ type: [{ id: null, label: 'branded' }, ...] }`), unless `prefix`
 *   collides with a {@link RESERVED_RESULT_KEYS} entry, in which case the tag
 *   is routed to the generic `tags` array instead.
 * - Plain tags with no `prefix:` at all are also collected into `tags`.
 *
 * Both forms apply the same `Parent__Child` splitting as the known dimensions.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @returns {{[prefix: string]: FilterDimensionItem[], tags: FilterDimensionItem[]}}
 */
export function transformOtherTagsForFilterDimensions(raw) {
  const values = (raw?.blocks?.value ?? [])
    .map((item) => String(item.value ?? ''))
    .filter((value) => value !== '' && !KNOWN_TAG_PREFIXES.some((p) => value.startsWith(p)));

  const groups = {};
  const tags = [];

  values.forEach((value) => {
    const sepIdx = value.indexOf(':');
    if (sepIdx === -1) {
      tags.push({ id: null, ...splitParent(value) });
      return;
    }
    const prefix = value.slice(0, sepIdx);
    const rest = value.slice(sepIdx + 1);
    if (RESERVED_RESULT_KEYS.includes(prefix)) {
      tags.push({ id: null, ...splitParent(rest) });
      return;
    }
    groups[prefix] = groups[prefix] ?? [];
    groups[prefix].push({ id: null, ...splitParent(rest) });
  });

  return { ...groups, tags };
}
