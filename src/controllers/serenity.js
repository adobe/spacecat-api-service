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
import {
  resolveBrandWorkspace,
  clearBrandWorkspaceCache,
} from '../support/serenity/workspace-resolver.js';
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
  listGlobalModelCatalog,
  listLanguageCatalog,
} from '../support/serenity/handlers/markets.js';
import {
  handleListMarketsSubworkspace,
  handleGetMarketSubworkspace,
  handleCreateMarketSubworkspace,
  handleDeleteMarketSubworkspace,
  handleListTagsSubworkspace,
  handleListModelsSubworkspace,
  handleUpdateModelsSubworkspace,
} from '../support/serenity/handlers/markets-subworkspace.js';
import {
  handleListPromptsSubworkspace,
  handleCreatePromptsSubworkspace,
  handleUpdatePromptSubworkspace,
  handleBulkDeletePromptsSubworkspace,
} from '../support/serenity/handlers/prompts-subworkspace.js';
import { ensureSubworkspace, decommissionBrandWorkspace } from '../support/serenity/workspace-lifecycle.js';
import AccessControlUtil from '../support/access-control-util.js';
import { resolveBrandUuid } from '../support/prompts-storage.js';
import {
  getBrandAliasNames, getBrandUrlSources, getBrandCompetitors,
} from '../support/brands-storage.js';
import { ErrorWithStatusCode } from '../support/utils.js';

const MAX_ERR_MSG_LEN = 500;
const BEARER_PREFIX = 'Bearer ';
// Upper bound on markets per activate request. Each market drives sequential
// upstream create+publish calls in the request thread, so an unbounded array
// could pin the Lambda (same rationale as MAX_MODEL_IDS on PUT /serenity/models).
const MAX_MARKETS = 50;

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
      // Do NOT echo e.message here: the transport error message embeds the full
      // gateway URL (internal host + workspace/project UUIDs). Return a generic
      // message and keep the detail to the log.error above (matches the 502 branch).
      return createResponse(
        { error: errorTokenForStatus(e.status), message: 'Upstream authorization failed' },
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

/**
 * Builds an async reload callback that re-reads the brand's CURRENT
 * semrush_workspace_id from the data layer. ensureSubworkspace uses it as a
 * lost-update concurrency guard so a parallel activation cannot orphan a
 * freshly-created, resourced sub-workspace.
 */
export function brandPointerReloader(ctx, brandUuid) {
  return async () => {
    const Brand = ctx?.dataAccess?.Brand;
    if (!Brand || typeof Brand.findById !== 'function') {
      return null;
    }
    const fresh = await Brand.findById(brandUuid);
    return fresh?.getSemrushWorkspaceId?.() ?? null;
  };
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
   *   - `mode` is 'subworkspace' when brands.semrush_workspace_id is set, else 'flat'
   *   - `workspaceId` is the workspace handlers call upstream (subworkspace ws in subworkspace
   *     mode, org parent in flat mode)
   *   - `parentWorkspaceId` is the org parent (needed for subworkspace create/activate)
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
    // resolveBrandWorkspace resolves the parent workspace once and returns it
    // alongside the mode, so activate can mint a sub-workspace without a second
    // org lookup. A brand already in subworkspace mode resolves against its OWN
    // workspace, so a missing/cleared parent must NOT 404 it out of a
    // functioning sub-workspace - only flat mode without a parent is a genuine
    // "no workspace" 404 (in flat mode workspaceId IS the parent).
    const { mode, workspaceId, parentWorkspaceId } = await resolveBrandWorkspace(
      ctx,
      spaceCatId,
      brandUuid,
    );
    if (mode !== 'subworkspace' && !hasText(workspaceId)) {
      return { error: notFound('Organization has no semrush_workspace_id') };
    }
    // Hard invariant: a brand's sub-workspace must NEVER be the org's shared
    // parent workspace. If they coincide (misconfiguration / bad backfill / a
    // gateway create that handed back the parent id), every sub-workspace
    // operation - most dangerously deactivate's decommission, which deletes all
    // projects and releases the allocation - would run against the shared
    // parent pool and wipe it for every brand in the org. Refuse all operations
    // until the pointer is corrected, rather than act on the parent.
    if (mode === 'subworkspace' && workspaceId === parentWorkspaceId) {
      log.error('serenity: brand sub-workspace equals org parent workspace - refusing', {
        brandUuid, spaceCatId, workspaceId,
      });
      return {
        error: createResponse(
          {
            error: 'workspaceMisconfigured',
            message: 'Brand sub-workspace must not be the organization parent workspace',
          },
          409,
        ),
      };
    }
    return {
      brandUuid, mode, workspaceId, parentWorkspaceId,
    };
  }

  function buildTransport(ctx, imsToken) {
    return createSerenityTransport({ env: ctx.env || env, imsToken });
  }

  /** Loads the Brand model instance (for subworkspace-mode write/lifecycle flows). */
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
      const result = auth.mode === 'subworkspace'
        ? await handleListPromptsSubworkspace(transport, auth.workspaceId, parsedQuery(ctx), log)
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
      const result = auth.mode === 'subworkspace'
        ? await handleCreatePromptsSubworkspace(transport, auth.workspaceId, ctx.data || {}, log)
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
      const result = auth.mode === 'subworkspace'
        ? await handleUpdatePromptSubworkspace(
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
      const result = auth.mode === 'subworkspace'
        ? await handleBulkDeletePromptsSubworkspace(
          transport,
          auth.workspaceId,
          ctx.data || {},
          log,
        )
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
      const result = auth.mode === 'subworkspace'
        ? await handleListMarketsSubworkspace(transport, auth.brandUuid, auth.workspaceId)
        : await handleListMarkets(
          transport,
          ctx.dataAccess,
          auth.brandUuid,
          auth.workspaceId,
        );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const getMarket = async (ctx) => {
    try {
      // IMS bearer is required on the whole surface. Flat mode is a pure DB
      // read (no upstream), but subworkspace mode reads the live listing, so the token
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
      const result = auth.mode === 'subworkspace'
        ? await handleGetMarketSubworkspace(
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
      if (auth.mode === 'subworkspace') {
        const brand = await loadBrand(ctx, auth.brandUuid);
        // Brand aliases are brand-level: every market/project carries them in
        // its Semrush brand_names.
        const brandAliases = await getBrandAliasNames(
          auth.brandUuid,
          ctx.dataAccess.services.postgrestClient,
        );
        // Brand URLs (own sites + social + earned) are brand-level too: read the
        // persisted set and push it (region-filtered) onto the new market.
        const brandUrlSources = await getBrandUrlSources(
          auth.brandUuid,
          ctx.dataAccess.services.postgrestClient,
        );
        // Competitors ("other brands to track") merge into the new market's CI list.
        const competitors = await getBrandCompetitors(
          auth.brandUuid,
          ctx.dataAccess.services.postgrestClient,
        );
        result = await handleCreateMarketSubworkspace(
          transport,
          brand,
          auth.parentWorkspaceId,
          ctx.data || {},
          log,
          null,
          brandPointerReloader(ctx, auth.brandUuid),
          { brandAliases, brandUrlSources, competitors },
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
      const result = auth.mode === 'subworkspace'
        ? await handleDeleteMarketSubworkspace(
          transport,
          auth.workspaceId,
          geoTargetId,
          languageCode,
          log,
        )
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
      const result = auth.mode === 'subworkspace'
        ? await handleListTagsSubworkspace(transport, auth.workspaceId, parsedQuery(ctx), log)
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
      const result = auth.mode === 'subworkspace'
        ? await handleListModelsSubworkspace(transport, auth.workspaceId, parsedQuery(ctx), log)
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

  /**
   * GET /v2/orgs/:spaceCatId/serenity/models — the brand-INDEPENDENT global AI
   * model catalog. The add-brand wizard needs the catalog before a brand (and
   * its workspace) exists, so this authorizes at the org level and reads the
   * workspace-independent `GET /v1/ai_models` catalog. No brand/workspace
   * resolution, no geo/lang params.
   */
  const listOrgModels = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const spaceCatId = ctx?.params?.spaceCatId;
      if (!isValidUUID(spaceCatId)) {
        return createResponse(
          { error: 'invalidRequest', message: 'spaceCatId must be a UUID' },
          400,
        );
      }
      const Organization = ctx?.dataAccess?.Organization;
      if (!Organization || typeof Organization.findById !== 'function') {
        return internalServerError('Organization data-access not available');
      }
      const organization = await Organization.findById(spaceCatId);
      if (!organization) {
        return notFound(`Organization not found: ${spaceCatId}`);
      }
      const accessControl = AccessControlUtil.fromContext(ctx);
      if (!await accessControl.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await listGlobalModelCatalog(transport);
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  /**
   * GET /v2/orgs/:spaceCatId/serenity/languages — the brand-INDEPENDENT catalog
   * of languages Semrush AIO supports. The add-brand wizard needs it before a
   * brand (and its workspace) exists to limit the language picker to codes that
   * will actually resolve (org-level auth, no brand/workspace resolution).
   */
  const listOrgLanguages = async (ctx) => {
    try {
      const imsToken = requireImsBearer(ctx);
      const spaceCatId = ctx?.params?.spaceCatId;
      if (!isValidUUID(spaceCatId)) {
        return createResponse(
          { error: 'invalidRequest', message: 'spaceCatId must be a UUID' },
          400,
        );
      }
      const Organization = ctx?.dataAccess?.Organization;
      if (!Organization || typeof Organization.findById !== 'function') {
        return internalServerError('Organization data-access not available');
      }
      const organization = await Organization.findById(spaceCatId);
      if (!organization) {
        return notFound(`Organization not found: ${spaceCatId}`);
      }
      const accessControl = AccessControlUtil.fromContext(ctx);
      if (!await accessControl.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }
      const transport = buildTransport(ctx, imsToken);
      const result = await listLanguageCatalog(transport);
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
      const result = auth.mode === 'subworkspace'
        ? await handleUpdateModelsSubworkspace(transport, auth.workspaceId, ctx.data || {}, log)
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
   * POST /serenity/activate — flips a brand into subworkspace mode (design flow 5):
   * ensure the subworkspace, then per caller-supplied market create a draft,
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
      if (markets.length > MAX_MARKETS) {
        throw new ErrorWithStatusCode(`markets must not exceed ${MAX_MARKETS} entries`, 400);
      }
      const transport = buildTransport(ctx, imsToken);
      const brand = await loadBrand(ctx, auth.brandUuid);
      // Brand aliases are brand-level: read once and apply to every market's
      // project (Semrush brand_names) in this batch.
      const brandAliases = await getBrandAliasNames(
        auth.brandUuid,
        ctx.dataAccess.services.postgrestClient,
      );
      // Brand URLs are brand-level: read once, push (region-filtered) per market.
      const brandUrlSources = await getBrandUrlSources(
        auth.brandUuid,
        ctx.dataAccess.services.postgrestClient,
      );
      // Competitors are brand-level too: read once, merge (region-filtered) per market.
      const competitors = await getBrandCompetitors(
        auth.brandUuid,
        ctx.dataAccess.services.postgrestClient,
      );

      // Ensure the sub-workspace ONCE for the whole batch, sized to the real
      // market count, then create each market against the resolved workspace.
      // (Calling ensureSubworkspace per market would re-grant + double-poll N
      // times — seconds of redundant settling that risks the Lambda timeout —
      // and size the allocation as if there were a single market.)
      const workspaceId = await ensureSubworkspace(
        transport,
        brand,
        auth.parentWorkspaceId,
        markets.length,
        log,
        {},
        brandPointerReloader(ctx, auth.brandUuid),
      );
      const results = [];
      let anyLive = false; // ≥1 market is live (created now OR already live)
      let anyFailed = false; // ≥1 market neither created nor already-live
      for (const m of markets) {
        const createBody = {
          market: m.market,
          languageCode: m.languageCode,
          brandDomain: body.brandDomain,
          brandNames: body.brandNames,
          brandDisplayName: body.brandDisplayName,
          name: m.name,
        };
        let r;
        try {
          // eslint-disable-next-line no-await-in-loop
          r = await handleCreateMarketSubworkspace(
            transport,
            brand,
            auth.parentWorkspaceId,
            createBody,
            log,
            workspaceId,
            null,
            { brandAliases, brandUrlSources, competitors },
          );
        } catch (e) {
          // A single market failing must NOT abort the batch: markets already
          // published in this loop are live upstream, and aborting would leave
          // them live while the brand stays pending with no per-market record.
          // Record the failure and continue; the multi-status response reports
          // it per market. (A generic message - never the upstream error text,
          // which carries the gateway URL.)
          log?.error?.('serenity activate: market create failed', {
            market: m.market,
            languageCode: m.languageCode,
            status: e?.status,
          });
          r = {
            status: e?.status || 502,
            body: { error: 'serenityUpstreamError', message: 'Market activation failed' },
          };
        }
        // 201 = created+published now; 409 = sliceExists (the market is already
        // live upstream). Both mean the slice IS live, so both count toward
        // brand-active and neither trips the partial-failure path — a full
        // idempotent re-activate (every market already live → all 409s) is a
        // complete success, not a 207/pending.
        if (r.status === 201 || r.status === 409) {
          anyLive = true;
        } else {
          anyFailed = true;
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
      // Success-level summary so a completed activation can be correlated with
      // upstream state during incident investigation (counts + workspace).
      log.info('serenity activate: completed', {
        brandId: auth.brandUuid,
        semrushWorkspaceId: workspaceId,
        status: anyLive ? 'active' : 'pending',
        marketsTotal: results.length,
        marketsLive: results.filter((r) => r.status === 201 || r.status === 409).length,
        marketsFailed: results.filter((r) => !(r.status === 201 || r.status === 409)).length,
      });
      // 207 Multi-Status whenever ANY market failed (even if others went live),
      // so a caller keying off the HTTP status sees the partial failure instead
      // of a bare 200. 200 only when every market is live.
      return createResponse(
        {
          brandId: auth.brandUuid,
          status: anyLive ? 'active' : 'pending',
          markets: results,
        },
        anyFailed ? 207 : 200,
      );
    } catch (e) {
      return mapError(e, log);
    }
  };

  /**
   * POST /serenity/deactivate — decommissions the brand's sub-workspace
   * (design flow 6): delete every project and release the allocation back to
   * the parent pool, then DISCONNECT the brand by clearing its
   * semrush_workspace_id pointer. The sub-workspace itself is NEVER deleted
   * (deletion is forbidden — upstream deprovisioning is Semrush CS's act); it
   * is left empty and unowned. Clearing the pointer flips the brand back to
   * flat mode, so a future activate allocates a fresh sub-workspace. Sets
   * brands.status = 'pending'. No-op decommission (still 200) for a brand with
   * no sub-workspace.
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
      const subworkspaceId = brand.getSemrushWorkspaceId?.();
      if (hasText(subworkspaceId)) {
        await decommissionBrandWorkspace(
          transport,
          subworkspaceId,
          log,
          auth.parentWorkspaceId,
          {
            enforceLinkedGuard:
              (ctx.env || env)?.SERENITY_ENFORCE_LINKED_SUBWORKSPACE_GUARD === 'true',
          },
        );
        // Disconnect the brand from the now-emptied sub-workspace. The
        // sub-workspace is kept (never deleted); clearing the pointer is what
        // returns the brand to flat mode. Invalidate the resolver cache HERE —
        // before the save — so that even if save() throws, the resolver can't
        // keep routing to the already-emptied sub-workspace for the full
        // positive-TTL window (the upstream is empty the moment decommission
        // returns).
        brand.setSemrushWorkspaceId?.(null);
        clearBrandWorkspaceCache();
      }
      brand.setStatus?.('pending');
      if (typeof brand.save === 'function') {
        try {
          await brand.save();
        } catch (saveError) {
          // Non-atomic seam: the sub-workspace was already decommissioned
          // (emptied + allocation released) upstream, but persisting the
          // cleared pointer / pending status failed. The state is divergent —
          // brands.semrush_workspace_id still points at the now-empty
          // sub-workspace and status is not 'pending'. A re-activate converges
          // (the re-grant path re-uses the emptied workspace), so this
          // self-heals, but emit a DISTINCT, greppable token so the orphan is
          // alertable rather than indistinguishable from an ordinary upstream
          // error. Re-throw to mapError after recording it.
          log.error('serenity deactivate: SERENITY_DEACTIVATE_SAVE_DIVERGENCE — decommissioned upstream but failed to persist pointer/status', {
            brandId: auth.brandUuid,
            decommissionedWorkspaceId: hasText(subworkspaceId) ? subworkspaceId : null,
            error: saveError?.message,
          });
          throw saveError;
        }
      }
      log.info('serenity deactivate: completed', {
        brandId: auth.brandUuid,
        decommissionedWorkspaceId: hasText(subworkspaceId) ? subworkspaceId : null,
        status: 'pending',
      });
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
    listOrgModels,
    listOrgLanguages,
    updateModels,
    activate,
    deactivate,
  };
}

export default SerenityController;
