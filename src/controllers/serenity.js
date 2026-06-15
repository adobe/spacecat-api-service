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
import { resolveWorkspaceId, resolveBrandWorkspace } from '../support/serenity/workspace-resolver.js';
import {
  handleListPrompts,
  handleCreatePrompts,
  handleUpdatePrompt,
  handleBulkDeletePrompts,
} from '../support/serenity/handlers/prompts.js';
import {
  handleListMarkets,
  handleGetMarket,
  handleCreateMarket,
  handleDeleteMarket,
  handleListTags,
  handleListModels,
  handleUpdateModels,
} from '../support/serenity/handlers/markets.js';
import {
  handleListMarketsChild,
  handleGetMarketChild,
  handleCreateMarketChild,
  handleDeleteMarketChild,
  handleListTagsChild,
  handleListModelsChild,
  handleUpdateModelsChild,
} from '../support/serenity/handlers/markets-child.js';
import {
  handleListPromptsChild,
  handleCreatePromptsChild,
  handleUpdatePromptChild,
  handleBulkDeletePromptsChild,
} from '../support/serenity/handlers/prompts-child.js';
import { decommissionBrandWorkspace } from '../support/serenity/workspace-lifecycle.js';
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
        // tagIds is multi-value — collected below via getAll(); excluded here
        // to avoid last-write-wins clobbering the array. Any future multi-value
        // param should follow the same pattern.
        if (k !== 'tagIds') {
          out[k] = v;
        }
      }
      const tagIdsAll = u.searchParams.getAll('tagIds');
      if (tagIdsAll.length > 0) {
        out.tagIds = tagIdsAll;
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
   * Returns either `{ error: Response }` or
   * `{ brandUuid, mode, workspaceId, parentWorkspaceId }`:
   *   - `mode` is 'child' when brands.semrush_workspace_id is set, else 'legacy'
   *   - `workspaceId` is the workspace handlers call upstream (child ws in child
   *     mode, org parent in legacy mode)
   *   - `parentWorkspaceId` is the org parent (needed for child create/activate)
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
    const parentWorkspaceId = await resolveWorkspaceId(ctx, spaceCatId);
    if (!hasText(parentWorkspaceId)) {
      return { error: notFound('Organization has no semrush_workspace_id') };
    }
    const { mode, workspaceId } = await resolveBrandWorkspace(ctx, spaceCatId, brandUuid);
    return {
      brandUuid, mode, workspaceId, parentWorkspaceId,
    };
  }

  function buildTransport(ctx, imsToken) {
    return createSerenityTransport({ env: ctx.env || env, imsToken });
  }

  /** Loads the Brand model instance (for child-mode write/lifecycle flows). */
  async function loadBrand(ctx, brandUuid) {
    const Brand = ctx?.dataAccess?.Brand;
    if (!Brand || typeof Brand.findById !== 'function') {
      throw new ErrorWithStatusCode('Brand data-access not available', 500);
    }
    const brand = await Brand.findById(brandUuid);
    if (!brand) {
      throw new ErrorWithStatusCode(`Brand not found: ${brandUuid}`, 404);
    }
    return brand;
  }

  const listPrompts = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = auth.mode === 'child'
        ? await handleListPromptsChild(transport, auth.workspaceId, parsedQuery(ctx), log)
        : await handleListPrompts(
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
      const result = auth.mode === 'child'
        ? await handleCreatePromptsChild(transport, auth.workspaceId, ctx.data || {}, log)
        : await handleCreatePrompts(
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
      const { semrushPromptId } = ctx?.params || {};
      if (!hasText(semrushPromptId)) {
        throw new ErrorWithStatusCode('Missing semrushPromptId', 400);
      }
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = auth.mode === 'child'
        ? await handleUpdatePromptChild(
          transport,
          auth.workspaceId,
          semrushPromptId,
          ctx.data || {},
          log,
        )
        : await handleUpdatePrompt(
          transport,
          ctx.dataAccess,
          auth.brandUuid,
          auth.workspaceId,
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
      const result = auth.mode === 'child'
        ? await handleBulkDeletePromptsChild(transport, auth.workspaceId, ctx.data || {}, log)
        : await handleBulkDeletePrompts(
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

  const listMarkets = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = auth.mode === 'child'
        ? await handleListMarketsChild(transport, auth.brandUuid, auth.workspaceId)
        : await handleListMarkets(
          transport,
          ctx.dataAccess,
          auth.brandUuid,
          auth.workspaceId,
          log,
        );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const getMarket = async (ctx) => {
    try {
      // IMS bearer is required on the whole surface. Legacy mode is a pure DB
      // read (no upstream), but child mode reads the live listing, so the token
      // is captured here and a transport built only when needed.
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { geoTargetId: pGeo, languageCode: pLang } = ctx?.params || {};
      // Strict digit match — same rationale as deleteMarket: parseInt would
      // coerce '2840abc' → 2840 and silently resolve a different slice.
      const geoTargetId = /^\d+$/.test(String(pGeo || '')) ? Number(pGeo) : null;
      const languageCode = pLang ? String(pLang).toLowerCase() : null;
      const result = auth.mode === 'child'
        ? await handleGetMarketChild(
          buildTransport(ctx, imsToken),
          auth.brandUuid,
          auth.workspaceId,
          geoTargetId,
          languageCode,
          log,
        )
        : await handleGetMarket(ctx.dataAccess, auth.brandUuid, geoTargetId, languageCode);
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
      let result;
      if (auth.mode === 'child') {
        const brand = await loadBrand(ctx, auth.brandUuid);
        result = await handleCreateMarketChild(
          transport,
          brand,
          auth.parentWorkspaceId,
          ctx.data || {},
          log,
        );
      } else {
        result = await handleCreateMarket(
          transport,
          ctx.dataAccess,
          auth.brandUuid,
          auth.workspaceId,
          ctx.data || {},
          log,
        );
      }
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
      const languageCode = pLang ? String(pLang).toLowerCase() : null;
      const transport = buildTransport(ctx, imsToken);
      const result = auth.mode === 'child'
        ? await handleDeleteMarketChild(transport, auth.workspaceId, geoTargetId, languageCode, log)
        : await handleDeleteMarket(
          transport,
          ctx.dataAccess,
          auth.brandUuid,
          auth.workspaceId,
          geoTargetId,
          languageCode,
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
      const result = auth.mode === 'child'
        ? await handleListTagsChild(transport, auth.workspaceId, parsedQuery(ctx), log)
        : await handleListTags(
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

  const listModels = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = auth.mode === 'child'
        ? await handleListModelsChild(transport, auth.workspaceId, parsedQuery(ctx), log)
        : await handleListModels(
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

  const updateModels = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = auth.mode === 'child'
        ? await handleUpdateModelsChild(transport, auth.workspaceId, ctx.data || {}, log)
        : await handleUpdateModels(
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

  /**
   * POST /serenity/activate — flips a brand into child mode (design flow 5):
   * ensure the child workspace, then per caller-supplied market create a draft,
   * publish once, and confirm. Sets brands.status = 'active' once ≥1 market is
   * live. Body: { brandDomain, brandNames, brandDisplayName?, markets: [{ market,
   * languageCode }] }. Markets are supplied by the caller (reactivation
   * re-supplies them — there is no stored memory).
   */
  const activate = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const body = ctx.data || {};
      const markets = Array.isArray(body.markets) ? body.markets : [];
      if (markets.length === 0) {
        throw new ErrorWithStatusCode('markets must be a non-empty array', 400);
      }
      const transport = buildTransport(ctx, imsToken);
      const brand = await loadBrand(ctx, auth.brandUuid);

      // ensureChildWorkspace (inside handleCreateMarketChild) is idempotent —
      // the first market creates/re-grants the workspace; later markets re-grant
      // (a settle + transfer) onto the now-existing workspace.
      const results = [];
      let anyLive = false;
      for (const m of markets) {
        const createBody = {
          market: m.market,
          languageCode: m.languageCode,
          brandDomain: body.brandDomain,
          brandNames: body.brandNames,
          brandDisplayName: body.brandDisplayName,
          name: m.name,
        };
        // eslint-disable-next-line no-await-in-loop
        const r = await handleCreateMarketChild(
          transport,
          brand,
          auth.parentWorkspaceId,
          createBody,
          log,
        );
        if (r.status === 201) {
          anyLive = true;
        }
        results.push({
          market: m.market,
          languageCode: m.languageCode,
          status: r.status,
          body: r.body,
        });
      }

      if (anyLive && typeof brand.setStatus === 'function') {
        brand.setStatus('active');
        await brand.save();
      }
      return createResponse(
        { brandId: auth.brandUuid, status: anyLive ? 'active' : 'pending', markets: results },
        anyLive ? 200 : 207,
      );
    } catch (e) {
      return mapError(e, log);
    }
  };

  /**
   * POST /serenity/deactivate — decommissions the brand's child workspace
   * (design flow 6): delete every project, release the allocation back to the
   * parent pool, keep the workspace and its semrush_workspace_id pointer. Sets
   * brands.status = 'pending'. No-op (200) for a brand with no child workspace.
   */
  const deactivate = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const brand = await loadBrand(ctx, auth.brandUuid);
      const childWorkspaceId = brand.getSemrushWorkspaceId?.();
      if (hasText(childWorkspaceId)) {
        await decommissionBrandWorkspace(transport, childWorkspaceId, log);
      }
      if (typeof brand.setStatus === 'function') {
        brand.setStatus('pending');
        await brand.save();
      }
      return ok({ brandId: auth.brandUuid, status: 'pending' });
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
    getMarket,
    createMarket,
    deleteMarket,
    listTags,
    listModels,
    updateModels,
    activate,
    deactivate,
  };
}

export default SerenityController;
