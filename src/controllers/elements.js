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
import { hasText, isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';

import { listBrands as listSpacecatBrands, getBrandBySite } from '../support/brands-storage.js';
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
 * Org-scoped handlers use the org's workspace ID; brand-scoped handlers (Phase 2)
 * will use the brand's subworkspace ID.
 *
 * @param {object} context - Request context.
 * @param {object} log - Logger.
 * @param {object} env - Environment variables.
 */
/**
 * Validates org access and resolves the Semrush workspace ID.
 * Returns `{ workspaceId }` on success or `{ error: Response }` on failure.
 */
async function authorizeOrg(ctx) {
  const spaceCatId = ctx?.params?.spaceCatId;
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
   * Returns filter dimensions for the URL Inspector dashboard
   * (brands, regions, topics, categories, page_intents, origins).
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

      const spacecatBrands = await listSpacecatBrands(spaceCatId, postgrestClient);

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
   * Returns the list of weeks that have Brand Presence data (week filter dropdown).
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

      // The URL Inspector filter sends a siteId, which Semrush has no concept of.
      // Reverse-map it to the site's primary brand (brands.site_id) and scope the
      // weeks to that brand. Omitted siteId → workspace-wide weeks.
      const siteId = query.siteId || query.site_id;
      let brand;
      if (hasText(siteId)) {
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

  /**
   * GET /v2/orgs/:spaceCatId/serenity/all/brand-presence/url-inspector/cited-domains
   * Returns domains most frequently cited alongside owned URLs (Cited Domains panel).
   */
  /* c8 ignore start -- LLMO-6020 POC endpoint; unit tests intentionally deferred */
  const listCitedDomains = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { spaceCatId } = ctx?.params ?? {};
      const query = extractQuery(ctx);
      const service = buildService(ctx);

      // Every Semrush element is scoped by the BRAND's mapped sub-workspace, not the org
      // workspace (LLMO-6029 tracks the same fix for filter-dimensions/weeks). `brandId` is
      // therefore required — it selects the sub-workspace we query. The URL Inspector UI has
      // no brand picker, so it cross-maps its selected site → brandId before calling.
      const { brandId } = query;
      if (!hasText(brandId)) {
        return badRequest('brandId is required for cited-domains');
      }
      // Confirm the brand belongs to this org before resolving its workspace (prevents
      // reading another tenant's sub-workspace). Reused for region resolution below.
      const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
      const orgBrands = await listSpacecatBrands(spaceCatId, postgrestClient);
      if (!orgBrands.some((b) => b.id === brandId)) {
        return notFound(`Brand not found in organization: ${brandId}`);
      }

      // Resolve the brand's Semrush sub-workspace (falls back to the org/parent workspace for
      // flat-mode brands with no sub-workspace minted). This — not authorizeOrg's org
      // workspace — is the workspace every element call below must target.
      const { workspaceId } = await resolveBrandWorkspace(ctx, spaceCatId, brandId);
      if (!hasText(workspaceId)) {
        return notFound('No Semrush workspace resolved for the brand');
      }

      // Region scoping: a Semrush project == one (brand, market). Resolve the UI's region
      // code to that project's id (via the Markets element) and pass it as top-level
      // `project_id`. region=all/absent → all of the brand's markets.
      let projectId;
      const { region } = query;
      if (hasText(region) && region.toLowerCase() !== 'all') {
        const { BrandSemrushProject } = ctx?.dataAccess ?? {};
        const brandSemrushProjects = await fetchBrandSemrushProjects(
          BrandSemrushProject,
          orgBrands,
        );
        projectId = await service.resolveRegionProjectId(workspaceId, {
          brandId, region, brandSemrushProjects,
        });
      }

      // Normalize the aliases the UI may send under either casing/key. `category` (the UI
      // sends it as `categoryId`) is pushed to Semrush as a tag; `channel` is applied
      // client-side as a content-type filter in the transform; `region` is resolved above.
      const params = {
        ...query,
        projectId,
        model: query.model || query.platform,
        startDate: query.startDate || query.start_date,
        endDate: query.endDate || query.end_date,
        category: query.categoryId || query.category,
        channel: query.channel || query.selectedChannel,
      };

      const result = await service.getCitedDomains(workspaceId, params);
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };
  /* c8 ignore stop */

  return {
    listUrlInspectorFilterDimensions,
    listWeeks,
    listCitedDomains,
  };
}
