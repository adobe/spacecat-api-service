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
  badRequest, createResponse, forbidden, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isNonEmptyObject, isValidUUID } from '@adobe/spacecat-shared-utils';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';

import { getBrandById, getBrandBySite } from '../support/brands-storage.js';
import { createElementsTransport } from '../support/elements/elements-transport.js';
import { ElementsTransportError } from '../support/elements/errors.js';
import { createElementsService } from '../support/elements/elements-service.js';
import { resolveBrandWorkspace } from '../support/serenity/workspace-resolver.js';
import AccessControlUtil from '../support/access-control-util.js';
import { ErrorWithStatusCode, resolveSemrushImsToken } from '../support/utils.js';
import { X_PROMISE_TOKEN_HEADER, PROMISE_TOKEN_REQUIRED_ERROR_CODE } from '../utils/constants.js';

const MAX_ERR_MSG_LEN = 500;
const BEARER_PREFIX = 'Bearer ';
// Caps concurrent DB queries / upstream POSTs when fanning out across brands or projects.
const FANOUT_CONCURRENCY = 8;

/**
 * Runs `mapper` over `items` with at most `limit` concurrent invocations,
 * preserving input order in the returned array. Bounds fan-out so a workspace
 * with many brands/projects can't spawn an unbounded number of parallel calls.
 */
async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor;
        cursor += 1;
        // eslint-disable-next-line no-await-in-loop
        out[idx] = await mapper(items[idx], idx);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/**
 * Maps a BrandSemrushProject model instance to the plain object shape the
 * definitions layer expects.
 */
function toPlainProject(p) {
  return {
    brandId: p.getBrandId(),
    semrushProjectId: p.getSemrushProjectId(),
    geoTargetId: p.getGeoTargetId(),
    languageCode: p.getLanguageCode(),
  };
}

/**
 * Fetches all BrandSemrushProject rows for the given brands with bounded
 * concurrency, flattened and mapped to plain objects.
 */
async function fetchBrandSemrushProjects(BrandSemrushProject, brands) {
  if (!BrandSemrushProject) {
    return [];
  }
  const perBrand = await mapWithConcurrency(
    brands,
    FANOUT_CONCURRENCY,
    (b) => BrandSemrushProject.allByBrandId(b.id),
  );
  return perBrand.flat().map(toPlainProject);
}

function safeError(msg) {
  return cleanupHeaderValue(String(msg || '')).slice(0, MAX_ERR_MSG_LEN);
}

function errorTokenForStatus(status) {
  switch (status) {
    case 401: return 'authenticationRequired';
    case 403: return 'forbidden';
    case 404: return 'notFound';
    case 503: return 'configurationError';
    default: return 'invalidRequest';
  }
}

function mapError(e, log) {
  if (e instanceof ErrorWithStatusCode) {
    const status = Number.isInteger(e.status) ? e.status : 400;
    const errorToken = hasText(e.code) ? e.code : errorTokenForStatus(status);
    return createResponse({ error: errorToken, message: safeError(e.message) }, status);
  }
  if (e instanceof ElementsTransportError) {
    log.error('Elements upstream error', e);
    if (e.status === 401 || e.status === 403) {
      return createResponse(
        { error: errorTokenForStatus(e.status), message: 'Upstream authorization failed' },
        e.status,
      );
    }
    return createResponse({ error: 'elementsUpstreamError', message: 'Upstream request failed' }, 502);
  }
  log.error('Elements controller error', e);
  return createResponse({ error: 'internalServerError', message: 'Internal server error' }, 500);
}

/**
 * Extracts query parameters from the request URL as a plain object.
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
    } catch { /* fall through */ }
  }
  return {};
}

/**
 * Extracts and validates the IMS bearer token from the inbound Authorization header.
 * Throws 401 if missing or if the caller authenticated via a non-IMS mechanism.
 *
 * NOTE — this is NOT the only path into the handlers below: `x-promise-token`
 * (see `resolveElementsImsToken`) is a second, always-on way to reach them
 * without passing this function's IMS-type check, by exchanging the promise
 * token for an IMS token instead of forwarding `Authorization` directly.
 */
function requireImsBearer(ctx) {
  const authInfo = ctx?.attributes?.authInfo;
  if (authInfo?.getType && authInfo.getType() !== 'ims') {
    // Reached only when x-promise-token was absent (resolveElementsImsToken
    // checks that header first) — a non-IMS caller has no other way to
    // authenticate to Semrush, so point them at the promise-token flow.
    const err = new ErrorWithStatusCode(
      `Elements proxy requires IMS authentication; send the ${X_PROMISE_TOKEN_HEADER} header instead`,
      401,
    );
    err.code = PROMISE_TOKEN_REQUIRED_ERROR_CODE;
    throw err;
  }
  const header = ctx?.pathInfo?.headers?.authorization;
  if (!hasText(header) || !header.startsWith(BEARER_PREFIX)) {
    throw new ErrorWithStatusCode('Missing or invalid Authorization header', 401);
  }
  return header.substring(BEARER_PREFIX.length);
}

/**
 * Controller for Semrush Elements API wrapper endpoints. Every route is
 * brand-scoped via `:brandId` (see `authorizeOrg`); there is no org-wide
 * "all brands" variant.
 *
 * @param {object} context - Request context.
 * @param {object} log - Logger.
 * @param {object} env - Environment variables.
 */
/**
 * Validates org + brand access and resolves the Semrush workspace ID for
 * `:brandId`. `workspaceId` is the brand's Semrush sub-workspace ID, falling
 * back to the org's parent workspace when the brand hasn't been provisioned
 * one yet (per `resolveBrandWorkspace`'s dual-mode resolution).
 *
 * Returns `{ workspaceId, brand }` on success or `{ error: Response }` on failure.
 */
async function authorizeOrg(ctx) {
  const spaceCatId = ctx?.params?.spaceCatId;
  const brandIdParam = ctx?.params?.brandId;
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

  if (!isValidUUID(brandIdParam)) {
    return { error: badRequest('Brand id must be a valid UUID') };
  }
  const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
  const brand = await getBrandById(spaceCatId, brandIdParam, postgrestClient);
  if (!brand) {
    return { error: forbidden('Brand not found or not accessible for this organization') };
  }
  const { workspaceId } = await resolveBrandWorkspace(ctx, spaceCatId, brandIdParam);
  if (!hasText(workspaceId)) {
    return { error: notFound('Brand has no resolvable Semrush workspace') };
  }
  return { workspaceId, brand };
}

export default function ElementsController(context, log, env) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }
  if (!log) {
    throw new Error('Log required');
  }

  /**
   * Resolves the IMS access token to forward to the Semrush gateway.
   *
   * Preferred path: the caller sends `x-promise-token` (minted by
   * POST /auth/v2/promise). This lets a caller authenticate to spacecat itself
   * with a NON-IMS credential (e.g. a spacecat JWT on `Authorization`) while
   * still supplying an IMS-exchangeable token for the upstream Semrush call.
   * The promise token is checked FIRST and, when present, `requireImsBearer`
   * (and its `authInfo.getType() === 'ims'` gate) is never invoked, since
   * `Authorization` is not expected to carry an IMS token in that case.
   *
   * Fallback path: no `x-promise-token` — behaves exactly as before, requiring
   * IMS-type auth and forwarding the `Authorization: Bearer <ims-token>` as-is.
   *
   * Delegates the promise-token decode/exchange to the shared
   * `resolveSemrushImsToken` helper in support/utils.js (also used by
   * serenity.js and the brand create/edit/provisioning re-sync paths),
   * passing this controller's own `requireImsBearer` as the fallback.
   */
  async function resolveElementsImsToken(ctx) {
    return resolveSemrushImsToken(ctx, log, 'elements', requireImsBearer);
  }

  async function buildService(ctx) {
    const imsToken = await resolveElementsImsToken(ctx);
    return createElementsService(createElementsTransport({ env, imsToken }));
  }

  /**
   * GET /v2/orgs/:spaceCatId/serenity/:brandId/brand-presence/url-inspector/filter-dimensions
   * Returns filter dimensions for the URL Inspector dashboard
   * (brands, regions, topics, categories, page_intents, origins), scoped to
   * that single brand.
   */
  const listUrlInspectorFilterDimensions = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};

      const spacecatBrands = [auth.brand];

      const brandSemrushProjects = await fetchBrandSemrushProjects(
        BrandSemrushProject,
        spacecatBrands,
      );

      const service = await buildService(ctx);
      const result = await service.getUrlInspectorFilterDimensions(
        auth.workspaceId,
        extractQuery(ctx),
        spacecatBrands,
        brandSemrushProjects,
      );
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  /**
   * GET /v2/orgs/:spaceCatId/serenity/:brandId/brand-presence/weeks
   * Returns the list of weeks that have Brand Presence data (week filter
   * dropdown), scoped to that brand. An unrelated siteId filter is rejected.
   */
  /* c8 ignore start -- LLMO-6011 POC endpoint; unit tests intentionally deferred */
  const listWeeks = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { spaceCatId } = ctx?.params ?? {};
      const query = extractQuery(ctx);
      const siteId = query.siteId || query.site_id;

      // The path already names the brand. A siteId query param is only
      // honored when it actually belongs to that brand — this catches a
      // caller mixing a brand-scoped path with a stale/mismatched siteId
      // filter from a different brand.
      if (hasText(siteId)) {
        const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
        const resolved = await getBrandBySite(spaceCatId, siteId, postgrestClient, log);
        if (!resolved || resolved.id !== auth.brand.id) {
          return badRequest('siteId does not belong to the specified brand');
        }
      }

      // The workspace/sub-workspace resolved for :brandId already scopes the
      // WEEKS element to this brand — the CBF_ws_brand name filter is not
      // passed here (buildWeeksPayload still supports it when a caller opts in).
      const service = await buildService(ctx);
      const result = await service.getWeeks(auth.workspaceId, query);
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };
  /* c8 ignore stop */

  return {
    listUrlInspectorFilterDimensions,
    listWeeks,
  };
}
