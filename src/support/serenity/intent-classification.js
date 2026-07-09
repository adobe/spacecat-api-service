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

import { createIntentClassifier, classifyIntents } from '../intent-classifier.js';
import { INTENT_TAG } from './prompt-tags.js';
import { SERENITY_INTENT_CATEGORY_SPEC, PER_CALL_MS } from './intent-taxonomy.js';

/**
 * Serenity write-path request budget (serenity-docs#32) — a single shared
 * deadline so classify + its budget-gated retry + create-fanout + publish
 * together stay under the ~15s Fastly first-byte timeout the write already
 * shares. `WRITE_SOFT_BUDGET_MS` leaves ~3s margin; `CREATE_PUBLISH_RESERVE_MS`
 * is reserved for the write itself, so classification only gets the remainder.
 */
export const WRITE_SOFT_BUDGET_MS = 12000;
export const CREATE_PUBLISH_RESERVE_MS = 6000;

// Classify concurrency. Deliberately a local constant rather than importing
// `BULK_CREATE_CONCURRENCY` from `./handlers/prompts.js` (which would create a
// circular import, since that module imports from here) — by design decision
// (serenity-docs#32) it currently mirrors that value.
const CLASSIFY_CONCURRENCY = 8;

// AI-generation classify cap (serenity-docs#32, resolved 2026-07-09): 2 budget
// rounds (one call + one budget-gated retry) at CLASSIFY_CONCURRENCY each.
export const AI_GEN_CLASSIFY_MAX = CLASSIFY_CONCURRENCY * 2;

/**
 * Computes the request-scoped write deadline. Call once at controller entry,
 * before any classify/create/publish work begins.
 *
 * @param {number} [now] - override for testing.
 * @returns {number} epoch ms deadline.
 */
export function computeWriteDeadline(now = Date.now()) {
  return now + WRITE_SOFT_BUDGET_MS;
}

/**
 * Remaining budget (ms) available for classification: whatever is left on the
 * deadline, minus the reserve for create-fanout + publish. Never negative.
 *
 * @param {number} deadline - epoch ms deadline from {@link computeWriteDeadline}.
 * @param {number} [now] - override for testing.
 * @returns {number}
 */
function remainingClassifyBudget(deadline, now = Date.now()) {
  return Math.max(0, (deadline - now) - CREATE_PUBLISH_RESERVE_MS);
}

/**
 * Batch-classifies prompt texts into `intent:<Value>` wire tags under the
 * shared write-budget, applying the full fallback ladder from serenity-docs#32:
 *
 * 1. Hard skip-gate — if there's no room for even one call at entry, default
 *    everything immediately (no LLM calls attempted, counted `budget_skipped`).
 * 2. Azure not configured — default everything (same in every environment; a
 *    `warn` + `prod_llm_unavailable` signal only in prod, `info` elsewhere).
 * 3. First classify pass under the remaining budget.
 * 4. One budget-gated retry for anything still unresolved — only if there's
 *    still room for a full per-call timeout; otherwise skip straight to default.
 * 5. Terminal default `intent:Informational` for anything still unresolved.
 *
 * Every input text is guaranteed a value in the returned map — never missing —
 * so callers never need a separate "no tag" branch.
 *
 * @param {string[]} texts - prompt texts to classify (deduplicated internally).
 * @param {object} options
 * @param {object} [options.env] - environment (Azure OpenAI creds).
 * @param {object} [options.log] - logger.
 * @param {number} options.deadline - the request's write deadline (epoch ms).
 * @returns {Promise<Map<string, string>>} text -> `intent:<Value>` wire tag.
 */
export async function classifyPromptIntents(texts, { env, log = console, deadline }) {
  // `env`/`log` may arrive explicitly `null` (some callers default optional
  // options that way) — a default *parameter* only applies on `undefined`, so
  // normalize here rather than relying on destructuring defaults.
  const safeEnv = env || {};
  const safeLog = log || console;
  const unique = [...new Set((texts || []).filter((t) => typeof t === 'string' && t.length > 0))];
  const result = new Map();
  if (unique.length === 0) {
    return result;
  }

  const counts = {
    classified_ok: 0, retry_attempted: 0, retry_succeeded: 0, defaulted: 0, budget_skipped: 0,
  };

  const defaultAll = (list) => {
    list.forEach((t) => result.set(t, INTENT_TAG.INFORMATIONAL));
    counts.defaulted += list.length;
  };

  if (remainingClassifyBudget(deadline) < PER_CALL_MS) {
    counts.budget_skipped = unique.length;
    defaultAll(unique);
    safeLog?.info?.('serenity intent classification: budget_skipped (no room at entry)', { count: unique.length });
    return result;
  }

  const classify = createIntentClassifier(
    { env: safeEnv, log: safeLog },
    SERENITY_INTENT_CATEGORY_SPEC,
  );
  if (typeof classify !== 'function') {
    defaultAll(unique);
    const message = 'serenity intent classification: Azure OpenAI is not configured; defaulting to Informational';
    if (safeEnv.AWS_ENV === 'prod') {
      safeLog?.warn?.(`WARN: prod_llm_unavailable — ${message}`);
    } else {
      safeLog?.info?.(message);
    }
    return result;
  }

  const firstPass = await classifyIntents(classify, unique, {
    maxConcurrency: CLASSIFY_CONCURRENCY,
    timeoutMs: remainingClassifyBudget(deadline),
  });
  const stillUnresolved = [];
  unique.forEach((t) => {
    const value = firstPass.get(t);
    if (value) {
      result.set(t, value);
      counts.classified_ok += 1;
    } else {
      stillUnresolved.push(t);
    }
  });

  if (stillUnresolved.length > 0 && remainingClassifyBudget(deadline) >= PER_CALL_MS) {
    counts.retry_attempted = stillUnresolved.length;
    const retryPass = await classifyIntents(classify, stillUnresolved, {
      maxConcurrency: CLASSIFY_CONCURRENCY,
      timeoutMs: remainingClassifyBudget(deadline),
    });
    const stillUnresolvedAfterRetry = [];
    stillUnresolved.forEach((t) => {
      const value = retryPass.get(t);
      if (value) {
        result.set(t, value);
        counts.retry_succeeded += 1;
      } else {
        stillUnresolvedAfterRetry.push(t);
      }
    });
    defaultAll(stillUnresolvedAfterRetry);
  } else {
    defaultAll(stillUnresolved);
  }

  safeLog?.info?.('serenity intent classification summary', counts);
  return result;
}
