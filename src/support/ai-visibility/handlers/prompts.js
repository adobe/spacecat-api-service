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

/* eslint-disable max-statements-per-line -- AI Visibility handler surface */

import { PROMPTS_REQUEST_ORDER_BY_ENUM } from '@quazar/ai-seo-ts/v2/prompt/enums_pb.js';
import {
  num, brandTarget, parseLimitOffset, resolveCountryForFts, requiredLlmFromQuery,
  llmToEngine, promptMatchesResponsesQuery, mentionedBrandRestLabel,
  PROMPTS_RESPONSES_PROMPTS_SCAN_LIMIT, toIsoDate, hasRelationIdentity,
  relationStatusFor, deriveResponse,
  normalizeCountryForGrpc, engineToLlm, LLM_ENUM, COUNTRY_ENUM,
} from '../grpc-utils.js';

/** Whole-brand `/all` traversal: default and hard-cap page sizes. The cap keeps one
 *  page's per-item relation hydration inside the ~29s API-Gateway timeout. */
const PROMPTS_RESPONSES_ALL_DEFAULT_LIMIT = 100;
const PROMPTS_RESPONSES_ALL_MAX_LIMIT = 200;
/** Bulk `/batch` read: maximum caller-supplied identities per request. */
const PROMPTS_RESPONSES_BATCH_MAX_ITEMS = 500;
/**
 * Upstream Semrush prompt scan is offset-based with a documented ~1000-row ceiling
 * (spec §2.3). When traversal reaches it before the corpus is exhausted, `/all`
 * still returns the page it can serve (HTTP 200) and signals the stop explicitly in
 * the envelope (`truncated: true`, `truncationReason: 'backend_offset_ceiling'`)
 * rather than silently dropping the tail.
 */
const PROMPTS_RESPONSES_ALL_BACKEND_OFFSET_CEILING = 1000;
/** Upper bound accepted when decoding a cursor offset (defends against absurd values). */
const MAX_CURSOR_OFFSET = 1_000_000;

/**
 * Opaque, base64url-encoded pagination cursor. Mirrors the encoder precedent in
 * `src/controllers/state-access-mappings.js` so the ai-visibility surface stays
 * offset-based rather than inventing a new cursor scheme.
 *
 * @param {number} offset
 * @returns {string}
 */
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

/**
 * @param {string} cursor base64url cursor
 * @returns {{ offset: number } | null} null when the cursor is malformed
 */
function decodeCursor(cursor) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof decoded?.offset === 'number'
      && Number.isInteger(decoded.offset)
      && decoded.offset >= 0
      && decoded.offset <= MAX_CURSOR_OFFSET) {
      return { offset: decoded.offset };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Parse and clamp the `/all` page size. Falls back to the default when absent or
 * invalid and never exceeds the hard cap.
 * @param {URLSearchParams} sp
 * @returns {number}
 */
function parseAllLimit(sp) {
  const raw = sp.get('limit');
  let n = raw == null || String(raw).trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) { n = PROMPTS_RESPONSES_ALL_DEFAULT_LIMIT; }
  return Math.min(Math.floor(n), PROMPTS_RESPONSES_ALL_MAX_LIMIT);
}

/**
 * Resolve a batch item's market to a gRPC country enum. Batch identities carry
 * discrete strings (not a URLSearchParams), so this mirrors `resolveCountryForFts`
 * (WORLDWIDE folds to US for the FTS-backed prompt scan).
 * @param {string|null|undefined} raw
 * @returns {number}
 */
function resolveBatchCountry(raw) {
  const c = normalizeCountryForGrpc(raw ?? 'US');
  return c === COUNTRY_ENUM.WORLDWIDE ? COUNTRY_ENUM.US : c;
}

/**
 * Build one hydrated prompt/response record. Extracted so the single-page list
 * (`/prompts/responses`) and the whole-brand traversal (`/all`) emit the exact same
 * item shape and cannot drift (spec §7). `rel` is the already-unwrapped relation
 * value (`Relations/Prompt` `.value`), which may be null.
 *
 * @param {object} p prompt proto (from `PromptService/Prompts`)
 * @param {object|null} rel unwrapped relation value, or null when skipped/failed
 * @param {boolean} attempted whether the relation call was issued for this row
 * @param {{ status: 'fulfilled'|'rejected' }} settled the settled relation promise
 * @param {number} fallbackLlm request-level llm used when the prompt carries none
 * @returns {object}
 */
function buildPromptResponseItem(p, rel, attempted, settled, fallbackLlm) {
  const relationStatus = relationStatusFor({ attempted, settled });
  const { response, responseSource, responseComplete } = deriveResponse(rel, p.briefResponse);
  return {
    prompt: p.prompt,
    promptHash: String(p.promptHash ?? ''),
    serpId: String(p.serpId ?? ''),
    topic: p.topicName,
    topicId: String(p.topicId ?? ''),
    engine: llmToEngine(p.llm || fallbackLlm),
    response,
    responseExcerpt: p.briefResponse ?? '',
    responseSource,
    responseComplete,
    relationStatus,
    date: toIsoDate(rel?.date),
    citedPages: Array.isArray(rel?.sources) ? rel.sources : [],
    mentionedBrands: (rel?.mentionedBrands ?? []).map(mentionedBrandRestLabel).filter(Boolean),
    mentionedBrandsCount: num(p.mentionedBrandsCount),
    sourcesCount: num(p.sourcesCount),
  };
}

export async function handlePromptsResponses(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const country = resolveCountryForFts(sp);
  const { limit, offset } = parseLimitOffset(sp);
  const promptQuery = (sp.get('prompt') ?? '').trim();
  const llm = requiredLlmFromQuery(sp);
  const raw = await clients.promptClient.prompts({
    country,
    llm,
    target: brandTarget(domain),
    range: { limit: PROMPTS_RESPONSES_PROMPTS_SCAN_LIMIT, offset: 0 },
    order: { by: PROMPTS_REQUEST_ORDER_BY_ENUM.TOPIC_VOLUME },
  });
  let prompts = raw.prompts || [];
  if (promptQuery) {
    prompts = prompts.filter((p) => promptMatchesResponsesQuery(p.prompt, promptQuery));
  }
  const total = prompts.length;
  const page = prompts.slice(offset, offset + limit);
  // Single identity predicate, reused by both the relation-call guard and
  // `attempted[i]`, so the two cannot drift. `attempted[i]` records whether we
  // actually issued the per-prompt relation call: without it a skipped prompt
  // (missing identity → Promise.resolve(null)) is indistinguishable from a
  // relation call that fulfilled with a null value, which hides why a row has no
  // full response.
  const attempted = page.map(hasRelationIdentity);
  const settled = await Promise.allSettled(
    page.map((p) => {
      if (!hasRelationIdentity(p)) { return Promise.resolve(null); }
      const { promptHash, topicId } = p;
      const serpId = String(p.serpId ?? '');
      return clients.prRelationsClient.prompt({
        country, llm: p.llm || llm, promptHash, serpId, topicId,
      });
    }),
  );
  const relations = settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
  const data = page.map((p, i) => buildPromptResponseItem(
    p,
    relations[i]?.value ?? null,
    attempted[i],
    settled[i],
    llm,
  ));
  return {
    status: 200,
    body: {
      data, total, offset, limit,
    },
  };
}

export async function handlePromptsResponsesLatest(sp, clients) {
  const promptHash = sp.get('promptHash')?.trim();
  const serpId = sp.get('serpId')?.trim();
  const topicId = sp.get('topicId')?.trim();
  if (!promptHash || !serpId || !topicId) {
    return {
      status: 400,
      body: { error: 'missing_params', message: 'promptHash, serpId, and topicId are required' },
    };
  }
  const country = resolveCountryForFts(sp);
  const llm = requiredLlmFromQuery(sp);
  const raw = await clients.prRelationsClient.prompt({
    country, llm, promptHash, serpId, topicId,
  });
  const v = raw.value ?? null;
  if (!v) { return { status: 200, body: { data: null } }; }
  return {
    status: 200,
    body: {
      data: {
        prompt: v.prompt,
        engine: llmToEngine(llm),
        topicId,
        response: v.response,
        citedPages: Array.isArray(v.sources) ? v.sources : [],
        mentionedBrands: (v.mentionedBrands ?? []).map(mentionedBrandRestLabel).filter(Boolean),
        date: toIsoDate(v.date),
      },
    },
  };
}

/**
 * Whole-brand traversal feed (LLMO-7027) — `GET /llmo/ai-visibility/prompts/responses/all`.
 *
 * Walks a brand's entire prompt/response corpus page by page via an opaque, offset-based
 * cursor, hydrating each page's relations exactly like the single-page list endpoint and
 * emitting the same item shape (`buildPromptResponseItem`). Cursor traversal depth is bound
 * by the upstream offset ceiling; when reached, the page is still served with an explicit
 * `truncated` / `truncationReason` signal instead of a silent tail drop (spec §5.2).
 *
 * @param {URLSearchParams} sp
 * @param {object} clients gRPC clients
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handlePromptsResponsesAll(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const cursorRaw = sp.get('cursor')?.trim();
  let offset = 0;
  if (cursorRaw) {
    const decoded = decodeCursor(cursorRaw);
    if (!decoded) { return { status: 400, body: { error: 'invalid_cursor', message: 'cursor is malformed' } }; }
    offset = decoded.offset;
  }
  const limit = parseAllLimit(sp);
  const country = resolveCountryForFts(sp);
  const llm = requiredLlmFromQuery(sp);
  const promptQuery = (sp.get('promptQuery') ?? sp.get('prompt') ?? '').trim();
  const raw = await clients.promptClient.prompts({
    country,
    llm,
    target: brandTarget(domain),
    range: { limit, offset },
    order: { by: PROMPTS_REQUEST_ORDER_BY_ENUM.TOPIC_VOLUME },
  });
  const fetched = raw.prompts || [];
  // Advance the cursor by the number of rows the backend returned, before any client-side
  // filtering, so traversal stays correct regardless of `promptQuery`.
  const fetchedCount = fetched.length;
  // Hydrate the full fetched page (pre-filter) so `executionDate` reflects the page's
  // snapshot even when `promptQuery` removes the dated rows. Concurrency is bounded by
  // `limit` (<= PROMPTS_RESPONSES_ALL_MAX_LIMIT); API Gateway rate-limiting is the
  // operational control against upstream gRPC saturation.
  const attempted = fetched.map(hasRelationIdentity);
  const settled = await Promise.allSettled(
    fetched.map((p) => {
      if (!hasRelationIdentity(p)) { return Promise.resolve(null); }
      const { promptHash, topicId } = p;
      const serpId = String(p.serpId ?? '');
      return clients.prRelationsClient.prompt({
        country, llm: p.llm || llm, promptHash, serpId, topicId,
      });
    }),
  );
  const relations = settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
  const allItems = fetched.map((p, i) => buildPromptResponseItem(
    p,
    relations[i]?.value ?? null,
    attempted[i],
    settled[i],
    llm,
  ));
  // Page-level snapshot date, taken from the pre-filter set so a fully-filtered page
  // still reports the date the backend served.
  const executionDate = allItems.find((d) => d.date)?.date ?? null;
  // `promptQuery` is a client-side filter applied after hydration; the cursor still
  // advances by the backend fetch count, so a filtered page may be empty (or shorter
  // than `limit`) while `nextCursor` remains non-null.
  const data = promptQuery
    ? allItems.filter((it) => promptMatchesResponsesQuery(it.prompt, promptQuery))
    : allItems;
  const nextOffset = offset + fetchedCount;
  let nextCursor = null;
  let truncated = false;
  let truncationReason = null;
  // A full backend page means more rows may exist; a short page is a natural end.
  if (fetchedCount === limit) {
    if (nextOffset >= PROMPTS_RESPONSES_ALL_BACKEND_OFFSET_CEILING) {
      truncated = true;
      truncationReason = 'backend_offset_ceiling';
    } else {
      nextCursor = encodeCursor(nextOffset);
    }
  }
  return {
    status: 200,
    body: {
      data,
      nextCursor,
      snapshotId: null,
      executionDate,
      truncated,
      truncationReason,
    },
  };
}

/**
 * Bulk hydration feed (LLMO-7026) — `POST /llmo/ai-visibility/prompts/responses/batch`.
 *
 * Hydrates up to {@link PROMPTS_RESPONSES_BATCH_MAX_ITEMS} caller-supplied identities into
 * their full responses via `Relations/Prompt`. The result is order-stable and never drops
 * an item: `data[i]` corresponds to `items[i]` for the full request length. A backend
 * failure is surfaced as `relationStatus: 'error'`; an identity lacking the fields needed
 * to issue the call is surfaced as `relationStatus: 'skipped'`. A per-item `country`/`engine`
 * overrides the top-level default. Malformed input (missing `domain`/`items`, over the cap,
 * or a non-object item) is a request-level `400`, not a per-item error (spec §5.1).
 *
 * @param {object} body parsed request body (`context.data`)
 * @param {object} clients gRPC clients
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handlePromptsResponsesBatch(body, clients) {
  const b = body != null && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const domain = typeof b.domain === 'string' ? b.domain.trim() : '';
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const { items } = b;
  if (!Array.isArray(items) || items.length === 0) {
    return { status: 400, body: { error: 'missing_items', message: 'items must be a non-empty array' } };
  }
  if (items.length > PROMPTS_RESPONSES_BATCH_MAX_ITEMS) {
    return {
      status: 400,
      body: { error: 'too_many_items', message: `at most ${PROMPTS_RESPONSES_BATCH_MAX_ITEMS} items are allowed` },
    };
  }
  for (const it of items) {
    if (it === null || typeof it !== 'object' || Array.isArray(it)) {
      return { status: 400, body: { error: 'malformed_item', message: 'each item must be an object' } };
    }
  }
  const topCountry = typeof b.country === 'string' ? b.country : undefined;
  const topEngine = typeof b.engine === 'string' ? b.engine : undefined;
  const llmForItem = (it) => engineToLlm(it.engine ?? topEngine) ?? LLM_ENUM.ALL;
  const attempted = items.map(hasRelationIdentity);
  // Up to PROMPTS_RESPONSES_BATCH_MAX_ITEMS (500) relation calls fan out here; that
  // ceiling plus API Gateway rate-limiting is the control against upstream gRPC
  // saturation (no per-request concurrency limiter — matches the ai-visibility handlers).
  const settled = await Promise.allSettled(
    items.map((it) => {
      if (!hasRelationIdentity(it)) { return Promise.resolve(null); }
      const { promptHash, topicId } = it;
      const serpId = String(it.serpId ?? '');
      return clients.prRelationsClient.prompt({
        country: resolveBatchCountry(it.country ?? topCountry),
        llm: llmForItem(it),
        promptHash,
        serpId,
        topicId,
      });
    }),
  );
  const relations = settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
  const data = items.map((it, i) => {
    const rel = relations[i]?.value ?? null;
    const relationStatus = relationStatusFor({ attempted: attempted[i], settled: settled[i] });
    // Batch has no brief excerpt to fall back to, so values are the `full | none` subset.
    const { response, responseSource, responseComplete } = deriveResponse(rel, '');
    return {
      promptHash: String(it.promptHash ?? ''),
      serpId: String(it.serpId ?? ''),
      topicId: String(it.topicId ?? ''),
      engine: llmToEngine(llmForItem(it)),
      prompt: rel?.prompt ?? '',
      response,
      responseSource,
      responseComplete,
      relationStatus,
      date: toIsoDate(rel?.date),
      citedPages: Array.isArray(rel?.sources) ? rel.sources : [],
      mentionedBrands: (rel?.mentionedBrands ?? []).map(mentionedBrandRestLabel).filter(Boolean),
    };
  });
  return { status: 200, body: { data, requested: items.length } };
}
