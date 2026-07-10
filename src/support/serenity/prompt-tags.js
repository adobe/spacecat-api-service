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

// @ts-check

/**
 * Serenity prompt-tag taxonomy — the single source of truth for the tag tree
 * attached to prompts (and registered as the tag vocabulary on each project).
 * Import these constants instead of hardcoding tag literals anywhere in the
 * serenity flow.
 *
 * A tag's DIMENSION is its root ancestor, not a prefix on its name. Every
 * project's tag tree has exactly four roots — `category`, `intent`, `source`,
 * `type` — and every tag value is a bare-named descendant of one of them. No
 * tag name contains a `:`. A tag's dimension is therefore `path[0]` of the
 * upstream breadcrumb (verified against the live Semrush API: `path[]` is a
 * full root-first ancestry at any depth), never something parsed out of a name.
 *
 * Depth is a property of the data, not of this module: a customer category
 * sits at depth 2 (child of the `category` root) and a sub-category at depth 3.
 * The upstream API caps neither, so nothing here does either.
 *
 * Names are NOT unique on their own — upstream uniqueness is scoped per
 * `(project, parent)`. A sub-category named `human` and the `source` value
 * `human` are two distinct tags. Never key a tag by name alone; key by id.
 */

/**
 * The four dimension roots. Each is a bare-named ROOT tag on every project.
 */
export const DIMENSION = Object.freeze({
  CATEGORY: 'category',
  INTENT: 'intent',
  SOURCE: 'source',
  TYPE: 'type',
});

/** Root names, in the order they are provisioned on a project. */
export const DIMENSION_ROOT_NAMES = Object.freeze([
  DIMENSION.CATEGORY,
  DIMENSION.INTENT,
  DIMENSION.SOURCE,
  DIMENSION.TYPE,
]);

/** `source` values — who authored the prompt. */
export const SOURCE_VALUE = Object.freeze({
  AI: 'ai',
  HUMAN: 'human',
});

/**
 * `intent` values — the searcher intent the prompt represents.
 *
 * These are the Semrush AIO intent TARGETS, the shared vocabulary that the
 * mysticat-data-service customer-onboarding script also registers as a project's
 * tag taxonomy. They are NOT the raw data-service intent buckets persisted in
 * `prompts.intent` (those — informational / instructional / comparative /
 * transactional / planning / delegation — live in `src/support/intent.js` and
 * are unchanged here). The DRS-bucket → Semrush-target mapping is the onboarding
 * script's `INTENT_MAP` (mysticat-data-service `scripts/serenity_migration/tags.py`).
 *
 * `Navigational` has no DRS source bucket, so no generated prompt is tagged with
 * it, but it is part of the Semrush vocabulary and every live customer project
 * carries it — so it belongs in the taxonomy.
 */
export const INTENT_VALUE = Object.freeze({
  INFORMATIONAL: 'Informational',
  TASK: 'Task',
  COMMERCIAL: 'Commercial',
  TRANSACTIONAL: 'Transactional',
  NAVIGATIONAL: 'Navigational',
});

/** `type` values — whether the prompt mentions the brand. */
export const TYPE_VALUE = Object.freeze({
  BRANDED: 'branded',
  NON_BRANDED: 'non-branded',
});

/**
 * The CLOSED dimensions and their fixed child vocabularies. A caller may never
 * mint an arbitrary value under these; the values below are provisioned as the
 * root's children on every project. A caller may still "create" one of these
 * (POST /serenity/tags) to learn its upstream id, but only a value already in
 * the enum, and the create is resolve-before-create/idempotent — unlike an OPEN
 * dimension, where a duplicate `(parent, name)` is a hard upstream 500 by design
 * (verified live) and resolve-before-create is the caller's job.
 */
export const CLOSED_DIMENSION_VALUES = Object.freeze({
  [DIMENSION.INTENT]: Object.freeze(Object.values(INTENT_VALUE)),
  [DIMENSION.SOURCE]: Object.freeze(Object.values(SOURCE_VALUE)),
  [DIMENSION.TYPE]: Object.freeze(Object.values(TYPE_VALUE)),
});

/** The closed dimensions — fixed vocabularies, never customer-authored. */
export const CLOSED_DIMENSIONS = Object.freeze([
  DIMENSION.INTENT,
  DIMENSION.SOURCE,
  DIMENSION.TYPE,
]);

/**
 * The OPEN dimensions — a caller may create arbitrary descendants at any depth.
 * `category` is the only one: a customer category is a child of the `category`
 * root, and a sub-category is a child of a category.
 */
export const OPEN_DIMENSIONS = Object.freeze([DIMENSION.CATEGORY]);

/** Every dimension a caller may address on the create-tag endpoint. */
export const ALL_DIMENSIONS = Object.freeze([...OPEN_DIMENSIONS, ...CLOSED_DIMENSIONS]);

/**
 * The closed-dimension values applied to EVERY AI-generated prompt: `source:ai`
 * (AI-authored) plus the default `Informational` intent (the most common intent
 * for brand-topic prompts; re-classification can refine it later). The `type`
 * value is classified per prompt at generation time (branded vs non-branded —
 * see the handler), so it is NOT seeded here.
 *
 * Each entry names a dimension and the bare value beneath it; the caller resolves
 * the pair to an upstream tag id against the project's tree.
 */
export const STANDARD_PROMPT_TAG_VALUES = Object.freeze([
  Object.freeze({ dimension: DIMENSION.SOURCE, name: SOURCE_VALUE.AI }),
  Object.freeze({ dimension: DIMENSION.INTENT, name: INTENT_VALUE.INFORMATIONAL }),
]);

/**
 * True when `name` is one of the four dimension roots. Root names are reserved:
 * a customer category may not be called `category`, and a closed value may not
 * be minted at the root level.
 *
 * @param {string} name - a bare tag name.
 * @returns {boolean}
 */
export function isDimensionRootName(name) {
  return (/** @type {readonly string[]} */ (DIMENSION_ROOT_NAMES)).includes(name);
}

/**
 * True when `dimension` has a fixed child vocabulary.
 *
 * @param {string} dimension
 * @returns {boolean}
 */
export function isClosedDimension(dimension) {
  return (/** @type {readonly string[]} */ (CLOSED_DIMENSIONS)).includes(dimension);
}

/**
 * The fixed child vocabulary of a closed dimension, or an empty tuple for an
 * open one.
 *
 * @param {string} dimension
 * @returns {readonly string[]}
 */
export function closedValuesOf(dimension) {
  return CLOSED_DIMENSION_VALUES[/** @type {keyof CLOSED_DIMENSION_VALUES} */ (dimension)] ?? [];
}
