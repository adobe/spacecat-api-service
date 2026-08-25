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
import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * The 6 canonical intent buckets persisted in `prompts.intent`. Mirrors the
 * buckets DRS emits (see DRS `prompt_generation_agentic_traffic` generation
 * prompts) and that the stats intent breakdown aggregates over.
 *
 * This module is the single source of truth for the bucket set + normalization.
 * It lives apart from `prompts-storage.js` so the LLM intent classifier can
 * reuse `normalizeIntent` without creating an import cycle.
 */
export const INTENT_VALUES = ['informational', 'instructional', 'comparative', 'transactional', 'planning', 'delegation'];
const CANONICAL_INTENTS = new Set(INTENT_VALUES);

/**
 * Legacy intent labels remapped onto the canonical buckets. Mirrors DRS
 * `INTENT_REMAP` (src/providers/prompt_generation_agentic_traffic/utils/
 * hard_validate.py) so values produced by older generations or external
 * callers collapse onto the supported set instead of dropping to NULL.
 */
const INTENT_REMAP = {
  statistical: 'informational',
  navigational: 'informational',
  commercial: 'transactional',
};

/**
 * Normalizes a caller-supplied intent for persistence into `prompts.intent`.
 *
 * Lowercases the value, applies the legacy remap, then validates against the
 * 6 canonical buckets. Absent, empty, or values that are still invalid after
 * remapping yield `null` — gap-filling (e.g. LLM classification of
 * human-added prompts) is handled elsewhere, so we never coerce to a default
 * bucket here.
 *
 * @param {*} intent - Raw intent value from the request body
 * @returns {string|null} Canonical lowercase intent, or null
 */
export function normalizeIntent(intent) {
  if (!hasText(intent)) {
    return null;
  }
  const lowered = intent.trim().toLowerCase();
  const remapped = INTENT_REMAP[lowered] || lowered;
  return CANONICAL_INTENTS.has(remapped) ? remapped : null;
}
