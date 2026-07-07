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
 * Storage helpers for the `workflows` table (PostgREST). Mirrors the pattern
 * in profiles-storage.js. The table is defined by the mysticat-data-service
 * migration 20260706120000_workflows.sql.
 */

const TABLE = 'workflows';

/**
 * Maps a DB row (snake_case) to the API/UI shape (camelCase).
 * @param {object} row
 * @returns {object}
 */
export function rowToWorkflow(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    siteId: row.site_id,
    name: row.name,
    workflowId: row.workflow_id,
    scope: row.scope,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Inserts a new workflow row.
 * @param {object} params
 * @param {object} params.postgrestClient
 * @param {string} params.siteId
 * @param {string} params.profileId
 * @param {string} params.name
 * @param {string} params.workflowId  registry key (e.g. 'createJiraTicket')
 * @param {string} [params.scope='all']
 * @returns {Promise<object>} the created workflow (API shape)
 */
export async function createWorkflow({
  postgrestClient, siteId, profileId, name, workflowId, scope = 'all',
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for workflows');
  }

  const { data, error } = await postgrestClient
    .from(TABLE)
    .insert({
      site_id: siteId,
      profile_id: profileId,
      name,
      workflow_id: workflowId,
      scope,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create workflow: ${error.message}`);
  }

  return rowToWorkflow(data);
}

/**
 * Updates a workflow's status, scoped to a site.
 * @param {object} params
 * @param {object} params.postgrestClient
 * @param {string} params.siteId
 * @param {string} params.workflowId  DB id (uuid)
 * @param {string} params.status
 * @returns {Promise<object|null>} the updated workflow or null if not found
 */
export async function updateWorkflowStatus({
  postgrestClient, siteId, workflowId, status,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for workflows');
  }

  const { data, error } = await postgrestClient
    .from(TABLE)
    .update({ status })
    .eq('id', workflowId)
    .eq('site_id', siteId)
    .select()
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to update workflow status: ${error.message}`);
  }

  return data ? rowToWorkflow(data) : null;
}

/**
 * Deletes a workflow by id, scoped to a site.
 * @param {object} params
 * @param {object} params.postgrestClient
 * @param {string} params.siteId
 * @param {string} params.workflowId  DB id (uuid)
 * @returns {Promise<void>}
 */
export async function deleteWorkflow({ postgrestClient, siteId, workflowId }) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for workflows');
  }

  const { error } = await postgrestClient
    .from(TABLE)
    .delete()
    .eq('id', workflowId)
    .eq('site_id', siteId);

  if (error) {
    throw new Error(`Failed to delete workflow: ${error.message}`);
  }
}

/**
 * Lists all workflows for a profile, newest first.
 * @param {object} params
 * @param {object} params.postgrestClient
 * @param {string} params.profileId
 * @returns {Promise<object[]>} workflows (API shape)
 */
export async function listWorkflowsForProfile({ postgrestClient, profileId }) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for workflows');
  }

  const { data, error } = await postgrestClient
    .from(TABLE)
    .select('*')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to list workflows: ${error.message}`);
  }

  return (data ?? []).map(rowToWorkflow);
}

/**
 * Fetches a single workflow by id, scoped to a site.
 * @param {object} params
 * @param {object} params.postgrestClient
 * @param {string} params.siteId
 * @param {string} params.workflowId  DB id (uuid)
 * @returns {Promise<object|null>}
 */
export async function getWorkflowById({ postgrestClient, siteId, workflowId }) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for workflows');
  }

  const { data, error } = await postgrestClient
    .from(TABLE)
    .select('*')
    .eq('id', workflowId)
    .eq('site_id', siteId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch workflow: ${error.message}`);
  }

  return data ? rowToWorkflow(data) : null;
}
