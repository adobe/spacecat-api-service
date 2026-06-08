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

import { hasText } from '@adobe/spacecat-shared-utils';

const MAX_LIMIT = 5000;
const ALLOWED_STATUSES = new Set(['ignored', 'added']);

function normalizeRegion(value) {
  return String(value || '').trim().toLowerCase().slice(0, 2);
}

function normalizeSource(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function buildKey({ text, region, source }) {
  return `${text.toLowerCase()}|${region}|${source}`;
}

function mapRowToItem(row) {
  return {
    id: row.id,
    text: row.prompt_text,
    region: row.region_code,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Upserts gsc_prompts rows. Idempotent on `(brand, lower(text), region, source)`:
 * if a row exists, the status is updated in place; if not, a new row is
 * inserted. Same status as the existing row → counted as skipped (no-op).
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.brandUuid
 * @param {{text:string,region:string,source:string,status:string}[]} params.items
 * @param {object} params.postgrestClient
 * @param {string} [params.createdBy='system']
 * @returns {Promise<{created:number,updated:number,skipped:number,items:object[]}>}
 */
export async function upsertGscPrompts({
  organizationId,
  brandUuid,
  items,
  postgrestClient,
  createdBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }
  if (!Array.isArray(items) || items.length === 0) {
    return {
      created: 0, updated: 0, skipped: 0, items: [],
    };
  }

  const normalized = items.map((item) => ({
    text: normalizeText(item.text),
    region: normalizeRegion(item.region),
    source: normalizeSource(item.source),
    status: normalizeStatus(item.status),
  }));

  for (const n of normalized) {
    if (!hasText(n.text)) {
      throw new Error('Each item must include a non-empty text');
    }
    if (!hasText(n.region)) {
      throw new Error('Each item must include a non-empty region');
    }
    if (!hasText(n.source)) {
      throw new Error('Each item must include a non-empty source');
    }
    if (!ALLOWED_STATUSES.has(n.status)) {
      throw new Error(`status must be one of: ${[...ALLOWED_STATUSES].join(', ')}`);
    }
  }

  // Dedup the incoming list itself first — keep the last occurrence per key.
  const incoming = new Map();
  for (const n of normalized) {
    incoming.set(buildKey(n), n);
  }

  // Pull existing rows for this brand. Functional unique index on
  // lower(prompt_text) means PostgREST can't ON CONFLICT, so dedup happens
  // application-side — same pattern as prompts-storage.js upsertPrompts.
  const { data: existing, error: existingError } = await postgrestClient
    .from('gsc_prompts')
    .select('id,prompt_text,region_code,source,status')
    .eq('brand_id', brandUuid);

  if (existingError) {
    throw new Error(`Failed to fetch existing gsc_prompts: ${existingError.message}`);
  }

  const existingByKey = new Map(
    (existing || []).map((r) => [buildKey({
      text: r.prompt_text,
      region: r.region_code,
      source: r.source,
    }), r]),
  );

  const toInsert = [];
  const toUpdate = [];
  let skipped = 0;

  for (const [key, n] of incoming) {
    const match = existingByKey.get(key);
    if (!match) {
      toInsert.push({
        organization_id: organizationId,
        brand_id: brandUuid,
        prompt_text: n.text,
        region_code: n.region,
        source: n.source,
        status: n.status,
        created_by: createdBy,
        updated_by: createdBy,
      });
    } else if (match.status === n.status) {
      skipped += 1;
    } else {
      toUpdate.push({ id: match.id, status: n.status });
    }
  }

  const resultItems = [];

  if (toInsert.length > 0) {
    const { data: inserted, error: insertError } = await postgrestClient
      .from('gsc_prompts')
      .insert(toInsert)
      .select();

    if (insertError) {
      throw new Error(`Failed to insert gsc_prompts: ${insertError.message}`);
    }
    for (const row of (inserted || [])) {
      resultItems.push(mapRowToItem(row));
    }
  }

  for (const upd of toUpdate) {
    // eslint-disable-next-line no-await-in-loop
    const { data: updated, error: updateError } = await postgrestClient
      .from('gsc_prompts')
      .update({ status: upd.status, updated_by: createdBy })
      .eq('id', upd.id)
      .select()
      .maybeSingle();

    if (updateError) {
      throw new Error(`Failed to update gsc_prompts row ${upd.id}: ${updateError.message}`);
    }
    if (updated) {
      resultItems.push(mapRowToItem(updated));
    }
  }

  return {
    created: toInsert.length,
    updated: toUpdate.length,
    skipped,
    items: resultItems,
  };
}

/**
 * Lists gsc_prompts rows for a brand with optional status / source filters
 * and pagination.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.brandUuid
 * @param {string} [params.status] - 'ignored' | 'added'
 * @param {string} [params.source] - e.g. 'gsc'
 * @param {number} [params.limit=1000]
 * @param {number} [params.page=1]
 * @param {object} params.postgrestClient
 * @returns {Promise<{items:object[],total:number,limit:number,page:number}>}
 */
export async function listGscPrompts({
  organizationId,
  brandUuid,
  status,
  source,
  limit = 1000,
  page = 1,
  postgrestClient,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const limitNum = Number(limit) || 1000;
  if (limitNum < 1 || limitNum > MAX_LIMIT) {
    throw new Error(`Limit must be between 1 and ${MAX_LIMIT}`);
  }
  const pageNum = Math.max(1, Number(page) || 1);
  const offset = (pageNum - 1) * limitNum;

  let query = postgrestClient
    .from('gsc_prompts')
    .select(
      'id,prompt_text,region_code,source,status,created_at,created_by,updated_at,updated_by',
      { count: 'exact' },
    )
    .eq('organization_id', organizationId)
    .eq('brand_id', brandUuid)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: true });

  if (hasText(status)) {
    query = query.eq('status', normalizeStatus(status));
  }
  if (hasText(source)) {
    query = query.eq('source', normalizeSource(source));
  }

  const { data, error, count } = await query.range(offset, offset + limitNum - 1);

  if (error) {
    throw new Error(`Failed to list gsc_prompts: ${error.message}`);
  }

  return {
    items: (data || []).map(mapRowToItem),
    total: count ?? (data?.length ?? 0),
    limit: limitNum,
    page: pageNum,
  };
}
