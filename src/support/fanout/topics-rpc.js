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

/**
 * Thin wrapper around the `rpc_fanout_topics` PL/pgSQL function in
 * mysticat-data-service. Returns the brand's tracked topics together with
 * per-prompt mention rate and citation rate over a trailing window.
 *
 * The RPC is org-scoped and brand-scoped; the window, model, region, and
 * cap are passed as parameters (defaulted in the SQL function).
 *
 * @param {import('@supabase/postgrest-js').PostgrestClient} postgrestClient
 * @param {object} opts
 * @param {string} opts.organizationId
 * @param {string} opts.brandId
 * @param {number} [opts.limit=1000]
 * @returns {Promise<Array<{
 *   topicUuid: string,
 *   topicId: string,
 *   name: string,
 *   description: string|null,
 *   promptsTotal: number,
 *   mentionRate: number|null,
 *   citationRate: number|null
 * }>>}
 */
export async function fetchFanoutTopics(postgrestClient, {
  organizationId,
  brandId,
  limit = 1000,
}) {
  const { data, error } = await postgrestClient.rpc('rpc_fanout_topics', {
    p_organization_id: organizationId,
    p_brand_id: brandId,
    p_limit: limit,
  });
  if (error) {
    throw new Error(`rpc_fanout_topics failed: ${error.message}`);
  }
  return (data || []).map((row) => ({
    topicUuid: row.topic_uuid,
    topicId: row.topic_id,
    name: row.name,
    description: row.description ?? null,
    promptsTotal: Number(row.prompts_total ?? 0),
    mentionRate: row.mention_rate == null ? null : Number(row.mention_rate),
    citationRate: row.citation_rate == null ? null : Number(row.citation_rate),
  }));
}
