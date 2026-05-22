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
  createResponse, forbidden, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';

import { createSerenityTransport, SerenityTransportError } from '../support/serenity/rest-transport.js';
import { resolveWorkspaceId } from '../support/serenity/workspace-resolver.js';
import {
  handleListPrompts,
  handleCreatePrompts,
  handleUpdatePrompt,
  handleBulkDeletePrompts,
} from '../support/serenity/handlers/prompts.js';
import {
  handleListProjects,
  handleCreateProject,
  handleListProjectTags,
  handleListProjectModels,
  handleListWorkspaceProjects,
} from '../support/serenity/handlers/projects.js';
import AccessControlUtil from '../support/access-control-util.js';
import { resolveBrandUuid } from '../support/prompts-storage.js';
import { ErrorWithStatusCode } from '../support/utils.js';

const MAX_ERR_MSG_LEN = 500;
const BEARER_PREFIX = 'Bearer ';

/**
 * Strips characters HTTP headers can't carry (CR/LF/non-ASCII) and caps length.
 * Prevents response splitting and keeps error bodies bounded.
 */
function safeError(msg) {
  return cleanupHeaderValue(String(msg || '')).slice(0, MAX_ERR_MSG_LEN);
}

/**
 * Extracts query params from the request URL. Unlike the prior implementation
 * this does NOT fall back to `context.data` (the request body) on parse
 * failure — body keys must never become query keys on a GET, which would be
 * a silent attribute confusion vector.
 */
function extractQuery(context) {
  if (context?.request?.url) {
    try {
      const u = new URL(context.request.url);
      const out = {};
      for (const [k, v] of u.searchParams) {
        out[k] = v;
      }
      return out;
    } catch { /* fall through to empty */ }
  }
  return {};
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

/**
 * Stable machine-readable token per HTTP status class. Clients key on
 * `error` for UX flows (e.g. an `authenticationRequired` envelope drives a
 * token-refresh prompt) while `message` carries the sanitized human-facing
 * detail. Keep this map narrow — every entry is a published contract.
 */
function errorTokenForStatus(status) {
  switch (status) {
    case 401: return 'authenticationRequired';
    case 403: return 'forbidden';
    case 404: return 'notFound';
    case 409: return 'conflict';
    case 503: return 'configurationError';
    default: return 'invalidRequest';
  }
}

/**
 * Unified error envelope. All client-facing messages run through
 * `cleanupHeaderValue` and are length-capped. SerenityTransportError details
 * are deliberately NOT echoed — the upstream body may contain provider
 * internals; clients get a stable contract instead.
 */
function mapError(e, log) {
  if (e instanceof ErrorWithStatusCode) {
    const status = Number.isInteger(e.status) ? e.status : 400;
    return createResponse(
      { error: errorTokenForStatus(status), message: safeError(e.message) },
      status,
    );
  }
  if (e instanceof SerenityTransportError) {
    // Log full upstream detail server-side, but do NOT leak the upstream body
    // to clients (it may contain provider internals).
    log.error('Semrush upstream error', e);
    return createResponse({
      error: 'semrushUpstreamError',
      message: 'Semrush upstream request failed',
    }, 502);
  }
  log.error('Semrush controller error', e);
  return createResponse(
    { error: 'internalServerError', message: 'Internal server error' },
    500,
  );
}

/**
 * Pulls the IMS bearer from the inbound Authorization header. Throws 401 if
 * missing OR if the caller authenticated by some other mechanism (scoped API
 * key, S2S JWT). The Semrush gateway only understands IMS user tokens; we
 * refuse to forward anything else.
 */
function requireImsBearer(ctx) {
  const authInfo = ctx?.attributes?.authInfo;
  if (authInfo?.getType && authInfo.getType() !== 'ims') {
    throw new ErrorWithStatusCode(
      'Semrush proxy requires IMS authentication',
      401,
    );
  }
  const header = ctx?.pathInfo?.headers?.authorization;
  if (!hasText(header) || !header.startsWith(BEARER_PREFIX)) {
    throw new ErrorWithStatusCode(
      'Missing or invalid Authorization header',
      401,
    );
  }
  return header.substring(BEARER_PREFIX.length);
}

function SerenityController(context, log, env) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }
  if (!log) {
    throw new Error('Log required');
  }

  /**
   * Verifies the caller has access to the addressed org AND the brand belongs
   * to that org, then resolves the org's Semrush workspace and 404s if
   * missing. All 9 endpoints today are brand-scoped + workspace-scoped, so
   * the shape is uniform.
   *
   * Returns either `{ error: Response }` or `{ brandUuid, workspaceId }`.
   */
  async function authorize(ctx) {
    const spaceCatId = ctx?.params?.spaceCatId;
    const brandId = ctx?.params?.brandId;
    const Organization = ctx?.dataAccess?.Organization;
    if (!Organization || typeof Organization.findById !== 'function') {
      return { error: internalServerError('Organization data-access not available') };
    }
    const organization = await Organization.findById(spaceCatId);
    if (!organization) {
      return { error: notFound(`Organization not found: ${spaceCatId}`) };
    }
    const accessControl = AccessControlUtil.fromContext(ctx);
    if (!await accessControl.hasAccess(organization)) {
      return { error: forbidden('User does not have access to this organization') };
    }
    // Brand <-> org binding. Mirrors brands.js — UUID lookup scoped to the
    // org, so a cross-tenant brandId in the path returns 404 instead of
    // proxying to Semrush. Required because there is no Brand entity in
    // spacecat-shared yet; brand membership lives in mysticat-data-service.
    const postgrestClient = ctx.dataAccess?.services?.postgrestClient;
    if (!postgrestClient?.from) {
      return {
        error: createResponse(
          { error: 'configurationError', message: 'PostgREST client not available' },
          503,
        ),
      };
    }
    const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
    if (!brandUuid) {
      return { error: notFound(`Brand not found for organization: ${brandId}`) };
    }
    const workspaceId = await resolveWorkspaceId(ctx, spaceCatId);
    if (!hasText(workspaceId)) {
      return { error: notFound('Organization has no semrush_workspace_id') };
    }
    return { brandUuid, workspaceId };
  }

  /**
   * For the 3 workspace-scoped lookups (tags / models / workspaceProjects)
   * we additionally verify the path `:workspaceId` matches the org's
   * resolved workspace. Defense-in-depth on top of Semrush's ACL.
   */
  function verifyPathWorkspace(ctx, resolvedWorkspaceId) {
    const pathWs = ctx?.params?.workspaceId;
    if (!hasText(pathWs)) {
      throw new ErrorWithStatusCode('Missing workspaceId', 400);
    }
    if (pathWs !== resolvedWorkspaceId) {
      throw new ErrorWithStatusCode(
        'Path workspaceId does not match the organization workspace',
        403,
      );
    }
    return pathWs;
  }

  function buildTransport(ctx, imsToken) {
    return createSerenityTransport({ env: ctx.env || env, imsToken });
  }

  const listPrompts = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleListPrompts(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.workspaceId,
        parsedQuery(ctx),
      );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const createPrompts = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleCreatePrompts(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.workspaceId,
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
      const imsToken = requireImsBearer(ctx);
      const { promptId } = ctx?.params || {};
      if (!hasText(promptId)) {
        throw new ErrorWithStatusCode('Missing promptId', 400);
      }
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleUpdatePrompt(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.workspaceId,
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
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleBulkDeletePrompts(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.workspaceId,
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
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleListProjects(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.workspaceId,
        parsedQuery(ctx),
        log,
      );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const createProject = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleCreateProject(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.workspaceId,
        ctx.data || {},
        log,
      );
      return createResponse(result.body, result.status);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listProjectTags = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const pathWs = verifyPathWorkspace(ctx, auth.workspaceId);
      const { projectId } = ctx?.params || {};
      if (!hasText(projectId)) {
        throw new ErrorWithStatusCode('Missing projectId', 400);
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleListProjectTags(transport, pathWs, projectId);
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listProjectModels = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const pathWs = verifyPathWorkspace(ctx, auth.workspaceId);
      const { projectId } = ctx?.params || {};
      if (!hasText(projectId)) {
        throw new ErrorWithStatusCode('Missing projectId', 400);
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleListProjectModels(transport, pathWs, projectId);
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listWorkspaceProjects = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const pathWs = verifyPathWorkspace(ctx, auth.workspaceId);
      const transport = buildTransport(ctx, imsToken);
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

export default SerenityController;
