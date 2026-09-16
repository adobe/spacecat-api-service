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
import { inspectTopicCategory, buildCategorySystemPrompt, PER_CALL_MS } from './category-taxonomy.js';

/**
 * Onboarding-topic → existing-category classification (adobe/serenity-docs#44).
 * Structurally mirrors `classifyPromptIntents` (`intent-classification.js`):
 * same shared write-budget, same Azure-OpenAI-via-`createIntentClassifier`
 * plumbing, same fail-open contract on any soft failure — but keyed on TOPIC
 * text (at most `MAX_TOPICS_ON_CREATE` = 5 per onboarding run, not the up-to-
 * `AI_GEN_CLASSIFY_MAX` (16) prompt texts `intent` classifies), and against a
 * PER-CALL candidate set (the brand's existing top-level categories) rather
 * than a fixed taxonomy — see `category-taxonomy.js`.
 *
 * A brand with no existing categories (`categoryNames` empty) is a no-op: there
 * is nothing to match against, so every topic is left uncategorized without a
 * single LLM call — unchanged from today's behavior (plan §0).
 *
 * Every input topic is guaranteed a `Map` entry — `null` for "leave
 * uncategorized" (whether that is because of a budget/config skip, a timeout,
 * an explicit `NO_MATCH`, a below-confidence-floor match, or a hallucinated
 * name outside the candidate set), or the matched candidate name (a member of
 * `categoryNames`) for a confident match. Callers never need a separate
 * "was this even attempted" branch.
 *
 * @param {string[]} topics - topic texts to classify (deduplicated internally).
 * @param {readonly string[]} categoryNames - the brand's existing top-level
 *   `category` children (bare names). Empty ⇒ immediate no-op.
 * @param {object} options
 * @param {object} [options.env] - environment (Azure OpenAI creds).
 * @param {object} [options.log] - logger.
 * @param {number} [options.deadline] - the request's shared write deadline
 *   (epoch ms) — the SAME deadline `classifyPromptIntents` is called with for
 *   this onboarding run, so category classification draws from the remaining
 *   budget after intent classification has already run.
 * @param {string} [options.writePath] - metric `WritePath` dimension, mirrors
 *   `classifyPromptIntents` (`'ai-gen'` for this call site).
 * @param {string} [options.workspaceId] - the Semrush workspace id, for the
 *   per-customer `Workspace` metric dimension.
 * @returns {Promise<Map<string, string|null>>} topic text -> matched existing
 *   category name, or null.
 */
export async function classifyTopicCategories(topics, categoryNames, {
  env, log = console, deadline, writePath = 'unknown', workspaceId,
} = {}) {
  const safeEnv = env || {};
  const safeLog = log || console;
  const unique = [...new Set((topics || []).filter((t) => typeof t === 'string' && t.length > 0))];
  const result = new Map();
  if (unique.length === 0) {
    return result;
  }

  const names = [...new Set((categoryNames || []).filter((n) => typeof n === 'string' && n.length > 0))];
  const defaultAll = (list) => list.forEach((t) => result.set(t, null));
  if (names.length === 0) {
    defaultAll(unique);
    return result;
  }

  const counts = {
    classified_ok: 0,
    no_match: 0,
    low_confidence: 0,
    invalid_value: 0,
    defaulted: 0,
    budget_skipped: 0,
  };
  const softFailures = [];

  const emitObservability = () => {
    const dims = { WritePath: writePath, Workspace: workspaceId };
    Object.entries(counts).forEach(([outcome, count]) => {
      if (count > 0) {
        try {
          emitMetric(
            {
              name: 'CategoryOutcome', value: count, unit: 'Count', dimensions: { ...dims, Outcome: outcome },
            },
            { environment: resolveEnvironment(safeEnv), namespace: 'Mysticat/Serenity' },
          );
        } catch {
          // best-effort: metric emission must never affect the classify path
        }
      }
    });
  };

  // Hard skip-gate — mirrors `classifyPromptIntents`: no room for even one call
  // at entry, default everything without attempting a call.
  if (((deadline ?? NaN) - Date.now()) < PER_CALL_MS) {
    counts.budget_skipped = unique.length;
    defaultAll(unique);
    safeLog?.info?.('serenity category classification: budget_skipped (no room at entry)', { count: unique.length });
    emitObservability();
    return result;
  }

  const observedSpec = {
    systemPrompt: buildCategorySystemPrompt(names),
    invokeTimeoutMs: PER_CALL_MS,
    parseResult: (parsed) => {
      const { value, reason, reasoning } = inspectTopicCategory(parsed, names);
      if (reason !== 'ok') {
        counts[reason] = (counts[reason] || 0) + 1;
        if (softFailures.length < 10) {
          softFailures.push({ reason, reasoning: String(reasoning || '').slice(0, 200) });
        }
      }
      return value;
    },
  };

  const classify = createIntentClassifier({ env: safeEnv, log: safeLog }, observedSpec);
  if (typeof classify !== 'function') {
    defaultAll(unique);
    safeLog?.info?.('serenity category classification: Azure OpenAI is not configured; leaving topics uncategorized');
    emitObservability();
    return result;
  }

  const firstPass = await classifyIntents(classify, unique, {
    maxConcurrency: unique.length,
    timeoutMs: Math.max(0, (deadline ?? NaN) - Date.now()),
  });
  unique.forEach((t) => {
    const value = firstPass.get(t);
    if (value) {
      result.set(t, value);
      counts.classified_ok += 1;
    } else {
      result.set(t, null);
      counts.defaulted += 1;
    }
  });

  if (softFailures.length > 0) {
    safeLog?.info?.('serenity category classification soft failures', {
      no_match: counts.no_match,
      low_confidence: counts.low_confidence,
      invalid_value: counts.invalid_value,
      samples: softFailures,
    });
  }
  safeLog?.info?.('serenity category classification summary', counts);
  emitObservability();
  return result;
}
