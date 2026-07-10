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

import { TYPE_VALUE } from './prompt-tags.js';
import { collectAliasNames } from './brand-aliases.js';

/**
 * Server-side branded / non-branded classifier — the SINGLE implementation used
 * on every path that writes a Serenity (Semrush sub-workspace) prompt: manual
 * create / edit, CSV import (which reuses the create path), AI generation, and
 * onboarding/provisioning seeding. A prompt carries the `type` value `branded` when its text
 * mentions the brand name or an applicable alias as a WHOLE WORD (diacritics
 * folded); otherwise `non-branded`.
 *
 * This replaces the earlier AI-only substring matcher (`brandedTypeTag`): the
 * match is now word-boundary + diacritic-folding, and it is shared everywhere so
 * the classification is identical no matter how the prompt got in. The behaviour
 * change (substring → whole-word) is forward-only — existing prompts are not
 * reclassified (serenity-docs#31, decisions 1/2/6).
 */

// Latin letters that carry a diacritic/ligature but have NO canonical NFD
// decomposition, so the `\p{Diacritic}` strip alone leaves them intact. Folded
// explicitly to their ASCII base(s) so a brand written with the accented form
// (`Ørsted`, `Æro`) still matches the ASCII-typed spelling in prompt text
// (`Orsted`, `Aero`). Keyed on the lower-cased form (folding runs after
// `toLowerCase`), so only lower-case keys are needed.
const NON_DECOMPOSING_FOLDS = Object.freeze({
  ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ð: 'd', þ: 'th', ł: 'l', đ: 'd', ħ: 'h',
});
const NON_DECOMPOSING_RE = new RegExp(`[${Object.keys(NON_DECOMPOSING_FOLDS).join('')}]`, 'g');

/**
 * Normalizes one side of the match (needle OR haystack) into a canonical,
 * space-delimited token stream:
 *   - fold diacritics (NFD decomposition, strip combining marks) so `café` ≈ `cafe`;
 *   - lower-case (case-insensitive match);
 *   - fold the non-decomposing accented/ligature letters (`ø→o`, `æ→ae`, `ß→ss`,
 *     …) that the NFD strip leaves intact, so `Ørsted` ≈ `Orsted`;
 *   - replace every run of non-alphanumeric characters (Unicode letters/numbers)
 *     with a single space, so punctuation/whitespace collapses to token gaps;
 *   - trim.
 * Both sides go through this, so word-boundary matching reduces to a padded
 * substring test (see {@link classifyBrandedTag}). Applying the identical
 * transform to needle and haystack is what keeps `Ace` from matching `surface`
 * while letting the multi-word needle `le creuset` match a contiguous run.
 *
 * @param {unknown} value
 * @returns {string} the normalized, space-delimited form ('' when empty).
 */
export function normalizeMatch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(NON_DECOMPOSING_RE, (ch) => NON_DECOMPOSING_FOLDS[ch])
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Normalizes a list of raw brand-name / alias strings into deduplicated match
 * needles (empties dropped). The order of first appearance is preserved.
 *
 * @param {string[]} names
 * @returns {string[]}
 */
export function needlesFromNames(names) {
  const seen = new Set();
  const out = [];
  for (const name of Array.isArray(names) ? names : []) {
    const needle = normalizeMatch(name);
    if (needle && !seen.has(needle)) {
      seen.add(needle);
      out.push(needle);
    }
  }
  return out;
}

/**
 * Builds the branded-classification needles for a prompt's market: the brand
 * display name plus the aliases applicable to `market` (region-clamped exactly
 * as the AI/create paths clamp them, via {@link collectAliasNames}), all
 * normalized for matching. An empty market ('' — e.g. an unknown geoTargetId)
 * keeps region-less / 'ww' aliases and drops region-specific ones, so the brand
 * name alone still classifies.
 *
 * @param {string} brandName - the brand display name.
 * @param {Array<string|{name: string, regions?: string[]}>} aliases - brand aliases.
 * @param {string} market - ISO-2 country code of the prompt's market ('' when unknown).
 * @returns {string[]} normalized needles (possibly empty ⇒ everything non-branded).
 */
export function brandNeedles(brandName, aliases, market) {
  return needlesFromNames([
    ...(brandName ? [brandName] : []),
    ...collectAliasNames(aliases, market),
  ]);
}

/**
 * Classifies a prompt as `branded` when its text contains any needle as a
 * whole word (or contiguous whole-word run for a multi-word needle), else
 * `non-branded`. Both sides are normalized via {@link normalizeMatch}; the
 * haystack is padded with spaces so a needle wrapped in spaces matches only on
 * token boundaries. Empty `needles` ⇒ `non-branded`.
 *
 * Returns the BARE value beneath the `type` dimension root; the caller resolves
 * it to an upstream tag id against the project's tree.
 *
 * @param {string} promptText - the prompt text.
 * @param {string[]} needles - normalized needles from {@link brandNeedles} /
 *   {@link needlesFromNames}.
 * @returns {typeof TYPE_VALUE.BRANDED | typeof TYPE_VALUE.NON_BRANDED}
 */
export function classifyBrandedTag(promptText, needles) {
  const list = Array.isArray(needles) ? needles : [];
  if (list.length === 0) {
    return TYPE_VALUE.NON_BRANDED;
  }
  const haystack = ` ${normalizeMatch(promptText)} `;
  return list.some((n) => n && haystack.includes(` ${n} `))
    ? TYPE_VALUE.BRANDED
    : TYPE_VALUE.NON_BRANDED;
}
