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

import { getBrandIdentity, getBrandBySite } from '../support/brands-storage.js';
import { resolveBrandUuid } from '../support/prompts-storage.js';
import { createElementsTransport } from '../support/elements/elements-transport.js';
import { ElementsTransportError } from '../support/elements/errors.js';
import { createElementsService } from '../support/elements/elements-service.js';
import { fetchOwnedUrlsTraffic, mergeOwnedUrlsTraffic } from '../support/elements/owned-urls-traffic.js';
import { mapWithConcurrency } from '../support/elements/concurrency.js';
import { addDaysToDate } from '../support/elements/week-utils.js';
import { resolveBrandWorkspace } from '../support/serenity/workspace-resolver.js';
import { cachedOk } from '../support/cached-response.js';
import AccessControlUtil from '../support/access-control-util.js';
import { ErrorWithStatusCode, resolveSemrushImsToken } from '../support/utils.js';
import { X_PROMISE_TOKEN_HEADER, PROMISE_TOKEN_REQUIRED_ERROR_CODE } from '../utils/constants.js';

const MAX_ERR_MSG_LEN = 500;
const BEARER_PREFIX = 'Bearer ';
// Caps concurrent DB queries / upstream POSTs when fanning out across brands or projects.
// mapWithConcurrency itself lives in support/elements/concurrency.js (shared with the service).
const FANOUT_CONCURRENCY = 8;

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
 * True when `value` is a real `YYYY-MM-DD` calendar date. Rejects malformed shapes
 * and impossible dates (e.g. `2026-13-45`) by round-tripping through Date so a bad
 * value never reaches Semrush. (shared-utils `isIsoDate` requires a full datetime,
 * not the date-only form the URL Inspector sends.)
 */
function isYmdDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Default 28-day trailing date range for `/stats`, mirroring
 * `llmo-brand-presence.js#defaultDateRange`, used when the caller omits
 * startDate/endDate. Uses `addDaysToDate` (anchored to T12:00:00Z) rather than
 * `Date#setDate`, which operates in local time before `toISOString()` converts
 * to UTC — avoiding a DST-boundary date-shift bug.
 */
function defaultStatsDateRange() {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = addDaysToDate(endDate, -28);
  return { startDate, endDate };
}

/**
 * Splits a comma-separated query value into a trimmed, non-empty string array.
 * `extractQuery` collapses repeated params (last value wins), so multi-valued
 * filters (topics, project ids) are passed as a single CSV value.
 *
 * @param {string} [value] - Raw query value (e.g. "AI,Commerce").
 * @returns {string[]} Parsed values, or [] when absent/blank.
 */
function splitCsv(value) {
  if (!hasText(value)) {
    return [];
  }
  return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
}

/**
 * True when the `showTrends`/`show_trends` query param requests trend data,
 * mirroring `llmo-brand-presence.js#parseShowTrends`.
 *
 * Exported (unlike this file's other private helpers) because `extractQuery`
 * always yields string values from `URLSearchParams`, so the boolean/number
 * branch below is unreachable through the HTTP query-string path and can only
 * be exercised via a direct unit test.
 */
export function parseShowTrends(q) {
  const v = q?.showTrends ?? q?.show_trends;
  if (v === true || v === 1) {
    return true;
  }
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    return s === 'true' || s === '1';
  }
  return false;
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
 * Resolves the organization and verifies the caller has access to it.
 * Shared pre-flight for the org- and brand-scoped authorizers.
 * Returns `{ organization }` on success or `{ error: Response }` on failure.
 */
async function authorizeOrgAccess(ctx) {
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
  return { organization };
}

/**
 * Validates org + brand access and resolves the Semrush workspace ID for
 * `:brandId`. `workspaceId` is the brand's Semrush sub-workspace ID, falling
 * back to the org's parent workspace when the brand hasn't been provisioned
 * one yet (per `resolveBrandWorkspace`'s dual-mode resolution). `brand` is
 * looked up via {@link getBrandIdentity} (a lightweight `id, name` select) —
 * a missing PostgREST client is reported as 503, not masked as a brand 404.
 *
 * Returns `{ workspaceId, brand }` on success or `{ error: Response }` on failure.
 */
async function authorizeOrg(ctx) {
  const spaceCatId = ctx?.params?.spaceCatId;
  const brandIdParam = ctx?.params?.brandId;
  const access = await authorizeOrgAccess(ctx);
  if (access.error) {
    return access;
  }
  if (!isValidUUID(brandIdParam)) {
    return { error: badRequest('Brand id must be a valid UUID') };
  }
  const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    return { error: createResponse({ error: 'configurationError', message: 'PostgREST client not available' }, 503) };
  }
  const brand = await getBrandIdentity(spaceCatId, brandIdParam, postgrestClient);
  if (!brand) {
    return { error: notFound('Brand not found for this organization') };
  }
  const { workspaceId } = await resolveBrandWorkspace(ctx, spaceCatId, brandIdParam);
  if (!hasText(workspaceId)) {
    return { error: notFound('Brand has no resolvable Semrush workspace') };
  }
  return { workspaceId, brand };
}

/**
 * Validates access and resolves the Semrush **sub-workspace** for a brand.
 *
 * Semrush projects (and therefore prompts) live ONLY in a brand's own
 * sub-workspace — never in the org's shared parent workspace (verified against
 * prod: the same project payload returns data on the sub-workspace and 0 on the
 * parent). So a prompts query must resolve the brand's sub-workspace and refuse
 * to run against an org workspace. This helper enforces exactly that.
 *
 * @param {object} ctx - Request context.
 * @param {object} log - Logger (for the misconfiguration alert).
 * @returns {Promise<{workspaceId: string} | {error: Response}>} the brand's
 *   sub-workspace id on success, or a Response on failure (400 non-UUID brandId,
 *   403 no access, 404 org/brand not found or brand has no sub-workspace,
 *   409 sub-workspace misconfigured as the parent).
 */
async function authorizeBrandSubWorkspace(ctx, log) {
  const spaceCatId = ctx?.params?.spaceCatId;
  const brandId = ctx?.params?.brandId;
  if (!isValidUUID(brandId)) {
    return { error: createResponse({ error: 'invalidRequest', message: 'brandId must be a UUID' }, 400) };
  }
  const access = await authorizeOrgAccess(ctx);
  if (access.error) {
    return access;
  }
  const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    return { error: createResponse({ error: 'configurationError', message: 'PostgREST client not available' }, 503) };
  }
  const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
  if (!brandUuid) {
    return { error: notFound(`Brand not found for organization: ${brandId}`) };
  }
  const { mode, workspaceId, parentWorkspaceId } = await resolveBrandWorkspace(
    ctx,
    spaceCatId,
    brandUuid,
  );
  // Require sub-workspace mode: a flat-mode brand (no semrush_sub_workspace_id)
  // resolves to the org parent workspace, which holds no projects/prompts.
  if (mode !== 'subworkspace') {
    return {
      error: createResponse(
        { error: 'subWorkspaceRequired', message: 'Brand has no Semrush sub-workspace; org workspaces have no projects' },
        404,
      ),
    };
  }
  // Safety invariant (mirrors the serenity controller): a sub-workspace must
  // never coincide with the org parent, or a scoped query would run against the
  // shared parent pool.
  if (workspaceId === parentWorkspaceId) {
    log.error('elements: brand sub-workspace equals org parent workspace - refusing', {
      brandUuid, spaceCatId, workspaceId,
    });
    return {
      error: createResponse(
        { error: 'workspaceMisconfigured', message: 'Brand sub-workspace must not be the organization parent workspace' },
        409,
      ),
    };
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
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence
   *     /url-inspector/filter-dimensions
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
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/weeks
   * Returns the list of weeks that have Brand Presence data (week filter
   * dropdown), scoped to that brand. An unrelated siteId filter is rejected.
   */
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

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/prompts
   * Returns the prompts matching the given filters plus their count
   * (`{ count, prompts }`). Powers the prompt healthcheck metrics (intent %, and
   * — via a topic-filtered count ratio — branded %).
   *
   * Brand-scoped: resolves the brand's Semrush **sub-workspace** (where projects
   * and prompts live) and refuses to run against an org workspace — see
   * {@link authorizeBrandSubWorkspace}.
   *
   * Query params (all optional): `model`/`platform` (AI model, default search-gpt),
   * `tag` (CSV of FULL tag values, AND-ed — e.g. `type__branded`, `category__Brand`),
   * `projectId` (CSV of Semrush project UUIDs; omitted → all of the brand's projects
   * in its sub-workspace).
   */
  const listPrompts = async (ctx) => {
    try {
      const auth = await authorizeBrandSubWorkspace(ctx, log);
      if (auth.error) {
        return auth.error;
      }
      const query = extractQuery(ctx);
      const service = await buildService(ctx);
      const result = await service.getPrompts(auth.workspaceId, {
        model: query.model,
        platform: query.platform,
        tags: splitCsv(query.tag),
        projectIds: splitCsv(query.projectId || query.project_id),
      });
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

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
      // authorizeOrg validated `:brandId`, confirmed the brand belongs to the org, and
      // resolved the brand's Semrush **sub-workspace** — every element is scoped by that
      // workspace, not the org's (LLMO-5990/6029). The URL Inspector UI has no brand picker,
      // so it cross-maps its selected site → brandId before calling.
      const { brandId } = ctx?.params ?? {};
      const { workspaceId, brand } = auth;
      const query = extractQuery(ctx);

      // Date range is required (the UI always sends it) and must be a valid YYYY-MM-DD —
      // fail fast rather than silently defaulting to a rolling window or forwarding a
      // malformed date to Semrush.
      const startDate = query.startDate || query.start_date;
      const endDate = query.endDate || query.end_date;
      if (!hasText(startDate) || !hasText(endDate)) {
        return badRequest('startDate and endDate are required (YYYY-MM-DD)');
      }
      if (!isYmdDate(startDate) || !isYmdDate(endDate)) {
        return badRequest('startDate and endDate must be valid YYYY-MM-DD dates');
      }
      if (startDate > endDate) {
        return badRequest('startDate must not be after endDate');
      }

      // buildService is async: it resolves the IMS token via the x-promise-token flow
      // (falling back to Authorization IMS) before constructing the transport (LLMO-5990).
      const service = await buildService(ctx);

      // Region scoping: a Semrush project == one (brand, market). Resolve the UI's region
      // code to that project's id (via the Markets element) and pass it as top-level
      // `project_id`. region=all/absent → all of the brand's markets.
      let projectId;
      const { region } = query;
      if (hasText(region) && region.toLowerCase() !== 'all') {
        const { BrandSemrushProject } = ctx?.dataAccess ?? {};
        const brandSemrushProjects = await fetchBrandSemrushProjects(
          BrandSemrushProject,
          [brand],
        );
        projectId = await service.resolveRegionProjectId(workspaceId, {
          brandId, region, brandSemrushProjects,
        });
        // Don't silently fall back to all-region data when the caller asked for a specific
        // region we can't resolve to a market — that would return a superset of what was
        // requested. Fail explicitly, mirroring the brandId/workspaceId guards above.
        if (!hasText(projectId)) {
          return notFound(`No Semrush market found for region: ${region}`);
        }
      }

      // Explicitly pick the params the service needs (normalizing the aliases the UI may send
      // under either casing/key) rather than spreading all raw query keys through. `category`
      // (sent as `categoryId`) becomes a Semrush tag; `channel` is a client-side content-type
      // filter in the transform; `region` was resolved to `projectId` above; page/pageSize
      // drive the client-side slice.
      const params = {
        projectId,
        model: query.model || query.platform,
        startDate,
        endDate,
        category: query.categoryId || query.category,
        channel: query.channel || query.selectedChannel,
        page: query.page,
        pageSize: query.pageSize,
      };

      const result = await service.getCitedDomains(workspaceId, params);
      return ok(result);
    } catch (e) {
      return mapError(e, log);
    }
  };
  /* c8 ignore stop */

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/sentiment-overview
   * Returns per-week brand sentiment (positive/neutral/negative percentages) sourced from
   * the Semrush Sentiment element, in the legacy `{ weeklyTrends: [...] }` contract so the
   * existing brand-presence sentiment chart consumes it drop-in. Single upstream call
   * (aggregate, no fan-out); region → top-level project_id like cited-domains.
   */
  /* c8 ignore start -- LLMO-6300 POC endpoint; unit tests intentionally deferred */
  const listSentimentOverview = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { brandId } = ctx?.params ?? {};
      const { workspaceId, brand } = auth;
      const query = extractQuery(ctx);

      // Date range is required + validated (mirrors cited-domains) — never silently
      // default to a rolling window nor forward a malformed date to Semrush.
      const startDate = query.startDate || query.start_date;
      const endDate = query.endDate || query.end_date;
      if (!hasText(startDate) || !hasText(endDate)) {
        return badRequest('startDate and endDate are required (YYYY-MM-DD)');
      }
      if (!isYmdDate(startDate) || !isYmdDate(endDate)) {
        return badRequest('startDate and endDate must be valid YYYY-MM-DD dates');
      }
      if (startDate > endDate) {
        return badRequest('startDate must not be after endDate');
      }
      // Bound the span (mirrors listOwnedUrls/listDomainUrls): a multi-year range is
      // needlessly expensive upstream and inflates the in-memory weekly rollup.
      const MAX_RANGE_DAYS = 366;
      const spanDays = (Date.parse(`${endDate}T00:00:00Z`)
        - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
      if (spanDays > MAX_RANGE_DAYS) {
        return badRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
      }

      const service = await buildService(ctx);

      // Region scoping: a Semrush project == one (brand, market). Resolve the UI's region
      // code to that project's id (via the Markets element) and pass it as top-level
      // `project_id`. region=all/absent → aggregate across all the brand's markets.
      let projectId;
      const { region } = query;
      if (hasText(region) && region.toLowerCase() !== 'all') {
        const { BrandSemrushProject } = ctx?.dataAccess ?? {};
        const brandSemrushProjects = await fetchBrandSemrushProjects(
          BrandSemrushProject,
          [brand],
        );
        projectId = await service.resolveRegionProjectId(workspaceId, {
          brandId, region, brandSemrushProjects,
        });
        if (!hasText(projectId)) {
          return notFound(`No Semrush market found for region: ${region}`);
        }
      }

      const params = {
        projectId,
        model: query.model || query.platform,
        startDate,
        endDate,
        category: query.categoryId || query.category,
      };

      const result = await service.getSentimentOverview(workspaceId, params);
      return cachedOk(result);
    } catch (e) {
      return mapError(e, log);
    }
  };
  /* c8 ignore stop */

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence
   *     /url-inspector/owned-urls
   * The URL Inspector "Your cited URLs" table. Hybrid: per-URL citations +
   * weekly trends from Semrush (Stats-per-URL 9af5ed83 + trend afb2e5d3);
   * agentic/referral traffic from Adobe Postgres, joined by (site_id, url_path).
   */
  /* c8 ignore start -- LLMO-6086 POC endpoint; unit tests intentionally deferred */
  const listOwnedUrls = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { spaceCatId, brandId } = ctx?.params ?? {};
      const { workspaceId, brand } = auth;
      const query = extractQuery(ctx);

      // Date range is required + validated (mirrors cited-domains) — never silently
      // default to a rolling window nor forward a malformed date to Semrush.
      const startDate = query.startDate || query.start_date;
      const endDate = query.endDate || query.end_date;
      if (!hasText(startDate) || !hasText(endDate)) {
        return badRequest('startDate and endDate are required (YYYY-MM-DD)');
      }
      if (!isYmdDate(startDate) || !isYmdDate(endDate)) {
        return badRequest('startDate and endDate must be valid YYYY-MM-DD dates');
      }
      if (startDate > endDate) {
        return badRequest('startDate must not be after endDate');
      }
      // Bound the span (defense-in-depth alongside the traffic RPC's p_urls cap): a
      // multi-year range fanned across every project is needlessly expensive upstream.
      const MAX_RANGE_DAYS = 366;
      const spanDays = (Date.parse(`${endDate}T00:00:00Z`)
        - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
      if (spanDays > MAX_RANGE_DAYS) {
        return badRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
      }

      // siteId is OPTIONAL here (unlike the legacy site-scoped RPC): citations come
      // from Semrush (brand-scoped), so siteId only feeds the Postgres traffic join.
      // When supplied it must belong to this brand (mirrors listWeeks). Absent →
      // agentic/referral degrade to 0/[].
      const siteId = query.siteId || query.site_id;
      let resolvedSiteId;
      if (hasText(siteId)) {
        const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
        const resolved = await getBrandBySite(spaceCatId, siteId, postgrestClient, log);
        if (!resolved || resolved.id !== brand.id) {
          return badRequest('siteId does not belong to the specified brand');
        }
        resolvedSiteId = siteId;
      }

      const service = await buildService(ctx);

      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(BrandSemrushProject, [brand]);

      // Scope per project (region): a specific region → that one project; otherwise
      // all the brand's markets. Per-project keeps each element call under the
      // Semrush 50k-row cap and lets the transform tag each URL with its region.
      let projects;
      let regionFilter;
      const { region } = query;
      if (hasText(region) && region.toLowerCase() !== 'all') {
        const projectId = await service.resolveRegionProjectId(workspaceId, {
          brandId, region, brandSemrushProjects,
        });
        if (!hasText(projectId)) {
          return notFound(`No Semrush market found for region: ${region}`);
        }
        projects = [{ region, projectId }];
        regionFilter = region;
      } else {
        projects = await service.getOwnedUrlProjects(workspaceId, { brandSemrushProjects });
      }

      const allUrls = await service.getOwnedUrls(workspaceId, {
        projects,
        model: query.model || query.platform,
        startDate,
        endDate,
        category: query.categoryId || query.category,
      });

      // Client-side pagination — Semrush has no server-side pagination; totalCount is
      // the full post-filter (owned) count.
      const page = Math.max(0, Number.parseInt(query.page, 10) || 0);
      const pageSize = Math.min(Math.max(1, Number.parseInt(query.pageSize, 10) || 50), 1000);
      const totalCount = allUrls.length;
      const offset = page * pageSize;
      const pageUrls = allUrls.slice(offset, offset + pageSize);

      // Hybrid: join agentic/referral from Postgres for JUST this page's URLs
      // (keeps p_urls small). Best-effort — degrades to 0/[] on any failure.
      const trafficMap = await fetchOwnedUrlsTraffic(ctx?.dataAccess?.Site?.postgrestService, {
        siteId: resolvedSiteId,
        startDate,
        endDate,
        urls: pageUrls.map((u) => u.url),
        region: regionFilter,
        referralSource: query.referralSource || query.referral_source,
        log,
      });
      const urls = mergeOwnedUrlsTraffic(pageUrls, trafficMap);

      return cachedOk({ urls, totalCount });
    } catch (e) {
      return mapError(e, log);
    }
  };
  /* c8 ignore stop */

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence
   *     /url-inspector/domain-urls
   * Phase 2 of the Cited Third-Party tree: expand a cited domain → its URLs.
   * Same Semrush element as owned-urls (Stats-per-URL 9af5ed83) minus the trend
   * element and the Postgres traffic hybrid, filtered to a single domain
   * (required `hostname`) client-side instead of `domain_type='Owned'`.
   */
  /* c8 ignore start -- LLMO-6160 POC endpoint; unit tests intentionally deferred */
  const listDomainUrls = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { brandId } = ctx?.params ?? {};
      const { workspaceId, brand } = auth;
      const query = extractQuery(ctx);

      // Date range is required + validated (mirrors cited-domains/owned-urls).
      const startDate = query.startDate || query.start_date;
      const endDate = query.endDate || query.end_date;
      if (!hasText(startDate) || !hasText(endDate)) {
        return badRequest('startDate and endDate are required (YYYY-MM-DD)');
      }
      if (!isYmdDate(startDate) || !isYmdDate(endDate)) {
        return badRequest('startDate and endDate must be valid YYYY-MM-DD dates');
      }
      if (startDate > endDate) {
        return badRequest('startDate must not be after endDate');
      }
      // Bound the span (mirrors listOwnedUrls): a multi-year range fanned across every
      // project is needlessly expensive upstream and inflates the in-memory aggregation,
      // gated only by FACS auth.
      const MAX_RANGE_DAYS = 366;
      const spanDays = (Date.parse(`${endDate}T00:00:00Z`)
        - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
      if (spanDays > MAX_RANGE_DAYS) {
        return badRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
      }

      // hostname (aka domain) is the domain to drill into — required (the UI only
      // calls this after a domain row is expanded).
      const hostname = query.hostname || query.domain;
      if (!hasText(hostname)) {
        return badRequest('hostname is required for domain URL drilldown');
      }

      const service = await buildService(ctx);

      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(BrandSemrushProject, [brand]);

      // Scope per project (region): a specific region → that one project; otherwise
      // all the brand's markets. Per-project keeps each element call under the
      // Semrush 50k-row cap and lets the transform tag each URL with its region.
      let projects;
      const { region } = query;
      if (hasText(region) && region.toLowerCase() !== 'all') {
        const projectId = await service.resolveRegionProjectId(workspaceId, {
          brandId, region, brandSemrushProjects,
        });
        if (!hasText(projectId)) {
          return notFound(`No Semrush market found for region: ${region}`);
        }
        projects = [{ region, projectId }];
      } else {
        projects = await service.getOwnedUrlProjects(workspaceId, { brandSemrushProjects });
      }

      // The transform host-filters, sorts by citations desc, and slices client-side
      // (Semrush has no server-side pagination); totalCount is the full post-filter count.
      const result = await service.getDomainUrls(workspaceId, {
        projects,
        hostname,
        channel: query.channel || query.selectedChannel,
        model: query.model || query.platform,
        startDate,
        endDate,
        category: query.categoryId || query.category,
        page: query.page,
        pageSize: query.pageSize,
      });

      return cachedOk(result);
    } catch (e) {
      return mapError(e, log);
    }
  };
  /* c8 ignore stop */

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/market-tracking-trends
   * Weekly per-competitor mentions + citations for the Competitor Comparison chart on
   * the brand-presence-sr-ui dashboard. Backed by two weekly `line` elements (TRENDS_MV
   * for mentions, MARKET_CITATIONS_TREND for citations); competitors come back natively
   * as tracked-benchmark legends, so no competitor list is needed as input. See
   * docs/elements/market-tracking-trends-plan.md.
   *
   * Query params (all optional): `startDate`/`start_date` + `endDate`/`end_date`
   * (default: 28-day trailing window), `model`/`platform` (default search-gpt),
   * `regionCode`/`region_code`/`region` (a single region → its one Semrush project;
   * `all`/absent → aggregate across every project the brand owns), `siteId`/`site_id`
   * (cross-check only — must belong to `:brandId`).
   */
  /* c8 ignore start -- market-tracking-trends POC endpoint; unit tests intentionally deferred */
  const getMarketTrackingTrends = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { spaceCatId, brandId } = ctx?.params ?? {};
      const { workspaceId, brand } = auth;
      const query = extractQuery(ctx);

      // The path already names the brand; a siteId filter is only honored when it
      // belongs to that brand (mirrors listWeeks / listCitedDomains).
      const siteId = query.siteId || query.site_id;
      if (hasText(siteId)) {
        const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
        const resolved = await getBrandBySite(spaceCatId, siteId, postgrestClient, log);
        if (!resolved || resolved.id !== brand.id) {
          return badRequest('siteId does not belong to the specified brand');
        }
      }

      // Date range is optional (defaults to a 28-day trailing window); when a value is
      // sent it must be a valid YYYY-MM-DD and correctly ordered.
      let startDate = query.startDate || query.start_date;
      let endDate = query.endDate || query.end_date;
      if (hasText(startDate) && !isYmdDate(startDate)) {
        return badRequest('startDate must be a valid YYYY-MM-DD date');
      }
      if (hasText(endDate) && !isYmdDate(endDate)) {
        return badRequest('endDate must be a valid YYYY-MM-DD date');
      }
      // Require both or neither (mirrors listOwnedUrls/listDomainUrls): a half-supplied
      // range would otherwise pair a caller-provided date with the default's other half,
      // silently producing an unbounded window that bypasses the 28-day-default contract.
      // If either is absent, fall back to the full default range as a unit.
      if (!hasText(startDate) || !hasText(endDate)) {
        const defaultRange = defaultStatsDateRange();
        startDate = defaultRange.startDate;
        endDate = defaultRange.endDate;
      }
      if (startDate > endDate) {
        return badRequest('startDate must not be after endDate');
      }
      // Bound the span (mirrors listOwnedUrls/listDomainUrls): a multi-year range fanned
      // across every project is needlessly expensive upstream, and this endpoint also
      // aggregates across all projects when no region is given, compounding the fan-out.
      const MAX_RANGE_DAYS = 366;
      const spanDays = (Date.parse(`${endDate}T00:00:00Z`)
        - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
      if (spanDays > MAX_RANGE_DAYS) {
        return badRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
      }

      const service = await buildService(ctx);
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(BrandSemrushProject, [brand]);

      // A single selected region+language → its one Semrush projectId. region=all/absent
      // → every project the brand owns (the payload builder ORs them into one call, so
      // neither path fans out).
      let projectId;
      let projectIds;
      const region = query.regionCode || query.region_code || query.region;
      if (hasText(region) && region.toLowerCase() !== 'all') {
        projectId = await service.resolveRegionProjectId(workspaceId, {
          brandId, region, brandSemrushProjects,
        });
        if (!hasText(projectId)) {
          return notFound(`No Semrush market found for region: ${region}`);
        }
      } else {
        projectIds = brandSemrushProjects
          .map((p) => p.semrushProjectId)
          .filter(hasText);
        // Guard the aggregate path: with no project ids the trend payload would carry
        // no `CBF_project(s)` filter and Semrush would return the ENTIRE workspace —
        // which, on the org-parent-workspace fallback (a brand with no sub-workspace),
        // is other brands' data. A brand with zero Semrush projects has no trends, so
        // return empty rather than issue an unscoped upstream query.
        if (projectIds.length === 0) {
          return cachedOk({ weeklyTrends: [] });
        }
      }

      const result = await service.getMarketTrackingTrends(workspaceId, {
        model: query.model,
        platform: query.platform,
        startDate,
        endDate,
        projectId,
        projectIds,
        brandName: brand.name,
      });
      return cachedOk(result);
    } catch (e) {
      return mapError(e, log);
    }
  };
  /* c8 ignore stop */

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/stats
   * Elements-backed equivalent of the Postgres-RPC `/stats` endpoint (see
   * llmo-brand-presence.js#createBrandPresenceStatsHandler): same response shape
   * (`{ stats, trends? }`) — aggregated `total_executions`, `average_visibility_score`,
   * `total_mentions`, `total_citations`, plus an optional weekly `trends` array. See
   * docs/elements/brand-presence-stats-plan.md for the full design + resolved decisions.
   *
   * `categoryId(s)`/`topicIds`/`origin` are accepted by the reference endpoint but are
   * NOT yet supported here — the Elements API has no confirmed filter equivalent for
   * them (see the plan doc's gap analysis); they are currently no-ops.
   */
  const getStats = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { spaceCatId, brandId } = ctx?.params ?? {};
      const { workspaceId, brand } = auth;
      const query = extractQuery(ctx);
      const siteId = query.siteId || query.site_id;

      if (hasText(siteId)) {
        const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
        const resolved = await getBrandBySite(spaceCatId, siteId, postgrestClient, log);
        if (!resolved || resolved.id !== brand.id) {
          return badRequest('siteId does not belong to the specified brand');
        }
      }

      const startDate = query.startDate || query.start_date;
      const endDate = query.endDate || query.end_date;
      if (hasText(startDate) && !isYmdDate(startDate)) {
        return badRequest('startDate must be a valid YYYY-MM-DD date');
      }
      if (hasText(endDate) && !isYmdDate(endDate)) {
        return badRequest('endDate must be a valid YYYY-MM-DD date');
      }
      if (hasText(startDate) && hasText(endDate) && startDate > endDate) {
        return badRequest('startDate must not be after endDate');
      }
      const defaultRange = defaultStatsDateRange();
      const effectiveStartDate = startDate || defaultRange.startDate;
      const effectiveEndDate = endDate || defaultRange.endDate;
      // Bound the span (mirrors listOwnedUrls/listDomainUrls): the Brand Presence
      // date picker only allows selecting up to 8 weeks, matching the trends
      // fan-out cap (splitDateRangeIntoWeeksBackward's TRENDS_MAX_WEEKS), so a
      // wider range can only come from a caller bypassing the UI.
      const MAX_RANGE_DAYS = 56;
      const spanDays = (Date.parse(`${effectiveEndDate}T00:00:00Z`)
        - Date.parse(`${effectiveStartDate}T00:00:00Z`)) / 86400000;
      if (spanDays > MAX_RANGE_DAYS) {
        return badRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
      }

      const service = await buildService(ctx);
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(BrandSemrushProject, [brand]);

      // A single selected region+language maps 1:1 to a Semrush projectId — the
      // common case, needing no fan-out. Absent → aggregate "all regions" view,
      // scoped to every project this brand owns.
      let projectId;
      let projectIds;
      const regionCode = query.regionCode || query.region_code || query.region;
      if (hasText(regionCode)) {
        projectId = await service.resolveRegionProjectId(workspaceId, {
          brandId, region: regionCode, brandSemrushProjects,
        });
        if (!hasText(projectId)) {
          return notFound(`No Semrush market found for region: ${regionCode}`);
        }
      } else {
        projectIds = brandSemrushProjects
          .map((p) => p.semrushProjectId)
          .filter(hasText);
        // An empty list here must not silently fall through to an unscoped
        // (workspace-wide) Semrush query — that would return data for every
        // brand/project in the subworkspace, not just this one. Fail explicitly.
        if (projectIds.length === 0) {
          return notFound(`No Semrush projects configured for brand: ${brandId}`);
        }
      }

      const result = await service.getBrandPresenceStats(workspaceId, {
        model: query.model,
        platform: query.platform,
        startDate: effectiveStartDate,
        endDate: effectiveEndDate,
        projectId,
        projectIds,
        brandName: brand.name,
        showTrends: parseShowTrends(query),
      });

      return cachedOk(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence
   *     /url-inspector/stats
   * URL Inspector stats KPI cards (totalPromptsCited, totalPrompts, uniqueUrls,
   * totalCitations) plus a per-week sparkline breakdown, matching the response
   * shape of the Aurora/Postgres reference endpoint
   * (docs/llmo-brandalf-apis/url-inspector-stats-api.md). See
   * docs/elements/url-inspector-stats-plan.md for the full design, including two
   * known approximation gaps: `totalPromptsCited` sums a per-URL count (Semrush
   * exposes no distinct prompts-cited element, so a prompt citing multiple owned
   * URLs is overcounted), and `totalPrompts` is not date-scoped (the Semrush
   * PROMPTS element has no date filter, unlike the Aurora RPC).
   */
  const getUrlInspectorStats = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { spaceCatId, brandId } = ctx?.params ?? {};
      const { workspaceId, brand } = auth;
      const query = extractQuery(ctx);

      const siteId = query.siteId || query.site_id;
      if (hasText(siteId)) {
        const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
        const resolved = await getBrandBySite(spaceCatId, siteId, postgrestClient, log);
        if (!resolved || resolved.id !== brand.id) {
          return badRequest('siteId does not belong to the specified brand');
        }
      }

      // Date range is required (the UI always sends it) and must be a valid
      // YYYY-MM-DD — mirrors listCitedDomains/listOwnedUrls/listDomainUrls.
      const startDate = query.startDate || query.start_date;
      const endDate = query.endDate || query.end_date;
      if (!hasText(startDate) || !hasText(endDate)) {
        return badRequest('startDate and endDate are required (YYYY-MM-DD)');
      }
      if (!isYmdDate(startDate) || !isYmdDate(endDate)) {
        return badRequest('startDate and endDate must be valid YYYY-MM-DD dates');
      }
      if (startDate > endDate) {
        return badRequest('startDate must not be after endDate');
      }
      // Bound the span (mirrors listOwnedUrls/listDomainUrls): a multi-year range
      // fanned across every project (plus up to 8 per-week fan-out calls for the
      // sparkline) is needlessly expensive upstream.
      const MAX_RANGE_DAYS = 366;
      const spanDays = (Date.parse(`${endDate}T00:00:00Z`)
        - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
      if (spanDays > MAX_RANGE_DAYS) {
        return badRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
      }

      const service = await buildService(ctx);
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(BrandSemrushProject, [brand]);

      // Scope per project (region): a specific region → that one project; otherwise
      // all the brand's markets — mirrors listOwnedUrls/listDomainUrls.
      let projects;
      let projectIds;
      const { region } = query;
      if (hasText(region) && region.toLowerCase() !== 'all') {
        const projectId = await service.resolveRegionProjectId(workspaceId, {
          brandId, region, brandSemrushProjects,
        });
        if (!hasText(projectId)) {
          return notFound(`No Semrush market found for region: ${region}`);
        }
        projects = [{ region, projectId }];
        projectIds = [projectId];
      } else {
        projects = await service.getOwnedUrlProjects(workspaceId, { brandSemrushProjects });
        projectIds = brandSemrushProjects.map((p) => p.semrushProjectId).filter(hasText);
      }

      const result = await service.getUrlInspectorStats(workspaceId, {
        projects,
        projectIds,
        model: query.model || query.platform,
        startDate,
        endDate,
        category: query.categoryId || query.category,
      });

      return cachedOk(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  return {
    listUrlInspectorFilterDimensions,
    listWeeks,
    listPrompts,
    listCitedDomains,
    listSentimentOverview,
    listOwnedUrls,
    listDomainUrls,
    getMarketTrackingTrends,
    getStats,
    getUrlInspectorStats,
  };
}
