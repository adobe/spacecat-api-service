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

/**
 * Authorization check for caller-supplied `projectId`(s): every id must be one
 * this brand actually owns (per its `BrandSemrushProject` rows — the same
 * source the aggregate "all projects" view already uses), or a caller who
 * knows another brand's Semrush project UUID could scope a query to that
 * brand's data. This is the invariant `resolveRegionProjectId` used to
 * enforce implicitly (a region only ever resolved to a project the Markets
 * element tied back to the caller's own brand); a raw caller-supplied id has
 * no such lookup, so it must be checked explicitly here instead.
 *
 * @param {string[]} requestedProjectIds - Parsed `projectId` query value.
 * @param {object[]} brandSemrushProjects - This brand's `BrandSemrushProject`
 *   rows (plain objects with `semrushProjectId`).
 * @returns {Response|null} A 403 `Response` if any id isn't owned by the
 *   brand; `null` when the aggregate view was requested (no ids) or every id
 *   checks out.
 */
function checkProjectIdsOwnership(requestedProjectIds, brandSemrushProjects) {
  if (requestedProjectIds.length === 0) {
    return null;
  }
  const owned = new Set(brandSemrushProjects.map((p) => p.semrushProjectId));
  const unauthorized = requestedProjectIds.filter((id) => !owned.has(id));
  if (unauthorized.length > 0) {
    return forbidden(`projectId not owned by this brand: ${unauthorized.join(', ')}`);
  }
  return null;
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

// Upper bound on how many project ids a caller can pass in one `projectId` CSV
// value. Unlike the old `region` param — where the Markets-element lookup
// implicitly rejected anything that wasn't a real market — a caller-supplied
// project id is used as-is with no lookup, so nothing else caps the fan-out
// (CITED_DOMAINS/STATS_PER_URL/URL_TRENDS issue one upstream call per id) or
// the size of the CBF_project/CBF_projects OR-filter sent to every other
// element. This cap bounds both.
const MAX_PROJECT_IDS = 8;

/**
 * Extracts caller-supplied Semrush project ids from the `projectId`/`project_id`
 * query param (CSV, e.g. `projectId=uuid1,uuid2`). Replaces the old single-value
 * `region`/`regionCode` param — the caller now supplies the Semrush project id(s)
 * to scope to directly, instead of a market/region code that had to be resolved
 * via the Markets element. Absent/empty → caller wants the aggregate view across
 * every project the brand owns.
 *
 * Deduplicates (order-preserving) before validating: a repeated id is harmless
 * for the `CBF_project`/`CBF_projects` OR-filter builders (a duplicated `eq`
 * term is a no-op), but the CITED_DOMAINS/STATS_PER_URL/URL_TRENDS per-project
 * fan-out issues one upstream call per id and sums the results — an
 * undeduplicated `projectId=X,X` would double-count that project's citations.
 * Dedup happens before the count cap so a caller repeating the same id many
 * times isn't rejected for exceeding {@link MAX_PROJECT_IDS}.
 *
 * Validates each id is a UUID and caps the (deduplicated) count at
 * {@link MAX_PROJECT_IDS} — with no Markets-element lookup in this path
 * anymore, nothing else rejects a malformed or excessively long id list before
 * it reaches the upstream calls.
 *
 * @param {object} query - Parsed query params (from `extractQuery`).
 * @returns {string[]} Deduplicated, requested project ids, or [] for the
 *   aggregate view.
 * @throws {ErrorWithStatusCode} 400 if more than {@link MAX_PROJECT_IDS}
 *   (deduplicated) ids are given, or any id is not a valid UUID.
 */
function extractProjectIds(query) {
  const ids = [...new Set(splitCsv(query.projectId || query.project_id))];
  if (ids.length > MAX_PROJECT_IDS) {
    throw new ErrorWithStatusCode(
      `projectId supports at most ${MAX_PROJECT_IDS} comma-separated ids (received ${ids.length})`,
      400,
    );
  }
  const invalidIds = ids.filter((id) => !isValidUUID(id));
  if (invalidIds.length > 0) {
    throw new ErrorWithStatusCode(
      `projectId must be a comma-separated list of UUIDs (invalid: ${invalidIds.join(', ')})`,
      400,
    );
  }
  return ids;
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
 * True when the `userIntent`/`user_intent` query param opts into per-prompt
 * intent enrichment on the brand-presence prompts endpoint. Same boolean
 * parsing as {@link parseShowTrends} (the HTTP path only ever yields strings;
 * the boolean/number branch is unit-test-only).
 */
export function parseUserIntent(q) {
  const v = q?.userIntent ?? q?.user_intent;
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
 * @returns {Promise<{workspaceId: string, brandUuid: string} | {error: Response}>}
 *   the brand's sub-workspace id and resolved Postgres brand UUID on success, or a
 *   Response on failure (400 non-UUID brandId, 403 no access, 404 org/brand not found
 *   or brand has no sub-workspace, 409 sub-workspace misconfigured as the parent).
 *   `brandUuid` lets callers run the project-ownership guard (see listUrlPrompts).
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
  return { workspaceId, brandUuid };
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
    return createElementsService(createElementsTransport({ env, imsToken }), log);
  }

  /**
   * Shared scaffolding for the two URL Inspector KPI endpoints
   * (`getUrlInspectorStats`, `getUrlInspectorPromptsCount`): org/brand auth,
   * the optional `siteId` -> brand ownership cross-check, and projectId ->
   * project(s) scoping (including the empty-scope 404 guard). Both
   * endpoints need the exact same security-relevant checks (siteId
   * ownership, cross-brand project scoping) — keeping them in one place
   * means a fix to one can't silently miss the other (PR #2861 review: the
   * `/prompts/count` copy had already drifted to skip test coverage the
   * `/stats` copy had).
   *
   * @param {object} ctx - Request context.
   * @returns {Promise<{error: Response}|{workspaceId: string, brand: object,
   *   brandId: string, query: object, service: object, projects: object[],
   *   projectIds: string[]}>} `projects` carries `{ region, projectId }`
   *   entries (only populated for the aggregate view); `projectIds`
   *   is always the flat, `hasText`-filtered list of Semrush project ids.
   */
  async function resolveUrlInspectorScope(ctx) {
    const auth = await authorizeOrg(ctx);
    if (auth.error) {
      return { error: auth.error };
    }
    const { spaceCatId, brandId } = ctx?.params ?? {};
    const { workspaceId, brand } = auth;
    const query = extractQuery(ctx);

    const siteId = query.siteId || query.site_id;
    if (hasText(siteId)) {
      const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
      const resolved = await getBrandBySite(spaceCatId, siteId, postgrestClient, log);
      if (!resolved || resolved.id !== brand.id) {
        return { error: badRequest('siteId does not belong to the specified brand') };
      }
    }

    const service = await buildService(ctx);
    const { BrandSemrushProject } = ctx?.dataAccess ?? {};
    const brandSemrushProjects = await fetchBrandSemrushProjects(BrandSemrushProject, [brand]);

    // Scope per project: caller-supplied projectId(s) → those projects; otherwise
    // all the brand's markets — mirrors listOwnedUrls/listDomainUrls.
    let projects;
    let projectIds;
    const requestedProjectIds = extractProjectIds(query);
    const ownershipError = checkProjectIdsOwnership(requestedProjectIds, brandSemrushProjects);
    if (ownershipError) {
      return { error: ownershipError };
    }
    if (requestedProjectIds.length > 0) {
      projects = requestedProjectIds.map((projectId) => ({ projectId }));
      projectIds = requestedProjectIds;
    } else {
      projects = await service.getOwnedUrlProjects(workspaceId, { brandSemrushProjects });
      // Derived from the SAME resolved `projects` array (not re-filtered from
      // brandSemrushProjects) — a project can exist in the DB rows but not
      // resolve via the Markets element (or vice versa), and using two
      // different sources here would scope the two KPI endpoints to
      // different project sets.
      projectIds = projects.map((p) => p.projectId).filter(hasText);
      // An empty list here must not silently fall through to an unscoped
      // (workspace-wide) Semrush query (mirrors getStats's Decision 4.1) —
      // if this brand has no sub-workspace of its own yet, `workspaceId`
      // resolves to the org's shared parent, so an unscoped call would
      // return every brand/project in that parent, not just this one.
      if (projectIds.length === 0) {
        return { error: notFound(`No Semrush projects configured for brand: ${brandId}`) };
      }
    }

    return {
      workspaceId, brand, brandId, query, service, projects, projectIds,
    };
  }

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence
   *     /url-inspector/filter-dimensions
   * Returns filter dimensions for the URL Inspector dashboard
   * (brands, regions, topics, categories, page_intents, origins, content_types), scoped to
   * that single brand. `projectId`/`project_id` (CSV of Semrush project UUIDs, optional)
   * scopes the topics/categories/page_intents/origins/tags dimensions (backed by the
   * TOPICS element) to those projects via a `CBF_project` OR filter; absent → unscoped.
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

      const query = extractQuery(ctx);
      // Any caller-supplied id must belong to this brand — otherwise it could scope the
      // Topics element to another brand's data.
      const projectIds = extractProjectIds(query);
      const ownershipError = checkProjectIdsOwnership(projectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }
      const service = await buildService(ctx);
      const result = await service.getUrlInspectorFilterDimensions(
        auth.workspaceId,
        { ...query, projectIds },
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
        enrichUserIntent: parseUserIntent(query),
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

      // Project scoping: caller-supplied projectId(s) (CSV) scope directly to those
      // Semrush projects; absent → all of the brand's markets. Any caller-supplied id
      // must belong to this brand — otherwise it could scope to another brand's data.
      const projectIds = extractProjectIds(query);
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(BrandSemrushProject, [brand]);
      const ownershipError = checkProjectIdsOwnership(projectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }

      // Explicitly pick the params the service needs (normalizing the aliases the UI may send
      // under either casing/key) rather than spreading all raw query keys through. `category`
      // (sent as `categoryId`) becomes a Semrush tag; `channel` is a client-side content-type
      // filter in the transform; page/pageSize drive the client-side slice.
      const params = {
        projectIds,
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
   * (aggregate, no fan-out); projectId(s) → `CBF_project` filter.
   */
  /* c8 ignore start -- LLMO-6300 POC endpoint; unit tests intentionally deferred */
  const listSentimentOverview = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
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

      // Project scoping: caller-supplied projectId(s) (CSV) → `CBF_project` filter;
      // absent → aggregate across all the brand's markets. Any caller-supplied id
      // must belong to this brand — otherwise it could scope to another brand's data.
      const projectIds = extractProjectIds(query);
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(BrandSemrushProject, [brand]);
      const ownershipError = checkProjectIdsOwnership(projectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }

      const params = {
        projectIds,
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
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/topics
   * Data Insights per-topic table. Backed by the rich PROMPTS_BY_TOPIC element
   * (78864493) fetched across ALL topics, grouped by topic and aggregated
   * server-side (promptCount, brandMentions/citations, avg visibility/position/sentiment).
   *
   * Brand-scoped via the brand's Semrush **sub-workspace** (like {@link listTopicPrompts}).
   * Caller-supplied projectId(s) (optional) scope to `CBF_project`; absent → all of the
   * brand's markets.
   * Returns the full topic list (`{ topics, totalCount }`); the table paginates client-side.
   *
   * Query params (all optional): `model`/`platform` (default search-gpt), `projectId`
   * (CSV of Semrush project UUIDs), `startDate`/`endDate` (YYYY-MM-DD).
   */
  /* c8 ignore start -- LLMO-6418 POC endpoint; unit tests intentionally deferred */
  const listTopics = async (ctx) => {
    try {
      const auth = await authorizeBrandSubWorkspace(ctx, log);
      if (auth.error) {
        return auth.error;
      }
      const { brandId } = ctx?.params ?? {};
      const { workspaceId } = auth;
      const query = extractQuery(ctx);

      // Date range is optional; when present it must be a valid, ordered YYYY-MM-DD pair.
      const startDate = query.startDate || query.start_date;
      const endDate = query.endDate || query.end_date;
      if (hasText(startDate) || hasText(endDate)) {
        if (!isYmdDate(startDate) || !isYmdDate(endDate)) {
          return badRequest('startDate and endDate must be valid YYYY-MM-DD dates');
        }
        if (startDate > endDate) {
          return badRequest('startDate must not be after endDate');
        }
      }

      const service = await buildService(ctx);

      // Project scoping: caller-supplied projectId(s) (CSV) → CBF_project; absent → all markets.
      // Any caller-supplied id must belong to this brand — otherwise it could scope to
      // another brand's data.
      const projectIds = extractProjectIds(query);
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(
        BrandSemrushProject,
        [{ id: brandId }],
      );
      const ownershipError = checkProjectIdsOwnership(projectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }

      const topics = await service.getTopics(workspaceId, {
        model: query.model || query.platform,
        startDate: hasText(startDate) ? startDate : undefined,
        endDate: hasText(endDate) ? endDate : undefined,
        projectIds,
      });

      return cachedOk({ topics, totalCount: topics.length });
    } catch (e) {
      return mapError(e, log);
    }
  };
  /* c8 ignore stop */

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/topics/:topicId/prompts
   * Data Insights per-prompt drill-down for a single topic. Backed by the rich
   * PROMPTS_BY_TOPIC element (78864493), scoped by `CBF_topic` = the topic NAME
   * (`:topicId` is the URL-encoded topic name, not a UUID — Semrush topics have no id).
   *
   * Brand-scoped via the brand's Semrush **sub-workspace** (like {@link listPrompts} —
   * projects/prompts live only there). Caller-supplied projectId(s) (optional) scope
   * to `CBF_project`; absent → all of the brand's markets. Pagination is
   * client-side (Semrush has no server-side paging); `totalCount` is the full count.
   *
   * Query params (all optional): `model`/`platform` (default search-gpt), `projectId`
   * (CSV of Semrush project UUIDs), `startDate`/`endDate` (YYYY-MM-DD), `page` (0-based),
   * `pageSize` (1..1000, default 50).
   */
  /* c8 ignore start -- LLMO-6418 POC endpoint; unit tests intentionally deferred */
  const listTopicPrompts = async (ctx) => {
    try {
      const auth = await authorizeBrandSubWorkspace(ctx, log);
      if (auth.error) {
        return auth.error;
      }
      const { brandId, topicId } = ctx?.params ?? {};
      const { workspaceId } = auth;

      // :topicId is the URL-encoded topic NAME. enrichPathInfo already decodes path
      // params, but decode defensively in case a caller double-encodes.
      let topic = topicId;
      try {
        topic = decodeURIComponent(topicId);
      } catch { /* keep raw when not a valid encoding */ }
      if (!hasText(topic)) {
        return badRequest('topicId (topic name) is required');
      }

      const query = extractQuery(ctx);

      // Date range is optional here (unlike the aggregate endpoints); when present it
      // must be a valid, ordered YYYY-MM-DD pair — never forward a malformed date.
      const startDate = query.startDate || query.start_date;
      const endDate = query.endDate || query.end_date;
      if (hasText(startDate) || hasText(endDate)) {
        if (!isYmdDate(startDate) || !isYmdDate(endDate)) {
          return badRequest('startDate and endDate must be valid YYYY-MM-DD dates');
        }
        if (startDate > endDate) {
          return badRequest('startDate must not be after endDate');
        }
      }

      const service = await buildService(ctx);

      // Project scoping: caller-supplied projectId(s) (CSV) → CBF_project; absent → all markets.
      // Any caller-supplied id must belong to this brand — otherwise it could scope to
      // another brand's data.
      const projectIds = extractProjectIds(query);
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(
        BrandSemrushProject,
        [{ id: brandId }],
      );
      const ownershipError = checkProjectIdsOwnership(projectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }

      const allPrompts = await service.getTopicPrompts(workspaceId, {
        topic,
        model: query.model || query.platform,
        startDate: hasText(startDate) ? startDate : undefined,
        endDate: hasText(endDate) ? endDate : undefined,
        projectIds,
      });

      // Client-side pagination (mirrors listOwnedUrls); totalCount is the full count.
      const page = Math.max(0, Number.parseInt(query.page, 10) || 0);
      const pageSize = Math.min(Math.max(1, Number.parseInt(query.pageSize, 10) || 50), 1000);
      const totalCount = allPrompts.length;
      const offset = page * pageSize;
      const prompts = allPrompts.slice(offset, offset + pageSize);

      return cachedOk({
        topicId: topic, prompts, totalCount, page, pageSize,
      });
    } catch (e) {
      return mapError(e, log);
    }
  };
  /* c8 ignore stop */

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/url-inspector/url-prompts
   * URL Inspector details drill-down: the prompts that cited a specific URL. Backed by the
   * URL_PROMPTS element (b4f1ead7), scoped by `CBF_source` = the URL string (verified live).
   *
   * Brand-scoped via the brand's Semrush **sub-workspace** (like {@link listTopicPrompts});
   * the brand is NOT sent as a filter (`CBF_brand` is redundant with sub-workspace scoping —
   * see url-prompts.js). Pagination is client-side; `totalCount` is the full count.
   *
   * Query params: `url` (required, the cited URL), `startDate`/`endDate` (required,
   * YYYY-MM-DD), `model`/`platform` (optional, default search-gpt). `siteId` is accepted
   * but ignored (the sub-workspace authorization already scopes to the brand). Returns the
   * full prompt list in one `{ prompts }` envelope, matching the PG url-prompts endpoint.
   */
  /* c8 ignore start -- LLMO-6620 POC endpoint; unit tests deferred (see url-prompts.js tests) */
  const listUrlPrompts = async (ctx) => {
    try {
      const auth = await authorizeBrandSubWorkspace(ctx, log);
      if (auth.error) {
        return auth.error;
      }
      const { workspaceId, brandUuid } = auth;

      const query = extractQuery(ctx);

      // `url` is the cited URL to drill into (CBF_source). Query params are already
      // percent-decoded by the framework, so use as-is.
      const { url } = query;
      if (!hasText(url)) {
        return badRequest('url is required');
      }

      // Date range is required (mirrors listOwnedUrls): a valid, ordered, bounded pair.
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
      // Bound the span (mirrors listOwnedUrls/listDomainUrls): a multi-year window would buffer
      // an unbounded result set into `allPrompts` before pagination slices it.
      const MAX_RANGE_DAYS = 366;
      const spanDays = (Date.parse(`${endDate}T00:00:00Z`)
        - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
      if (spanDays > MAX_RANGE_DAYS) {
        return badRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
      }

      // Market scope: caller-supplied projectId(s) must belong to this brand — mirrors
      // listOwnedUrls/listDomainUrls — or a caller could scope to another brand's data.
      // Absent → the aggregate view across the brand's whole sub-workspace.
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(
        BrandSemrushProject,
        [{ id: brandUuid }],
      );
      const requestedProjectIds = extractProjectIds(query);
      const ownershipError = checkProjectIdsOwnership(requestedProjectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }

      const service = await buildService(ctx);
      const prompts = await service.getUrlPrompts(workspaceId, {
        url,
        model: query.model || query.platform,
        startDate,
        endDate,
        // Full `category__<label>` tag, sent as-is (CBF_tags in advanced).
        category: query.categoryId || query.category,
        // Fan out per market + union/dedupe by prompt text (element takes one project_id).
        projectIds: requestedProjectIds,
      });

      // Match the PG url-prompts envelope this endpoint will replace: a bare `{ prompts }`
      // with no server-side pagination (the element returns the full list in one call).
      return cachedOk({ prompts });
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
      const { spaceCatId } = ctx?.params ?? {};
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

      // Scope per project: caller-supplied projectId(s) → those projects; otherwise
      // all the brand's markets. Per-project keeps each element call under the
      // Semrush 50k-row cap and lets the transform tag each URL with its project.
      // Any caller-supplied id must belong to this brand — otherwise it could scope to
      // another brand's data.
      let projects;
      const requestedProjectIds = extractProjectIds(query);
      const ownershipError = checkProjectIdsOwnership(requestedProjectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }
      if (requestedProjectIds.length > 0) {
        projects = requestedProjectIds.map((projectId) => ({ projectId }));
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
      // (keeps p_urls small). Best-effort — degrades to 0/[] on any failure. No
      // region filter is passed to the RPC (the old `region` UI code has no
      // equivalent now that projects are selected by Semrush project id).
      const trafficMap = await fetchOwnedUrlsTraffic(ctx?.dataAccess?.Site?.postgrestService, {
        siteId: resolvedSiteId,
        startDate,
        endDate,
        urls: pageUrls.map((u) => u.url),
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

      // Scope per project: caller-supplied projectId(s) → those projects; otherwise
      // all the brand's markets. Per-project keeps each element call under the
      // Semrush 50k-row cap and lets the transform tag each URL with its project.
      // Any caller-supplied id must belong to this brand — otherwise it could scope to
      // another brand's data.
      let projects;
      const requestedProjectIds = extractProjectIds(query);
      const ownershipError = checkProjectIdsOwnership(requestedProjectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }
      if (requestedProjectIds.length > 0) {
        projects = requestedProjectIds.map((projectId) => ({ projectId }));
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
   * `projectId`/`project_id` (CSV of Semrush project UUIDs to scope to;
   * absent → aggregate across every project the brand owns), `siteId`/`site_id`
   * (cross-check only — must belong to `:brandId`).
   */
  /* c8 ignore start -- market-tracking-trends POC endpoint; unit tests intentionally deferred */
  const getMarketTrackingTrends = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { spaceCatId } = ctx?.params ?? {};
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

      // Caller-supplied projectId(s) scope directly to those Semrush projects; absent
      // → every project the brand owns (the payload builder ORs them into one call, so
      // neither path fans out). Any caller-supplied id must belong to this brand —
      // otherwise it could scope to another brand's data.
      const requestedProjectIds = extractProjectIds(query);
      const ownershipError = checkProjectIdsOwnership(requestedProjectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }
      let projectIds = requestedProjectIds;
      if (projectIds.length === 0) {
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

      // Caller-supplied projectId(s) map directly to Semrush project ids — the
      // common case, needing no fan-out. Absent → aggregate "all projects" view,
      // scoped to every project this brand owns. Any caller-supplied id must
      // belong to this brand — otherwise it could scope to another brand's data.
      const requestedProjectIds = extractProjectIds(query);
      const ownershipError = checkProjectIdsOwnership(requestedProjectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }
      let projectIds = requestedProjectIds;
      if (projectIds.length === 0) {
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
   * 3 of the 4 URL Inspector stats KPI cards (totalPromptsCited, uniqueUrls,
   * totalCitations) plus a per-week sparkline breakdown, matching the response
   * shape of the Aurora/Postgres reference endpoint
   * (docs/llmo-brandalf-apis/url-inspector-stats-api.md) minus its
   * `totalPrompts` field. The 4th card (`totalPrompts`) is served by
   * {@link getUrlInspectorPromptsCount} on its own endpoint — split out
   * because this endpoint's per-project Stats-per-URL fan-out (up to 8 weeks x
   * N projects) is what was timing out, while `totalPrompts` is a single,
   * unscoped Semrush call that always completes fast; bundling it here just
   * made it wait on the slow cards. Known approximation gap:
   * `totalPromptsCited` sums a per-URL count (Semrush exposes no distinct
   * prompts-cited element, so a prompt citing multiple owned URLs is
   * overcounted).
   */
  const getUrlInspectorStats = async (ctx) => {
    try {
      const scope = await resolveUrlInspectorScope(ctx);
      if (scope.error) {
        return scope.error;
      }
      const {
        workspaceId, query, service, projects,
      } = scope;

      // Date range is optional (defaults to a 28-day trailing window) — matches
      // every other *stats* endpoint (getStats, both Aurora stats endpoints),
      // not the required-date convention of the table endpoints
      // (listCitedDomains/listOwnedUrls/listDomainUrls) this file's other
      // url-inspector routes use.
      let startDate = query.startDate || query.start_date;
      let endDate = query.endDate || query.end_date;
      if (hasText(startDate) && !isYmdDate(startDate)) {
        return badRequest('startDate must be a valid YYYY-MM-DD date');
      }
      if (hasText(endDate) && !isYmdDate(endDate)) {
        return badRequest('endDate must be a valid YYYY-MM-DD date');
      }
      if (hasText(startDate) && hasText(endDate) && startDate > endDate) {
        return badRequest('startDate must not be after endDate');
      }
      // Default each side independently — a caller supplying only one of the
      // two (e.g. startDate with no endDate) must not have their explicit
      // value silently discarded by overwriting both with the default range.
      if (!hasText(startDate) || !hasText(endDate)) {
        const defaultRange = defaultStatsDateRange();
        if (!hasText(startDate)) {
          startDate = defaultRange.startDate;
        }
        if (!hasText(endDate)) {
          endDate = defaultRange.endDate;
        }
      }
      // Bound the span at 56 days (8 weeks) — matches getStats (brand-presence).
      // `weeklyTrends` may cover a NARROWER window than this on a multi-project
      // aggregate view (its per-week cap adapts to project count so the
      // service's fan-out fits one gateway-safe round-trip — see
      // getUrlInspectorStats in elements-service.js); `stats` always covers the
      // full requested range regardless.
      const MAX_RANGE_DAYS = 56;
      const spanDays = (Date.parse(`${endDate}T00:00:00Z`)
        - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
      if (spanDays > MAX_RANGE_DAYS) {
        return badRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
      }

      const result = await service.getUrlInspectorStats(workspaceId, {
        projects,
        model: query.model,
        platform: query.platform,
        startDate,
        endDate,
        category: query.categoryId || query.category,
      });

      return cachedOk(result);
    } catch (e) {
      return mapError(e, log);
    }
  };

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence
   *     /url-inspector/prompts/count
   * The 4th URL Inspector stats KPI card (`totalPrompts`), split out of
   * `/url-inspector/stats` (see that handler's docstring for why) — a single
   * Semrush PROMPTS element call, scoped to the brand's project(s) the same
   * way `getUrlInspectorStats` scopes Stats-per-URL. No date range: the
   * PROMPTS element has no date filter, so there is nothing to default/cap and
   * no weekly breakdown to return.
   *
   * **Known, PERMANENT limitation: no weekly trend for `totalPrompts`.** The
   * Aurora/Postgres reference endpoint
   * (`docs/llmo-brandalf-apis/url-inspector-stats-api.md`) returns
   * `totalPrompts` WITH a per-week trend, via `rpc_url_inspector_total_prompts`
   * — a time-windowed count of distinct active prompts that ran each week.
   * The Semrush PROMPTS element has no equivalent: it is a static, currently-
   * configured-prompt roster (filterable by model/tag/project, but not by
   * date), not an execution log, so there is no upstream data to bucket by
   * week. This is not a gap to close later with more work — it's a ceiling of
   * the Semrush data model. (An earlier version tried to route around this by
   * repeating the all-time total in every `weeklyTrends` entry; that was
   * flagged in review as misleading — a caller would read
   * `weeklyTrends[i].totalPrompts` as "prompts that week" — so it was split
   * into this dedicated, trend-less endpoint instead of fabricating a
   * per-week series.) The consuming UI (project-elmo-ui#2479) renders this
   * KPI card as a static number with no sparkline, unlike its 3 siblings.
   */
  const getUrlInspectorPromptsCount = async (ctx) => {
    try {
      const scope = await resolveUrlInspectorScope(ctx);
      if (scope.error) {
        return scope.error;
      }
      const {
        workspaceId, query, service, projectIds,
      } = scope;

      // category already carries the `category__<label>` prefix from the caller;
      // sent through as-is, not re-prefixed.
      const category = query.categoryId || query.category;
      const { count: totalPrompts } = await service.getPrompts(workspaceId, {
        model: query.model,
        platform: query.platform,
        tags: category ? [category] : [],
        projectIds,
      });

      return cachedOk({ totalPrompts });
    } catch (e) {
      return mapError(e, log);
    }
  };

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/competitor-summary
   * Elements-backed equivalent of the Postgres-RPC `/competitor-summary` endpoint
   * (see llmo-brand-presence.js#createCompetitorSummaryHandler): aggregate per-competitor
   * mentions/citations totals (no weekly breakdown) for the Overview Competitor
   * Comparison bar chart. Param resolution mirrors getMarketTrackingTrends — same two
   * upstream elements, just summed instead of week-bucketed.
   */
  /* c8 ignore start -- competitor-summary POC endpoint; unit tests intentionally deferred */
  const getCompetitorSummary = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { spaceCatId } = ctx?.params ?? {};
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

      let startDate = query.startDate || query.start_date;
      let endDate = query.endDate || query.end_date;
      if (hasText(startDate) && !isYmdDate(startDate)) {
        return badRequest('startDate must be a valid YYYY-MM-DD date');
      }
      if (hasText(endDate) && !isYmdDate(endDate)) {
        return badRequest('endDate must be a valid YYYY-MM-DD date');
      }
      if (!hasText(startDate) || !hasText(endDate)) {
        const defaultRange = defaultStatsDateRange();
        startDate = defaultRange.startDate;
        endDate = defaultRange.endDate;
      }
      if (startDate > endDate) {
        return badRequest('startDate must not be after endDate');
      }
      const MAX_RANGE_DAYS = 366;
      const spanDays = (Date.parse(`${endDate}T00:00:00Z`)
        - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
      if (spanDays > MAX_RANGE_DAYS) {
        return badRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
      }

      const service = await buildService(ctx);
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(BrandSemrushProject, [brand]);

      // Any caller-supplied id must belong to this brand — otherwise it could scope to
      // another brand's data.
      const requestedProjectIds = extractProjectIds(query);
      const ownershipError = checkProjectIdsOwnership(requestedProjectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }
      let projectIds = requestedProjectIds;
      if (projectIds.length === 0) {
        projectIds = brandSemrushProjects
          .map((p) => p.semrushProjectId)
          .filter(hasText);
        // A brand with zero Semrush projects has no competitor data — return empty
        // rather than falling through to an unscoped query, which (mirrors
        // getMarketTrackingTrends) would return the entire workspace, including
        // other brands' data on the org-parent-workspace fallback.
        if (projectIds.length === 0) {
          return cachedOk({ competitors: [] });
        }
      }

      const result = await service.getCompetitorSummary(workspaceId, {
        model: query.model,
        platform: query.platform,
        startDate,
        endDate,
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
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/kpi-headlines
   * Overview-SR Share of Voice + Brand Visibility KPI headline cards — the exact
   * numbers the Brand Presence MFE itself shows (its own per-brand `kpiLineChart`
   * elements), not derived from market-tracking-trends's weekly series (LLMO-6515
   * follow-up, exact MFE parity). Param resolution mirrors getMarketTrackingTrends/
   * getCompetitorSummary.
   */
  /* c8 ignore start -- kpi-headlines POC endpoint; unit tests intentionally deferred */
  const getKpiHeadlines = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { spaceCatId } = ctx?.params ?? {};
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

      let startDate = query.startDate || query.start_date;
      let endDate = query.endDate || query.end_date;
      if (hasText(startDate) && !isYmdDate(startDate)) {
        return badRequest('startDate must be a valid YYYY-MM-DD date');
      }
      if (hasText(endDate) && !isYmdDate(endDate)) {
        return badRequest('endDate must be a valid YYYY-MM-DD date');
      }
      if (!hasText(startDate) || !hasText(endDate)) {
        const defaultRange = defaultStatsDateRange();
        startDate = defaultRange.startDate;
        endDate = defaultRange.endDate;
      }
      if (startDate > endDate) {
        return badRequest('startDate must not be after endDate');
      }
      const MAX_RANGE_DAYS = 366;
      const spanDays = (Date.parse(`${endDate}T00:00:00Z`)
        - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
      if (spanDays > MAX_RANGE_DAYS) {
        return badRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
      }

      const service = await buildService(ctx);
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(BrandSemrushProject, [brand]);

      // Any caller-supplied id must belong to this brand — otherwise it could scope to
      // another brand's data.
      const requestedProjectIds = extractProjectIds(query);
      const ownershipError = checkProjectIdsOwnership(requestedProjectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }
      let projectIds = requestedProjectIds;
      if (projectIds.length === 0) {
        projectIds = brandSemrushProjects
          .map((p) => p.semrushProjectId)
          .filter(hasText);
        if (projectIds.length === 0) {
          return cachedOk({
            shareOfVoice: { value: 0, comparisonValue: null },
            brandVisibility: { value: 0, comparisonValue: null },
          });
        }
      }

      const result = await service.getKpiHeadlines(workspaceId, {
        model: query.model,
        platform: query.platform,
        startDate,
        endDate,
        projectIds,
        brandName: brand.name,
        // Already carries the `category__<label>` prefix from the caller; sent
        // through as-is, not re-prefixed (see PR #2912).
        category: query.categoryId || query.category,
      });
      return cachedOk(result);
    } catch (e) {
      return mapError(e, log);
    }
  };
  /* c8 ignore stop */

  /**
   * GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/source-visibility-headline
   * Overview-SR Source Visibility KPI headline card. Split from `getKpiHeadlines`
   * because it needs a SEQUENTIAL brand-URL-list lookup before the KPI element
   * itself can be scoped — see {@link getSourceVisibilityHeadline} in
   * elements-service.js for the timeout-budget rationale. Param resolution
   * otherwise mirrors getKpiHeadlines.
   */
  /* c8 ignore start -- kpi-headlines POC endpoint; unit tests intentionally deferred */
  const getSourceVisibilityHeadline = async (ctx) => {
    try {
      const auth = await authorizeOrg(ctx);
      if (auth.error) {
        return auth.error;
      }
      const { spaceCatId } = ctx?.params ?? {};
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

      let startDate = query.startDate || query.start_date;
      let endDate = query.endDate || query.end_date;
      if (hasText(startDate) && !isYmdDate(startDate)) {
        return badRequest('startDate must be a valid YYYY-MM-DD date');
      }
      if (hasText(endDate) && !isYmdDate(endDate)) {
        return badRequest('endDate must be a valid YYYY-MM-DD date');
      }
      if (!hasText(startDate) || !hasText(endDate)) {
        const defaultRange = defaultStatsDateRange();
        startDate = defaultRange.startDate;
        endDate = defaultRange.endDate;
      }
      if (startDate > endDate) {
        return badRequest('startDate must not be after endDate');
      }
      const MAX_RANGE_DAYS = 366;
      const spanDays = (Date.parse(`${endDate}T00:00:00Z`)
        - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
      if (spanDays > MAX_RANGE_DAYS) {
        return badRequest(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
      }

      const service = await buildService(ctx);
      const { BrandSemrushProject } = ctx?.dataAccess ?? {};
      const brandSemrushProjects = await fetchBrandSemrushProjects(BrandSemrushProject, [brand]);

      // Any caller-supplied id must belong to this brand — otherwise it could scope to
      // another brand's data.
      const requestedProjectIds = extractProjectIds(query);
      const ownershipError = checkProjectIdsOwnership(requestedProjectIds, brandSemrushProjects);
      if (ownershipError) {
        return ownershipError;
      }
      let projectIds = requestedProjectIds;
      if (projectIds.length === 0) {
        projectIds = brandSemrushProjects
          .map((p) => p.semrushProjectId)
          .filter(hasText);
        if (projectIds.length === 0) {
          return cachedOk({ value: 0, comparisonValue: null });
        }
      }

      const result = await service.getSourceVisibilityHeadline(workspaceId, {
        model: query.model,
        platform: query.platform,
        startDate,
        endDate,
        projectIds,
        brandName: brand.name,
        // Already carries the `category__<label>` prefix from the caller; sent
        // through as-is, not re-prefixed (see PR #2912).
        category: query.categoryId || query.category,
      });
      return cachedOk(result);
    } catch (e) {
      return mapError(e, log);
    }
  };
  /* c8 ignore stop */

  return {
    listUrlInspectorFilterDimensions,
    listWeeks,
    listPrompts,
    listCitedDomains,
    listSentimentOverview,
    listTopics,
    listTopicPrompts,
    listUrlPrompts,
    listOwnedUrls,
    listDomainUrls,
    getMarketTrackingTrends,
    getStats,
    getUrlInspectorStats,
    getUrlInspectorPromptsCount,
    getCompetitorSummary,
    getKpiHeadlines,
    getSourceVisibilityHeadline,
  };
}
