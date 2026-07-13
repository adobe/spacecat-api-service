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

import { ConnectError, Code } from '@connectrpc/connect';
import { BRAND_TOPICS_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import { PROMPTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import { ORDER_DIRECTION_ENUM } from '@quazar/ai-seo-ts/common/types_pb.js';
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
  resolveTopicIdsDimensionFilter,
  COUNTRY_ENUM,
  LLM_ENUM,
  LLM_UI,
  FTS_LLMS,
  EMPTY_ENGINE_BREAKDOWN,
  MAX_COMPETITOR_DOMAINS,
  TOPIC_OPPORTUNITY_PROMPTS_MAX_PAGES,
  GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT,
  settledValueOrElse,
  settledFulfilledMap,
} from '../grpc-utils.js';

/* c8 ignore start -- branch fan-out / defensive paths; see test/support/ai-visibility/handlers/brands.test.js */
/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function buildByDateEntry(year, month, slice) {
  const agg = (slice || []).find((r) => !r.llm) || slice?.[0];
  const mentions = EMPTY_ENGINE_BREAKDOWN();
  const citedPages = EMPTY_ENGINE_BREAKDOWN();
  const visibilityByEngine = EMPTY_ENGINE_BREAKDOWN();
  mentions.all = num(agg?.mentions);
  citedPages.all = num(agg?.ownedSources);
  visibilityByEngine.all = num(agg?.aiVisibility);
  for (const r of slice || []) {
    if (r.llm) {
      const engine = LLM_UI[r.llm];
      if (engine) {
        mentions[engine] = num(r.mentions);
        citedPages[engine] = num(r.ownedSources);
        visibilityByEngine[engine] = num(r.aiVisibility);
      }
    }
  }
  return {
    year,
    month,
    day: num(agg?.date?.day) || 1,
    aiVisibility: num(agg?.aiVisibility),
    audience: num(agg?.audience),
    mentions,
    citedPages,
    ownedSources: num(agg?.ownedSources),
    visibilityByEngine,
  };
}

/**
 * Resolves gRPC list ordering from `sortBy`/`sortDirection` query params.
 * `sortBy` is matched against the given order-by enum's member names (e.g.
 * `PROMPTS_COUNT`, `URL`, `DOMAIN`); unknown or `UNSPECIFIED` values fall back
 * to `defaultBy`. Direction defaults to DESC (matching the previous fixed order
 * the client displayed via its now-removed client-side sort). Returns a
 * `{ by, direction }` object for the request `order`.
 */
function resolveGrpcSortOrder(sp, orderByEnum, defaultBy) {
  // Unlike `resolveFtsSort` in topics.js (which 400s on an unrecognized sort value),
  // this deliberately falls back to the default — matched by the OpenAPI docs
  // ("Unknown values fall back to the default"). Keep it lenient; don't "fix" it to throw.
  // `sortBy` is matched case-insensitively (enum member names are uppercase).
  const byKey = sp.get('sortBy')?.trim()?.toUpperCase();
  const mappedBy = byKey ? orderByEnum[byKey] : undefined;
  const by = (typeof mappedBy === 'number' && mappedBy > 0) ? mappedBy : defaultBy;
  const dirKey = sp.get('sortDirection')?.trim()?.toUpperCase();
  const mappedDir = dirKey ? ORDER_DIRECTION_ENUM[dirKey] : undefined;
  const direction = (typeof mappedDir === 'number' && mappedDir > 0)
    ? mappedDir : ORDER_DIRECTION_ENUM.DESC;
  return { by, direction };
}

export function mapStatsByLLM(data, dateRange) {
  const rows = data.llm || [];
  const byYM = new Map();
  for (const r of rows) {
    const ym = num(r.date?.year) * 100 + num(r.date?.month);
    if (ym !== 0) {
      if (!byYM.has(ym)) { byYM.set(ym, []); }
      byYM.get(ym).push(r);
    }
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
  const byDate = sequence.map(({ year, month }) => buildByDateEntry(year, month, byYM.get(year * 100 + month) || []));
  const emptyTop = () => ({
    visibility: 0,
    visibilityByEngine: EMPTY_ENGINE_BREAKDOWN(),
    audience: 0,
    mentions: EMPTY_ENGINE_BREAKDOWN(),
    citedPages: EMPTY_ENGINE_BREAKDOWN(),
    byDate,
  });
  if (byDate.length === 0) { return emptyTop(); }
  const latest = byDate[byDate.length - 1];
  return {
    visibility: latest.aiVisibility,
    visibilityByEngine: latest.visibilityByEngine,
    audience: latest.audience,
    mentions: latest.mentions,
    citedPages: latest.citedPages,
    byDate,
  };
}

export function mapGrpcPromptToBrandPromptRow(p, engineSlug, requestCountryGrpc) {
  const tv = p.topicVolume;
  const sliceCountry = restCountryFromPromptProto(p) ?? restCountryFromGrpcRequestCountry(requestCountryGrpc);
  return {
    prompt: p.prompt,
    promptHash: String(p.promptHash ?? ''),
    serpId: String(p.serpId ?? ''),
    topic: p.topicName,
    topicId: String(p.topicId ?? ''),
    engine: engineSlug || llmToEngine(p.llm),
    mentions: mentionedBrandsCountFromPromptProto(p),
    citedPages: num(p.sourcesCount),
    ...(sliceCountry ? { country: sliceCountry } : {}),
    ...(tv != null && tv !== '' ? { topicVolume: num(tv) } : {}),
    ...(p.briefResponse ? { responseExcerpt: p.briefResponse } : {}),
    topicVolumeSortKey: tv != null && tv !== '' ? num(tv) : -1,
  };
}

function mapSourceRowToCitedPage(s, requestCountryGrpc) {
  const pageUrl = String(s.url ?? '').trim();
  const responses = num(s.promptsCount);
  const sliceCountry = restMarketFromSourceDomainCountryField(s) ?? restCountryFromGrpcRequestCountry(requestCountryGrpc);
  return { pageUrl, responses, ...(sliceCountry ? { country: sliceCountry } : {}) };
}

function mapSourceDomainRowToCitedSource(d) {
  let sourceDomain = String(d.domain ?? d.hostname ?? d.host ?? '').trim().toLowerCase();
  if (sourceDomain.startsWith('www.')) { sourceDomain = sourceDomain.slice(4); }
  const row = {
    sourceDomain,
    sourcesCount: num(d.sourcesCount),
    responses: num(d.promptsCount),
    mentions: num(d.mentions),
  };
  const mk = restMarketFromSourceDomainCountryField(d);
  if (mk) { row.country = mk; }
  const otRaw = d.organicTraffic;
  if (otRaw != null && otRaw !== '' && !(typeof otRaw === 'number' && !Number.isFinite(otRaw))) {
    const ot = num(otRaw);
    if (Number.isFinite(ot)) { row.organicTraffic = ot; }
  }
  return row;
}

export async function citedPagesOwnedCountFromStatsByLlmForMonth(country, target, monthYm, llmEnum, clients) {
  const dateRange = statsByLLMDateRange(monthYm.year, monthYm.month, 1);
  const raw = await clients.brandClient.statsByLLM({ country, target, dateRange });
  const mapped = mapStatsByLLM(raw, dateRange);
  const cp = mapped.citedPages;
  if (!cp || typeof cp !== 'object') { return null; }
  const citedPagesAllTotal = () => {
    const v = num(cp.all);
    return Number.isFinite(v) && v >= 0 ? v : null;
  };
  if (llmEnum === LLM_ENUM.ALL) {
    return citedPagesAllTotal();
  }
  const slug = LLM_UI[llmEnum];
  if (slug && cp[slug] != null) {
    const v = num(cp[slug]);
    return Number.isFinite(v) && v >= 0 ? v : null;
  }
  return citedPagesAllTotal();
}

function isBrandTopicOpportunityRow(mapped) {
  return mapped.topicVolumeSortKey >= 5000;
}

function stripTopicVolumeSortKey(row) {
  const next = { ...row };
  delete next.topicVolumeSortKey;
  return next;
}

function sortTopicOpportunityRowsByBrandsDesc(rows) {
  return [...rows].sort((a, b) => {
    const d = num(b.mentions) - num(a.mentions); if (d !== 0) { return d; }
    const tv = num(b.topicVolume) - num(a.topicVolume); if (tv !== 0) { return tv; }
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
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

async function fetchBrandPromptsPagesForOpportunities(country, domain, llm, maxPages, orderBy, clients) {
  const target = brandTarget(domain);
  const order = { by: orderBy };
  async function pullPage(page, acc) {
    if (page >= maxPages) {
      return acc;
    }
    const raw = await clients.promptClient.prompts({
      country, llm, target, order, range: { limit: 100, offset: page * 100 },
    }).catch(() => ({ prompts: [] }));
    const chunk = raw.prompts || [];
    const next = [...acc, ...chunk];
    if (chunk.length < 100) {
      return next;
    }
    return pullPage(page + 1, next);
  }
  return pullPage(0, []);
}

async function fetchTopicOpportunityRawPromptPoolForLlm(country, domain, llm, maxPages, clients) {
  const settled = await Promise.allSettled([
    fetchBrandPromptsPagesForOpportunities(country, domain, llm, maxPages, PROMPTS_REQUEST_ORDER_BY_ENUM.TOPIC_VOLUME, clients),
    fetchBrandPromptsPagesForOpportunities(country, domain, llm, maxPages, PROMPTS_REQUEST_ORDER_BY_ENUM.MENTIONED_BRANDS_COUNT, clients),
  ]);
  const byVol = settledValueOrElse(settled[0], []);
  const byBrandCount = settledValueOrElse(settled[1], []);
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
  const windowMonths = Math.min(Math.max(Number(sp.get('windowMonths')) || 4, 1), 6);
  const dateRange = statsByLLMDateRange(endYear, endM, windowMonths);
  const statsSettled = await Promise.allSettled([
    clients.brandClient.statsByLLM({ country, target, dateRange }),
    clients.brandClient.statsByCountry({ target, llm: LLM_ENUM.ALL }),
  ]);
  if (statsSettled[0].status !== 'fulfilled') {
    throw statsSettled[0].reason;
  }
  const rawLlm = statsSettled[0].value;
  const rawByCountry = settledValueOrElse(statsSettled[1], { byCountry: [] });
  const body = mapStatsByLLM(rawLlm, dateRange);
  const bc = rawByCountry.byCountry || [];
  body.byCountry = bc.map((row) => ({
    country: restCountryFromGrpcRequestCountry(row.country) || COUNTRY_ENUM[row.country] || String(row.country),
    mentions: num(row.mentions),
    audience: num(row.audience),
    citedPages: num(row.ownedSources),
  })).filter((r) => r.mentions > 0 || r.audience > 0 || r.citedPages > 0);
  return { status: 200, body };
}

export async function handleBrandTopics(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountry(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const llm = engineToLlm(sp.get('engine')?.trim() || '');
  const body = {
    country, target: brandTarget(domain), order: { by: BRAND_TOPICS_ORDER_BY_ENUM.VISIBILITY }, range: { limit, offset },
  };
  if (llm) { body.llm = llm; }
  const totalsBody = { country, target: brandTarget(domain) };
  if (llm) { totalsBody.llm = llm; }
  const topicsSettled = await Promise.allSettled([
    clients.topicClient.brandTopics(body),
    clients.topicClient.brandTopicsTotals(totalsBody),
  ]);
  if (topicsSettled[0].status !== 'fulfilled') {
    throw topicsSettled[0].reason;
  }
  const raw = topicsSettled[0].value;
  const totalsRaw = settledValueOrElse(topicsSettled[1], { total: 0 });
  const topics = raw.topics || [];
  const data = topics.map((t) => ({
    topic: t.name,
    topicId: String(t.id),
    topicVolume: num(t.volume),
    responses: num(t.mentions),
    mentions: num(t.mentions),
    citedPages: 0,
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
  const topicFilter = resolveTopicIdsDimensionFilter(sp);
  if (!topicFilter.ok) {
    return { status: topicFilter.status, body: topicFilter.body };
  }
  const { dimensionFilterQl } = topicFilter;
  const target = brandTarget(domain);
  const order = { by: PROMPTS_REQUEST_ORDER_BY_ENUM.TOPIC_VOLUME };

  if (llmSingle) {
    const body = {
      country, llm: llmSingle, target, range: { limit, offset }, order,
    };
    if (dimensionFilterQl) { body.dimensionFilterQl = dimensionFilterQl; }
    const totalsReq = { country, llm: llmSingle, target };
    if (dimensionFilterQl) { totalsReq.dimensionFilterQl = dimensionFilterQl; }
    const promptsPair = await Promise.allSettled([
      clients.promptClient.promptsTotals(totalsReq),
      clients.promptClient.prompts(body),
    ]);
    if (promptsPair[1].status !== 'fulfilled') {
      throw promptsPair[1].reason;
    }
    const raw = promptsPair[1].value;
    const totalsRaw = settledValueOrElse(promptsPair[0], { total: 0 });
    const prompts = raw.prompts || [];
    const data = prompts.map((p) => {
      const row = mapGrpcPromptToBrandPromptRow(p, llmToEngine(llmSingle), country);
      return stripTopicVolumeSortKey(row);
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
  for (let i = 0; i < FTS_LLMS.length; i += 1) {
    const engineSlug = llmToEngine(FTS_LLMS[i]);
    for (const p of listResults[i]?.prompts || []) {
      const row = mapGrpcPromptToBrandPromptRow(p, engineSlug, country);
      const promptNorm = String(row.prompt ?? '').trim().toLowerCase();
      const key = row.promptHash && row.serpId
        ? `${row.topicId}|${row.promptHash}|${row.serpId}|${row.engine}|${promptNorm}`
        : `${row.topicId}|${promptNorm}|${row.engine}`;
      if (!seen.has(key)) { seen.set(key, row); }
    }
  }

  const merged = [...seen.values()].sort((a, b) => {
    const d = b.topicVolumeSortKey - a.topicVolumeSortKey; if (d !== 0) { return d; }
    const cmp = String(a.prompt ?? '').localeCompare(String(b.prompt ?? '')); if (cmp !== 0) { return cmp; }
    return String(a.engine ?? '').localeCompare(String(b.engine ?? ''));
  });
  const page = merged.slice(offset, offset + limit).map(stripTopicVolumeSortKey);
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
  const order = resolveGrpcSortOrder(sp, SOURCES_REQUEST_ORDER_BY_ENUM, SOURCES_REQUEST_ORDER_BY_ENUM.PROMPTS_COUNT);
  const monthYm = parseMonthYM(sp);
  const monthRaw = sp.get('month')?.trim();
  const listReq = {
    country, llm: llmEnum, target, category: SOURCE_CATEGORY_ENUM.OWNED_BY_TARGET, order, range: { limit, offset },
  };
  if (monthYm && monthRaw) { listReq.targetDate = monthRaw; }
  const totalsReq = { country, llm: llmEnum, target };

  async function fetchSourcesListBody() {
    try {
      const first = await clients.sourceClient.sources(listReq);
      return first;
    } catch (e) {
      if (listReq.targetDate) {
        const rest = { ...listReq };
        delete rest.targetDate;
        return clients.sourceClient.sources(rest);
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

  const pair = await Promise.allSettled([fetchSourcesListBody(), fromTotalsPromise]);
  if (pair[0].status !== 'fulfilled') {
    throw pair[0].reason;
  }
  const raw = pair[0].value;
  const fromTotals = settledValueOrElse(pair[1], null);
  const src = sourcesListFromSourcesResponse(raw);
  const data = src.map((s) => mapSourceRowToCitedPage(s, country)).filter((r) => r.pageUrl);
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

  const dedupeMergePromptRows = (perLlmArrays, getEngineSlug) => {
    const seen = new Map();
    for (let i = 0; i < perLlmArrays.length; i += 1) {
      const engineSlug = getEngineSlug(i);
      for (const p of perLlmArrays[i] || []) {
        const row = mapGrpcPromptToBrandPromptRow(p, engineSlug, country);
        const promptNorm = String(row.prompt ?? '').trim().toLowerCase();
        const key = row.promptHash && row.serpId
          ? `${row.topicId}|${row.promptHash}|${row.serpId}|${row.engine}|${promptNorm}`
          : `${row.topicId}|${promptNorm}|${row.engine}`;
        if (!seen.has(key)) { seen.set(key, row); }
      }
    }
    return [...seen.values()].sort((a, b) => {
      const d = b.topicVolumeSortKey - a.topicVolumeSortKey; if (d !== 0) { return d; }
      const cmp = String(a.prompt ?? '').localeCompare(String(b.prompt ?? '')); if (cmp !== 0) { return cmp; }
      return String(a.engine).localeCompare(String(b.engine));
    });
  };

  if (llmSingle) {
    const prompts = await fetchTopicOpportunityRawPromptPoolForLlm(country, domain, llmSingle, TOPIC_OPPORTUNITY_PROMPTS_MAX_PAGES, clients);
    const merged = dedupeMergePromptRows([prompts], () => llmToEngine(llmSingle));
    const filtered = merged.filter(isBrandTopicOpportunityRow).map(stripTopicVolumeSortKey);
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

  const perLlmSettled = await Promise.allSettled(
    FTS_LLMS.map((l) => fetchTopicOpportunityRawPromptPoolForLlm(country, domain, l, TOPIC_OPPORTUNITY_PROMPTS_MAX_PAGES, clients)),
  );
  const perLlm = perLlmSettled.map((s) => settledValueOrElse(s, []));
  const merged = dedupeMergePromptRows(perLlm, (i) => llmToEngine(FTS_LLMS[i]));
  const filtered = merged.filter(isBrandTopicOpportunityRow).map(stripTopicVolumeSortKey);
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
  const topBrandsSortBy = sp.get('sortBy')?.trim()?.toUpperCase() === 'NAME' ? 'NAME' : 'MENTIONS';
  const topBrandsSortAsc = sp.get('sortDirection')?.trim()?.toUpperCase() === 'ASC';
  const llmSingle = optionalLlmFromQuery(sp);
  // There is no dedicated count call on the brand gRPC client for top-brands, so the
  // returned `total` is the size of what we fetch. Always fetch the full set (1000 cap)
  // regardless of offset/sort so `total` is stable across pages — a page-dependent window
  // makes the pager's page-count shift as the user pages forward.
  const fetchN = 1000;
  const brandDomain = domain.replace(/^www\./, '').toLowerCase();
  const listArgs = { country, brandDomain, limit: fetchN };

  let raw;
  if (llmSingle) {
    raw = await clients.brandClient.topBrandsByDomain({ ...listArgs, llm: llmSingle });
  } else {
    try {
      raw = await clients.brandClient.topBrandsByDomain({ ...listArgs, llm: LLM_ENUM.ALL });
    } catch {
      const rawListSettled = await Promise.allSettled(
        FTS_LLMS.map((l) => clients.brandClient.topBrandsByDomain({ ...listArgs, llm: l }).catch(() => ({ brands: [] }))),
      );
      const rawList = rawListSettled.map((s) => settledValueOrElse(s, { brands: [] }));
      raw = mergeTopBrandsByDomainResponsesByMax(rawList);
    }
  }

  const brands = (raw.brands || []).filter((b) => Boolean(normalizeTopBrandsByDomainNameKey(topBrandsByDomainEntryName(b))));
  const sliceCountry = restCountryFromGrpcRequestCountry(country);
  const dataFull = brands.map((b) => {
    const name = topBrandsByDomainEntryName(b);
    const mentions = topBrandsByDomainEntryCount(b);
    return {
      name,
      mentions,
      ...(sliceCountry ? { country: sliceCountry } : {}),
    };
  }).sort((a, b) => {
    if (topBrandsSortBy === 'NAME') {
      const c = a.name.localeCompare(b.name, 'en');
      return topBrandsSortAsc ? c : -c;
    }
    const d = topBrandsSortAsc ? (a.mentions - b.mentions) : (b.mentions - a.mentions);
    return d !== 0 ? d : a.name.localeCompare(b.name, 'en');
  });
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
    country, llm: llmEnum, target, order: resolveGrpcSortOrder(sp, DOMAINS_REQUEST_ORDER_BY_ENUM, DOMAINS_REQUEST_ORDER_BY_ENUM.PROMPTS_COUNT), range: { limit, offset },
  };
  const totalsReq = { country, llm: llmEnum, target };

  const [listOutcome, totalsOutcome] = await Promise.allSettled([
    clients.sourceClient.sourceDomains(listReq),
    clients.voSourcesClient.domainsTotals(totalsReq),
  ]);
  if (listOutcome.status !== 'fulfilled') { throw listOutcome.reason; }

  const raw = listOutcome.value;
  const domains = sourceDomainsListFromResponse(raw);
  const data = domains.map(mapSourceDomainRowToCitedSource).filter((r) => r.sourceDomain);
  const fromTotals = settledFulfilledMap(totalsOutcome, (v) => sumVoTotalBySourceCategoryCounts(v), null);
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
  const gapKindsCsv = sp.get('gapKinds')?.trim();
  let kinds = [1];
  if (gapKindsCsv) {
    const parsed = gapKindsCsv.split(',').map((p) => nameToN[p.trim().toUpperCase()]).filter((n) => n != null);
    if (parsed.length) { kinds = parsed; }
  }

  let snapshotDate;
  const explicit = sp.get('gapSnapshotDate')?.trim();
  const dm = explicit && /^(\d{4})-(\d{2})-(\d{1,2})$/.exec(explicit);
  if (dm) { snapshotDate = { year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]) }; }

  const focal = domain.replace(/^www\./, '').split('.')[0].toLowerCase().replace(/-/g, '');
  let competitors = [];
  try {
    const topRaw = await clients.brandClient.topBrandsByDomain({
      country, brandDomain: domain.replace(/^www\./, '').toLowerCase(), llm, limit: 20,
    });
    competitors = (topRaw.brands || [])
      .map((b) => {
        const name = String(b.brandName || '');
        const n = name.toLowerCase().replace(/\s+/g, '');
        return { name, n };
      })
      .filter((x) => x.n && x.n !== focal)
      .slice(0, MAX_COMPETITOR_DOMAINS)
      .map((x) => ({ domain: slugHostFromBrandName(x.name), name: x.name }));
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
    order: resolveGrpcSortOrder(sp, DOMAINS_REQUEST_ORDER_BY_ENUM, DOMAINS_REQUEST_ORDER_BY_ENUM.ORGANIC_TRAFFIC),
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
  const totalsRaw = settledValueOrElse(totalsOutcome, null);
  const domainsRaw = rawResult.domains || [];
  const data = domainsRaw.map((d) => {
    let sourceDomain = String(d.domain ?? d.hostname ?? d.host ?? '').trim().toLowerCase();
    if (sourceDomain.startsWith('www.')) { sourceDomain = sourceDomain.slice(4); }
    const row = {
      sourceDomain,
      sourcesCount: num(d.sourcesCount),
      responses: num(d.promptsCount),
      mentions: num(d.targetMentions ?? d.mentions ?? 0),
    };
    const mk = restMarketFromSourceDomainCountryField(d);
    if (mk) { row.country = mk; }
    const otRaw = d.organicTraffic;
    if (otRaw != null && otRaw !== '' && !(typeof otRaw === 'number' && !Number.isFinite(otRaw))) {
      row.organicTraffic = num(otRaw);
    }
    return row;
  }).filter((r) => r.sourceDomain);
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
/* c8 ignore end */
