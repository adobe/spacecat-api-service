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

/* eslint-disable max-statements-per-line -- filter walk helpers */

export const SR_AI_SEO_SUPPORTED_MARKET_CODES = [
  'AE', 'AR', 'AT', 'AU', 'BE', 'BR', 'CA', 'CH', 'CL', 'CO',
  'DE', 'DK', 'ES', 'FI', 'FR', 'HK', 'ID', 'IE', 'IL', 'IN',
  'IT', 'JP', 'KR', 'MX', 'MY', 'NL', 'NO', 'PA', 'PE', 'PH',
  'PL', 'SA', 'SE', 'SG', 'TH', 'TR', 'TW', 'UK', 'US', 'UY',
  'VN', 'ZA',
];

const SUPPORTED_MARKET = new Set(SR_AI_SEO_SUPPORTED_MARKET_CODES);

export const SR_VISIBILITY_MARKETS_CATALOG = ['WW', ...SR_AI_SEO_SUPPORTED_MARKET_CODES];

export const SR_VISIBILITY_MODELS_CATALOG = [
  'all', 'chatgpt', 'gemini', 'googleAiMode', 'googleAiOverview',
];

function sortUnique(xs) {
  return [...new Set(xs)].sort((a, b) => a.localeCompare(b));
}

export function normalizeMarketToken(raw) {
  const u = raw.trim().toUpperCase();
  if (u === 'WORLDWIDE' || u === 'WW') { return 'WW'; }
  if (u === 'GB') { return 'UK'; }
  if (SUPPORTED_MARKET.has(u)) { return u; }
  return 'US';
}

export function resolveVisibilityMarketFromSearchParams(sp) {
  const country = sp.get('country')?.trim();
  if (country) { return normalizeMarketToken(country); }
  const region = (sp.get('region') || '').trim();
  if (!region) { return 'US'; }
  return normalizeMarketToken(region);
}

const ENGINE_QUERY_MAP = {
  chatgpt: 'chatgpt',
  chat_gpt: 'chatgpt',
  gemini: 'gemini',
  aimode: 'googleAiMode',
  overview: 'googleAiOverview',
  googleaimode: 'googleAiMode',
  googleaioverview: 'googleAiOverview',
  google_ai_mode: 'googleAiMode',
  google_ai_overview: 'googleAiOverview',
};

export function normalizeEngineFromQuery(engine) {
  if (engine == null || engine === '') { return null; }
  const t = engine.trim();
  const e = t.toLowerCase();
  // Drop aggregate / non-engine tokens: `all` (query) and `unspecified` (the
  // SR `stats-by-llm` cross-engine total row's `llm` enum) are not selectable models.
  if (e === 'all' || e === 'unspecified') { return null; }
  return ENGINE_QUERY_MAP[e] ?? t;
}

function addMarket(markets, raw) {
  if (typeof raw !== 'string' || !raw.trim()) { return; }
  markets.add(normalizeMarketToken(raw));
}

function addModel(models, raw) {
  if (typeof raw !== 'string' || !raw.trim()) { return; }
  const n = normalizeEngineFromQuery(raw);
  if (n) { models.add(n); }
}

function extractBreakdownModels(o, models) {
  for (const blockKey of ['mentions', 'citedPages']) {
    const block = o[blockKey];
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      /* skip */
    } else {
      for (const k of Object.keys(block)) {
        if (k !== 'all') {
          const n = normalizeEngineFromQuery(k);
          if (n) { models.add(n); }
        }
      }
    }
  }
}

function walkCollect(val, markets, models, seen, depth) {
  if (depth > 24) { return; }
  if (val === null || typeof val !== 'object') { return; }
  if (seen.has(val)) { return; }
  seen.add(val);
  if (Array.isArray(val)) {
    for (const item of val) { walkCollect(item, markets, models, seen, depth + 1); }
    return;
  }
  const o = val;
  extractBreakdownModels(o, models);
  if ('country' in o) { addMarket(markets, o.country); }
  if ('engine' in o) { addModel(models, o.engine); }
  if ('llm' in o) { addModel(models, o.llm); }
  for (const v of Object.values(o)) { walkCollect(v, markets, models, seen, depth + 1); }
}

export function attachSrFiltersToSuccessfulBody(status, body, searchParams) {
  if (status !== 200 || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  const o = body;
  if ('error' in o) { return body; }
  const markets = new Set();
  const models = new Set();
  walkCollect(body, markets, models, new WeakSet(), 0);
  if (searchParams) {
    markets.add(resolveVisibilityMarketFromSearchParams(searchParams));
    const eng = normalizeEngineFromQuery(searchParams.get('engine'));
    if (eng) { models.add(eng); }
  }
  const inferredMarkets = sortUnique([...markets]);
  const marketsList = inferredMarkets.length > 0
    ? sortUnique([...SR_VISIBILITY_MARKETS_CATALOG, ...inferredMarkets])
    : [...SR_VISIBILITY_MARKETS_CATALOG];
  const modelsList = models.size > 0
    ? sortUnique([...models])
    : [...SR_VISIBILITY_MODELS_CATALOG];
  return {
    ...o,
    srFilters: {
      markets: marketsList,
      models: modelsList,
      marketsCatalog: [...SR_VISIBILITY_MARKETS_CATALOG],
      modelsCatalog: [...SR_VISIBILITY_MODELS_CATALOG],
    },
  };
}
