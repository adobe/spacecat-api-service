/*
 * Copyright 2024 Adobe. All rights reserved.
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
  createResponse,
  badRequest,
  internalServerError,
  notFound,
  ok, forbidden,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText, isNonEmptyObject,
  isObject,
  isString,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import { Response } from '@adobe/fetch';
import TierClient from '@adobe/spacecat-shared-tier-client';
import { OrganizationDto } from '../dto/organization.js';
import { ProjectDto } from '../dto/project.js';
import { SiteDto } from '../dto/site.js';
import { applyFieldProjection } from '../utils/field-projection.js';
import AccessControlUtil from '../support/access-control-util.js';
import { CAP_ORG_READ_ALL } from '../routes/capability-constants.js';
import { filterSitesForProductCode, CUSTOMER_VISIBLE_TIERS, getEntitledProductCodes } from '../support/utils.js';
import { resolveViewableSiteIds } from '../support/facs-site-visibility.js';
import {
  ensureOrgEntitlement,
  resolveProductCode,
} from '../support/tier-provisioning.js';
import { LLMO_SHEETDATA_SOURCE_URL } from './llmo/llmo-utils.js';
import { fetchLlmoSource, llmoSourceErrorResponse } from './llmo/llmo-source.js';

// Cross-product sites-listing scope (SITES-46454, Phase 1 of multi-product login support).
// See mysticat-architecture/platform/decisions/cross-product-sites-listing-via-client-id-scope.md
const SITES_LIST_CROSS_PRODUCT_SCOPE = 'sites:list:cross_product';

// Customer-access-map sheet: per-IMS-org, per-user, time-bounded read access grants for the
// admin-only by-access-map-sheet endpoint. Hosted on the same elmo-ui-data HLX project as other
// LLMO customer sheets, so it uses the same LLMO_HLX_API_KEY-authenticated fetch path.
const ACCESS_MAP_SHEET_URL = `${LLMO_SHEETDATA_SOURCE_URL}/admin-readonly-org-access/customer-access-map.json`;

// Excel/Lotus serial-date epoch offset to Unix epoch, in days (1899-12-30 -> 1970-01-01).
const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Converts an Excel serial date (as found in the "Access Expires At" sheet column) to the
 * end-of-day instant (23:59:59.999) of that calendar day, so a grant remains valid through its
 * entire expiration day regardless of the caller's timezone.
 * @param {string|number} serial - Excel serial date value.
 * @returns {number|null} End-of-day epoch ms, or null if serial is not a finite number.
 */
const excelSerialDateToEndOfDayMs = (serial) => {
  const num = Number(serial);
  if (!Number.isFinite(num)) {
    return null;
  }
  return ((num - EXCEL_EPOCH_OFFSET_DAYS) * MS_PER_DAY) + MS_PER_DAY - 1;
};

/**
 * True for a genuinely empty "Access Expires At" cell (null/undefined/whitespace-only string).
 * Deliberately distinct from "unparsable" (e.g. an ISO date string): both are treated as
 * expired/denied, but a blank cell most likely means the sheet maintainer intended "no expiry"
 * rather than a typo, so it's worth a different log message.
 * @param {*} value - Raw "Access Expires At" cell value.
 * @returns {boolean}
 */
const isBlankExpiry = (value) => value === null
  || value === undefined
  || (typeof value === 'string' && value.trim() === '');

/**
 * Trims and lowercases an IMS org ID (or any other identifier) so that a whitespace-padded or
 * differently-cased sheet cell still matches organization.getImsOrgId(). Mirrors the
 * case-insensitive comparison already used by llmo-utils.js#applyFilters for sheet-row matching.
 * @param {string|undefined|null} imsOrgId - Raw IMS org ID.
 * @returns {string|null} Normalized IMS org ID, or null if not a usable string.
 */
const normalizeImsOrgId = (imsOrgId) => (
  hasText(imsOrgId) ? imsOrgId.trim().toLowerCase() : null
);

/**
 * The authenticated caller's human-readable email. Prefers trial_email (present for trial
 * users), then preferred_username (the RFC-5322 address on enterprise/IMS tokens); profile.email
 * is an IMS user GUID, not a real address, so it is only a last resort. See
 * llmo-akamai.js#getCallerEmail for the same precedence used elsewhere in this repo.
 * @param {object} context - Request context.
 * @returns {string|null} Caller's email, or null when no usable address is present.
 */
const getCallerEmail = (context) => {
  const profile = context?.attributes?.authInfo?.getProfile?.() || {};
  const candidate = [profile.trial_email, profile.preferred_username, profile.email]
    .find((v) => hasText(v));
  return candidate ? candidate.trim() : null;
};
/**
 * Organizations controller. Provides methods to create, read, update and delete organizations.
 * @param {object} ctx - Context of the request.
 * @param {object} env - Environment object.
 * @returns {object} Organizations controller.
 * @constructor
 */
function OrganizationsController(ctx, env) {
  const X_PRODUCT_HEADER = 'x-product';
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  if (!isNonEmptyObject(env)) {
    throw new Error('Environment object required');
  }
  const { SLACK_URL_WORKSPACE_EXTERNAL: slackExternalWorkspaceUrl } = env;
  const {
    Organization, Project, Site, SiteImsOrgAccess, Entitlement, SiteEnrollment,
  } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Creates an organization. The organization ID is generated automatically.
   *
   * Write-time tier provisioning: when an organization is newly created, it ensures org
   * entitlement via TierClient using the existing tier when present, otherwise FREE_TRIAL.
   * Idempotent re-POSTs do not run provisioning.
   *
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Organization response.
   */
  const createOrganization = async (context) => {
    const { log } = ctx;
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create new Organizations');
    }
    const { productCode, error: productCodeError } = resolveProductCode(context);
    if (productCodeError) {
      return badRequest(productCodeError);
    }
    let organization;
    let status;
    // check if the organization already exists
    const existingOrganization = await Organization.findByImsOrgId(context.data.imsOrgId);
    if (existingOrganization) {
      organization = existingOrganization;
      status = 200;
    } else {
      try {
        organization = await Organization.create(context.data);
        status = 201;
      } catch (e) {
        return badRequest(e.message);
      }
    }

    if (productCode && status === 201) {
      try {
        await ensureOrgEntitlement(context, organization, productCode, log);
      } catch (error) {
        log.error(
          `Error ensuring entitlement for organization ${organization.getId()}: ${error.message}`,
          error,
        );
        return internalServerError('Failed to ensure entitlement for organization');
      }
    }

    return createResponse(OrganizationDto.toJSON(organization), status);
  };

  /**
   * Gets all organizations. Accessible to admin callers (legacy admin path) and to S2S
   * consumers that hold the `organization:readAll` capability - see
   * `docs/s2s/READALL_CAPABILITY_DESIGN.md`.
   * @returns {Promise<Response>} Array of organizations response.
   */
  const getAll = async (context) => {
    const { log } = ctx;
    const requestId = context?.invocation?.id || 'unknown';
    // Read-only admin and full admin both bypass the S2S capability check;
    // S2S consumers must hold organization:readAll. See READALL_CAPABILITY_DESIGN.md.
    const isAdmin = accessControlUtil.hasAdminReadAccess();
    const s2sResult = isAdmin
      ? { allowed: false, reason: 'admin-bypass' }
      : await accessControlUtil.hasS2SCapability(CAP_ORG_READ_ALL);
    if (!isAdmin && !s2sResult.allowed) {
      log.info(`[acl] Denied GET /organizations - reason=${s2sResult.reason} clientId=${s2sResult.clientId || 'n/a'} consumerId=${s2sResult.consumerId || 'n/a'} requestId=${requestId}`);
      return forbidden('Forbidden: admin access or organization:readAll capability required');
    }

    const organizations = (await Organization.all())
      .map((organization) => OrganizationDto.toJSON(organization));

    if (s2sResult.allowed) {
      log.info(`[s2s-readall] GET /organizations granted clientId=${s2sResult.clientId} consumerId=${s2sResult.consumerId} capability=${CAP_ORG_READ_ALL} count=${organizations.length} requestId=${requestId}`);
    }

    return ok(organizations);
  };

  /**
   * Gets all organizations that have at least one site onboarded (enrolled) for the given
   * product code (e.g. 'LLMO'). "Onboarded" means a SiteEnrollment row links one of the
   * organization's sites to an entitlement of that product - the same signal used by
   * `getSitesForOrganization` / `filterSitesForProductCode`. Only orgs with a real enrollment
   * are returned, so an org that merely holds an entitlement but has onboarded no site is
   * excluded. Same access model as `getAll`: admin-read callers, or S2S consumers holding
   * `organization:readAll` - see `docs/s2s/READALL_CAPABILITY_DESIGN.md`.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of organizations response.
   */
  /**
   * Collects the DISTINCT organizations that own at least one site enrolled (onboarded) for the
   * given product code. Pages through Site.allByEnrollmentFiltered - a single
   * sites -> site_enrollments!inner -> entitlements!inner query per page, range-paginated -
   * rather than SiteEnrollment.allSiteIdsByProductCode, which is unpaginated and would silently
   * truncate at the PostgREST row cap as enrollments grow.
   * @param {string} productCode - Product code (already validated/uppercased by the caller).
   * @returns {Promise<Array<object>>} Raw Organization model instances (not DTO'd).
   */
  const fetchOrganizationsForProductCode = async (productCode) => {
    const PAGE_SIZE = 1000;
    const orgIds = new Set();
    let cursor;
    do {
      // eslint-disable-next-line no-await-in-loop
      const { data: sites, cursor: nextCursor } = await Site.allByEnrollmentFiltered(
        { productCode },
        { limit: PAGE_SIZE, cursor, returnCursor: true },
      );
      sites.forEach((site) => {
        const orgId = site.getOrganizationId();
        if (hasText(orgId)) {
          orgIds.add(orgId);
        }
      });
      cursor = nextCursor;
    } while (cursor);

    if (orgIds.size === 0) {
      return [];
    }

    const { data: organizations } = await Organization.batchGetByKeys(
      [...orgIds].map((organizationId) => ({ organizationId })),
    );
    return organizations;
  };

  const getByProductCode = async (context) => {
    const { log } = ctx;
    const requestId = context?.invocation?.id || 'unknown';
    // Read-only admin and full admin both bypass the S2S capability check;
    // S2S consumers must hold organization:readAll. See READALL_CAPABILITY_DESIGN.md.
    const isAdmin = accessControlUtil.hasAdminReadAccess();
    const s2sResult = isAdmin
      ? { allowed: false, reason: 'admin-bypass' }
      : await accessControlUtil.hasS2SCapability(CAP_ORG_READ_ALL);
    if (!isAdmin && !s2sResult.allowed) {
      log.info(`[acl] Denied GET /organizations/by-product-code - reason=${s2sResult.reason} clientId=${s2sResult.clientId || 'n/a'} consumerId=${s2sResult.consumerId || 'n/a'} requestId=${requestId}`);
      return forbidden('Forbidden: admin access or organization:readAll capability required');
    }

    const productCode = context.params?.productCode?.toUpperCase();
    const validProductCodes = Object.values(EntitlementModel.PRODUCT_CODES);
    if (!hasText(productCode) || !validProductCodes.includes(productCode)) {
      return badRequest(`Invalid product code. Allowed values: ${validProductCodes.join(', ')}`);
    }

    const organizations = await fetchOrganizationsForProductCode(productCode);
    const result = organizations.map((organization) => OrganizationDto.toJSON(organization));

    if (s2sResult.allowed) {
      log.info(`[s2s-readall] GET /organizations/by-product-code/${productCode} granted clientId=${s2sResult.clientId} consumerId=${s2sResult.consumerId} capability=${CAP_ORG_READ_ALL} count=${result.length} requestId=${requestId}`);
    }

    return ok(result);
  };

  /**
   * Gets all organizations onboarded for the given product code, restricted to the subset the
   * calling admin is allowed to see per the customer-access-map sheet (admin-read-access only,
   * no S2S bypass - unlike getByProductCode).
   *
   * Order of operations: (1) resolve the full by-product-code organization list, (2) fetch the
   * access-map sheet and resolve the caller's allowed IMS org IDs, (3) intersect. If the
   * caller's email is not present in the sheet at all, the full unfiltered list from step 1 is
   * returned. If the email IS present but every row for it is expired, the result is an empty
   * list - an expired grant must never be more permissive than no grant.
   *
   * INVARIANT - do NOT add a `hasS2SCapability(CAP_ORG_READ_ALL)` fallback here. The route is
   * mapped to CAP_ORG_READ_ALL in required-capabilities.js only so readOnlyAdminWrapper takes
   * its read fast-path (this route has no siteId/organizationId for the wrapper's ownership
   * check to resolve) - that mapping also lets an S2S consumer holding organization:readAll
   * pass s2sAuthWrapper, but this controller intentionally checks hasAdminReadAccess() ONLY.
   * That is the single, deliberate gate that keeps this route admin-only end-to-end; adding an
   * S2S fallback here (mirroring getByProductCode) would silently open it to S2S consumers.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of organizations response.
   */
  const getByAccessMapSheet = async (context) => {
    const { log } = ctx;
    const requestId = context?.invocation?.id || 'unknown';

    // Do NOT add an `isAdmin ? ... : hasS2SCapability(...)` dual-layer check here - see the
    // INVARIANT note above. hasAdminReadAccess() is the only intended gate for this route.
    if (!accessControlUtil.hasAdminReadAccess()) {
      log.info(`[acl] Denied GET /organizations/by-access-map-sheet - reason=not-admin requestId=${requestId}`);
      return forbidden('Forbidden: admin access required');
    }

    const productCode = context.params?.productCode?.toUpperCase();
    const validProductCodes = Object.values(EntitlementModel.PRODUCT_CODES);
    if (!hasText(productCode) || !validProductCodes.includes(productCode)) {
      return badRequest(`Invalid product code. Allowed values: ${validProductCodes.join(', ')}`);
    }

    const organizations = await fetchOrganizationsForProductCode(productCode);
    if (organizations.length === 0) {
      return ok([]);
    }

    // The access map restricts by caller identity - if we can't identify the caller, we cannot
    // know what to restrict them to, so we must deny rather than fail open into "email not in
    // map -> unfiltered access".
    const callerEmail = getCallerEmail(context);
    if (!hasText(callerEmail)) {
      log.info(`[access-map] Denied GET /organizations/by-access-map-sheet/${productCode} - reason=no-caller-email requestId=${requestId}`);
      return forbidden('Forbidden: caller email could not be resolved');
    }

    let sheet;
    try {
      ({ data: sheet } = await fetchLlmoSource(context, ACCESS_MAP_SHEET_URL));
    } catch (error) {
      log.error(`Failed to fetch customer access map sheet: ${error.message}`, error);
      return llmoSourceErrorResponse(error) || internalServerError('Failed to fetch customer access map');
    }

    const rows = Array.isArray(sheet?.data) ? sheet.data : [];
    // Case-insensitive match: the IMS token casing and the human-maintained sheet casing are
    // not guaranteed to agree, and a casing mismatch must never fail open into the unfiltered
    // branch below.
    const normalizedCallerEmail = callerEmail.toLowerCase();
    const callerRows = rows.filter((row) => row['User email']?.toLowerCase?.() === normalizedCallerEmail);

    if (callerRows.length === 0) {
      // Caller's email is not present in the access map at all - unfiltered access.
      const result = organizations.map((organization) => OrganizationDto.toJSON(organization));
      log.info(`[access-map] GET /organizations/by-access-map-sheet/${productCode} unfiltered (email not in map) count=${result.length} requestId=${requestId}`);
      return ok(result);
    }

    const now = Date.now();
    const allowedImsOrgIds = new Set(
      callerRows
        .filter((row) => {
          const rawExpiry = row['Access Expires At'];
          const orgId = row['Customer IMS Org Id'];

          // Fail closed either way, but log the two cases distinctly: a blank cell reads as
          // "no expiry" to whoever maintains the sheet, while an unparsable value (e.g. an ISO
          // date string) is most likely a data-entry mistake that would otherwise drop the row
          // with no trace.
          if (isBlankExpiry(rawExpiry)) {
            log.warn(`[access-map] Blank Access Expires At for org "${orgId}" (productCode=${productCode}, requestId=${requestId}) - treating the grant as expired/denied, not indefinite`);
            return false;
          }

          const endOfDayMs = excelSerialDateToEndOfDayMs(rawExpiry);
          if (endOfDayMs === null) {
            log.warn(`[access-map] Unparsable Access Expires At "${rawExpiry}" for org "${orgId}" (productCode=${productCode}, requestId=${requestId}) - treating the grant as expired/denied`);
            return false;
          }

          return endOfDayMs >= now;
        })
        .map((row) => normalizeImsOrgId(row['Customer IMS Org Id']))
        .filter((imsOrgId) => imsOrgId !== null),
    );

    const filtered = organizations.filter((organization) => allowedImsOrgIds
      .has(normalizeImsOrgId(organization.getImsOrgId())));
    const result = filtered.map((organization) => OrganizationDto.toJSON(organization));

    log.info(`[access-map] GET /organizations/by-access-map-sheet/${productCode} filtered count=${result.length} requestId=${requestId}`);

    return ok(result);
  };

  /**
   * Gets an organization by ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<object>} Organization.
   * @throws {Error} If organization ID is not provided.
   */
  const getByID = async (context) => {
    const organizationId = context.params?.organizationId;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound('Organization not found');
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view it');
    }

    return ok(OrganizationDto.toJSON(organization));
  };

  /**
   * Gets an organization by its IMS organization ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<object>} Organization.
   * @throws {Error} If IMS organization ID is not provided, or if not found.
   */
  const getByImsOrgID = async (context) => {
    const imsOrgId = context.params?.imsOrgId;

    if (!hasText(imsOrgId)) {
      return badRequest('IMS org ID required');
    }

    const organization = await Organization.findByImsOrgId(imsOrgId);
    if (!organization) {
      return notFound(`Organization not found by IMS org ID: ${imsOrgId}`);
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view it');
    }

    return ok(OrganizationDto.toJSON(organization));
  };

  /**
   * Gets an organization's Slack configuration by IMS organization ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<object>} Slack config object.
   * @throws {Error} If IMS org ID is not provided, org not found, or Slack config not found.
   */
  const getSlackConfigByImsOrgID = async (context) => {
    if (!accessControlUtil.hasAdminReadAccess()) {
      return forbidden('Only admins can view Slack configurations');
    }
    const response = await getByImsOrgID(context);
    if (response.status !== 200) {
      return response;
    }

    const body = await response.json();
    const slack = body.config?.slack;

    if (hasText(slack?.channel)) {
      // This organization has a Slack channel configured
      return ok({
        ...slack,
        'channel-url': `${slackExternalWorkspaceUrl}/archives/${slack.channel}`,
      });
    }

    return notFound(`Slack config not found for IMS org ID: ${context.params.imsOrgId}`);
  };

  /**
   * Gets all sites for an organization.
   *
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Sites.
   */
  const getSitesForOrganization = async (context) => {
    const organizationId = context.params?.organizationId;
    const { pathInfo } = context;
    const productCode = pathInfo.headers[X_PRODUCT_HEADER];
    if (!hasText(productCode)) {
      return badRequest('Product code required');
    }

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound(`Organization not found by IMS org ID: ${organizationId}`);
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view its sites');
    }

    const ownSites = await Site.allByOrganizationId(organizationId);
    const delegatedSites = [];

    if (SiteImsOrgAccess) {
      try {
        const delegatedEntries = await SiteImsOrgAccess.allByOrganizationIdWithSites(
          organizationId,
        );
        const now = new Date();
        const ownSiteIds = new Set(ownSites.map((s) => s.getId()));

        // First pass: filter to active grants that match the product code
        const activeEntries = delegatedEntries.filter((entry) => {
          const notExpired = !entry.grant.getExpiresAt()
            || new Date(entry.grant.getExpiresAt()) > now;
          return entry.grant.getProductCode() === productCode
            && notExpired
            && entry.site
            && !ownSiteIds.has(entry.site.getId());
        });

        if (activeEntries.length > 0 && Entitlement && SiteEnrollment) {
          // Batch entitlement lookups by unique target org — one Promise.all round, not N+1
          const uniqueTargetOrgIds = [...new Set(
            activeEntries.map((e) => e.grant.getTargetOrganizationId()),
          )];
          const entitlementResults = await Promise.all(
            uniqueTargetOrgIds.map((targetOrgId) => Entitlement.findByIndexKeys({
              organizationId: targetOrgId,
              productCode,
            })),
          );

          // Batch enrollment lookups for all found entitlements — another Promise.all round
          const enrolledByTargetOrg = new Map();
          await Promise.all(
            uniqueTargetOrgIds.map(async (targetOrgId, i) => {
              const entitlement = entitlementResults[i];
              if (entitlement) {
                // PRE_ONBOARD and any future internal tiers
                // are not customer-visible and not allowed for delegation
                if (!CUSTOMER_VISIBLE_TIERS.includes(entitlement.getTier())) {
                  return;
                }

                const enrollments = await SiteEnrollment.allByEntitlementId(entitlement.getId());
                // eslint-disable-next-line max-len
                enrolledByTargetOrg.set(targetOrgId, new Set(enrollments.map((e) => e.getSiteId())));
              }
            }),
          );

          // Only include delegated sites that are enrolled under the target org's entitlement.
          // This ensures delegation cannot grant access to sites the target org is not entitled to.
          for (const entry of activeEntries) {
            const enrolledSiteIds = enrolledByTargetOrg.get(entry.grant.getTargetOrganizationId());
            if (enrolledSiteIds?.has(entry.site.getId())) {
              delegatedSites.push(entry.site);
              ownSiteIds.add(entry.site.getId());
            }
          }
        }
      } catch (err) {
        ctx.log.warn(
          '[Organizations] Failed to load delegated sites, returning own-org sites only',
          err,
        );
      }
    }

    // Cross-product branch (SITES-46454). When the session JWT carries
    // sites:list:cross_product (minted by spacecat-auth-service for allow-listed IMS
    // client_ids), widen the per-product filter to a union across every product the
    // org is entitled to — preserving today's entitlement, tier-visibility, and
    // enrollment gates and dropping only the single-product restriction. Delegated
    // sites are NOT touched; their flow above stays product-pinned to x-product.
    const authInfo = context?.attributes?.authInfo;
    const isCrossProduct = authInfo?.hasScope?.(SITES_LIST_CROSS_PRODUCT_SCOPE) === true;

    let filteredSites;
    if (isCrossProduct) {
      ctx.log.info(`[sites] cross-product listing for org=${organizationId} user=${authInfo?.getProfile?.()?.userId || 'n/a'}`);
      const entitledProductCodes = await getEntitledProductCodes(context, organization);
      const byId = new Map();
      // Sequential (not parallel) so log lines and DB call ordering stay predictable;
      // the entitled-product set is small (one entry per SpaceCat product, currently 3).
      for (const code of entitledProductCodes) {
        // eslint-disable-next-line no-await-in-loop
        const perProduct = await filterSitesForProductCode(
          context,
          organization,
          ownSites,
          code,
          accessControlUtil,
        );
        for (const s of perProduct) {
          byId.set(s.getId(), s);
        }
      }
      filteredSites = [...byId.values()];
    } else {
      // Own sites go through the enrollment filter (delegate org's entitlement).
      // Delegated sites have already been validated against the target org's entitlement above.
      filteredSites = await filterSitesForProductCode(
        context,
        organization,
        ownSites,
        productCode,
        accessControlUtil,
      );
    }

    // ReBAC collection filter. When facsWrapper marks this session as
    // FACS-enrolled and resource-scoped (no org-wide can_view — see
    // context.attributes.facs), narrow the org's OWN sites to those the caller
    // may view via a state-layer grant. Delegated sites are governed by the
    // delegation grant itself and pass through unchanged. Absent flag (admin /
    // internal org / non-ReBAC org / org-wide viewer) => full list.
    //
    // Product-shape bypass: only filter when the current product actually
    // ReBAC-scopes `site` (ASO). Under LLMO, `site` is not a ReBAC resource
    // (LLMO scopes `brand`), so the state layer holds no per-site grants and
    // filtering would wrongly hide every site — return the full list instead.
    //
    // Cross-product (SITES-46454) bypass: when the session carries
    // `sites:list:cross_product` (minted at login via `unique_client_id` or
    // `cdn_origin_verified`), the caller is trusted at the CLIENT level to see
    // the union of sites the org is entitled to across every product. That
    // client-level trust intentionally supersedes the per-user, per-product
    // ReBAC filter — the ReBAC filter is keyed on a single product's `site`
    // resource, and applying it under the cross-product branch would filter
    // out sites from other products that don't have any per-user grant on the
    // FACS-enrolled product (they are still authorised by the client-level
    // scope). Skip the filter entirely in this branch. See
    // mysticat-architecture/platform/decisions/multi-product-login-phase1.md.
    let visibleOwnSites = filteredSites;
    if (!isCrossProduct) {
      const viewable = await resolveViewableSiteIds(context, organization);
      if (viewable instanceof Response) {
        return viewable;
      }
      if (viewable) {
        visibleOwnSites = filteredSites.filter((site) => viewable.has(site.getId()));
      }
    }

    const sites = [...visibleOwnSites, ...delegatedSites].map((site) => SiteDto.toJSON(site));
    const { list, error } = applyFieldProjection(sites, context.data?.fields);
    if (error) {
      return badRequest(error);
    }
    return ok(list);
  };

  /**
   * Removes an organization and all sites/audits associated with it.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Delete response.
   */
  const removeOrganization = async () => forbidden('Restricted Operation');

  /**
   * Updates an organization
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Organization response.
   */
  const updateOrganization = async (context) => {
    const organizationId = context.params?.organizationId;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound('Organization not found');
    }

    const requestBody = context.data;
    if (!isObject(requestBody)) {
      return badRequest('Request body required');
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can update it');
    }

    let updates = false;
    if (isString(requestBody.name) && requestBody.name !== organization.getName()) {
      organization.setName(requestBody.name);
      updates = true;
    }

    if (isString(requestBody.imsOrgId) && requestBody.imsOrgId !== organization.getImsOrgId()) {
      organization.setImsOrgId(requestBody.imsOrgId);
      updates = true;
    }

    if (isString(requestBody.semrushWorkspaceId)
      && requestBody.semrushWorkspaceId !== organization.getSemrushWorkspaceId()) {
      // semrushWorkspaceId binds the Adobe org to a Semrush workspace - billing
      // and access-level concern. Restrict to admins, unlike the other fields
      // that any org member can update.
      if (!accessControlUtil.hasAdminAccess()) {
        return forbidden('Only admins can set semrushWorkspaceId');
      }
      organization.setSemrushWorkspaceId(requestBody.semrushWorkspaceId);
      updates = true;
    }

    if (isObject(requestBody.config)) {
      if (isObject(requestBody.config.defaults)) {
        const VALID_PRODUCT_CODES = new Set(Object.values(EntitlementModel.PRODUCT_CODES));
        for (const [productCode, entry] of Object.entries(requestBody.config.defaults)) {
          if (!VALID_PRODUCT_CODES.has(productCode)) {
            return badRequest(`Unknown product code in config.defaults: ${productCode}`);
          }
          if (isObject(entry) && entry.siteId != null) {
            if (!isValidUUID(entry.siteId)) {
              return badRequest(`Invalid siteId for product ${productCode} in config.defaults`);
            }
            // eslint-disable-next-line no-await-in-loop
            const site = await Site.findById(entry.siteId);
            if (!site || site.getOrganizationId() !== organization.getId()) {
              return badRequest(`config.defaults.${productCode}: site not found or does not belong to this organization`);
            }
            // eslint-disable-next-line no-await-in-loop
            const siteTierClient = await TierClient.createForSite(context, site, productCode);
            // eslint-disable-next-line no-await-in-loop
            const { entitlement, siteEnrollment } = await siteTierClient.checkValidEntitlement();
            if (!entitlement) {
              return badRequest(`config.defaults.${productCode}: organization does not have an entitlement for this product`);
            }
            if (!siteEnrollment) {
              return badRequest(`config.defaults.${productCode}: site is not enrolled for this product`);
            }
          }
        }
      }
      organization.setConfig(requestBody.config);
      updates = true;
    }

    if (updates) {
      const updatedOrganization = await organization.save();
      return ok(OrganizationDto.toJSON(updatedOrganization));
    }

    return badRequest('No updates provided');
  };

  /**
   * Gets all projects for an organization.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Projects for the organization.
   */
  const getProjectsByOrganizationId = async (context) => {
    const organizationId = context.params?.organizationId;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound('Organization not found');
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view its projects');
    }

    const projects = await Project.allByOrganizationId(organizationId);

    // FACS ReBAC filter (mirrors getSitesForOrganization): when the caller is
    // FACS-enrolled and resource-scoped (no org-wide `<product>/can_view`),
    // restrict projects to those containing at least one site the caller may
    // view. Only applies where `site` is a ReBAC resource for the product (ASO,
    // not LLMO which scopes `brand`) — otherwise the state layer holds no
    // per-site grants and filtering would wrongly hide everything.
    const viewable = await resolveViewableSiteIds(context, organization);
    if (viewable instanceof Response) {
      return viewable;
    }
    if (viewable) {
      const orgSites = await Site.allByOrganizationId(organizationId);
      const viewableProjectIds = new Set(
        orgSites
          .filter((site) => viewable.has(site.getId()))
          .map((site) => site.getProjectId())
          .filter(Boolean),
      );
      return ok(
        projects
          .filter((project) => viewableProjectIds.has(project.getId()))
          .map((project) => ProjectDto.toJSON(project)),
      );
    }

    return ok(projects.map((project) => ProjectDto.toJSON(project)));
  };

  /**
   * Gets all sites for an organization by project ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Sites for the organization and project.
   */
  const getSitesByProjectIdAndOrganizationId = async (context) => {
    const { organizationId, projectId } = context.params;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    if (!isValidUUID(projectId)) {
      return badRequest('Project ID required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound('Organization not found');
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view its sites');
    }

    const sites = await Site.allByOrganizationIdAndProjectId(organizationId, projectId);

    return ok(sites.map((site) => SiteDto.toJSON(site)));
  };

  /**
   * Gets all sites for an organization by project name.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Sites for the organization and project.
   */
  const getSitesByProjectNameAndOrganizationId = async (context) => {
    const { organizationId, projectName } = context.params;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    if (!hasText(projectName)) {
      return badRequest('Project name required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound('Organization not found');
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view its sites');
    }

    const sites = await Site.allByOrganizationIdAndProjectName(organizationId, projectName);

    return ok(sites.map((site) => SiteDto.toJSON(site)));
  };

  return {
    createOrganization,
    getAll,
    getByProductCode,
    getByAccessMapSheet,
    getByID,
    getByImsOrgID,
    getSlackConfigByImsOrgID,
    getSitesForOrganization,
    getProjectsByOrganizationId,
    getSitesByProjectIdAndOrganizationId,
    getSitesByProjectNameAndOrganizationId,
    removeOrganization,
    updateOrganization,
  };
}

export default OrganizationsController;
