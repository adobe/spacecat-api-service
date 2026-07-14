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
import { emitMetric, resolveEnvironment } from '../metrics-emf.js';
import { INTENT_TAG, TAG_DIMENSION, tagFor } from './prompt-tags.js';
import {
  SERENITY_INTENT_CATEGORY_SPEC,
  SERENITY_INTENT_VALUES,
  inspectSerenityIntent,
  PER_CALL_MS,
} from './intent-taxonomy.js';

/**
 * CloudWatch namespace for Serenity write-path intent-classification metrics
 * (serenity-docs#32 Observability). Mirrors the `Mysticat/Brands` convention in
 * `src/controllers/brands.js`.
 */
const SERENITY_METRICS_NAMESPACE = 'Mysticat/Serenity';

// Cap on the number of soft-failure reasoning samples logged per request, so a
// low-confidence storm produces one bounded structured line, not a log flood.
const SOFT_FAILURE_LOG_CAP = 10;

/**
 * Nearest-rank percentile of a NON-EMPTY ascending-sorted numeric array. Used for
 * per-call latency p50/p95 without pulling in a stats dep; the sole caller only
 * invokes it once at least one call has been timed.
 *
 * @param {number[]} sortedAsc - non-empty values sorted ascending.
 * @param {number} p - percentile in [0, 100].
 * @returns {number}
 */
function percentile(sortedAsc, p) {
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank));
  return sortedAsc[idx];
}

/**
 * Best-effort EMF emit for a single Serenity intent-classification metric. Wraps
 * {@link emitMetric} (which already swallows its own errors) in an extra
 * try/catch — belt-and-suspenders matching the `emitBrandDemotionBlocked`
 * pattern in `brands.js` — so instrumentation can never throw into the classify
 * path.
 *
 * @param {string} name - CloudWatch metric name.
 * @param {number} value - metric value.
 * @param {string} unit - CloudWatch unit ('Count', 'Milliseconds', ...).
 * @param {object} dimensions - dimension key/value pairs (null values dropped).
 * @param {object} env - environment (for {@link resolveEnvironment}).
 */
function emitIntentMetric(name, value, unit, dimensions, env) {
  try {
    emitMetric(
      {
        name, value, unit, dimensions,
      },
      { environment: resolveEnvironment(env), namespace: SERENITY_METRICS_NAMESPACE },
    );
  } catch {
    // best-effort: metric emission must never affect the classify path
  }
}

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
 * Emits best-effort observability (serenity-docs#32) — outcome counters,
 * value distribution, per-call/batch latency, timeout/`budget_skipped` and
 * `prod_llm_unavailable` — via EMF, dimensioned by `writePath` (and workspace on
 * the outcome counters). All emission is best-effort and never throws into the
 * classify path; the classify/retry/default decision logic is unchanged.
 *
 * @param {string[]} texts - prompt texts to classify (deduplicated internally).
 * @param {object} options
 * @param {object} [options.env] - environment (Azure OpenAI creds).
 * @param {object} [options.log] - logger.
 * @param {number} options.deadline - the request's write deadline (epoch ms).
 * @param {string} [options.writePath] - which write-path this call serves, for
 *   the metric `WritePath` dimension: `'create' | 'edit' | 'csv' | 'ai-gen'`.
 * @param {string} [options.workspaceId] - the Semrush workspace id, used as the
 *   per-customer `Workspace` dimension on the outcome counters so one catalog's
 *   degradation isn't hidden under a healthy aggregate.
 * @returns {Promise<Map<string, string>>} text -> `intent:<Value>` wire tag.
 */
export async function classifyPromptIntents(texts, {
  env, log = console, deadline, writePath = 'unknown', workspaceId,
}) {
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
    classified_ok: 0,
    low_confidence: 0,
    retry_attempted: 0,
    retry_succeeded: 0,
    defaulted: 0,
    budget_skipped: 0,
  };
  // Distribution of the emitted classified wire tags (excludes `defaulted`,
  // which is reported as its own bucket). Keyed by wire tag.
  const valueCounts = Object.create(null);
  // Per-call LLM latencies (ms) and a heuristic per-call timeout tally.
  const callDurations = [];
  let callTimeouts = 0;
  let batchStart = 0;
  // Truncated soft-failure reasoning samples for one bounded structured log line.
  const softFailures = [];

  const defaultAll = (list) => {
    list.forEach((t) => result.set(t, INTENT_TAG.INFORMATIONAL));
    counts.defaulted += list.length;
  };

  const resolve = (t, value, ok) => {
    result.set(t, value);
    counts[ok] += 1;
    valueCounts[value] = (valueCounts[value] || 0) + 1;
  };

  // Emit all per-request EMF metrics from the current counters/timings. Called
  // on every terminal path so the classified-vs-fallback ratio is always
  // derivable. Best-effort: each emit is individually wrapped.
  const emitObservability = () => {
    const outcomeDims = { WritePath: writePath, Workspace: workspaceId };
    Object.entries(counts).forEach(([outcome, count]) => {
      if (count > 0) {
        emitIntentMetric('IntentOutcome', count, 'Count', { ...outcomeDims, Outcome: outcome }, safeEnv);
      }
    });
    SERENITY_INTENT_VALUES.forEach((word) => {
      const tag = tagFor(TAG_DIMENSION.INTENT, word);
      const c = valueCounts[tag] || 0;
      if (c > 0) {
        emitIntentMetric('IntentValueDistribution', c, 'Count', { WritePath: writePath, Value: word }, safeEnv);
      }
    });
    if (counts.defaulted > 0) {
      emitIntentMetric('IntentValueDistribution', counts.defaulted, 'Count', { WritePath: writePath, Value: 'defaulted' }, safeEnv);
    }
    if (callDurations.length > 0) {
      const sorted = [...callDurations].sort((a, b) => a - b);
      emitIntentMetric('PerCallLatencyP50Ms', percentile(sorted, 50), 'Milliseconds', { WritePath: writePath }, safeEnv);
      emitIntentMetric('PerCallLatencyP95Ms', percentile(sorted, 95), 'Milliseconds', { WritePath: writePath }, safeEnv);
      if (callTimeouts > 0) {
        emitIntentMetric('PerCallTimeout', callTimeouts, 'Count', { WritePath: writePath }, safeEnv);
      }
    }
    if (batchStart > 0) {
      emitIntentMetric('ClassifyBatchDurationMs', Date.now() - batchStart, 'Milliseconds', { WritePath: writePath }, safeEnv);
    }
  };

  const emitProdLlmUnavailable = (message) => {
    emitIntentMetric('ProdLlmUnavailable', 1, 'Count', { WritePath: writePath }, safeEnv);
    safeLog?.warn?.(`WARN: prod_llm_unavailable — ${message}`);
  };

  if (remainingClassifyBudget(deadline) < PER_CALL_MS) {
    counts.budget_skipped = unique.length;
    defaultAll(unique);
    safeLog?.info?.('serenity intent classification: budget_skipped (no room at entry)', { count: unique.length });
    emitObservability();
    return result;
  }

  // Per-request category spec: wraps the taxonomy's `inspectSerenityIntent` so
  // the caller can count `low_confidence` soft-failures apart from other
  // unresolved cases and capture their `reasoning`, while still returning the
  // same `string|null` tag the retry/default ladder expects (behavior unchanged).
  const observedSpec = {
    systemPrompt: SERENITY_INTENT_CATEGORY_SPEC.systemPrompt,
    invokeTimeoutMs: SERENITY_INTENT_CATEGORY_SPEC.invokeTimeoutMs,
    parseResult: (parsed) => {
      const { tag, reason, reasoning } = inspectSerenityIntent(parsed);
      if (reason !== 'ok') {
        if (reason === 'low_confidence') {
          counts.low_confidence += 1;
        }
        if (softFailures.length < SOFT_FAILURE_LOG_CAP) {
          softFailures.push({ reason, reasoning: String(reasoning || '').slice(0, 200) });
        }
      }
      return tag;
    },
  };

  const classify = createIntentClassifier(
    { env: safeEnv, log: safeLog },
    observedSpec,
  );
  if (typeof classify !== 'function') {
    defaultAll(unique);
    const message = 'serenity intent classification: Azure OpenAI is not configured; defaulting to Informational';
    if (resolveEnvironment(safeEnv) === 'prod') {
      emitProdLlmUnavailable(message);
    } else {
      safeLog?.info?.(message);
    }
    emitObservability();
    return result;
  }

  // Wrap the single-text classifier to record per-call latency (and a heuristic
  // per-call timeout: a null result that took ~the full per-call budget). The
  // classifier itself is best-effort and never rejects; the try/finally is
  // defensive so timing is recorded even if that contract ever changes.
  const timedClassify = async (text) => {
    const t0 = Date.now();
    let r = null;
    try {
      r = await classify(text);
      return r;
    } finally {
      const dt = Date.now() - t0;
      callDurations.push(dt);
      if (r === null && dt >= PER_CALL_MS) {
        callTimeouts += 1;
      }
    }
  };

  batchStart = Date.now();
  const firstPass = await classifyIntents(timedClassify, unique, {
    maxConcurrency: CLASSIFY_CONCURRENCY,
    timeoutMs: remainingClassifyBudget(deadline),
  });
  const stillUnresolved = [];
  unique.forEach((t) => {
    const value = firstPass.get(t);
    if (value) {
      resolve(t, value, 'classified_ok');
    } else {
      stillUnresolved.push(t);
    }
  });

  if (stillUnresolved.length > 0 && remainingClassifyBudget(deadline) >= PER_CALL_MS) {
    counts.retry_attempted = stillUnresolved.length;
    const retryPass = await classifyIntents(timedClassify, stillUnresolved, {
      maxConcurrency: CLASSIFY_CONCURRENCY,
      timeoutMs: remainingClassifyBudget(deadline),
    });
    const stillUnresolvedAfterRetry = [];
    stillUnresolved.forEach((t) => {
      const value = retryPass.get(t);
      if (value) {
        resolve(t, value, 'retry_succeeded');
      } else {
        stillUnresolvedAfterRetry.push(t);
      }
    });
    defaultAll(stillUnresolvedAfterRetry);
  } else {
    defaultAll(stillUnresolved);
  }

  // Repeated-invoke-failure signal (serenity-docs#32): calls were actually made
  // (the classifier was constructed) but not a single one resolved — the LLM is
  // effectively unavailable, distinct from `budget_skipped` where no call runs.
  if (callDurations.length > 0
    && counts.classified_ok + counts.retry_succeeded === 0
    && resolveEnvironment(safeEnv) === 'prod') {
    emitProdLlmUnavailable('running on prod but the intent LLM returned no classifications for any prompt; prompts are being assigned the Informational default, not classified');
  }

  if (softFailures.length > 0) {
    safeLog?.info?.('serenity intent classification soft failures', {
      low_confidence: counts.low_confidence,
      samples: softFailures,
    });
  }
  safeLog?.info?.('serenity intent classification summary', counts);
  emitObservability();
  return result;
}
