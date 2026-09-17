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
import { SERENITY_INTENT_CATEGORY_SPEC } from './intent-taxonomy.js';

// Classify concurrency, matching the sync write-path's `CLASSIFY_CONCURRENCY`
// (a local constant here too, for the same reason: importing it would create a
// circular import back through `./intent-classification.js` -> `./handlers/prompts.js`).
const CLASSIFY_CONCURRENCY = 8;

// Bounded LLM-level retry ("retrying with backoff" per serenity-docs#33) —
// distinct from the job-level "one re-enqueue" the handler does for whatever is
// still unresolved after this exhausts. 5 rounds keeps a genuinely-down LLM from
// looping the worker indefinitely inside a single invocation.
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

/**
 * Exponential backoff delay (ms) for retry attempt `attempt` (1-indexed),
 * capped so a long run of failures does not stall the worker indefinitely
 * between rounds.
 *
 * @param {number} attempt - 1-indexed attempt number just completed.
 * @returns {number}
 */
function backoffDelayMs(attempt) {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * (2 ** (attempt - 1)));
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Async-worker counterpart of `classifyPromptIntents` (`./intent-classification.js`),
 * for the deferred `serenity-classify-prompts` job (serenity-docs#33). The sync
 * write-path version is bound by the shared ~15s Fastly request budget and MUST
 * terminal-default anything unresolved to `Informational` when that budget runs
 * out. The worker has no such budget — the whole point of moving classification
 * off the request path — so it retries a soft failure (LLM error, timeout, or a
 * confidence below `PROMPT_INTENT_MIN_CONFIDENCE`, both folded into the same
 * "unresolved" signal by `classifyIntents`) with backoff, and ONLY gives up after
 * `maxAttempts` rounds. A prompt still unresolved after that is left OUT of the
 * result with an explicit `null` — never defaulted — so the caller
 * (`makeIntentInjector`) writes it with no value under the `intent` root at all.
 *
 * @param {string[]} texts - prompt texts to classify (deduplicated internally).
 * @param {object} [options]
 * @param {object} [options.env] - environment (Azure OpenAI creds).
 * @param {object} [options.log] - logger.
 * @param {number} [options.maxAttempts] - classify rounds before giving up on a
 *   still-unresolved text (each round classifies every text still pending).
 * @returns {Promise<Map<string, string|null>>} text -> bare `intent` value, or
 *   `null` for a text whose retries were exhausted.
 */
export async function classifyPromptIntentsUnbounded(texts, {
  env, log = console, maxAttempts = MAX_ATTEMPTS,
} = {}) {
  const safeEnv = env || {};
  const safeLog = log || console;
  const unique = [...new Set((texts || []).filter((t) => typeof t === 'string' && t.length > 0))];
  const result = new Map();
  if (unique.length === 0) {
    return result;
  }

  const classify = createIntentClassifier(
    { env: safeEnv, log: safeLog },
    SERENITY_INTENT_CATEGORY_SPEC,
  );
  if (typeof classify !== 'function') {
    unique.forEach((t) => result.set(t, null));
    safeLog?.warn?.('serenity async intent classification: Azure OpenAI is not configured; leaving prompts unclassified for a later retry');
    return result;
  }

  let pending = unique;
  for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt += 1) {
    // No per-round time budget (`timeoutMs: Infinity`) — `classifyIntents` only
    // races a timeout when `Number.isFinite(timeoutMs)`, so this round runs to
    // completion for every still-pending text, matching the issue's "classify
    // with no time budget".
    // eslint-disable-next-line no-await-in-loop
    const pass = await classifyIntents(classify, pending, {
      maxConcurrency: CLASSIFY_CONCURRENCY,
      timeoutMs: Infinity,
    });
    const stillUnresolved = [];
    pending.forEach((t) => {
      const value = pass.get(t);
      if (value) {
        result.set(t, value);
      } else {
        stillUnresolved.push(t);
      }
    });
    pending = stillUnresolved;
    if (pending.length > 0 && attempt < maxAttempts) {
      safeLog?.info?.('serenity async intent classification: retrying still-unresolved prompts', {
        attempt, remaining: pending.length,
      });
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoffDelayMs(attempt));
    }
  }

  if (pending.length > 0) {
    pending.forEach((t) => result.set(t, null));
    safeLog?.info?.('serenity async intent classification: exhausted retries, leaving unclassified for a follow-up job', {
      count: pending.length,
    });
  }

  return result;
}
