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

// Canonicalize a display name for storage and comparison. Non-lossy:
// preserves the client's casing and punctuation, but folds whitespace and
// unicode-composition variants so that "  Taxonomy " and "Taxonomy" — or an
// NFD vs NFC é — collapse to the same stored form. Semantic variants like
// "A & B" vs "A and B" are intentionally NOT folded here; that requires a
// business rule, not a canonical form.
function canonicalizeName(name) {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ');
}

// PostgREST-pattern-safe escape of literal `%` and `_` so ilike() matches
// an exact canonical string rather than a wildcard pattern.
function escapeIlike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function mapDbCategoryToV2(row) {
  return {
    id: row.category_id,
    uuid: row.id,
    name: row.name,
    status: row.status || 'active',
    origin: row.origin || 'human',
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Lists categories for an organization from the normalized categories table.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.status] - Filter by status
 * @returns {Promise<object[]>} Array of categories
 */
export async function listCategories({
  organizationId, postgrestClient, status,
}) {
  if (!postgrestClient?.from) {
    return [];
  }

  let query = postgrestClient
    .from('categories')
    .select('*')
    .eq('organization_id', organizationId)
    .order('name', { ascending: true });

  if (hasText(status)) {
    query = query.eq('status', status);
  } else {
    query = query.neq('status', 'deleted');
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list categories: ${error.message}`, { cause: error });
  }

  return (data || []).map(mapDbCategoryToV2);
}

// Finds ANY row for the org whose canonical name matches (case-insensitive,
// whitespace-folded, NFC). Includes soft-deleted rows so callers can choose
// between idempotent update and resurrection. Note: DB unique constraint
// `uq_category_name_per_org` is case-sensitive, so two concurrent inserts
// with different cases can still both succeed — a full schema-level fix
// requires a partial-index or generated-column migration (out of scope).
async function findCategoryByName(postgrestClient, organizationId, name) {
  const canonical = canonicalizeName(name);
  const { data, error } = await postgrestClient
    .from('categories')
    .select('*')
    .eq('organization_id', organizationId)
    .ilike('name', escapeIlike(canonical))
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to lookup category by name: ${error.message}`, { cause: error });
  }
  return data;
}

// Builds the patch an idempotent re-POST should apply on top of an existing
// row. Returns null when nothing meaningful changes — callers use that as a
// signal to short-circuit without writing (and without bumping updated_by /
// updated_at), so a no-op DRS heartbeat preserves the last human edit's
// audit trail.
//
// Provenance rule: never downgrade `origin: 'human'` to `'ai'`. A scheduler
// asserting `ai` must not erase a human curator's explicit labeling.
// Resurrection from soft-deleted is always a write regardless of field diff.
function buildCategoryPatch(existing, category, { resurrect }) {
  const patch = {};

  if (resurrect) {
    patch.status = 'active';
  } else if (category.status && category.status !== existing.status) {
    patch.status = category.status;
  }

  if (category.origin && category.origin !== existing.origin) {
    const downgrade = existing.origin === 'human' && category.origin === 'ai';
    if (!downgrade) {
      patch.origin = category.origin;
    }
  }

  return Object.keys(patch).length === 0 ? null : patch;
}

async function updateExistingCategory(postgrestClient, existing, patch, updatedBy) {
  const { data, error } = await postgrestClient
    .from('categories')
    .update({ ...patch, updated_by: updatedBy })
    .eq('id', existing.id)
    .select()
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to update existing category: ${error.message}`, { cause: error });
  }
  if (!data) {
    // Row was hard-deleted between lookup and update. Surface as a typed
    // 409 so callers can retry the full POST — which will then take the
    // insert path against a now-absent row.
    const conflict = new Error('Category was concurrently modified; please retry');
    conflict.status = 409;
    throw conflict;
  }
  return mapDbCategoryToV2(data);
}

// Resolves an existing row against an incoming idempotent POST: either
// short-circuits (no write, no audit-trail churn) or applies a patch —
// including resurrecting soft-deleted rows. Returns { category, created }:
// `created: true` when the row was resurrected (client-visible: the
// resource reappears), otherwise false.
async function resolveExistingCategory(postgrestClient, existing, category, updatedBy) {
  const resurrect = existing.status === 'deleted';
  const patch = buildCategoryPatch(existing, category, { resurrect });
  if (!patch) {
    return { category: mapDbCategoryToV2(existing), created: false };
  }
  const updated = await updateExistingCategory(postgrestClient, existing, patch, updatedBy);
  return { category: updated, created: resurrect };
}

/**
 * Creates a category in the categories table, idempotent by name.
 *
 * If a non-deleted category with the same name already exists for the
 * organization, its non-key fields are refreshed (origin/status/updated_by)
 * and the existing row is returned — the stable `category_id` slug is
 * preserved so foreign-key references remain valid.
 *
 * Rationale: clients (notably DRS) re-post the same canonical categories
 * on every sync run with a potentially drifted slug. Without name-level
 * idempotency, every such re-post trips `uq_category_name_per_org` and
 * surfaces as a 409 — thousands per day of false-positive ERROR logs.
 * See LLMO-4370.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {object} params.category - Category data { name, id?, origin?, status? }
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @returns {Promise<{category: object, created: boolean}>}
 *   `category` is the resulting row (mapped); `created` is true when a new
 *   row was inserted and false when an existing row was updated. Callers
 *   map this to HTTP 201 vs 200.
 */
export async function createCategory({
  organizationId, category, postgrestClient, updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }
  if (!hasText(category?.name)) {
    throw new Error('Category name is required');
  }

  const canonicalName = canonicalizeName(category.name);
  if (!hasText(canonicalName)) {
    throw new Error('Category name is required');
  }

  const existing = await findCategoryByName(postgrestClient, organizationId, canonicalName);
  if (existing) {
    return resolveExistingCategory(postgrestClient, existing, category, updatedBy);
  }

  const categoryId = category.id || canonicalName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const row = {
    organization_id: organizationId,
    category_id: categoryId,
    name: canonicalName,
    origin: category.origin || 'human',
    status: category.status || 'active',
    updated_by: updatedBy,
  };

  const { data, error } = await postgrestClient
    .from('categories')
    .insert(row)
    .select()
    .single();

  if (error) {
    if (error.code === '23505' && /uq_category_name_per_org/.test(error.message || '')) {
      // Race: another writer inserted the same name between our lookup and
      // insert. Retry the lookup once and fold into the normal resolve path.
      // If the retry lookup itself fails, preserve the original 23505 as
      // the primary cause — it's the more diagnostic error for this path.
      let raced = null;
      try {
        raced = await findCategoryByName(postgrestClient, organizationId, canonicalName);
      } catch (_lookupErr) {
        // Intentionally swallow — fall through to the original-error throw.
      }
      if (raced) {
        return resolveExistingCategory(postgrestClient, raced, category, updatedBy);
      }
    }
    throw new Error(`Failed to create category: ${error.message}`, { cause: error });
  }
  return { category: mapDbCategoryToV2(data), created: true };
}

/**
 * Updates a category by its business key (category_id).
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.categoryId - category_id business key
 * @param {object} params.updates - Partial category data
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @returns {Promise<object|null>} Updated category or null
 */
export async function updateCategory({
  organizationId, categoryId, updates, postgrestClient, updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const patch = { updated_by: updatedBy };
  if (updates.name !== undefined) {
    patch.name = canonicalizeName(updates.name);
  }
  if (updates.origin !== undefined) {
    patch.origin = updates.origin;
  }
  if (updates.status !== undefined) {
    patch.status = updates.status;
  }

  const { data, error } = await postgrestClient
    .from('categories')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('category_id', categoryId)
    .select()
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to update category: ${error.message}`, { cause: error });
  }
  if (!data) {
    return null;
  }
  return mapDbCategoryToV2(data);
}

/**
 * Soft-deletes a category by setting status to 'deleted'.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.categoryId - category_id business key
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @returns {Promise<boolean>} True if deleted, false if not found
 */
export async function deleteCategory({
  organizationId, categoryId, postgrestClient, updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const { data, error } = await postgrestClient
    .from('categories')
    .update({ status: 'deleted', updated_by: updatedBy })
    .eq('organization_id', organizationId)
    .eq('category_id', categoryId)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to delete category: ${error.message}`, { cause: error });
  }
  return !!data;
}
