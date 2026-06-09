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
  badRequest,
  createResponse,
  forbidden,
  internalServerError,
  noContent,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';

import { hasText, isValidUUID } from '@adobe/spacecat-shared-utils';

import routeFacsCapabilities, { PRODUCTS_CAPABILITIES } from '../routes/facs-capabilities.js';
import {
  createFacsAccessMappings,
  listFacsAccessMappings,
  listFacsAccessMappingHistory,
  requirePostgrestForFacsMappings,
  revokeFacsAccessMappingById,
} from '../support/state-access-mapping-utils.js';

// TODO(deps): replace with `normalizeImsOrgId` imported from
// `@adobe/spacecat-shared-http-utils` once the published package includes
// the new export. Inlined here mirroring the legacy controller's helper.
function normalizeImsOrgId(orgIdent, authSrc = 'AdobeOrg') {
  if (!orgIdent || typeof orgIdent !== 'string') {
    return orgIdent;
  }
  return orgIdent.includes('@') ? orgIdent : `${orgIdent}@${authSrc}`;
}

const X_PRODUCT_HEADER = 'x-product';
const ALLOWED_SUBJECT_TYPES = new Set(['user', 'org']);
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Returns the catalog of capability strings declared for a given product
 * in `PRODUCTS_CAPABILITIES`. The catalog is the single source of truth
 * (mac-state-layer.md §"Capability catalog") — it is intent, not derived
 * from the route map. A product may declare capabilities (e.g. ASO's
 * `can_edit` / `can_configure` / `can_deploy`) even if no route currently
 * consumes them, and `PRODUCTS_ROUTES` values must be a subset of this
 * catalog (enforced by the invariant test).
 *
 * @param {string} product Uppercase product code.
 * @returns {string[]} Sorted, de-duplicated capability strings.
 */
function getProductCapabilityCatalog(product) {
  const catalog = PRODUCTS_CAPABILITIES[product] || [];
  return [...new Set(catalog)].sort();
}

/**
 * Returns the resource-type keys declared for a given product in
 * `PRODUCTS_FACS_RESOURCE_PARAM_ALIASES` (e.g. `['brand']` for LLMO,
 * `['site']` for ASO). Empty array when the product has no FACS resources.
 *
 * @param {string} product Uppercase product code.
 * @returns {string[]}
 */
function getProductResourceTypes(product) {
  const resourceMap = routeFacsCapabilities.PRODUCTS_FACS_RESOURCE_PARAM_ALIASES[product] || {};
  return Object.keys(resourceMap);
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!hasText(cursor)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof decoded?.offset === 'number' && Number.isInteger(decoded.offset) && decoded.offset >= 0) {
      return { offset: decoded.offset };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Parses the request's query string into a plain object.
 *
 * The Lambda runtime exposes the raw query string on
 * `context.invocation.event.rawQueryString` (not `pathInfo.queryParams`,
 * which is not populated in this deployment). Mirrors the established
 * pattern in `controllers/feature-flags.js` and `controllers/brands.js`.
 *
 * @param {object} ctx - request context
 * @returns {Object<string, string>} decoded query parameters
 */
function getQueryParams(ctx) {
  const rawQueryString = ctx.invocation?.event?.rawQueryString;
  if (!rawQueryString) {
    return {};
  }
  const params = {};
  rawQueryString.split('&').forEach((param) => {
    const [key, value] = param.split('=');
    if (key && value) {
      const decode = (s) => decodeURIComponent(s.replace(/\+/g, ' '));
      params[decode(key)] = decode(value);
    }
  });
  return params;
}

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

/**
 * Transforms a `facs_access_mappings` row (snake_case from PostgREST) into
 * the API response DTO (camelCase).
 */
function toMappingDto(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    imsOrgId: row.ims_org_id,
    product: row.product,
    grantedCapabilities: row.granted_capabilities ?? [],
    createdBy: row.created_by ?? null,
    createdAt: row.created_at ?? null,
    revokedAt: row.revoked_at ?? null,
    revokedBy: row.revoked_by ?? null,
    revokeReason: row.revoke_reason ?? null,
  };
}

/**
 * State-layer management endpoints under the hybrid permission model.
 *
 * Seven endpoints — five state-layer CRUD + two capability-introspection.
 * All are routed under `/state/access-mappings/*` and `/product/capabilities`
 * + `/user/capabilities/:resourceId`. Capability gating is performed by
 * `facsWrapper` upstream against `routeFacsCapabilities.PRODUCTS_ROUTES`.
 *
 *   - GET    /state/access-mappings           — list active bindings
 *   - GET    /state/access-mappings/history   — list active + revoked
 *   - POST   /state/access-mappings           — create one binding
 *   - PATCH  /state/access-mappings/:id       — replace granted capabilities
 *   - DELETE /state/access-mappings/:id       — soft-revoke a binding
 *   - GET    /product/capabilities            — product capability catalog
 *   - GET    /user/capabilities/:resourceId   — caller's effective capabilities
 *
 * See:
 *   - mysticat-architecture/platform/decisions/mac-state-layer.md
 *   - mysticat-architecture/platform/decisions/rebac-hybrid-permission-model.md
 *   - mysticat-architecture/platform/decisions/api-audit-trail.md
 */
function StateAccessMappingsController(context) {
  const { log } = context;

  function resolveCallerImsOrgIdentBare(ctx) {
    return ctx.attributes?.authInfo?.getTenantIds?.()?.[0] ?? null;
  }

  function resolveCallerUserIdent(ctx) {
    return ctx.attributes?.authInfo?.getProfile?.()?.sub ?? null;
  }

  /**
   * Read and validate the `x-product` header. Uppercased so it matches the
   * column constraint and the `PRODUCTS_ROUTES` key shape. Returns null when
   * absent / unknown.
   */
  function resolveProduct(ctx) {
    const raw = ctx.pathInfo?.headers?.[X_PRODUCT_HEADER];
    if (!hasText(raw)) {
      return null;
    }
    const upper = raw.toUpperCase();
    return routeFacsCapabilities.PRODUCTS_ROUTES[upper] ? upper : null;
  }

  /**
   * Validates that every entry in `grantedCapabilities` is a string of the
   * shape `<product-lower>/<capability>` AND belongs to the product's
   * capability catalog. Returns an error message string, or null on success.
   */
  function validateGrantedCapabilities(grantedCapabilities, product) {
    if (!Array.isArray(grantedCapabilities) || grantedCapabilities.length === 0) {
      return 'grantedCapabilities must be a non-empty array';
    }
    const productLower = product.toLowerCase();
    const catalog = new Set(getProductCapabilityCatalog(product));
    for (const cap of grantedCapabilities) {
      if (!hasText(cap)) {
        return 'grantedCapabilities entries must be non-empty strings';
      }
      const [prefix] = cap.split('/');
      if (prefix !== productLower) {
        return `grantedCapabilities entry '${cap}' must be prefixed with '${productLower}/'`;
      }
      if (!catalog.has(cap)) {
        return `grantedCapabilities entry '${cap}' is not in the ${product} capability catalog`;
      }
    }
    return null;
  }

  function buildListFilters(ctx, imsOrgId, product) {
    const queryParams = getQueryParams(ctx);
    return {
      imsOrgId,
      product,
      subjectType: queryParams.subjectType,
      subjectId: queryParams.subjectId,
      resourceType: queryParams.resourceType,
      resourceId: queryParams.resourceId,
      limit: queryParams.limit,
    };
  }

  /**
   * Common preamble for state-layer endpoints — runs the PostgREST guard,
   * resolves and validates `x-product`, resolves the canonical IMS org id.
   *
   * Returns either `{ error: Response }` to be returned to the client, or
   * `{ product, imsOrgId, imsOrgIdentBare }` on success.
   */
  function preamble(ctx) {
    const guard = requirePostgrestForFacsMappings(ctx);
    if (guard) {
      return { error: guard };
    }
    const product = resolveProduct(ctx);
    if (!product) {
      return { error: badRequest('x-product header is required and must reference a known product') };
    }
    const imsOrgIdentBare = resolveCallerImsOrgIdentBare(ctx);
    const imsOrgId = normalizeImsOrgId(imsOrgIdentBare);
    if (!imsOrgId) {
      return { error: forbidden('Caller has no IMS org') };
    }
    return { product, imsOrgId, imsOrgIdentBare };
  }

  /**
   * GET /state/access-mappings — list ACTIVE bindings. Requires at least one
   * of (subjectType + subjectId) or (resourceType + resourceId).
   */
  async function listMappings(ctx) {
    const pre = preamble(ctx);
    if (pre.error) {
      return pre.error;
    }
    const { product, imsOrgId } = pre;

    const filters = buildListFilters(ctx, imsOrgId, product);
    if (filters.subjectType && !ALLOWED_SUBJECT_TYPES.has(filters.subjectType)) {
      return badRequest("subjectType filter must be 'user' or 'org'");
    }
    const hasSubject = hasText(filters.subjectType) && hasText(filters.subjectId);
    const hasResource = hasText(filters.resourceType) && hasText(filters.resourceId);
    if (!hasSubject && !hasResource) {
      return badRequest(
        'must supply at least one of (subjectType + subjectId) or (resourceType + resourceId)',
      );
    }

    const queryParams = getQueryParams(ctx);
    const decoded = decodeCursor(queryParams.cursor);
    const limit = clampLimit(filters.limit);
    // Helper applies a single page-size limit; for cursor pagination we
    // over-fetch one row to detect whether a next page exists.
    filters.limit = limit + 1 + (decoded?.offset ?? 0);

    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const allRows = await listFacsAccessMappings(postgrestClient, filters);
      const offset = decoded?.offset ?? 0;
      const slice = allRows.slice(offset, offset + limit);
      const hasMore = allRows.length > offset + limit;
      return ok({
        items: slice.map(toMappingDto),
        cursor: hasMore ? encodeCursor(offset + limit) : null,
      });
    } catch (error) {
      log.error({ tag: 'state-access-mappings', err: error.message }, 'Failed to list state-layer access mappings');
      return internalServerError('Failed to list access mappings');
    }
  }

  /**
   * GET /state/access-mappings/history — list ACTIVE + REVOKED bindings.
   */
  async function listHistory(ctx) {
    const pre = preamble(ctx);
    if (pre.error) {
      return pre.error;
    }
    const { product, imsOrgId } = pre;

    const filters = buildListFilters(ctx, imsOrgId, product);
    if (filters.subjectType && !ALLOWED_SUBJECT_TYPES.has(filters.subjectType)) {
      return badRequest("subjectType filter must be 'user' or 'org'");
    }
    const hasSubject = hasText(filters.subjectType) && hasText(filters.subjectId);
    const hasResource = hasText(filters.resourceType) && hasText(filters.resourceId);
    if (!hasSubject && !hasResource) {
      return badRequest(
        'must supply at least one of (subjectType + subjectId) or (resourceType + resourceId)',
      );
    }

    const queryParams = getQueryParams(ctx);
    const decoded = decodeCursor(queryParams.cursor);
    const limit = clampLimit(filters.limit);
    filters.limit = limit + 1 + (decoded?.offset ?? 0);

    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const allRows = await listFacsAccessMappingHistory(postgrestClient, filters);
      const offset = decoded?.offset ?? 0;
      const slice = allRows.slice(offset, offset + limit);
      const hasMore = allRows.length > offset + limit;
      return ok({
        items: slice.map(toMappingDto),
        cursor: hasMore ? encodeCursor(offset + limit) : null,
      });
    } catch (error) {
      log.error({ tag: 'state-access-mappings', err: error.message }, 'Failed to list state-layer access mapping history');
      return internalServerError('Failed to list access mapping history');
    }
  }

  /**
   * POST /state/access-mappings — create a single binding.
   *
   * Body: { subjectType, subjectId, resourceType, resourceId, grantedCapabilities }.
   * Validates capabilities against the product's catalog and the resource
   * type against the product's declared resource keys. For org-type
   * subjects, the only legal `subjectId` is the caller's canonical org id.
   */
  async function createMapping(ctx) {
    const pre = preamble(ctx);
    if (pre.error) {
      return pre.error;
    }
    const { product, imsOrgId } = pre;
    const createdBy = resolveCallerUserIdent(ctx);

    const { data } = ctx;
    if (!data || typeof data !== 'object') {
      return badRequest('request body is required');
    }
    const {
      subjectType, subjectId, resourceType, resourceId, grantedCapabilities,
    } = data;

    if (!ALLOWED_SUBJECT_TYPES.has(subjectType)) {
      return badRequest("subjectType must be 'user' or 'org'");
    }
    if (!hasText(subjectId)) {
      return badRequest('subjectId is required');
    }
    if (subjectType === 'user' && !subjectId.includes('@')) {
      return badRequest("subjectId for type 'user' must be canonical '<ident>@<authSrc>'");
    }
    if (subjectType === 'org' && subjectId !== imsOrgId) {
      return forbidden("subjectId for type 'org' must equal the caller's canonical org id");
    }

    const productResourceTypes = getProductResourceTypes(product);
    if (!productResourceTypes.includes(resourceType)) {
      return badRequest(
        `resourceType must be one of [${productResourceTypes.join(', ')}] for product ${product}`,
      );
    }
    if (!hasText(resourceId)) {
      return badRequest('resourceId is required');
    }

    const capErr = validateGrantedCapabilities(grantedCapabilities, product);
    if (capErr) {
      return badRequest(capErr);
    }

    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const result = await createFacsAccessMappings(postgrestClient, {
        imsOrgId,
        product,
        resourceType,
        resourceId,
        grantedCapabilities,
        subjects: [{ type: subjectType, id: subjectId }],
        createdBy,
      });
      if (result.created.length === 0 && result.skipped.length > 0) {
        // Active duplicate already exists. Surface the existing row id for
        // idempotent client handling — look it up by the natural key.
        const existing = await listFacsAccessMappings(postgrestClient, {
          imsOrgId,
          product,
          subjectType,
          subjectId,
          resourceType,
          resourceId,
          limit: 1,
        });
        const conflictId = existing[0]?.id ?? null;
        return createResponse(
          {
            message: 'Active access mapping already exists for this subject and resource',
            id: conflictId,
          },
          409,
        );
      }
      return createResponse(toMappingDto(result.created[0]), 201);
    } catch (error) {
      log.error(
        { tag: 'state-access-mappings', err: error.message },
        'Failed to create state-layer access mapping',
      );
      return internalServerError('Failed to create access mapping');
    }
  }

  /**
   * PATCH /state/access-mappings/:id — replace the row's
   * `granted_capabilities` array (single-field mutation).
   *
   * 404 when the row does not exist, is revoked, or belongs to a different
   * org / product.
   */
  async function patchMapping(ctx) {
    const pre = preamble(ctx);
    if (pre.error) {
      return pre.error;
    }
    const { product, imsOrgId } = pre;

    const { id } = ctx.pathInfo?.params || {};
    if (!hasText(id) || !isValidUUID(id)) {
      return badRequest('id must be a valid UUID');
    }
    const { data } = ctx;
    if (!data || typeof data !== 'object') {
      return badRequest('request body is required');
    }
    const { grantedCapabilities } = data;
    const capErr = validateGrantedCapabilities(grantedCapabilities, product);
    if (capErr) {
      return badRequest(capErr);
    }

    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const { data: rows, error } = await postgrestClient
        .from('facs_access_mappings')
        .update({ granted_capabilities: grantedCapabilities })
        .eq('id', id)
        .eq('ims_org_id', imsOrgId)
        .eq('product', product)
        .is('revoked_at', null)
        .select('*');
      if (error) {
        throw new Error(error.message);
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return notFound('Mapping not found');
      }
      return ok(toMappingDto(rows[0]));
    } catch (error) {
      log.error(
        { tag: 'state-access-mappings', err: error.message, id },
        'Failed to patch state-layer access mapping',
      );
      return internalServerError('Failed to update access mapping');
    }
  }

  /**
   * DELETE /state/access-mappings/:id — soft-revoke a binding.
   * 204 on success, 404 when no active row matched.
   */
  async function revokeMapping(ctx) {
    const pre = preamble(ctx);
    if (pre.error) {
      return pre.error;
    }
    const { imsOrgId } = pre;

    const { id } = ctx.pathInfo?.params || {};
    if (!hasText(id) || !isValidUUID(id)) {
      return badRequest('id must be a valid UUID');
    }
    const revokeReason = ctx.data && typeof ctx.data === 'object' && ctx.data.reason
      ? ctx.data.reason
      : null;

    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const tombstone = await revokeFacsAccessMappingById(postgrestClient, {
        id,
        imsOrgId,
        revokedBy: resolveCallerUserIdent(ctx),
        revokeReason,
      });
      if (!tombstone) {
        return notFound('Mapping not found');
      }
      return noContent();
    } catch (error) {
      log.error(
        { tag: 'state-access-mappings', err: error.message, id },
        'Failed to revoke state-layer access mapping',
      );
      return internalServerError('Failed to revoke access mapping');
    }
  }

  /**
   * GET /product/capabilities — read-only catalog of capabilities declared
   * for the product. Sourced from `PRODUCTS_CAPABILITIES[product]`.
   */
  async function getProductCapabilities(ctx) {
    const product = resolveProduct(ctx);
    if (!product) {
      return badRequest('x-product header is required and must reference a known product');
    }
    return ok({
      product,
      capabilities: getProductCapabilityCatalog(product),
    });
  }

  /**
   * GET /user/capabilities/:resourceId — caller's effective capability set
   * for the given resource under the current product.
   *
   * Effective set = union of:
   *   - JWT.facs_permissions (filtered to the product),
   *   - state.granted_capabilities for the user binding to the resource,
   *   - state.granted_capabilities for the caller's org binding to the
   *     resource.
   *
   * Provenance is reported per capability with tags from
   * {`jwt`, `state:user`, `state:org`}.
   */
  async function getUserCapabilities(ctx) {
    const guard = requirePostgrestForFacsMappings(ctx);
    if (guard) {
      return guard;
    }

    const product = resolveProduct(ctx);
    if (!product) {
      return badRequest('x-product header is required and must reference a known product');
    }

    const imsOrgIdentBare = resolveCallerImsOrgIdentBare(ctx);
    const imsOrgId = normalizeImsOrgId(imsOrgIdentBare);
    if (!imsOrgId) {
      return forbidden('Caller has no IMS org');
    }

    const { resourceId } = ctx.pathInfo?.params || {};
    if (!hasText(resourceId)) {
      return badRequest('resourceId is required');
    }

    const productResourceTypes = getProductResourceTypes(product);
    if (productResourceTypes.length === 0) {
      return badRequest(`product ${product} has no FACS resource types configured`);
    }
    const queryParams = getQueryParams(ctx);
    let resourceType;
    if (productResourceTypes.length === 1) {
      [resourceType] = productResourceTypes;
    } else {
      resourceType = queryParams.resourceType;
      if (!productResourceTypes.includes(resourceType)) {
        return badRequest(
          `resourceType query param must be one of [${productResourceTypes.join(', ')}] for product ${product}`,
        );
      }
    }

    const userIdent = resolveCallerUserIdent(ctx);
    const productLower = product.toLowerCase();
    const provenance = {};

    function addProvenance(cap, tag) {
      if (!provenance[cap]) {
        provenance[cap] = [];
      }
      if (!provenance[cap].includes(tag)) {
        provenance[cap].push(tag);
      }
    }

    // 1. JWT facs_permissions for the product.
    const jwtPermissions = ctx.attributes?.authInfo?.getFacsPermissions?.() ?? [];
    for (const perm of jwtPermissions) {
      if (typeof perm === 'string' && perm.startsWith(`${productLower}/`)) {
        addProvenance(perm, 'jwt');
      }
    }

    // 2. State-layer rows for (user, resource) and (org, resource).
    try {
      const { postgrestClient } = ctx.dataAccess.services;
      const baseFilter = {
        imsOrgId,
        product,
        resourceType,
        resourceId,
      };
      const queries = [];
      if (userIdent) {
        queries.push(listFacsAccessMappings(postgrestClient, {
          ...baseFilter,
          subjectType: 'user',
          subjectId: userIdent,
          limit: MAX_PAGE_SIZE,
        }).then((rows) => ({ tag: 'state:user', rows })));
      }
      queries.push(listFacsAccessMappings(postgrestClient, {
        ...baseFilter,
        subjectType: 'org',
        subjectId: imsOrgId,
        limit: MAX_PAGE_SIZE,
      }).then((rows) => ({ tag: 'state:org', rows })));

      const results = await Promise.all(queries);
      for (const { tag, rows } of results) {
        for (const row of rows) {
          for (const cap of row.granted_capabilities ?? []) {
            addProvenance(cap, tag);
          }
        }
      }
    } catch (error) {
      log.error(
        { tag: 'state-access-mappings', err: error.message, resourceId },
        'Failed to compute effective capabilities',
      );
      return internalServerError('Failed to compute effective capabilities');
    }

    return ok({
      product,
      resourceType,
      resourceId,
      capabilities: Object.keys(provenance).sort(),
      provenance,
    });
  }

  return {
    listMappings,
    listHistory,
    createMapping,
    patchMapping,
    revokeMapping,
    getProductCapabilities,
    getUserCapabilities,
  };
}

export default StateAccessMappingsController;
