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

import { gzipSync } from 'node:zlib';
import { getBrandById } from '../brands-storage.js';
import { fetchFanoutTopics } from './topics-rpc.js';
import { resolveTopicMetricsBatched, intentNameFromEnum } from './semrush-client.js';

export const SCHEMA_VERSION = 1;
export const SIMILARITY_THRESHOLD = 70; // Semrush range 0..100 (Q22)
export const TOPICS_DB_LIMIT = 1000; // Q6a-iii
export const TOP_N_TOPICS = 5; // Q20

/**
 * Mirror of the UI's `extractDomain` (project-elmo-ui/src/utils/urlParser.ts).
 * Returns the hostname with leading `www.` stripped, or null on parse failure.
 * Subdomains other than `www.` are kept — matches what Semrush returns in
 * `rankings[].domain` (confirmed with Semrush engineering).
 */
export function extractDomain(value) {
  if (value == null) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  try {
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(normalized).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Server-side equivalent of the UI's `collectBrandUrlDomains` (true-mirror,
 * Q18). Primary source is `brand.urls[].value`; falls back to `brand.baseUrl`
 * only when no valid hostname was extracted from urls[].
 */
export function brandDomainsFromBrand(brand) {
  const fromUrls = [...new Set(
    (brand?.urls ?? [])
      .map((u) => extractDomain(u?.value))
      .filter((d) => d !== null),
  )];
  if (fromUrls.length > 0) {
    return fromUrls;
  }
  const fromBase = extractDomain(brand?.baseUrl);
  return fromBase ? [fromBase] : [];
}

/**
 * Returns the lowest (best) SERP position at which any of the brand's
 * domains appears in `rankings[]`, or null if none match. Matching is
 * exact-hostname against the apex-stripped set in `brandDomainSet`.
 */
export function brandPositionOf(rankings, brandDomainSet) {
  let best = null;
  for (const r of rankings) {
    if (brandDomainSet.has(r.domain) && (best === null || r.position < best)) {
      best = r.position;
    }
  }
  return best;
}

function toRankings(fanoutQuery) {
  return (fanoutQuery.rankings ?? []).map((r) => ({
    domain: r.domain,
    position: Number(r.position ?? 0),
  }));
}

function buildSubQuery(fanoutQuery, brandDomainSet) {
  const rankings = toRankings(fanoutQuery);
  const top = rankings[0];
  const intent = intentNameFromEnum(fanoutQuery.intents);
  const subQuery = {
    keyword: fanoutQuery.keyword,
    volume: Number(fanoutQuery.volume ?? 0),
    brandPosition: brandPositionOf(rankings, brandDomainSet),
    topDomain: top?.domain ?? '',
    rankings,
  };
  if (intent !== undefined) {
    subQuery.intent = intent;
  }
  return subQuery;
}

function buildTopic(dbTopic, sem, brandDomainSet) {
  // Semrush's metrics.volume is uint64 → BigInt in TS. Safe to coerce to
  // Number — monthly search volume never approaches Number.MAX_SAFE_INTEGER.
  const volume = Number(sem.metrics?.volume ?? 0n);
  const citation = dbTopic.citationRate ?? 0;
  return {
    topicUuid: dbTopic.topicUuid,
    name: dbTopic.name,
    matchedTopicName: sem.matchedTopicName,
    volume,
    promptsTotal: dbTopic.promptsTotal,
    mentionRate: dbTopic.mentionRate,
    citationRate: dbTopic.citationRate,
    priorityScore: volume * (1 - citation),
    subQueries: (sem.fanoutQueries ?? []).map((fq) => buildSubQuery(fq, brandDomainSet)),
  };
}

function emptyReport({
  organizationId, brandId, brandName, brandDomains, country, llm, windowDays, isoDate,
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    isoDate: isoDate ?? new Date().toISOString().slice(0, 10),
    orgId: organizationId,
    brandId,
    brandName,
    brandDomains,
    country,
    llm,
    windowDays,
    topics: [],
  };
}

/**
 * Runs the full curation pipeline:
 *   1. Fetch up to TOPICS_DB_LIMIT tracked topics from Mysticat
 *      (`rpc_fanout_topics`) — already in `id DESC` order, with rates.
 *   2. Load the brand and compute the apex-stripped `brandDomains` set
 *      using the same logic the UI applies (Q18).
 *   3. Call Semrush `resolveTopicMetrics` in batches with bounded concurrency.
 *   4. Drop topics whose Semrush `similarityScore < SIMILARITY_THRESHOLD`.
 *   5. Sort the survivors by `priorityScore` desc and keep the top
 *      TOP_N_TOPICS.
 *   6. Return the assembled `FanoutReport` (matches the OpenAPI schema) plus
 *      a stats block for observability.
 *
 * The result is plain JSON — gzip via `gzipReport` before writing to S3.
 */
export async function curateFanoutReport({
  organizationId,
  brandId,
  country,
  llm,
  countryName,
  llmName,
  windowDays,
  postgrestClient,
  fanoutClient,
  concurrency,
  batchSize,
  log,
}) {
  const t0 = Date.now();

  const dbTopics = await fetchFanoutTopics(postgrestClient, {
    organizationId,
    brandId,
    limit: TOPICS_DB_LIMIT,
  });
  const tDb = Date.now() - t0;

  const brand = await getBrandById(organizationId, brandId, postgrestClient);
  const brandName = brand?.name ?? '';
  const brandDomains = brandDomainsFromBrand(brand);
  const brandDomainSet = new Set(brandDomains);

  if (dbTopics.length === 0) {
    log?.info?.('fanout: brand has no tracked topics; writing empty report', {
      orgId: organizationId, brandId,
    });
    return {
      report: emptyReport({
        organizationId,
        brandId,
        brandName,
        brandDomains,
        country: countryName,
        llm: llmName,
        windowDays,
        isoDate: null,
      }),
      stats: {
        dbTopics: 0,
        semrushReturned: 0,
        similarityPassed: 0,
        topicsPicked: 0,
        tDb,
        tSem: 0,
      },
    };
  }

  const tSemStart = Date.now();
  const { byOriginal, isoDate } = await resolveTopicMetricsBatched({
    fanoutClient,
    topics: dbTopics.map((t) => t.name),
    country,
    llm,
    concurrency,
    batchSize,
    log,
  });
  const tSem = Date.now() - tSemStart;

  const joined = [];
  for (const t of dbTopics) {
    const sem = byOriginal.get(t.name);
    if (!sem) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const sim = Number(sem.similarityScore ?? 0);
    if (sim < SIMILARITY_THRESHOLD) {
      // eslint-disable-next-line no-continue
      continue;
    }
    joined.push(buildTopic(t, sem, brandDomainSet));
  }
  const similarityPassed = joined.length;

  joined.sort((a, b) => b.priorityScore - a.priorityScore);
  const topics = joined.slice(0, TOP_N_TOPICS);

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    isoDate: isoDate ?? new Date().toISOString().slice(0, 10),
    orgId: organizationId,
    brandId,
    brandName,
    brandDomains,
    country: countryName,
    llm: llmName,
    windowDays,
    topics,
  };

  return {
    report,
    stats: {
      dbTopics: dbTopics.length,
      semrushReturned: byOriginal.size,
      similarityPassed,
      topicsPicked: topics.length,
      tDb,
      tSem,
    },
  };
}

export function gzipReport(report) {
  return gzipSync(Buffer.from(JSON.stringify(report)));
}
