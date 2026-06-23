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
});

// `source:<value>` — who authored the prompt.
export const SOURCE_TAG = Object.freeze({
  AI: 'source:ai',
  HUMAN: 'source:human',
});

// `intent:<value>` — the searcher intent the prompt represents.
export const INTENT_TAG = Object.freeze({
  INFORMATIONAL: 'intent:informational',
  INSTRUCTIONAL: 'intent:instructional',
  COMPARATIVE: 'intent:comparative',
  TRANSACTIONAL: 'intent:transactional',
  PLANNING: 'intent:planning',
  DELEGATION: 'intent:delegation',
});

// `type:<value>` — whether the prompt mentions the brand.
export const TYPE_TAG = Object.freeze({
  BRANDED: 'type:branded',
  NON_BRANDED: 'type:non-branded',
});

/** Builds the `topic:<NAME>` tag for a topic name. */
export function topicTag(name) {
  return `${TAG_DIMENSION.TOPIC}:${name}`;
}

// Tags applied to EVERY AI-generated prompt on top of its `topic:<NAME>` tag:
// `source:ai` (AI-authored) plus the default `intent:informational` (the most
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
