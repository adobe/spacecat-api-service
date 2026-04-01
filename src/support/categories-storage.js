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
  if (!postgrestClient?.from) return [];

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
  if (error) throw new Error(`Failed to list categories: ${error.message}`);

  return (data || []).map(mapDbCategoryToV2);
}

/**
 * Creates a category in the categories table.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {object} params.category - Category data { name, origin? }
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @returns {Promise<object>} Created category
 */
export async function createCategory({
  organizationId, category, postgrestClient, updatedBy = 'system',
}) {
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');
  if (!hasText(category?.name)) throw new Error('Category name is required');

  const categoryId = category.id || category.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const row = {
    organization_id: organizationId,
    category_id: categoryId,
    name: category.name,
    origin: category.origin || 'human',
    status: category.status || 'active',
    updated_by: updatedBy,
  };

  const { data, error } = await postgrestClient
    .from('categories')
    .upsert(row, { onConflict: 'organization_id,category_id' })
    .select()
    .single();

  if (error) throw new Error(`Failed to create category: ${error.message}`);
  return mapDbCategoryToV2(data);
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
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');

  const patch = { updated_by: updatedBy };
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.origin !== undefined) patch.origin = updates.origin;
  if (updates.status !== undefined) patch.status = updates.status;

  const { data, error } = await postgrestClient
    .from('categories')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('category_id', categoryId)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to update category: ${error.message}`);
  if (!data) return null;
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
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');

  const { data, error } = await postgrestClient
    .from('categories')
    .update({ status: 'deleted', updated_by: updatedBy })
    .eq('organization_id', organizationId)
    .eq('category_id', categoryId)
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`Failed to delete category: ${error.message}`);
  return !!data;
}
