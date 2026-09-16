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
 * Onboarding-topic → existing-category classification (adobe/serenity-docs#44,
 * see `onboarding-prompt-categorization-implementation-plan.md`). Unlike the
 * fixed 5/6-value `intent` taxonomy (`intent-taxonomy.js`), `category` is an
 * OPEN, customer-authored dimension (`dimension-root-tag-model.md` §1) — there
 * is no fixed vocabulary to bake into a static system prompt. The candidate set
 * is the brand's OWN existing top-level category names, fetched once per
 * onboarding run and injected into the prompt built here; classification NEVER
 * invents a category the customer never authored (plan §0).
 *
 * Sentinel: the model may legitimately conclude no existing category fits — it
 * must say so explicitly (`NO_MATCH`) rather than be forced to pick one, so a
 * genuinely-uncategorized topic stays uncategorized (unchanged from today),
 * exactly like a below-confidence-floor result.
 */

// Emitted by the model when no existing category is a good fit. Distinct from
// any real category name, and never itself checked into a brand's category
// vocabulary, so a caller can tell "explicitly no match" apart from "garbled
// output" (both fold to the same null result, but a caller can log a `reason`).
export const NO_MATCH = 'NO_MATCH';

// Validity floor — mirrors `PROMPT_INTENT_MIN_CONFIDENCE`'s role: not a quality
// gate, just a fixed floor that keeps a garbled / genuinely-uncertain output
// from attaching a wrong category. Deliberately higher than the intent floor
// (0.5): a wrong `intent` value is a soft miscategorization within a fixed,
// reversible closed-dimension vocabulary; a wrong `category` mints a durable,
// customer-visible sub-category tag under someone else's category, so this
// plan's design (§2.2) sets a stricter default until the calibration pass in
// §5.3 of the plan replaces it with a data-backed value.
export const CATEGORY_MIN_CONFIDENCE = 0.7;

// Per-call timeout for the topic→category classifier. Onboarding topic
// generation classifies at most `MAX_TOPICS_ON_CREATE` (5) topics per run — far
// fewer than the up-to-`AI_GEN_CLASSIFY_MAX` (16) prompt texts `intent`
// classifies — so this reuses the same per-call budget as the Serenity intent
// classifier (`PER_CALL_MS`) rather than defining a second constant.
export { PER_CALL_MS } from './intent-taxonomy.js';

/**
 * Builds the system prompt for one classification run, embedding the caller's
 * existing top-level category names as the closed candidate set for THIS call
 * only (the "vocabulary" is per-brand, not global — a new `createIntentClassifier`
 * call is required per distinct candidate set, which is exactly what one
 * onboarding run needs: one candidate set, reused across its ≤5 topics).
 *
 * @param {readonly string[]} categoryNames - the brand's existing top-level
 *   `category` children (bare names), already deduplicated by the caller.
 * @returns {string} the system prompt.
 */
export function buildCategorySystemPrompt(categoryNames) {
  const list = categoryNames.map((name) => `- ${name}`).join('\n');
  return `You are classifying a topic (a short phrase describing what a set of AI-assistant prompts are about) against a brand's EXISTING set of content categories, so the topic can be filed as a sub-category under the single best-matching category.

Existing categories for this brand:
${list}

Rules:
- Pick EXACTLY ONE existing category from the list above that the topic best fits under, OR answer "${NO_MATCH}" if none of them are a reasonable fit.
- NEVER invent a category name that is not in the list above.
- If the topic could plausibly fit more than one category, pick the single closest match — do not attempt to output more than one.
- Base the decision on the topic's meaning, not superficial word overlap.

Output requirements (strict): Reply with ONLY valid JSON. Response is limited to ~150 tokens, so keep it short.
Output format: {"category": "<exact existing category name, or \\"${NO_MATCH}\\">", "confidence": 0.0-1.0, "reasoning": "<one brief sentence>"}
Do not include markdown, code fences, or any text outside the JSON object.`;
}

/**
 * @typedef {object} TopicCategoryInspection
 * @property {string|null} value - the matched existing category NAME (an exact
 *   member of the candidate set passed to {@link buildCategorySystemPrompt}), or
 *   null on any soft failure (including an explicit `NO_MATCH`).
 * @property {'ok'|'no_match'|'invalid_value'|'low_confidence'} reason - `ok`
 *   (usable match), `no_match` (model explicitly found nothing to match),
 *   `invalid_value` (garbled / a name outside the candidate set — the model
 *   hallucinated a category), or `low_confidence` (a valid candidate name below
 *   {@link CATEGORY_MIN_CONFIDENCE}).
 * @property {number} confidence - the parsed confidence (NaN if unparseable).
 * @property {string} reasoning - the model's `reasoning` field ('' if absent).
 */

/**
 * Inspects a parsed model response against the SPECIFIC candidate set this call
 * was built for (a hallucinated name outside `categoryNames` is `invalid_value`,
 * never silently accepted — this plan never invents categories, see plan §0).
 *
 * @param {object} parsed - the parsed `{category, confidence, reasoning}` body.
 * @param {readonly string[]} categoryNames - the candidate set this call used.
 * @returns {TopicCategoryInspection}
 */
export function inspectTopicCategory(parsed, categoryNames) {
  const value = String(parsed?.category ?? '');
  const confidence = Number(parsed?.confidence);
  const reasoning = typeof parsed?.reasoning === 'string' ? parsed.reasoning : '';
  if (value === NO_MATCH) {
    return {
      value: null, reason: 'no_match', confidence, reasoning,
    };
  }
  if (!categoryNames.includes(value)) {
    return {
      value: null, reason: 'invalid_value', confidence, reasoning,
    };
  }
  if (!Number.isFinite(confidence) || confidence < CATEGORY_MIN_CONFIDENCE) {
    return {
      value: null, reason: 'low_confidence', confidence, reasoning,
    };
  }
  return {
    value, reason: 'ok', confidence, reasoning,
  };
}

/**
 * Builds the `CategorySpec` (see `../intent-classifier.js` `createIntentClassifier`)
 * for one onboarding run's candidate set. Callers needing the soft-failure
 * `reason` (for observability) should use {@link inspectTopicCategory} directly
 * via a custom `parseResult`, mirroring `intent-classification.js`'s
 * `observedSpec` pattern — this export is the plain, reason-discarding spec for
 * simple callers/tests.
 *
 * @param {readonly string[]} categoryNames - the brand's existing top-level
 *   category names (deduplicated).
 * @param {number} [invokeTimeoutMs] - per-call timeout override.
 * @returns {{ systemPrompt: string, parseResult: (parsed: object) => (string|null),
 *   invokeTimeoutMs?: number }}
 */
export function buildCategoryClassificationSpec(categoryNames, invokeTimeoutMs) {
  return {
    systemPrompt: buildCategorySystemPrompt(categoryNames),
    parseResult: (parsed) => inspectTopicCategory(parsed, categoryNames).value,
    ...(invokeTimeoutMs !== undefined ? { invokeTimeoutMs } : {}),
  };
}
