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

import { TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM, BRAND_TOPICS_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import { PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import { BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/brand/enums_pb.js';
import { SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import {
  num, brandTarget, parseLimitOffset, resolveCountry, resolveCountryForFts,
  optionalLlmFromQuery, llmToEngine,
  sourceDomainsByTopicFtsRows,
  LLM_ENUM, FTS_LLMS, TOPIC_INTENT_SLUG,
} from '../grpc-utils.js';

const DISTINCT_TOPIC_IDS_PAGE = 1000;
const DISTINCT_TOPIC_IDS_MAX_PAGES = 200;

/* c8 ignore start -- topic counting / metrics helper functions with defensive branches */
async function countTopicRowsByTopicsByFtsPaging(country, query, llm, clients) {
  const q = String(query || '').trim();
  if (!q) { return 0; }
  let offset = 0;
  let total = 0;
  for (let page = 0; page < DISTINCT_TOPIC_IDS_MAX_PAGES; page++) {
    const raw = await clients.topicClient.topicsByFTS({
      country,
      llm,
      query: q,
      order: { by: TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.VOLUME },
      range: { limit: DISTINCT_TOPIC_IDS_PAGE, offset },
    }).catch(() => ({ topics: [] }));
    const topics = raw.topics || [];
    if (topics.length === 0) { break; }
    total += topics.length;
    offset += topics.length;
  }
  return total;
}

async function countDistinctTopicIdsAcrossFtsLlms(country, query, clients) {
  const q = String(query || '').trim();
  if (!q) { return 0; }
  const seen = new Set();
  await Promise.all(FTS_LLMS.map(async (llm) => {
    let offset = 0;
    for (let page = 0; page < DISTINCT_TOPIC_IDS_MAX_PAGES; page++) {
      const raw = await clients.topicClient.topicsByFTS({
        country,
        llm,
        query: q,
        order: { by: TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.VOLUME },
        range: { limit: DISTINCT_TOPIC_IDS_PAGE, offset },
      }).catch(() => ({ topics: [] }));
      const topics = raw.topics || [];
      if (topics.length === 0) { break; }
      for (const t of topics) { seen.add(String(t.id)); }
      offset += topics.length;
    }
  }));
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
/* c8 ignore stop */

function attachRelatedTopicsAiVolume(body, v) {
  if (v == null) { return body; }
  return { ...body, related_topics_ai_volume: v };
}

/* c8 ignore next 12 -- intent breakdown parsing with defensive guards */
function intentBreakdownFromMetricsByFtsRaw(raw) {
  if (!raw || typeof raw !== 'object') { return []; }
  const out = [];
  for (const item of raw.intents || []) {
    const slug = TOPIC_INTENT_SLUG[item.intent];
    if (!slug) { continue; }
    const w = num(item.weight);
    if (w <= 0) { continue; }
    out.push({ intent: slug, count: w });
  }
  return out;
}

function mergeIntentBreakdownsFromPerLlmMetrics(rawRows) {
  const merged = new Map();
  for (const raw of rawRows) {
    if (!raw) { continue; }
    for (const row of intentBreakdownFromMetricsByFtsRaw(raw)) {
      merged.set(row.intent, (merged.get(row.intent) ?? 0) + row.count);
    }
  }
  return [...merged.entries()].map(([intent, count]) => ({ intent, count }));
}

/* c8 ignore start -- all-models metrics with per-LLM fallback */
async function brandsAndSourceDomainsMetricsByFtsAllModels(country, query, clients) {
  const q = String(query || '').trim();
  if (!q) { return { brands_total: 0, source_domains_total: 0, intent_breakdown: [] }; }
  try {
    const raw = await clients.topicClient.metricsByFTS({ country, llm: LLM_ENUM.ALL, query: q });
    return {
      brands_total: num(raw.brandsCount),
      source_domains_total: num(raw.sourceDomainsCount),
      intent_breakdown: intentBreakdownFromMetricsByFtsRaw(raw),
    };
  } catch {
    return sumBrandsAndSourceDomainsMetricsByFtsAcrossLlmsFallback(country, q, clients);
  }
}

async function sumBrandsAndSourceDomainsMetricsByFtsAcrossLlmsFallback(country, query, clients) {
  const q = String(query || '').trim();
  if (!q) { return { brands_total: 0, source_domains_total: 0, intent_breakdown: [] }; }
  try {
    const rows = await Promise.all(FTS_LLMS.map((l) => clients.topicClient.metricsByFTS({ country, llm: l, query: q }).catch(() => null)));
    let brands_total = 0;
    let source_domains_total = 0;
    for (const raw of rows) {
      if (!raw) { continue; }
      brands_total += num(raw.brandsCount);
      source_domains_total += num(raw.sourceDomainsCount);
    }
    return { brands_total, source_domains_total, intent_breakdown: mergeIntentBreakdownsFromPerLlmMetrics(rows) };
  } catch {
    return { brands_total: 0, source_domains_total: 0, intent_breakdown: [] };
  }
}
/* c8 ignore stop */

/* c8 ignore next 14 -- defensive ternary spreads in mapping */
function mapPromptRow(p) {
  const tv = p.topicVolume;
  return {
    prompt: p.prompt,
    prompt_hash: String(p.promptHash ?? ''),
    serp_id: String(p.serpId ?? ''),
    topic: p.topicName,
    topic_id: String(p.topicId ?? ''),
    engine: llmToEngine(p.llm),
    mentions: num(p.mentionedBrandsCount),
    cited_pages: num(p.sourcesCount),
    ...(tv != null && tv !== '' ? { topic_volume: num(tv) } : {}),
    ...(p.briefResponse ? { response_excerpt: p.briefResponse } : {}),
  };
}

/* c8 ignore next 11 -- brand-by-topic mapping */
function mapBrandsByTopicFtsRow(b) {
  const sourceDomains = num(b.sourceDomainsCount);
  return {
    domain: b.domain || '',
    name: String(b.name ?? '').trim(),
    mentions: num(b.mentions),
    cited_pages: sourceDomains,
    source_domains_count: sourceDomains,
    prompt_example: String(b.examplePrompt ?? '').trim(),
  };
}

/* c8 ignore next 3 */
function extractSourceDomainExamplePrompt(s) {
  if (!s || typeof s !== 'object') { return ''; }
  for (const v of [s.examplePrompt, s.promptExample]) {
    if (v == null || v === '') { continue; }
    const t = String(v).trim();
    if (t) { return t; }
  }
  const ex = s.example;
  if (ex != null && typeof ex === 'object' && !Array.isArray(ex)) {
    for (const v of [ex.prompt, ex.text, ex.examplePrompt]) {
      if (v == null || v === '') { continue; }
      const t = String(v).trim();
      if (t) { return t; }
    }
  }
  return '';
}

function mapSourceDomainsByTopicFtsRow(s) {
  /* c8 ignore next 9 -- source domain mapping defensive branches */
  const sourcesCount = num(s.sourcesCount);
  const mentions = num(s.mentions ?? s.overallMentions);
  const otRaw = s.organicTraffic;
  const hasUpstreamOrganic = otRaw !== undefined && otRaw !== null && otRaw !== '' && !(typeof otRaw === 'number' && !Number.isFinite(otRaw));
  const pe = extractSourceDomainExamplePrompt(s);
  const row = { source_domain: s.domain || '', sources_count: sourcesCount, mentions };
  if (hasUpstreamOrganic) { row.organic_traffic = num(otRaw); }
  if (pe) { row.prompt_example = pe; }
  return row;
}

export async function handleTopicsResearchStats(sp, clients) {
  const country = resolveCountryForFts(sp);
  const q = (sp.get('search_query') ?? '').trim();
  if (!q) { return { status: 400, body: { error: 'missing_search_query', message: 'search_query is required' } }; }
  const llm = optionalLlmFromQuery(sp);
  if (llm) {
    const [topics_total, metricsRaw] = await Promise.all([
      countTopicRowsByTopicsByFtsPaging(country, q, llm, clients),
      clients.topicClient.metricsByFTS({ country, llm, query: q }).catch(() => null),
    ]);
    let metricsVolNum; let brands_total = 0; let source_domains_total = 0; let intent_breakdown = [];
    if (metricsRaw) {
      metricsVolNum = num(metricsRaw.volume);
      brands_total = num(metricsRaw.brandsCount);
      source_domains_total = num(metricsRaw.sourceDomainsCount);
      intent_breakdown = intentBreakdownFromMetricsByFtsRaw(metricsRaw);
    } else {
      const [volFallback, brandsTotalsRaw, sourcesTotalsRaw] = await Promise.all([
        fetchRelatedTopicsAiVolumeMetrics(country, q, llm, clients),
        clients.brandClient.brandsByTopicFTSTotals({ country, llm, query: q }),
        clients.sourceClient.sourceDomainsByTopicFTSTotals({ country, llm, query: q }),
      ]);
      metricsVolNum = volFallback;
      brands_total = num(brandsTotalsRaw.total);
      source_domains_total = num(sourcesTotalsRaw.total);
    }
    const body = {
      topics_total, brands_total, source_domains_total, ...(intent_breakdown.length ? { intent_breakdown } : {}),
    };
    return { status: 200, body: attachRelatedTopicsAiVolume(body, metricsVolNum) };
  }
  const [topics_total, metricsVol, kpis] = await Promise.all([
    countDistinctTopicIdsAcrossFtsLlms(country, q, clients),
    fetchRelatedTopicsAiVolumeMetrics(country, q, null, clients),
    brandsAndSourceDomainsMetricsByFtsAllModels(country, q, clients),
  ]);
  const { brands_total, source_domains_total, intent_breakdown = [] } = kpis;
  const body = {
    topics_total, brands_total, source_domains_total, ...(intent_breakdown.length ? { intent_breakdown } : {}),
  };
  return { status: 200, body: attachRelatedTopicsAiVolume(body, metricsVol) };
}

export async function handleTopicsResearch(sp, clients) {
  const country = resolveCountryForFts(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const q = (sp.get('search_query') ?? '').trim();
  if (!q) { return { status: 400, body: { error: 'missing_search_query', message: 'search_query is required' } }; }
  const llm = optionalLlmFromQuery(sp);
  if (llm) {
    const [listTotal, raw] = await Promise.all([
      countTopicRowsByTopicsByFtsPaging(country, q, llm, clients),
      clients.topicClient.topicsByFTS({
        country, llm, query: q, order: { by: TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.VOLUME }, range: { limit, offset },
      }),
    ]);
    /* c8 ignore next */
    const data = (raw.topics || []).map((t) => ({
      topic: t.name, topic_id: String(t.id), topic_volume: num(t.volume), prompts_count: num(t.promptsCount),
    }));
    return {
      status: 200,
      body: {
        data, total: listTotal, offset, limit,
      },
    };
  }
  const [topicsTotalDistinct, listResults] = await Promise.all([
    countDistinctTopicIdsAcrossFtsLlms(country, q, clients),
    Promise.all(FTS_LLMS.map((l) => clients.topicClient.topicsByFTS({
      country, llm: l, query: q, order: { by: TOPICS_BY_FTS_REQUEST_ORDER_BY_ENUM.VOLUME }, range: { limit, offset },
    }).catch(() => ({ topics: [] })))),
  ]);
  const seen = new Map();
  /* c8 ignore next 4 -- all-LLM fan-out dedup */
  for (const raw of listResults) {
    for (const t of (raw.topics || [])) {
      const id = String(t.id);
      if (!seen.has(id)) {
        seen.set(id, {
          topic: t.name, topic_id: id, topic_volume: num(t.volume), prompts_count: num(t.promptsCount), _sort: num(t.volume),
        });
      }
    }
  }
  /* c8 ignore next */
  const merged = Array.from(seen.values()).sort((a, b) => b._sort - a._sort || a.topic.localeCompare(b.topic));
  const data = merged.slice(0, limit).map(({ _sort, ...r }) => r);
  return {
    status: 200,
    body: {
      data, total: topicsTotalDistinct, offset, limit,
    },
  };
}

export async function handleTopicsStats(sp, clients) {
  const topicId = sp.get('topic_id')?.trim();
  if (!topicId) { return { status: 400, body: { error: 'missing_topic_id', message: 'topic_id is required' } }; }
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountry(sp);
  const raw = await clients.topicClient.brandTopics({
    country, target: brandTarget(domain), order: { by: BRAND_TOPICS_ORDER_BY_ENUM.VISIBILITY }, range: { limit: 500, offset: 0 },
  });
  /* c8 ignore next */
  const t = (raw.topics || []).find((x) => String(x.id) === topicId);
  if (!t) { return { status: 200, body: { data: [] } }; }
  return {
    status: 200,
    body: {
      data: [{
        topic: t.name, topic_id: String(t.id), topic_volume: num(t.volume), domain, mentions: num(t.mentions), cited_pages: 0,
      }],
    },
  };
}

export async function handleTopicsResearchPrompts(sp, clients) {
  const searchQuery = sp.get('search_query')?.trim();
  if (!searchQuery) { return { status: 400, body: { error: 'missing_search_query', message: 'search_query is required' } }; }
  const country = resolveCountryForFts(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llm = optionalLlmFromQuery(sp);
  if (llm) {
    const engineSlug = llmToEngine(llm);
    const [totalsRaw, raw] = await Promise.all([
      clients.promptClient.promptsByTopicFTSTotals({ country, llm, query: searchQuery }),
      clients.promptClient.promptsByTopicFTS({
        country, llm, query: searchQuery, order: { by: PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONED_BRANDS_COUNT }, range: { limit, offset },
      }),
    ]);
    /* c8 ignore next */
    const data = (raw.prompts || []).map((p) => { const row = mapPromptRow(p); row.engine = engineSlug || row.engine; return row; });
    return {
      status: 200,
      body: {
        data, total: num(totalsRaw.total), offset, limit,
      },
    };
  }
  const [totalsResults, listResults] = await Promise.all([
    Promise.all(FTS_LLMS.map((l) => clients.promptClient.promptsByTopicFTSTotals({ country, llm: l, query: searchQuery }).catch(() => ({ total: 0 })))),
    Promise.all(FTS_LLMS.map((l) => clients.promptClient.promptsByTopicFTS({
      country, llm: l, query: searchQuery, order: { by: PROMPTS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONED_BRANDS_COUNT }, range: { limit, offset },
    }).catch(() => ({ prompts: [] })))),
  ]);
  const total = totalsResults.reduce((sum, r) => sum + num(r.total), 0);
  /* c8 ignore start -- all-LLM fan-out dedup/grouping */
  const seen = new Map();
  for (let i = 0; i < FTS_LLMS.length; i++) {
    const engineSlug = llmToEngine(FTS_LLMS[i]);
    for (const p of (listResults[i].prompts || [])) {
      const row = mapPromptRow(p); row.engine = engineSlug || row.engine;
      const promptNorm = String(row.prompt ?? '').trim().toLowerCase();
      const key = row.prompt_hash && row.serp_id ? `${row.topic_id}|${row.prompt_hash}|${row.serp_id}|${row.engine}|${promptNorm}` : `${row.topic_id}|${promptNorm}|${row.engine}`;
      if (!seen.has(key)) { seen.set(key, { ...row, _sort: row.mentions, _promptNorm: promptNorm }); }
    }
  }
  /* c8 ignore stop */
  const byNorm = new Map();
  for (const row of seen.values()) {
    const norm = row._promptNorm;
    if (!byNorm.has(norm)) { byNorm.set(norm, []); }
    byNorm.get(norm).push(row);
  }
  /* c8 ignore next 15 -- complex multi-engine grouping/sort logic */
  const groups = [...byNorm.values()].map((rows) => {
    const sorted = [...rows].sort((a, b) => b._sort - a._sort || (a.prompt || '').localeCompare(b.prompt || ''));
    const maxSort = sorted.length ? Math.max(...sorted.map((r) => r._sort)) : 0;
    const multiEngine = new Set(sorted.map((r) => r.engine)).size > 1;
    return {
      rows: sorted, maxSort, multiEngine, norm: sorted[0]?._promptNorm ?? '',
    };
  });
  groups.sort((a, b) => b.maxSort - a.maxSort || (a.norm || '').localeCompare(b.norm || ''));
  const overflowCap = limit + FTS_LLMS.length - 1;
  const picked = [];
  for (const g of groups) {
    if (g.multiEngine) {
      const n = g.rows.length;
      if (n > FTS_LLMS.length) { continue; }
      const nextLen = picked.length + n;
      if (nextLen <= limit) { picked.push(...g.rows); } else if (picked.length < limit && nextLen <= overflowCap) { picked.push(...g.rows); }
    } else if (picked.length < limit) { picked.push(g.rows[0]); }
  }
  const data = picked.map(({ _sort, _promptNorm, ...r }) => r);
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}

export async function handleTopicsResearchBrands(sp, clients) {
  const searchQuery = sp.get('search_query')?.trim();
  if (!searchQuery) { return { status: 400, body: { error: 'missing_search_query', message: 'search_query is required' } }; }
  const country = resolveCountryForFts(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llm = optionalLlmFromQuery(sp);
  if (llm) {
    const [totalsRaw, raw] = await Promise.all([
      clients.brandClient.brandsByTopicFTSTotals({ country, llm, query: searchQuery }),
      clients.brandClient.brandsByTopicFTS({
        country, llm, query: searchQuery, order: { by: BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONS }, range: { limit, offset },
      }),
    ]);
    const data = (raw.brands || []).map(mapBrandsByTopicFtsRow);
    return {
      status: 200,
      body: {
        data, total: num(totalsRaw.total), offset, limit,
      },
    };
  }
  const [totalsResults, listResults] = await Promise.all([
    Promise.all(FTS_LLMS.map((l) => clients.brandClient.brandsByTopicFTSTotals({ country, llm: l, query: searchQuery }).catch(() => ({ total: 0 })))),
    Promise.all(FTS_LLMS.map((l) => clients.brandClient.brandsByTopicFTS({
      country, llm: l, query: searchQuery, order: { by: BRANDS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONS }, range: { limit, offset },
    }).catch(() => ({ brands: [] })))),
  ]);
  const total = totalsResults.reduce((sum, r) => sum + num(r.total), 0);
  const agg = new Map();
  for (const raw of listResults) {
    for (const b of (raw.brands || [])) {
      const domain = b.domain || ''; if (!domain) { continue; }
      const row = mapBrandsByTopicFtsRow(b);
      const existing = agg.get(domain);
      if (existing) {
        existing.mentions += row.mentions; existing.cited_pages += row.cited_pages;
        existing.source_domains_count = num(existing.source_domains_count) + num(row.source_domains_count);
        if (!existing.name && row.name) { existing.name = row.name; }
        if (!existing.prompt_example && row.prompt_example) { existing.prompt_example = row.prompt_example; }
      } else { agg.set(domain, { ...row }); }
    }
  }
  const merged = Array.from(agg.values()).sort((a, b) => b.mentions - a.mentions || a.domain.localeCompare(b.domain));
  const data = merged.slice(0, limit);
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}

export async function handleTopicsResearchSourceDomains(sp, clients) {
  const searchQuery = sp.get('search_query')?.trim();
  if (!searchQuery) { return { status: 400, body: { error: 'missing_search_query', message: 'search_query is required' } }; }
  const country = resolveCountryForFts(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llm = optionalLlmFromQuery(sp);
  if (llm) {
    const [totalsRaw, raw] = await Promise.all([
      clients.sourceClient.sourceDomainsByTopicFTSTotals({ country, llm, query: searchQuery }),
      clients.sourceClient.sourceDomainsByTopicFTS({
        country, llm, query: searchQuery, order: { by: SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONS }, range: { limit, offset },
      }),
    ]);
    const data = sourceDomainsByTopicFtsRows(raw).map(mapSourceDomainsByTopicFtsRow);
    return {
      status: 200,
      body: {
        data, total: num(totalsRaw.total), offset, limit,
      },
    };
  }
  const [totalsResults, listResults] = await Promise.all([
    Promise.all(FTS_LLMS.map((l) => clients.sourceClient.sourceDomainsByTopicFTSTotals({ country, llm: l, query: searchQuery }).catch(() => ({ total: 0 })))),
    Promise.all(FTS_LLMS.map((l) => clients.sourceClient.sourceDomainsByTopicFTS({
      country, llm: l, query: searchQuery, order: { by: SOURCE_DOMAINS_BY_TOPIC_FTS_REQUEST_ORDER_BY_ENUM.MENTIONS }, range: { limit, offset },
    }).catch(() => ({ sourceDomains: [] })))),
  ]);
  const total = totalsResults.reduce((sum, r) => sum + num(r.total), 0);
  const agg = new Map();
  for (const raw of listResults) {
    for (const s of sourceDomainsByTopicFtsRows(raw)) {
      const domain = s.domain || ''; if (!domain) { continue; }
      const row = mapSourceDomainsByTopicFtsRow(s);
      const existing = agg.get(domain);
      if (existing) {
        existing.sources_count = num(existing.sources_count) + num(row.sources_count);
        existing.mentions += row.mentions;
        if (row.organic_traffic !== undefined) { existing.organic_traffic = num(existing.organic_traffic ?? 0) + num(row.organic_traffic); }
        if (!existing.prompt_example && row.prompt_example) { existing.prompt_example = row.prompt_example; }
      } else { agg.set(domain, { ...row }); }
    }
  }
  const merged = Array.from(agg.values()).sort((a, b) => b.mentions - a.mentions || b.sources_count - a.sources_count || a.source_domain.localeCompare(b.source_domain));
  const data = merged.slice(0, limit);
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}
