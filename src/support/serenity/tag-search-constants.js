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

export const TAG_SEARCH_CURSOR_VERSION = 1;
export const MAX_TAG_SEARCH_CURSOR_LENGTH = 4096;
export const MAX_TAG_SEARCH_CURSOR_DECODED_BYTES = 2048;
export const DEFAULT_TAG_SEARCH_LIMIT = 25;
export const MAX_TAG_SEARCH_LIMIT = 100;
export const MAX_TAG_SEARCH_QUERY_LENGTH = 200;
export const MAX_TREE_PARENT_READS = 200;
export const MAX_TREE_NODES = 10_000;
export const MAX_TREE_CONCURRENCY = 6;
export const MAX_TREE_DURATION_MS = 15_000;
export const MAX_TREE_PAGES_PER_PARENT = 50;
export const TAG_TREE_PAGE_SIZE = 100;

/**
 * Env names overriding the traversal budgets above, so an environment can be
 * tuned against a real production taxonomy without a code change and redeploy
 * (they are read from `context.env`, which merges Secrets Manager, so a change
 * takes effect on the next invocation). The compiled constants stay the
 * defaults: an unset, blank, non-numeric, or non-positive value is ignored, so
 * a typo degrades to the shipped budget rather than to an unbounded walk.
 */
export const TAG_TREE_BUDGET_ENV_KEYS = Object.freeze({
  maxParents: 'SERENITY_TAG_TREE_MAX_PARENTS',
  maxNodes: 'SERENITY_TAG_TREE_MAX_NODES',
  maxDurationMs: 'SERENITY_TAG_TREE_MAX_DURATION_MS',
  concurrency: 'SERENITY_TAG_TREE_CONCURRENCY',
  maxPagesPerParent: 'SERENITY_TAG_TREE_MAX_PAGES_PER_PARENT',
});

/**
 * Kill switch for `GET /serenity/tags/search` alone. Default-ON (absent means
 * enabled), so it changes nothing on deploy; setting it to `'true'` takes the
 * endpoint dark per environment without a redeploy, leaving every other
 * `/serenity/*` route — including the unbounded-nesting reads and the
 * separately flagged deep authoring — untouched.
 */
export const TAG_SEARCH_DISABLED_FLAG = 'SERENITY_TAG_SEARCH_DISABLED';

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function positiveIntegerOr(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const parsed = Number(String(raw).trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolves the per-environment traversal budgets from `env`, falling back to
 * the compiled defaults for anything unset or unusable.
 *
 * @param {Record<string, any> | undefined} env - typically `context.env`.
 * @param {object} [log] - warns once per ignored, present-but-unusable value.
 * @returns {{
 *   maxParents: number,
 *   maxNodes: number,
 *   maxDurationMs: number,
 *   concurrency: number,
 *   maxPagesPerParent: number,
 * }}
 */
export function resolveTagTreeBudgets(env, log) {
  const defaults = {
    maxParents: MAX_TREE_PARENT_READS,
    maxNodes: MAX_TREE_NODES,
    maxDurationMs: MAX_TREE_DURATION_MS,
    concurrency: MAX_TREE_CONCURRENCY,
    maxPagesPerParent: MAX_TREE_PAGES_PER_PARENT,
  };
  /** @type {Record<string, number>} */
  const resolved = {};
  for (const [budget, envKey] of Object.entries(TAG_TREE_BUDGET_ENV_KEYS)) {
    const raw = env?.[envKey];
    const fallback = defaults[/** @type {keyof typeof defaults} */ (budget)];
    const value = positiveIntegerOr(raw, fallback);
    if (raw !== undefined && String(raw).trim() !== '' && value === fallback
      && Number(String(raw).trim()) !== fallback) {
      log?.warn?.(`[serenity] ${envKey} is not a positive integer — using the default ${fallback}`);
    }
    resolved[budget] = value;
  }
  return /** @type {ReturnType<typeof resolveTagTreeBudgets>} */ (resolved);
}

/**
 * @param {Record<string, any> | undefined} env - typically `context.env`.
 * @returns {boolean} `false` only when {@link TAG_SEARCH_DISABLED_FLAG} is
 *   explicitly `'true'`; anything else (including unset) leaves search enabled.
 */
export function isTagSearchDisabled(env) {
  return String(env?.[TAG_SEARCH_DISABLED_FLAG] ?? '').trim().toLowerCase() === 'true';
}
