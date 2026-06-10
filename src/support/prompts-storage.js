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

/**
 * The 6 canonical intent buckets persisted in `prompts.intent`. Mirrors the
 * buckets DRS emits (see DRS `prompt_generation_agentic_traffic` generation
 * prompts) and that the stats intent breakdown aggregates over.
 */
const INTENT_VALUES = ['informational', 'instructional', 'comparative', 'transactional', 'planning', 'delegation'];
const CANONICAL_INTENTS = new Set(INTENT_VALUES);

/**
 * Legacy intent labels remapped onto the canonical buckets. Mirrors DRS
 * `INTENT_REMAP` (src/providers/prompt_generation_agentic_traffic/utils/
 * hard_validate.py) so values produced by older generations or external
 * callers collapse onto the supported set instead of dropping to NULL.
 */
const INTENT_REMAP = {
  statistical: 'informational',
  navigational: 'informational',
  commercial: 'transactional',
};

/**
 * Normalizes a caller-supplied intent for persistence into `prompts.intent`.
 *
 * Lowercases the value, applies the legacy remap, then validates against the
 * 6 canonical buckets. Absent, empty, or values that are still invalid after
 * remapping yield `null` — gap-filling (e.g. LLM classification of
 * human-added prompts) is handled elsewhere, so we never coerce to a default
 * bucket here.
 *
 * @param {*} intent - Raw intent value from the request body
 * @returns {string|null} Canonical lowercase intent, or null
 */
export function normalizeIntent(intent) {
  if (!hasText(intent)) {
    return null;
  }
  const lowered = intent.trim().toLowerCase();
  const remapped = INTENT_REMAP[lowered] || lowered;
  return CANONICAL_INTENTS.has(remapped) ? remapped : null;
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

const SORT_COLUMN_MAP = {
  topic: 'topics(name)',
  prompt: 'text',
  category: 'categories(name)',
  origin: 'origin',
  status: 'status',
  updatedAt: 'updated_at',
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
    origin: row.origin || 'human',
    source: row.source || 'config',
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

    if (hasText(region)) {
      baseQuery = baseQuery.contains('regions', [region]);
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
 * Upserts prompts into the prompts table.
 * Match by id (prompt_id) or by (text, regions). Regions normalized (lowercase, sorted).
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.brandUuid - brands.id (uuid)
 * @param {object[]} params.prompts - Array of { prompt_id?, prompt, regions,
 * categoryId, topicId, ... }
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} params.updatedBy - User performing the update
 * @returns {Promise<{created: number, updated: number, prompts: object[]}>}
 */
export async function upsertPrompts({
  organizationId,
  brandUuid,
  prompts,
  postgrestClient,
  updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for prompts');
  }

  const incomingIds = prompts
    .map((p) => p.id || p.prompt_id)
    .filter(hasText);

  let existingQuery = postgrestClient
    .from('prompts')
    .select('id,prompt_id,text,regions,status')
    .eq('organization_id', organizationId)
    .eq('brand_id', brandUuid);

  if (incomingIds.length > 0) {
    existingQuery = existingQuery.in('prompt_id', incomingIds);
  }

  const [{ data: existing }, lookups] = await Promise.all([
    existingQuery,
    buildLookupMaps(organizationId, postgrestClient),
  ]);

  const { categoryMap, topicMap } = lookups;

  // eslint-disable-next-line no-await-in-loop,max-len
  await ensureLookupEntries(organizationId, prompts, categoryMap, topicMap, postgrestClient, updatedBy);

  const getKey = (p) => {
    const norm = (p.regions || []).map((r) => String(r).toLowerCase()).sort();
    return `${String(p.prompt || p.text || '').trim()}:${norm.join(',')}`;
  };

  const existingById = new Map((existing || []).map((p) => [p.prompt_id, p]));
  const existingByKey = new Map(
    (existing || []).map((p) => [getKey({ prompt: p.text, regions: p.regions }), p]),
  );

  const toInsert = [];
  const toUpdate = [];
  const processed = [];

  for (const p of prompts) {
    const text = p.prompt || p.text;
    const regions = p.regions || [];
    const promptId = hasText(p.id)
      ? p.id
      : (p.prompt_id || crypto.randomUUID().toString());

    // eslint-disable-next-line max-len
    const match = existingById.get(promptId) || existingByKey.get(getKey({ prompt: text, regions }));

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
      source: p.source || 'config',
      intent: normalizeIntent(p.intent),
      updated_by: updatedBy,
    };

    if (match && match.status !== 'active') {
      // eslint-disable-next-line no-continue
      continue;
    }

    if (match) {
      toUpdate.push({ ...row, id: match.id });
      processed.push({ ...row, prompt_id: promptId });
    } else {
      toInsert.push(row);
      processed.push({ ...row, prompt_id: promptId });
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
      throw new Error(`Failed to insert prompts: ${error.message}`);
    }
    created = inserted?.length ?? toInsert.length;
  }

  for (const row of toUpdate) {
    const { id, ...patch } = row;
    // eslint-disable-next-line no-await-in-loop
    const { error } = await withMissingIntentFallback(
      postgrestClient,
      (includeIntent) => postgrestClient
        .from('prompts')
        .update(includeIntent ? patch : stripIntent(patch))
        .eq('id', id),
    );
    if (error) {
      throw new Error(`Failed to update prompt: ${error.message}`);
    }
    updated += 1;
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
 * @returns {Promise<object|null>} Updated prompt or null if not found
 */
export async function updatePromptById({
  organizationId,
  brandUuid,
  promptId,
  updates,
  postgrestClient,
  updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const patch = { updated_by: updatedBy };
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
  if (updates.origin !== undefined) {
    patch.origin = updates.origin;
  }
  if (updates.intent !== undefined) {
    // The shared fallback strips intent when the column is known-absent.
    patch.intent = normalizeIntent(updates.intent);
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
