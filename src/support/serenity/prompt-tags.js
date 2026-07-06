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
 * Serenity prompt-tag taxonomy — the single source of truth for the
 * `dimension:value` tag strings attached to prompts (and registered as the tag
 * vocabulary on each project). Import these constants instead of hardcoding tag
 * literals anywhere in the serenity flow.
 */

// Tag dimension prefixes (the part before the colon).
export const TAG_DIMENSION = Object.freeze({
  TOPIC: 'topic',
  SOURCE: 'source',
  INTENT: 'intent',
  TYPE: 'type',
  CATEGORY: 'category',
});

// `source:<value>` — who authored the prompt.
export const SOURCE_TAG = Object.freeze({
  AI: 'source:ai',
  HUMAN: 'source:human',
});

// `intent:<value>` — the searcher intent the prompt represents.
//
// These are the Semrush AIO intent TARGETS, the shared vocabulary that the
// mysticat-data-service customer-onboarding script also registers as a project's
// tag taxonomy (its `DEFAULT_PROJECT_TAGS`). They are NOT the raw data-service
// intent buckets persisted in `prompts.intent` (those — informational /
// instructional / comparative / transactional / planning / delegation — live in
// `src/support/intent.js` and are unchanged here). The DRS-bucket → Semrush-target
// mapping is the onboarding script's `INTENT_MAP` (mysticat-data-service
// `scripts/customer_onboarding/tags.py`; see mysticat-data-service PR #737).
// `Navigational` has no DRS source bucket but is part of the Semrush vocabulary,
// so it belongs in the taxonomy even though no generated prompt is tagged with it.
export const INTENT_TAG = Object.freeze({
  INFORMATIONAL: 'intent:Informational',
  TASK: 'intent:Task',
  COMMERCIAL: 'intent:Commercial',
  TRANSACTIONAL: 'intent:Transactional',
  NAVIGATIONAL: 'intent:Navigational',
});

// `type:<value>` — whether the prompt mentions the brand.
export const TYPE_TAG = Object.freeze({
  BRANDED: 'type:branded',
  NON_BRANDED: 'type:non-branded',
});

/** Builds the `<dimension>:<NAME>` tag string for a dimension + free-form value. */
export function tagFor(dimension, name) {
  return `${dimension}:${name}`;
}

/** Builds the `topic:<NAME>` tag for a topic name. */
export function topicTag(name) {
  return tagFor(TAG_DIMENSION.TOPIC, name);
}

/**
 * The tag dimensions a caller may freely create values under (the open
 * taxonomies). The closed taxonomies — `source` / `intent` / `type` — have a
 * fixed value enum registered as {@link PROJECT_STANDARD_TAGS}, so callers must
 * NOT mint arbitrary values under them; only `topic` and `category` accept
 * customer-authored values. The create-tag endpoint validates the requested
 * `type` against this list, which is what bounds the allowed tag prefixes.
 */
export const CREATABLE_TAG_DIMENSIONS = Object.freeze([
  TAG_DIMENSION.CATEGORY,
  TAG_DIMENSION.TOPIC,
]);

/**
 * The closed dimensions — `source` / `intent` / `type` — whose values are a
 * fixed enum ({@link PROJECT_STANDARD_TAGS}), never customer-authored. A
 * caller may still "create" one of these (POST /serenity/tags) to learn its
 * upstream id, but ONLY a value already in the enum, and the create is
 * resolve-before-create/idempotent (unlike {@link CREATABLE_TAG_DIMENSIONS}'s
 * open dimensions, where a duplicate name is a hard upstream 500 by design —
 * see serenity-docs#24 §3.1 gate 7). Closed-dimension tags are always roots;
 * `parentId` is rejected for them.
 */
export const CLOSED_TAG_DIMENSIONS = Object.freeze([
  TAG_DIMENSION.SOURCE,
  TAG_DIMENSION.INTENT,
  TAG_DIMENSION.TYPE,
]);

// Tags applied to EVERY AI-generated prompt on top of its `topic:<NAME>` tag:
// `source:ai` (AI-authored) plus the default `intent:Informational` (the most
// common intent for brand-topic prompts; re-classification can refine it
// later). `type:` is classified per prompt at generation time (branded vs
// non-branded — see the handler), so it is NOT seeded here.
export const STANDARD_PROMPT_TAGS = Object.freeze([
  SOURCE_TAG.AI,
  INTENT_TAG.INFORMATIONAL,
]);

// The full tag TAXONOMY registered on EVERY project (via createProjectTags),
// independent of any prompt — so classification can later apply the right
// intent / source / type value per prompt. Order: all intents, then sources,
// then types.
export const PROJECT_STANDARD_TAGS = Object.freeze([
  ...Object.values(INTENT_TAG),
  ...Object.values(SOURCE_TAG),
  ...Object.values(TYPE_TAG),
]);
