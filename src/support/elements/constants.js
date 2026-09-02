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

export const DEFAULT_ELEMENT_MODEL = 'search-gpt';

/**
 * Semrush's Elements API tag encoding: `prefix__value`, with `__` also used for
 * `parent__child` nesting within the value. A tag's wire form is its `__`-joined
 * PATH, so the leading segment is the name of its ROOT tag — which is why renaming
 * a dimension root renames every one of its tags on this surface.
 *
 * This replaced an earlier `prefix:value` encoding (colon-delimited, `Parent__Child`
 * nesting only within the value). The cutover was a one-time, atomic migration on
 * Semrush's side — all workspaces/customers moved to `__` together, so there is no
 * dual-format transition period and nothing parses both encodings.
 */
export const SEP = '__';

/**
 * Sentinel platform/model value meaning "all platforms" — no single-model filter.
 * Mirrors the UI's `PLATFORM_CODES.All` ('all'), the same "no filter" convention the
 * category/region dimensions already use. Elements that support it OMIT the `CBF_model`
 * filter for this value, returning the deduped cross-model union.
 */
export const ALL_PLATFORMS = 'all';

/**
 * True when `value` is the {@link ALL_PLATFORMS} sentinel (case-insensitive, whitespace
 * trimmed — matching the sibling `'all'`-sentinel helpers `SKIP_VALUES` in
 * `llmo-brand-presence.js` and `normalizeEngineFromQuery`). Callers MUST check this
 * BEFORE {@link resolveElementModel}, which would otherwise coerce `'all'` to
 * {@link DEFAULT_ELEMENT_MODEL} (it is not a valid Semrush model).
 *
 * @param {string} [value] - Raw value from the `model` or `platform` query param.
 * @returns {boolean}
 */
export function isAllPlatforms(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === ALL_PLATFORMS;
}

/**
 * True when a brand-presence model/platform filter should aggregate across ALL of the
 * brand's models rather than scope to a single one — i.e. the value is ABSENT (empty /
 * non-string) OR the explicit {@link ALL_PLATFORMS} sentinel. When true, the affected
 * brand-presence element payloads OMIT the `CBF_model` filter, so Semrush returns the
 * deduped cross-model aggregate across whatever models produced data (the brand's enabled
 * models) — LLMO-7093.
 *
 * Distinct from {@link isAllPlatforms}, which matches ONLY the literal `'all'` string: this
 * ALSO treats the absent value as "all models". The Serenity "All Platforms" UI omits the
 * `platform` query param entirely (project-elmo-ui#2888), so for these endpoints "no
 * platform" means "all platforms" — NOT the {@link DEFAULT_ELEMENT_MODEL} single-model
 * default that {@link resolveElementModel} would otherwise apply. (The `url-prompts`
 * endpoint deliberately keeps the `absent → default model` behaviour and uses the plain
 * {@link isAllPlatforms} check instead; only the brand-presence family opts into
 * `absent → aggregate`.)
 *
 * @param {string} [value] - Raw value from the `model` or `platform` query param.
 * @returns {boolean}
 */
export function isAllModelsFilter(value) {
  return typeof value !== 'string' || value.trim().length === 0 || isAllPlatforms(value);
}

export const ELEMENT_MODELS = Object.freeze([
  'google-ai-mode',
  'grok-3',
  'google-ai-overview',
  'microsoft-copilot',
  'open-evidence',
  'gemini-2.5-flash',
  'claude-sonnet-4',
  'gpt-5',
  'deepseek',
  'search-gpt',
  'perplexity',
  'chatgpt-paid',
]);

/**
 * Maps the UI's platform filter codes (project-elmo-ui `PLATFORM_CODES`) to the
 * Semrush Elements model names in {@link ELEMENT_MODELS}. Vivek/UI confirmed the UI
 * keeps sending its existing platform values, so the translation lives here on the
 * SpaceCat side.
 *
 * Only entries whose names DIFFER are listed. Codes that are already identical to a
 * Semrush model (`google-ai-overview`, `google-ai-mode`, `perplexity`, `deepseek`)
 * and any Semrush-only model with no UI counterpart (`open-evidence`) need no
 * entry — {@link resolveElementModel} passes them through unchanged.
 */
export const PLATFORM_TO_ELEMENT_MODEL = Object.freeze({
  copilot: 'microsoft-copilot',
  gemini: 'gemini-2.5-flash',
  openai: 'chatgpt-paid',
  chatgpt: 'search-gpt',
  grok: 'grok-3',
  anthropic: 'claude-sonnet-4',
});

/**
 * Resolves a requested platform/model value to a valid Semrush Elements model.
 * Applies the UI→Semrush translation first, then respects any value that is already
 * a valid Semrush model, and finally falls back to {@link DEFAULT_ELEMENT_MODEL}.
 *
 * @param {string} [value] - Raw value from the `model` or `platform` query param.
 * @returns {string} A member of {@link ELEMENT_MODELS}.
 */
/* c8 ignore start -- LLMO-6011 POC endpoint; unit tests intentionally deferred */
export function resolveElementModel(value) {
  const mapped = PLATFORM_TO_ELEMENT_MODEL[value] ?? value;
  return ELEMENT_MODELS.includes(mapped) ? mapped : DEFAULT_ELEMENT_MODEL;
}
/* c8 ignore stop */

/**
 * Builds the single-model `CBF_model` advanced filter for a brand-presence element, or
 * returns `null` when the request is an all-models aggregate ({@link isAllModelsFilter} —
 * param absent or the `'all'` sentinel), so the caller simply omits the filter and Semrush
 * aggregates across every model the brand has data for (LLMO-7093). Centralises the
 * `absent/'all' → omit, else resolve-and-scope` branch shared by the brand-presence family
 * (stats, kpi-headlines, market-tracking-trends, sentiment-overview).
 *
 * @param {string} [requestedModel] - Raw model/platform value (callers pass `model || platform`).
 * @param {object} [opts]
 * @param {boolean} [opts.wrap=true] - Wrap the `eq` in a one-member `or` block (the shape most
 *   elements use); pass `false` for the bare-`eq` elements (stats mentions/citations).
 * @returns {object|null} The `CBF_model` filter node, or `null` for the aggregate case.
 */
export function buildModelFilter(requestedModel, { wrap = true } = {}) {
  if (isAllModelsFilter(requestedModel)) {
    return null;
  }
  const eq = { op: 'eq', val: resolveElementModel(requestedModel), col: 'CBF_model' };
  return wrap ? { op: 'or', filters: [eq] } : eq;
}

/**
 * Builds the `filters.advanced` fragment of an Elements payload, OMITTING the key entirely
 * when there is nothing to filter on. Spread into the `filters` object by the caller.
 *
 * Semrush REJECTS an empty AND block: `advanced: { op: 'and', filters: [] }` returns
 * HTTP 422 `{"message":"request could not be processed"}` — it does NOT treat it as the
 * vacuously-true "match all". Dropping the key instead returns the unfiltered result.
 *
 * Verified live 2026-09-02 (brand "Asian Paints", sub-workspace c8feffff-6e58-41db-b804-
 * 5652033dd292, 2026-08-04→2026-09-02) against all three elements that can reach the
 * empty case — SENTIMENT (f4153af8), TRENDS_MV (b5281393) and MARKET_CITATIONS_TREND
 * (2e5a6f4e): empty AND → 422 on every one, key omitted → 200 on every one. The 422 is
 * caused by the empty AND itself, not by a missing required filter — an `advanced` block
 * carrying only `CBF_model` (no `CBF_project`) returns 200.
 *
 * This case is reachable in production: the Overview-SR sentiment card requests
 * "all platforms" with no region and no category, which leaves every optional filter
 * unset (LLMO-7093).
 *
 * @param {object[]} [filters] - Advanced filter nodes; empty/absent → `{}`.
 * @returns {{ advanced?: object }} Fragment to spread into `filters`.
 */
export function buildAdvancedFilters(filters) {
  return Array.isArray(filters) && filters.length > 0
    ? { advanced: { op: 'and', filters } }
    : {};
}
