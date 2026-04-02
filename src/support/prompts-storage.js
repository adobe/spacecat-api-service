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
    if (!error && data?.id) return data.id;
    return null;
  }

  const { data, error } = await postgrestClient
    .from('brands')
    .select('id')
    .eq('organization_id', organizationId)
    .ilike('name', brandId)
    .maybeSingle();

  if (!error && data?.id) return data.id;
  return null;
}

/**
 * Resolves category business key to categories.id (uuid).
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} categoryId - Business key (e.g. "photoshop-photo-editing")
 * @param {object} postgrestClient - PostgREST client
 * @returns {Promise<string|null>} categories.id (uuid) or null
 */
export async function resolveCategoryUuid(organizationId, categoryId, postgrestClient) {
  if (!hasText(categoryId) || !postgrestClient?.from) return null;
  const { data, error } = await postgrestClient
    .from('categories')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('category_id', categoryId)
    .maybeSingle();
  return !error && data?.id ? data.id : null;
}

/**
 * Resolves topic business key to topics.id (uuid).
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {string} topicId - Business key
 * @param {object} postgrestClient - PostgREST client
 * @returns {Promise<string|null>} topics.id (uuid) or null
 */
export async function resolveTopicUuid(organizationId, topicId, postgrestClient) {
  if (!hasText(topicId) || !postgrestClient?.from) return null;
  const { data, error } = await postgrestClient
    .from('topics')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('topic_id', topicId)
    .maybeSingle();
  return !error && data?.id ? data.id : null;
}

/**
 * Builds in-memory lookup maps for category and topic business keys to UUIDs.
 * Fetches all categories/topics for the org in two bulk queries, replacing
 * per-prompt DB round-trips with O(1) Map lookups.
 */
async function buildLookupMaps(organizationId, postgrestClient) {
  const [catResult, topicResult] = await Promise.all([
    postgrestClient.from('categories').select('id,category_id').eq('organization_id', organizationId),
    postgrestClient.from('topics').select('id,topic_id').eq('organization_id', organizationId),
  ]);

  const categoryMap = new Map();
  (catResult.data || []).forEach((c) => categoryMap.set(c.category_id, c.id));

  const topicMap = new Map();
  (topicResult.data || []).forEach((t) => topicMap.set(t.topic_id, t.id));

  return { categoryMap, topicMap };
}

/**
 * Best-effort conversion of a category/topic slug back to a readable name.
 * Strips known DRS source prefixes, title-cases each word, and joins with
 * " & " to restore the original naming convention (e.g. "Comparison & Decision").
 *
 * NOTE: The prefix list must stay in sync with DRS _build_gsc / _build_base_url /
 * _build_agentic_traffic in spacecat_v2_prompts_sync.py. This is a fallback —
 * the primary fix is DRS sending explicit `id` so this path rarely executes.
 */
function slugToName(slug) {
  const stripped = slug.replace(/^(baseurl|gsc|agentic)-/, '');
  return stripped
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' & ');
}

/**
 * Ensures that all referenced categories and topics exist in their respective
 * tables. Creates any missing ones and updates the lookup maps in place.
 */
// eslint-disable-next-line max-len
async function ensureLookupEntries(organizationId, prompts, categoryMap, topicMap, postgrestClient, updatedBy) {
  const missingCategories = [];
  const missingTopics = [];

  for (const p of prompts) {
    if (hasText(p.categoryId) && !categoryMap.has(p.categoryId)) {
      missingCategories.push(p.categoryId);
    }
    if (hasText(p.topicId) && !topicMap.has(p.topicId)) {
      missingTopics.push(p.topicId);
    }
  }

  const ops = [];

  if (missingCategories.length > 0) {
    const unique = [...new Set(missingCategories)];
    const rows = unique.map((catId) => ({
      organization_id: organizationId,
      category_id: catId,
      name: slugToName(catId),
      origin: 'human',
      status: 'active',
      updated_by: updatedBy,
    }));
    ops.push(
      postgrestClient
        .from('categories')
        .upsert(rows, { onConflict: 'organization_id,category_id' })
        .select('id,category_id')
        .then(async ({ data, error }) => {
          if (!error) {
            data.forEach((c) => categoryMap.set(c.category_id, c.id));
            return;
          }
          // Unique name constraint — a category with the same name but different
          // category_id already exists.  Look it up by name and reuse its UUID.
          for (const catId of unique) {
            if (!categoryMap.has(catId)) {
              const name = slugToName(catId);
              // eslint-disable-next-line no-await-in-loop
              const { data: existing } = await postgrestClient
                .from('categories')
                .select('id,category_id')
                .eq('organization_id', organizationId)
                .eq('name', name)
                .maybeSingle();
              if (existing) categoryMap.set(catId, existing.id);
            }
          }
        }),
    );
  }

  if (missingTopics.length > 0) {
    const unique = [...new Set(missingTopics)];
    const rows = unique.map((topId) => ({
      organization_id: organizationId,
      topic_id: topId,
      name: slugToName(topId),
      status: 'active',
      updated_by: updatedBy,
    }));
    ops.push(
      postgrestClient
        .from('topics')
        .upsert(rows, { onConflict: 'organization_id,topic_id' })
        .select('id,topic_id')
        .then(async ({ data, error }) => {
          if (!error) {
            data.forEach((t) => topicMap.set(t.topic_id, t.id));
            return;
          }
          // Unique name constraint — fall back to lookup by name.
          for (const topId of unique) {
            if (!topicMap.has(topId)) {
              const name = slugToName(topId);
              // eslint-disable-next-line no-await-in-loop
              const { data: existing } = await postgrestClient
                .from('topics')
                .select('id,topic_id')
                .eq('organization_id', organizationId)
                .eq('name', name)
                .maybeSingle();
              if (existing) topicMap.set(topId, existing.id);
            }
          }
        }),
    );
  }

  if (ops.length > 0) await Promise.all(ops);
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
    id: row.prompt_id,
    uuid: row.id,
    prompt: row.text,
    name: row.name,
    regions: row.regions || [],
    categoryId: category?.category_id ?? null,
    topicId: topic?.topic_id ?? null,
    status: row.status || 'active',
    origin: row.origin || 'human',
    source: row.source || 'config',
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    brandId: brand?.id ?? null,
    brandName: brand?.name ?? null,
    category: category
      ? {
        id: category.category_id,
        uuid: category.id,
        name: category.name,
        origin: category.origin,
      }
      : null,
    topic: topic
      ? {
        id: topic.topic_id,
        uuid: topic.id,
        name: topic.name,
        categoryId: category?.category_id ?? null,
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
 * @param {string} [params.categoryId] - Filter by category business key
 * @param {string} [params.topicId] - Filter by topic business key
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
  if (!postgrestClient?.from) return [];

  let brandUuid = null;
  if (hasText(brandId)) {
    brandUuid = await resolveBrandUuid(organizationId, brandId, postgrestClient);
    if (!brandUuid) return [];
  }

  const MAX_LIMIT = 5000;
  const limitNum = Number(limit) || 100;
  if (limitNum < 1 || limitNum > MAX_LIMIT) {
    throw new Error(`Limit must be between 1 and ${MAX_LIMIT}`);
  }
  const pageNum = Math.max(1, Number(page) || 1);
  const offset = (pageNum - 1) * limitNum;

  const select = `
    id,
    prompt_id,
    name,
    text,
    regions,
    status,
    origin,
    source,
    category_id,
    topic_id,
    brand_id,
    created_at,
    created_by,
    updated_at,
    updated_by,
    brands(id,name),
    categories(id,category_id,name,origin),
    topics(id,topic_id,name)
  `;

  let baseQuery = postgrestClient
    .from('prompts')
    .select(select, { count: 'exact' })
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

  if (brandUuid) baseQuery = baseQuery.eq('brand_id', brandUuid);
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

  if (hasText(categoryId) || hasText(topicId)) {
    const categoryUuid = hasText(categoryId)
      ? await resolveCategoryUuid(organizationId, categoryId, postgrestClient)
      : null;
    const topicUuid = hasText(topicId)
      ? await resolveTopicUuid(organizationId, topicId, postgrestClient)
      : null;
    if (categoryUuid) baseQuery = baseQuery.eq('category_id', categoryUuid);
    if (topicUuid) baseQuery = baseQuery.eq('topic_id', topicUuid);
  }

  const { data: rows, error, count } = await baseQuery.range(offset, offset + limitNum - 1);

  if (error) throw new Error(`Failed to list prompts: ${error.message}`);
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
  if (!postgrestClient?.from) return null;
  if (!hasText(promptId)) return null;

  const { data, error } = await postgrestClient
    .from('prompts')
    .select(`
      id,
      prompt_id,
      name,
      text,
      regions,
      status,
      origin,
      source,
      category_id,
      topic_id,
      brand_id,
      created_at,
      created_by,
      updated_at,
      updated_by,
      brands(id,name),
      categories(id,category_id,name,origin),
      topics(id,topic_id,name)
    `)
    .eq('organization_id', organizationId)
    .eq('brand_id', brandUuid)
    .eq('prompt_id', promptId)
    .maybeSingle();

  if (error) throw new Error(`Failed to get prompt: ${error.message}`);
  if (!data) return null;

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
    .select('id,prompt_id,text,regions')
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

    const categoryUuid = hasText(p.categoryId) ? (categoryMap.get(p.categoryId) || null) : null;
    const topicUuid = hasText(p.topicId) ? (topicMap.get(p.topicId) || null) : null;

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
      updated_by: updatedBy,
    };

    if (match) {
      toUpdate.push({ ...row, id: match.id });
      processed.push({
        ...row, categoryId: p.categoryId, topicId: p.topicId, prompt_id: promptId,
      });
    } else {
      toInsert.push(row);
      processed.push({
        ...row, categoryId: p.categoryId, topicId: p.topicId, prompt_id: promptId,
      });
    }
  }

  let created = 0;
  let updated = 0;

  if (toInsert.length > 0) {
    const { data: inserted, error } = await postgrestClient.from('prompts').insert(toInsert).select();
    if (error) throw new Error(`Failed to insert prompts: ${error.message}`);
    created = inserted?.length ?? toInsert.length;
  }

  for (const row of toUpdate) {
    const { id, ...patch } = row;
    // eslint-disable-next-line no-await-in-loop, max-len
    const { error } = await postgrestClient.from('prompts').update(patch).eq('id', id);
    if (error) throw new Error(`Failed to update prompt: ${error.message}`);
    updated += 1;
  }

  const promptsOut = processed.map((r) => ({
    id: r.prompt_id,
    prompt: r.text,
    regions: r.regions,
    categoryId: r.categoryId,
    topicId: r.topicId,
    status: r.status,
    origin: r.origin,
    source: r.source,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  }));

  return { created, updated, prompts: promptsOut };
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
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');

  const patch = { updated_by: updatedBy };
  if (updates.prompt !== undefined) patch.text = updates.prompt;
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.regions !== undefined) patch.regions = updates.regions;
  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.origin !== undefined) patch.origin = updates.origin;
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

  const { data, error } = await postgrestClient
    .from('prompts')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('brand_id', brandUuid)
    .eq('prompt_id', promptId)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to update prompt: ${error.message}`);
  if (!data) return null;

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
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');

  const { data, error } = await postgrestClient
    .from('prompts')
    .update({ status: 'deleted', updated_by: updatedBy })
    .eq('organization_id', organizationId)
    .eq('brand_id', brandUuid)
    .eq('prompt_id', promptId)
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`Failed to delete prompt: ${error.message}`);
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
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');

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
