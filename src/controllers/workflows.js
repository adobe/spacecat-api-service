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

import {
  badRequest,
  notFound,
  internalServerError,
  ok,
  createResponse,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';

import {
  createWorkflow,
  updateWorkflowStatus,
  deleteWorkflow,
  listWorkflowsForProfile,
  getWorkflowById,
} from '../support/workflows-storage.js';
import { getProfileById } from '../support/profiles-storage.js';

const VALID_STATUSES = new Set(['pending', 'running', 'completed', 'failed']);

/**
 * Workflows controller.
 *
 * Endpoints:
 *   GET    /sites/:siteId/profiles/:profileId/workflows
 *   POST   /sites/:siteId/profiles/:profileId/workflows
 *   PATCH  /sites/:siteId/profiles/:profileId/workflows/:workflowId
 *   DELETE /sites/:siteId/profiles/:profileId/workflows/:workflowId
 *
 * @param {object} ctx universal context
 * @param {object} log logger
 * @returns {object} handlers
 */
function WorkflowsController(ctx, log) {
  const { dataAccess } = ctx;
  const getPostgrestClient = () => dataAccess?.services?.postgrestClient;

  /**
   * GET /sites/:siteId/profiles/:profileId/workflows
   */
  const list = async (context) => {
    const { siteId, profileId } = context.params ?? {};
    try {
      const postgrestClient = getPostgrestClient();
      const profile = await getProfileById({ postgrestClient, siteId, profileId });
      if (!profile) {
        return notFound('Profile not found.');
      }
      const workflows = await listWorkflowsForProfile({ postgrestClient, profileId });
      return ok(workflows);
    } catch (error) {
      log.error(`Workflow list error: ${error.message}`);
      return internalServerError('Failed to list workflows.');
    }
  };

  /**
   * POST /sites/:siteId/profiles/:profileId/workflows
   * Body: { name, workflowId, scope? }
   */
  const create = async (context) => {
    const { siteId, profileId } = context.params ?? {};
    const { name, workflowId, scope = 'all' } = context?.data ?? {};

    if (!hasText(name)) {
      return badRequest('A non-empty "name" is required.');
    }
    if (!hasText(workflowId)) {
      return badRequest('A non-empty "workflowId" is required.');
    }

    try {
      const postgrestClient = getPostgrestClient();
      const profile = await getProfileById({ postgrestClient, siteId, profileId });
      if (!profile) {
        return notFound('Profile not found.');
      }

      const workflow = await createWorkflow({
        postgrestClient,
        siteId,
        profileId,
        name,
        workflowId,
        scope,
      });
      return createResponse(workflow, 201);
    } catch (error) {
      log.error(`Workflow create error: ${error.message}`);
      return internalServerError('Failed to create workflow.');
    }
  };

  /**
   * PATCH /sites/:siteId/profiles/:profileId/workflows/:workflowId
   * Body: { status }
   */
  const updateStatus = async (context) => {
    const { siteId, profileId, workflowId } = context.params ?? {};
    const { status } = context?.data ?? {};

    if (!hasText(status) || !VALID_STATUSES.has(status)) {
      return badRequest(`"status" must be one of: ${[...VALID_STATUSES].join(', ')}.`);
    }

    try {
      const postgrestClient = getPostgrestClient();
      const profile = await getProfileById({ postgrestClient, siteId, profileId });
      if (!profile) {
        return notFound('Profile not found.');
      }
      const existing = await getWorkflowById({ postgrestClient, siteId, workflowId });
      if (!existing || existing.profileId !== profileId) {
        return notFound('Workflow not found.');
      }
      const updated = await updateWorkflowStatus({
        postgrestClient, siteId, workflowId, status,
      });
      return ok(updated);
    } catch (error) {
      log.error(`Workflow update error: ${error.message}`);
      return internalServerError('Failed to update workflow status.');
    }
  };

  /**
   * DELETE /sites/:siteId/profiles/:profileId/workflows/:workflowId
   */
  const deleteById = async (context) => {
    const { siteId, profileId, workflowId } = context.params ?? {};
    try {
      const postgrestClient = getPostgrestClient();
      const profile = await getProfileById({ postgrestClient, siteId, profileId });
      if (!profile) {
        return notFound('Profile not found.');
      }
      const existing = await getWorkflowById({ postgrestClient, siteId, workflowId });
      if (!existing || existing.profileId !== profileId) {
        return notFound('Workflow not found.');
      }
      await deleteWorkflow({ postgrestClient, siteId, workflowId });
      return createResponse(null, 204);
    } catch (error) {
      log.error(`Workflow delete error: ${error.message}`);
      return internalServerError('Failed to delete workflow.');
    }
  };

  return {
    list, create, updateStatus, deleteById,
  };
}

export default WorkflowsController;
