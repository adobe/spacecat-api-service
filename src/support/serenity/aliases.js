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

import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * Shared brand-alias helpers. A brand's aliases (own-brand `brand_aliases` and a
 * competitor's `aliases`) are lists of free-form name strings that propagate to
 * Semrush benchmark `brand_aliases` / project `brand_names`. Both the own-brand
 * alias sync and the competitor-benchmark sync need the same trim/dedupe and
 * set-equality semantics, so they live here.
 */

/**
 * Trims, drops empties, and de-duplicates an alias list (case-insensitive key,
 * first-seen spelling wins, original order preserved). Non-array input → [].
 *
 * @param {Array<string>} [list]
 * @returns {string[]}
 */
export function dedupeAliases(list) {
  const seen = new Set();
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const value = typeof a === 'string' ? a.trim() : '';
    if (!hasText(value)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Whether two alias lists denote the same set (order- and case-insensitive,
 * after trim/dedupe). Used to skip an in-place benchmark/project update when the
 * alias set has not actually changed.
 *
 * @param {Array<string>} [a]
 * @param {Array<string>} [b]
 * @returns {boolean}
 */
export function sameAliasSet(a, b) {
  const sa = dedupeAliases(a).map((s) => s.toLowerCase()).sort();
  const sb = dedupeAliases(b).map((s) => s.toLowerCase()).sort();
  if (sa.length !== sb.length) {
    return false;
  }
  return sa.every((v, i) => v === sb[i]);
}

/**
 * From a benchmark listing, extract the aliases Semrush rejected
 * (`rejected_brand_aliases`) for the benchmarks selected by `select`. Returns
 * `[{ domain, aliases }]` only for benchmarks that have at least one rejected
 * alias. Pure — the caller fetches the listing (a re-read after the alias write,
 * since neither the create nor the update response carries the rejected set).
 *
 * @param {Array<object>} benchmarks - `aio_benchmarks` from `listBenchmarks`.
 * @param {(b: object) => boolean} select - keep predicate (e.g. `main_brand`, or
 *   domain ∈ a desired set).
 * @returns {{domain: string|null, aliases: string[]}[]}
 */
export function rejectedAliasesFrom(benchmarks, select) {
  const out = [];
  for (const b of Array.isArray(benchmarks) ? benchmarks : []) {
    if (!select(b)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const rejected = Array.isArray(b?.rejected_brand_aliases)
      ? b.rejected_brand_aliases.filter((a) => hasText(a))
      : [];
    if (rejected.length > 0) {
      out.push({ domain: b?.domain ?? null, aliases: rejected });
    }
  }
  return out;
}
