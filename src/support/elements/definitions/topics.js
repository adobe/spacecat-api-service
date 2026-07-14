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

const SEP = '__';

/**
 * @typedef {object} FilterDimensionItem
 * @property {string} id - Dimension identifier: the original, unmodified tag
 *   value as returned by the Elements API (e.g. `topic__Furniture__Sofas`).
 * @property {string} label - Human-readable label.
 */

/**
 * @typedef {object} PrefixedTag
 * @property {string} original - The raw tag value exactly as returned by the
 *   Elements API (e.g. `topic__Furniture__Sofas`), used as the dimension `id`.
 * @property {string} stripped - `original` with the matched `prefix__` marker
 *   removed (e.g. `Furniture__Sofas`), used to derive `label`/`parent_label`.
 */

/**
 * @param {object} raw - Raw response from the Elements API.
 * @param {string} prefix - Tag prefix to filter on (e.g. `topic`), matched
 *   against values starting with `${prefix}__`.
 * @returns {PrefixedTag[]}
 */
function extractByPrefix(raw, prefix) {
  const marker = `${prefix}${SEP}`;
  return (raw?.blocks?.value ?? [])
    .filter((item) => String(item.value ?? '').startsWith(marker))
    .map((item) => {
      const original = String(item.value);
      return { original, stripped: original.substring(marker.length) };
    });
}

/**
 * Splits a "Parent__Child" value into its child label and parent label.
 * Splits on the first "__" only, so a label containing further "__" occurrences
 * is preserved intact in the child label. `parent_id` is reconstructed as
 * `${prefix}${parent_label}` — the same original-tag shape as the item's own
 * `id` — so a caller can filter by parent the same way as by id (e.g. for
 * `category__Living Room Furniture Retail__Living Room Furniture and Sofas`,
 * `parent_id` is `category__Living Room Furniture Retail`).
 * @param {string} value - Raw stripped tag value (prefix marker already removed).
 * @param {string} [prefix] - The prefix (including trailing `__`) stripped from
 *   `value` before it was passed in; '' when the original tag had no prefix.
 * @returns {{label: string, parent_id?: string, parent_label?: string}}
 */
function splitParent(value, prefix = '') {
  const idx = value.indexOf(SEP);
  if (idx === -1) {
    return { label: value };
  }
  const parentLabel = value.slice(0, idx);
  return {
    label: value.slice(idx + SEP.length),
    parent_id: `${prefix}${parentLabel}`,
    parent_label: parentLabel,
  };
}

/**
 * Extracts only "topic__"-prefixed entries → `{ id: original tag, label }`,
 * plus `parent_id`/`parent_label` when the tag encodes a "Parent__Child"
 * hierarchy.
 * @param {object} raw - Raw response from the Elements API.
 * @returns {FilterDimensionItem[]}
 */
export function transformTopicsForFilterDimensions(raw) {
  return extractByPrefix(raw, 'topic')
    .map(({ original, stripped }) => ({ id: original, ...splitParent(stripped, 'topic__') }));
}

/**
 * Extracts only "category__"-prefixed entries → `{ id: original tag, label }`,
 * plus `parent_id`/`parent_label` when the tag encodes a "Parent__Child"
 * hierarchy.
 * @param {object} raw - Raw response from the Elements API.
 * @returns {FilterDimensionItem[]}
 */
export function transformCategoriesToFilterDimensions(raw) {
  return extractByPrefix(raw, 'category')
    .map(({ original, stripped }) => ({ id: original, ...splitParent(stripped, 'category__') }));
}

/**
 * Extracts only "intent__"-prefixed entries → `{ id: original tag, label }`,
 * plus `parent_id`/`parent_label` when the tag encodes a "Parent__Child"
 * hierarchy.
 * @param {object} raw - Raw response from the Elements API.
 * @returns {FilterDimensionItem[]}
 */
export function transformIntentsToFilterDimensions(raw) {
  return extractByPrefix(raw, 'intent')
    .map(({ original, stripped }) => ({ id: original, ...splitParent(stripped, 'intent__') }));
}

/**
 * Extracts only "source__"-prefixed entries → `{ id: original tag, label }`,
 * plus `parent_id`/`parent_label` when the tag encodes a "Parent__Child"
 * hierarchy.
 * @param {object} raw - Raw response from the Elements API.
 * @returns {FilterDimensionItem[]}
 */
export function transformOriginsToFilterDimensions(raw) {
  return extractByPrefix(raw, 'source')
    .map(({ original, stripped }) => ({ id: original, ...splitParent(stripped, 'source__') }));
}

const KNOWN_TAG_PREFIXES = ['topic__', 'category__', 'intent__', 'source__'];

/**
 * Extracts every tag NOT already covered by the known `topic__`/`category__`/
 * `intent__`/`source__` prefixes, so newly-introduced Semrush tag types (e.g.
 * `type__branded`) surface in the response without a code change per prefix.
 *
 * - `prefix__value` tags are grouped by their prefix into a dynamic key
 *   (e.g. `{ type: [{ id: 'type__branded', label: 'branded' }, ...] }`), unless
 *   `prefix` collides with an entry in `reservedResultKeys`, in which case the
 *   tag is routed to the generic `tags` array instead.
 * - Bare values with no `__` at all are prefix declarations (e.g. a lone
 *   `category` row announcing the dimension itself, with no value) and are
 *   ignored entirely — they are not tag data.
 *
 * `id` is always the original, unmodified tag value as returned by the
 * Elements API. Grouped tags apply the same `Parent__Child` splitting as the
 * known dimensions to derive `label`/`parent_label`.
 *
 * Tag prefixes are arbitrary strings from Semrush, so a prefix can legitimately
 * be `constructor`, `__proto__`, etc. `groups` is created with `Object.create(null)`
 * (not `{}`) so `groups[prefix]` never resolves to an inherited `Object.prototype`
 * member for such a prefix — with a plain `{}`, `groups[prefix] ?? []` would
 * silently return e.g. the `Object` constructor function instead of `undefined`,
 * and the following `.push(...)` would throw.
 *
 * @param {object} raw - Raw response from the Elements API.
 * @param {string[]} [reservedResultKeys] - Keys already populated on the
 *   caller's result object (see `elements-service.js`) that a raw tag's
 *   `prefix` must not collide with. Passed in by the caller — rather than
 *   hardcoded here — so this stays in sync automatically as the caller's
 *   result shape changes.
 * @returns {{[prefix: string]: FilterDimensionItem[], tags: FilterDimensionItem[]}}
 */
export function transformOtherTagsForFilterDimensions(raw, reservedResultKeys = []) {
  const values = (raw?.blocks?.value ?? [])
    .map((item) => String(item.value ?? ''))
    .filter((value) => value !== '' && !KNOWN_TAG_PREFIXES.some((p) => value.startsWith(p)));

  const groups = Object.create(null);
  const tags = [];

  values.forEach((value) => {
    const sepIdx = value.indexOf(SEP);
    if (sepIdx === -1) {
      // Bare prefix declaration (e.g. "category") — not tag data, ignore.
      return;
    }
    const prefix = value.slice(0, sepIdx);
    const rest = value.slice(sepIdx + SEP.length);
    if (reservedResultKeys.includes(prefix)) {
      tags.push({ id: value, ...splitParent(rest, `${prefix}${SEP}`) });
      return;
    }
    groups[prefix] = groups[prefix] ?? [];
    groups[prefix].push({ id: value, ...splitParent(rest, `${prefix}${SEP}`) });
  });

  return { ...groups, tags };
}
