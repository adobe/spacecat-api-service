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

/**
 * Pure, I/O-free helpers for reading the AI product `prompts` resource shape from a Semrush
 * workspace-resources response. Split out of `serenity-metered-405-canary.mjs` so they're
 * importable/testable without triggering that script's top-level side effects (argv parsing,
 * env-var validation with `process.exit`, live transport construction) — see that file's header
 * for the "Read-side shape drift" this exists to handle.
 */

const LEGACY_PROMPT_KEYS = ['prompts'];
const TIERED_PROMPT_KEYS = ['daily_prompts', 'weekly_prompts'];

export function isUsedTotalPair(dim) {
  return Boolean(dim) && typeof dim.used === 'number' && typeof dim.total === 'number';
}

// Normalizes the two AI-resources read shapes Semrush has been observed to return: a legacy flat
// `prompts` dimension, or the current tiered `daily_prompts` + `weekly_prompts` pair. Returns null
// when neither shape is present.
export function resolvePromptDims(aiResources) {
  if (isUsedTotalPair(aiResources?.prompts)) {
    return { shape: 'legacy', dims: LEGACY_PROMPT_KEYS.map((key) => ({ key, ...aiResources[key] })) };
  }
  const tiered = TIERED_PROMPT_KEYS.map((key) => ({ key, ...aiResources?.[key] }));
  if (tiered.every((dim) => isUsedTotalPair(dim))) {
    return { shape: 'tiered', dims: tiered };
  }
  return null;
}

export function isZeroHeadroom(dims) {
  return dims.every((dim) => dim.total <= dim.used);
}
