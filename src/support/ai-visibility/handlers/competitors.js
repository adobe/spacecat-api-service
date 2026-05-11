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
import { StatsResponseSchema } from '@quazar/ai-seo-ts/ai-cr/messages_pb.js';
import { TOPICS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/topic/enums_pb.js';
import { GAP_PROMPTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import { DOMAINS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import {
  num, brandTarget, parseLimitOffset, resolveCountryForCompetitorsMetrics,
  optionalLlmFromQuery, engineToLlm, llmToEngine,
  restMarketFromSourceDomainCountryField,
  parseCompetitorDomainsList, parseGapKindEnumList,
  aggregateGapPromptsTotalFromTotals,
  LLM_ENUM, GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT,
} from '../grpc-utils.js';
import { messageToJson } from '../proto-json.js';

function mapCompetitorsStatsResponse(raw) {
  const json = messageToJson(StatsResponseSchema, raw);
  const rows = Array.isArray(json.byBrand) ? json.byBrand : [];
  return {
    byBrand: rows.map((row) => {
      const byDate = Array.isArray(row?.byDate) ? row.byDate : [];
      return {
        brand: {
          domain: row?.brand?.domain ?? '',
          name: row?.brand?.name ?? row?.brand?.domain ?? '',
        },
        byDate,
      };
    }),
  };
}

export async function handleCompetitorsMetrics(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const compDomains = parseCompetitorDomainsList(sp);
  if (compDomains.length === 0) {
    return {
      status: 400,
      body: { error: 'missing_competitors', message: 'Set competitors=comma-separated-domains (and/or repeated competitor=)' },
    };
  }
  const country = resolveCountryForCompetitorsMetrics(sp);
  const body = { country, target: brandTarget(domain), competitors: compDomains.map(brandTarget) };
  const explicit = sp.get('gapSnapshotDate')?.trim() || sp.get('metricsSnapshotDate')?.trim();
  const dm = explicit && /^(\d{4})-(\d{2})-(\d{1,2})$/.exec(explicit);
  if (dm) {
    const d = { year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]) };
    body.dateRange = { from: d, till: d };
  }
  const llm = engineToLlm(sp.get('engine')?.trim() || '');
  if (llm) { body.llm = llm; }
  let raw;
  try {
    raw = await clients.crMetricsClient.stats(body);
  } catch (e) {
    const msg = String(e?.message || e);
    const isNotFound = (e instanceof ConnectError && e.code === Code.NotFound)
      || /Code:\s*NotFound/i.test(msg)
      || /\bNotFound\b/i.test(msg);
    if (isNotFound) { return { status: 200, body: { byBrand: [] } }; }
    throw e;
  }
  return { status: 200, body: mapCompetitorsStatsResponse(raw) };
}

function mapGapTopicRow(t) {
  const gapRaw = t.gapMentions || [];
  const gapMentions = gapRaw.map((gm) => ({
    domain: gm.brand?.domain ?? '', name: gm.brand?.name ?? gm.brand?.domain ?? '', mentions: num(gm.mentions),
  }));
  return {
    topicId: String(t.hash ?? ''),
    topic: t.name ?? '',
    topicVolume: num(t.volume),
    visibility: num(t.visibility),
    mentions: num(t.mentions),
    difficulty: num(t.difficulty),
    gapMentions,
  };
}

export async function handleCompetitorsGapTopics(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const compDomains = parseCompetitorDomainsList(sp);
  if (compDomains.length === 0) {
    return {
      status: 400,
      body: { error: 'missing_competitors', message: 'Set competitors=comma-separated-domains (and/or repeated competitor=)' },
    };
  }
  const country = resolveCountryForCompetitorsMetrics(sp);
  const parsedLo = parseLimitOffset(sp);
  const { offset } = parsedLo;
  let { limit } = parsedLo;
  limit = Math.min(limit, GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT);
  const kinds = parseGapKindEnumList(sp);
  const llm = optionalLlmFromQuery(sp) ?? LLM_ENUM.ALL;
  const fetchLimit = Math.min(limit + 1, GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT);
  const body = {
    country,
    llm,
    target: brandTarget(domain),
    competitors: compDomains.map(brandTarget),
    kind: kinds,
    order: { by: TOPICS_REQUEST_ORDER_BY_ENUM.MENTIONED_COMPETITORS },
    range: { limit: fetchLimit, offset },
  };
  const explicit = sp.get('gapSnapshotDate')?.trim();
  const dm = explicit && /^(\d{4})-(\d{2})-(\d{1,2})$/.exec(explicit);
  if (dm) { body.date = { year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]) }; }
  const totalsBody = {
    country: body.country, llm: body.llm, target: body.target, competitors: body.competitors,
  };
  if (body.date) { totalsBody.date = body.date; }
  const [gapOutcome, totalsOutcome] = await Promise.allSettled([
    clients.topicClient.gapTopics(body), clients.topicClient.gapTopicsTotals(totalsBody),
  ]);
  if (gapOutcome.status === 'rejected') {
    const msg = String(gapOutcome.reason?.message || gapOutcome.reason || '');
    const isNotFound = (gapOutcome.reason instanceof ConnectError && gapOutcome.reason.code === Code.NotFound)
      || /Code:\s*NotFound/i.test(msg)
      || /\bNotFound\b/i.test(msg);
    if (isNotFound) {
      return {
        status: 200,
        body: {
          data: [], total: 0, offset, limit,
        },
      };
    }
    throw gapOutcome.reason;
  }
  const raw = gapOutcome.value;
  const totalsRaw = totalsOutcome.status === 'fulfilled' ? totalsOutcome.value : null;
  const topics = raw.topics || [];
  const hasMore = topics.length > limit;
  const slice = hasMore ? topics.slice(0, limit) : topics;
  const data = slice.map(mapGapTopicRow);
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

export async function handleCompetitorsGapSourceDomains(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const compDomains = parseCompetitorDomainsList(sp);
  if (compDomains.length === 0) {
    return {
      status: 400,
      body: { error: 'missing_competitors', message: 'Set competitors=comma-separated-domains (and/or repeated competitor=)' },
    };
  }
  const country = resolveCountryForCompetitorsMetrics(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const kinds = parseGapKindEnumList(sp);
  const llm = optionalLlmFromQuery(sp) ?? LLM_ENUM.ALL;
  const rangeLimit = Math.min(Math.max(1, limit), GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT);
  const listBody = {
    country,
    llm,
    target: brandTarget(domain),
    competitors: compDomains.map(brandTarget),
    kind: kinds,
    order: { by: DOMAINS_REQUEST_ORDER_BY_ENUM.ORGANIC_TRAFFIC },
    range: { limit: rangeLimit, offset },
  };
  const explicit = sp.get('gapSnapshotDate')?.trim();
  const dm = explicit && /^(\d{4})-(\d{2})-(\d{1,2})$/.exec(explicit);
  if (dm) { listBody.date = { year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]) }; }
  const totalsBody = {
    country: listBody.country, llm: listBody.llm, target: listBody.target, competitors: listBody.competitors,
  };
  if (listBody.date) { totalsBody.date = listBody.date; }
  const [listOutcome, totalsOutcome] = await Promise.allSettled([
    clients.sourceClient.gapSourceDomains(listBody), clients.sourceClient.gapSourceDomainsTotals(totalsBody),
  ]);
  if (listOutcome.status === 'rejected') {
    const msg = String(listOutcome.reason?.message || listOutcome.reason || '');
    const isNotFound = (listOutcome.reason instanceof ConnectError && listOutcome.reason.code === Code.NotFound)
      || /Code:\s*NotFound/i.test(msg)
      || /\bNotFound\b/i.test(msg);
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
  const raw = listOutcome.value;
  const totalsRaw = totalsOutcome.status === 'fulfilled' ? totalsOutcome.value : null;
  const domains = raw.domains || [];
  const data = domains.map((d) => {
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

function mapGapPromptRow(p, targetDomain) {
  const t = targetDomain.trim().toLowerCase().replace(/^www\./, '');
  let mentioned = 0;
  for (const gm of p.gapMentions || []) {
    const bd = String(gm.brand?.domain || '').toLowerCase().replace(/^www\./, '');
    if (bd && bd !== t) { mentioned += 1; }
  }
  return {
    id: `${p.promptHash}-${p.serpId || ''}-${p.topicId || ''}`,
    prompt: p.prompt,
    engine: llmToEngine(p.llm),
    topic: p.topicName,
    topicId: String(p.topicId ?? ''),
    topicVolume: num(p.topicVolume),
    mentioned,
    brands: num(p.mentionedBrandsCount),
    sources: num(p.sourcesCount),
    promptHash: p.promptHash == null || p.promptHash === '' ? '' : String(p.promptHash),
    serpId: p.serpId == null || p.serpId === '' ? '' : String(p.serpId),
  };
}

export async function handleCompetitorsGapPrompts(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const compDomains = parseCompetitorDomainsList(sp);
  if (compDomains.length === 0) {
    return {
      status: 400,
      body: { error: 'missing_competitors', message: 'Set competitors=comma-separated-domains (and/or repeated competitor=)' },
    };
  }
  const country = resolveCountryForCompetitorsMetrics(sp);
  const parsedLo = parseLimitOffset(sp);
  const { offset } = parsedLo;
  let { limit } = parsedLo;
  limit = Math.min(limit, GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT);
  const kinds = parseGapKindEnumList(sp);
  const llm = optionalLlmFromQuery(sp) ?? LLM_ENUM.ALL;
  const fetchLimit = Math.min(limit + 1, GAP_SOURCE_DOMAINS_MAX_RANGE_LIMIT);
  const body = {
    country,
    llm,
    target: brandTarget(domain),
    competitors: compDomains.map(brandTarget),
    kinds,
    order: { by: GAP_PROMPTS_REQUEST_ORDER_BY_ENUM.MENTIONED_BRANDS_COUNT },
    range: { limit: fetchLimit, offset },
  };
  const explicit = sp.get('gapSnapshotDate')?.trim();
  const dm = explicit && /^(\d{4})-(\d{2})-(\d{1,2})$/.exec(explicit);
  if (dm) { body.date = { year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]) }; }
  const totalsBody = {
    country: body.country, llm: body.llm, target: body.target, competitors: body.competitors,
  };
  if (body.date) { totalsBody.date = body.date; }
  const [gapOutcome, totalsOutcome] = await Promise.allSettled([
    clients.promptClient.gapPrompts(body), clients.promptClient.gapPromptsTotals(totalsBody),
  ]);
  if (gapOutcome.status === 'rejected') {
    const msg = String(gapOutcome.reason?.message || gapOutcome.reason || '');
    const isNotFound = (gapOutcome.reason instanceof ConnectError && gapOutcome.reason.code === Code.NotFound)
      || /Code:\s*NotFound/i.test(msg)
      || /\bNotFound\b/i.test(msg);
    if (isNotFound) {
      return {
        status: 200,
        body: {
          data: [], total: 0, offset, limit,
        },
      };
    }
    throw gapOutcome.reason;
  }
  const raw = gapOutcome.value;
  const totalsRaw = totalsOutcome.status === 'fulfilled' ? totalsOutcome.value : null;
  const prompts = raw.prompts || [];
  const hasMore = prompts.length > limit;
  const slice = hasMore ? prompts.slice(0, limit) : prompts;
  const data = slice.map((p) => mapGapPromptRow(p, domain));
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
