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

import { randomUUID } from 'crypto';

import {
  createResponse, forbidden, internalServerError, noContent, notFound, accepted,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText, isNonEmptyObject, isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';

import { createSerenityTransport } from '../support/serenity/rest-transport.js';
import {
  ERROR_CODES, isSemrushTransportError, unwrapTransportCause,
} from '../support/serenity/errors.js';
import {
  resolveBrandWorkspace,
  clearBrandWorkspaceCache,
} from '../support/serenity/workspace-resolver.js';
import {
  handleListPrompts,
  handleCreatePrompts,
  handleUpdatePrompt,
  handleBulkDeletePrompts,
  validateAsync,
  BULK_PROMPTS_MAX_ITEMS,
  resolveCallerId,
  assertCreatePromptTagLimits,
} from '../support/serenity/handlers/prompts.js';
import { orchestrateCreateMarketSubworkspace } from '../support/serenity/handlers/create-market-orchestration.js';
import { orchestrateActivateMarkets } from '../support/serenity/handlers/activate-markets-orchestration.js';
import { createAndEnqueueJob } from '../support/serenity/async-job-runner.js';
import { CLASSIFY_PROMPTS_JOB_TYPE } from '../support/serenity/handlers/classify-prompts-job.js';
import { PROVISION_WORKSPACE_JOB_TYPE } from '../support/serenity/handlers/provision-workspace-job.js';
import { CREATE_MARKET_JOB_TYPE } from '../support/serenity/handlers/create-market-job.js';
import { ACTIVATE_MARKETS_JOB_TYPE } from '../support/serenity/handlers/activate-markets-job.js';
import { ACTIVATE_BRAND_WORKSPACE_JOB_TYPE } from '../support/serenity/handlers/activate-brand-workspace-job.js';
import { ORIGIN_VALUE } from '../support/serenity/prompt-tags.js';
import {
  BULK_TAGS_JOB_TYPE,
  BULK_TAGS_PUBLIC_JOB_TYPE,
  handleBulkTags,
  handleBulkTagsSubworkspace,
  pageBulkFailures,
} from '../support/serenity/handlers/bulk-tags-job.js';
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
  handleDeleteTag,
  handleDeleteTagSubworkspace,
  handleTagImpact,
  handleTagImpactSubworkspace,
} from '../support/serenity/handlers/tags.js';
import { ensureSubworkspace, decommissionBrandWorkspace } from '../support/serenity/workspace-lifecycle.js';
import { isSerenityActiveForBrand } from '../support/serenity/serenity-active.js';
import { marketForGeoTargetId } from '../support/serenity/locations.js';
import { brandNeedles, classifyBrandedTag } from '../support/serenity/branded-classifier.js';
import { computeWriteDeadline } from '../support/serenity/intent-classification.js';
import AccessControlUtil from '../support/access-control-util.js';
import { isServicePrincipal, resolveBrandUuid } from '../support/prompts-storage.js';
import {
  getBrandAliases, getBrandBaseSiteId,
  cancelProvisioningAttempt,
  guardAgainstConcurrentProvisioning, beginProvisioningAttempt, updateProvisioningJobId,
  getBrandProvisioningState,
} from '../support/brands-storage.js';
import { ErrorWithStatusCode, resolveSemrushImsToken as resolveImsTokenViaPromise } from '../support/utils.js';
import {
  resolveSiteIdentity,
  unlinkMarketSiteIfOrphaned,
} from '../support/serenity/site-linkage.js';
import { X_PROMISE_TOKEN_HEADER, PROMISE_TOKEN_REQUIRED_ERROR_CODE } from '../utils/constants.js';
import { tombstoneAllForBrand } from '../support/serenity/mapping-rows.js';
import { logUpstreamError } from '../support/serenity/upstream-log.js';

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

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? undefined;
  }
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1];
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
  if (raw.failureLimit !== undefined) {
    const n = parseInt(raw.failureLimit, 10);
    out.failureLimit = Number.isFinite(n) ? n : null;
  }
  return out;
}

const PUBLIC_JOB_ERROR_CODES = new Set([
  ERROR_CODES.INVALID_REQUEST,
  ERROR_CODES.PROMPT_NOT_FOUND,
  ERROR_CODES.SERENITY_UPSTREAM_ERROR,
  ERROR_CODES.TAG_LIMIT_EXCEEDED,
  ERROR_CODES.INCOMPATIBLE_TAG_TAXONOMY,
  ERROR_CODES.PROMPT_CORPUS_INCOMPLETE,
]);

function publicJobError(error) {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const code = PUBLIC_JOB_ERROR_CODES.has(error.code) ? error.code : ERROR_CODES.JOB_FAILED;
  let message = 'The background job failed';
  if (code === ERROR_CODES.SERENITY_UPSTREAM_ERROR) {
    message = 'Upstream request failed';
  } else if (code !== ERROR_CODES.JOB_FAILED && typeof error.message === 'string') {
    message = safeError(error.message).slice(0, 256) || message;
  }
  return {
    code,
    message,
    retryable: error.retryable === true,
  };
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

/** @param {string} code @param {unknown} details @returns {object | undefined} */
function publicErrorDetails(code, details) {
  if (!details || typeof details !== 'object') {
    return undefined;
  }
  const value = /** @type {any} */ (details);
  if (code === ERROR_CODES.TAG_LIMIT_EXCEEDED
    && Number.isInteger(value.attemptedCount)
    && Number.isInteger(value.maxPromptTagIds)) {
    return {
      attemptedCount: value.attemptedCount,
      maxPromptTagIds: value.maxPromptTagIds,
    };
  }
  if (code === ERROR_CODES.TAG_FILTER_TOO_LARGE
    && Number.isInteger(value.attemptedCount)
    && Number.isInteger(value.maxTagFilterValues)) {
    return {
      attemptedCount: value.attemptedCount,
      maxTagFilterValues: value.maxTagFilterValues,
    };
  }
  return undefined;
}

/**
 * @param {object} [ctx]
 * @param {{ brandUuid?: string, workspaceId?: string | null }} [auth]
 * @returns {Record<string, unknown>}
 */
function reqCtxOf(ctx, auth) {
  return {
    spaceCatId: ctx?.params?.spaceCatId,
    brandId: ctx?.params?.brandId,
    brandUuid: auth?.brandUuid,
    workspaceId: auth?.workspaceId,
  };
}

function mapError(e, log, reqCtx = {}) {
  if (e instanceof ErrorWithStatusCode) {
    const status = Number.isInteger(e.status) ? e.status : 400;
    // Handlers can set `e.code` (e.g. 'marketNotFound') to pin a specific
    // error token in the response envelope; falls back to the status-based
    // default for plain throws.
    const errorToken = e.code && hasText(e.code) ? e.code : errorTokenForStatus(status);
    const details = publicErrorDetails(errorToken, /** @type {any} */ (e).details);
    // `serenityLogged` is set ad hoc by project-provisioning.js's
    // cleanupAndRethrow, not declared on ErrorWithStatusCode itself.
    const alreadyLogged = /** @type {{ serenityLogged?: boolean }} */ (e).serenityLogged;
    if (e.code === ERROR_CODES.MAIN_BRAND_BENCHMARK_INVARIANT && !alreadyLogged) {
      // The client-facing message is deliberately generic (LLMO-7421 review) —
      // log the workspace/project/count detail server-side only, via the
      // error's own properties. Skipped when `e.serenityLogged` is already set
      // (project-provisioning.js's cleanupAndRethrow logged this exact failure
      // on the flat provisioning path) so both provisioning paths log the
      // invariant exactly once, not twice on one path and once on the other.
      // reqCtx passed as a structured field, not string-interpolated into the
      // message, so it can't be mistaken for (or exploit) log-format control
      // characters in a caller-controlled value (MysticatBot review).
      log?.error?.('Serenity controller error', { reqCtx, error: e });
    }
    return createResponse(
      {
        error: errorToken,
        message: safeError(e.message),
        ...(details ? { details } : {}),
      },
      status,
    );
  }
  // A Project Engine call now throws ProjectEngineApiError directly (LLMO-6386, adaptPE retired).
  // On its no-HTTP-response path (per-attempt timeout / exhausted network / a missing-IMS-token
  // 401) the status is `undefined` and the original throw is carried as `.cause` — the retired
  // adaptPE boundary used to rethrow that cause, so unwrap it here to keep the mapping below
  // yielding the SAME HTTP code (auth → 401, timeout → 502, raw network → 500). A bare undefined
  // status would otherwise flatten all three to 502, silently regressing the auth response.
  const err = unwrapTransportCause(e);
  if (isSemrushTransportError(err)) {
    logUpstreamError(log, 'Serenity upstream error', err, reqCtx);
    if (err.status === 401 || err.status === 403) {
      // Do NOT echo err.message here: the transport error message embeds the full
      // gateway URL (internal host + workspace/project UUIDs). Return a generic
      // message and keep the detail to the log.error above (matches the 502 branch).
      return createResponse(
        { error: errorTokenForStatus(err.status), message: 'Upstream authorization failed' },
        err.status,
      );
    }
    if (err.status === 409) {
      // An upstream refusal of a conflicting write (e.g. a prompt rename onto a
      // sibling prompt's exact text — serenity-docs#63) is the caller's to act
      // on, not an upstream outage: surface the status and the `conflict` token
      // instead of flattening it into the generic 502. Message stays redacted
      // for the same reason as the 401/403 branch above.
      return createResponse(
        { error: errorTokenForStatus(err.status), message: 'Upstream rejected the request as a conflict' },
        err.status,
      );
    }
    return createResponse({
      error: 'serenityUpstreamError',
      message: 'Upstream request failed',
    }, 502);
  }
  // Not an upstream error: reqCtx passed as a structured field (not
  // JSON.stringify'd into the message string), matching the benchmark
  // invariant branch above — a caller-controlled reqCtx value can't be
  // mistaken for log-format control characters this way (MysticatBot review).
  log.error('Serenity controller error', { reqCtx, error: err });
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
 * transport surfaces as a typed Semrush error — ProjectEngineApiError for a
 * Project Engine call, SerenityTransportError for a User Manager one — both
 * classified by isSemrushTransportError). This local check is only a
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
    // Per-brand serenity rollout gate. Serenity is "active" for a brand only
    // when its resolved `LLMO/serenity` value is ON *and* a Semrush workspace
    // resolves for it (the workspace half is enforced below by
    // resolveBrandWorkspace). The value resolves the brand's own override row
    // first and falls back to the organization's row, so an org that activated
    // everything at once still answers for all of its brands, while a
    // mid-migration org serves only the brands its waves have released. While a
    // brand is inactive its UI keeps reading the normal backend data — even if a
    // `semrush_sub_workspace_id` has already been backfilled for rollout prep —
    // so reject the serenity surface with a 404 (the same "no serenity here"
    // contract the UI already handles for a brand without a workspace).
    //
    // This resolves AFTER brand resolution, where the org-wide gate it replaces
    // ran before it to avoid leaking brand existence. That ordering is no longer
    // load-bearing: every caller reaching this point has passed
    // `hasAccess(organization)` above and can already enumerate the org's brands
    // via `GET /organizations/:id/brands`, so keeping the precise "brand not
    // found" body reveals nothing a shared 404 would hide, and it stays
    // diagnosable mid-wave.
    const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
    if (!brandUuid) {
      return { error: notFound(`Brand not found for organization: ${brandId}`) };
    }
    if (!await isSerenityActiveForBrand(ctx, spaceCatId, brandUuid, log)) {
      return { error: notFound('Serenity is not active for this brand') };
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

  /**
   * Builds the server-side `branded`/`non-branded` `type`-value classifier for the
   * manual prompt create/edit paths (serenity-docs#31). Loads the brand's display
   * name + aliases ONCE per request, then returns a pure
   * `(text, geoTargetId) => TYPE_VALUE` closure: each prompt's market is derived
   * from its geoTargetId and the alias needles are region-clamped to that market
   * (memoized per market). This is the SAME classifier the AI-generation and
   * onboarding paths use, so a prompt is classified identically no matter how it
   * is written; the client never controls the value.
   */
  async function buildPromptTypeClassifier(ctx, brandUuid) {
    const brand = await loadBrand(ctx, brandUuid);
    const brandName = brand.getName?.() || '';
    const brandAliases = await getBrandAliases(
      brandUuid,
      ctx.dataAccess.services.postgrestClient,
    );
    const needlesByMarket = new Map();
    return (text, geoTargetId) => {
      const market = marketForGeoTargetId(geoTargetId) || '';
      let needles = needlesByMarket.get(market);
      if (!needles) {
        needles = brandNeedles(brandName, brandAliases, market);
        needlesByMarket.set(market, needles);
      }
      return classifyBrandedTag(text, needles);
    };
  }

  const listPrompts = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = auth.mode === 'subworkspace'
        ? await handleListPromptsSubworkspace(transport, auth.workspaceId, parsedQuery(ctx), log)
        : await handleListPrompts(
          transport,
          ctx.dataAccess,
          /** @type {string} */ (auth.brandUuid),
          /** @type {string} */ (auth.workspaceId),
          parsedQuery(ctx),
          log,
        );
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  const createPrompts = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      // serenity-docs#33 (Layer 1, #2920): async routing is keyed off a DEDICATED
      // `async: true` flag, NOT `deferPublish`. `deferPublish` is a publish-
      // batching hint on the SYNCHRONOUS CSV-chunking path (set on every non-final
      // chunk); conflating the two made that sync client silently receive 202s it
      // never handled (a multi-chunk import broke). Keying async off its own
      // explicit opt-in keeps every existing write path — single create/edit, UI
      // multi-add, and the sync CSV-chunking client — synchronous and untouched,
      // and makes the async job runner strictly opt-in for callers that will poll
      // the job. BOTH modes enqueue: the worker reconstructs the write from the
      // metadata below — `authMode` picks the subworkspace-vs-flat create branch,
      // `workspaceId`/`parentWorkspaceId` give it the sub-workspace and org parent
      // it needs.
      const body = ctx.data || {};
      // Deliberately diverges from the v2/Postgres path's `deriveV2PromptOrigin`
      // (prompts-storage.js), which reuses this SAME `isServicePrincipal`
      // classifier but then honours a service principal's declared body
      // `origin` (defaulting to `human` when absent/invalid). This proxy route
      // has no such body-origin write surface — `origin` is a closed,
      // server-owned dimension here (see makePromptTagInjector) — so a service
      // principal is unconditionally `ai`, matching origin-dimension.md §3's
      // "Serenity AI generation, service, ai" row. That is safe only because no
      // non-AI service principal is expected to front this route; if one ever
      // does (e.g. an S2S integration proxying human-authored prompts), it
      // would be silently mislabeled `ai` with no way to declare `human`.
      const originValue = isServicePrincipal(ctx?.attributes?.authInfo)
        ? ORIGIN_VALUE.AI
        : ORIGIN_VALUE.HUMAN;
      if (validateAsync(body)) {
        const prompts = Array.isArray(body.prompts) ? body.prompts : [];
        if (prompts.length === 0) {
          return createResponse(
            { error: 'invalidRequest', message: 'Body must include a non-empty prompts array' },
            400,
          );
        }
        if (prompts.length > BULK_PROMPTS_MAX_ITEMS) {
          return createResponse(
            { error: 'invalidRequest', message: `prompts array exceeds maxItems=${BULK_PROMPTS_MAX_ITEMS}` },
            400,
          );
        }
        assertCreatePromptTagLimits(prompts);
        const job = await createAndEnqueueJob(ctx, {
          jobType: CLASSIFY_PROMPTS_JOB_TYPE,
          metadata: {
            mode: 'create',
            brandId: auth.brandUuid,
            // Backwards-compatible: the flat worker create path already reads
            // `semrushWorkspaceId` as the workspace to write to — in subworkspace
            // mode `auth.workspaceId` IS the sub-workspace, so the same key names
            // the correct upstream target for both modes.
            semrushWorkspaceId: auth.workspaceId,
            // Explicit reconstruction fields (this PR): `authMode` selects the
            // worker's create branch; `workspaceId` is the sub-workspace the live
            // project listing (buildSliceProjectMap) is enumerated from;
            // `parentWorkspaceId` is the org parent, carried for completeness.
            authMode: auth.mode,
            workspaceId: auth.workspaceId,
            parentWorkspaceId: auth.parentWorkspaceId,
            prompts,
            originValue,
            // Authorship (LLMO-6289): capture the caller id at enqueue time — from
            // the auth profile, never the forwarded upstream bearer — so the async
            // classify-on-create job stamps the submitter, not the job runner.
            callerId: resolveCallerId(ctx),
          },
        });
        return accepted({
          jobId: job.getId(), jobType: 'classifyPrompts', status: job.getStatus(),
        });
      }
      const transport = buildTransport(ctx, imsToken);
      const classifyPromptType = await buildPromptTypeClassifier(ctx, auth.brandUuid);
      // serenity-docs#32: one shared write-budget deadline for classify + create
      // + publish, computed once at request entry.
      const writeDeadline = computeWriteDeadline();
      // CORRECTNESS-CRITICAL (LLMO-6289): resolve the caller identity ONCE, from
      // the request's auth profile — NEVER from the bearer forwarded upstream —
      // and thread it into every write below to stamp created_*/updated_*.
      const callerId = resolveCallerId(ctx);
      const result = auth.mode === 'subworkspace'
        ? await handleCreatePromptsSubworkspace(
          transport,
          /** @type {string} */ (auth.workspaceId),
          ctx.data || {},
          log,
          classifyPromptType,
          ctx.env,
          writeDeadline,
          callerId,
          {
            // serenity-docs#72 §5: feeds the quota-rejection Slack alert (opt-in via
            // SERENITY_QUOTA_ALERTS_ENABLED) — never required, a no-op when unset.
            orgId: ctx?.params?.spaceCatId,
            brandId: auth.brandUuid,
            originValue,
          },
        )
        : await handleCreatePrompts(
          transport,
          ctx.dataAccess,
          auth.brandUuid,
          /** @type {string} */ (auth.workspaceId),
          ctx.data || {},
          log,
          classifyPromptType,
          ctx.env,
          writeDeadline,
          callerId,
          { orgId: ctx?.params?.spaceCatId, originValue },
        );
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  const updatePrompt = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      const { semrushPromptId } = ctx?.params || {};
      if (!hasText(semrushPromptId)) {
        throw new ErrorWithStatusCode('Missing semrushPromptId', 400);
      }
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const classifyPromptType = await buildPromptTypeClassifier(ctx, auth.brandUuid);
      const writeDeadline = computeWriteDeadline();
      // Caller identity for the updated_* stamp — resolved from the auth profile,
      // never the forwarded upstream bearer (LLMO-6289).
      const callerId = resolveCallerId(ctx);
      const result = auth.mode === 'subworkspace'
        ? await handleUpdatePromptSubworkspace(
          transport,
          auth.workspaceId,
          semrushPromptId,
          ctx.data || {},
          log,
          classifyPromptType,
          ctx.env,
          writeDeadline,
          callerId,
        )
        : await handleUpdatePrompt(
          transport,
          ctx.dataAccess,
          auth.brandUuid,
          auth.workspaceId,
          semrushPromptId,
          ctx.data || {},
          log,
          classifyPromptType,
          ctx.env,
          writeDeadline,
          callerId,
        );
      return createResponse(result.body, result.status);
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  const bulkDeletePrompts = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      // Requester identity (LLMO-6289 pattern, SITES-50099 audit trail): resolve
      // from the auth profile — NEVER the forwarded upstream bearer — and thread
      // it through so the delete audit log line attributes the caller, not the
      // Semrush service principal.
      const callerId = resolveCallerId(ctx);
      const result = auth.mode === 'subworkspace'
        ? await handleBulkDeletePromptsSubworkspace(
          transport,
          /** @type {string} */ (auth.workspaceId),
          ctx.data || {},
          log,
          {
            orgId: ctx?.params?.spaceCatId, brandId: auth.brandUuid, env: ctx.env || env, callerId,
          },
        )
        : await handleBulkDeletePrompts(
          transport,
          ctx.dataAccess,
          auth.brandUuid,
          /** @type {string} */ (auth.workspaceId),
          ctx.data || {},
          log,
          { orgId: ctx?.params?.spaceCatId, env: ctx.env || env, callerId },
        );
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  const bulkTagPrompts = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const callerId = resolveCallerId(ctx);
      const idempotencyKey = headerValue(ctx?.pathInfo?.headers, 'idempotency-key');
      const result = auth.mode === 'subworkspace'
        ? await handleBulkTagsSubworkspace(
          ctx,
          transport,
          /** @type {string} */ (auth.brandUuid),
          /** @type {string} */ (ctx?.params?.spaceCatId),
          /** @type {string} */ (auth.workspaceId),
          ctx.data || {},
          callerId,
          idempotencyKey,
          log,
        )
        : await handleBulkTags(
          ctx,
          transport,
          ctx.dataAccess,
          /** @type {string} */ (auth.brandUuid),
          /** @type {string} */ (ctx?.params?.spaceCatId),
          /** @type {string} */ (auth.workspaceId),
          ctx.data || {},
          callerId,
          idempotencyKey,
          log,
        );
      return createResponse(result.body, result.status);
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  const listMarkets = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = auth.mode === 'subworkspace'
        ? await handleListMarketsSubworkspace(
          transport,
          /** @type {string} */ (auth.brandUuid),
          /** @type {string} */ (auth.workspaceId),
          // Passed so the live slices can be enriched with each market's siteId
          // from the brand's mapping rows (LLMO-6405 Phase 2); best-effort.
          ctx.dataAccess,
          log,
        )
        : await handleListMarkets(
          transport,
          ctx.dataAccess,
          auth.brandUuid,
          auth.workspaceId,
        );
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  const getMarket = async (ctx) => {
    let auth;
    try {
      // IMS bearer is required on the whole surface. Flat mode is a pure DB
      // read (no upstream), but subworkspace mode reads the live listing, so the token
      // is captured here and a transport built only when needed.
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
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
          // Enrich the resolved slice with its siteId (LLMO-6405 Phase 2).
          ctx.dataAccess,
        )
        : await handleGetMarket(ctx.dataAccess, auth.brandUuid, geoTargetId, languageCode);
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  /**
   * @typedef {{
   *   geoTargetId: number, languageCode: string|null, workspaceId: string,
   *   promptCount?: number,
   * }} MarketCreateSuccessBody
   */

  const createMarket = async (ctx) => {
    let auth;
    try {
      // Shared write-budget deadline for the SYNCHRONOUS branch only (serenity-docs#32);
      // the async branch below never uses it (the write happens in the worker, not this
      // request).
      const writeDeadline = computeWriteDeadline();
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const requestBody = ctx.data || {};
      // Optional siteId (LLMO-6405 Phase 2): a market created from an already-
      // onboarded URL carries its SpaceCat Site UUID, so the client can send
      // `siteId` instead of a raw `brandDomain`. Captured once for both the
      // domain derivation and the direct site link below. Absent → unchanged.
      const suppliedSiteId = hasText(requestBody.siteId) ? requestBody.siteId : null;
      // A supplied Site is resolved and ownership-checked HERE, before either mode
      // dispatches, because the id the caller names decides what the market's
      // project analyses: it lands on `brand_to_semrush_projects.site_id`, the
      // per-market source of truth for `settings.ai.primary_url`. Neither handler
      // can make that check — the sub-workspace one has no Site access, and the
      // flat one has no organization — so a Site from another organization would
      // otherwise be recorded verbatim and point this project at someone else's
      // site. Unresolvable and cross-org both answer the same 400: whether the id
      // is unknown or simply not yours is not the caller's business.
      let suppliedSiteIdentity = null;
      if (suppliedSiteId) {
        const orgId = ctx?.params?.spaceCatId;
        suppliedSiteIdentity = await resolveSiteIdentity(
          ctx.dataAccess,
          suppliedSiteId,
          log,
          orgId,
        );
        if (!suppliedSiteIdentity?.domain || !hasText(suppliedSiteIdentity.domain)) {
          return createResponse(
            { error: 'invalidRequest', message: 'siteId did not resolve to a site domain' },
            400,
          );
        }
      }
      if (auth.mode === 'subworkspace') {
        // PR-C conversion (LLMO-7352/LLMO-7418): this is one of the 3 real conversion
        // candidates — the subworkspace-mode create path defaults `ensureSubworkspace` to
        // `'poll'` (see `orchestrateCreateMarketSubworkspace` → `handleCreateMarketSubworkspace`),
        // the in-request settle-poll + project-create/publish sequence that is the biggest
        // remaining Fastly-edge-timeout risk of the endpoints this epic covers.
        //
        // Opt-in only (mirrors createPrompts' own `async` flag, `validateAsync` above):
        // `async: true` mints a provisioning attempt and hands the whole create off to the
        // `provision-workspace-job` -> `serenity-create-market` job chain instead of running
        // it synchronously. Absent/false runs the EXACT same synchronous call this endpoint
        // has always made — no behavior change for any caller that doesn't opt in. Unlike
        // `createPrompts`'s flag, this one is NOT a permanent dual-mode feature: the
        // synchronous branch is the LLMO-7352 bug pattern itself, not a valid alternative, and
        // is slated for removal once every known caller has migrated to `async: true`.
        if (validateAsync(requestBody)) {
          // The worker's existing-pointer fast path (provision-workspace-job.js) polls THIS
          // brand's already-canonical workspace rather than provisioning a new one — every
          // brand reaching this branch already has one (`auth.mode === 'subworkspace'` IS that
          // invariant; see `authorize`).
          //
          // LLMO-7418 external-review Finding 9: beginProvisioningAttempt's own CAS has no
          // staleness awareness — a stuck `pending` row (a crashed worker, a DLQ'd message) would
          // 409 here forever, with nothing else to ever reconcile it once every caller has
          // migrated to async (a scheduled sweep is architecturally impossible — Semrush only
          // accepts user-token auth). Reuse the sync guard's own reconcile-or-409 logic first: a
          // stale attempt is reconciled to `failed` here (so the CAS below then succeeds), a
          // genuinely fresh one still 409s (via the guard's own throw, same shape as `!began`'s).
          await guardAgainstConcurrentProvisioning(
            auth.brandUuid,
            ctx.dataAccess.services.postgrestClient,
            log,
          );
          const attemptId = randomUUID();
          const began = await beginProvisioningAttempt({
            brandId: auth.brandUuid,
            attemptId,
            postgrestClient: ctx.dataAccess.services.postgrestClient,
            updatedBy: 'serenity-create-market',
          });
          if (!began) {
            const err = new ErrorWithStatusCode(
              'A Semrush sub-workspace provisioning attempt is already in progress for this '
              + 'brand; please retry shortly.',
              409,
            );
            err.code = 'semrush_provisioning_in_progress';
            throw err;
          }
          // N2 note: no `title` is passed here deliberately. This branch runs only in
          // subworkspace mode, where the brand already has a canonical pointer, so the worker
          // polls that existing workspace and never reads `title`. The one exception is a narrow
          // race (a concurrent deactivate clearing the pointer within the ~10s workspace-mode
          // cache) in which the worker would take its create path with no title and fail fast —
          // an acceptable, clearly-surfaced error, since creating a NEW sub-workspace mid
          // add-market is itself not a valid outcome (unlike activate, which legitimately mints
          // one and therefore does pass a title).
          const job = await createAndEnqueueJob(ctx, {
            jobType: PROVISION_WORKSPACE_JOB_TYPE,
            metadata: {
              brandId: auth.brandUuid,
              attemptId,
              parentWorkspaceId: auth.parentWorkspaceId ?? '',
              chainedJobType: CREATE_MARKET_JOB_TYPE,
              chainedJobMetadata: {
                brandId: auth.brandUuid,
                parentWorkspaceId: auth.parentWorkspaceId ?? '',
                orgId: ctx?.params?.spaceCatId,
                requestBody,
                suppliedSiteIdentity,
                suppliedSiteId,
                callerId: resolveCallerId(ctx),
              },
            },
          });
          // LLMO-7418 external-review Finding 17: only the worker's OWN self-requeue path ever
          // wrote semrush_provisioning_job_id, so an attempt resolving on its first hop (the
          // common case) left it permanently NULL — contradicting the column's own database
          // comment and leaving no brand-to-job link for an attempt that never requeues.
          // Best-effort, same as the worker's own write: a failure here must never turn an
          // already-successfully-enqueued job into a client-facing error.
          await updateProvisioningJobId({
            brandId: auth.brandUuid,
            attemptId,
            jobId: job.getId(),
            postgrestClient: ctx.dataAccess.services.postgrestClient,
          }).catch((updateError) => {
            log.error('createMarket: failed to record the first-hop job id (best-effort)', {
              brandId: auth.brandUuid, attemptId, jobId: job.getId(), error: updateError?.message,
            });
          });
          return accepted({ jobId: job.getId(), status: job.getStatus() });
        }
        // PR-C guard (LLMO-7352/LLMO-7418): this branch stays synchronous by default, but an
        // `activate` call for this SAME brand may have an async provisioning attempt in flight
        // (from its own `async: true` twin, or from createBrandForOrg) — without this check, a
        // concurrent sync createMarket and an async activate batch could both independently
        // create/publish a project against the same workspace. See the wasPending/
        // bare-reactivation branches in `activate` for the identical rationale.
        await guardAgainstConcurrentProvisioning(
          auth.brandUuid,
          ctx.dataAccess.services.postgrestClient,
          log,
        );
        const result = await orchestrateCreateMarketSubworkspace({
          dataAccess: ctx.dataAccess,
          env: ctx.env,
          orgId: ctx?.params?.spaceCatId,
          transport,
          brandUuid: auth.brandUuid,
          parentWorkspaceId: auth.parentWorkspaceId ?? '',
          workspaceId: /** @type {string} */ (auth.workspaceId),
          requestBody,
          log,
          writeDeadline,
          suppliedSiteIdentity,
          suppliedSiteId,
          reloadPointer: brandPointerReloader(ctx, auth.brandUuid),
          callerId: resolveCallerId(ctx),
        });
        return createResponse(result.body, result.status);
      }
      // LLMO-7418 external-review (adversarial B1): a brand whose sub-workspace pointer is not yet
      // written resolves to `mode: 'flat'` with `workspaceId = the ORG'S SHARED PARENT`
      // (workspace-resolver.js: `if (hasText(subworkspaceId)) … else return { mode: 'flat',
      // workspaceId: parentWorkspaceId }`). That is correct for a genuinely flat brand, and WRONG
      // for a Semrush brand that is merely mid-provisioning: async creation persists the brand
      // before Semrush confirms the workspace, so for the whole provisioning window this brand
      // looks flat. Falling through here would create and publish a project in the shared org
      // workspace — consuming the org's shared allocation, bound in the DB to this brand — and the
      // moment the real pointer lands the brand flips to sub-workspace mode and that market
      // becomes invisible: an orphaned upstream project plus a stale mapping row.
      //
      // A tracked provisioning attempt is the signal that this brand is NOT flat, it is a
      // sub-workspace brand whose workspace does not exist yet. Refuse rather than silently
      // writing to the parent. `pending` = in flight; `failed` = provisioning did not complete, so
      // the brand still has no workspace of its own to create a market in. A genuinely flat brand
      // (non-Serenity org) has no provisioning row at all and is unaffected.
      const flatProvisioningState = await getBrandProvisioningState(
        /** @type {string} */ (auth.brandUuid),
        ctx.dataAccess.services.postgrestClient,
      ).catch(() => null); // never fail an otherwise-valid flat create on a state-read blip
      if (flatProvisioningState?.provisioningStatus === 'pending'
        || flatProvisioningState?.provisioningStatus === 'failed') {
        const err = new ErrorWithStatusCode(
          'This brand\'s Semrush sub-workspace is still being set up; adding a market is not '
          + 'available until provisioning completes.',
          409,
        );
        err.code = 'semrush_provisioning_incomplete';
        throw err;
      }
      // Flat handler self-derives brandDomain from siteId (it has Site access).
      const result = await handleCreateMarket(
        transport,
        ctx.dataAccess,
        auth.brandUuid,
        auth.workspaceId,
        requestBody,
        log,
      );
      return createResponse(result.body, result.status);
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  const deleteMarket = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
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
      // Both delete handlers resolve to { status: 204, deletedSiteId } on success
      // (errors throw → mapError). The response is an empty 204 either way; the
      // deletedSiteId feeds the R12 orphan-link cleanup below.
      const deleteResult = await (auth.mode === 'subworkspace'
        ? handleDeleteMarketSubworkspace(
          transport,
          auth.workspaceId,
          geoTargetId,
          languageCode,
          log,
          // Narrowed to the one model the mapping-row helpers touch — see the
          // create-market call site above for the same rationale.
          {
            dataAccess: { BrandSemrushProject: ctx.dataAccess.BrandSemrushProject },
          },
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

      // R12 (LLMO-6405): when the deleted market was the LAST live market on its
      // (non-primary) Site, remove the now-orphaned brand_sites 'serenity' link.
      // Best-effort: never fails the 204. The brand's PRIMARY site (brands.site_id)
      // is protected — resolved here and passed to the reference-count guard. If
      // the primary-site lookup itself fails, skip the unlink entirely (fail-safe:
      // never risk removing the primary link on a transient read error).
      const deletedSiteId = deleteResult?.deletedSiteId ?? null;
      if (hasText(deletedSiteId)) {
        let primarySiteId = null;
        let primaryResolved = true;
        try {
          primarySiteId = await getBrandBaseSiteId(
            ctx?.params?.spaceCatId,
            /** @type {string} */ (auth.brandUuid),
            ctx.dataAccess.services.postgrestClient,
          );
        } catch (lookupErr) {
          primaryResolved = false;
          log.warn('serenity deleteMarket: primary-site lookup failed; skipping brand_sites unlink', {
            brandId: auth.brandUuid,
            error: lookupErr?.message,
          });
        }
        if (primaryResolved) {
          await unlinkMarketSiteIfOrphaned(ctx, {
            brandId: auth.brandUuid,
            siteId: deletedSiteId,
            primarySiteId,
          }, log);
        }
      }
      return noContent();
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  const listTags = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
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
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  /**
   * POST /serenity/tags — register a bare-named prompt tag beneath a dimension
   * root, on a single market (the (geoTargetId, languageCode) slice in the body).
   * `type` names the dimension (one of ALL_DIMENSIONS). An open `category` value
   * is customer-authored and may name a `parentId` inside its own dimension; a
   * closed dimension's value comes from a fixed vocabulary and is resolved or
   * created under its own root, never under a caller-chosen parent. The UI's
   * "Categories" view, for one, is derived from the `category` root's descendants
   * across a brand's markets.
   * Dispatches by workspace mode, mirroring the tags/markets handlers.
   */
  const createTag = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
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
      return mapError(e, log, reqCtxOf(ctx, auth));
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
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      const { tagId } = ctx?.params || {};
      if (!hasText(tagId)) {
        throw new ErrorWithStatusCode('Missing tagId', 400);
      }
      auth = await authorize(ctx);
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
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  /**
   * DELETE /serenity/tags/:tagId — delete a category (or sub-category) and its
   * whole subtree, preserving every carrying prompt (category-delete.md). The
   * market slice travels as query params (`geoTargetId`, `languageCode`) since
   * a DELETE has no body. Dispatches by workspace mode, mirroring updateTag.
   */
  const deleteTag = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      const { tagId } = ctx?.params || {};
      if (!hasText(tagId)) {
        throw new ErrorWithStatusCode('Missing tagId', 400);
      }
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const ifMatch = headerValue(ctx?.pathInfo?.headers, 'if-match');
      if (auth.mode === 'subworkspace') {
        await handleDeleteTagSubworkspace(
          transport,
          /** @type {string} */ (auth.workspaceId),
          tagId,
          parsedQuery(ctx),
          log,
          ifMatch,
        );
      } else {
        await handleDeleteTag(
          transport,
          ctx.dataAccess,
          /** @type {string} */ (auth.brandUuid),
          /** @type {string} */ (auth.workspaceId),
          tagId,
          parsedQuery(ctx),
          log,
          ifMatch,
        );
      }
      return noContent();
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  const getTagImpact = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      const { tagId } = ctx?.params || {};
      if (!hasText(tagId)) {
        throw new ErrorWithStatusCode('Missing tagId', 400);
      }
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = auth.mode === 'subworkspace'
        ? await handleTagImpactSubworkspace(
          transport,
          /** @type {string} */ (auth.workspaceId),
          tagId,
          parsedQuery(ctx),
          log,
        )
        : await handleTagImpact(
          transport,
          ctx.dataAccess,
          /** @type {string} */ (auth.brandUuid),
          /** @type {string} */ (auth.workspaceId),
          tagId,
          parsedQuery(ctx),
          log,
        );
      return createResponse(result.body, result.status, { ETag: result.body.revision });
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  const listModels = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
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
      return mapError(e, log, reqCtxOf(ctx, auth));
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
      // Org-level route: no authorize()/workspace resolution here.
      return mapError(e, log, reqCtxOf(ctx));
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
      const result = await listLanguageCatalog(transport, log);
      return createResponse(result, 200);
    } catch (e) {
      // Org-level route: no authorize()/workspace resolution here.
      return mapError(e, log, reqCtxOf(ctx));
    }
  };

  const updateModels = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const result = auth.mode === 'subworkspace'
        ? await handleUpdateModelsSubworkspace(
          transport,
          /** @type {string} */ (auth.workspaceId),
          ctx.data || {},
          log,
          {
            env: ctx.env || env,
            orgId: ctx?.params?.spaceCatId,
            brandId: auth.brandUuid,
          },
        )
        : await handleUpdateModels(
          transport,
          ctx.dataAccess,
          auth.brandUuid,
          /** @type {string} */ (auth.workspaceId),
          ctx.data || {},
          log,
          { orgId: ctx?.params?.spaceCatId, env: ctx.env || env },
        );
      return createResponse(result, 200);
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
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
    let auth;
    try {
      // Shared write-budget deadline, computed once at request entry so intent
      // classification during per-market topic/prompt generation budgets against
      // the true request start rather than per-market function entry
      // (serenity-docs#32).
      const writeDeadline = computeWriteDeadline();
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
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
      // SITES-49448: brands.pending_semrush_provisioning (the wizard's "Save as
      // pending" stash) is retired — markets, primary URL, and generatePrompts
      // come from the request body only. A reactivation re-supplies them.
      // Whether to generate topics/prompts for the provisioned project(s);
      // default false preserves the historical activate behavior (projects
      // published without generated prompts).
      const generatePrompts = body.generatePrompts === true;
      const wasPending = brand.getStatus?.() === 'pending';
      // The Semrush project domain: the request's brandDomain.
      // SITES-49448 retired the pending_semrush_provisioning stash, so brandDomain
      // now comes from the request body only (no stashed-URL fallback).
      const { brandDomain } = body;
      const suppliedUrlOrDomain = hasText(brandDomain);

      // ----- Pending-brand activation is ALWAYS sub-workspace-only (LLMO-6405) -----
      // Markets are Semrush projects added afterwards from the Markets tab, never
      // auto-created at activation — so a pending brand activates to just its
      // sub-workspace (the anchor, persisted by ensureSubworkspace) plus a status
      // flip. The brand's primary site (brands.site_id) was set at create for
      // every brand created after LLMO-6405 — but SITES-49449 tightened
      // chk_active_brand_has_site_id to require site_id unconditionally, so a
      // legacy pre-LLMO-6405 pending brand with none would otherwise provision a
      // live sub-workspace upstream and THEN fail the active-flip write with a
      // raw DB constraint violation. Guard it upfront instead of wasting that
      // provisioning call, mirroring the flat-brand activate handler's own guard
      // (brands.js) for the same legacy-drain scenario.
      // Reactivation of an already ACTIVE brand (body-driven markets) is handled
      // by the branches below.
      if (wasPending) {
        const existingSiteId = await getBrandBaseSiteId(
          /** @type {string} */ (ctx?.params?.spaceCatId),
          brandUuid,
          ctx.dataAccess.services.postgrestClient,
        );
        if (!existingSiteId) {
          throw new ErrorWithStatusCode(`Brand has no onboarded primary site: ${brandUuid}`, 400);
        }
        // Phase 4 (LLMO-7352/LLMO-7418): opt-in only (mirrors this endpoint's own
        // project-activation branch below, and createMarket's/createBrandForOrg's `async` flag).
        // Absent/false runs the EXACT synchronous pending->active flip this branch has always
        // run. `async: true` hands the sub-workspace-ensure + status flip off to the
        // `provision-workspace-job` ->
        // `serenity-activate-brand-workspace` job chain instead.
        if (validateAsync(body)) {
          // LLMO-7418 external-review Finding 9: see createMarket's async branch for the full
          // rationale — reconcile a stale in-flight attempt (reusing the sync guard's own logic)
          // before minting a new one, since beginProvisioningAttempt's own CAS has no staleness
          // awareness on its own.
          await guardAgainstConcurrentProvisioning(
            brandUuid,
            ctx.dataAccess.services.postgrestClient,
            log,
          );
          const attemptId = randomUUID();
          const began = await beginProvisioningAttempt({
            brandId: brandUuid,
            attemptId,
            postgrestClient: ctx.dataAccess.services.postgrestClient,
            updatedBy: 'serenity-activate',
          });
          if (!began) {
            const err = new ErrorWithStatusCode(
              'A Semrush sub-workspace provisioning attempt is already in progress for this '
              + 'brand; please retry shortly.',
              409,
            );
            err.code = 'semrush_provisioning_in_progress';
            throw err;
          }
          const job = await createAndEnqueueJob(ctx, {
            jobType: PROVISION_WORKSPACE_JOB_TYPE,
            metadata: {
              brandId: brandUuid,
              attemptId,
              parentWorkspaceId: auth.parentWorkspaceId ?? '',
              // LLMO-7418 external-review Finding 4: this branch's brand is GUARANTEED
              // pointer-less (a pending brand never has a workspace pointer), so the worker
              // ALWAYS takes the create-or-adopt path here, never the existing-pointer fast
              // path — omitting `title` would call Semrush with an untitled sub-workspace on
              // every single pending->active async activation.
              title: brand.getName?.() ?? '',
              chainedJobType: ACTIVATE_BRAND_WORKSPACE_JOB_TYPE,
              chainedJobMetadata: { brandId: brandUuid, wasPending: true },
            },
          });
          // LLMO-7418 external-review Finding 17: records the first-hop job id, best-effort,
          // so it isn't left permanently NULL until the worker's own self-requeue hop writes it.
          await updateProvisioningJobId({
            brandId: brandUuid,
            attemptId,
            jobId: job.getId(),
            postgrestClient: ctx.dataAccess.services.postgrestClient,
          }).catch((updateError) => {
            log.error('activate: failed to record the first-hop job id (best-effort)', {
              brandId: brandUuid, attemptId, jobId: job.getId(), error: updateError?.message,
            });
          });
          return accepted({ jobId: job.getId(), status: job.getStatus() });
        }
        // PR-C guard (LLMO-7352/LLMO-7418): this branch stays synchronous, but a market-creating
        // endpoint may have an async provisioning attempt in flight for this SAME brand — without
        // this check, ensureSubworkspace below could independently create a second workspace.
        await guardAgainstConcurrentProvisioning(
          brandUuid,
          ctx.dataAccess.services.postgrestClient,
          log,
        );
        const pendingWorkspaceId = await ensureSubworkspace(
          transport,
          brand,
          auth.parentWorkspaceId ?? '',
          log,
          {},
          brandPointerReloader(ctx, auth.brandUuid),
          {
            // createReadiness 'skip' (LLMO-6569): pending→active is sub-workspace-only — no project
            // or prompts are created here — so skip the up-to-30s settle poll. This is the path
            // where a poll timeout otherwise leaves the brand row present but its sub-workspace
            // pointer unwritten (the "created upstream, never linked" orphan); persisting the
            // pointer immediately closes that window. Self-heals on retry, but the user ate a 504.
            createReadiness: 'skip',
            brandCollection: ctx?.dataAccess?.Brand,
          },
        );
        let pendingActivateSucceeded = true;
        if (typeof brand.setStatus === 'function') {
          brand.setStatus('active');
        }
        try {
          await brand.save();
        } catch (saveError) {
          pendingActivateSucceeded = false;
          log.error('serenity activate: SERENITY_ACTIVATE_SAVE_DIVERGENCE — sub-workspace ensured upstream but failed to persist active status', {
            brandId: auth.brandUuid,
            semrushWorkspaceId: pendingWorkspaceId,
            error: saveError?.message,
          });
        }
        log.info('serenity activate: completed (pending → active, sub-workspace only)', {
          brandId: auth.brandUuid,
          semrushWorkspaceId: pendingWorkspaceId,
          fullySucceeded: pendingActivateSucceeded,
        });
        if (pendingActivateSucceeded) {
          return createResponse(
            { brandId: auth.brandUuid, status: 'active', markets: [] },
            200,
          );
        }
        // Sub-workspace ensured upstream but the active flip did not persist — the
        // brand stays pending; a retry converges (the sub-workspace 409s idempotently).
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

      // ----- Sub-workspace-only activation (no primary URL → no project) -----
      // Reactivation of an already-ACTIVE brand with no primary URL — a no-op flip.
      // (A pending brand never reaches here; it returned above.) Ensure its
      // sub-workspace and re-affirm active.
      if (!hasText(brandDomain)) {
        // A URL/domain WAS supplied but did not resolve to a hostname → bad input.
        // Fail fast (a silent fallback would mask the typo).
        if (suppliedUrlOrDomain) {
          throw new ErrorWithStatusCode('brandDomain is required to provision a Semrush market', 400);
        }
        if (generatePrompts) {
          throw new ErrorWithStatusCode('A primary URL is required to generate prompts', 400);
        }
        // Phase 4 (LLMO-7352/LLMO-7418): opt-in only — see the wasPending branch above for the
        // full rationale. `wasPending: false` in the chained metadata distinguishes this
        // already-active no-op re-affirm from a real pending->active transition, so
        // activate-brand-workspace-job.js's save-divergence handling matches this branch's own
        // 207-not-502 contract.
        if (validateAsync(body)) {
          // LLMO-7418 external-review Finding 9: see createMarket's async branch (and the
          // wasPending branch above) for the full rationale.
          await guardAgainstConcurrentProvisioning(
            brandUuid,
            ctx.dataAccess.services.postgrestClient,
            log,
          );
          const attemptId = randomUUID();
          const began = await beginProvisioningAttempt({
            brandId: brandUuid,
            attemptId,
            postgrestClient: ctx.dataAccess.services.postgrestClient,
            updatedBy: 'serenity-activate',
          });
          if (!began) {
            const err = new ErrorWithStatusCode(
              'A Semrush sub-workspace provisioning attempt is already in progress for this '
              + 'brand; please retry shortly.',
              409,
            );
            err.code = 'semrush_provisioning_in_progress';
            throw err;
          }
          const job = await createAndEnqueueJob(ctx, {
            jobType: PROVISION_WORKSPACE_JOB_TYPE,
            metadata: {
              brandId: brandUuid,
              attemptId,
              parentWorkspaceId: auth.parentWorkspaceId ?? '',
              // LLMO-7418 external-review Finding 4: see the wasPending branch above — an
              // already-active brand isn't as reliably pointer-less as a pending one, but the
              // SYNCHRONOUS twin of this exact branch still defensively calls the general-purpose
              // `ensureSubworkspace` (create-or-existing), so the async path must be able to
              // create with a real title too, not assume the existing-pointer fast path always
              // applies.
              title: brand.getName?.() ?? '',
              chainedJobType: ACTIVATE_BRAND_WORKSPACE_JOB_TYPE,
              chainedJobMetadata: { brandId: brandUuid, wasPending: false },
            },
          });
          // LLMO-7418 external-review Finding 17: records the first-hop job id, best-effort,
          // so it isn't left permanently NULL until the worker's own self-requeue hop writes it.
          await updateProvisioningJobId({
            brandId: brandUuid,
            attemptId,
            jobId: job.getId(),
            postgrestClient: ctx.dataAccess.services.postgrestClient,
          }).catch((updateError) => {
            log.error('activate: failed to record the first-hop job id (best-effort)', {
              brandId: brandUuid, attemptId, jobId: job.getId(), error: updateError?.message,
            });
          });
          return accepted({ jobId: job.getId(), status: job.getStatus() });
        }
        // PR-C guard (LLMO-7352/LLMO-7418): see the wasPending branch above for rationale.
        await guardAgainstConcurrentProvisioning(
          brandUuid,
          ctx.dataAccess.services.postgrestClient,
          log,
        );
        const bareWorkspaceId = await ensureSubworkspace(
          transport,
          brand,
          auth.parentWorkspaceId ?? '',
          log,
          {},
          brandPointerReloader(ctx, auth.brandUuid),
          {
            // createReadiness 'skip' (LLMO-6569): bare reactivation of an already-active brand is
            // sub-workspace-only (no project/prompts), so skip the settle poll — same safety and
            // orphan-window rationale as the pending→active branch above.
            createReadiness: 'skip',
            brandCollection: ctx?.dataAccess?.Brand,
          },
        );
        let bareSucceeded = true;
        if (typeof brand.setStatus === 'function') {
          brand.setStatus('active');
        }
        try {
          await brand.save();
        } catch (saveError) {
          // An already-active brand's re-flip failed transiently; it stays active
          // (the flip was a no-op anyway). Log and return 207.
          bareSucceeded = false;
          log.error('serenity activate: SERENITY_ACTIVATE_SAVE_DIVERGENCE — sub-workspace ensured upstream but failed to persist active status', {
            brandId: auth.brandUuid,
            semrushWorkspaceId: bareWorkspaceId,
            error: saveError?.message,
          });
        }
        log.info('serenity activate: completed (sub-workspace only, active reactivation)', {
          brandId: auth.brandUuid,
          semrushWorkspaceId: bareWorkspaceId,
          fullySucceeded: bareSucceeded,
        });
        return createResponse(
          { brandId: auth.brandUuid, status: 'active', markets: [] },
          bareSucceeded ? 200 : 207,
        );
      }

      // ----- Project activation (primary URL present) -----
      // Markets come from the body (reactivation). A URL with no market supplied
      // provisions a single US/EN fallback project — the same default
      // brand-provisioning.js applies on the direct-create path. Validated HERE (before
      // either branch) so a caller gets an immediate 400 rather than a 202 whose async job
      // fails later — orchestrateActivateMarkets re-derives/re-checks the same thing for the
      // synchronous caller, which is harmless duplication of pure derivation logic.
      const requestedMarkets = Array.isArray(body.markets) ? body.markets : [];
      const markets = requestedMarkets.length > 0
        ? requestedMarkets
        : [{ market: 'US', languageCode: 'en' }];
      if (markets.length > MAX_MARKETS) {
        throw new ErrorWithStatusCode(`markets must not exceed ${MAX_MARKETS} entries`, 400);
      }
      // PR-C (LLMO-7352/LLMO-7418): opt-in only (mirrors createMarket's/createBrandForOrg's own
      // `async` flag, `validateAsync`). Absent/false runs the EXACT synchronous batch this
      // endpoint has always run — no behavior change for any caller that doesn't opt in.
      // `async: true` mints a provisioning attempt and hands the whole batch off to the
      // `provision-workspace-job` -> `serenity-activate-markets` job chain instead. Unlike
      // `createPrompts`'s flag, this one is NOT permanent: the synchronous branch is the
      // LLMO-7352 bug pattern itself (this is one of the 3 real conversion candidates — the
      // in-request settle-poll + project-create/publish sequence), slated for removal once every
      // known caller has migrated to `async: true`.
      if (validateAsync(body)) {
        // LLMO-7418 external-review Finding 9: see the createMarket async branch above for the
        // full rationale — reconcile a stale in-flight attempt before minting a new one, since
        // beginProvisioningAttempt's own CAS has no staleness awareness.
        await guardAgainstConcurrentProvisioning(
          brandUuid,
          ctx.dataAccess.services.postgrestClient,
          log,
        );
        const attemptId = randomUUID();
        const began = await beginProvisioningAttempt({
          brandId: brandUuid,
          attemptId,
          postgrestClient: ctx.dataAccess.services.postgrestClient,
          updatedBy: 'serenity-activate',
        });
        if (!began) {
          const err = new ErrorWithStatusCode(
            'A Semrush sub-workspace provisioning attempt is already in progress for this '
            + 'brand; please retry shortly.',
            409,
          );
          err.code = 'semrush_provisioning_in_progress';
          throw err;
        }
        const job = await createAndEnqueueJob(ctx, {
          jobType: PROVISION_WORKSPACE_JOB_TYPE,
          metadata: {
            brandId: brandUuid,
            attemptId,
            // LLMO-7418 external-review Finding N2: an active flat-mode brand (authorize admits
            // one that has an org workspace) reaches this branch with no sub-workspace pointer, so
            // the worker takes its create-or-adopt path — which fail-fasts without a title. Supply
            // the brand's name (the sub-workspace title convention) so that path yields a titled,
            // adoptable workspace instead of a hard error.
            title: brand.getName?.() ?? '',
            parentWorkspaceId: auth.parentWorkspaceId ?? '',
            chainedJobType: ACTIVATE_MARKETS_JOB_TYPE,
            chainedJobMetadata: {
              brandId: brandUuid,
              parentWorkspaceId: auth.parentWorkspaceId ?? '',
              orgId: ctx?.params?.spaceCatId,
              requestBody: body,
              callerId: resolveCallerId(ctx),
            },
          },
        });
        // LLMO-7418 external-review Finding 17: see createMarket's async branch above for the
        // full rationale. Best-effort — never turns an already-enqueued job into a client error.
        await updateProvisioningJobId({
          brandId: brandUuid,
          attemptId,
          jobId: job.getId(),
          postgrestClient: ctx.dataAccess.services.postgrestClient,
        }).catch((updateError) => {
          log.error('activate: failed to record the first-hop job id (best-effort)', {
            brandId: brandUuid, attemptId, jobId: job.getId(), error: updateError?.message,
          });
        });
        return accepted({ jobId: job.getId(), status: job.getStatus() });
      }
      // PR-C guard (LLMO-7352/LLMO-7418): this branch stays synchronous by default, but a
      // market-creating call for this SAME brand may have an async provisioning attempt in
      // flight (from this very endpoint's own `async: true` twin, or from createMarket/
      // createBrandForOrg) — without this check, ensureSubworkspace below could independently
      // create a second workspace. See the wasPending/bare-reactivation branches above for the
      // identical rationale.
      await guardAgainstConcurrentProvisioning(
        brandUuid,
        ctx.dataAccess.services.postgrestClient,
        log,
      );
      const result = await orchestrateActivateMarkets({
        dataAccess: ctx.dataAccess,
        env: ctx.env,
        orgId: ctx?.params?.spaceCatId,
        transport,
        brandUuid,
        parentWorkspaceId: auth.parentWorkspaceId ?? '',
        requestBody: body,
        log,
        writeDeadline,
        reloadPointer: brandPointerReloader(ctx, auth.brandUuid),
        callerId: resolveCallerId(ctx),
      });
      return createResponse(result.body, result.status);
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  /**
   * POST /serenity/deactivate — decommissions the brand's sub-workspace
   * (design flow 6): delete every project, then DISCONNECT the brand by clearing its
   * semrush_sub_workspace_id pointer. The sub-workspace itself is never deleted — production never
   * deletes a sub-workspace (upstream deprovisioning is Semrush CS's act) — it is left empty and
   * unowned. There is no allocation to reclaim: a sub-workspace is created without a `resources`
   * payload and nothing ever transfers units onto it (see docs/serenity.md).
   * Clearing the pointer flips the brand back to flat mode, so a future
   * activate allocates a fresh sub-workspace. Sets brands.status = 'pending'.
   * No-op decommission (still 200) for a brand with no sub-workspace.
   */
  const deactivate = async (ctx) => {
    let auth;
    try {
      const imsToken = await resolveSemrushImsToken(ctx);
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const transport = buildTransport(ctx, imsToken);
      const brand = await loadBrand(ctx, auth.brandUuid);
      // LLMO-7418 external-review Finding 3 / N6: cancel any in-flight async provisioning attempt
      // FIRST — before decommission, the pointer clear, and the status write. Once cancel sets
      // semrush_provisioning_status='failed', a worker hop still mid-flight can no longer win its
      // promoteProvisioningReady CAS (which requires status='pending'), so it cannot flip the
      // brand back to 'active' and re-bind a workspace. Running it first (rather than last) both
      // closes that race window and guarantees it still runs when the pointer/status save below
      // throws. Best-effort: a failure here must never fail the deactivate itself.
      try {
        await cancelProvisioningAttempt({
          brandId: /** @type {string} */ (auth.brandUuid),
          postgrestClient: ctx.dataAccess.services.postgrestClient,
        });
      } catch (cancelError) {
        log.error('serenity deactivate: failed to cancel an in-flight provisioning attempt (best-effort)', {
          brandId: auth.brandUuid,
          error: cancelError?.message,
        });
      }
      // LLMO-7418 external-review (adversarial): `brand` was loaded BEFORE the cancel above, so
      // its in-memory pointer is a pre-cancel snapshot. A worker hop whose promoteProvisioningReady
      // committed in the loadBrand→cancel window has since written a canonical pointer this object
      // cannot see — and acting on the stale `null` would skip decommission entirely, leaving that
      // workspace live (and its projects intact) behind a "successful" deactivate. Re-read the
      // pointer after the cancel and prefer the fresh value; fall back to the snapshot when the
      // reloader cannot read (best-effort by contract: it returns null on missing data-access).
      const snapshotSubworkspaceId = brand.getSemrushSubWorkspaceId?.();
      const freshSubworkspaceId = await brandPointerReloader(ctx, auth.brandUuid)();
      const subworkspaceId = hasText(freshSubworkspaceId)
        ? freshSubworkspaceId
        : snapshotSubworkspaceId;
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
        // Disconnect the brand from the now-emptied, floor-lowered sub-workspace (never
        // deleted); clearing the pointer is what returns the brand to flat mode.
        // Invalidate the resolver cache HERE —
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
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/prompts/jobs/:jobId (legacy path) and
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/jobs/:jobId (PR-C, LLMO-7352/LLMO-7418) —
   * both routed to this SAME handler. Despite the historical name/path, this is job-type-agnostic:
   * it never inspects the job's `type`, only its `brandId`, so it already polls
   * serenity-classify-prompts jobs (serenity-docs#33 Layer 1, the companion to createPrompts'
   * 202 CSV-import path) equally well as the newer serenity-provision-workspace/
   * serenity-create-market/serenity-activate-markets chain jobs (PR-C's `async: true` opt-in on
   * createMarket/createBrandForOrg/activate). The `/serenity/jobs/:jobId` alias exists so a
   * caller of one of those newer async paths isn't stuck polling a URL that says "prompts". No
   * upstream Semrush call, so no IMS token is resolved here; access control reuses `authorize`
   * (same org/brand access + serenity-active gate as every other serenity handler).
   *
   * Returns a STABLE, secret-free contract — exactly `{ jobId, status, result,
   * error }`, camelCase, which the polling UI is built against. `status` is the
   * AsyncJob state (IN_PROGRESS | COMPLETED | FAILED); `result` is
   * `job.getResult()` (present when COMPLETED); `error` is `job.getError()`
   * (present when FAILED, `{ code, message }`). The job's metadata (which carries
   * the promise token and other internals) is NEVER returned.
   *
   * Ownership guard: a job whose metadata `brandId` does not match the addressed
   * brand 404s exactly like a missing job — a caller must not be able to probe or
   * read another brand's jobs by id.
   */
  const getPromptsJobStatus = async (ctx) => {
    let auth;
    try {
      auth = await authorize(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { jobId } = ctx?.params || {};
      if (!isValidUUID(jobId)) {
        return createResponse(
          { error: 'invalidRequest', message: 'jobId must be a UUID' },
          400,
        );
      }
      const AsyncJob = ctx?.dataAccess?.AsyncJob;
      if (!AsyncJob || typeof AsyncJob.findById !== 'function') {
        return internalServerError('AsyncJob data-access not available');
      }
      let job = await AsyncJob.findById(jobId);
      // A job that does not exist AND a job that belongs to another brand answer
      // the same 404: whether the id is unknown or simply not yours is not the
      // caller's business (mirrors authorize's brand-not-found contract).
      const jobBrandId = job?.getMetadata?.()?.brandId;
      if (!job || jobBrandId !== auth.brandUuid) {
        return notFound(`Job not found: ${jobId}`);
      }
      const metadata = job.getMetadata?.() ?? {};
      // This single handler polls TWO unrelated job families that happen to share the async-job
      // infrastructure: the pre-existing prompt-classification / bulk-tags / tag-impact jobs, and
      // the provisioning jobs this stack added (PROVISION_WORKSPACE_JOB_TYPE + its chained
      // market-create / activate hops). The chain-follow and the type label below must key off
      // which family this job belongs to, or one family's behavior silently bleeds onto the other
      // (LLMO-7418 external-review N4/N5).
      const isProvisioningJob = metadata.jobType === PROVISION_WORKSPACE_JOB_TYPE;
      // Follow a chain/requeue to its EFFECTIVE terminal hop (LLMO-7418 external-review
      // Finding 8): the runner marks the ORIGINAL job COMPLETED on any non-throwing handler
      // return, including a self-requeue (`{ requeuedJobId }`, workspace not yet settled) or a
      // chain hand-off (`{ provisioningStatus: 'ready', chainedJobId }`, the chained market-
      // create/activate work not yet started) — neither means the real work actually finished.
      // Without this, a caller polling the FIRST hop's id sees a premature COMPLETED the moment
      // the chain merely starts, not when it actually ends. `jobId`/`jobType` below still report
      // the ORIGINALLY-requested job's identity — only status/result/error follow the chain, so a
      // caller polling a fixed URL never needs to learn about intermediate hop ids. Bounded to
      // guard against a corrupt/cyclic chain; a dangling pointer (an id the chain names but that
      // no longer resolves) simply stops following and reports the last hop actually found.
      //
      // N5: this is SCOPED to provisioning jobs. classifyPrompts jobs ALSO self-requeue and
      // return `requeuedJobId`, but their shipped polling contract (before this stack) returned
      // the FIRST hop's result — following their chain here would silently change what a live
      // CSV-import consumer reads (hop-0 `{created,skipped,...}` vs a later reclassify hop's
      // `{patched,...}`). Restore that contract by never following a non-provisioning chain; if
      // the classify owners want terminal-hop following, that is theirs to opt into deliberately.
      const MAX_CHAIN_FOLLOW_HOPS = 10;
      for (let hops = 0; isProvisioningJob && job.getStatus() === 'COMPLETED' && hops < MAX_CHAIN_FOLLOW_HOPS; hops += 1) {
        const hopResult = job.getResult?.();
        const nextJobId = hopResult?.chainedJobId || hopResult?.requeuedJobId;
        if (!nextJobId) {
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        const nextJob = await AsyncJob.findById(nextJobId);
        if (!nextJob) {
          break;
        }
        job = nextJob;
      }
      /** @type {'classifyPrompts' | 'bulkTags' | 'tagImpact' | 'provisionWorkspace'} */
      let publicJobType = 'classifyPrompts';
      if (isProvisioningJob) {
        // N4: a provisioning job must report its real family, not the classifyPrompts default —
        // the async markets/activate/create clients (and the LLMO-7419 UI) branch on this.
        publicJobType = 'provisionWorkspace';
      } else if (metadata.jobType === BULK_TAGS_JOB_TYPE) {
        publicJobType = BULK_TAGS_PUBLIC_JOB_TYPE;
      } else if (metadata.jobType === 'serenity-tag-impact') {
        publicJobType = 'tagImpact';
      }
      const query = parsedQuery(ctx);
      const failureLimit = typeof query.failureLimit === 'number'
        ? query.failureLimit
        : undefined;
      const status = job.getStatus();
      const rawResult = status === 'COMPLETED' ? job.getResult?.() ?? null : null;
      const result = publicJobType === BULK_TAGS_PUBLIC_JOB_TYPE && rawResult
        ? pageBulkFailures(
          rawResult,
          typeof query.failureCursor === 'string' ? query.failureCursor : undefined,
          failureLimit,
        )
        : rawResult;
      const error = status === 'FAILED' ? publicJobError(job.getError?.()) : null;
      return createResponse(
        {
          // The ORIGINALLY-requested id, never a followed hop's — the caller polls a fixed URL
          // and never needs to learn about intermediate chain/requeue job ids.
          jobId,
          jobType: publicJobType,
          status,
          result,
          error,
        },
        200,
      );
    } catch (e) {
      return mapError(e, log, reqCtxOf(ctx, auth));
    }
  };

  return {
    listPrompts,
    createPrompts,
    getPromptsJobStatus,
    updatePrompt,
    bulkTagPrompts,
    bulkDeletePrompts,
    listMarkets,
    getMarket,
    createMarket,
    deleteMarket,
    listTags,
    createTag,
    updateTag,
    getTagImpact,
    deleteTag,
    listModels,
    listOrgModels,
    listOrgLanguages,
    updateModels,
    activate,
    deactivate,
  };
}

export default SerenityController;
