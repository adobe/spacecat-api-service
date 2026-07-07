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

// @ts-check

import {
  createResponse, forbidden, internalServerError, noContent, notFound,
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
import {
  handleCreateTag,
  handleCreateTagSubworkspace,
  handleUpdateTag,
  handleUpdateTagSubworkspace,
} from '../support/serenity/handlers/tags.js';
import { ensureSubworkspace, decommissionBrandWorkspace } from '../support/serenity/workspace-lifecycle.js';
import { isSerenityActiveForOrg } from '../support/serenity/serenity-active.js';
import { MAX_TOPICS_ON_CREATE } from '../support/serenity/brand-provisioning.js';
import { STANDARD_PROMPT_TAGS, PROJECT_STANDARD_TAGS } from '../support/serenity/prompt-tags.js';
import AccessControlUtil from '../support/access-control-util.js';
import { resolveBrandUuid } from '../support/prompts-storage.js';
import {
  getBrandAliases, getBrandUrlSources, getBrandCompetitors,
} from '../support/brands-storage.js';
import { ErrorWithStatusCode, resolveSemrushImsToken as resolveImsTokenViaPromise } from '../support/utils.js';
import { hostnameFromUrlString } from '../support/url-utils.js';
import { ensureMarketSite } from '../support/serenity/site-linkage.js';
import { X_PROMISE_TOKEN_HEADER, PROMISE_TOKEN_REQUIRED_ERROR_CODE } from '../utils/constants.js';
import { tombstoneAllForBrand, linkSiteToLiveRows } from '../support/serenity/mapping-rows.js';

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
  /** @type {Record<string, string | string[] | number | null>} */
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
    const errorToken = e.code && hasText(e.code) ? e.code : errorTokenForStatus(status);
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
 *
 * NOTE — this is NOT the only path into the handlers below: `x-promise-token`
 * (see `resolveSemrushImsToken`) is a SECOND, always-on (including production)
 * way to reach them without passing this function's IMS-type check, by
 * exchanging the promise token for an IMS token instead of forwarding
 * `Authorization` directly. This function's gate — and the test-only escape
 * hatch below — only govern the plain-bearer fallback path.
 *
 * SECURITY MODEL — this proxy is NOT the auth boundary; Semrush is. The bearer
 * we forward is validated AGAIN by the real Semrush gateway on every upstream
 * call (it rejects an invalid/expired/forged token with 401/403, which the
 * transport surfaces as a SerenityTransportError). This local check is only a
 * fail-fast + shape guard so we do not forward a token Semrush will obviously
 * reject; it never substitutes for the upstream's own validation.
 *
 * Test-only escape hatch: when `SERENITY_ALLOW_NON_IMS_AUTH === 'true'` AND the
 * runtime is not production, the IMS-type check is skipped so an authenticated
 * NON-IMS caller (e.g. the
 * locally-signed JWT the integration-test harness mints) can reach the
 * handlers. This is sound because (a) production auth is unaffected — Semrush
 * still validates the forwarded token end to end — and (b) the integration
 * tests run against the Semrush vendor MOCKS, which intentionally do not
 * validate the bearer, so the token's value never matters there, only that an
 * authenticated identity is present. Mirrors `SERENITY_ALLOW_WORKSPACE_DELETE`
 * in rest-transport.js: an explicit opt-in flag that NO deployed environment
 * sets (it is never written to Vault `dx_mysticat/<env>/api-service`); it is
 * for local + automated E2E only. The Authorization-header requirement still
 * holds — a bearer must be present to forward upstream.
 */
function requireImsBearer(ctx) {
  const authInfo = ctx?.attributes?.authInfo;
  // Hard-disable the escape hatch in production, mirroring getImsUserTokenStrict:
  // even if SERENITY_ALLOW_NON_IMS_AUTH were somehow set in a prod env, a non-IMS
  // caller must never reach the handlers there.
  const isProd = ctx?.env?.AWS_ENV === 'prod' || ctx?.env?.ENV === 'prod';
  const allowNonIms = !isProd && ctx?.env?.SERENITY_ALLOW_NON_IMS_AUTH === 'true';
  if (!allowNonIms && authInfo?.getType && authInfo.getType() !== 'ims') {
    // Reached only when x-promise-token was absent (resolveSemrushImsToken checks
    // that header first and never falls through to here when it's present) — a
    // non-IMS caller has no other way to authenticate to Semrush, so point them
    // at the promise-token flow instead of a bare "not authenticated" message.
    const err = new ErrorWithStatusCode(
      `Serenity proxy requires IMS authentication; send the ${X_PROMISE_TOKEN_HEADER} header instead`,
      401,
    );
    err.code = PROMISE_TOKEN_REQUIRED_ERROR_CODE;
    throw err;
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
 * semrush_sub_workspace_id from the data layer. ensureSubworkspace uses it as
 * a lost-update concurrency guard so a parallel activation cannot orphan a
 * freshly-created, resourced sub-workspace.
 */
export function brandPointerReloader(ctx, brandUuid) {
  return async () => {
    const Brand = ctx?.dataAccess?.Brand;
    if (!Brand || typeof Brand.findById !== 'function') {
      return null;
    }
    const fresh = await Brand.findById(brandUuid);
    return fresh?.getSemrushSubWorkspaceId?.() ?? null;
  };
}

// Logged at most once per process: makes an accidental SERENITY_ALLOW_NON_IMS_AUTH
// enablement in a deployed environment visible in the logs (the flag bypasses the
// IMS-type gate — it must only ever be set for local/automated E2E).
let warnedNonImsAuth = false;

function SerenityController(context, log, env) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }
  if (!log) {
    throw new Error('Log required');
  }
  if (!warnedNonImsAuth && (context?.env || env)?.SERENITY_ALLOW_NON_IMS_AUTH === 'true') {
    warnedNonImsAuth = true;
    log.warn('[serenity] SERENITY_ALLOW_NON_IMS_AUTH is enabled — the IMS-type auth gate is bypassed. This is test-only and must never be set in a deployed environment.');
  }

  /**
   * Resolves the IMS access token to forward to the Semrush gateway.
   *
   * Preferred path: the caller sends `x-promise-token` (minted by
   * POST /auth/v2/promise). This lets a caller authenticate to spacecat itself
   * with a NON-IMS credential (e.g. a spacecat JWT on `Authorization`) while
   * still supplying an IMS-exchangeable token for the upstream Semrush call —
   * mirrors the existing pattern in edge-routing-auth.js / fixes.js. The promise
   * token is checked FIRST and, when present, `requireImsBearer` (and its
   * `authInfo.getType() === 'ims'` gate) is never invoked, since `Authorization`
   * is not expected to carry an IMS token in that case. This is a SECOND,
   * always-on (including production) bypass of that gate, distinct from the
   * SERENITY_ALLOW_NON_IMS_AUTH test-only escape hatch above.
   *
   * Fallback path: no `x-promise-token` — behaves exactly as before, requiring
   * IMS-type auth and forwarding the `Authorization: Bearer <ims-token>` as-is.
   *
   * Delegates the promise-token decode/exchange to the shared
   * `resolveSemrushImsToken` helper in support/utils.js (also used by
   * elements.js and the brand create/edit/provisioning re-sync paths),
   * passing this controller's own `requireImsBearer` as the fallback since it
   * additionally supports the SERENITY_ALLOW_NON_IMS_AUTH test-only escape hatch.
   */
  async function resolveSemrushImsToken(ctx) {
    return resolveImsTokenViaPromise(ctx, log, 'serenity', requireImsBearer);
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
   *   - `mode` is 'subworkspace' when brands.semrush_sub_workspace_id is set, else 'flat'
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
    // Org-wide serenity rollout gate. Serenity is "active" for an org only when
    // its `LLMO/serenity` feature flag is ON *and* a Semrush workspace resolves
    // for the brand (the workspace half is enforced below by
    // resolveBrandWorkspace). While the flag is OFF the org's UI keeps reading
    // the normal backend data — even if a `semrush_sub_workspace_id` has
    // already been backfilled for rollout prep — so reject the serenity
    // surface with a 404 (the same "no serenity for this org" contract the UI already handles
    // for an org without a workspace). Checked before brand resolution so an
    // inactive org never leaks brand existence.
    if (!await isSerenityActiveForOrg(ctx, spaceCatId, log)) {
      return { error: notFound('Serenity is not active for this organization') };
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
    if (mode !== 'subworkspace' && (!workspaceId || !hasText(workspaceId))) {
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
      const imsToken = await resolveSemrushImsToken(ctx);
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
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const createPrompts = async (ctx) => {
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
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
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const updatePrompt = async (ctx) => {
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
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
      const imsToken = await resolveSemrushImsToken(ctx);
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
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listMarkets = async (ctx) => {
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
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
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const getMarket = async (ctx) => {
    try {
      // IMS bearer is required on the whole surface. Flat mode is a pure DB
      // read (no upstream), but subworkspace mode reads the live listing, so the token
      // is captured here and a transport built only when needed.
      const imsToken = await resolveSemrushImsToken(ctx);
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
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const createMarket = async (ctx) => {
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      let result;
      if (auth.mode === 'subworkspace') {
        const brand = await loadBrand(ctx, auth.brandUuid);
        // Brand aliases are brand-level but region-scoped: the create handler
        // clamps each to the new market's region before writing brand_names.
        const brandAliases = await getBrandAliases(
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
        // Optional prompt/topic generation for this market, defaulting to off so
        // the endpoint's behavior is unchanged unless the caller opts in.
        const genMarketTopics = (ctx.data || {}).generatePrompts === true;
        result = await handleCreateMarketSubworkspace(
          transport,
          brand,
          auth.parentWorkspaceId ?? '',
          ctx.data || {},
          log,
          null,
          brandPointerReloader(ctx, auth.brandUuid),
          {
            generateTopics: genMarketTopics,
            topicCap: genMarketTopics ? MAX_TOPICS_ON_CREATE : 0,
            standardTags: genMarketTopics ? [...STANDARD_PROMPT_TAGS] : [],
            projectTags: genMarketTopics ? [...PROJECT_STANDARD_TAGS] : [],
            brandAliases,
            brandUrlSources,
            competitors,
            // auth.brandUuid is an already-persisted brand row here (loadBrand
            // above), so the mapping-row upsert's FK to brands is satisfied —
            // see mapping-rows.js upsertMappingRow doc.
            // Narrowed to the one model the mapping-row helpers touch (defense
            // in depth: this options bag flows into markets-subworkspace.js and
            // shouldn't carry access to unrelated tables).
            dataAccess: { BrandSemrushProject: ctx.dataAccess.BrandSemrushProject },
          },
        );
        // Mirror this market as a SpaceCat Site (+ brand_sites link) keyed on the
        // market's own domain, once its Semrush project is created. Best-effort:
        // never fails a live market.
        if (result?.status === 201) {
          const linkedSiteId = await ensureMarketSite(ctx, {
            // Optional-chained so a missing/throwing accessor can't 500 a market
            // that is already live upstream — the mirror is best-effort.
            organizationId: brand.getOrganizationId?.(),
            brandId: auth.brandUuid,
            domain: ctx.data?.brandDomain,
            updatedBy: 'serenity-create-market',
            log,
          });
          // Best-effort, scope-guarded to unlinked live rows (mapping-rows.js) —
          // never overwrites an existing link.
          await linkSiteToLiveRows(ctx.dataAccess, auth.brandUuid, linkedSiteId, log);
        }
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
      const imsToken = await resolveSemrushImsToken(ctx);
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
      // Both delete handlers resolve to { status: 204 } on success (errors throw
      // → mapError); the response is an empty 204 either way, so await for the
      // upstream delete side effect and discard the result.
      await (auth.mode === 'subworkspace'
        ? handleDeleteMarketSubworkspace(
          transport,
          auth.workspaceId,
          geoTargetId,
          languageCode,
          log,
          // Narrowed to the one model the mapping-row helpers touch — see the
          // create-market call site above for the same rationale.
          { dataAccess: { BrandSemrushProject: ctx.dataAccess.BrandSemrushProject } },
        )
        : handleDeleteMarket(
          transport,
          ctx.dataAccess,
          auth.brandUuid,
          auth.workspaceId,
          geoTargetId,
          languageCode,
          log,
        ));
      return noContent();
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listTags = async (ctx) => {
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
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
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log);
    }
  };

  /**
   * POST /serenity/tags — register a `<type>:<NAME>` prompt tag on a single
   * market (the (geoTargetId, languageCode) slice in the body). `type` is one of
   * the open tag dimensions (CREATABLE_TAG_DIMENSIONS — `category` / `topic`);
   * the closed taxonomies are not freely creatable. The UI's "Categories" view,
   * for one, is derived from the `category:` tags across a brand's markets.
   * Dispatches by workspace mode, mirroring the tags/markets handlers.
   */
  const createTag = async (ctx) => {
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      // authorize() guarantees brandUuid (404s a missing brand) and, in flat
      // mode, a non-null workspaceId (404s 'no semrush_workspace_id'); assert
      // the invariant for the typed handler, mirroring activate().
      const result = auth.mode === 'subworkspace'
        ? await handleCreateTagSubworkspace(
          transport,
          /** @type {string} */ (auth.workspaceId),
          ctx.data || {},
          log,
        )
        : await handleCreateTag(
          transport,
          ctx.dataAccess,
          /** @type {string} */ (auth.brandUuid),
          /** @type {string} */ (auth.workspaceId),
          ctx.data || {},
          log,
        );
      return createResponse(result.body, result.status);
    } catch (e) {
      return mapError(e, log);
    }
  };

  /**
   * PATCH /serenity/tags/:tagId — rename and/or re-parent a single AIO tag in
   * place (the nested Categories edit path). `tagId` is the upstream tag id from a
   * prior tags list; the body carries the tag's full `name` (required upstream)
   * and an optional `parentId` to re-parent. An unknown tagId surfaces upstream as
   * a 404. Dispatches by workspace mode, mirroring createTag / updatePrompt.
   */
  const updateTag = async (ctx) => {
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      const { tagId } = ctx?.params || {};
      if (!hasText(tagId)) {
        throw new ErrorWithStatusCode('Missing tagId', 400);
      }
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = auth.mode === 'subworkspace'
        ? await handleUpdateTagSubworkspace(
          transport,
          /** @type {string} */ (auth.workspaceId),
          tagId,
          ctx.data || {},
          log,
        )
        : await handleUpdateTag(
          transport,
          ctx.dataAccess,
          /** @type {string} */ (auth.brandUuid),
          /** @type {string} */ (auth.workspaceId),
          tagId,
          ctx.data || {},
          log,
        );
      return createResponse(result.body, result.status);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const listModels = async (ctx) => {
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
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
      return createResponse(result, 200);
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
      const imsToken = await resolveSemrushImsToken(ctx);
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
      return createResponse(result, 200);
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
      const imsToken = await resolveSemrushImsToken(ctx);
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
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log);
    }
  };

  const updateModels = async (ctx) => {
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
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
      return createResponse(result, 200);
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
      const imsToken = await resolveSemrushImsToken(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      // authorize() guarantees a resolved brand (it 404s a missing one), but the
      // `{ error } | { brandUuid, ... }` union leaves `brandUuid` typed
      // `string | undefined`. Assert the non-null invariant once for the typed
      // data-access helpers below.
      // eslint-disable-next-line prefer-destructuring
      const brandUuid = /** @type {string} */ (auth.brandUuid);
      const body = ctx.data || {};
      const transport = buildTransport(ctx, imsToken);
      const brand = await loadBrand(ctx, brandUuid);
      // Markets + primary URL come from the request body, but a pending (draft)
      // brand activated from the wizard supplies none: fall back to what the
      // wizard stashed at "Save as pending" (brands.pending_semrush_provisioning =
      // { primaryUrl, markets }). A reactivation of an already-live brand
      // re-supplies them in the body, so the body wins when present.
      const pendingSemrushProvisioning = isNonEmptyObject(brand.getPendingSemrushProvisioning?.())
        ? brand.getPendingSemrushProvisioning()
        : null;
      const hadPendingSemrushProvisioning = pendingSemrushProvisioning != null;
      const storedMarkets = Array.isArray(pendingSemrushProvisioning?.markets)
        ? pendingSemrushProvisioning.markets
        : [];
      // Whether to generate topics/prompts for the provisioned project(s). Body
      // overrides the stash; default false preserves the historical activate
      // behavior (projects published without generated prompts).
      const generatePrompts = typeof body.generatePrompts === 'boolean'
        ? body.generatePrompts
        : pendingSemrushProvisioning?.generatePrompts === true;
      const wasPending = brand.getStatus?.() === 'pending';
      // The Semrush project domain: the request's brandDomain, else derived from
      // the stashed draft primary URL (the wizard's "Save as pending" URL).
      const suppliedUrlOrDomain = hasText(body.brandDomain)
        || hasText(pendingSemrushProvisioning?.primaryUrl);
      const brandDomain = hasText(body.brandDomain)
        ? body.brandDomain
        : hostnameFromUrlString(pendingSemrushProvisioning?.primaryUrl);

      // ----- Sub-workspace-only activation (no primary URL → no project) -----
      // A brand with no domain has nothing to provision a project against: just
      // ensure its sub-workspace (which IS the active-brand anchor, persisted by
      // ensureSubworkspace) and flip it active. This is the bare "save & continue
      // later" draft; the user adds markets (projects) afterwards from the Markets
      // tab. generatePrompts can't apply with no project, so reject the combo.
      if (!hasText(brandDomain)) {
        // A URL/domain WAS supplied but did not resolve to a hostname → bad input,
        // not a bare brand. Fail fast (a silent fallback would mask the typo and
        // strand the user with a project-less brand they did not ask for).
        if (suppliedUrlOrDomain) {
          throw new ErrorWithStatusCode('brandDomain is required to provision a Semrush market', 400);
        }
        if (generatePrompts) {
          throw new ErrorWithStatusCode('A primary URL is required to generate prompts', 400);
        }
        const bareWorkspaceId = await ensureSubworkspace(
          transport,
          brand,
          auth.parentWorkspaceId ?? '',
          1,
          log,
          {},
          brandPointerReloader(ctx, auth.brandUuid),
        );
        let bareSucceeded = true;
        if (typeof brand.setStatus === 'function') {
          brand.setStatus('active');
        }
        if (hadPendingSemrushProvisioning
          && typeof brand.setPendingSemrushProvisioning === 'function') {
          brand.setPendingSemrushProvisioning(null);
        }
        try {
          await brand.save();
        } catch (saveError) {
          bareSucceeded = false;
          log.error('serenity activate: SERENITY_ACTIVATE_SAVE_DIVERGENCE — sub-workspace ensured upstream but failed to persist active status', {
            brandId: auth.brandUuid,
            semrushWorkspaceId: bareWorkspaceId,
            error: saveError?.message,
          });
        }
        log.info('serenity activate: completed (sub-workspace only)', {
          brandId: auth.brandUuid,
          semrushWorkspaceId: bareWorkspaceId,
          fullySucceeded: bareSucceeded,
        });
        if (bareSucceeded) {
          return createResponse(
            { brandId: auth.brandUuid, status: 'active', markets: [] },
            200,
          );
        }
        // Save failed: a pending draft stays pending (retryable, idempotent — the
        // sub-workspace 409s on retry); an already-active brand is left active
        // (the flip was a no-op anyway).
        if (wasPending) {
          return createResponse(
            {
              brandId: auth.brandUuid,
              status: 'pending',
              error: 'serenityActivationIncomplete',
              message: 'Sub-workspace provisioned but the active status could not be persisted.',
              markets: [],
            },
            502,
          );
        }
        return createResponse(
          { brandId: auth.brandUuid, status: 'active', markets: [] },
          207,
        );
      }

      // ----- Project activation (primary URL present) -----
      // Markets come from the body (reactivation), else the stash. A draft with a
      // URL but no stashed market provisions a single US/EN fallback project — the
      // same default brand-provisioning.js applies on the direct-create path.
      const requestedMarkets = Array.isArray(body.markets) && body.markets.length > 0
        ? body.markets
        : storedMarkets;
      const markets = requestedMarkets.length > 0
        ? requestedMarkets
        : [{ market: 'US', languageCode: 'en' }];
      if (markets.length > MAX_MARKETS) {
        throw new ErrorWithStatusCode(`markets must not exceed ${MAX_MARKETS} entries`, 400);
      }
      // Brand aliases are brand-level but region-scoped: read once; each market's
      // create clamps them to that market's region before writing brand_names.
      const brandAliases = await getBrandAliases(
        brandUuid,
        ctx.dataAccess.services.postgrestClient,
      );
      // Brand URLs are brand-level: read once, push (region-filtered) per market.
      const brandUrlSources = await getBrandUrlSources(
        brandUuid,
        ctx.dataAccess.services.postgrestClient,
      );
      // Competitors are brand-level too: read once, merge (region-filtered) per market.
      const competitors = await getBrandCompetitors(
        brandUuid,
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
        auth.parentWorkspaceId ?? '',
        markets.length,
        log,
        {},
        brandPointerReloader(ctx, auth.brandUuid),
      );
      const results = [];
      for (const m of markets) {
        const createBody = {
          market: m.market,
          languageCode: m.languageCode,
          brandDomain,
          brandNames: body.brandNames,
          brandDisplayName: body.brandDisplayName,
          name: m.name,
        };
        // AI models (LLMs) the draft staged for this market (or that the activate
        // request supplied). handleCreateMarketSubworkspace reads them from its
        // OPTIONS arg (NOT the body) and attaches them to the project before
        // publish; omitted/empty → none attached.
        const marketModelIds = Array.isArray(m.modelIds) ? m.modelIds : [];
        let r;
        try {
          // eslint-disable-next-line no-await-in-loop
          r = await handleCreateMarketSubworkspace(
            transport,
            brand,
            auth.parentWorkspaceId ?? '',
            createBody,
            log,
            workspaceId,
            null,
            {
              modelIds: marketModelIds,
              // Generate topics/prompts only when the brand opted in. When false
              // the project is published empty (no prompts) — today's default.
              generateTopics: generatePrompts,
              topicCap: generatePrompts ? MAX_TOPICS_ON_CREATE : 0,
              standardTags: generatePrompts ? [...STANDARD_PROMPT_TAGS] : [],
              projectTags: generatePrompts ? [...PROJECT_STANDARD_TAGS] : [],
              // A project with neither models nor generated prompts publishes
              // "empty units" → Semrush's disguised quota 405. Tolerate it
              // (best-effort, leaves a draft) rather than failing activation; a
              // project with models OR prompts has real units and must publish.
              publishMode: marketModelIds.length > 0 || generatePrompts
                ? 'require'
                : 'best-effort',
              brandAliases,
              brandUrlSources,
              competitors,
              // `brand` was loaded via loadBrand above — an already-persisted
              // row, so the mapping-row upsert's FK to brands is satisfied.
              // Narrowed to the one model the mapping-row helpers touch — see
              // the single-market create call site for the same rationale.
              dataAccess: { BrandSemrushProject: ctx.dataAccess.BrandSemrushProject },
            },
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
        // 201 = created+published now; 409 = sliceExists (already live upstream).
        // Both mean the slice IS live (a full idempotent re-activate where every
        // market 409s is a complete success). The live/failed tally is derived
        // from `results` after the loop (see allMarketsLive below).
        results.push({
          market: m.market,
          languageCode: m.languageCode,
          status: r.status,
          body: r.body,
        });
      }

      // ALL-OR-NOTHING activation. The brand flips to 'active' ONLY when the
      // full provisioning chain succeeded:
      //   1. sub-workspace ensured (above; throws → caught → error response),
      //   2. EVERY market's project published (status 201/409 — all live),
      //   3. the brand is linked to its sub-workspace (semrushWorkspaceId,
      //      persisted by ensureSubworkspace above), AND
      //   4. every provisioned market is mirrored as a Site + brand_sites row
      //      (type='serenity').
      // If ANY step fails, a brand that was pending STAYS pending — its stash and
      // workspace pointer are left intact so a retry converges idempotently (live
      // markets return 409; the site-link + stash-clear re-run) — and the
      // response is an error. (An already-active brand re-supplying markets is
      // never downgraded.)
      const allMarketsLive = results.length > 0
        && results.every((r) => r.status === 201 || r.status === 409);

      // The brand_sites mirror is now a REQUIRED activation step (NOT
      // best-effort): run it only once every market is live. Every market in
      // this batch was provisioned against the single resolved `brandDomain`
      // (body/stash primary URL), so one idempotent ensure on that domain links
      // them all. A null return (any failure: bad input, cross-org, write error)
      // keeps the brand pending below.
      let siteLinked = false;
      if (allMarketsLive) {
        const linkedSiteId = await ensureMarketSite(ctx, {
          // Optional-chained so a missing/throwing accessor can't 500 the call.
          organizationId: brand.getOrganizationId?.(),
          brandId: auth.brandUuid,
          domain: brandDomain,
          updatedBy: 'serenity-activate',
          log,
        });
        siteLinked = !!linkedSiteId && hasText(linkedSiteId);
        // Best-effort, scope-guarded to unlinked live rows (mapping-rows.js) —
        // never overwrites an existing link. All markets in this batch share
        // one resolved brandDomain and thus one mirror Site, so by-brand picks
        // up every row this batch wrote (including 409/already-live ones).
        await linkSiteToLiveRows(ctx.dataAccess, auth.brandUuid, linkedSiteId, log);
      }

      let fullySucceeded = allMarketsLive && siteLinked;

      if (fullySucceeded) {
        if (typeof brand.setStatus === 'function') {
          brand.setStatus('active');
        }
        // Fully provisioned → clear the whole deferred-provisioning stash,
        // saved atomically with the status flip.
        if (hadPendingSemrushProvisioning
          && typeof brand.setPendingSemrushProvisioning === 'function') {
          brand.setPendingSemrushProvisioning(null);
        }
        try {
          await brand.save();
        } catch (saveError) {
          // Divergence seam: markets live + site linked upstream, but persisting
          // the 'active' flip failed → the brand stays 'pending'. A re-activate
          // converges (idempotent). Emit a DISTINCT, greppable token so the
          // orphaned status is alertable, then fall through to the error response
          // (do NOT collapse to a bare mapError 5xx — that discards the
          // per-market results telling the caller what went live).
          fullySucceeded = false;
          log.error('serenity activate: SERENITY_ACTIVATE_SAVE_DIVERGENCE — markets live + site linked upstream but failed to persist active status', {
            brandId: auth.brandUuid,
            semrushWorkspaceId: workspaceId,
            marketsLive: results.filter((r) => r.status === 201 || r.status === 409).length,
            error: saveError?.message,
          });
        }
      }

      const marketsLiveCount = results.filter((r) => r.status === 201 || r.status === 409).length;
      log.info('serenity activate: completed', {
        brandId: auth.brandUuid,
        semrushWorkspaceId: workspaceId,
        fullySucceeded,
        siteLinked,
        marketsTotal: results.length,
        marketsLive: marketsLiveCount,
        marketsFailed: results.length - marketsLiveCount,
      });

      if (fullySucceeded) {
        return createResponse(
          { brandId: auth.brandUuid, status: 'active', markets: results },
          200,
        );
      }

      // Not fully succeeded. A pending-draft activation that did not complete
      // every step STAYS pending and returns an ERROR (HTTP 502: the upstream
      // provisioning chain is incomplete) naming the failed step, with the
      // per-market results so the caller can show specifics and retry.
      if (wasPending) {
        if (allMarketsLive && !siteLinked) {
          // Every market is LIVE upstream, but the brand stays 'pending' because
          // the brand_sites mirror did not link (a transient write error, or the
          // type='serenity' migration not yet deployed — see
          // SERENITY_MARKET_LINK_REJECTED in site-linkage.js). The brand is dark
          // on our side despite live markets until a retry re-links. Emit a
          // DISTINCT, greppable token so this strand is alertable rather than
          // hidden in a generic 502; it self-heals on idempotent re-activate.
          log.error('serenity activate: SERENITY_ACTIVATE_LINK_INCOMPLETE — all markets live upstream but brand_sites mirror failed; brand stays pending', {
            brandId: auth.brandUuid,
            semrushWorkspaceId: workspaceId,
            marketsLive: marketsLiveCount,
          });
        }
        const failureReason = !allMarketsLive
          ? 'One or more markets failed to provision.'
          : 'Markets were provisioned but could not be linked as sites (brand_sites).';
        return createResponse(
          {
            brandId: auth.brandUuid,
            status: 'pending',
            error: 'serenityActivationIncomplete',
            message: failureReason,
            markets: results,
          },
          502,
        );
      }

      // An already-active brand re-supplying markets (reactivation) is never
      // downgraded: a single failed market is reported as 207 Multi-Status while
      // the brand remains active.
      return createResponse(
        { brandId: auth.brandUuid, status: 'active', markets: results },
        207,
      );
    } catch (e) {
      return mapError(e, log);
    }
  };

  /**
   * POST /serenity/deactivate — decommissions the brand's sub-workspace
   * (design flow 6): delete every project and release the allocation back to
   * the parent pool, then DISCONNECT the brand by clearing its
   * semrush_sub_workspace_id pointer. The sub-workspace itself is NEVER deleted
   * (deletion is forbidden — upstream deprovisioning is Semrush CS's act); it
   * is left empty and unowned. Clearing the pointer flips the brand back to
   * flat mode, so a future activate allocates a fresh sub-workspace. Sets
   * brands.status = 'pending'. No-op decommission (still 200) for a brand with
   * no sub-workspace.
   */
  const deactivate = async (ctx) => {
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      const auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const brand = await loadBrand(ctx, auth.brandUuid);
      const subworkspaceId = brand.getSemrushSubWorkspaceId?.();
      if (hasText(subworkspaceId)) {
        await decommissionBrandWorkspace(
          transport,
          subworkspaceId,
          log,
          auth.parentWorkspaceId ?? undefined,
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
        brand.setSemrushSubWorkspaceId?.(null);
        clearBrandWorkspaceCache();
        // Every project the brand owned is gone now that decommission emptied
        // the sub-workspace — tombstone the brand's live mapping rows
        // (best-effort, spec §4.2). By-brand because decommission only knows
        // the workspace id; also sweeps rows whose upstream project had
        // already vanished before decommission ran.
        await tombstoneAllForBrand(ctx.dataAccess, auth.brandUuid, log);
      }
      brand.setStatus?.('pending');
      if (typeof brand.save === 'function') {
        try {
          await brand.save();
        } catch (saveError) {
          // Non-atomic seam: the sub-workspace was already decommissioned
          // (emptied + allocation released) upstream, but persisting the
          // cleared pointer / pending status failed. The state is divergent —
          // brands.semrush_sub_workspace_id still points at the now-empty
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
      return createResponse({ brandId: auth.brandUuid, status: 'pending' }, 200);
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
    createTag,
    updateTag,
    listModels,
    listOrgModels,
    listOrgLanguages,
    updateModels,
    activate,
    deactivate,
  };
}

export default SerenityController;
