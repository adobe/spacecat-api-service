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

/* eslint-disable max-statements-per-line, max-len -- AI Visibility handler surface */

import { ORDER_DIRECTION_ENUM } from '@quazar/ai-seo-ts/common/types_pb.js';
import { TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM, BRAND_TOPICS_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import { PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import { BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/brand/enums_pb.js';
import { SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import {
  num, brandTarget, parseLimitOffset, resolveCountry, resolveCountryForFts,
  optionalLlmFromQuery, llmToEngine,
  sourceDomainsByTopicFtsRows,
  LLM_ENUM, FTS_LLMS, TOPIC_INTENT_SLUG,
  settledValueOrElse,
} from '../grpc-utils.js';

/* ------------------------------------------------------------------ */
/*  Sort param parsing for FTS topic-research endpoints                */
/* ------------------------------------------------------------------ */

const TOPICS_SORT_BY = {
  RELEVANCE_SCORE: TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.RELEVANCE_SCORE,
  VOLUME: TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.VOLUME,
};

const PROMPTS_SORT_BY = {
  PROMPT: PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.PROMPT,
  MENTIONED_BRANDS_COUNT: PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONED_BRANDS_COUNT,
  SOURCES_COUNT: PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.SOURCES_COUNT,
};

const BRANDS_SORT_BY = {
  NAME: BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.NAME,
  MENTIONS: BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONS,
  SOURCES_COUNT: BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.SOURCES_COUNT,
};

const SOURCE_DOMAINS_SORT_BY = {
  DOMAIN: SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.DOMAIN,
  SOURCES_COUNT: SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.SOURCES_COUNT,
  MENTIONS: SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONS,
  ORGANIC_TRAFFIC: SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.ORGANIC_TRAFFIC,
};

/**
 * Parses optional `sortBy` and `sortDirection` query params against an endpoint-specific
 * allowlist and returns the resolved gRPC enum values plus an ordering direction multiplier
 * for in-process merge-sort. Invalid values produce a `400` response envelope under `error`;
 * callers must short-circuit on `error` before reading the other fields.
 *
 * Defaults are independent: omitting `sortBy` keeps `defaultByKey`; omitting `sortDirection`
 * keeps `DESC`. This mirrors the v1 brand-topics / brand-prompts handler contract.
 *
 * @param {URLSearchParams} sp
 * @param {Record<string, number>} sortByMap allowlisted UPPER_SNAKE names → gRPC enum values
 * @param {string} defaultByKey one of the keys of sortByMap (used when sp omits `sortBy`)
 * @returns {{ error: { status: 400, body: object } } | { by: number, direction: number, sortByKey: string, dirMult: 1 | -1, error?: undefined }}
 */
function resolveFtsSort(sp, sortByMap, defaultByKey) {
  const rawBy = sp.get('sortBy');
  if (rawBy && !Object.prototype.hasOwnProperty.call(sortByMap, rawBy)) {
    return {
      error: {
        status: 400,
        body: {
          error: 'invalid_sort_by',
          message: `sortBy must be one of: ${Object.keys(sortByMap).join(', ')}`,
        },
      },
    };
  }
  const sortByKey = rawBy || defaultByKey;
  const by = sortByMap[sortByKey];

  const rawDir = sp.get('sortDirection');
  if (rawDir && rawDir !== 'ASC' && rawDir !== 'DESC') {
    return {
      error: {
        status: 400,
        body: {
          error: 'invalid_sort_direction',
          message: 'sortDirection must be ASC or DESC',
        },
      },
    };
  }
  const direction = rawDir === 'ASC' ? ORDER_DIRECTION_ENUM.ASC : ORDER_DIRECTION_ENUM.DESC;
  const dirMult = rawDir === 'ASC' ? 1 : -1;

  return {
    by, direction, sortByKey, dirMult,
  };
}

function cmpNum(a, b) {
  return (Number(a) || 0) - (Number(b) || 0);
}

function cmpStr(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/* c8 ignore start -- branch fan-out / defensive paths; see test/support/ai-visibility/handlers/topics.test.js */
const DISTINCT_TOPIC_IDS_PAGE = 1000;
const DISTINCT_TOPIC_IDS_MAX_PAGES = 200;

function resolveDistinctTopicIdsMaxPages(opts) {
  if (opts && typeof opts.maxPages === 'number' && opts.maxPages >= 0) {
    return opts.maxPages;
  }
  return DISTINCT_TOPIC_IDS_MAX_PAGES;
}

/** @param {{ maxPages?: number }} [opts] Optional cap for tests (default 200 pages). */
export async function countTopicRowsByTopicsByFtsPaging(country, query, llm, clients, opts) {
  const q = String(query || '').trim();
  if (!q) { return 0; }
  const maxPages = resolveDistinctTopicIdsMaxPages(opts);
  async function pull(offset, total, pagesLeft) {
    if (pagesLeft <= 0) {
      return total;
    }
    const raw = await clients.topicClient.topicsByFTS({
      country,
      llm,
      query: q,
      order: { by: TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.VOLUME },
      range: { limit: DISTINCT_TOPIC_IDS_PAGE, offset },
    }).catch(() => ({ topics: [] }));
    const topics = raw.topics || [];
    if (topics.length === 0) {
      return total;
    }
    return pull(offset + topics.length, total + topics.length, pagesLeft - 1);
  }
  return pull(0, 0, maxPages);
}

/** @param {{ maxPages?: number }} [opts] Optional cap for tests (default 200 pages per LLM). */
export async function countDistinctTopicIdsAcrossFtsLlms(country, query, clients, opts) {
  const q = String(query || '').trim();
  if (!q) { return 0; }
  const maxPages = resolveDistinctTopicIdsMaxPages(opts);
  const seen = new Set();
  async function pullForLlm(llm, offset, pagesLeft) {
    if (pagesLeft <= 0) {
      return;
    }
    const raw = await clients.topicClient.topicsByFTS({
      country,
      llm,
      query: q,
      order: { by: TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.VOLUME },
      range: { limit: DISTINCT_TOPIC_IDS_PAGE, offset },
    }).catch(() => ({ topics: [] }));
    const topics = raw.topics || [];
    if (topics.length === 0) {
      return;
    }
    for (const t of topics) { seen.add(String(t.id)); }
    await pullForLlm(llm, offset + topics.length, pagesLeft - 1);
  }
  await Promise.allSettled(FTS_LLMS.map((llm) => pullForLlm(llm, 0, maxPages)));
  return seen.size;
}

async function fetchRelatedTopicsAiVolumeMetrics(country, query, llm, clients) {
  const q = String(query || '').trim();
  if (!q) { return null; }
  try {
    if (llm) {
      const raw = await clients.topicClient.metricsByFTS({ country, llm, query: q });
      return num(raw.volume);
    }
    const raw = await clients.topicClient.metricsByFTSGroupedByLLM({ country, query: q });
    let sum = 0;
    for (const row of raw.metricsByLlm || []) { sum += num(row.volume); }
    return sum;
  } catch { return null; }
}

function attachRelatedTopicsAiVolume(body, v) {
  if (v == null) { return body; }
  return { ...body, relatedTopicsAiVolume: v };
}

function stripPromptDedupeKeys(row) {
  const next = { ...row };
  delete next.mentionSortKey;
  delete next.promptNormKey;
  return next;
}

function intentBreakdownFromMetricsByFtsRaw(raw) {
  if (!raw || typeof raw !== 'object') { return []; }
  const out = [];
  for (const item of raw.intents || []) {
    const slug = TOPIC_INTENT_SLUG[item.intent];
    const w = slug ? num(item.weight) : 0;
    if (slug && w > 0) {
      out.push({ intent: slug, count: w });
    }
  }
  return out;
}

function mergeIntentBreakdownsFromPerLlmMetrics(rawRows) {
  const merged = new Map();
  for (const raw of rawRows) {
    if (raw) {
      for (const row of intentBreakdownFromMetricsByFtsRaw(raw)) {
        merged.set(row.intent, (merged.get(row.intent) ?? 0) + row.count);
      }
    }
  }
  return [...merged.entries()].map(([intent, count]) => ({ intent, count }));
}

async function sumBrandsAndSourceDomainsMetricsByFtsAcrossLlmsFallback(country, query, clients) {
  const q = String(query || '').trim();
  if (!q) { return { brandsTotal: 0, sourceDomainsTotal: 0, intentBreakdown: [] }; }
  try {
    const settled = await Promise.allSettled(
      FTS_LLMS.map((l) => clients.topicClient.metricsByFTS({ country, llm: l, query: q }).catch(() => null)),
    );
    const rows = settled.map((s) => settledValueOrElse(s, null));
    let brandsTotal = 0;
    let sourceDomainsTotal = 0;
    for (const raw of rows) {
      if (raw) {
        brandsTotal += num(raw.brandsCount);
        sourceDomainsTotal += num(raw.sourceDomainsCount);
      }
    }
    return {
      brandsTotal,
      sourceDomainsTotal,
      intentBreakdown: mergeIntentBreakdownsFromPerLlmMetrics(rows),
    };
  } catch {
    return { brandsTotal: 0, sourceDomainsTotal: 0, intentBreakdown: [] };
  }
}

async function brandsAndSourceDomainsMetricsByFtsAllModels(country, query, clients) {
  const q = String(query || '').trim();
  if (!q) { return { brandsTotal: 0, sourceDomainsTotal: 0, intentBreakdown: [] }; }
  try {
    const raw = await clients.topicClient.metricsByFTS({ country, llm: LLM_ENUM.ALL, query: q });
    return {
      brandsTotal: num(raw.brandsCount),
      sourceDomainsTotal: num(raw.sourceDomainsCount),
      intentBreakdown: intentBreakdownFromMetricsByFtsRaw(raw),
    };
  } catch {
    return sumBrandsAndSourceDomainsMetricsByFtsAcrossLlmsFallback(country, q, clients);
  }
}

function mapPromptRow(p) {
  const tv = p.topicVolume;
  return {
    prompt: p.prompt,
    promptHash: String(p.promptHash ?? ''),
    serpId: String(p.serpId ?? ''),
    topic: p.topicName,
    topicId: String(p.topicId ?? ''),
    engine: llmToEngine(p.llm),
    mentions: num(p.mentionedBrandsCount),
    citedPages: num(p.sourcesCount),
    ...(tv != null && tv !== '' ? { topicVolume: num(tv) } : {}),
    ...(p.briefResponse ? { responseExcerpt: p.briefResponse } : {}),
  };
}

function mapBrandsByTopicFtsRow(b) {
  const sourceDomains = num(b.sourceDomainsCount);
  return {
    domain: b.domain || '',
    name: String(b.name ?? '').trim(),
    mentions: num(b.mentions),
    citedPages: sourceDomains,
    sourceDomainsCount: sourceDomains,
    promptExample: String(b.examplePrompt ?? '').trim(),
  };
}

function extractSourceDomainExamplePrompt(s) {
  if (!s || typeof s !== 'object') { return ''; }
  for (const v of [s.examplePrompt, s.promptExample]) {
    if (v != null && v !== '') {
      const t = String(v).trim();
      if (t) { return t; }
    }
  }
  const ex = s.example;
  if (ex != null && typeof ex === 'object' && !Array.isArray(ex)) {
    for (const v of [ex.prompt, ex.text, ex.examplePrompt]) {
      if (v != null && v !== '') {
        const t = String(v).trim();
        if (t) { return t; }
      }
    }
  }
  return '';
}

function mapSourceDomainsByTopicFtsRow(s) {
  const sourcesCount = num(s.sourcesCount);
  const mentions = num(s.mentions ?? s.overallMentions);
  const otRaw = s.organicTraffic;
  const hasUpstreamOrganic = otRaw !== undefined && otRaw !== null && otRaw !== '' && !(typeof otRaw === 'number' && !Number.isFinite(otRaw));
  const pe = extractSourceDomainExamplePrompt(s);
  const row = { sourceDomain: s.domain || '', sourcesCount, mentions };
  if (hasUpstreamOrganic) { row.organicTraffic = num(otRaw); }
  if (pe) { row.promptExample = pe; }
  return row;
}

export async function handleTopicsResearchStats(sp, clients) {
  const country = resolveCountryForFts(sp);
  const q = (sp.get('searchQuery') ?? '').trim();
  if (!q) {
    return { status: 400, body: { error: 'missing_search_query', message: 'searchQuery is required' } };
  }
  const llm = optionalLlmFromQuery(sp);
  if (llm) {
    const pair = await Promise.allSettled([
      countTopicRowsByTopicsByFtsPaging(country, q, llm, clients),
      clients.topicClient.metricsByFTS({ country, llm, query: q }).catch(() => null),
    ]);
    const topicsTotal = settledValueOrElse(pair[0], 0);
    const metricsRaw = settledValueOrElse(pair[1], null);
    let metricsVolNum;
    let brandsTotal = 0;
    let sourceDomainsTotal = 0;
    let intentBreakdown = [];
    if (metricsRaw) {
      metricsVolNum = num(metricsRaw.volume);
      brandsTotal = num(metricsRaw.brandsCount);
      sourceDomainsTotal = num(metricsRaw.sourceDomainsCount);
      intentBreakdown = intentBreakdownFromMetricsByFtsRaw(metricsRaw);
    } else {
      const fb = await Promise.allSettled([
        fetchRelatedTopicsAiVolumeMetrics(country, q, llm, clients),
        clients.brandClient.brandsByTopicFTSTotals({ country, llm, query: q }),
        clients.sourceClient.sourceDomainsByTopicFTSTotals({ country, llm, query: q }),
      ]);
      metricsVolNum = settledValueOrElse(fb[0], null);
      brandsTotal = num(settledValueOrElse(fb[1], { total: 0 }).total);
      sourceDomainsTotal = num(settledValueOrElse(fb[2], { total: 0 }).total);
    }
    const body = {
      topicsTotal,
      brandsTotal,
      sourceDomainsTotal,
      ...(intentBreakdown.length ? { intentBreakdown } : {}),
    };
    return { status: 200, body: attachRelatedTopicsAiVolume(body, metricsVolNum) };
  }
  const tri = await Promise.allSettled([
    countDistinctTopicIdsAcrossFtsLlms(country, q, clients),
    fetchRelatedTopicsAiVolumeMetrics(country, q, null, clients),
    brandsAndSourceDomainsMetricsByFtsAllModels(country, q, clients),
  ]);
  const topicsTotal = settledValueOrElse(tri[0], 0);
  const metricsVol = settledValueOrElse(tri[1], null);
  const kpis = settledValueOrElse(tri[2], { brandsTotal: 0, sourceDomainsTotal: 0, intentBreakdown: [] });
  const { brandsTotal, sourceDomainsTotal } = kpis;
  const intentBreakdown = kpis.intentBreakdown ?? [];
  const body = {
    topicsTotal,
    brandsTotal,
    sourceDomainsTotal,
    ...(intentBreakdown.length ? { intentBreakdown } : {}),
  };
  return { status: 200, body: attachRelatedTopicsAiVolume(body, metricsVol) };
}

/**
 * @param {{ sortByKey: string, dirMult: 1 | -1 }} sort
 */
function topicsResearchComparator(sort) {
  const { sortByKey, dirMult } = sort;
  // Tiebreak by topic name ASC to keep ordering deterministic and to preserve the
  // pre-existing default behaviour on the RELEVANCE_SCORE + DESC path.
  if (sortByKey === 'VOLUME') {
    return (a, b) => cmpNum(a.topicVolume, b.topicVolume) * dirMult || cmpStr(a.topic, b.topic);
  }
  return (a, b) => cmpNum(a.relevanceScore, b.relevanceScore) * dirMult || cmpStr(a.topic, b.topic);
}

export async function handleTopicsResearch(sp, clients) {
  const country = resolveCountryForFts(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const q = (sp.get('searchQuery') ?? '').trim();
  if (!q) {
    return { status: 400, body: { error: 'missing_search_query', message: 'searchQuery is required' } };
  }
  const sort = resolveFtsSort(sp, TOPICS_SORT_BY, 'RELEVANCE_SCORE');
  if (sort.error) { return sort.error; }
  const order = { by: sort.by, direction: sort.direction };
  const llm = optionalLlmFromQuery(sp);
  if (llm) {
    const pair = await Promise.allSettled([
      countTopicRowsByTopicsByFtsPaging(country, q, llm, clients),
      clients.topicClient.topicsByFTS({
        country, llm, query: q, order, range: { limit, offset },
      }),
    ]);
    const listTotal = settledValueOrElse(pair[0], 0);
    if (pair[1].status !== 'fulfilled') {
      throw pair[1].reason;
    }
    const raw = pair[1].value;
    const data = (raw.topics || []).map((t) => ({
      topic: t.name,
      topicId: String(t.id),
      topicVolume: num(t.volume),
      promptsCount: num(t.promptsCount),
      relevanceScore: num(t.relevanceScore),
    }));
    return {
      status: 200,
      body: {
        data, total: listTotal, offset, limit,
      },
    };
  }
  const pairAll = await Promise.all([
    countDistinctTopicIdsAcrossFtsLlms(country, q, clients),
    Promise.all(FTS_LLMS.map((l) => clients.topicClient.topicsByFTS({
      country, llm: l, query: q, order, range: { limit, offset },
    }).catch(() => ({ topics: [] })))),
  ]);
  const topicsTotalDistinct = pairAll[0];
  const listResults = pairAll[1];
  const seen = new Map();
  for (const raw of listResults) {
    for (const t of (raw.topics || [])) {
      const id = String(t.id);
      if (!seen.has(id)) {
        seen.set(id, {
          topic: t.name,
          topicId: id,
          topicVolume: num(t.volume),
          promptsCount: num(t.promptsCount),
          relevanceScore: num(t.relevanceScore),
        });
      } else {
        const prev = seen.get(id);
        prev.relevanceScore = Math.max(prev.relevanceScore, num(t.relevanceScore));
      }
    }
  }
  const merged = Array.from(seen.values()).sort(topicsResearchComparator(sort));
  const data = merged.slice(0, limit);
  return {
    status: 200,
    body: {
      data, total: topicsTotalDistinct, offset, limit,
    },
  };
}

export async function handleTopicsStats(sp, clients) {
  const topicId = sp.get('topicId')?.trim();
  if (!topicId) {
    return { status: 400, body: { error: 'missing_topic_id', message: 'topicId is required' } };
  }
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountry(sp);
  const raw = await clients.topicClient.brandTopics({
    country, target: brandTarget(domain), order: { by: BRAND_TOPICS_ORDER_BY_ENUM.VISIBILITY }, range: { limit: 500, offset: 0 },
  });
  const t = (raw.topics || []).find((x) => String(x.id) === topicId);
  if (!t) { return { status: 200, body: { data: [] } }; }
  return {
    status: 200,
    body: {
      data: [{
        topic: t.name,
        topicId: String(t.id),
        topicVolume: num(t.volume),
        domain,
        mentions: num(t.mentions),
        citedPages: 0,
      }],
    },
  };
}

/**
 * @param {{ sortByKey: string }} sort
 * @returns {(row: object) => number | string}
 */
function promptsResearchSortKey(sort) {
  if (sort.sortByKey === 'PROMPT') {
    return (row) => row.promptNormKey;
  }
  if (sort.sortByKey === 'SOURCES_COUNT') {
    return (row) => row.citedPages;
  }
  return (row) => row.mentions;
}

/**
 * Group-level aggregator: picks the "best" sort key across the group rows
 * honouring direction. For DESC we want the highest value to surface the
 * group first; for ASC we want the lowest.
 */
function reduceGroupSortKey(values, sort) {
  if (sort.sortByKey === 'PROMPT') {
    return values[0];
  }
  if (sort.dirMult === -1) {
    return values.reduce((acc, v) => (v > acc ? v : acc), Number.NEGATIVE_INFINITY);
  }
  return values.reduce((acc, v) => (v < acc ? v : acc), Number.POSITIVE_INFINITY);
}

export async function handleTopicsResearchPrompts(sp, clients) {
  const searchQuery = sp.get('searchQuery')?.trim();
  if (!searchQuery) {
    return { status: 400, body: { error: 'missing_search_query', message: 'searchQuery is required' } };
  }
  const sort = resolveFtsSort(sp, PROMPTS_SORT_BY, 'MENTIONED_BRANDS_COUNT');
  if (sort.error) { return sort.error; }
  const order = { by: sort.by, direction: sort.direction };
  const country = resolveCountryForFts(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llm = optionalLlmFromQuery(sp);
  if (llm) {
    const engineSlug = llmToEngine(llm);
    const pr = await Promise.allSettled([
      clients.promptClient.promptsByTopicFTSTotals({ country, llm, query: searchQuery }),
      clients.promptClient.promptsByTopicFTS({
        country, llm, query: searchQuery, order, range: { limit, offset },
      }),
    ]);
    if (pr[1].status !== 'fulfilled') {
      throw pr[1].reason;
    }
    const raw = pr[1].value;
    const totalsRaw = settledValueOrElse(pr[0], { total: 0 });
    const data = (raw.prompts || []).map((p) => {
      const row = mapPromptRow(p);
      row.engine = engineSlug || row.engine;
      return row;
    });
    return {
      status: 200,
      body: {
        data, total: num(totalsRaw.total), offset, limit,
      },
    };
  }
  const prPair = await Promise.all([
    Promise.all(FTS_LLMS.map((l) => clients.promptClient.promptsByTopicFTSTotals({ country, llm: l, query: searchQuery }).catch(() => ({ total: 0 })))),
    Promise.all(FTS_LLMS.map((l) => clients.promptClient.promptsByTopicFTS({
      country, llm: l, query: searchQuery, order, range: { limit, offset },
    }).catch(() => ({ prompts: [] })))),
  ]);
  const totalsResults = prPair[0];
  const listResults = prPair[1];
  const total = totalsResults.reduce((sum, r) => sum + num(r.total), 0);
  const sortKey = promptsResearchSortKey(sort);
  const isStringSort = sort.sortByKey === 'PROMPT';
  const seen = new Map();
  for (let i = 0; i < FTS_LLMS.length; i += 1) {
    const engineSlug = llmToEngine(FTS_LLMS[i]);
    for (const p of (listResults[i]?.prompts || [])) {
      const row = mapPromptRow(p);
      row.engine = engineSlug || row.engine;
      const promptNorm = String(row.prompt ?? '').trim().toLowerCase();
      const key = row.promptHash && row.serpId
        ? `${row.topicId}|${row.promptHash}|${row.serpId}|${row.engine}|${promptNorm}`
        : `${row.topicId}|${promptNorm}|${row.engine}`;
      if (!seen.has(key)) {
        const withKeys = { ...row, promptNormKey: promptNorm };
        withKeys.mentionSortKey = sortKey(withKeys);
        seen.set(key, withKeys);
      }
    }
  }
  const byNorm = new Map();
  for (const row of seen.values()) {
    const norm = row.promptNormKey;
    if (!byNorm.has(norm)) { byNorm.set(norm, []); }
    byNorm.get(norm).push(row);
  }
  const groups = [...byNorm.values()].map((rows) => {
    const sorted = [...rows].sort((a, b) => {
      const cmp = isStringSort
        ? cmpStr(a.mentionSortKey, b.mentionSortKey)
        : cmpNum(a.mentionSortKey, b.mentionSortKey);
      return cmp * sort.dirMult || cmpStr(a.prompt, b.prompt);
    });
    const groupKey = reduceGroupSortKey(sorted.map((r) => r.mentionSortKey), sort);
    const multiEngine = new Set(sorted.map((r) => r.engine)).size > 1;
    return {
      rows: sorted, groupKey, multiEngine, norm: sorted[0].promptNormKey,
    };
  });
  groups.sort((a, b) => {
    const cmp = isStringSort ? cmpStr(a.groupKey, b.groupKey) : cmpNum(a.groupKey, b.groupKey);
    return cmp * sort.dirMult || cmpStr(a.norm, b.norm);
  });
  const overflowCap = limit + FTS_LLMS.length - 1;
  const picked = [];
  for (const g of groups) {
    if (g.multiEngine) {
      const n = g.rows.length;
      if (n <= FTS_LLMS.length) {
        const nextLen = picked.length + n;
        if (nextLen <= limit) {
          picked.push(...g.rows);
        } else if (picked.length < limit && nextLen <= overflowCap) {
          picked.push(...g.rows);
        }
      }
    } else if (picked.length < limit) { picked.push(g.rows[0]); }
  }
  const data = picked.map(stripPromptDedupeKeys);
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}

/**
 * @param {{ sortByKey: string, dirMult: 1 | -1 }} sort
 */
function brandsResearchComparator(sort) {
  const { sortByKey, dirMult } = sort;
  if (sortByKey === 'NAME') {
    return (a, b) => cmpStr(a.name, b.name) * dirMult || cmpStr(a.domain, b.domain);
  }
  if (sortByKey === 'SOURCES_COUNT') {
    return (a, b) => cmpNum(a.sourceDomainsCount, b.sourceDomainsCount) * dirMult || cmpStr(a.domain, b.domain);
  }
  return (a, b) => cmpNum(a.mentions, b.mentions) * dirMult || cmpStr(a.domain, b.domain);
}

export async function handleTopicsResearchBrands(sp, clients) {
  const searchQuery = sp.get('searchQuery')?.trim();
  if (!searchQuery) {
    return { status: 400, body: { error: 'missing_search_query', message: 'searchQuery is required' } };
  }
  const sort = resolveFtsSort(sp, BRANDS_SORT_BY, 'MENTIONS');
  if (sort.error) { return sort.error; }
  const order = { by: sort.by, direction: sort.direction };
  const country = resolveCountryForFts(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llm = optionalLlmFromQuery(sp);
  if (llm) {
    const br = await Promise.allSettled([
      clients.brandClient.brandsByTopicFTSTotals({ country, llm, query: searchQuery }),
      clients.brandClient.brandsByTopicFTS({
        country, llm, query: searchQuery, order, range: { limit, offset },
      }),
    ]);
    if (br[1].status !== 'fulfilled') {
      throw br[1].reason;
    }
    const raw = br[1].value;
    const totalsRaw = settledValueOrElse(br[0], { total: 0 });
    const data = (raw.brands || []).map(mapBrandsByTopicFtsRow);
    return {
      status: 200,
      body: {
        data, total: num(totalsRaw.total), offset, limit,
      },
    };
  }
  const brPair = await Promise.all([
    Promise.all(FTS_LLMS.map((l) => clients.brandClient.brandsByTopicFTSTotals({ country, llm: l, query: searchQuery }).catch(() => ({ total: 0 })))),
    Promise.all(FTS_LLMS.map((l) => clients.brandClient.brandsByTopicFTS({
      country, llm: l, query: searchQuery, order, range: { limit, offset },
    }).catch(() => ({ brands: [] })))),
  ]);
  const totalsResults = brPair[0];
  const listResults = brPair[1];
  const total = totalsResults.reduce((sum, r) => sum + num(r.total), 0);
  const agg = new Map();
  for (const raw of listResults) {
    for (const b of (raw.brands || [])) {
      const domainKey = b.domain || '';
      if (domainKey) {
        const row = mapBrandsByTopicFtsRow(b);
        const existing = agg.get(domainKey);
        if (existing) {
          existing.mentions += row.mentions;
          existing.citedPages += row.citedPages;
          existing.sourceDomainsCount = num(existing.sourceDomainsCount) + num(row.sourceDomainsCount);
          if (!existing.name && row.name) { existing.name = row.name; }
          if (!existing.promptExample && row.promptExample) { existing.promptExample = row.promptExample; }
        } else { agg.set(domainKey, { ...row }); }
      }
    }
  }
  const merged = Array.from(agg.values()).sort(brandsResearchComparator(sort));
  const data = merged.slice(0, limit);
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}

/**
 * @param {{ sortByKey: string, dirMult: 1 | -1 }} sort
 */
function sourceDomainsResearchComparator(sort) {
  const { sortByKey, dirMult } = sort;
  if (sortByKey === 'DOMAIN') {
    return (a, b) => cmpStr(a.sourceDomain, b.sourceDomain) * dirMult;
  }
  if (sortByKey === 'SOURCES_COUNT') {
    return (a, b) => cmpNum(a.sourcesCount, b.sourcesCount) * dirMult || cmpStr(a.sourceDomain, b.sourceDomain);
  }
  if (sortByKey === 'ORGANIC_TRAFFIC') {
    return (a, b) => cmpNum(a.organicTraffic ?? 0, b.organicTraffic ?? 0) * dirMult || cmpStr(a.sourceDomain, b.sourceDomain);
  }
  // MENTIONS default: preserve the historic three-level tiebreak for stability.
  return (a, b) => cmpNum(a.mentions, b.mentions) * dirMult
    || cmpNum(a.sourcesCount, b.sourcesCount) * dirMult
    || cmpStr(a.sourceDomain, b.sourceDomain);
}

export async function handleTopicsResearchSourceDomains(sp, clients) {
  const searchQuery = sp.get('searchQuery')?.trim();
  if (!searchQuery) {
    return { status: 400, body: { error: 'missing_search_query', message: 'searchQuery is required' } };
  }
  const sort = resolveFtsSort(sp, SOURCE_DOMAINS_SORT_BY, 'MENTIONS');
  if (sort.error) { return sort.error; }
  const order = { by: sort.by, direction: sort.direction };
  const country = resolveCountryForFts(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llm = optionalLlmFromQuery(sp);
  if (llm) {
    const sd = await Promise.allSettled([
      clients.sourceClient.sourceDomainsByTopicFTSTotals({ country, llm, query: searchQuery }),
      clients.sourceClient.sourceDomainsByTopicFTS({
        country, llm, query: searchQuery, order, range: { limit, offset },
      }),
    ]);
    if (sd[1].status !== 'fulfilled') {
      throw sd[1].reason;
    }
    const raw = sd[1].value;
    const totalsRaw = settledValueOrElse(sd[0], { total: 0 });
    const data = sourceDomainsByTopicFtsRows(raw).map(mapSourceDomainsByTopicFtsRow);
    return {
      status: 200,
      body: {
        data, total: num(totalsRaw.total), offset, limit,
      },
    };
  }
  const sdPair = await Promise.all([
    Promise.all(FTS_LLMS.map((l) => clients.sourceClient.sourceDomainsByTopicFTSTotals({ country, llm: l, query: searchQuery }).catch(() => ({ total: 0 })))),
    Promise.all(FTS_LLMS.map((l) => clients.sourceClient.sourceDomainsByTopicFTS({
      country, llm: l, query: searchQuery, order, range: { limit, offset },
    }).catch(() => ({ sourceDomains: [] })))),
  ]);
  const totalsResults = sdPair[0];
  const listResults = sdPair[1];
  const total = totalsResults.reduce((sum, r) => sum + num(r.total), 0);
  const agg = new Map();
  for (const raw of listResults) {
    for (const s of sourceDomainsByTopicFtsRows(raw)) {
      const domainKey = s.domain || '';
      if (domainKey) {
        const row = mapSourceDomainsByTopicFtsRow(s);
        const existing = agg.get(domainKey);
        if (existing) {
          existing.sourcesCount = num(existing.sourcesCount) + num(row.sourcesCount);
          existing.mentions += row.mentions;
          if (row.organicTraffic !== undefined) {
            existing.organicTraffic = num(existing.organicTraffic ?? 0) + num(row.organicTraffic);
          }
          if (!existing.promptExample && row.promptExample) { existing.promptExample = row.promptExample; }
        } else { agg.set(domainKey, { ...row }); }
      }
    }
  }
  const merged = Array.from(agg.values()).sort(sourceDomainsResearchComparator(sort));
  const data = merged.slice(0, limit);
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}
/* c8 ignore end */
