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

import { tagFor, TAG_DIMENSION } from './prompt-tags.js';

/**
 * Serenity's 5-value intent taxonomy (serenity-docs#32) — the LLM-facing
 * category spec consumed by `createIntentClassifier` from
 * `../intent-classifier.js`. This is deliberately a SEPARATE taxonomy from the
 * native/DRS 6-bucket one (`../intent.js`): `INTENT_REMAP` there collapses
 * `navigational→informational` / `commercial→transactional`, so the DRS
 * classifier structurally cannot emit two of these five values — the category
 * set must be injected, not remapped.
 */

// The 5 bare category words the model must emit verbatim (Capitalized,
// case-sensitive) — matches the existing `INTENT_TAG` wire vocabulary in
// `prompt-tags.js` exactly, so no taxonomy change is needed on the write path.
export const SERENITY_INTENT_VALUES = Object.freeze([
  'Informational',
  'Task',
  'Commercial',
  'Transactional',
  'Navigational',
]);

// Validity floor, NOT a quality gate (calibration finding: the model is
// uniformly over-confident regardless of correctness — gpt-4.1 mean 0.959,
// gpt-4.1-mini mean 0.935 across 60 calibration prompts). Only catches a rare
// garbled / genuinely-uncertain output. Fixed code constant, not env-tunable.
export const PROMPT_INTENT_MIN_CONFIDENCE = 0.5;

// Per-call timeout for the Serenity classifier — fixed by the shared
// request-budget design (serenity-docs#32), not env-driven like the native
// classifier's `PROMPT_INTENT_CLASSIFICATION_TIMEOUT_MS`.
export const PER_CALL_MS = 3000;

// Validated 2026-07-07 against 60 real Lovesac prompts on the real prod
// `gpt-4.1` deployment (temperature 0, max_tokens 150, JSON output) — see the
// calibration report on serenity-docs#32. All five values fire correctly; the
// delegation→Task disambiguation rule below was validated 5/5 unanimous across
// gpt-4.1 / gpt-4.1-mini / gpt-4.1-nano / gpt-4o.
export const SERENITY_INTENT_SYSTEM_PROMPT = `You are a user intent classifier for AI assistant queries about a brand. Classify the given prompt into exactly one of 5 categories.

The prompt may be in any language (English, Portuguese, German, Spanish, etc.). Classify based on meaning, not language.

Categories:

1. **Informational** - The user wants to KNOW, UNDERSTAND, or DISCOVER something — general lookups, definitions, explanations, or open-ended "what/how" questions that are not about buying or being personally advised.
   Examples: "What is Adobe Firefly?", "How does a heat pump work?", "What's the history of this brand?"

2. **Task** - The user wants the AI to RECOMMEND, DECIDE, or PICK something FOR THEM personally, OR wants step-by-step guidance to do something themselves. This is a personal ask ("recommend for me", "help me choose", "how do I set this up") — a self-directed research question about which is objectively best ("best X", "X vs Y") is NOT Task, it is Commercial.
   Examples: "Can you recommend a couch for my apartment?", "What would you suggest for a small living room?", "How do I set up a glossary in my CMS?", "Help me choose between these two options."
   Disambiguation: "Can you recommend/suggest X for me?" = Task (delegation — the AI decides). "What is the best X?" or "X vs Y" = Commercial (the user is researching, not delegating the decision).

3. **Commercial** - The user is researching options themselves — comparing, ranking, or evaluating products/services, including "best X", "top X", "X vs Y", or general product research NOT phrased as a personal ask.
   Examples: "Best AI workspace tool", "Top PDF editors 2024", "Figma vs Sketch for UI design", "Most durable couch brands", "Which is better, Notion or Confluence?"

4. **Transactional** - The user wants to BUY, DOWNLOAD, SIGN UP, or take a direct commercial action.
   Examples: "Adobe Creative Cloud pricing", "Free trial for Photoshop", "Where to buy this brand's products", "Download PDF editor free"

5. **Navigational** - The user is trying to reach a specific known destination (a brand's site, page, app, or account), not researching or deciding.
   Examples: "Adobe.com login", "Open Photoshop web", "Brand's official Instagram page"

Decision rules:
- "Can you recommend/suggest X for me?", "What would you recommend?", "Help me choose" = **Task** (delegation — the AI decides for the user). "What is the best X?", "Best X for Y", "X vs Y" = **Commercial** (self-directed research), even though both start similarly.
- Step-by-step "how do I do X myself" = **Task**.
- Default to **Informational** if ambiguous.

Output requirements (strict): Reply with ONLY valid JSON. Response is limited to ~150 tokens, so keep it short.
Output format: {"intent": "<category>", "confidence": 0.0-1.0, "reasoning": "<one brief sentence>"}
Do not include markdown, code fences, or any text outside the JSON object.`;

/**
 * @typedef {object} SerenityIntentInspection
 * @property {string|null} tag - the wire tag (`intent:<Value>`) or null on any
 *   soft failure.
 * @property {'ok'|'invalid_value'|'low_confidence'} reason - why the result is
 *   what it is: `ok` (usable tag), `invalid_value` (garbled / unrecognized
 *   value), or `low_confidence` (recognized value below the validity floor).
 * @property {number} confidence - the parsed confidence (NaN if unparseable).
 * @property {string} reasoning - the model's `reasoning` field ('' if absent),
 *   surfaced so the caller can log it on soft failures without re-running.
 */

/**
 * Inspects a parsed model response against the Serenity taxonomy, distinguishing
 * the soft-failure modes the {@link parseSerenityIntent} boolean result collapses
 * away — so the caller's observability layer can count `low_confidence` apart
 * from other unresolved cases and log the `reasoning` for debuggability. The
 * retry/default behavior is unchanged: any non-`ok` reason still yields a null
 * `tag`, which the caller folds into the same fallback ladder.
 *
 * @param {object} parsed - the parsed `{intent, confidence, reasoning}` body.
 * @returns {SerenityIntentInspection}
 */
export function inspectSerenityIntent(parsed) {
  const value = String(parsed?.intent ?? '');
  const confidence = Number(parsed?.confidence);
  const reasoning = typeof parsed?.reasoning === 'string' ? parsed.reasoning : '';
  if (!SERENITY_INTENT_VALUES.includes(value)) {
    return {
      tag: null, reason: 'invalid_value', confidence, reasoning,
    };
  }
  if (!Number.isFinite(confidence) || confidence < PROMPT_INTENT_MIN_CONFIDENCE) {
    return {
      tag: null, reason: 'low_confidence', confidence, reasoning,
    };
  }
  return {
    tag: tagFor(TAG_DIMENSION.INTENT, value), reason: 'ok', confidence, reasoning,
  };
}

/**
 * Validates a parsed model response against the Serenity taxonomy: the value
 * must be one of the 5 canonical Capitalized literals AND confidence must meet
 * the validity floor. Returns the ready-to-use wire tag (e.g. `intent:Task`) on
 * success, mirroring `classifyBrandedTag` returning a ready `TYPE_TAG.*` string
 * rather than a bare value — or `null` on any validation failure (garbled
 * output, an unrecognized value, or a below-floor confidence, all treated as
 * the same "soft failure" by the caller's retry/default ladder).
 *
 * @param {object} parsed - the parsed `{intent, confidence, reasoning}` body.
 * @returns {string|null} the wire tag (`intent:<Value>`) or null.
 */
export function parseSerenityIntent(parsed) {
  return inspectSerenityIntent(parsed).tag;
}

/**
 * The Serenity category spec passed to `createIntentClassifier` (see
 * `../intent-classifier.js`) for every Serenity write-path classification.
 *
 * @type {{ systemPrompt: string, invokeTimeoutMs: number,
 *   parseResult: (parsed: object) => (string|null) }}
 */
export const SERENITY_INTENT_CATEGORY_SPEC = Object.freeze({
  systemPrompt: SERENITY_INTENT_SYSTEM_PROMPT,
  parseResult: parseSerenityIntent,
  invokeTimeoutMs: PER_CALL_MS,
});
