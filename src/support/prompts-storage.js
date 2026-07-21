/* eslint-disable header/header */
/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and the License.
 */

import crypto from 'node:crypto';
import { hasText, isValidUUID } from '@adobe/spacecat-shared-utils';

import { classifyIntents } from './intent-classifier.js';
import { throwOnPgConstraintViolation } from './errors.js';
import { assertPermittedSource } from './prompt-sources.js';
import { INTENT_VALUES, normalizeIntent } from './intent.js';
import { canonicalizeSource, foldSourceValue } from './serenity/prompt-tags.js';

// Re-exported for backward compatibility — `normalizeIntent`/`INTENT_VALUES` now
// live in `./intent.js` so the LLM intent classifier can reuse them without an
// import cycle. Existing importers of these from `prompts-storage.js` keep working.
export { INTENT_VALUES, normalizeIntent };

/**
 * The closed `origin` vocabulary — who authored the prompt's text
 * (origin-dimension.md §1). Matches the `category_origin` enum on `prompts.origin`.
 */
export const V2_PROMPT_ORIGINS = Object.freeze(['ai', 'human']);
const DEFAULT_ORIGIN = 'human';

/**
 * Derives the `origin` to store for a v2-prompts write, as a function of the
 * request PRINCIPAL, never of the caller-supplied body value (origin-dimension.md
 * §3). `origin` records who authored the prompt's text and is read-only wherever a
 * user can reach it:
 *
 *   - a USER-authenticated principal (IMS / JWT) always writes `human`; any
 *     `origin` in the body is IGNORED (never rejected — the derived value is
 *     authoritative, so the caller loses nothing);
 *   - a SERVICE principal (e.g. DRS via admin `x-api-key`) is believed: its body
 *     value is honoured, validated against {@link V2_PROMPT_ORIGINS}, defaulting
 *     to `human` only when absent or out-of-vocabulary. This is the DRS contract
 *     (`origin: 'ai'`); dropping it would relabel every generated prompt `human`
 *     on its next upsert (origin-dimension.md §3 consequence 1).
 *
 * This governs CREATE only — `origin` is never patched on update (it is fixed by
 * the writer that created the row), which the update path enforces by not writing
 * the column at all.
 *
 * @param {unknown} bodyOrigin - the caller-supplied `origin`, or undefined.
 * @param {boolean} isUserPrincipal - true for an IMS/JWT user request.
 * @returns {string} the origin to store (`ai` or `human`).
 */
export function deriveV2PromptOrigin(bodyOrigin, isUserPrincipal) {
  if (isUserPrincipal) {
    return DEFAULT_ORIGIN;
  }
  return V2_PROMPT_ORIGINS.includes(/** @type {string} */ (bodyOrigin))
    ? /** @type {string} */ (bodyOrigin)
    : DEFAULT_ORIGIN;
}

/**
 * Per-client cache of whether `prompts.intent` is selectable/writable. Keyed by
 * the PostgREST client so unit tests (fresh mock clients) never bleed state and
 * production detects once per client instance. Absent = unknown (try with
 * intent); `false` = known-missing (skip intent up front).
 *
 * Why best-effort instead of bumping the IT image: the integration PostgREST
 * image is pinned to a data-service version that predates the `intent`
 * migration, and bumping it pulls in unrelated migrations + a constraint that
 * rejects the IT seed brand. So the code self-defends: when `intent` is absent,
 * prompts are still written/read WITHOUT intent rather than 500-ing.
 *
 * TODO: remove this fallback (the WeakMap, `isMissingIntentColumnError`, and the
 * try/detect/retry in withMissingIntentFallback) once the IT PostgREST image in
 * `test/it/postgres/docker-compose.yml` is bumped to a mysticat-data-service
 * version >= v5.27.0 that includes the `intent` column. Tracked in SITES-39521.
 */
const intentColumnSupported = new WeakMap();

/**
 * Detects a PostgREST/Postgres error that indicates the `intent` column is
 * absent. Covers the insert/upsert error (`PGRST204`, "Could not find the
 * 'intent' column of 'prompts' in the schema cache") and the select error
 * (`42703`, "column prompts.intent does not exist").
 *
 * Gated on the two specific error codes first, THEN on the column being
 * `intent`. This deliberately avoids broad message matching: an error that
 * merely mentions "intent" and "column" (e.g. a future check-constraint
 * violation "column intent violates check constraint") must NOT be treated as
 * a missing column, or the fallback would latch off and silently drop the
 * intent the caller sent — the exact data-loss bug this code exists to fix.
 *
 * @param {*} error - Error object from a PostgREST response (`{ message, details, hint, code }`)
 * @returns {boolean} true when the error is specifically about a missing `intent` column
 */
export function isMissingIntentColumnError(error) {
  if (!error) {
    return false;
  }
  const code = String(error.code || '').toUpperCase();
  if (code !== '42703' && code !== 'PGRST204') {
    return false;
  }
  const haystack = [error.message, error.details, error.hint]
    .filter((v) => v != null)
    .join(' ')
    .toLowerCase();
  return haystack.includes('intent');
}

/**
 * Removes the `intent` key from a row/patch (used when the column is known-absent).
 */
function stripIntent(row) {
  const { intent: _, ...rest } = row;
  return rest;
}

/**
 * Runs a PostgREST op that may reference `prompts.intent`, transparently degrading
 * when the column is absent (see intentColumnSupported). `run(includeIntent)` builds
 * AND executes the op with or without intent and resolves to a PostgREST result
 * (`{ error, ... }`). On the first missing-`intent`-column error for a client it
 * caches the fact and retries once without intent; subsequent calls skip intent up
 * front. Centralizes the try/detect/cache/retry the read and write paths share.
 *
 * @param {object} postgrestClient - PostgREST client (WeakMap key)
 * @param {(includeIntent: boolean) => Promise<object>} run - builds+executes the op
 * @returns {Promise<object>} the PostgREST result
 */
async function withMissingIntentFallback(postgrestClient, run) {
  const includeIntent = intentColumnSupported.get(postgrestClient) !== false;
  const result = await run(includeIntent);
  if (includeIntent && result?.error && isMissingIntentColumnError(result.error)) {
    intentColumnSupported.set(postgrestClient, false);
    return run(false);
  }
  return result;
}

// Bound the number of ids per `id=in.(...)` PostgREST GET so the query string
// stays well under proxy/header URL-length limits: a full page (pageSize caps at
// 1000) of ~36-char UUIDs would be ~37KB and risk a 414. 100 ids ≈ 3.7KB.
const INTENT_LOOKUP_CHUNK_SIZE = 100;

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Loads `intent` for a set of prompts by their `prompts.id` (uuid) values.
 * Used to enrich reads (e.g. brand-presence executions) that carry a `prompt_id`
 * FK but not intent itself. Any error — including a missing `intent` column — is a
 * non-fatal miss (empty Map) so callers never fail a request over this enrichment.
 * No missing-column retry is needed here: this helper's only output is intent, so a
 * column-absent environment simply yields an empty Map, same as the error path.
 *
 * The id list is chunked across parallel queries to bound the IN-clause URL length,
 * and an optional `organizationId` predicate scopes the lookup for defense-in-depth
 * (callers already pass tenant-scoped ids). A missing-`intent`-column error logs at
 * debug (benign, older DB image); any other error logs at warn so blank intent is
 * diagnosable — neither fails the caller.
 *
 * @param {object} params
 * @param {Array<string>} params.promptIds - prompts.id (uuid) values; nullish/dupes are ignored
 * @param {string} [params.organizationId] - scopes the lookup to this org (defense-in-depth)
 * @param {object} params.postgrestClient - PostgREST client
 * @param {object} [params.log] - logger; `debug` for benign missing-column, `warn` otherwise
 * @returns {Promise<Map<string, string>>} Map of promptId -> intent (only non-empty intents)
 */
export async function getIntentsByPromptIds({
  promptIds, organizationId, postgrestClient, log,
}) {
  const ids = [...new Set((promptIds || []).filter(Boolean))];
  if (!ids.length || !postgrestClient?.from) {
    return new Map();
  }

  const results = await Promise.all(
    chunkArray(ids, INTENT_LOOKUP_CHUNK_SIZE).map((batch) => {
      let query = postgrestClient.from('prompts').select('id, intent').in('id', batch);
      if (organizationId) {
        query = query.eq('organization_id', organizationId);
      }
      return query;
    }),
  );

  const map = new Map();
  results.forEach(({ data, error }) => {
    if (error) {
      if (isMissingIntentColumnError(error)) {
        log?.debug?.(`getIntentsByPromptIds: prompts.intent unavailable (${error.message}); returning no intent`);
      } else {
        log?.warn?.(`getIntentsByPromptIds: intent lookup failed (${error.message}); returning no intent`);
      }
      return;
    }
    (data || []).forEach((r) => {
      if (r.intent) {
        map.set(String(r.id), r.intent);
      }
    });
  });
  return map;
}

/**
 * Resolves brandId (path param) to Postgres brands.id (uuid).
 * Tries: 1) valid uuid lookup, 2) case-insensitive name lookup.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} brandId - From API path (uuid or name)
 * @param {object} postgrestClient - PostgREST client
 * @returns {Promise<string|null>} brands.id (uuid) or null
 */
export async function resolveBrandUuid(organizationId, brandId, postgrestClient) {
  if (!hasText(brandId) || !postgrestClient?.from) {
    return null;
  }

  if (isValidUUID(brandId)) {
    const { data, error } = await postgrestClient
      .from('brands')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('id', brandId)
      .maybeSingle();
    if (!error && data?.id) {
      return data.id;
    }
    return null;
  }

  const { data, error } = await postgrestClient
    .from('brands')
    .select('id')
    .eq('organization_id', organizationId)
    .ilike('name', brandId)
    .maybeSingle();

  if (!error && data?.id) {
    return data.id;
  }
  return null;
}

/**
 * Resolves a category UUID to categories.id (uuid), validating that the row
 * belongs to the organization. The v2 API exposes only the UUID primary key
 * (`categories.id`) as the category identifier, so the input must be a UUID.
 *
 * Returns null for anything that is not a valid UUID or does not resolve to a
 * row in the org. Callers that filter by category MUST treat null as "no
 * match" (return empty), never as "no filter" — the legacy dual-path
 * (UUID-or-business-key) silently dropped the filter when a UUID-shaped
 * business key failed to resolve, returning every prompt for the brand
 * (LLMO-5515).
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} categoryId - categories.id UUID
 * @param {object} postgrestClient - PostgREST client
 * @returns {Promise<string|null>} categories.id (uuid) or null
 */
export async function resolveCategoryUuid(organizationId, categoryId, postgrestClient) {
  if (!hasText(categoryId) || !isValidUUID(categoryId) || !postgrestClient?.from) {
    return null;
  }
  const { data, error } = await postgrestClient
    .from('categories')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('id', categoryId)
    .maybeSingle();
  return !error && data?.id ? data.id : null;
}

/**
 * Resolves topic business key or UUID to topics.id (uuid).
 * When topicId is a UUID it is looked up by primary key scoped to the
 * organization (consistent with resolveBrandUuid) — this validates org
 * ownership rather than blindly trusting the caller-supplied UUID.
 * When topicId is a business key it is looked up by topic_id as before.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} topicId - Business key or UUID
 * @param {object} postgrestClient - PostgREST client
 * @returns {Promise<string|null>} topics.id (uuid) or null
 */
export async function resolveTopicUuid(organizationId, topicId, postgrestClient) {
  if (!hasText(topicId) || !postgrestClient?.from) {
    return null;
  }
  const query = postgrestClient.from('topics').select('id').eq('organization_id', organizationId);
  const { data, error } = await (isValidUUID(topicId)
    ? query.eq('id', topicId)
    : query.eq('topic_id', topicId)
  ).maybeSingle();
  return !error && data?.id ? data.id : null;
}

/**
 * Builds in-memory lookup maps for category and topic names to UUIDs.
 * Keys are normalized (lowercase + trim) to handle legacy title-cased names.
 * Fetches all categories/topics for the org in two bulk queries, replacing
 * per-prompt DB round-trips with O(1) Map lookups.
 */
async function buildLookupMaps(organizationId, postgrestClient) {
  const [catResult, topicResult] = await Promise.all([
    postgrestClient.from('categories').select('id,name').eq('organization_id', organizationId),
    postgrestClient.from('topics').select('id,name').eq('organization_id', organizationId),
  ]);

  const categoryMap = new Map();
  (catResult.data || []).forEach((c) => {
    if (c.name) {
      categoryMap.set(c.name.toLowerCase().trim(), c.id);
    }
  });

  const topicMap = new Map();
  (topicResult.data || []).forEach((t) => {
    if (t.name) {
      topicMap.set(t.name.toLowerCase().trim(), t.id);
    }
  });

  return { categoryMap, topicMap };
}

/**
 * Ensures that all referenced categories and topics exist in their respective
 * tables. Creates any missing ones (by name) and updates the lookup maps in place.
 * Map keys are normalized (lowercase + trim) for case-insensitive matching.
 * New categories dedup on (organization_id, name) — the legacy `category_id`
 * business key is no longer set and falls to its random DB default (LLMO-5515).
 * New topics still set the `topic_id` business key from the name.
 */
// eslint-disable-next-line max-len
async function ensureLookupEntries(organizationId, prompts, categoryMap, topicMap, postgrestClient, updatedBy) {
  const missingCatNames = [...new Set(
    prompts
      .filter((p) => hasText(p.category) && !categoryMap.has(p.category.toLowerCase().trim()))
      .map((p) => p.category.trim()),
  )];

  const missingTopicNames = [...new Set(
    prompts
      .filter((p) => hasText(p.topic) && !topicMap.has(p.topic.toLowerCase().trim()))
      .map((p) => p.topic.trim()),
  )];

  const ops = [];

  if (missingCatNames.length > 0) {
    ops.push(
      postgrestClient
        .from('categories')
        .upsert(
          missingCatNames.map((name) => ({
            organization_id: organizationId,
            name,
            origin: 'human',
            status: 'active',
            updated_by: updatedBy,
          })),
          { onConflict: 'organization_id,name' },
        )
        .select('id,name')
        .then(({ data, error }) => {
          if (error) {
            // eslint-disable-next-line no-console
            console.warn(`Failed to auto-create categories: ${error.message}`);
            return;
          }
          (data || []).forEach((c) => categoryMap.set(c.name.toLowerCase().trim(), c.id));
        }),
    );
  }

  if (missingTopicNames.length > 0) {
    ops.push(
      postgrestClient
        .from('topics')
        .upsert(
          missingTopicNames.map((name) => ({
            organization_id: organizationId,
            topic_id: name,
            name,
            status: 'active',
            updated_by: updatedBy,
          })),
          { onConflict: 'organization_id,topic_id' },
        )
        .select('id,name')
        .then(({ data, error }) => {
          if (error) {
            // eslint-disable-next-line no-console
            console.warn(`Failed to auto-create topics: ${error.message}`);
            return;
          }
          (data || []).forEach((t) => topicMap.set(t.name.toLowerCase().trim(), t.id));
        }),
    );
  }

  if (ops.length > 0) {
    await Promise.all(ops);
  }
}

const UPDATE_CONCURRENCY = 20;

const SORT_COLUMN_MAP = {
  topic: 'topics(name)',
  prompt: 'text',
  category: 'categories(name)',
  origin: 'origin',
  status: 'status',
  updatedAt: 'updated_at',
  // FIX (WP-S2 interim): sort on the RAW `source` column. Stock PostgREST (the
  // backend) cannot order by an inline SQL expression like
  // `lower(replace(source,'_','-'))` — it returns 400 — and there is no canonical
  // column to name yet. WP-S4 adds a `source_canonical` generated column (+ its
  // index) and ordering moves to that column name, so the two drift spellings order
  // together; until then raw ordering only interleaves the `_`/`-` spellings of the
  // same producer, which is cosmetic (source-dimension.md §3.1).
  source: 'source',
};

function mapRowToPrompt(row) {
  const brand = row.brands;
  const category = row.categories;
  const topic = row.topics;
  return {
    // `id` is the TEXT business key (`prompts.prompt_id`) — used in URL paths
    // (GET/PATCH/DELETE `/prompts/:promptId`) and as the human-readable handle.
    // `uuid` is the UUID PK (`prompts.id`) — needed by DRS to populate the
    // `brand_presence_executions.prompt_id` UUID FK column. Removing `uuid`
    // (LLMO-4625 / PR #2199) caused 100% NULL prompt_id in BPE — keep both.
    id: row.prompt_id,
    uuid: row.id,
    prompt: row.text,
    name: row.name,
    regions: row.regions || [],
    status: row.status || 'active',
    // Return the stored `origin` verbatim — deliberately NO `|| 'human'` AND no
    // `?? 'human'` fallback (origin-dimension.md §WP-O2b item 4 / §2.3).
    // INVARIANT: `prompts.origin` is NOT NULL in production (zero NULLs in
    // 265,980 rows, §2.3). Any fallback — including nullish-coalescing, which
    // masks NULL exactly as `||` masks it for a NULL — would silently mislabel a
    // model-written (`ai`) prompt as `human` were a NULL ever present, the exact
    // corruption this dimension exists to prevent. Surfacing the raw value is the
    // fail-loud choice over a fabricated `human`; unlike `source`/`status`, whose
    // fallbacks are cosmetic, an origin fallback is a correctness hazard.
    origin: row.origin,
    // Second derivation boundary (source-dimension.md §3.1): the v2 read surface
    // returns the CANONICAL slug, so elmo's badge — which keys on the API's value —
    // resolves (`agentic_traffic` → `agentic-traffic`). A value that fails the guard
    // (empty, `:`, over-long, root-shadowing) returns the RAW string rather than
    // null: the grid must still show the operator what is stored. `?? 'config'` only
    // guards a nullish column (in-memory/test rows); the DB column is NOT NULL.
    source: canonicalizeSource(row.source) ?? row.source ?? 'config',
    intent: row.intent ?? null,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    brandId: brand?.id ?? null,
    brandName: brand?.name ?? null,
    // `uuid` is the UUID PK consumers must use for FK linkage (e.g. DRS reads
    // `category.uuid` / `topic.uuid` to populate
    // `brand_presence_executions.category_id` / `.topic_id`). Documented in
    // OpenAPI V2Prompt schema; absent here previously, which produced NULL FKs
    // for the v2 (brandalf) cohort. `id` kept unchanged for backward compat
    // (today it carries the UUID, not the business key as the OpenAPI schema
    // suggests; aligning to schema is a deferred breaking change).
    category: category
      ? {
        id: category.id,
        uuid: category.id,
        name: category.name,
        origin: category.origin,
      }
      : null,
    topic: topic
      ? {
        id: topic.id,
        uuid: topic.id,
        name: topic.name,
      }
      : null,
  };
}

/**
 * Lists prompts for an organization with optional filters and sorting.
 * Joins brands, categories, topics for enrichment.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} [params.brandId] - Filter by brand (uuid or config id)
 * @param {string} [params.categoryId] - Filter by category UUID (categories.id)
 * @param {string} [params.topicId] - Filter by topic business key or UUID
 * @param {string} [params.status] - Filter by status (active, pending, deleted)
 * @param {string} [params.search] - Free-text search across prompt text, name,
 * topic name, category name
 * @param {string} [params.region] - Filter by region (array containment)
 * @param {string} [params.origin] - Filter by origin (ai, human)
 * @param {string} [params.source] - Filter by source. Matched on the raw column
 * across both drift spellings (WP-S2 interim): `citation-attempt` also matches
 * `citation_attempt`. WP-S4 folds this to a single `source_canonical` column match.
 * @param {string} [params.sort] - Sort column (topic, prompt, category, origin,
 * status, updatedAt)
 * @param {string} [params.order] - Sort direction (asc, desc). Default desc
 * @param {number} [params.limit] - Page size (default 100, max 5000)
 * @param {number} [params.page] - Page number, 1-based (default 1)
 * @param {object} params.postgrestClient - PostgREST client
 * @returns {Promise<{items:object[],total:number,limit:number,page:number}>}
 */
export async function listPrompts({
  organizationId,
  brandId,
  categoryId,
  topicId,
  status,
  search,
  region,
  origin,
  source,
  sort,
  order,
  limit = 100,
  page = 1,
  postgrestClient,
}) {
  if (!postgrestClient?.from) {
    return [];
  }

  let brandUuid = null;
  if (hasText(brandId)) {
    brandUuid = await resolveBrandUuid(organizationId, brandId, postgrestClient);
    if (!brandUuid) {
      return [];
    }
  }

  const MAX_LIMIT = 5000;
  const limitNum = Number(limit) || 100;
  if (limitNum < 1 || limitNum > MAX_LIMIT) {
    throw new Error(`Limit must be between 1 and ${MAX_LIMIT}`);
  }
  const pageNum = Math.max(1, Number(page) || 1);
  const offset = (pageNum - 1) * limitNum;

  // Resolve category/topic filters up front and FAIL CLOSED: when a filter is
  // requested but does not resolve to a row in this org, return an empty page
  // rather than dropping the filter and returning every prompt for the brand.
  // Mirrors the brandUuid guard above. The unfiltered-leak this prevents was
  // LLMO-5515 (a UUID-shaped category business key that resolved to no row).
  const emptyPage = {
    items: [], total: 0, limit: limitNum, page: pageNum,
  };

  let categoryUuid = null;
  if (hasText(categoryId)) {
    categoryUuid = await resolveCategoryUuid(organizationId, categoryId, postgrestClient);
    if (!categoryUuid) {
      return emptyPage;
    }
  }

  let topicUuid = null;
  if (hasText(topicId)) {
    topicUuid = await resolveTopicUuid(organizationId, topicId, postgrestClient);
    if (!topicUuid) {
      return emptyPage;
    }
  }

  const buildSelect = (includeIntent) => `
    id,
    prompt_id,
    name,
    text,
    regions,
    status,
    origin,
    source,${includeIntent ? '\n    intent,' : ''}
    category_id,
    topic_id,
    brand_id,
    created_at,
    created_by,
    updated_at,
    updated_by,
    brands(id,name),
    categories(id,name,origin),
    topics(id,topic_id,name)
  `;

  // Best-effort against environments where `prompts.intent` is absent (see
  // intentColumnSupported): try with intent, and on a missing-column error
  // remember it for this client and re-run the select without intent.
  const run = (includeIntent) => {
    let baseQuery = postgrestClient
      .from('prompts')
      .select(buildSelect(includeIntent), { count: 'exact' })
      .eq('organization_id', organizationId);

    // Sorting
    const sortCol = SORT_COLUMN_MAP[sort];
    if (sortCol) {
      const ascending = order === 'asc';
      if (sortCol.includes('(')) {
        const [foreignTable, col] = sortCol.replace(')', '').split('(');
        baseQuery = baseQuery.order(col, { ascending, foreignTable });
      } else {
        baseQuery = baseQuery.order(sortCol, { ascending });
      }
      baseQuery = baseQuery.order('id', { ascending: true });
    } else {
      baseQuery = baseQuery
        .order('updated_at', { ascending: false })
        .order('id', { ascending: true });
    }

    if (brandUuid) {
      baseQuery = baseQuery.eq('brand_id', brandUuid);
    }
    if (hasText(status)) {
      baseQuery = baseQuery.eq('status', status);
    } else {
      baseQuery = baseQuery.neq('status', 'deleted');
    }

    if (hasText(origin)) {
      baseQuery = baseQuery.eq('origin', origin);
    }

    if (hasText(source)) {
      // FIX (WP-S2 interim): match on the RAW `source` column, not a canonical SQL
      // expression — stock PostgREST 400s on `lower(replace(source,'_','-'))=eq.…`.
      // To keep "filter by the value the grid shows" working across a producer's two
      // drift spellings, fold the incoming value to canonical (shared
      // `foldSourceValue` — the single definition of the transform) and match BOTH
      // the hyphen and underscore forms, so `citation-attempt` also finds rows stored
      // as `citation_attempt`. WP-S4's `source_canonical` generated column replaces
      // this with a single canonical-column match (and adds case-folding, which raw
      // matching drops).
      const wanted = foldSourceValue(source);
      const sourceVariants = [...new Set([wanted, wanted.replace(/-/g, '_')])];
      baseQuery = baseQuery.in('source', sourceVariants);
    }

    if (hasText(region)) {
      // Stored region codes can be lower- or upper-case, so match both
      // variants — a case-sensitive `.contains` would miss the other. (LLMO-5755)
      const regionVariants = [...new Set([region.toLowerCase(), region.toUpperCase()])];
      baseQuery = baseQuery.overlaps('regions', regionVariants);
    }

    if (hasText(search)) {
      const term = `%${search}%`;
      baseQuery = baseQuery.or(`text.ilike.${term},name.ilike.${term}`);
    }

    if (categoryUuid) {
      baseQuery = baseQuery.eq('category_id', categoryUuid);
    }
    if (topicUuid) {
      baseQuery = baseQuery.eq('topic_id', topicUuid);
    }

    return baseQuery.range(offset, offset + limitNum - 1);
  };

  const { data: rows, error, count } = await withMissingIntentFallback(postgrestClient, run);

  if (error) {
    throw new Error(`Failed to list prompts: ${error.message}`);
  }
  if (!rows?.length) {
    return {
      items: [], total: count ?? 0, limit: limitNum, page: pageNum,
    };
  }

  const prompts = rows.map(mapRowToPrompt);
  return {
    items: prompts, total: count ?? prompts.length, limit: limitNum, page: pageNum,
  };
}

/**
 * Gets a single prompt by organization, brand, and prompt_id.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.brandUuid - brands.id (uuid)
 * @param {string} params.promptId - prompt_id (business key)
 * @param {object} params.postgrestClient - PostgREST client
 * @returns {Promise<object|null>} Prompt or null if not found
 */
export async function getPromptById({
  organizationId,
  brandUuid,
  promptId,
  postgrestClient,
}) {
  if (!postgrestClient?.from) {
    return null;
  }
  if (!hasText(promptId)) {
    return null;
  }

  // Best-effort against environments where `prompts.intent` is absent: try with
  // intent, and on a missing-column error remember it and re-run without intent.
  const run = (includeIntent) => postgrestClient
    .from('prompts')
    .select(`
      id,
      prompt_id,
      name,
      text,
      regions,
      status,
      origin,
      source,${includeIntent ? '\n      intent,' : ''}
      category_id,
      topic_id,
      brand_id,
      created_at,
      created_by,
      updated_at,
      updated_by,
      brands(id,name),
      categories(id,name,origin),
      topics(id,topic_id,name)
    `)
    .eq('organization_id', organizationId)
    .eq('brand_id', brandUuid)
    .eq('prompt_id', promptId)
    .maybeSingle();

  const { data, error } = await withMissingIntentFallback(postgrestClient, run);

  if (error) {
    throw new Error(`Failed to get prompt: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  return mapRowToPrompt(data);
}

/**
 * Canonical prompt-identity key: `lower(text):sorted(regions):source`, matching
 * the store's partial unique index (brand_id, lower(text), sorted_regions, source)
 * (SITES-47870). Both the incoming-match map and the pre-insert dedup use this so
 * their normalization can't drift apart. `source` defaults to 'config' to mirror
 * the column default for prompts that omit it.
 *
 * @param {{ text?: string, regions?: string[], source?: string }} p
 * @returns {string}
 */
function buildPromptKey({ text, regions, source }) {
  const t = String(text || '').trim().toLowerCase();
  const r = (regions || []).map((x) => String(x).toLowerCase()).sort().join(',');
  return `${t}:${r}:${source || 'config'}`;
}

/**
 * Upserts prompts into the prompts table.
 * Match by id (prompt_id) or by (text, regions, source). Regions normalized (lowercase, sorted).
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.brandUuid - brands.id (uuid)
 * @param {object[]} params.prompts - Array of { prompt_id?, prompt, regions,
 * categoryId, topicId, ... }
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} params.updatedBy - User performing the update
 * @param {((text: string) => Promise<string|null>)} [params.classifyIntent] -
 *   Optional best-effort intent classifier; applied only to prompts that change
 *   text without an explicit intent. Non-fatal: a null result leaves intent unset.
 * @param {number} [params.classifyIntentBatchTimeoutMs] - Cap on the classifier
 *   batch (ms); the upsert proceeds without intent once it elapses.
 * @returns {Promise<{created: number, updated: number, prompts: object[]}>}
 */
export async function upsertPrompts({
  organizationId,
  brandUuid,
  prompts,
  postgrestClient,
  updatedBy = 'system',
  classifyIntent,
  classifyIntentBatchTimeoutMs = 8000,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for prompts');
  }

  // Write-boundary chokepoint (SITES-47870 / D2): validate every source up front,
  // before any DB work or side effects. ensureLookupEntries (below) creates
  // category/topic rows for the whole batch, so validating per-prompt inside the
  // main loop would leave orphan lookup rows when a later prompt's source is
  // rejected. Fail the whole batch first, cleanly.
  for (const p of prompts) {
    assertPermittedSource(p.source || 'config');
  }

  const incomingIds = prompts
    .map((p) => p.id || p.prompt_id)
    .filter(hasText);

  const [{ data: existing }, lookups] = await Promise.all([
    withMissingIntentFallback(postgrestClient, (includeIntent) => {
      const cols = includeIntent
        ? 'id,prompt_id,text,regions,status,source,intent'
        : 'id,prompt_id,text,regions,status,source';
      let q = postgrestClient
        .from('prompts')
        .select(cols)
        .eq('organization_id', organizationId)
        .eq('brand_id', brandUuid);
      if (incomingIds.length > 0) {
        q = q.in('prompt_id', incomingIds);
      }
      return q;
    }),
    buildLookupMaps(organizationId, postgrestClient),
  ]);

  const { categoryMap, topicMap } = lookups;

  // eslint-disable-next-line no-await-in-loop,max-len
  await ensureLookupEntries(organizationId, prompts, categoryMap, topicMap, postgrestClient, updatedBy);

  // `source` is part of prompt identity (SITES-47870): the store's unique key is
  // (brand_id, lower(text), sorted_regions(regions), source), so the same text
  // and regions produced by two pipelines coexists as separate per-source rows.
  // Match/dedup here must therefore key on source too, or an incoming prompt
  // would be matched to an existing same-text row of a DIFFERENT source and
  // update it (moving counts between columns) instead of inserting its own row.
  const getKey = (p) => buildPromptKey({
    text: p.prompt || p.text,
    regions: p.regions,
    source: p.source,
  });

  const existingById = new Map((existing || []).map((p) => [p.prompt_id, p]));
  const existingByKey = new Map(
    (existing || []).map(
      (p) => [getKey({ prompt: p.text, regions: p.regions, source: p.source }), p],
    ),
  );

  const toInsert = [];
  const toUpdate = [];
  const processed = [];

  for (const p of prompts) {
    const text = p.prompt || p.text;
    const regions = p.regions || [];
    const source = p.source || 'config';
    const promptId = hasText(p.id)
      ? p.id
      : (p.prompt_id || crypto.randomUUID().toString());

    // eslint-disable-next-line max-len
    const match = existingById.get(promptId) || existingByKey.get(getKey({ prompt: text, regions, source }));

    const categoryUuid = hasText(p.category)
      ? categoryMap.get(p.category.toLowerCase().trim()) || null
      : null;
    const topicUuid = hasText(p.topic)
      ? topicMap.get(p.topic.toLowerCase().trim()) || null
      : null;

    const row = {
      organization_id: organizationId,
      brand_id: brandUuid,
      prompt_id: promptId,
      name: p.name || (text ? text.slice(0, 255) : null) || promptId,
      text,
      regions,
      category_id: categoryUuid,
      topic_id: topicUuid,
      status: p.status || 'active',
      origin: p.origin || 'human',
      source,
      intent: normalizeIntent(p.intent),
      updated_by: updatedBy,
    };

    // `source` is immutable on an UPDATE (SITES-47870). getKey folds source into
    // the match key, so a key-match always shares source; but existingById
    // matches by prompt_id ALONE, so an id-match can carry a different incoming
    // source. Overwriting it would silently move an existing row between report
    // columns (the exact corruption the source-aware key prevents) and could
    // raise an unmapped 23505 on the UPDATE. Preserve the stored source; source
    // is only set at insert time. The `match.source ?? source` below is a
    // defensive fallback only: the companion migration (#793) makes prompts.source
    // NOT NULL, so match.source is always present for a real DB row — the `??`
    // just keeps an in-memory/test row without a source from becoming `undefined`;
    // it is NOT a backfill path.
    if (match && match.status !== 'active') {
      if (match.status === 'deleted') {
        const reactivated = {
          ...row,
          id: match.id,
          status: 'active',
          intent: row.intent ?? match.intent,
          source: match.source ?? source,
          // `origin` is fixed by the writer that created the row and is never
          // re-derived on a later write (origin-dimension.md §3): preserve the
          // stored value across a reactivation. `?? row.origin` is a defensive
          // fallback for an in-memory/test match without an origin, mirroring
          // `source` above — not a backfill path (prod has zero NULL origins).
          origin: match.origin ?? row.origin,
        };
        toUpdate.push(reactivated);
        processed.push({ ...reactivated, prompt_id: promptId });
      }
      // eslint-disable-next-line no-continue
      continue;
    }

    if (match) {
      // `source` AND `origin` are both immutable on an UPDATE: source names the
      // producing system, origin names the writer that created the row, and
      // neither is re-derived on a later write (origin-dimension.md §3). Preserve
      // the stored values so a user-principal derive of `human` cannot relabel an
      // existing `ai` prompt. `?? row.*` is the same defensive in-memory/test
      // fallback used for `source` — not a backfill.
      const updated = {
        ...row,
        id: match.id,
        source: match.source ?? source,
        origin: match.origin ?? row.origin,
      };
      toUpdate.push(updated);
      processed.push({ ...updated, prompt_id: promptId });
    } else {
      toInsert.push(row);
      processed.push({ ...row, prompt_id: promptId });
    }
  }

  // Guard against uq_prompt_text_region_source_per_brand: deduplicate toInsert
  // by (lower(text), sorted_regions, source) before the bulk INSERT. For a new
  // brand existingByKey is empty, so cross-topic text collisions all land here.
  // `source` is part of the key (SITES-47870), so the same text under two
  // different sources is NOT a collision — each keeps its own row.
  // Deterministic tie-break: sort by (topic_id, prompt_id) asc, keep first.
  // Each drop is logged (warn) with a text hash — auditable without echoing
  // customer data. Dropped entries are removed from processed so counts stay
  // honest. Guard is > 1: a single-row batch cannot collide with itself.
  if (toInsert.length > 1) {
    const dedupKey = (row) => buildPromptKey(row);
    const sortedForDedup = [...toInsert].sort((a, b) => {
      const tCmp = String(a.topic_id ?? '').localeCompare(String(b.topic_id ?? ''));
      return tCmp !== 0 ? tCmp : String(a.prompt_id).localeCompare(String(b.prompt_id));
    });
    const winnerByKey = new Map();
    const droppedIds = new Set();
    for (const row of sortedForDedup) {
      const key = dedupKey(row);
      if (winnerByKey.has(key)) {
        droppedIds.add(row.prompt_id);
        // eslint-disable-next-line no-console
        console.warn('[upsertPrompts] dedup-drop', {
          brand_id: row.brand_id,
          text_hash: crypto.createHash('sha256').update(row.text || '').digest('hex').slice(0, 12),
          dropped_prompt_id: row.prompt_id,
          dropped_topic_id: row.topic_id ?? null,
          winning_prompt_id: winnerByKey.get(key).prompt_id,
          winning_topic_id: winnerByKey.get(key).topic_id ?? null,
        });
      } else {
        winnerByKey.set(key, row);
      }
    }
    if (droppedIds.size > 0) {
      const keep = (r) => !droppedIds.has(r.prompt_id);
      toInsert.splice(0, toInsert.length, ...toInsert.filter(keep));
      processed.splice(0, processed.length, ...processed.filter(keep));
    }
  }

  // Best-effort intent classification for prompts that arrived WITHOUT an
  // intent. Failures leave intent null; the backfill path covers them later.
  if (typeof classifyIntent === 'function') {
    const rowsNeedingIntent = [...toInsert, ...toUpdate]
      .filter((r) => r.intent === null && hasText(r.text));
    if (rowsNeedingIntent.length > 0) {
      const intentByText = await classifyIntents(
        classifyIntent,
        rowsNeedingIntent.map((r) => r.text),
        { timeoutMs: classifyIntentBatchTimeoutMs },
      );
      const apply = (r) => {
        const classified = intentByText.get(r.text);
        if (r.intent === null && hasText(r.text) && classified != null) {
          // eslint-disable-next-line no-param-reassign
          r.intent = classified;
        }
      };
      toInsert.forEach(apply);
      toUpdate.forEach(apply);
      processed.forEach(apply);
    }
  }

  let created = 0;
  let updated = 0;
  const skipped = prompts.length - toInsert.length - toUpdate.length;

  // Best-effort against environments where `prompts.intent` is absent: the
  // shared helper drops intent and retries when the column is missing.
  if (toInsert.length > 0) {
    const { data: inserted, error } = await withMissingIntentFallback(
      postgrestClient,
      (includeIntent) => postgrestClient
        .from('prompts')
        .insert(includeIntent ? toInsert : toInsert.map(stripIntent))
        .select(),
    );
    if (error) {
      throwOnPgConstraintViolation(error, {
        23505: { status: 409, message: 'A prompt with the same text, region and source already exists for this brand.' },
      });
      throw new Error(`Failed to insert prompts: ${error.message}`);
    }
    created = inserted?.length ?? toInsert.length;
  }

  if (toUpdate.length > 0) {
    let cursor = 0;
    const errors = [];
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= toUpdate.length) {
          return;
        }
        const { id, ...patch } = toUpdate[index];
        // eslint-disable-next-line no-await-in-loop
        const { error } = await withMissingIntentFallback(
          postgrestClient,
          (includeIntent) => postgrestClient
            .from('prompts')
            .update(includeIntent ? patch : stripIntent(patch))
            .eq('id', id),
        );
        if (error) {
          errors.push(error);
        } else {
          updated += 1;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(UPDATE_CONCURRENCY, toUpdate.length) }, () => worker()),
    );
    if (errors.length > 0) {
      throw new Error(`Failed to update ${errors.length} prompt(s): ${errors.map((e) => e.message).join('; ')}`);
    }
  }

  const promptsOut = processed.map((r) => ({
    id: r.prompt_id,
    prompt: r.text,
    regions: r.regions,
    status: r.status,
    origin: r.origin,
    source: r.source,
    intent: r.intent,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  }));

  return {
    created, updated, skipped, prompts: promptsOut,
  };
}

/**
 * Updates a single prompt by id (prompts.id uuid) or prompt_id (business key).
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.brandUuid - brands.id (uuid)
 * @param {string} params.promptId - prompt_id (business key) from path
 * @param {object} params.updates - Partial prompt fields to update
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} params.updatedBy - User performing the update
 * @param {((text: string) => Promise<string|null>)} [params.classifyIntent] -
 *   Optional best-effort classifier; used only when the text changes WITHOUT an
 *   explicit intent. Non-fatal: a null result simply leaves intent unset.
 * @returns {Promise<object|null>} Updated prompt or null if not found
 */
export async function updatePromptById({
  organizationId,
  brandUuid,
  promptId,
  updates,
  postgrestClient,
  updatedBy = 'system',
  classifyIntent,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const patch = { updated_by: updatedBy };
  // `source` is deliberately NOT patchable (source-dimension.md §1 item 6): a
  // prompt's producer is fixed at creation, and the dimension has no write surface.
  // A caller-supplied `updates.source` is ignored rather than written.
  if (updates.prompt !== undefined) {
    patch.text = updates.prompt;
  }
  if (updates.name !== undefined) {
    patch.name = updates.name;
  }
  if (updates.regions !== undefined) {
    patch.regions = updates.regions;
  }
  if (updates.status !== undefined) {
    patch.status = updates.status;
  }
  // `origin` is deliberately NOT patchable: it is fixed by the writer that
  // created the row and is never re-derived on update (origin-dimension.md §3
  // item 3 / §1 item 5). A caller-supplied `origin` in the PATCH body is ignored,
  // leaving the stored value — including an `ai` prompt's — untouched.
  if (updates.intent !== undefined) {
    // The shared fallback strips intent when the column is known-absent.
    patch.intent = normalizeIntent(updates.intent);
  } else if (typeof classifyIntent === 'function' && hasText(patch.text)) {
    // No intent supplied but the text changed: best-effort classify the new
    // text. Non-fatal — a null result simply leaves intent unset on the patch.
    const intent = await classifyIntent(patch.text).catch(() => null);
    if (intent !== null) {
      patch.intent = intent;
    }
  }
  if (updates.categoryId !== undefined) {
    patch.category_id = hasText(updates.categoryId)
      ? await resolveCategoryUuid(organizationId, updates.categoryId, postgrestClient)
      : null;
  }
  if (updates.topicId !== undefined) {
    patch.topic_id = hasText(updates.topicId)
      ? await resolveTopicUuid(organizationId, updates.topicId, postgrestClient)
      : null;
  }

  const runUpdate = (p) => postgrestClient
    .from('prompts')
    .update(p)
    .eq('organization_id', organizationId)
    .eq('brand_id', brandUuid)
    .eq('prompt_id', promptId)
    .select()
    .maybeSingle();

  const { data, error } = await withMissingIntentFallback(
    postgrestClient,
    (includeIntent) => runUpdate(includeIntent ? patch : stripIntent(patch)),
  );

  if (error) {
    throw new Error(`Failed to update prompt: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  return getPromptById({
    organizationId,
    brandUuid,
    promptId,
    postgrestClient,
  });
}

/**
 * Normalizes a regions array for set comparison: lower-cased, trimmed, non-empty
 * codes, sorted. Used by the brand-region consistency guard so casing/order
 * differences never defeat the removed-region comparison.
 *
 * @param {string[]} regions
 * @returns {string[]} normalized, sorted region codes
 */
function normalizeRegionsForCompare(regions) {
  if (!Array.isArray(regions)) {
    return [];
  }
  return regions
    .filter((r) => r != null)
    .map((r) => (typeof r === 'string' ? r : String(r)).trim().toLowerCase())
    .filter((r) => r.length > 0)
    .sort();
}

/**
 * Counts, per region, how many of a brand's non-deleted prompts still use each
 * of the given regions (LLMO-5645). Used to guard a brand-level region change:
 * DRS schedules off each prompt's `regions`, so a region must not be removed
 * from a brand while prompts still reference it (that would orphan those
 * prompts on a market the brand no longer covers). The operator relocates the
 * prompts first; comparison is case-insensitive. Deleted prompts are skipped.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.brandUuid - brands.id (uuid)
 * @param {string[]} params.oldRegions - brand regions BEFORE the update
 * @param {string[]} params.newRegions - brand regions AFTER the update
 * @param {object} params.postgrestClient - PostgREST client
 * @param {object} [params.log] - Logger
 * @returns {Promise<Record<string, number>>} map of removed region (lowercase)
 *   → count of prompts still using it; empty when nothing blocks the change
 */
export async function findPromptsBlockingRegionRemoval({
  organizationId,
  brandUuid,
  oldRegions,
  newRegions,
  postgrestClient,
  log = console,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const newSet = new Set(normalizeRegionsForCompare(newRegions));
  const removed = normalizeRegionsForCompare(oldRegions).filter((r) => !newSet.has(r));
  if (removed.length === 0) {
    return {};
  }

  // Fetch the brand's non-deleted prompts. A single brand carries tens to a few
  // hundred prompts in practice; cap the read and warn (never silently truncate)
  // if a brand somehow exceeds it so the operator knows the check was partial.
  const READ_CAP = 5000;
  const { data, error } = await postgrestClient
    .from('prompts')
    .select('id, regions')
    .eq('organization_id', organizationId)
    .eq('brand_id', brandUuid)
    .neq('status', 'deleted')
    .limit(READ_CAP);

  if (error) {
    throw new Error(`Failed to read prompts for region consistency check: ${error.message}`);
  }

  const prompts = data || [];
  if (prompts.length >= READ_CAP) {
    log.warn?.(`findPromptsBlockingRegionRemoval: brand ${brandUuid} has >= ${READ_CAP} prompts; `
      + 'consistency check may be partial');
  }

  const counts = {};
  prompts.forEach((p) => {
    const promptRegions = new Set(normalizeRegionsForCompare(p.regions));
    removed.forEach((r) => {
      if (promptRegions.has(r)) {
        counts[r] = (counts[r] || 0) + 1;
      }
    });
  });

  return counts;
}

/**
 * Soft-deletes a prompt by setting status to 'deleted'.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.brandUuid - brands.id (uuid)
 * @param {string} params.promptId - prompt_id (business key)
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} params.updatedBy - User performing the delete
 * @returns {Promise<boolean>} True if updated, false if not found
 */
export async function deletePromptById({
  organizationId,
  brandUuid,
  promptId,
  postgrestClient,
  updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const { data, error } = await postgrestClient
    .from('prompts')
    .update({ status: 'deleted', updated_by: updatedBy })
    .eq('organization_id', organizationId)
    .eq('brand_id', brandUuid)
    .eq('prompt_id', promptId)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to delete prompt: ${error.message}`);
  }
  return !!data;
}

/**
 * Bulk soft-deletes prompts by setting status to 'deleted'.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.brandUuid - brands.id (uuid)
 * @param {string[]} params.promptIds - Array of prompt_id business keys
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} params.updatedBy - User performing the delete
 * @returns {Promise<{metadata:{total:number,success:number,failure:number},failures:object[]}>}
 */
export async function bulkDeletePrompts({
  organizationId,
  brandUuid,
  promptIds,
  postgrestClient,
  updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const total = promptIds.length;
  let success = 0;
  const failures = [];

  for (const promptId of promptIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await postgrestClient
        .from('prompts')
        .update({ status: 'deleted', updated_by: updatedBy })
        .eq('organization_id', organizationId)
        .eq('brand_id', brandUuid)
        .eq('prompt_id', promptId)
        .select('id')
        .maybeSingle();

      if (error) {
        failures.push({ promptId, reason: error.message });
      } else if (!data) {
        failures.push({ promptId, reason: 'Prompt not found' });
      } else {
        success += 1;
      }
    } catch (err) {
      failures.push({ promptId, reason: err.message });
    }
  }

  return {
    metadata: { total, success, failure: failures.length },
    failures,
  };
}

export async function checkPromptsExist({ brandUuid, prompts, postgrestClient }) {
  if (!postgrestClient?.rpc) {
    throw new Error('PostgREST client is required');
  }

  const { data, error } = await postgrestClient.rpc('rpc_check_prompts_exist', {
    p_brand_id: brandUuid,
    p_prompts: prompts,
  });

  if (error) {
    throw new Error(`checkPromptsExist RPC failed: ${error.message}`);
  }

  return data ?? [];
}

export async function getPromptStats({ organizationId, brandUuid, postgrestClient }) {
  if (!postgrestClient?.rpc) {
    throw new Error('PostgREST client is required');
  }

  const { data, error } = await postgrestClient.rpc('rpc_brand_prompt_stats', {
    p_organization_id: organizationId,
    p_brand_id: brandUuid,
  });

  if (error) {
    throw new Error(`getPromptStats RPC failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? (data[0] ?? {}) : (data ?? {});
  const intents = Object.fromEntries(
    INTENT_VALUES.map((k) => [k, Number(row[`intent_${k}`]) || 0]),
  );

  return {
    branded: Number(row.branded) || 0,
    unbranded: Number(row.unbranded) || 0,
    intents,
  };
}
