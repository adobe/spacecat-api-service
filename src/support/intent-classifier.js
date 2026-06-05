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
import { AzureChatOpenAI } from '@langchain/openai';
import { hasText } from '@adobe/spacecat-shared-utils';

import { normalizeIntent } from './intent.js';

/**
 * LLM-backed classifier that buckets a human-added prompt's text into one of the
 * 6 canonical intent categories persisted in `prompts.intent`.
 *
 * This is the Node mirror of the DRS `UserIntentClassifier`
 * (llmo-data-retrieval-service/src/pipelines/brand_presence/fargate/
 * user_intent_classifier.py): identical bucket semantics, temperature 0, and a
 * strict JSON `{intent, confidence, reasoning}` output. It exists to fill the
 * gap left by the persist-on-upsert change (PR #2562): pipeline prompts arrive
 * WITH an intent (DRS forwards it), but human-added prompts arrive WITHOUT one
 * and would otherwise stay NULL forever.
 *
 * Design contract:
 * - Best-effort / non-fatal. Any failure (no client configured, LLM error,
 *   timeout, malformed JSON, invalid bucket) resolves to `null` — the caller
 *   persists NULL and the existing backfill/reconciliation path covers it
 *   later. Classification MUST NEVER throw into a prompt create/update.
 * - Reuses the Azure OpenAI credentials already wired for OrgDetectorAgent
 *   (`AZURE_OPEN_AI_*` env vars). No new secrets are introduced.
 */

// Mirrors DRS UserIntentClassifier.SYSTEM_PROMPT verbatim so bucket semantics
// stay identical across the Python pipeline and this Node write-path.
export const SYSTEM_PROMPT = `You are a user intent classifier for AI assistant queries. Classify the given prompt into exactly one of 6 categories.

The prompt may be in any language (English, Portuguese, German, Spanish, etc.). Classify based on meaning, not language.

Categories:

1. **informational** - The user wants to KNOW, UNDERSTAND, or DISCOVER something — including finding tools or getting recommendations.
   Signals: "what is", "what are", "how does", "tell me about", "best X", "top X", "which X", "tool that does X", "alternative to X", "what's the easiest way to"
   Examples: "What is Adobe Firefly?", "Best AI workspace tool", "Top PDF editors 2024", "Tool for summarizing documents", "Alternative to Notion AI", "What's the best way to edit a PDF on Mac?"
   Note: "Best X for Y" = informational (seeking a recommendation). "What tool does X?" = informational.

2. **comparative** - The user explicitly compares two or more NAMED options side-by-side.
   MUST include "vs", "versus", "compare", "difference between", or name two specific options directly.
   Examples: "Figma vs Sketch for UI design", "Compare Adobe Acrobat vs PDF Expert", "Which is better: Notion or Confluence?", "Differences between ChatGPT and Gemini"
   NOT comparative: "Best project management tools" (→ informational), "Top CMS platforms" (→ informational).

3. **transactional** - The user wants to BUY, DOWNLOAD, SIGN UP, or take a direct commercial action.
   Signals: "buy", "purchase", "pricing", "cost", "free trial", "download", "subscribe", "where can I get"
   Examples: "Adobe Creative Cloud pricing", "Free trial for Photoshop", "Download PDF editor free", "Where to buy Adobe licenses"

4. **planning** - The user wants step-by-step GUIDANCE to do something THEMSELVES. They perform the action; the AI provides instructions.
   Signals: "how to [action]", "steps to", "guide to", "instructions for", "process for", "checklist", "what do I need to"
   Examples: "How to edit a PDF on Mac?", "Steps to set up a glossary", "Guide to migrating a CMS", "How to use AI for document assistance"
   NOT planning: "Write me a guide" (→ instructional, AI produces the artifact). "What's X strategy?" (→ informational).

5. **instructional** - The user wants the AI to CREATE, PRODUCE, or PERFORM a specific task. The AI does the work on the user's behalf.
   Signals: "write", "create", "draft", "generate", "make me", "convert", "translate", "summarize", "edit this", "can AI [do X]"
   Examples: "Write a blog post about SEO", "Convert my PDF to Word", "Translate this video to English", "Summarize this document", "Can AI make me a reel?", "Create a marketing email template"
   Note: "Convert X to Y", "Translate X", "Summarize X" = instructional even without explicit "please" — the user is handing off a task.

6. **delegation** - The user wants the AI to RECOMMEND or DECIDE for them personally. They are handing over the decision.
   Signals: "can you recommend", "can you suggest", "what would you recommend", "advise me", "help me choose", "what's your opinion", "just tell me what to do"
   Examples: "Can you suggest a good AI art generator?", "Recommend the best option for me", "I need advice on choosing a dubbing tool", "What AI tool should I use for this?"
   Note: Delegation is a personal ask ("can YOU recommend…"), not a general lookup ("what is the best X?" → informational).

Decision rules:
- "Best X" or "Top X" WITHOUT naming two things = **informational**, not comparative.
- "Convert X", "Translate X", "Summarize X" = **instructional** (AI performs the transformation).
- "How to CREATE X using AI" = **planning** (user learns the process). "Create X for me" = **instructional** (AI does it).
- "Can you recommend X?" = **delegation**. "What is the best X?" = **informational**.
- "What's X's strategy?" or "Which strategies do Y?" = **informational**, not planning.
- Default to **informational** if ambiguous.

Output requirements (strict): Reply with ONLY valid JSON. Response is limited to ~150 tokens, so keep it short.
Output format: {"intent": "<category>", "confidence": 0.0-1.0, "reasoning": "<one brief sentence>"}
Do not include markdown, code fences, or any text outside the JSON object.`;

// Cap prompt text fed to the LLM (mirrors DRS prompt_text[:2000]).
const MAX_PROMPT_CHARS = 2000;
// Bound concurrent LLM calls so a bulk create (arrays up to 3000) does not fan
// out an unbounded number of in-flight requests.
const DEFAULT_MAX_CONCURRENCY = 10;
// Wall-clock cap (ms) on a single `model.invoke()`. A hung Azure call must not
// stall prompt creation: on timeout the classification is treated as a failure
// (intent stays null) and the write proceeds. Overridable via env so it can be
// tuned without a redeploy.
const DEFAULT_INVOKE_TIMEOUT_MS = 10000;

/**
 * Resolves the per-call LLM invoke timeout (ms) from env, falling back to the
 * default. Non-numeric / non-positive values fall back to the default so a
 * misconfigured env var can't disable the guard.
 *
 * @param {object} env - Environment variables
 * @returns {number} timeout in milliseconds
 */
function resolveInvokeTimeoutMs(env = {}) {
  const raw = Number(env.PROMPT_INTENT_CLASSIFICATION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INVOKE_TIMEOUT_MS;
}

/**
 * Races a promise against a timer. Rejects with a timeout error if `promise`
 * does not settle within `timeoutMs`. The timer is always cleared so the event
 * loop is not held open by a pending timeout once the race resolves.
 *
 * @param {Promise<*>} promise - Work to bound
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<*>} resolves/rejects with `promise`, or rejects on timeout
 */
function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`intent classification timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Coerces an LLM message `content` into a plain string. `AzureChatOpenAI`
 * `.invoke()` may return `content` as a string OR as an array of content parts
 * (`[{ type: 'text', text: '...' }, ...]`). Array content is concatenated from
 * its text parts so the downstream JSON parse sees the full model output rather
 * than silently failing on a non-string.
 *
 * @param {*} content - `response.content` from the model
 * @returns {string}
 */
export function contentToString(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        // LangChain text parts: { type: 'text', text: '...' }. Some providers
        // use `content` instead of `text`; accept either, ignore non-text parts.
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') {
            return part.text;
          }
          if (typeof part.content === 'string') {
            return part.content;
          }
        }
        return '';
      })
      .join('');
  }
  return String(content ?? '');
}

/**
 * Returns true when intent classification on write is enabled. Default-safe:
 * disabled unless `ENABLE_PROMPT_INTENT_CLASSIFICATION` is explicitly truthy,
 * so it can be turned on/off via config without a code change or redeploy.
 *
 * @param {object} env - Environment variables
 * @returns {boolean}
 */
export function isIntentClassificationEnabled(env = {}) {
  const flag = env.ENABLE_PROMPT_INTENT_CLASSIFICATION;
  return flag === true || flag === 'true' || flag === '1';
}

/**
 * Extracts a JSON object from a model response that may include code fences or
 * surrounding prose, then returns its normalized `intent` (or null).
 *
 * @param {string} content - Raw model output
 * @returns {string|null}
 */
function parseIntent(content) {
  if (!hasText(content)) {
    return null;
  }
  const trimmed = content.trim();
  // Strip ```json ... ``` fences if the model added them despite instructions,
  // else fall back to the first {...} block, else the trimmed content as-is.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = trimmed.match(/\{[\s\S]*\}/);
  let raw = trimmed;
  if (fenced) {
    [, raw] = fenced;
    raw = raw.trim();
  } else if (brace) {
    [raw] = brace;
  }
  try {
    const parsed = JSON.parse(raw);
    // normalizeIntent lowercases, applies the legacy remap, and validates
    // against the 6 canonical buckets (else null) — single source of truth.
    return normalizeIntent(parsed?.intent);
  } catch {
    return null;
  }
}

/**
 * Creates an intent classifier bound to the Azure OpenAI credentials in `env`.
 *
 * Returns a function `classify(text) => Promise<string|null>` that is always
 * best-effort: it resolves to a canonical bucket on success, or `null` on any
 * failure or when text/credentials are missing. It NEVER rejects.
 *
 * When classification is disabled by config or Azure credentials are absent,
 * returns `null` (no classifier) so callers can skip the work entirely and
 * persist NULL.
 *
 * @param {object} context - Helix universal context
 * @param {object} context.env - Environment variables (Azure creds + toggle)
 * @param {object} [context.log] - Logger
 * @returns {((text: string) => Promise<string|null>)|null}
 */
export function createIntentClassifier(context = {}) {
  const { env = {}, log = console } = context;

  if (!isIntentClassificationEnabled(env)) {
    return null;
  }

  const {
    AZURE_OPEN_AI_API_KEY: azureOpenAIApiKey,
    AZURE_OPEN_AI_API_INSTANCE_NAME: azureOpenAIApiInstanceName,
    AZURE_OPEN_AI_API_DEPLOYMENT_NAME: azureOpenAIApiDeploymentName,
    AZURE_OPEN_AI_API_VERSION: azureOpenAIApiVersion,
  } = env;

  if (!hasText(azureOpenAIApiKey)
    || !hasText(azureOpenAIApiInstanceName)
    || !hasText(azureOpenAIApiDeploymentName)) {
    log.info('Prompt intent classification enabled but Azure OpenAI is not configured; skipping (intent stays null)');
    return null;
  }

  let model;
  try {
    model = new AzureChatOpenAI({
      azureOpenAIApiKey,
      azureOpenAIApiInstanceName,
      azureOpenAIApiDeploymentName,
      azureOpenAIApiVersion,
      temperature: 0,
      maxTokens: 150,
      modelKwargs: { response_format: { type: 'json_object' } },
    });
  } catch (e) {
    log.warn(`Failed to construct intent classifier model; skipping classification: ${e.message}`);
    return null;
  }

  const invokeTimeoutMs = resolveInvokeTimeoutMs(env);

  return async function classify(text) {
    // Mirror DRS: skip empty / whitespace-only text (no LLM call, intent null).
    const trimmed = hasText(text) ? text.trim() : '';
    if (trimmed.length === 0) {
      return null;
    }
    try {
      // Bound the call: a hung Azure request must not stall prompt creation.
      // On timeout this rejects and falls through to the non-fatal catch below.
      const response = await withTimeout(
        model.invoke([
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: trimmed.slice(0, MAX_PROMPT_CHARS) },
        ]),
        invokeTimeoutMs,
      );
      // content may be a string OR an array of content parts; coerce either way.
      const content = contentToString(response?.content);
      return parseIntent(content);
    } catch (e) {
      log.warn(`Intent classification failed for prompt; persisting null: ${e.message}`);
      return null;
    }
  };
}

/**
 * Classifies a batch of distinct prompt texts with bounded concurrency, mapping
 * each text to a canonical bucket (or null). Deduplicates inputs so repeated
 * texts cost a single LLM call. Always resolves; never rejects.
 *
 * @param {((text: string) => Promise<string|null>)} classify - Single classifier
 * @param {string[]} texts - Prompt texts to classify
 * @param {object} [options]
 * @param {number} [options.maxConcurrency] - Max in-flight LLM calls
 * @returns {Promise<Map<string, string|null>>} text -> intent (or null)
 */
export async function classifyIntents(
  classify,
  texts,
  { maxConcurrency = DEFAULT_MAX_CONCURRENCY } = {},
) {
  const results = new Map();
  if (typeof classify !== 'function') {
    return results;
  }
  const unique = [...new Set((texts || []).filter(hasText))];
  if (unique.length === 0) {
    return results;
  }

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= unique.length) {
        return;
      }
      const text = unique[index];
      // classify() is already best-effort and never rejects, but guard anyway.
      // eslint-disable-next-line no-await-in-loop
      const intent = await classify(text).catch(() => null);
      results.set(text, intent);
    }
  };

  const workers = Array.from(
    { length: Math.min(maxConcurrency, unique.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
