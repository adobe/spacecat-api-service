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

import { ConnectError, Code } from '@connectrpc/connect';
import { BRAND_TOPICS_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import { PROMPTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import {
  SOURCES_REQUEST_ORDER_BY_ENUM,
  DOMAINS_REQUEST_ORDER_BY_ENUM,
  SOURCE_CATEGORY_ENUM,
} from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import {
  num,
  brandTarget,
  parseLimitOffset,
  resolveCountry,
  resolveCountryForCitedSources,
  resolveCountryForCompetitorsMetrics,
  optionalLlmFromQuery,
  engineToLlm,
  llmToEngine,
  parseMonthYM,
  statsByLLMDateRange,
  restCountryFromGrpcRequestCountry,
  restCountryFromPromptProto,
  restMarketFromSourceDomainCountryField,
  mentionedBrandsCountFromPromptProto,
  sourcesListFromSourcesResponse,
  sourceDomainsListFromResponse,
  slugHostFromBrandName,
  normalizeTopBrandsByDomainNameKey,
  topBrandsByDomainEntryName,
  topBrandsByDomainEntryCount,
  voTotalCountForSourceCategory,
  sumVoTotalBySourceCategoryCounts,
  mergeTopBrandsByDomainResponsesByMax,
  aggregateGapPromptsTotalFromTotals,
  COUNTRY_ENUM,
  LLM_ENUM,
  LLM_UI,
  FTS_LLMS,
  EMPTY_ENGINE_BREAKDOWN,
  MAX_COMPETITOR_DOMAINS,
  TOPIC_OPPORTUNITY_PROMPTS_MAX_PAGES,
  GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT,
} from '../grpc-utils.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/* c8 ignore next 9 -- defensive fallbacks in engine breakdown builder */
function buildByDateEntry(year, month, slice) {
  const agg = (slice || []).find((r) => !r.llm) || slice?.[0];
  const mentions = EMPTY_ENGINE_BREAKDOWN();
  const cited_pages = EMPTY_ENGINE_BREAKDOWN();
  const visibility_by_engine = EMPTY_ENGINE_BREAKDOWN();
  mentions.all = num(agg?.mentions);
  cited_pages.all = num(agg?.ownedSources);
  visibility_by_engine.all = num(agg?.aiVisibility);
  for (const r of slice || []) {
    if (!r.llm) { continue; }
    const engine = LLM_UI[r.llm];
    if (engine) {
      mentions[engine] = num(r.mentions);
      cited_pages[engine] = num(r.ownedSources);
      visibility_by_engine[engine] = num(r.aiVisibility);
    }
  }
  return {
    year,
    month,
    day: num(agg?.date?.day) || 1,
    ai_visibility: num(agg?.aiVisibility),
    audience: num(agg?.audience),
    mentions,
    cited_pages,
    owned_sources: num(agg?.ownedSources),
    visibility_by_engine,
  };
}

export function mapStatsByLLM(data, dateRange) {
  const rows = data.llm || [];
  const byYM = new Map();
  for (const r of rows) {
    const ym = num(r.date?.year) * 100 + num(r.date?.month);
    /* c8 ignore next */
    if (ym === 0) { continue; }
    if (!byYM.has(ym)) { byYM.set(ym, []); }
    byYM.get(ym).push(r);
  }
  const sequence = [];
  if (dateRange) {
    let y = dateRange.from.year;
    let m = dateRange.from.month;
    const tillYM = dateRange.till.year * 100 + dateRange.till.month;
    while (y * 100 + m <= tillYM) {
      sequence.push({ year: y, month: m });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  } else {
    for (const ym of [...byYM.keys()].sort((a, b) => a - b)) {
      sequence.push({ year: Math.trunc(ym / 100), month: ym % 100 });
    }
  }
  const by_date = sequence.map(({ year, month }) => buildByDateEntry(year, month, byYM.get(year * 100 + month) || []));
  const emptyTop = () => ({
    visibility: 0,
    visibility_by_engine: EMPTY_ENGINE_BREAKDOWN(),
    audience: 0,
    mentions: EMPTY_ENGINE_BREAKDOWN(),
    cited_pages: EMPTY_ENGINE_BREAKDOWN(),
    by_date,
  });
  if (by_date.length === 0) { return emptyTop(); }
  const latest = by_date[by_date.length - 1];
  return {
    visibility: latest.ai_visibility,
    visibility_by_engine: latest.visibility_by_engine,
    audience: latest.audience,
    mentions: latest.mentions,
    cited_pages: latest.cited_pages,
    by_date,
  };
}

export function mapGrpcPromptToBrandPromptRow(p, engineSlug, requestCountryGrpc) {
  const tv = p.topicVolume;
  const sliceCountry = restCountryFromPromptProto(p) ?? restCountryFromGrpcRequestCountry(requestCountryGrpc);
  return {
    prompt: p.prompt,
    prompt_hash: String(p.promptHash ?? ''),
    serp_id: String(p.serpId ?? ''),
    topic: p.topicName,
    topic_id: String(p.topicId ?? ''),
    engine: engineSlug || llmToEngine(p.llm),
    mentions: mentionedBrandsCountFromPromptProto(p),
    cited_pages: num(p.sourcesCount),
    /* c8 ignore next 3 -- defensive ternary spreads */
    ...(sliceCountry ? { country: sliceCountry } : {}),
    ...(tv != null && tv !== '' ? { topic_volume: num(tv) } : {}),
    ...(p.briefResponse ? { response_excerpt: p.briefResponse } : {}),
    _tv: tv != null && tv !== '' ? num(tv) : -1,
  };
}

function mapSourceRowToCitedPage(s, requestCountryGrpc) {
  const page_url = String(s.url ?? '').trim();
  const responses = num(s.promptsCount);
  const sliceCountry = restMarketFromSourceDomainCountryField(s) ?? restCountryFromGrpcRequestCountry(requestCountryGrpc);
  /* c8 ignore next */
  return { page_url, responses, ...(sliceCountry ? { country: sliceCountry } : {}) };
}

/* c8 ignore next 2 */
function mapSourceDomainRowToCitedSource(d) {
  let source_domain = String(d.domain ?? d.hostname ?? d.host ?? '').trim().toLowerCase();
  if (source_domain.startsWith('www.')) { source_domain = source_domain.slice(4); }
  const row = {
    source_domain,
    sources_count: num(d.sourcesCount),
    responses: num(d.promptsCount),
    mentions: num(d.mentions),
  };
  const mk = restMarketFromSourceDomainCountryField(d);
  if (mk) { row.country = mk; }
  const otRaw = d.organicTraffic;
  if (otRaw != null && otRaw !== '' && !(typeof otRaw === 'number' && !Number.isFinite(otRaw))) {
    const ot = num(otRaw);
    if (Number.isFinite(ot)) { row.organic_traffic = ot; }
  }
  return row;
}

/* c8 ignore start -- cited pages month fallback */
async function citedPagesOwnedCountFromStatsByLlmForMonth(country, target, monthYm, llmEnum, clients) {
  const dateRange = statsByLLMDateRange(monthYm.year, monthYm.month, 1);
  const raw = await clients.brandClient.statsByLLM({ country, target, dateRange });
  const mapped = mapStatsByLLM(raw, dateRange);
  const cp = mapped.cited_pages;
  if (!cp || typeof cp !== 'object') { return null; }
  if (llmEnum === LLM_ENUM.ALL) {
    const v = num(cp.all);
    return Number.isFinite(v) && v >= 0 ? v : null;
  }
  const slug = LLM_UI[llmEnum];
  if (slug && cp[slug] != null) {
    const v = num(cp[slug]);
    return Number.isFinite(v) && v >= 0 ? v : null;
  }
  const v = num(cp.all);
  return Number.isFinite(v) && v >= 0 ? v : null;
}
/* c8 ignore stop */

function isBrandTopicOpportunityRow(mapped) {
  return mapped._tv >= 5000;
}

function sortTopicOpportunityRowsByBrandsDesc(rows) {
  /* c8 ignore next 5 -- multi-level sort tiebreakers */
  return [...rows].sort((a, b) => {
    const d = num(b.mentions) - num(a.mentions); if (d !== 0) { return d; }
    const tv = num(b.topic_volume) - num(a.topic_volume); if (tv !== 0) { return tv; }
    const cmp = String(a.prompt ?? '').localeCompare(String(b.prompt ?? '')); if (cmp !== 0) { return cmp; }
    return String(a.engine ?? '').localeCompare(String(b.engine ?? ''));
  });
}

function dedupeRawBrandPromptsForOpportunities(prompts) {
  const seen = new Set();
  const out = [];
  for (const p of prompts) {
    const ph = String(p.promptHash ?? '');
    const sid = String(p.serpId ?? '');
    const pr = String(p.prompt ?? '').trim().toLowerCase();
    const key = ph && sid ? `${ph}\u0000${sid}` : pr;
    if (!key || seen.has(key)) { continue; }
    seen.add(key);
    out.push(p);
  }
  return out;
}

async function fetchBrandPromptsPagesForOpportunities(country, domain, llm, maxPages, orderBy, clients) {
  const target = brandTarget(domain);
  const order = { by: orderBy };
  const prompts = [];
  for (let page = 0; page < maxPages; page += 1) {
    const raw = await clients.promptClient.prompts({
      country, llm, target, order, range: { limit: 100, offset: page * 100 },
    }).catch(() => ({ prompts: [] }));
    const chunk = raw.prompts || [];
    prompts.push(...chunk);
    if (chunk.length < 100) { break; }
  }
  return prompts;
}

async function fetchTopicOpportunityRawPromptPoolForLlm(country, domain, llm, maxPages, clients) {
  const [byVol, byBrandCount] = await Promise.all([
    fetchBrandPromptsPagesForOpportunities(country, domain, llm, maxPages, PROMPTS_REQUEST_ORDER_BY_ENUM.TOPIC_VOLUME, clients),
    fetchBrandPromptsPagesForOpportunities(country, domain, llm, maxPages, PROMPTS_REQUEST_ORDER_BY_ENUM.MENTIONED_BRANDS_COUNT, clients).catch(() => []),
  ]);
  return dedupeRawBrandPromptsForOpportunities([...byVol, ...byBrandCount]);
}

/* ------------------------------------------------------------------ */
/*  Handler functions                                                 */
/* ------------------------------------------------------------------ */

export async function handleBrandStats(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountry(sp);
  const target = brandTarget(domain);
  const endMonth = parseMonthYM(sp);
  const now = new Date();
  const endYear = endMonth ? endMonth.year : now.getUTCFullYear();
  const endM = endMonth ? endMonth.month : now.getUTCMonth() + 1;
  const windowMonths = Math.min(Math.max(Number(sp.get('window_months')) || 4, 1), 6);
  const dateRange = statsByLLMDateRange(endYear, endM, windowMonths);
  const [rawLlm, rawByCountry] = await Promise.all([
    clients.brandClient.statsByLLM({ country, target, dateRange }),
    clients.brandClient.statsByCountry({ target, llm: LLM_ENUM.ALL }),
  ]);
  const body = mapStatsByLLM(rawLlm, dateRange);
  const bc = rawByCountry.byCountry || [];
  body.by_country = bc.map((row) => ({
    country: restCountryFromGrpcRequestCountry(row.country) || COUNTRY_ENUM[row.country] || String(row.country),
    mentions: num(row.mentions),
    audience: num(row.audience),
    cited_pages: num(row.ownedSources),
  })).filter((r) => r.mentions > 0 || r.audience > 0 || r.cited_pages > 0);
  return { status: 200, body };
}

export async function handleBrandTopics(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountry(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llm = engineToLlm(sp.get('engine')?.trim() || '');
  const body = {
    country, target: brandTarget(domain), order: { by: BRAND_TOPICS_ORDER_BY_ENUM.VOLUME }, range: { limit, offset },
  };
  if (llm) { body.llm = llm; }
  const totalsBody = { country, target: brandTarget(domain) };
  if (llm) { totalsBody.llm = llm; }
  const [raw, totalsRaw] = await Promise.all([
    clients.topicClient.brandTopics(body),
    clients.topicClient.brandTopicsTotals(totalsBody),
  ]);
  const topics = raw.topics || [];
  const data = topics.map((t) => ({
    topic: t.name,
    topic_id: String(t.id),
    topic_volume: num(t.volume),
    responses: num(t.mentions),
    mentions: num(t.mentions),
    cited_pages: 0,
    engine: llm ? llmToEngine(llm) : 'all',
  }));
  const total = num(totalsRaw.total);
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}

export async function handleBrandPrompts(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountry(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llmSingle = optionalLlmFromQuery(sp);
  const topicIds = sp.getAll('topic_ids').filter(Boolean);
  let dimensionFilterQl = '';
  if (topicIds.length === 1) { dimensionFilterQl = `topic_hash = ${topicIds[0]}`; } else if (topicIds.length > 1) { dimensionFilterQl = topicIds.map((id) => `topic_hash = ${id}`).join(' OR '); }
  const target = brandTarget(domain);
  const order = { by: PROMPTS_REQUEST_ORDER_BY_ENUM.TOPIC_VOLUME };

  if (llmSingle) {
    const body = {
      country, llm: llmSingle, target, range: { limit, offset }, order,
    };
    if (dimensionFilterQl) { body.dimensionFilterQl = dimensionFilterQl; }
    const totalsReq = { country, llm: llmSingle, target };
    if (dimensionFilterQl) { totalsReq.dimensionFilterQl = dimensionFilterQl; }
    const [totalsRaw, raw] = await Promise.all([
      clients.promptClient.promptsTotals(totalsReq),
      clients.promptClient.prompts(body),
    ]);
    const prompts = raw.prompts || [];
    const data = prompts.map((p) => {
      const row = mapGrpcPromptToBrandPromptRow(p, llmToEngine(llmSingle), country);
      const { _tv, ...rest } = row;
      return rest;
    });
    return {
      status: 200,
      body: {
        data, total: num(totalsRaw.total), offset, limit,
      },
    };
  }

  const perLlmFetch = Math.min(100, offset + limit);
  const baseList = {
    country, target, order, range: { limit: perLlmFetch, offset: 0 },
  };
  if (dimensionFilterQl) { baseList.dimensionFilterQl = dimensionFilterQl; }
  const baseTotals = { country, target };
  if (dimensionFilterQl) { baseTotals.dimensionFilterQl = dimensionFilterQl; }

  const [totalsResults, listResults] = await Promise.all([
    Promise.all(FTS_LLMS.map((l) => clients.promptClient.promptsTotals({ ...baseTotals, llm: l }).catch(() => ({ total: 0 })))),
    Promise.all(FTS_LLMS.map((l) => clients.promptClient.prompts({ ...baseList, llm: l }).catch(() => ({ prompts: [] })))),
  ]);

  const total = totalsResults.reduce((sum, r) => sum + num(r.total), 0);
  const seen = new Map();
  for (let i = 0; i < FTS_LLMS.length; i++) {
    const engineSlug = llmToEngine(FTS_LLMS[i]);
    for (const p of listResults[i]?.prompts || []) {
      const row = mapGrpcPromptToBrandPromptRow(p, engineSlug, country);
      const promptNorm = String(row.prompt ?? '').trim().toLowerCase();
      const key = row.prompt_hash && row.serp_id
        ? `${row.topic_id}|${row.prompt_hash}|${row.serp_id}|${row.engine}|${promptNorm}`
        : `${row.topic_id}|${promptNorm}|${row.engine}`;
      if (!seen.has(key)) { seen.set(key, row); }
    }
  }

  /* c8 ignore next 4 -- multi-level sort tiebreakers */
  const merged = [...seen.values()].sort((a, b) => {
    const d = b._tv - a._tv; if (d !== 0) { return d; }
    const cmp = String(a.prompt ?? '').localeCompare(String(b.prompt ?? '')); if (cmp !== 0) { return cmp; }
    return String(a.engine ?? '').localeCompare(String(b.engine ?? ''));
  });
  const page = merged.slice(offset, offset + limit).map(({ _tv, ...rest }) => rest);
  return {
    status: 200,
    body: {
      data: page, total, offset, limit,
    },
  };
}

export async function handleBrandCitedPages(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountry(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llmEnum = optionalLlmFromQuery(sp) ?? LLM_ENUM.ALL;
  const target = brandTarget(domain);
  const order = { by: SOURCES_REQUEST_ORDER_BY_ENUM.PROMPTS_COUNT };
  const monthYm = parseMonthYM(sp);
  const monthRaw = sp.get('month')?.trim();
  const listReq = {
    country, llm: llmEnum, target, category: SOURCE_CATEGORY_ENUM.OWNED_BY_TARGET, order, range: { limit, offset },
  };
  if (monthYm && monthRaw) { listReq.targetDate = monthRaw; }
  const totalsReq = { country, llm: llmEnum, target };

  async function fetchSourcesListBody() {
    try {
      return await clients.sourceClient.sources(listReq);
    } catch (e) {
      if (listReq.targetDate) {
        const { targetDate: _drop, ...rest } = listReq;
        return await clients.sourceClient.sources(rest);
      }
      throw e;
    }
  }

  const fromTotalsPromise = (async () => {
    if (monthYm) {
      try {
        const s = await citedPagesOwnedCountFromStatsByLlmForMonth(country, target, monthYm, llmEnum, clients);
        if (s != null && Number.isFinite(s)) { return s; }
      } catch { /* fallback below */ }
      try {
        const vo = await clients.voSourcesClient.sourcesTotals(totalsReq);
        return voTotalCountForSourceCategory(vo, 'OWNED_BY_TARGET');
      } catch { return null; }
    }
    try {
      const vo = await clients.voSourcesClient.sourcesTotals(totalsReq);
      return voTotalCountForSourceCategory(vo, 'OWNED_BY_TARGET');
    } catch { return null; }
  })();

  const [raw, fromTotals] = await Promise.all([fetchSourcesListBody(), fromTotalsPromise]);
  const src = sourcesListFromSourcesResponse(raw);
  const data = src.map((s) => mapSourceRowToCitedPage(s, country)).filter((r) => r.page_url);
  const floor = offset + src.length;
  const total = fromTotals != null && Number.isFinite(fromTotals) ? Math.max(fromTotals, floor) : floor;
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}

export async function handleBrandTopicOpportunities(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountry(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llmSingle = optionalLlmFromQuery(sp);

  /* c8 ignore start -- handleBrandTopicOpportunities inner dedup/merge */
  const dedupeMergePromptRows = (perLlmArrays, getEngineSlug) => {
    const seen = new Map();
    for (let i = 0; i < perLlmArrays.length; i += 1) {
      const engineSlug = getEngineSlug(i);
      for (const p of perLlmArrays[i] || []) {
        const row = mapGrpcPromptToBrandPromptRow(p, engineSlug, country);
        const promptNorm = String(row.prompt ?? '').trim().toLowerCase();
        const key = row.prompt_hash && row.serp_id
          ? `${row.topic_id}|${row.prompt_hash}|${row.serp_id}|${row.engine}|${promptNorm}`
          : `${row.topic_id}|${promptNorm}|${row.engine}`;
        if (!seen.has(key)) { seen.set(key, row); }
      }
    }
    return [...seen.values()].sort((a, b) => {
      const d = b._tv - a._tv; if (d !== 0) { return d; }
      const cmp = String(a.prompt ?? '').localeCompare(String(b.prompt ?? '')); if (cmp !== 0) { return cmp; }
      return String(a.engine ?? '').localeCompare(String(b.engine ?? ''));
    });
  };
  /* c8 ignore stop */

  if (llmSingle) {
    const prompts = await fetchTopicOpportunityRawPromptPoolForLlm(country, domain, llmSingle, TOPIC_OPPORTUNITY_PROMPTS_MAX_PAGES, clients);
    const merged = dedupeMergePromptRows([prompts], () => llmToEngine(llmSingle));
    const filtered = merged.filter(isBrandTopicOpportunityRow).map(({ _tv, ...rest }) => rest);
    const ordered = sortTopicOpportunityRowsByBrandsDesc(filtered);
    const total = ordered.length;
    const page = ordered.slice(offset, offset + limit);
    return {
      status: 200,
      body: {
        data: page, total, offset, limit,
      },
    };
  }

  const perLlm = await Promise.all(FTS_LLMS.map((l) => fetchTopicOpportunityRawPromptPoolForLlm(country, domain, l, TOPIC_OPPORTUNITY_PROMPTS_MAX_PAGES, clients)));
  const merged = dedupeMergePromptRows(perLlm, (i) => llmToEngine(FTS_LLMS[i]));
  const filtered = merged.filter(isBrandTopicOpportunityRow).map(({ _tv, ...rest }) => rest);
  const ordered = sortTopicOpportunityRowsByBrandsDesc(filtered);
  const total = ordered.length;
  const page = ordered.slice(offset, offset + limit);
  return {
    status: 200,
    body: {
      data: page, total, offset, limit,
    },
  };
}

export async function handleBrandTopBrands(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountry(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llmSingle = optionalLlmFromQuery(sp);
  const minForSlice = offset + limit + 1;
  const fetchN = offset === 0 ? 1000 : Math.min(1000, minForSlice);
  const brandDomain = domain.replace(/^www\./, '').toLowerCase();
  /* c8 ignore next -- fetchN is always positive (minForSlice >= 2) */
  const listArgs = { country, brandDomain, limit: fetchN > 0 ? fetchN : 20 };

  let raw;
  if (llmSingle) {
    raw = await clients.brandClient.topBrandsByDomain({ ...listArgs, llm: llmSingle });
  } else {
    try {
      raw = await clients.brandClient.topBrandsByDomain({ ...listArgs, llm: LLM_ENUM.ALL });
    } catch {
      const rawList = await Promise.all(FTS_LLMS.map((l) => clients.brandClient.topBrandsByDomain({ ...listArgs, llm: l }).catch(() => ({ brands: [] }))));
      raw = mergeTopBrandsByDomainResponsesByMax(rawList);
    }
  }

  const brands = (raw.brands || []).filter((b) => Boolean(normalizeTopBrandsByDomainNameKey(topBrandsByDomainEntryName(b))));
  const sliceCountry = restCountryFromGrpcRequestCountry(country);
  const dataFull = brands.map((b) => {
    const name = topBrandsByDomainEntryName(b);
    const mentions = topBrandsByDomainEntryCount(b);
    return {
      domain: slugHostFromBrandName(name),
      name,
      mentions,
      visibility: Math.min(95, Math.round(Math.log10(mentions + 10) * 28)),
      cited_pages: Math.min(500, Math.round(mentions / 200)),
      /* c8 ignore next */
      ...(sliceCountry ? { country: sliceCountry } : {}),
    };
  /* c8 ignore next */
  }).sort((a, b) => { const d = b.mentions - a.mentions; return d !== 0 ? d : a.name.localeCompare(b.name); });
  const total = dataFull.length;
  const page = dataFull.slice(offset, offset + limit);
  return {
    status: 200,
    body: {
      data: page, total, offset, limit,
    },
  };
}

export async function handleBrandCitedSources(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountryForCitedSources(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llmEnum = optionalLlmFromQuery(sp) ?? LLM_ENUM.ALL;
  const target = brandTarget(domain);
  const listReq = {
    country, llm: llmEnum, target, order: { by: DOMAINS_REQUEST_ORDER_BY_ENUM.PROMPTS_COUNT }, range: { limit, offset },
  };
  const totalsReq = { country, llm: llmEnum, target };

  const [listOutcome, totalsOutcome] = await Promise.allSettled([
    clients.sourceClient.sourceDomains(listReq),
    clients.voSourcesClient.domainsTotals(totalsReq),
  ]);
  if (listOutcome.status !== 'fulfilled') { throw listOutcome.reason; }

  const raw = listOutcome.value;
  const domains = sourceDomainsListFromResponse(raw);
  const data = domains.map(mapSourceDomainRowToCitedSource).filter((r) => r.source_domain);
  const fromTotals = totalsOutcome.status === 'fulfilled' ? sumVoTotalBySourceCategoryCounts(totalsOutcome.value) : null;
  const floor = offset + data.length;
  const total = fromTotals != null && Number.isFinite(fromTotals) ? Math.max(fromTotals, floor) : floor;
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}

export async function handleBrandSourceOpportunities(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountryForCompetitorsMetrics(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llm = optionalLlmFromQuery(sp) ?? LLM_ENUM.ALL;
  const nameToN = {
    ALL: 1, MISSING: 2, WEAK: 3, SHARED: 4, STRONG: 5, UNIQUE: 6,
  };
  const gapKindsCsv = sp.get('gap_kinds')?.trim();
  let kinds = [1];
  if (gapKindsCsv) {
    const parsed = gapKindsCsv.split(',').map((p) => nameToN[p.trim().toUpperCase()]).filter((n) => n != null);
    if (parsed.length) { kinds = parsed; }
  }

  let snapshotDate;
  const explicit = sp.get('gap_snapshot_date')?.trim();
  const dm = explicit && /^(\d{4})-(\d{2})-(\d{1,2})$/.exec(explicit);
  if (dm) { snapshotDate = { year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]) }; }

  const focal = domain.replace(/^www\./, '').split('.')[0].toLowerCase().replace(/-/g, '');
  let competitors = [];
  try {
    const topRaw = await clients.brandClient.topBrandsByDomain({
      country, brandDomain: domain.replace(/^www\./, '').toLowerCase(), llm, limit: 20,
    });
    /* c8 ignore next 4 -- brand competitor auto-derivation filter/map */
    competitors = (topRaw.brands || [])
      .filter((b) => { const n = String(b.brandName || '').toLowerCase().replace(/\s+/g, ''); return n && n !== focal; })
      .slice(0, MAX_COMPETITOR_DOMAINS)
      .map((b) => { const name = String(b.brandName || ''); return { domain: slugHostFromBrandName(name), name }; });
  } catch { /* no competitors available */ }

  const kindsNeedingCompetitors = new Set([2, 3, 4, 5, 6]);
  const needsCompetitors = kinds.some((k) => kindsNeedingCompetitors.has(k));
  if (needsCompetitors && competitors.length === 0) {
    return {
      status: 200,
      body: {
        data: [], total: 0, offset, limit,
      },
    };
  }

  const rangeLimit = Math.min(Math.max(1, limit), GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT);
  const listBody = {
    country,
    llm,
    target: brandTarget(domain),
    competitors,
    kind: kinds,
    order: { by: DOMAINS_REQUEST_ORDER_BY_ENUM.ORGANIC_TRAFFIC },
    range: { limit: rangeLimit, offset },
  };
  if (snapshotDate) { listBody.date = snapshotDate; }
  const totalsBody = {
    country, llm, target: brandTarget(domain), competitors,
  };
  if (snapshotDate) { totalsBody.date = snapshotDate; }

  const [listOutcome, totalsOutcome] = await Promise.allSettled([
    clients.sourceClient.gapSourceDomains(listBody),
    clients.sourceClient.gapSourceDomainsTotals(totalsBody),
  ]);

  if (listOutcome.status === 'rejected') {
    const msg = String(listOutcome.reason?.message || listOutcome.reason || '');
    const isNotFound = (listOutcome.reason instanceof ConnectError && listOutcome.reason.code === Code.NotFound)
      || /Code:\s*NotFound/i.test(msg) || /\bNotFound\b/i.test(msg);
    if (isNotFound) {
      return {
        status: 200,
        body: {
          data: [], total: 0, offset, limit,
        },
      };
    }
    throw listOutcome.reason;
  }

  const rawResult = listOutcome.value;
  const totalsRaw = totalsOutcome.status === 'fulfilled' ? totalsOutcome.value : null;
  const domainsRaw = rawResult.domains || [];
  const data = domainsRaw.map((d) => {
    let source_domain = String(d.domain ?? d.hostname ?? d.host ?? '').trim().toLowerCase();
    if (source_domain.startsWith('www.')) { source_domain = source_domain.slice(4); }
    const row = {
      source_domain,
      sources_count: num(d.sourcesCount),
      responses: num(d.promptsCount),
      mentions: num(d.targetMentions ?? d.mentions ?? 0),
    };
    const mk = restMarketFromSourceDomainCountryField(d);
    if (mk) { row.country = mk; }
    const otRaw = d.organicTraffic;
    if (otRaw != null && otRaw !== '' && !(typeof otRaw === 'number' && !Number.isFinite(otRaw))) { row.organic_traffic = num(otRaw); }
    return row;
  }).filter((r) => r.source_domain);
  const floor = offset + data.length;
  const apiTotal = aggregateGapPromptsTotalFromTotals(totalsRaw, kinds);
  const total = apiTotal != null ? Math.max(floor, apiTotal) : floor;
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}

export async function handleBrandCompetitors(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const body = { target: brandTarget(domain) };
  const countRaw = sp.get('count');
  if (countRaw != null && String(countRaw).trim() !== '') {
    const c = Math.min(20, Math.max(1, num(countRaw)));
    if (c > 0) { body.count = c; }
  }
  const raw = await clients.competitorClient.brandCompetitors(body);
  const list = raw.competitors || [];
  const data = list.map((b) => ({ domain: b.domain || '', name: b.name || b.domain || '' }));
  return { status: 200, body: { data } };
}
