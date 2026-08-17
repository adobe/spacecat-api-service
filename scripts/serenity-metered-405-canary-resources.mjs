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

const TIERED_PROMPT_KEYS = ['daily_prompts', 'weekly_prompts'];

export function isUsedTotalPair(dim) {
  return Boolean(dim) && typeof dim.used === 'number' && typeof dim.total === 'number';
}

// Narrows a raw resource-dimension object down to exactly {key, used, total} — deliberately NOT a
// spread of the source object, so unrelated vendor fields on the raw response never silently ride
// along in `dims` (they're not needed downstream today, but `dims` shapes what a future write call
// could serialize, so keeping it exact avoids that becoming a footgun later).
function pickDim(key, source) {
  return { key, used: source?.used, total: source?.total };
}

// Normalizes the two AI-resources read shapes Semrush has been observed to return: a legacy flat
// `prompts` dimension, or the current tiered `daily_prompts` + `weekly_prompts` pair. Returns null
// when neither shape is present.
export function resolvePromptDims(aiResources) {
  const legacy = pickDim('prompts', aiResources?.prompts);
  if (isUsedTotalPair(legacy)) {
    return { shape: 'legacy', dims: [legacy] };
  }
  const tiered = TIERED_PROMPT_KEYS.map((key) => pickDim(key, aiResources?.[key]));
  if (tiered.every((dim) => isUsedTotalPair(dim))) {
    return { shape: 'tiered', dims: tiered };
  }
  return null;
}

// `dims` is always the 1-2 element array `resolvePromptDims` returns, never empty — but since this
// is an exported, standalone helper, make the empty-input contract explicit rather than relying on
// `Array.prototype.every`'s vacuous-true default (which would otherwise silently read "zero
// headroom" for "no dimensions given").
export function isZeroHeadroom(dims) {
  if (!dims.length) {
    return false;
  }
  return dims.every((dim) => dim.total <= dim.used);
}
