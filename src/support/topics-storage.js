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

import { hasText, isValidUUID } from '@adobe/spacecat-shared-utils';

import { throwOnPgConstraintViolation } from './errors.js';

// Embed shape used by listTopics / createTopic / updateTopic so the response
// shape is symmetric across the three endpoints. Nesting `categories(status)`
// inside `topic_categories` lets us drop tombstoned categories client-side
// without relying on PostgREST inner-join filter semantics.
const TOPIC_SELECT = '*, topic_categories(category_id, categories(status))';

function mapDbTopicToV2(row) {
  // Filter out junction rows pointing at soft-deleted categories so consumers
  // never see a tombstone UUID. Junction rows whose nested `categories` row
  // is absent (e.g. older test fixtures, or a junction created without an
  // embed) are treated as "unknown status, include" to avoid silently
  // dropping data when the embed is missing.
  const categoryUuids = (row.topic_categories ?? [])
    .filter((tc) => tc.categories?.status !== 'deleted')
    .map((tc) => tc.category_id);

  return {
    id: row.topic_id,
    uuid: row.id,
    name: row.name,
    description: row.description || null,
    status: row.status || 'active',
    brandId: row.brand_id || null,
    categoryUuids,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Lists topics for an organization from the normalized topics table.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.status] - Filter by status
 * @param {string} [params.brandId] - Filter by brand UUID
 * @returns {Promise<object[]>} Array of topics
 */
export async function listTopics({
  organizationId, postgrestClient, status, brandId,
}) {
  if (!postgrestClient?.from) {
    return [];
  }

  let query = postgrestClient
    .from('topics')
    .select(TOPIC_SELECT)
    .eq('organization_id', organizationId)
    .order('name', { ascending: true });

  if (hasText(status)) {
    query = query.eq('status', status);
  } else {
    query = query.neq('status', 'deleted');
  }

  if (hasText(brandId)) {
    query = query.eq('brand_id', brandId);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list topics: ${error.message}`, { cause: error });
  }

  return (data || []).map(mapDbTopicToV2);
}

/**
 * Creates a topic in the topics table.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {object} params.topic - Topic data { name, description?, brandId?, categoryId? }
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @param {object} [params.log] - Logger instance for warnings
 * @returns {Promise<object>} Created topic
 */
export async function createTopic({
  organizationId, topic, postgrestClient, updatedBy = 'system', log,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }
  if (!hasText(topic?.name)) {
    throw new Error('Topic name is required');
  }

  const topicId = topic.id || topic.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const row = {
    organization_id: organizationId,
    topic_id: topicId,
    name: topic.name,
    description: topic.description || null,
    brand_id: topic.brandId || null,
    status: topic.status || 'active',
    updated_by: updatedBy,
  };

  const { data, error } = await postgrestClient
    .from('topics')
    .upsert(row, { onConflict: 'organization_id,topic_id' })
    .select()
    .single();

  if (error) {
    // 23505 unique-constraint and 23503 FK violations are surfaced as typed
    // HTTP errors (409 / 422) via the centralised utility. Postgres internals
    // (constraint names, table names) stay in `.cause` for operator triage and
    // are kept out of client-facing messages to avoid schema leakage. LLMO-4370.
    throwOnPgConstraintViolation(error, {
      23505: { status: 409, message: 'A topic with these attributes already exists for this organization' },
      23503: { status: 422, message: 'Topic references a non-existent related entity' },
    });
    throw new Error('Failed to create topic', { cause: error });
  }

  // Link topic to category via the topic_categories junction table.
  // categoryId is a UUID FK to categories.id — resolve it from the payload.
  const categoryId = topic.categoryId || null;
  if (categoryId && data?.id) {
    if (!isValidUUID(categoryId)) {
      // A non-UUID categoryId (e.g. a category slug / business-key) can never
      // satisfy the uuid FK to categories.id and would only produce a
      // guaranteed PostgREST 400. Skip the doomed write rather than emit it.
      log?.warn(`Skipping topic_categories link for topic ${data.id}: categoryId "${categoryId}" is not a valid UUID`);
    } else {
      const { error: junctionError } = await postgrestClient
        .from('topic_categories')
        .upsert(
          { topic_id: data.id, category_id: categoryId },
          { onConflict: 'topic_id,category_id' },
        );
      // Upsert errors are intentionally not thrown — the topic was already
      // created successfully. A missing or invalid categoryId should not fail
      // the entire operation. The SQLSTATE + details are logged (not just the
      // message) so a recurring failure — e.g. 23503 when the category row is
      // not committed yet or belongs to another org — is diagnosable.
      if (junctionError) {
        const code = junctionError.code ?? 'n/a';
        const details = junctionError.details ? `, details=${junctionError.details}` : '';
        log?.warn(`Failed to link topic ${data.id} to category ${categoryId}: ${junctionError.message} (code=${code}${details})`);
      }
    }
  }

  // Re-fetch with the topic_categories embed so the response shape matches
  // listTopics: callers POSTing with categoryId expect categoryUuids to be
  // populated on the response. The embed cannot be requested on the upsert
  // itself because the junction row is written in the step above. A refetch
  // failure is non-fatal — fall back to the upsert payload (categoryUuids:[]).
  if (data?.id) {
    const { data: full, error: refetchError } = await postgrestClient
      .from('topics')
      .select(TOPIC_SELECT)
      .eq('id', data.id)
      .maybeSingle();
    if (refetchError) {
      log?.warn?.(`Failed to refetch topic ${data.id} with category embed: ${refetchError.message}`);
    } else if (full) {
      return mapDbTopicToV2(full);
    }
  }
  return mapDbTopicToV2(data);
}

/**
 * Updates a topic by its business key (topic_id).
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.topicId - topic_id business key
 * @param {object} params.updates - Partial topic data
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @returns {Promise<object|null>} Updated topic or null
 */
export async function updateTopic({
  organizationId, topicId, updates, postgrestClient, updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const patch = { updated_by: updatedBy };
  if (updates.name !== undefined) {
    patch.name = updates.name;
  }
  if (updates.description !== undefined) {
    patch.description = updates.description;
  }
  if (updates.status !== undefined) {
    patch.status = updates.status;
  }
  if (updates.brandId !== undefined) {
    patch.brand_id = updates.brandId;
  }

  const { data, error } = await postgrestClient
    .from('topics')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('topic_id', topicId)
    .select(TOPIC_SELECT)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to update topic: ${error.message}`, { cause: error });
  }
  if (!data) {
    return null;
  }
  return mapDbTopicToV2(data);
}

/**
 * Soft-deletes a topic by setting status to 'deleted'.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {string} params.topicId - topic_id business key
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @returns {Promise<boolean>} True if deleted, false if not found
 */
export async function deleteTopic({
  organizationId, topicId, postgrestClient, updatedBy = 'system',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required');
  }

  const { data, error } = await postgrestClient
    .from('topics')
    .update({ status: 'deleted', updated_by: updatedBy })
    .eq('organization_id', organizationId)
    .eq('topic_id', topicId)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to delete topic: ${error.message}`, { cause: error });
  }
  return !!data;
}
