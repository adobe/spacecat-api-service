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

import {
  listBrands as listSpacecatBrands, getBrandById, getBrandBySite,
} from '../support/brands-storage.js';
import { createElementsTransport } from '../support/elements/elements-transport.js';
import { ElementsTransportError } from '../support/elements/errors.js';
import { createElementsService } from '../support/elements/elements-service.js';
import { resolveWorkspaceId, resolveBrandWorkspace } from '../support/serenity/workspace-resolver.js';
import AccessControlUtil from '../support/access-control-util.js';
import { ErrorWithStatusCode } from '../support/utils.js';

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
 */
function requireImsBearer(ctx) {
  const authInfo = ctx?.attributes?.authInfo;
  if (authInfo?.getType && authInfo.getType() !== 'ims') {
    throw new ErrorWithStatusCode('Elements proxy requires IMS authentication', 401);
  }
  const header = ctx?.pathInfo?.headers?.authorization;
  if (!hasText(header) || !header.startsWith(BEARER_PREFIX)) {
    throw new ErrorWithStatusCode('Missing or invalid Authorization header', 401);
  }
  return header.substring(BEARER_PREFIX.length);
}

/**
 * Controller for Semrush Elements API wrapper endpoints.
 * The `all` path segment scopes to the org's own workspace ID; a real `:brandId`
 * scopes to that brand's Semrush sub-workspace ID (see `authorizeOrg`).
 *
 * @param {object} context - Request context.
 * @param {object} log - Logger.
 * @param {object} env - Environment variables.
 */
/**
 * Validates org access and resolves the Semrush workspace ID.
 *
 * When the route carries a `:brandId` other than the `all` sentinel, the
 * result is brand-scoped: `workspaceId` is the brand's Semrush sub-workspace
 * ID (falling back to the org's parent workspace when the brand hasn't been
 * provisioned one yet, per `resolveBrandWorkspace`'s dual-mode resolution),
 * and `brand` is the resolved brand record. Otherwise behaves as before,
 * scoped to the org's own workspace.
 *
 * Returns `{ workspaceId, brand? }` on success or `{ error: Response }` on failure.
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

  const isBrandScoped = hasText(brandIdParam) && brandIdParam !== 'all';
  if (isBrandScoped) {
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

  const workspaceId = await resolveWorkspaceId(ctx, spaceCatId);
  if (!hasText(workspaceId)) {
    return { error: notFound('Organization has no semrush_workspace_id') };
  }
  return { workspaceId };
}

export default function ElementsController(context, log, env) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }
  if (!log) {
    throw new Error('Log required');
  }

  function buildService(ctx) {
    const imsToken = requireImsBearer(ctx);
    return createElementsService(createElementsTransport({ env, imsToken }));
  }

  /**
   * GET /v2/orgs/:spaceCatId/serenity/all/brand-presence/url-inspector/filter-dimensions
   * GET /v2/orgs/:spaceCatId/serenity/:brandId/brand-presence/url-inspector/filter-dimensions
   * Returns filter dimensions for the URL Inspector dashboard
   * (brands, regions, topics, categories, page_intents, origins).
   * With a real `:brandId`, scoped to that single brand instead of every org brand.
   */
  const listUrlInspectorFilterDimensions = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { spaceCatId } = ctx?.params ?? {};
      const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};

      const spacecatBrands = auth.brand
        ? [auth.brand]
        : await listSpacecatBrands(spaceCatId, postgrestClient);

      const brandSemrushProjects = await fetchBrandSemrushProjects(
        BrandSemrushProject,
        spacecatBrands,
      );

      const result = await buildService(ctx).getUrlInspectorFilterDimensions(
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
   * GET /v2/orgs/:spaceCatId/serenity/all/brand-presence/weeks
   * GET /v2/orgs/:spaceCatId/serenity/:brandId/brand-presence/weeks
   * Returns the list of weeks that have Brand Presence data (week filter dropdown).
   * With a real `:brandId`, scoped to that brand (an unrelated siteId filter is rejected).
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
      let brand;

      if (auth.brand) {
        // Brand-scoped route: the path already names the brand. A siteId query
        // param is only honored when it actually belongs to that brand — this
        // catches a caller mixing a brand-scoped path with a stale/mismatched
        // siteId filter from a different brand.
        brand = auth.brand.name;
        if (hasText(siteId)) {
          const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
          const resolved = await getBrandBySite(spaceCatId, siteId, postgrestClient, log);
          if (!resolved || resolved.id !== auth.brand.id) {
            return badRequest('siteId does not belong to the specified brand');
          }
        }
      } else if (hasText(siteId)) {
        // The URL Inspector filter sends a siteId, which Semrush has no concept of.
        // Reverse-map it to the site's primary brand (brands.site_id) and scope the
        // weeks to that brand. Omitted siteId → workspace-wide weeks.
        const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
        const resolved = await getBrandBySite(spaceCatId, siteId, postgrestClient, log);
        if (!resolved) {
          return notFound(`No brand found for site: ${siteId}`);
        }
        brand = resolved.name;
      }

      const result = await buildService(ctx).getWeeks(auth.workspaceId, { ...query, brand });
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
