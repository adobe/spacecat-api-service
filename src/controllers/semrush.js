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
  badRequest, createResponse, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import { createSemrushTransport, SemrushTransportError } from '../support/semrush/rest-transport.js';
import { resolveWorkspaceId } from '../support/semrush/workspace-resolver.js';
import {
  handleListPrompts,
  handleCreatePrompts,
  handleUpdatePrompt,
  handleBulkDeletePrompts,
} from '../support/semrush/handlers/prompts.js';
import {
  handleListProjects,
  handleCreateProject,
  handleListProjectTags,
  handleListProjectModels,
  handleListWorkspaceProjects,
} from '../support/semrush/handlers/projects.js';
import { ErrorWithStatusCode, getImsUserToken } from '../support/utils.js';

function extractQuery(context) {
  if (context?.request?.url) {
    try {
      const u = new URL(context.request.url);
      const out = {};
      for (const [k, v] of u.searchParams) {
        out[k] = v;
      }
      return out;
    } catch { /* fall through */ }
  }
  return context?.data || {};
}

function parsedQuery(context) {
  const raw = extractQuery(context);
  const out = { ...raw };
  if (raw.semrushLocationId !== undefined) {
    const n = parseInt(raw.semrushLocationId, 10);
    out.semrushLocationId = Number.isFinite(n) ? n : null;
  }
  return out;
}

function mapError(e, log) {
  if (e instanceof ErrorWithStatusCode) {
    return badRequest(e.message);
  }
  if (e instanceof SemrushTransportError) {
    log.error('Semrush upstream error', e);
    return createResponse({
      error: 'semrushUpstreamError',
      status: e.status,
      message: e.message,
      body: e.body,
    }, e.status || 502);
  }
  log.error('Semrush controller error', e);
  return internalServerError(e.message);
}

function SemrushController(context, log, env) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }
  if (!log) {
    throw new Error('Log required');
  }

  /**
   * Builds the per-request transport. Throws ErrorWithStatusCode(400) when
   * the IMS bearer is missing — controllers catch and map to badRequest.
   */
  function buildTransport(ctx) {
    const imsToken = getImsUserToken(ctx);
    return createSemrushTransport({ env: ctx.env || env, imsToken });
  }

  async function resolveWorkspaceOrNotFound(ctx) {
    const spaceCatId = ctx?.params?.spaceCatId;
    const workspaceId = await resolveWorkspaceId(ctx, spaceCatId);
    if (!hasText(workspaceId)) {
      return { error: notFound('Organization has no semrush_workspace_id') };
    }
    return { workspaceId };
  }

  const listPrompts = async (ctx) => {
    try {
      const transport = buildTransport(ctx);
      const { workspaceId, error } = await resolveWorkspaceOrNotFound(ctx);
      if (error) {
        return error;
      }
      const result = await handleListPrompts(
        transport,
        ctx.dataAccess,
        ctx.params.brandId,
        workspaceId,
        parsedQuery(ctx),
      );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const createPrompts = async (ctx) => {
    try {
      const transport = buildTransport(ctx);
      const { workspaceId, error } = await resolveWorkspaceOrNotFound(ctx);
      if (error) {
        return error;
      }
      const result = await handleCreatePrompts(
        transport,
        ctx.dataAccess,
        ctx.params.brandId,
        workspaceId,
        ctx.data || {},
        log,
      );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const updatePrompt = async (ctx) => {
    try {
      const { promptId } = ctx?.params || {};
      if (!hasText(promptId)) {
        return badRequest('Missing promptId');
      }
      const transport = buildTransport(ctx);
      const { workspaceId, error } = await resolveWorkspaceOrNotFound(ctx);
      if (error) {
        return error;
      }
      const result = await handleUpdatePrompt(
        transport,
        ctx.dataAccess,
        ctx.params.brandId,
        workspaceId,
        promptId,
        ctx.data || {},
        log,
      );
      return createResponse(result.body, result.status);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const bulkDeletePrompts = async (ctx) => {
    try {
      const transport = buildTransport(ctx);
      const { workspaceId, error } = await resolveWorkspaceOrNotFound(ctx);
      if (error) {
        return error;
      }
      const result = await handleBulkDeletePrompts(
        transport,
        ctx.dataAccess,
        ctx.params.brandId,
        workspaceId,
        ctx.data || {},
        log,
      );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listProjects = async (ctx) => {
    try {
      const transport = buildTransport(ctx);
      const { workspaceId, error } = await resolveWorkspaceOrNotFound(ctx);
      if (error) {
        return error;
      }
      const result = await handleListProjects(
        transport,
        ctx.dataAccess,
        ctx.params.brandId,
        workspaceId,
        parsedQuery(ctx),
      );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const createProject = async (ctx) => {
    try {
      const transport = buildTransport(ctx);
      const { workspaceId, error } = await resolveWorkspaceOrNotFound(ctx);
      if (error) {
        return error;
      }
      const result = await handleCreateProject(
        transport,
        ctx.dataAccess,
        ctx.params.brandId,
        workspaceId,
        ctx.data || {},
      );
      return createResponse(result.body, result.status);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listProjectTags = async (ctx) => {
    try {
      const { workspaceId: pathWs, projectId } = ctx?.params || {};
      if (!hasText(pathWs) || !hasText(projectId)) {
        return badRequest('Missing workspaceId or projectId');
      }
      const transport = buildTransport(ctx);
      const result = await handleListProjectTags(transport, pathWs, projectId);
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listProjectModels = async (ctx) => {
    try {
      const { workspaceId: pathWs, projectId } = ctx?.params || {};
      if (!hasText(pathWs) || !hasText(projectId)) {
        return badRequest('Missing workspaceId or projectId');
      }
      const transport = buildTransport(ctx);
      const result = await handleListProjectModels(transport, pathWs, projectId);
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listWorkspaceProjects = async (ctx) => {
    try {
      const { workspaceId: pathWs } = ctx?.params || {};
      if (!hasText(pathWs)) {
        return badRequest('Missing workspaceId');
      }
      const transport = buildTransport(ctx);
      const result = await handleListWorkspaceProjects(transport, pathWs);
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  return {
    listPrompts,
    createPrompts,
    updatePrompt,
    bulkDeletePrompts,
    listProjects,
    createProject,
    listProjectTags,
    listProjectModels,
    listWorkspaceProjects,
  };
}

export default SemrushController;
