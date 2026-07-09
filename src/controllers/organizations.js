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
import TierClient from '@adobe/spacecat-shared-tier-client';
import { OrganizationDto } from '../dto/organization.js';
import { ProjectDto } from '../dto/project.js';
import { SiteDto } from '../dto/site.js';
import AccessControlUtil from '../support/access-control-util.js';
import { CAP_ORG_READ_ALL } from '../routes/capability-constants.js';
import {
  filterSitesForProductCode,
  getEntitledProductCodes,
  CUSTOMER_VISIBLE_TIERS,
} from '../support/utils.js';
import { listViewableResourceIds } from '../support/state-access-mapping-utils.js';
import { requirePostgrestForFacsMappings } from '../support/postgrest-availability.js';
import { isFacsRebacResource } from '../routes/facs-capabilities.js';
import {
  ensureOrgEntitlement,
  resolveProductCode,
} from '../support/tier-provisioning.js';

// Cross-product sites-listing scope (SITES-46454, Phase 1 of multi-product login support).
// See mysticat-architecture/platform/decisions/cross-product-sites-listing-via-client-id-scope.md
const SITES_LIST_CROSS_PRODUCT_SCOPE = 'sites:list:cross_product';
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
    // Cross-product bypass: only filter when the current product actually
    // ReBAC-scopes `site` (ASO). Under LLMO, `site` is not a ReBAC resource
    // (LLMO scopes `brand`), so the state layer holds no per-site grants and
    // filtering would wrongly hide every site — return the full list instead.
    let visibleOwnSites = filteredSites;
    const facs = context.attributes?.facs;
    const hasFACSCapability = facs?.enabled
      && context.attributes?.authInfo?.hasFacsPermission?.(`${facs.product.toLowerCase()}/can_view`);
    if (facs?.enabled && !hasFACSCapability && isFacsRebacResource(facs.product, 'site')) {
      const unavailable = requirePostgrestForFacsMappings(context);
      if (unavailable) {
        return unavailable;
      }
      const viewable = await listViewableResourceIds(
        context.dataAccess.services.postgrestClient,
        {
          imsOrgId: organization.getImsOrgId(),
          product: facs.product,
          resourceType: 'site',
          subjectId: facs.subjectId,
        },
      );
      visibleOwnSites = filteredSites.filter((site) => viewable.has(site.getId()));
    }

    return ok([...visibleOwnSites, ...delegatedSites].map((site) => SiteDto.toJSON(site)));
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
        if (!accessControlUtil.hasAdminAccess()) {
          return forbidden('Only admins can update config.defaults');
        }
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
