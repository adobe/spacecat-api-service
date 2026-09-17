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

import { hasText } from '@adobe/spacecat-shared-utils';
import {
  lookupOpportunitiesByVector,
  getQueryEmbedding,
  upsertQueryEmbedding,
  touchQueryEmbedding,
} from '@adobe/spacecat-shared-data-access';
import { applyFieldProjection } from '../utils/field-projection.js';
import { parseLookupStatus } from './lookup-by-url.js';

/**
 * Shared engine for `POST .../opportunities/by-topics` (Lookup Service, Milestone 2 — semantic).
 * Parallels the by-url engine, swapping the exact-URL index for a per-topic nearest-neighbour
 * search. Body `{ topics: [...], k?, minScore?, status?, fields? }` (1-100 topics; invalid entries
 * dropped, not hard-failed). For each distinct topic it resolves a query vector (durable
 * `semantic_query_embedding` cache hit, else embeds the text once and caches it) and runs the ANN
 * read RPC (`lookupOpportunitiesByVector`), which already dedupes to distinct opportunities keeping
 * the best cosine similarity, applies the score floor, and returns the top-k. It then hydrates +
 * status-filters the union of matched opportunities in memory and returns `results[]` (one per
 * input topic, ranked `{opportunityId, score}` matches) + a top-level `opportunities` id→DTO map.
 *
 * No keyset pagination: each topic's match set is already bounded to `k` by the RPC, so the result
 * is naturally page-sized. Site existence + access control are the caller's concern.
 */

export const MAX_LOOKUP_TOPICS = 100;
export const MAX_TOPIC_LENGTH = 2048;
export const MAX_LOOKUP_MATCHES = 1000;
export const DEFAULT_TOPIC_K = 10;
export const MAX_TOPIC_K = 100;
export const DEFAULT_MIN_SCORE = 0.1;
export const TOPIC_SOURCE_TYPE = 'topic';

// Cache-key components for `semantic_query_embedding`. Must match the opportunity index's model +
// dimension so a query vector is comparable to the stored topic vectors; a model change here
// invalidates the query cache by key.
export const QUERY_EMBEDDING_MODEL = 'azure/text-embedding-3-small';
export const QUERY_EMBEDDING_DIMS = 1536;

// Cap on in-flight PostgREST round-trips (cache reads, ANN searches, best-effort cache writes) so a
// max-size request (100 distinct topics) can't fan out ~100 concurrent calls into the shared pool.
export const LOOKUP_CONCURRENCY = 20;

/**
 * Map `items` through `fn` with at most `limit` in flight, preserving input order in the result.
 * Dependency-free bounded-concurrency pool (no `p-limit` in this repo).
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      // eslint-disable-next-line no-await-in-loop
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Validates the request-body `topics`. Non-array / oversized are hard errors; individual
 * non-string/empty/oversized entries are dropped (drop-don't-fail); an all-dropped/empty list is
 * allowed. Topic text is a query value (parameterized into the RPC and the embedding API body), so
 * no character-class gate is needed — only a length bound.
 * @param {*} rawTopics
 * @returns {{ topics: string[] } | { error: string }}
 */
export function parseLookupTopics(rawTopics) {
  if (!Array.isArray(rawTopics)) {
    return { error: 'topics must be an array' };
  }
  if (rawTopics.length > MAX_LOOKUP_TOPICS) {
    return { error: `topics must contain at most ${MAX_LOOKUP_TOPICS} entries` };
  }
  const topics = rawTopics.filter((t) => typeof t === 'string'
    && t.trim().length > 0
    && t.length <= MAX_TOPIC_LENGTH);
  return { topics };
}

/**
 * Validates the optional `k` (max opportunities per topic).
 * @param {*} rawK
 * @returns {{ k: number } | { error: string }}
 */
export function parseTopicK(rawK) {
  if (rawK === undefined || rawK === null || `${rawK}` === '') {
    return { k: DEFAULT_TOPIC_K };
  }
  const isCleanInteger = typeof rawK === 'number'
    ? Number.isInteger(rawK)
    : /^\d+$/.test(String(rawK).trim());
  const k = Number.parseInt(rawK, 10);
  if (!isCleanInteger || k < 1 || k > MAX_TOPIC_K) {
    return { error: `k must be an integer between 1 and ${MAX_TOPIC_K}` };
  }
  return { k };
}

/**
 * Validates the optional `minScore` (cosine-similarity floor, 0-1). Defaults to `defaultMinScore`.
 * @param {*} rawMinScore
 * @param {number} defaultMinScore
 * @returns {{ minScore: number } | { error: string }}
 */
export function parseMinScore(rawMinScore, defaultMinScore) {
  if (rawMinScore === undefined || rawMinScore === null || `${rawMinScore}` === '') {
    return { minScore: defaultMinScore };
  }
  if (typeof rawMinScore !== 'number' && typeof rawMinScore !== 'string') {
    return { error: 'minScore must be a number between 0 and 1' };
  }
  const minScore = Number(rawMinScore);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    return { error: 'minScore must be a number between 0 and 1' };
  }
  return { minScore };
}

/**
 * Projects the surviving DTOs down to the requested `fields`, or to the endpoint's lightweight
 * default when `fields` is omitted. `id` is always retained either way (`applyFieldProjection`
 * force-includes it; the lightweight default lists it), so opportunities stay joinable to
 * `results[].matches`. Parallel to the by-url engine's projector; by-url additionally
 * force-includes `opportunityId` for suggestions — by-topic has no such need.
 * @returns {{ list: object[] } | { error: string }}
 */
function projectLookup(fullDtos, fieldsParam, lightweightFields) {
  if (fieldsParam !== undefined && fieldsParam !== null && typeof fieldsParam !== 'string') {
    return { error: 'fields must be a string' };
  }
  if (hasText(fieldsParam)) {
    return applyFieldProjection(fullDtos, fieldsParam);
  }
  const list = fullDtos.map((src) => {
    const out = {};
    for (const k of lightweightFields) {
      if (src && Object.hasOwn(src, k)) {
        out[k] = src[k];
      }
    }
    return out;
  });
  return { list };
}

/**
 * Resolve a query vector for each distinct topic text: a durable-cache hit (best-effort access
 * bump), else embed all misses in one batch call and cache them (best-effort write). The cache read
 * and the embed are load-bearing; the cache writes are optimizations that must never fail the
 * lookup.
 * @returns {Promise<Map<string, number[]>>} text -> vector
 */
async function resolveTopicVectors(postgrestClient, embeddingClient, texts, log) {
  const vectorByText = new Map();
  const cacheKey = { model: QUERY_EMBEDDING_MODEL, dims: QUERY_EMBEDDING_DIMS };

  // 1. Cache reads in parallel (bounded), result order aligned to `texts`.
  const cached = await mapWithConcurrency(
    texts,
    LOOKUP_CONCURRENCY,
    (text) => getQueryEmbedding(postgrestClient, { text, ...cacheKey }),
  );

  const hits = [];
  const misses = [];
  texts.forEach((text, i) => {
    if (cached[i]?.vector) {
      vectorByText.set(text, cached[i].vector);
      // carry the hit's textHash so the access bump skips re-hashing (it's already resolved).
      hits.push({ text, textHash: cached[i].textHash });
    } else {
      misses.push(text);
    }
  });

  // 2. Embed all misses in one batch call; guard the returned length so a short/misaligned
  //    response is a loud error, not an `undefined` vector silently cached and sent to the RPC.
  if (misses.length > 0) {
    const vectors = await embeddingClient.createEmbeddings(misses); // native dims (no truncation)
    if (!Array.isArray(vectors) || vectors.length !== misses.length) {
      const want = misses.length;
      const got = vectors?.length;
      throw new Error(`Embedding response length mismatch: expected ${want}, got ${got}`);
    }
    misses.forEach((text, i) => vectorByText.set(text, vectors[i]));
  }

  // 3. Best-effort cache maintenance (access bump for hits, populate for misses), bounded + settled
  //    before returning; these are optimizations that must never fail the lookup.
  const swallow = (label) => (e) => {
    log?.debug?.(`[lookup-by-topic] ${label} failed (non-fatal): ${e.message}`);
  };
  const writes = [
    ...hits.map(({ text, textHash }) => () => touchQueryEmbedding(postgrestClient, {
      text, textHash, ...cacheKey,
    }).catch(swallow('touchQueryEmbedding'))),
    ...misses.map((text) => () => upsertQueryEmbedding(postgrestClient, {
      text, ...cacheKey, vector: vectorByText.get(text),
    }).catch(swallow('upsertQueryEmbedding'))),
  ];
  await mapWithConcurrency(writes, LOOKUP_CONCURRENCY, (task) => task());

  return vectorByText;
}

/**
 * Runs a by-topic semantic lookup and builds the normalized response (or a validation error the
 * caller surfaces as `badRequest`). Embedding / RPC infrastructure failures propagate (caller →
 * 5xx); only invalid input is a 400.
 *
 * @param {object} postgrestClient - `dataAccess.services.postgrestClient`
 * @param {object} embeddingClient - an `EmbeddingProvider` (`createEmbeddings(inputs)`)
 * @param {object} cfg
 * @param {string} cfg.siteId
 * @param {*} cfg.rawTopics - request body `topics`
 * @param {object} cfg.params - body fields (`fields`, `status`, `k`, `minScore`)
 * @param {number} cfg.defaultMinScore - env-configured floor used when `minScore` is omitted
 * @param {object} [cfg.log] - optional logger; when omitted, the engine logs nothing
 * @param {string[]} cfg.validStatuses - the entity status enum
 * @param {string[]} cfg.defaultExcludedStatuses - statuses hidden when `status` is omitted
 * @param {(ids: string[]) => Promise<object[]>} cfg.fetchEntities - batch hydrate by id
 * @param {(entities: object[]) => object[]|Promise<object[]>} [cfg.filterEntities] - optional
 *   authorization / product-gating narrowing, applied before status filtering; skipped when nothing
 *   was hydrated.
 * @param {(e: object) => string} cfg.getId
 * @param {(e: object) => string} cfg.getStatus
 * @param {(e: object) => object} cfg.toFullDto - full DTO JSON for an entity
 * @param {string[]} cfg.lightweightFields - default projection when `fields` omitted
 * @param {string} cfg.mapKey - `opportunities`
 * @returns {Promise<{ response: object } | { error: string }>}
 */
export async function lookupByTopic(postgrestClient, embeddingClient, cfg) {
  const {
    siteId, rawTopics, params = {}, defaultMinScore = DEFAULT_MIN_SCORE, log,
    validStatuses, defaultExcludedStatuses,
    fetchEntities, filterEntities, getId, getStatus, toFullDto,
    lightweightFields, mapKey,
  } = cfg;

  const topicsResult = parseLookupTopics(rawTopics);
  if (topicsResult.error) {
    return { error: topicsResult.error };
  }
  const statusResult = parseLookupStatus(params.status, validStatuses);
  if (statusResult.error) {
    return { error: statusResult.error };
  }
  const kResult = parseTopicK(params.k);
  if (kResult.error) {
    return { error: kResult.error };
  }
  const minScoreResult = parseMinScore(params.minScore, defaultMinScore);
  if (minScoreResult.error) {
    return { error: minScoreResult.error };
  }

  const { topics } = topicsResult;
  const { statuses } = statusResult;
  const { k } = kResult;
  const { minScore } = minScoreResult;

  if (topics.length === 0) {
    return { response: { results: [], [mapKey]: {} } };
  }

  // Resolve a vector per distinct topic, then run the ANN search once per distinct topic.
  const distinctTexts = [...new Set(topics)];
  const vectorByText = await resolveTopicVectors(
    postgrestClient,
    embeddingClient,
    distinctTexts,
    log,
  );

  // ANN search per distinct topic, in parallel (bounded), result order aligned to distinctTexts.
  const matchesList = await mapWithConcurrency(
    distinctTexts,
    LOOKUP_CONCURRENCY,
    (text) => lookupOpportunitiesByVector(postgrestClient, {
      siteId, sourceType: TOPIC_SOURCE_TYPE, vector: vectorByText.get(text), k, minScore,
    }),
  );

  const matchesByText = new Map();
  const allIds = [];
  const seenIds = new Set();
  distinctTexts.forEach((text, i) => {
    const matches = matchesList[i];
    matchesByText.set(text, matches);
    for (const m of matches) {
      if (!seenIds.has(m.entityId)) {
        seenIds.add(m.entityId);
        allIds.push(m.entityId);
      }
    }
  });

  if (allIds.length > MAX_LOOKUP_MATCHES) {
    return { error: `Too many matched opportunities (${allIds.length}); lower k or narrow the topics list` };
  }

  const hydrated = allIds.length > 0 ? await fetchEntities(allIds) : [];
  if (hydrated.length !== allIds.length) {
    log?.warn?.(`[lookup-by-topic] index referenced ${allIds.length - hydrated.length} opportunity id(s) that could not be hydrated (siteId=${siteId}) - the index may be stale`);
  }
  // Authorization / product-gating narrowing (site-ownership, FACS composite, Summit-PLG) before
  // status filter; skipped when nothing was hydrated so a fixed-cost hook isn't paid on no matches.
  const entities = (filterEntities && hydrated.length > 0)
    ? await filterEntities(hydrated)
    : hydrated;

  const survivingById = new Map();
  for (const entity of entities) {
    const status = getStatus(entity);
    if (statuses.length > 0) {
      if (!statuses.includes(status)) {
        // eslint-disable-next-line no-continue
        continue;
      }
    } else if (defaultExcludedStatuses.includes(status)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    survivingById.set(getId(entity), entity);
  }

  // Project the surviving opportunities into the id -> DTO map.
  const survivors = [...survivingById.values()];
  const fullDtos = survivors.map((e) => toFullDto(e));
  const projection = projectLookup(fullDtos, params.fields, lightweightFields);
  if (projection.error) {
    return { error: projection.error };
  }
  const entityMap = {};
  survivors.forEach((e, i) => {
    entityMap[getId(e)] = projection.list[i];
  });

  // results in input order (one per input topic), ranked matches restricted to survivors.
  // Every input topic is in `distinctTexts`, so `matchesByText` always has its entry.
  const results = topics.map((topic) => {
    const matches = matchesByText.get(topic)
      .filter((m) => survivingById.has(m.entityId))
      .map((m) => ({ opportunityId: m.entityId, score: m.score }));
    return { topic, matches };
  });

  log?.info?.(`[lookup-by-topic] siteId=${siteId} topics=${topics.length} distinct=${distinctTexts.length} matchedIds=${allIds.length} hydrated=${hydrated.length} afterAuth=${entities.length} survivors=${survivors.length}`);

  return { response: { results, [mapKey]: entityMap } };
}
