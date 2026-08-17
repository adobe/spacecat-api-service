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
 * after trim/dedupe). Used to skip a project `brand_names` PATCH when the set has
 * not actually changed. Benchmark `brand_aliases` use {@link sameAliasSetExact}
 * instead — see the alias-identity note on {@link mergeBenchmarkAliases}.
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
 * The alias spellings to send for a benchmark, in the form Semrush's own brand
 * resolution uses: all lowercase.
 *
 * Upstream identifies an alias by its case-folded value, so `Acme` and `acme` are
 * ONE alias, not two — submitting both in a single list is rejected outright
 * (`409 duplicate brand name or alias`, live-verified 2026-08-13). This returns one
 * spelling per alias, lowercased, which is what Semrush stores when it creates an
 * alias itself (benchmark `Apple` carries `apple`, `Ford` carries `ford`).
 *
 * The benchmark's own name is included, because a benchmark's `brand_aliases`
 * normally repeats it and the same folding applies to that entry.
 *
 * Nothing is stored lowercase: `brand_aliases.alias` and `competitors.aliases`
 * keep the casing the customer typed — that is what the UI renders, and our own
 * matchers fold both sides already. The lowercasing happens HERE, on the way to
 * the payload.
 *
 * These are PREFERENCES, not commands: {@link mergeBenchmarkAliases} only applies
 * a spelling when it creates the alias, since upstream keeps the spelling an alias
 * was first stored with (see there).
 *
 * @param {string} [brandName] - the benchmark's `brand_name`.
 * @param {Array<string>} [aliases] - the aliases as stored on the brand.
 * @returns {string[]}
 */
export function benchmarkAliases(brandName, aliases) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!hasText(v) || seen.has(v)) {
      return;
    }
    seen.add(v);
    out.push(v);
  };
  dedupeAliases(aliases).forEach(add);
  // hasText does not narrow string|undefined — check the value first (see the
  // serenity type-checking notes).
  if (brandName && hasText(brandName)) {
    add(brandName);
  }
  return out;
}

/**
 * The alias list to PUT on a benchmark: the live list, minus what this edit
 * removed, plus any desired alias not already there.
 *
 * Three upstream behaviours shape this (all live-verified 2026-08-13):
 *
 * 1. An alias is identified by its CASE-FOLDED value, and the stored spelling is
 *    the one it was created with. Re-submitting a different casing does not change
 *    it — sending `Bark Phone` for a live `bark phone` leaves `bark phone`. So an
 *    existing alias keeps its live spelling here, and `desired` only decides the
 *    spelling of an alias being created. Re-casing an existing one takes a delete
 *    and a re-add, which is a repair pass, not something an edit does.
 * 2. A PUT replaces the whole list, so anything the caller does not send is gone.
 *    Semrush's resolution adds values we cannot reproduce — benchmark
 *    `General Motors` gains `gm`, `pixlr` gains the misspelling `pixlar` — and
 *    those survive only by being carried forward from the live list.
 * 3. Two spellings of one alias in a single list are rejected with a 409 that
 *    fails the whole write, which folding by key here makes impossible to build.
 *
 * `removed` is subtracted before the merge, so an alias the customer deleted
 * disappears while one that is both deleted and still desired survives.
 *
 * @param {Array<string>} [live] - the benchmark's current `brand_aliases`.
 * @param {Array<string>} [desired] - preferred spellings, from {@link benchmarkAliases}.
 * @param {Array<string>} [removed=[]] - aliases dropped from the brand in this edit.
 * @returns {string[]}
 */
export function mergeBenchmarkAliases(live, desired, removed = []) {
  const keyOf = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const gone = new Set(
    (Array.isArray(removed) ? removed : []).map(keyOf).filter((k) => hasText(k)),
  );
  // key → spelling to send. Live entries win their spelling; a desired alias only
  // gets its own spelling when it is not already there.
  const spellings = new Map();
  for (const a of Array.isArray(live) ? live : []) {
    const key = keyOf(a);
    if (hasText(key) && !gone.has(key) && !spellings.has(key)) {
      spellings.set(key, a.trim());
    }
  }
  for (const a of Array.isArray(desired) ? desired : []) {
    const key = keyOf(a);
    if (hasText(key) && !spellings.has(key)) {
      spellings.set(key, a.trim());
    }
  }
  return [...spellings.values()];
}

/**
 * The alias keys other benchmarks in the same project already own — every OTHER
 * benchmark's `brand_name` and `brand_aliases`, case-folded.
 *
 * Upstream enforces alias uniqueness across the union of every benchmark's name and
 * aliases WITHIN A PROJECT, case-insensitively, and a duplicate is refused with a
 * `409 duplicate brand name or alias` that fails the WHOLE write — for a batched
 * create, every benchmark in the batch, including the ones that would have been
 * fine (live-verified 2026-08-13). Sending an alias another benchmark owns is
 * therefore not a small mistake; it takes unrelated work down with it.
 *
 * Callers subtract this from what they were going to send. The values are dropped
 * silently rather than reported: they are ours to derive, so a customer cannot act
 * on them, and the alternative is a failed edit.
 *
 * @param {Array<object>} benchmarks - `aio_benchmarks` from `listBenchmarks`.
 * @param {string} [ownId] - the benchmark being written, excluded from the set.
 * @returns {Set<string>} case-folded keys.
 */
export function aliasKeysOwnedByOthers(benchmarks, ownId) {
  const owned = new Set();
  for (const b of Array.isArray(benchmarks) ? benchmarks : []) {
    if (ownId !== undefined && ownId !== null && String(b?.id) === String(ownId)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const values = [b?.brand_name, ...(Array.isArray(b?.brand_aliases) ? b.brand_aliases : [])];
    for (const v of values) {
      // Key on the trimmed value, not the raw one: `hasText` counts whitespace as
      // text, so a blank name would otherwise add an empty key to the set.
      const key = typeof v === 'string' ? v.trim().toLowerCase() : '';
      if (hasText(key)) {
        owned.add(key);
      }
    }
  }
  return owned;
}

/**
 * Whether two alias lists hold the same spellings (order ignored, casing
 * significant). The benchmark write decision uses this rather than
 * {@link sameAliasSet} so that a re-cased alias registers as a difference.
 *
 * Because {@link mergeBenchmarkAliases} keeps every live spelling, comparing its
 * result against the live list this way reports a difference only when an alias is
 * genuinely added or removed — a spelling we would prefer but cannot apply does not
 * cause a write, which is what keeps a steady-state re-sync silent.
 *
 * @param {Array<string>} [a]
 * @param {Array<string>} [b]
 * @returns {boolean}
 */
export function sameAliasSetExact(a, b) {
  const trimmed = (list) => (Array.isArray(list) ? list : [])
    .filter((v) => hasText(v))
    .map((v) => v.trim());
  const sa = [...new Set(trimmed(a))];
  const sb = [...new Set(trimmed(b))];
  if (sa.length !== sb.length) {
    return false;
  }
  const set = new Set(sb);
  return sa.every((v) => set.has(v));
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
