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

/* eslint-disable max-statements-per-line, max-len, no-continue, no-nested-ternary -- dense Semrush gRPC helpers */

import {
  COUNTRY_ENUM,
  LLM_ENUM,
  TOPIC_INTENT_ENUM,
} from '@quazar/ai-seo-ts/common/types_pb.js';
import { ConnectError, Code } from '@connectrpc/connect';

export { COUNTRY_ENUM, LLM_ENUM, TOPIC_INTENT_ENUM };

/**
 * Shared JSON read options for v1 protobuf-es handlers. Ignores unknown fields so
 * incoming JSON forwarded into `fromJson` does not fail on extra keys.
 * @type {import('@bufbuild/protobuf').JsonReadOptions}
 */
export const PROTO_FROM_JSON = { ignoreUnknownFields: true };

/**
 * Shared JSON write options for v1 protobuf-es handlers. Emits camelCase field names
 * and includes implicit (default-valued) fields so the response shape is stable.
 * @type {import('@bufbuild/protobuf').JsonWriteOptions}
 */
export const PROTO_TO_JSON = { useProtoFieldName: false, alwaysEmitImplicit: true };

export const LLM_UI = {
  [LLM_ENUM.CHAT_GPT]: 'chatgpt',
  [LLM_ENUM.GEMINI]: 'gemini',
  [LLM_ENUM.GOOGLE_AI_MODE]: 'googleAiMode',
  [LLM_ENUM.GOOGLE_AI_OVERVIEW]: 'googleAiOverview',
};

export const FTS_LLMS = [
  LLM_ENUM.CHAT_GPT,
  LLM_ENUM.GEMINI,
  LLM_ENUM.GOOGLE_AI_MODE,
  LLM_ENUM.GOOGLE_AI_OVERVIEW,
];

export const EMPTY_ENGINE_BREAKDOWN = () => ({
  all: 0,
  chatgpt: 0,
  gemini: 0,
  googleAiMode: 0,
  googleAiOverview: 0,
});

/**
 * @param {{ status: 'fulfilled' | 'rejected', value?: *, reason?: * }} settled
 * @param {*} fallback
 * @returns {*}
 */
export function settledValueOrElse(settled, fallback) {
  return settled.status === 'fulfilled' ? settled.value : fallback;
}

/**
 * @param {{ status: 'fulfilled' | 'rejected', value?: *, reason?: * }} settled
 * @param {(value: *) => *} mapFn
 * @param {*} fallback
 * @returns {*}
 */
export function settledFulfilledMap(settled, mapFn, fallback) {
  return settled.status === 'fulfilled' ? mapFn(settled.value) : fallback;
}

export const GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT = 100;
/** Max topicIds query values combined into Semrush dimensionFilterQl (injection-safe numeric ids only). */
export const MAX_TOPIC_IDS_DIMENSION_FILTER = 50;
const TOPIC_HASH_ID_PATTERN = /^\d+$/;

/**
 * Validates topicIds for dimensionFilterQl: digits-only, capped count.
 * @param {URLSearchParams} sp
 * @returns {{ ok: true, dimensionFilterQl: string } | { ok: false, status: number, body: object }}
 */
export function resolveTopicIdsDimensionFilter(sp) {
  const raw = sp.getAll('topicIds').filter(Boolean);
  if (raw.length === 0) {
    return { ok: true, dimensionFilterQl: '' };
  }
  if (raw.length > MAX_TOPIC_IDS_DIMENSION_FILTER) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'topic_ids_limit_exceeded',
        message: `At most ${MAX_TOPIC_IDS_DIMENSION_FILTER} topicIds values are allowed`,
      },
    };
  }
  for (const id of raw) {
    if (!TOPIC_HASH_ID_PATTERN.test(id)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'invalid_topic_ids',
          message: 'Each topicIds value must be a non-negative integer string',
        },
      };
    }
  }
  let dimensionFilterQl = '';
  if (raw.length === 1) {
    dimensionFilterQl = `topic_hash = ${raw[0]}`;
  } else {
    dimensionFilterQl = raw.map((id) => `topic_hash = ${id}`).join(' OR ');
  }
  return { ok: true, dimensionFilterQl };
}

export const PROMPTS_RESPONSES_PROMPTS_SCAN_LIMIT = 500;
export const MAX_COMPETITOR_DOMAINS = 5;
export const TOPIC_OPPORTUNITY_PROMPTS_MAX_PAGES = 15;

export function num(v) {
  if (v == null) {
    return 0;
  }
  if (typeof v === 'bigint') {
    return Number(v);
  }
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function brandTarget(domain) {
  const d = domain.trim().toLowerCase();
  return { domain: d, name: d };
}

export function parseLimitOffset(sp) {
  const rawLimit = sp.get('limit');
  let limit = rawLimit == null || String(rawLimit).trim() === ''
    ? Number.NaN
    : Number(rawLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    limit = 100;
  }
  const rawOffset = sp.get('offset');
  let offset = rawOffset == null || String(rawOffset).trim() === ''
    ? 0
    : Number(rawOffset);
  if (!Number.isFinite(offset)) {
    offset = 0;
  }
  offset = Math.max(0, offset);
  return { limit, offset };
}

/* c8 ignore start -- thin QL/validation helpers for V1 brand-topics filters */
/**
 * Escape a user-supplied string for embedding inside a Semrush QL double-quoted
 * literal. Backslashes are doubled and double-quotes are backslash-escaped so the
 * literal cannot break out of the surrounding `"..."` quotes.
 *
 * @param {string} s
 * @returns {string}
 */
export function escapeQlString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build a Semrush QL range expression like `volume >= 10 AND volume <= 100`.
 * - both bounds present → `metric >= from AND metric <= to`
 * - only `from` present → `metric >= from`
 * - only `to` present   → `metric <= to`
 * - neither present     → ''
 *
 * @param {string} metric
 * @param {string|number|null|undefined} from
 * @param {string|number|null|undefined} to
 * @returns {string}
 */
export function buildRangeExpr(metric, from, to) {
  const hasFrom = from != null && from !== '';
  const hasTo = to != null && to !== '';
  if (hasFrom && hasTo) {
    return `${metric} >= ${from} AND ${metric} <= ${to}`;
  }
  if (hasFrom) {
    return `${metric} >= ${from}`;
  }
  if (hasTo) {
    return `${metric} <= ${to}`;
  }
  return '';
}

/**
 * @param {string|number|null|undefined} v
 * @returns {boolean} true if `v` is null/undefined/empty (no bound) or an integer in [0, 100].
 */
export function isValidVisibility(v) {
  if (v == null || v === '') {
    return true;
  }
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100;
}

/**
 * @param {string|number|null|undefined} v
 * @returns {boolean} true if `v` is null/undefined/empty (no bound) or a non-negative integer.
 */
export function isValidVolume(v) {
  if (v == null || v === '') {
    return true;
  }
  const n = Number(v);
  return Number.isInteger(n) && n >= 0;
}
/* c8 ignore stop */

export function normalizeCountryForGrpc(raw) {
  const u = String(raw).trim().toUpperCase();
  if (u === 'WW' || u === 'WORLDWIDE') {
    return COUNTRY_ENUM.WORLDWIDE;
  }
  if (u === 'GB') {
    return COUNTRY_ENUM.UK;
  }
  if (COUNTRY_ENUM[u] != null) {
    return COUNTRY_ENUM[u];
  }
  return COUNTRY_ENUM.US;
}

export function resolveCountry(sp) {
  const country = sp.get('country')?.trim();
  if (country) {
    return normalizeCountryForGrpc(country);
  }
  const region = (sp.get('region') || '').trim().toUpperCase();
  if (region === 'WW' || region === 'WORLDWIDE') {
    return COUNTRY_ENUM.WORLDWIDE;
  }
  if (/^[A-Z]{2}$/.test(region)) {
    return normalizeCountryForGrpc(region);
  }
  return COUNTRY_ENUM.US;
}

export function resolveCountryForFts(sp) {
  const c = resolveCountry(sp);
  return c === COUNTRY_ENUM.WORLDWIDE ? COUNTRY_ENUM.US : c;
}

export function resolveCountryForCompetitorsMetrics(sp) {
  const c = resolveCountry(sp);
  return c === COUNTRY_ENUM.WORLDWIDE ? COUNTRY_ENUM.US : c;
}

export function resolveCountryForCitedSources(sp) {
  const c = resolveCountry(sp);
  return c === COUNTRY_ENUM.WORLDWIDE ? COUNTRY_ENUM.US : c;
}

export function restCountryFromGrpcRequestCountry(grpcCountry) {
  if (
    grpcCountry == null
    || grpcCountry === 0
    || grpcCountry === COUNTRY_ENUM.WORLDWIDE
  ) {
    return undefined;
  }
  if (grpcCountry === COUNTRY_ENUM.UK) {
    return 'GB';
  }
  return COUNTRY_ENUM[grpcCountry] || undefined;
}

export function restCountryFromPromptProto(p) {
  if (!p || typeof p !== 'object') {
    return undefined;
  }
  const raw = p.country;
  if (raw == null || raw === 0) {
    return undefined;
  }
  if (typeof raw === 'number') {
    if (raw === COUNTRY_ENUM.WORLDWIDE) {
      return undefined;
    }
    if (raw === COUNTRY_ENUM.UK) {
      return 'GB';
    }
    return COUNTRY_ENUM[raw] || undefined;
  }
  const s = String(raw).trim().toUpperCase();
  if (s === '' || s === 'WORLDWIDE' || s === 'WW') {
    return undefined;
  }
  if (s === 'UK') {
    return 'GB';
  }
  if (/^[A-Z]{2}$/.test(s)) {
    return s;
  }
  return undefined;
}

export function restMarketFromSourceDomainCountryField(d) {
  const raw = d?.country;
  if (raw == null || raw === 0) {
    return undefined;
  }
  if (typeof raw === 'number') {
    if (raw === COUNTRY_ENUM.WORLDWIDE) {
      return 'WW';
    }
    if (raw === COUNTRY_ENUM.UK) {
      return 'GB';
    }
    return COUNTRY_ENUM[raw] || undefined;
  }
  const s = String(raw).trim().toUpperCase();
  if (s === 'WORLDWIDE') {
    return 'WW';
  }
  return s;
}

export function engineToLlm(engine) {
  if (!engine) {
    return undefined;
  }
  const map = {
    chatgpt: LLM_ENUM.CHAT_GPT,
    gemini: LLM_ENUM.GEMINI,
    aimode: LLM_ENUM.GOOGLE_AI_MODE,
    overview: LLM_ENUM.GOOGLE_AI_OVERVIEW,
    googleaimode: LLM_ENUM.GOOGLE_AI_MODE,
    googleaioverview: LLM_ENUM.GOOGLE_AI_OVERVIEW,
    google_ai_mode: LLM_ENUM.GOOGLE_AI_MODE,
    google_ai_overview: LLM_ENUM.GOOGLE_AI_OVERVIEW,
  };
  return map[engine.toLowerCase()] || undefined;
}

export function llmToEngine(llm) {
  return LLM_UI[llm] || String(llm || '').toLowerCase();
}

export function optionalLlmFromQuery(sp) {
  return engineToLlm(sp.get('engine')?.trim() || '') || null;
}

export function requiredLlmFromQuery(sp) {
  return optionalLlmFromQuery(sp) ?? LLM_ENUM.ALL;
}

export function parseMonthYM(sp) {
  const raw = sp.get('month')?.trim();
  if (!raw) {
    return null;
  }
  const m = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!m) {
    return null;
  }
  return { year: Number(m[1]), month: Number(m[2]) };
}

export function statsByLLMDateRange(endYear, endMonth, windowMonths) {
  let fromMonth = endMonth - (windowMonths - 1);
  let fromYear = endYear;
  while (fromMonth <= 0) {
    fromYear -= 1;
    fromMonth += 12;
  }
  return {
    from: { year: fromYear, month: fromMonth, day: 1 },
    till: { year: endYear, month: endMonth, day: 1 },
  };
}

export function slugHostFromBrandName(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 48);
  return s ? `${s}.com` : 'brand.example';
}

export function normalizeTopBrandsByDomainNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

export function topBrandsByDomainEntryName(b) {
  return String(b.brandName ?? '').trim();
}

export function topBrandsByDomainEntryCount(b) {
  return num(b.count);
}

export function mentionedBrandRestLabel(b) {
  if (typeof b === 'string') {
    return b.trim();
  }
  const name = String(b?.name ?? '').trim();
  if (name) {
    return name;
  }
  return String(b?.domain ?? '').trim();
}

export function mentionedBrandsCountFromPromptProto(p) {
  const c = num(p.mentionedBrandsCount);
  const list = p.mentionedBrands;
  if (Array.isArray(list) && list.length > 0) {
    return Math.max(c, list.length);
  }
  return c;
}

export function promptMatchesResponsesQuery(promptRaw, queryRaw) {
  const q = String(queryRaw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ');
  if (!q) {
    return true;
  }
  const pl = String(promptRaw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ');
  if (!pl) {
    return false;
  }
  if (pl === q) {
    return true;
  }
  const shorter = pl.length <= q.length ? pl : q;
  if (shorter.length < 12) {
    return false;
  }
  return pl.includes(q) || q.includes(pl);
}

export function dateKey(d) {
  if (!d) {
    return 0;
  }
  return num(d.year) * 10000 + num(d.month) * 100 + num(d.day);
}

export function sourcesListFromSourcesResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const rows = raw.source ?? raw.sources;
  return Array.isArray(rows) ? rows : [];
}

export function sourceDomainsListFromResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const rows = raw.domains ?? raw.sourceDomains;
  return Array.isArray(rows) ? rows : [];
}

export function sourceDomainsByTopicFtsRows(raw) {
  return raw.sourceDomains || [];
}

export function sumVoTotalBySourceCategoryCounts(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const rows = raw.totals || [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  let sum = 0;
  for (const t of rows) {
    sum += num(t.count);
  }
  return sum;
}

const VO_V1_SOURCE_CATEGORY_NAME_BY_NUM = {
  1: 'OWNED_BY_TARGET',
  2: 'MENTIONS_TARGET',
  3: 'MISSES_TARGET',
};

export function voTotalCountForSourceCategory(raw, categoryName) {
  if (
    !raw
    || typeof raw !== 'object'
    || categoryName == null
    || categoryName === ''
  ) {
    return null;
  }
  const rows = raw.totals || [];
  if (!Array.isArray(rows)) {
    return null;
  }
  const want = String(categoryName);
  for (const t of rows) {
    const c = t.category;
    const asName = typeof c === 'number'
      ? (VO_V1_SOURCE_CATEGORY_NAME_BY_NUM[c] ?? '')
      : c == null
        ? ''
        : String(c);
    if (asName === want) {
      return num(t.count);
    }
  }
  return null;
}

export function parseCompetitorDomainsList(sp) {
  const out = [];
  const csv = sp.get('competitors')?.trim();
  if (csv) {
    for (const part of csv.split(',')) {
      const d = part.trim().toLowerCase();
      if (d) {
        out.push(d.startsWith('www.') ? d.slice(4) : d);
      }
    }
  }
  for (const raw of sp.getAll('competitor')) {
    const d = raw.trim().toLowerCase();
    if (d) {
      out.push(d.startsWith('www.') ? d.slice(4) : d);
    }
  }
  return [...new Set(out)].slice(0, MAX_COMPETITOR_DOMAINS);
}

export function parseGapKindEnumList(sp) {
  const tab = (
    sp.get('topicTab')
    || sp.get('topic_tab')
    || sp.get('promptTab')
    || sp.get('prompt_tab')
    || sp.get('tab')
    || 'all-prompts'
  )
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  const tabMap = {
    'all-prompts': [1],
    all: [1],
    missing: [2],
    shared: [4],
    unique: [6],
  };
  if (tabMap[tab]) {
    return tabMap[tab];
  }
  const csv = (sp.get('gapKinds') ?? sp.get('gap_kinds'))?.trim();
  if (!csv) {
    return [1];
  }
  const nameToN = {
    ALL: 1,
    MISSING: 2,
    WEAK: 3,
    SHARED: 4,
    STRONG: 5,
    UNIQUE: 6,
  };
  const result = [];
  for (const part of csv.split(',')) {
    const k = part.trim().toUpperCase();
    if (nameToN[k] != null) {
      result.push(nameToN[k]);
    }
  }
  return result.length ? result : [1];
}

/**
 * Classify a topic or prompt entry by its mention gap between the target brand and
 * its competitors. Returns one of GAP_KIND enum names (string): 'MISSING' | 'WEAK'
 * | 'SHARED' | 'STRONG' | 'UNIQUE'. Mirrors the proto enum semantics defined in
 * `semrush.services.ai_seo.common.v1.GAP_KIND.ENUM`:
 *   - MISSING : target has 0 mentions AND every competitor has > 0
 *   - UNIQUE  : target has > 0 mentions AND every competitor has 0
 *   - WEAK    : target < min(competitor mentions)
 *   - STRONG  : target > max(competitor mentions)
 *   - SHARED  : otherwise (between the two extremes, or mixed-zero edge cases)
 *
 * `entry.gapMentions` is expected to be `[{ brand: { domain }, mentions }, ...]`
 * and typically includes the target brand itself — we exclude it by domain match.
 * If no competitor entries are found, returns 'SHARED' as a neutral fallback.
 */
export function classifyGapKind(entry, targetDomain) {
  const target = typeof targetDomain === 'string' ? targetDomain.trim().toLowerCase() : '';
  const gapMentions = Array.isArray(entry?.gapMentions) ? entry.gapMentions : [];

  // Topics expose `mentions` at the top level; prompts don't and require lookup
  // inside `gapMentions` by brand domain. Prefer the explicit field when present.
  const targetMentions = entry?.mentions != null
    ? num(entry.mentions)
    : num(gapMentions.find((m) => {
      const d = m?.brand?.domain;
      return typeof d === 'string' && d.toLowerCase() === target;
    })?.mentions);

  const competitorMentions = gapMentions
    .filter((m) => {
      const d = m?.brand?.domain;
      return typeof d === 'string' && d.toLowerCase() !== target;
    })
    .map((m) => num(m?.mentions));

  if (competitorMentions.length === 0) {
    return 'SHARED';
  }

  const allCompetitorsZero = competitorMentions.every((m) => m === 0);
  const anyCompetitorPositive = competitorMentions.some((m) => m > 0);

  if (targetMentions === 0) {
    // Empirically the upstream gRPC service treats MISSING as "target = 0 AND at
    // least one competitor > 0" — the strict reading ("every competitor > 0")
    // would produce a far smaller bucket than the totals returned by the service.
    return anyCompetitorPositive ? 'MISSING' : 'SHARED';
  }

  if (allCompetitorsZero) {
    return 'UNIQUE';
  }

  const minCompetitor = Math.min(...competitorMentions);
  if (targetMentions < minCompetitor) {
    return 'WEAK';
  }

  const maxCompetitor = Math.max(...competitorMentions);
  if (targetMentions > maxCompetitor) {
    return 'STRONG';
  }

  return 'SHARED';
}

export function coerceProtoCommonGapKind(kind) {
  if (kind == null) {
    return null;
  }
  if (typeof kind === 'number' && Number.isFinite(kind)) {
    return kind;
  }
  const s = String(kind).trim();
  if (/^\d+$/.test(s)) {
    return Number(s);
  }
  const upper = s.toUpperCase();
  const tail = upper.includes('.') ? upper.split('.').pop() : upper;
  const bare = tail.replace(/^GAP_KIND_/, '');
  const map = {
    UNSPECIFIED: 0,
    ALL: 1,
    MISSING: 2,
    WEAK: 3,
    SHARED: 4,
    STRONG: 5,
    UNIQUE: 6,
  };
  if (map[bare] != null) {
    return map[bare];
  }
  return null;
}

export function aggregateGapPromptsTotalFromTotals(raw, kinds) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const single = num(raw.total);
  if (single > 0) {
    return single;
  }
  const rows = raw.totals || [];
  if (!rows.length) {
    return null;
  }
  const want = new Set(kinds.filter((k) => Number.isFinite(k) && k > 0));
  if (want.size === 0) {
    return null;
  }
  let sum = 0;
  let matched = false;
  for (const row of rows) {
    const rk = row.kind ?? row.gapKind;
    const k = coerceProtoCommonGapKind(rk);
    if (k != null && want.has(k)) {
      sum += num(row.count);
      matched = true;
    }
  }
  return matched ? sum : null;
}

export const TOPIC_INTENT_SLUG = {
  [TOPIC_INTENT_ENUM.TASK]: 'task',
  [TOPIC_INTENT_ENUM.INFORMATIONAL]: 'informational',
  [TOPIC_INTENT_ENUM.NAVIGATIONAL]: 'navigational',
  [TOPIC_INTENT_ENUM.COMMERCIAL]: 'commercial',
  [TOPIC_INTENT_ENUM.TRANSACTIONAL]: 'transactional',
};

export function mergeTopBrandsByDomainResponsesByMax(rawList) {
  const merged = new Map();
  for (const raw of rawList) {
    for (const b of raw.brands || []) {
      const name = topBrandsByDomainEntryName(b);
      if (!name) {
        continue;
      }
      const key = normalizeTopBrandsByDomainNameKey(name);
      const c = topBrandsByDomainEntryCount(b);
      const prev = merged.get(key);
      if (prev == null) {
        merged.set(key, { brandName: name, count: c });
      } else if (c > prev.count) {
        prev.count = c;
        prev.brandName = name;
      } else if (name.length > prev.brandName.length) {
        prev.brandName = name;
      }
    }
  }
  return {
    brands: [...merged.values()].map(({ brandName, count }) => ({
      brandName,
      count,
    })),
  };
}

/* c8 ignore start */
/**
 * Map a Connect RPC failure to an HTTP-style handler result.
 * @param {unknown} error
 * @returns {{ status: number, body: object } | null} null → propagate (e.g. unexpected throw)
 */
export function responseFromGrpcError(error) {
  if (!(error instanceof ConnectError)) {
    return null;
  }
  const message = error.rawMessage || error.message || 'Request failed';
  const grpcCode = error.code;
  const body = { error: 'grpc_error', grpcCode, message };
  switch (error.code) {
    case Code.InvalidArgument:
    case Code.FailedPrecondition:
    case Code.OutOfRange:
      return { status: 400, body: { ...body, error: 'invalid_request' } };
    case Code.Unauthenticated:
      return { status: 401, body: { ...body, error: 'unauthenticated' } };
    case Code.PermissionDenied:
      return { status: 403, body: { ...body, error: 'forbidden' } };
    case Code.NotFound:
      return { status: 404, body: { ...body, error: 'not_found' } };
    case Code.ResourceExhausted:
      return { status: 429, body: { ...body, error: 'resource_exhausted' } };
    case Code.Unavailable:
    case Code.DeadlineExceeded:
      return { status: 503, body: { ...body, error: 'service_unavailable' } };
    default:
      return { status: 502, body: { ...body, error: 'bad_gateway' } };
  }
}

/* c8 ignore stop */
