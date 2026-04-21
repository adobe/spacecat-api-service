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

// Zero-width / BOM characters that pass `trim()` but render invisible. Strip
// in canonicalization so a name like "Foo\u200B" cannot produce a row that
// looks identical to "Foo" in the UI yet bypasses idempotent matching.
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

// Canonicalize a display name for storage and comparison. Non-lossy:
// preserves the client's casing and punctuation, but folds whitespace and
// unicode-composition variants so that "  Taxonomy " and "Taxonomy" — or an
// NFD vs NFC é — collapse to the same stored form. Semantic variants like
// "A & B" vs "A and B" are intentionally NOT folded here; that requires a
// business rule, not a canonical form.
function canonicalizeName(name) {
  return name.normalize('NFC').replace(ZERO_WIDTH_RE, '').trim().replace(/\s+/g, ' ');
}

// PostgREST-pattern-safe escape of literal `%` and `_` so ilike() matches
// an exact canonical string rather than a wildcard pattern.
export function escapeIlike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function extractConstraintName(error) {
  const match = /unique constraint "([^"]+)"/.exec(error?.message || '');
  return match ? match[1] : 'unique constraint';
}

function conflictError(message, cause) {
  const err = new Error(message, { cause });
  err.status = 409;
  return err;
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
// row. Returns { patch, downgradeBlocked } — patch is null when nothing
// meaningful changes (no-op short-circuit: no write, no bumped
// updated_by/updated_at, so a DRS heartbeat preserves the last human edit's
// audit trail). downgradeBlocked is true when the caller attempted to
// change origin from 'human' to 'ai' — callers surface that as an operator
// signal.
//
// Provenance rule: never downgrade `origin: 'human'` to `'ai'`. A scheduler
// asserting `ai` must not erase a human curator's explicit labeling.
// Resurrection from soft-deleted is always a write regardless of field diff.
function buildCategoryPatch(existing, category, { resurrect }) {
  const patch = {};
  let downgradeBlocked = false;

  if (resurrect) {
    patch.status = 'active';
  } else if (category.status && category.status !== existing.status) {
    patch.status = category.status;
  }

  if (category.origin && category.origin !== existing.origin) {
    const downgrade = existing.origin === 'human' && category.origin === 'ai';
    if (downgrade) {
      downgradeBlocked = true;
    } else {
      patch.origin = category.origin;
    }
  }

  return {
    patch: Object.keys(patch).length === 0 ? null : patch,
    downgradeBlocked,
  };
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
    throw conflictError('Category was concurrently modified; please retry');
  }
  return mapDbCategoryToV2(data);
}

// Resolves an existing row against an incoming idempotent POST: either
// short-circuits (no write, no audit-trail churn) or applies a patch —
// including resurrecting soft-deleted rows. Returns
// { category, created, outcome } where `outcome` is one of
// 'noop' | 'update' | 'resurrect' (possibly prefixed 'race_retry_' when
// invoked from the 23505 race-recovery path). `created: true` when the row
// was resurrected (client-visible: the resource reappears).
async function resolveExistingCategory(
  postgrestClient,
  existing,
  category,
  updatedBy,
  { raceRecovery = false, log, organizationId } = {},
) {
  const resurrect = existing.status === 'deleted';
  const { patch, downgradeBlocked } = buildCategoryPatch(existing, category, { resurrect });

  if (downgradeBlocked) {
    // Operator signal: a scheduler/AI caller tried to stamp 'ai' over a
    // human-curated row. Preserved silently in the patch math; logged here
    // so misconfigured DRS taxonomies can be found in Coralogix without
    // reading individual rows. LLMO-4370 #13.
    log?.warn?.('Blocked origin downgrade human->ai on category', {
      organization_id: organizationId,
      category_id: existing.category_id,
      attempted_origin: category.origin,
      current_origin: existing.origin,
    });
  }

  if (!patch) {
    return {
      category: mapDbCategoryToV2(existing),
      created: false,
      outcome: raceRecovery ? 'race_retry_noop' : 'noop',
    };
  }
  const updated = await updateExistingCategory(postgrestClient, existing, patch, updatedBy);
  let outcome;
  if (raceRecovery) {
    outcome = 'race_retry';
  } else if (resurrect) {
    outcome = 'resurrect';
  } else {
    outcome = 'update';
  }
  return { category: updated, created: resurrect, outcome };
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
 * @param {object} [params.log] - Logger for operator signals (downgrade blocks)
 * @returns {Promise<{category: object, created: boolean, outcome: string}>}
 *   `category` is the resulting row (mapped); `created` is true when a new
 *   row was inserted/resurrected and false when an existing row was
 *   updated. Callers map `created` to HTTP 201 vs 200. `outcome` is one of
 *   'insert' | 'resurrect' | 'update' | 'noop' | 'race_retry' |
 *   'race_retry_noop', for post-deploy log-storm quantification.
 */
export async function createCategory({
  organizationId, category, postgrestClient, updatedBy = 'system', log,
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
    return resolveExistingCategory(
      postgrestClient,
      existing,
      category,
      updatedBy,
      { log, organizationId },
    );
  }

  // Derive a slug from the canonical name when none supplied, trimming
  // leading/trailing dashes so "   !!  " and Unicode-only names don't
  // produce a degenerate bare '-'. The client-supplied slug is trusted
  // verbatim (FK-stability).
  let derivedSlug;
  if (category.id) {
    derivedSlug = category.id;
  } else {
    derivedSlug = canonicalName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!derivedSlug) {
      throw new Error(
        'Category name produces an empty slug after normalization; supply an explicit `id`',
      );
    }
  }

  const row = {
    organization_id: organizationId,
    category_id: derivedSlug,
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
    if (error.code === '23505') {
      const constraint = extractConstraintName(error);
      if (constraint === 'uq_category_name_per_org') {
        // Race: another writer inserted the same name between our lookup
        // and insert. Retry the lookup once and fold into the normal
        // resolve path. If the retry lookup itself fails, preserve the
        // original 23505 as the primary cause — it's the more diagnostic
        // error for this path.
        let raced = null;
        try {
          raced = await findCategoryByName(postgrestClient, organizationId, canonicalName);
        } catch (_lookupErr) {
          // Intentionally swallow — fall through to the original-error throw.
        }
        if (raced) {
          return resolveExistingCategory(
            postgrestClient,
            raced,
            category,
            updatedBy,
            { raceRecovery: true, log, organizationId },
          );
        }
      } else {
        // Any other unique-constraint violation (e.g. slug collision via
        // uq_category_id_per_org when the client ships a drifted `id` that
        // maps to a different name already occupying that slug) surfaces as
        // a typed 409 echoing the actual constraint — mirrors the topics
        // pattern so callers don't have to mine 500 bodies. LLMO-4370 #5/#6.
        throw conflictError(
          `Category conflicts with ${constraint} for this organization`,
          error,
        );
      }
    }
    throw new Error(`Failed to create category: ${error.message}`, { cause: error });
  }
  return { category: mapDbCategoryToV2(data), created: true, outcome: 'insert' };
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
    // A PATCH to a name that collides with another row in the same org
    // trips `uq_category_name_per_org`. Surface as a typed 409 echoing the
    // constraint — symmetric with POST, so clients don't see a random 500
    // on what is really a duplicate-name conflict. LLMO-4370 #9.
    if (error.code === '23505') {
      throw conflictError(
        `Category conflicts with ${extractConstraintName(error)} for this organization`,
        error,
      );
    }
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
