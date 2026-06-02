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
import { hasText, isNonEmptyObject, isValidUUID } from '@adobe/spacecat-shared-utils';
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
  handleListMarkets,
  handleCreateMarket,
  handleDeleteMarket,
  handleListTags,
  handleListModels,
} from '../support/serenity/handlers/markets.js';
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
 * Extracts query params from the request URL. Does NOT fall back to
 * `context.data` (the request body) — body keys must never become query keys
 * on a GET (silent attribute-confusion vector).
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
  if (raw.geoTargetId !== undefined) {
    const n = parseInt(raw.geoTargetId, 10);
    out.geoTargetId = Number.isFinite(n) ? n : null;
  }
  if (raw.page !== undefined) {
    const n = parseInt(raw.page, 10);
    out.page = Number.isFinite(n) ? n : null;
  }
  if (raw.limit !== undefined) {
    const n = parseInt(raw.limit, 10);
    out.limit = Number.isFinite(n) ? n : null;
  }
  return out;
}

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

function mapError(e, log) {
  if (e instanceof ErrorWithStatusCode) {
    const status = Number.isInteger(e.status) ? e.status : 400;
    // Handlers can set `e.code` (e.g. 'marketNotFound') to pin a specific
    // error token in the response envelope; falls back to the status-based
    // default for plain throws.
    const errorToken = hasText(e.code) ? e.code : errorTokenForStatus(status);
    return createResponse(
      { error: errorToken, message: safeError(e.message) },
      status,
    );
  }
  if (e instanceof SerenityTransportError) {
    log.error('Serenity upstream error', e);
    if (e.status === 401 || e.status === 403) {
      return createResponse(
        { error: errorTokenForStatus(e.status), message: safeError(e.message) },
        e.status,
      );
    }
    return createResponse({
      error: 'serenityUpstreamError',
      message: 'Upstream request failed',
    }, 502);
  }
  log.error('Serenity controller error', e);
  return createResponse(
    { error: 'internalServerError', message: 'Internal server error' },
    500,
  );
}

/**
 * Pulls the IMS bearer from the inbound Authorization header. Throws 401 if
 * missing OR if the caller authenticated by some other mechanism. The
 * upstream gateway only understands IMS user tokens; we refuse to forward
 * anything else.
 */
function requireImsBearer(ctx) {
  const authInfo = ctx?.attributes?.authInfo;
  if (authInfo?.getType && authInfo.getType() !== 'ims') {
    throw new ErrorWithStatusCode(
      'Serenity proxy requires IMS authentication',
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
   * Verifies the caller has access to the addressed org AND the brand
   * belongs to that org, then resolves the org's upstream workspace.
   *
   * UUID-only brand guard: serenity endpoints reject non-UUID `:brandId`
   * with 400 at the controller boundary. UUIDs are immutable; a renamed
   * brand between page load and a PATCH/DELETE would otherwise silently
   * 404 (or worse, resolve to a different row on a name collision).
   *
   * Returns either `{ error: Response }` or `{ brandUuid, semrushWorkspaceId }`.
   */
  async function authorize(ctx) {
    const spaceCatId = ctx?.params?.spaceCatId;
    const brandId = ctx?.params?.brandId;
    if (!isValidUUID(brandId)) {
      return {
        error: createResponse(
          {
            error: 'invalidRequest',
            message: 'brandId must be a UUID on the /serenity/* surface',
          },
          400,
        ),
      };
    }
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
    const semrushWorkspaceId = await resolveWorkspaceId(ctx, spaceCatId);
    if (!hasText(semrushWorkspaceId)) {
      return { error: notFound('Organization has no semrush_workspace_id') };
    }
    return { brandUuid, semrushWorkspaceId };
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
        auth.semrushWorkspaceId,
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
        auth.semrushWorkspaceId,
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
      const { semrushPromptId } = ctx?.params || {};
      if (!hasText(semrushPromptId)) {
        throw new ErrorWithStatusCode('Missing semrushPromptId', 400);
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
        auth.semrushWorkspaceId,
        semrushPromptId,
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
        auth.semrushWorkspaceId,
        ctx.data || {},
        log,
      );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listMarkets = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleListMarkets(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.semrushWorkspaceId,
        log,
      );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const createMarket = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleCreateMarket(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.semrushWorkspaceId,
        ctx.data || {},
        log,
      );
      return createResponse(result.body, result.status);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const deleteMarket = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { geoTargetId: pGeo, languageCode: pLang } = ctx?.params || {};
      // Strict digit match: `parseInt('2840abc', 10)` returns 2840, which would
      // silently route /markets/2840abc/en to the legit (2840, en) slice. The
      // OpenAPI contract declares `geoTargetId: integer, minimum: 1`, so the
      // path segment must be all digits.
      const geoTargetId = /^\d+$/.test(String(pGeo || '')) ? Number(pGeo) : null;
      const transport = buildTransport(ctx, imsToken);
      const result = await handleDeleteMarket(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.semrushWorkspaceId,
        geoTargetId,
        pLang ? String(pLang).toLowerCase() : null,
        log,
      );
      return createResponse(null, result.status);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listTags = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleListTags(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.semrushWorkspaceId,
        parsedQuery(ctx),
        log,
      );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listModels = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await handleListModels(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.semrushWorkspaceId,
        parsedQuery(ctx),
      );
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
    listMarkets,
    createMarket,
    deleteMarket,
    listTags,
    listModels,
  };
}

export default SerenityController;
