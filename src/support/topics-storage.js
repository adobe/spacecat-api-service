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

function mapDbTopicToV2(row) {
  return {
    id: row.topic_id,
    uuid: row.id,
    name: row.name,
    description: row.description || null,
    status: row.status || 'active',
    brandId: row.brand_id || null,
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
  if (!postgrestClient?.from) return [];

  let query = postgrestClient
    .from('topics')
    .select('*')
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
  if (error) throw new Error(`Failed to list topics: ${error.message}`);

  return (data || []).map(mapDbTopicToV2);
}

/**
 * Creates a topic in the topics table.
 *
 * @param {object} params
 * @param {string} params.organizationId - SpaceCat organization UUID
 * @param {object} params.topic - Topic data { name, description?, brandId? }
 * @param {object} params.postgrestClient - PostgREST client
 * @param {string} [params.updatedBy] - User performing the operation
 * @returns {Promise<object>} Created topic
 */
export async function createTopic({
  organizationId, topic, postgrestClient, updatedBy = 'system',
}) {
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');
  if (!hasText(topic?.name)) throw new Error('Topic name is required');

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

  if (error) throw new Error(`Failed to create topic: ${error.message}`);
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
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');

  const patch = { updated_by: updatedBy };
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.brandId !== undefined) patch.brand_id = updates.brandId;

  const { data, error } = await postgrestClient
    .from('topics')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('topic_id', topicId)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to update topic: ${error.message}`);
  if (!data) return null;
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
  if (!postgrestClient?.from) throw new Error('PostgREST client is required');

  const { data, error } = await postgrestClient
    .from('topics')
    .update({ status: 'deleted', updated_by: updatedBy })
    .eq('organization_id', organizationId)
    .eq('topic_id', topicId)
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`Failed to delete topic: ${error.message}`);
  return !!data;
}
