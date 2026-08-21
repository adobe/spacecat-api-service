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
import { withTimeout, contentToString } from './llm-utils.js';

/**
 * On-demand translator for AI-generated suggestion prose (currently `aiRationale`).
 *
 * Audit workers write `suggestion.data.aiRationale` in English only and never populate
 * `suggestion.data.i18n[locale]` (the map `SuggestionDto.toJSON` promotes fields from — see
 * `ALLOWED_I18N_FIELDS` in `dto/suggestion.js`). Rather than requiring every audit worker to
 * generate per-locale text, this translates on first non-English read; the caller persists the
 * result into `suggestion.data.i18n[locale].aiRationale` so subsequent reads for that
 * suggestion + locale are served from the stored translation with no further LLM call.
 *
 * Best-effort / non-fatal, mirroring `intent-classifier.js`: any failure (no client configured,
 * LLM error, timeout) resolves to `null` so the caller falls back to the untranslated English
 * text `SuggestionDto` already returns.
 */

// Human-readable language names for the locale codes project-elmo-ui ships translations for
// (underscore form, matches isValidLocale). Unlisted codes fall back to the raw code so
// translation still works for a locale added later without a code change here.
const LOCALE_LANGUAGE_NAMES = {
  fr_fr: 'French',
  de_de: 'German',
  es_es: 'Spanish',
  it_it: 'Italian',
  pt_br: 'Brazilian Portuguese',
  ja_jp: 'Japanese',
  ko_kr: 'Korean',
  zh_cn: 'Simplified Chinese',
  zh_tw: 'Traditional Chinese',
};

const DEFAULT_INVOKE_TIMEOUT_MS = 10000;
// Intentionally shorter than DEFAULT_INVOKE_TIMEOUT_MS: the batch cap bounds how long the
// suggestions read path waits overall, not how long any individual call is allowed to run. A
// call already in flight when the batch cap fires may still resolve up to
// DEFAULT_INVOKE_TIMEOUT_MS later — the `stopped` flag in ensureAiRationaleTranslations ensures
// such a late result is discarded rather than persisted after this function (and the HTTP
// response it gates) has already returned.
const DEFAULT_BATCH_TIMEOUT_MS = 8000;
const DEFAULT_MAX_CONCURRENCY = 5;
// aiRationale is a one-to-few-sentence rationale; a few hundred tokens comfortably covers a
// translation (even into a more verbose target language) with headroom, while still bounding
// cost/latency per call for text that ultimately traces back to an untrusted broken URL.
const MAX_TRANSLATION_OUTPUT_TOKENS = 500;

function resolveInvokeTimeoutMs(env = {}) {
  const raw = Number(env.SUGGESTION_TRANSLATION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INVOKE_TIMEOUT_MS;
}

/**
 * Resolves the wall-clock cap (ms) for a whole translation batch from env, falling back to the
 * default. Non-numeric / non-positive values fall back to the default.
 *
 * @param {object} env - Environment variables
 * @returns {number} timeout in milliseconds
 */
export function resolveBatchTimeoutMs(env = {}) {
  const raw = Number(env.SUGGESTION_TRANSLATION_BATCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BATCH_TIMEOUT_MS;
}

// Allows a translation-scoped deployment override, else reuses the shared per-env deployment
// (mirrors resolveDeploymentName in intent-classifier.js).
function resolveDeploymentName(env = {}) {
  return env.SUGGESTION_TRANSLATION_DEPLOYMENT_NAME
    || env.AZURE_OPEN_AI_API_DEPLOYMENT_NAME;
}

/**
 * Creates a translator bound to the Azure OpenAI credentials in `env` (the same
 * `AZURE_OPEN_AI_*` credentials already used by `intent-classifier.js` / `OrgDetectorAgent`).
 *
 * Returns a function `translate(text, targetLocale) => Promise<string|null>` that is always
 * best-effort: it resolves to the translated text on success, or `null` on any failure or when
 * text/credentials are missing. It NEVER rejects.
 *
 * @param {object} context - Helix universal context
 * @param {object} context.env - Environment variables (Azure OpenAI creds)
 * @param {object} [context.log] - Logger
 * @returns {((text: string, targetLocale: string) => Promise<string|null>)|null}
 */
export function createSuggestionTranslator(context = {}) {
  const { env = {}, log = console } = context;

  const {
    AZURE_OPEN_AI_API_KEY: azureOpenAIApiKey,
    AZURE_OPEN_AI_API_INSTANCE_NAME: azureOpenAIApiInstanceName,
    AZURE_OPEN_AI_API_VERSION: azureOpenAIApiVersion,
  } = env;
  const azureOpenAIApiDeploymentName = resolveDeploymentName(env);

  if (!hasText(azureOpenAIApiKey)
    || !hasText(azureOpenAIApiInstanceName)
    || !hasText(azureOpenAIApiDeploymentName)) {
    log.info('Suggestion translation skipped: Azure OpenAI is not configured (falling back to English)');
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
      maxTokens: MAX_TRANSLATION_OUTPUT_TOKENS,
    });
  } catch (e) {
    log.warn(`Failed to construct suggestion translator model; skipping translation: ${e.message}`);
    return null;
  }

  const invokeTimeoutMs = resolveInvokeTimeoutMs(env);

  return async function translate(text, targetLocale) {
    const trimmed = hasText(text) ? text.trim() : '';
    if (trimmed.length === 0) {
      return null;
    }
    // Reject rather than fall through to the raw locale code: an unmapped code (including
    // `en_us`, which the `xx_yy` format validator accepts) would otherwise be sent straight into
    // the prompt, wasting a call and risking garbled/untranslated text overwriting the original.
    // Also closes off a prompt-injection surface if the upstream locale regex is ever relaxed.
    const languageName = LOCALE_LANGUAGE_NAMES[targetLocale];
    if (!languageName) {
      return null;
    }
    try {
      const response = await withTimeout(
        model.invoke([
          {
            role: 'system',
            content: `Translate the user's text into ${languageName}. Reply with ONLY the translated text — no quotes, no explanation, no markdown — and preserve any URLs verbatim.`,
          },
          { role: 'user', content: trimmed },
        ]),
        invokeTimeoutMs,
        'suggestion translation',
      );
      const translated = contentToString(response?.content).trim();
      return hasText(translated) ? translated : null;
    } catch (e) {
      log.warn(`Suggestion translation failed for locale ${targetLocale}; falling back to English: ${e.message}`);
      return null;
    }
  };
}

/**
 * Ensures every suggestion with an English `data.aiRationale` also has a
 * `data.i18n[locale].aiRationale` translation, translating and persisting any that are missing
 * one. Mutates and saves matching suggestion entities in-place; entities that already have a
 * translation, have no `aiRationale`, or fail to translate/save are left untouched (`SuggestionDto`
 * falls back to English for those).
 *
 * `createTranslator` is only invoked once at least one suggestion actually needs translating, so
 * callers can pass it unconditionally (e.g. `() => createSuggestionTranslator(context)`) without
 * paying for client construction on every request — most opportunity types never have an
 * `aiRationale` at all.
 *
 * Best-effort and bounded: runs with bounded concurrency under an overall wall-clock cap so a
 * slow/unavailable LLM cannot stall the suggestions read path. Once the cap is hit, no further
 * writes happen — any suggestion whose translation hasn't already been persisted by then stays
 * untranslated for this request and is retried on the next one. (The cap can't cancel an
 * in-flight LLM call itself, only stop this function from acting on it once it resolves.)
 *
 * @param {(() => (((text: string, targetLocale: string) => Promise<string|null>)|null))}
 *   createTranslator - Lazily builds a translator, e.g. `() => createSuggestionTranslator(ctx)`.
 * @param {object[]} suggestions - Suggestion entities (mutated in-place).
 * @param {string} locale - Target locale, e.g. 'ja_jp'.
 * @param {object} [options]
 * @param {number} [options.maxConcurrency] - Max in-flight LLM calls.
 * @param {number} [options.timeoutMs] - Total wall-clock cap for the batch.
 * @param {object} [options.log] - Logger; used to surface persistence failures to operators.
 * @returns {Promise<void>}
 */
export async function ensureAiRationaleTranslations(
  createTranslator,
  suggestions,
  locale,
  {
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    timeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
    log = console,
  } = {},
) {
  if (typeof createTranslator !== 'function' || !hasText(locale)) {
    return;
  }

  const pending = (suggestions || []).filter((s) => {
    const data = s.getData?.();
    return hasText(data?.aiRationale) && !hasText(data?.i18n?.[locale]?.aiRationale);
  });
  if (pending.length === 0) {
    return;
  }

  const translate = createTranslator();
  if (typeof translate !== 'function') {
    return;
  }

  let cursor = 0;
  // Flipped once the batch cap fires. Doesn't stop an in-flight translate() call (it can't be
  // cancelled), but every worker checks this before writing so nothing persists after the cap —
  // otherwise a call that resolves just past the cap would still call suggestion.save() after
  // this function (and the HTTP response it gates) has already returned.
  let stopped = false;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) {
        return;
      }
      const suggestion = pending[index];
      const data = suggestion.getData();
      // eslint-disable-next-line no-await-in-loop
      const translated = await translate(data.aiRationale, locale).catch(() => null);
      if (!stopped && hasText(translated)) {
        // Re-read rather than reuse the pre-await `data` snapshot: it narrows (doesn't
        // eliminate) the window in which a concurrent request translating this same
        // suggestion into a different locale could have its own setData/save overwritten by
        // this one replaying a stale i18n map from before the LLM call.
        const freshData = suggestion.getData();
        suggestion.setData({
          ...freshData,
          i18n: {
            ...freshData.i18n,
            [locale]: { ...freshData.i18n?.[locale], aiRationale: translated },
          },
        });
        try {
          // Cache-for-next-time write. On failure the translation still applies to this
          // response (setData already mutated the in-memory entity above).
          // eslint-disable-next-line no-await-in-loop
          await suggestion.save();
        } catch (e) {
          // Best-effort persist — but a silent failure here is invisible cost amplification:
          // every future request would re-translate via LLM with no signal to operators.
          log.warn(`Failed to persist translated aiRationale for suggestion ${suggestion.getId?.() ?? 'unknown'} (locale ${locale}): ${e.message}`);
        }
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(maxConcurrency, pending.length) },
    () => worker(),
  );
  const all = Promise.all(workers);

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    let timer;
    const cap = new Promise((resolve) => {
      timer = setTimeout(() => {
        stopped = true;
        cursor = pending.length; // stop workers from starting new calls after the cap
        resolve();
      }, timeoutMs);
    });
    await Promise.race([all, cap]).finally(() => clearTimeout(timer));
  } else {
    await all;
  }
}
