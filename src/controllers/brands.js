/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { randomUUID } from 'crypto';

import BrandClient, { BrandGovernanceClient } from '@adobe/spacecat-shared-brand-client';
import {
  badRequest,
  notFound,
  ok,
  createResponse,
  forbidden,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode, getImsUserToken, getImsUserTokenStrict } from '../support/utils.js';
import { hostnameFromUrlString } from '../support/url-utils.js';
import {
  STATUS_BAD_REQUEST,
} from '../utils/constants.js';
import AccessControlUtil from '../support/access-control-util.js';
import {
  listPrompts,
  getPromptById,
  upsertPrompts,
  updatePromptById,
  deletePromptById,
  bulkDeletePrompts,
  checkPromptsExist,
  getPromptStats,
  resolveBrandUuid,
  findPromptsBlockingRegionRemoval,
} from '../support/prompts-storage.js';
import {
  listBrands,
  upsertBrand,
  updateBrand,
  deleteBrand,
  setBrandStatus,
  getBrandById,
  getBrandBySite,
  getBrandCompetitors,
} from '../support/brands-storage.js';
import { provisionBrandSubworkspace, releaseProvisionedWorkspace } from '../support/serenity/brand-provisioning.js';
import { ensureMarketSite } from '../support/serenity/site-linkage.js';
import { createSerenityTransport, SerenityTransportError } from '../support/serenity/rest-transport.js';
import { syncBrandUrlsAcrossMarkets } from '../support/serenity/brand-urls.js';
import { syncBrandAliasesAcrossMarkets } from '../support/serenity/brand-aliases.js';
import { resolveProjects } from '../support/serenity/resolve-projects.js';
import {
  buildReservedDomains,
  dropReservedCompetitors,
  removedCompetitorDomains,
  syncCompetitorBenchmarksAcrossMarkets,
} from '../support/serenity/competitor-benchmarks.js';
import {
  resolveLlmoOnboardingMode,
  LLMO_ONBOARDING_MODE_V2,
} from '../support/llmo-onboarding-mode.js';
import { createIntentClassifier } from '../support/intent-classifier.js';
import { emitMetric, resolveEnvironment } from '../support/metrics-emf.js';
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from '../support/categories-storage.js';
import {
  listTopics,
  createTopic,
  updateTopic,
  deleteTopic,
} from '../support/topics-storage.js';

const HEADER_ERROR = 'x-error';
const BRAND_GUIDANCE_MAX_LENGTH = 4000;
const BRAND_GUIDANCE_FIELDS = ['brandContext', 'mentionSentimentGuidance'];

/**
 * Derives the brand domain (hostname) from a brand-create payload's URLs, used as
 * the Semrush project `domain` when provisioning a Semrush-mode brand. Takes the
 * first non-empty URL (the primary), tolerating bare hostnames and missing
 * schemes. Returns null when no usable URL is present.
 */
function brandDomainFromPayload(brandData) {
  const urls = Array.isArray(brandData?.urls) ? brandData.urls : [];
  const first = urls
    .map((u) => (typeof u === 'string' ? u : u?.value))
    .find(hasText);
  return hostnameFromUrlString(first);
}

/**
 * BrandsController. Provides methods to read brands and brand guidelines.
 * @param {object} ctx - Context of the request.
 * @param {Object} env - Environment object.
 * @returns {object} Brands controller.
 * @constructor
 */
function BrandsController(ctx, log, env) {
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
  const { Organization, Site } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  // Best-effort P1 alerting signal (LLMO-5587): a write path tried to silently demote
  // an active brand to pending and was rejected. Alarm on the count (Mysticat/Brands ->
  // BrandDemotionBlocked); attribute the specific caller via the WARN log that follows.
  // Modeled on the LLMO-5150 EMF pattern. Never affects the response.
  const BRAND_METRICS_NAMESPACE = 'Mysticat/Brands';
  const emitBrandDemotionBlocked = (context, operation) => {
    try {
      emitMetric(
        {
          name: 'BrandDemotionBlocked',
          dimensions: {
            Operation: operation,
            Product: context?.pathInfo?.headers?.['x-product'],
          },
        },
        { environment: resolveEnvironment(env), namespace: BRAND_METRICS_NAMESPACE },
      );
      log.warn(`BrandDemotionBlocked: ${operation} attempted an active->pending demotion `
        + `(org=${context?.params?.spaceCatId}, brand=${context?.params?.brandId}, `
        + `updatedBy=${context?.attributes?.authInfo?.profile?.sub || 'system'}); rejected — `
        + 'use PATCH /v2/orgs/{spaceCatId}/brands/{brandId}/status for intentful transitions.');
    } catch {
      // best-effort: metric/log emission must never affect the request path
    }
  };

  // Best-effort intent classifier for prompts that arrive without an intent
  // (human-added). Returns null when disabled by config or Azure OpenAI is not
  // configured, in which case intent is simply left null. Built once per
  // controller instance and passed into the prompt storage layer.
  const classifyIntent = createIntentClassifier({ env, log });

  /**
   * Fetches an organization by ID and returns a 404 error if not found.
   * @param {string} orgId - Organization ID
   * @returns {Promise<object|Response>} Organization object or 404 Response
   */
  async function getOrganizationOrNotFound(orgId) {
    const organization = await Organization.findById(orgId);
    if (!organization) {
      return notFound(`Organization not found: ${orgId}`);
    }
    return organization;
  }

  /**
   * Returns 503 if PostgREST client is not available (v2 config requires Postgres).
   * @param {object} context - Request context
   * @returns {Response|null} 503 response or null if postgrestClient is available
   */
  function requirePostgrestForV2Config(context) {
    const postgrestClient = context.dataAccess?.services?.postgrestClient;
    if (!postgrestClient?.from) {
      return createResponse(
        { message: 'V2 customer config requires Postgres (DATA_SERVICE_PROVIDER=postgres)' },
        503,
      );
    }
    return null;
  }

  /**
   * Get query parameters from context
   * @param {object} context - The request context
   * @returns {object} Parsed query parameters
   */
  function getQueryParams(context) {
    const rawQueryString = context.invocation?.event?.rawQueryString;
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

  function createErrorResponse(error) {
    // A Semrush upstream error's message embeds the gateway URL (internal host +
    // workspace/project UUIDs); never echo it to the client (body or x-error
    // header). Return a generic message and keep the detail to the log. Mirrors
    // the serenity controller's mapError hygiene.
    if (error instanceof SerenityTransportError) {
      const status = (error.status === 401 || error.status === 403) ? error.status : 502;
      const message = status === 502 ? 'Upstream request failed' : 'Upstream authorization failed';
      return createResponse({ message }, status, { [HEADER_ERROR]: message });
    }
    if (error.status) {
      return createResponse({ message: error.message }, error.status, {
        [HEADER_ERROR]: error.message,
      });
    }
    return internalServerError(error.message);
  }

  function validateBrandGuidanceFields(brandData = {}) {
    for (const field of BRAND_GUIDANCE_FIELDS) {
      const value = brandData[field];
      if (value !== undefined && value !== null) {
        if (typeof value !== 'string') {
          return badRequest(`${field} must be a string or null`);
        }
        // Validate the trimmed length: storage trims before persisting, so this
        // mirrors what is actually stored (and the schema's maxLength).
        if (value.trim().length > BRAND_GUIDANCE_MAX_LENGTH) {
          return badRequest(`${field} must be at most ${BRAND_GUIDANCE_MAX_LENGTH} characters`);
        }
      }
    }
    return null;
  }

  /**
   * Gets all brands for an organization.
   * @returns {Promise<Response>} Array of brands.
   */
  const getBrandsForOrganization = async (context) => {
    const organizationId = context.params?.organizationId;
    try {
      if (!isValidUUID(organizationId)) {
        return badRequest('Organization ID required');
      }

      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound(`Organization not found: ${organizationId}`);
      }

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('Only users belonging to the organization can view its brands');
      }

      const imsOrgId = organization.getImsOrgId();
      const imsUserToken = getImsUserToken(context);
      const brandClient = BrandClient.createFrom(context);
      const brands = await brandClient.getBrandsForOrganization(imsOrgId, `Bearer ${imsUserToken}`);
      return ok(brands);
    } catch (error) {
      log.error(`Error getting brands for organization: ${organizationId}`, error);
      return createErrorResponse(error);
    }
  };

  /**
   * Gets IMS config from the environment.
   * @returns {object} imsConfig - The IMS config.
   */
  function getImsConfig() {
    const {
      BRAND_IMS_HOST: host,
      BRAND_IMS_CLIENT_ID: clientId,
      BRAND_IMS_CLIENT_CODE: clientCode,
      BRAND_IMS_CLIENT_SECRET: clientSecret,
    } = env;
    if (!hasText(host) || !hasText(clientId) || !hasText(clientCode) || !hasText(clientSecret)) {
      throw new ErrorWithStatusCode('IMS Config not found in the environment', STATUS_BAD_REQUEST);
    }
    return {
      host,
      clientId,
      clientCode,
      clientSecret,
    };
  }

  /**
   * Gets IMS config for the Brand Governance Agent from the environment.
   * Returns null if Brand Governance is not configured in this environment.
   * @returns {object|null} Brand Governance IMS config or null.
   */
  function getImsConfigForBrandGovernance() {
    const {
      IMS_HOST: host,
      BRAND_GOV_IMS_CLIENT_ID: clientId,
      BRAND_GOV_IMS_CLIENT_CODE: clientCode,
      BRAND_GOV_IMS_CLIENT_SECRET: clientSecret,
    } = env;
    if (!hasText(host) || !hasText(clientId) || !hasText(clientCode) || !hasText(clientSecret)) {
      return null;
    }
    return {
      host, clientId, clientCode, clientSecret,
    };
  }

  /**
   * Gets Brand Guidelines for a site.
   *
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Brand Guidelines.
   */
  const getBrandGuidelinesForSite = async (context) => {
    const siteId = context.params?.siteId;
    try {
      if (!isValidUUID(siteId)) {
        return badRequest('Site ID required');
      }

      const site = await Site.findById(siteId);
      if (!site) {
        return notFound(`Site not found: ${siteId}`);
      }
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Only users belonging to the organization of the site can view its brand guidelines');
      }

      const organizationId = site.getOrganizationId();
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound(`Organization not found for site: ${siteId}`);
      }
      const imsOrgId = organization.getImsOrgId();

      // Try Brand Governance Agent first (URL-based lookup, no brandId required)
      const govConfig = getImsConfigForBrandGovernance();
      if (govConfig) {
        try {
          const brandGovClient = BrandGovernanceClient.createFrom(context);
          const brandGovGuidelines = await brandGovClient.getBrandGuidelinesForUrl(
            site.getBaseURL(),
            imsOrgId,
            govConfig,
          );
          if (brandGovGuidelines) {
            return ok(brandGovGuidelines);
          }
        } catch (govError) {
          log.warn(`Brand Governance Agent failed for site ${siteId}, falling back to Brand Publish: ${govError.message}`);
        }
      }

      // Fall back to Adobe Brand Publish (requires brandId + userId in site config)
      const brandId = site.getConfig()?.getBrandConfig()?.brandId;
      const userId = site.getConfig()?.getBrandConfig()?.userId;
      if (!hasText(brandId) || !hasText(userId)) {
        return notFound(`Brand config is missing, brandId or userId for site ID: ${siteId}`);
      }
      const imsConfig = getImsConfig();
      const brandClient = BrandClient.createFrom(context);
      const brandGuidelines = await brandClient.getBrandGuidelines(
        { brandId, userId },
        imsOrgId,
        imsConfig,
      );
      return ok(brandGuidelines);
    } catch (error) {
      log.error(`Error getting brand guidelines for site: ${siteId}`, error);
      return createErrorResponse(error);
    }
  };

  // ── Brand-scoped prompts CRUD (Aurora) ──

  const listPromptsByBrand = async (context) => {
    const { spaceCatId, brandId } = context.params || {};
    const {
      limit, page, categoryId, topicId, status,
      search, region, origin, sort, order,
    } = getQueryParams(context);

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }

      const limitNum = Number(limit);
      if (limit !== undefined && (Number.isNaN(limitNum) || limitNum < 1 || limitNum > 5000)) {
        return badRequest('Limit must be between 1 and 5000');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      const result = await listPrompts({
        organizationId: spaceCatId,
        brandId: brandUuid,
        categoryId,
        topicId,
        status,
        search,
        region,
        origin,
        sort,
        order,
        limit,
        page,
        postgrestClient,
      });

      return ok(result);
    } catch (error) {
      log.error(`Error listing prompts for brand ${brandId}:`, error);
      return createErrorResponse(error);
    }
  };

  const getPromptByBrandAndId = async (context) => {
    const { spaceCatId, brandId, promptId } = context.params || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }
      if (!hasText(promptId)) {
        return badRequest('Prompt ID required');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      const prompt = await getPromptById({
        organizationId: spaceCatId,
        brandUuid,
        promptId,
        postgrestClient,
      });

      if (!prompt) {
        return notFound(`Prompt not found: ${promptId}`);
      }
      return ok(prompt);
    } catch (error) {
      log.error(`Error getting prompt ${promptId}:`, error);
      return createErrorResponse(error);
    }
  };

  const createPromptsByBrand = async (context) => {
    const { spaceCatId, brandId } = context.params || {};
    const prompts = context.data;

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }
      if (!Array.isArray(prompts) || prompts.length === 0) {
        return badRequest('Prompts array required (min 1, max 3000)');
      }
      if (prompts.length > 3000) {
        return badRequest('Maximum 3000 prompts per request');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      const { created, updated, prompts: outPrompts } = await upsertPrompts({
        organizationId: spaceCatId,
        brandUuid,
        prompts,
        postgrestClient,
        updatedBy,
        classifyIntent,
      });

      return createResponse({ created, updated, prompts: outPrompts }, 201);
    } catch (error) {
      if (error?.status === 409) {
        log.warn(`Prompt unique-constraint conflict for brand ${brandId} (org ${spaceCatId}): ${error.message}`);
        return createErrorResponse(error);
      }
      log.error(`Error creating prompts for brand ${brandId}:`, error);
      return createErrorResponse(error);
    }
  };

  const updatePromptByBrandAndId = async (context) => {
    const { spaceCatId, brandId, promptId } = context.params || {};
    const updates = context.data || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }
      if (!hasText(promptId)) {
        return badRequest('Prompt ID required');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      const prompt = await updatePromptById({
        organizationId: spaceCatId,
        brandUuid,
        promptId,
        updates,
        postgrestClient,
        updatedBy,
        classifyIntent,
      });

      if (!prompt) {
        return notFound(`Prompt not found: ${promptId}`);
      }
      return ok(prompt);
    } catch (error) {
      log.error(`Error updating prompt ${promptId}:`, error);
      return createErrorResponse(error);
    }
  };

  const deletePromptByBrandAndId = async (context) => {
    const { spaceCatId, brandId, promptId } = context.params || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }
      if (!hasText(promptId)) {
        return badRequest('Prompt ID required');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      const deleted = await deletePromptById({
        organizationId: spaceCatId,
        brandUuid,
        promptId,
        postgrestClient,
        updatedBy,
      });

      if (!deleted) {
        return notFound(`Prompt not found: ${promptId}`);
      }
      return createResponse(null, 204);
    } catch (error) {
      log.error(`Error deleting prompt ${promptId}:`, error);
      return createErrorResponse(error);
    }
  };

  const bulkDeletePromptsByBrand = async (context) => {
    const { spaceCatId, brandId } = context.params || {};
    const body = context.data || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }

      const { promptIds } = body;
      if (!Array.isArray(promptIds) || promptIds.length === 0) {
        return badRequest('promptIds array required (min 1, max 100)');
      }
      if (promptIds.length > 100) {
        return badRequest('Maximum 100 prompt IDs per request');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      const result = await bulkDeletePrompts({
        organizationId: spaceCatId,
        brandUuid,
        promptIds,
        postgrestClient,
        updatedBy,
      });

      return ok(result);
    } catch (error) {
      log.error(`Error bulk deleting prompts for brand ${brandId}:`, error);
      return createErrorResponse(error);
    }
  };

  // ── Prompt existence check (v2) ──

  const checkPromptsByBrand = async (context) => {
    const { spaceCatId, brandId } = context.params || {};
    const body = context.data || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }

      const { prompts } = body;
      if (!Array.isArray(prompts) || prompts.length === 0) {
        return badRequest('"prompts" array required (min 1)');
      }
      if (prompts.length > 500) {
        return badRequest('Maximum 500 prompt pairs per request');
      }
      if (prompts.some((p) => !p || typeof p !== 'object' || !p.text?.trim() || !p.region?.trim() || p.text.length > 2000)) {
        return badRequest('Each prompt must have "text" (max 2000 chars) and "region"');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      const results = await checkPromptsExist({ brandUuid, prompts, postgrestClient });
      return ok({ results });
    } catch (error) {
      log.error('Error checking prompts existence', { brandId, error });
      return createErrorResponse(error);
    }
  };

  const getPromptStatsByBrand = async (context) => {
    const { spaceCatId, brandId } = context.params || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      const stats = await getPromptStats({
        organizationId: spaceCatId,
        brandUuid,
        postgrestClient,
      });

      return ok(stats);
    } catch (error) {
      log.error('Error fetching prompt stats', { brandId, error });
      return createErrorResponse(error);
    }
  };

  // ── Brand list (v2, reads from normalized tables) ──

  const getBrandForOrg = async (context) => {
    const { spaceCatId, brandId } = context.params || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      const brand = await getBrandById(spaceCatId, brandUuid, postgrestClient);
      if (!brand) {
        return notFound(`Brand not found: ${brandId}`);
      }

      return ok(brand);
    } catch (error) {
      log.error(`Error getting brand ${brandId} for organization ${spaceCatId}:`, error);
      return createErrorResponse(error);
    }
  };

  /**
   * Resolves the active brand for a (organization, site) pair.
   *
   * Gated by `resolveLlmoOnboardingMode` — returns 404 when the org is in v1
   * mode (neither brandalf nor brandalf_migration set, or kill-switch
   * downgrade). When v2 and an active brand row exists with
   * `brands.site_id === siteId` (the authoritative site mapping per
   * LLMO-4592), returns the full V2 brand object so callers can pick `id`
   * (or any other field).
   *
   * @returns {Promise<Response>} The active brand, or 404.
   */
  const getBrandForOrgSite = async (context) => {
    const { spaceCatId, siteId } = context.params || {};

    try {
      if (!hasText(spaceCatId) || !isValidUUID(spaceCatId)) {
        return badRequest('Organization ID (valid UUID) is required');
      }
      if (!hasText(siteId) || !isValidUUID(siteId)) {
        return badRequest('Site ID (valid UUID) is required');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const site = await Site.findById(siteId);
      if (!site) {
        return notFound(`Site not found: ${siteId}`);
      }
      if (site.getOrganizationId() !== spaceCatId) {
        return forbidden('Site does not belong to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      // readOnly: true keeps this GET endpoint idempotent — the resolver's
      // kill-switch remediation (which writes to feature_flags) only fires
      // from explicit onboarding/admin write paths, never from a high-traffic
      // resolver hit by BP refresh and the DRS scheduler.
      const mode = await resolveLlmoOnboardingMode(spaceCatId, context, {
        readOnly: true,
      });
      if (mode !== LLMO_ONBOARDING_MODE_V2) {
        return notFound('No v2 brand configured for this organization');
      }

      const { postgrestClient } = context.dataAccess.services;
      const brand = await getBrandBySite(spaceCatId, siteId, postgrestClient, log);
      if (!brand) {
        return notFound(`No active brand for site ${siteId}`);
      }

      return ok(brand);
    } catch (error) {
      log.error(
        `Error resolving brand for org ${spaceCatId} site ${siteId}:`,
        error,
      );
      return createErrorResponse(error);
    }
  };

  const listBrandsForOrg = async (context) => {
    const { spaceCatId } = context.params || {};
    const { status } = getQueryParams(context);

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const brands = await listBrands(spaceCatId, postgrestClient, { status });
      return ok({ brands });
    } catch (error) {
      log.error(`Error listing brands for organization ${spaceCatId}:`, error);
      return createErrorResponse(error);
    }
  };

  const listCategoriesForOrg = async (context) => {
    const { spaceCatId } = context.params || {};
    const { status } = getQueryParams(context);

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      // eslint-disable-next-line max-len
      const categories = await listCategories({ organizationId: spaceCatId, postgrestClient, status });
      return ok({ categories });
    } catch (error) {
      log.error(`Error listing categories for organization ${spaceCatId}:`, error);
      return createErrorResponse(error);
    }
  };

  // ── Category CRUD (v2) ──

  const createCategoryForOrg = async (context) => {
    const { spaceCatId } = context.params || {};
    const categoryData = context.data;

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!isNonEmptyObject(categoryData)) {
        return badRequest('Category data is required');
      }
      if (!hasText(categoryData.name)) {
        return badRequest('Category name is required');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const { category, created, outcome } = await createCategory({
        organizationId: spaceCatId,
        category: categoryData,
        postgrestClient,
        updatedBy,
        log,
      });

      // Log-storm quantification tag: lets Coralogix aggregate
      // category_post_result by outcome so the LLMO-4370 cleanup can be
      // quantified post-deploy (insert/resurrect/update/noop/race_retry*)
      // without grepping messages. LLMO-4370 #15.
      log.info(`Category POST resolved for organization ${spaceCatId}`, {
        organization_id: spaceCatId,
        category_uuid: category.id,
        outcome,
      });

      // 201 on insert, 200 on idempotent update — lets callers (UI toast,
      // DRS audit log) distinguish "created new" from "ensured existing".
      return createResponse(category, created ? 201 : 200);
    } catch (error) {
      // Storage is idempotent by name on the happy path, but still raises
      // a typed 409 on the concurrent hard-delete race (row vanishes
      // between lookup and update) and on non-name uniqueness collisions
      // (slug drift). Those are retry signals, not server faults — warn,
      // don't error, to keep Coralogix ERROR severity clean. LLMO-4370 #2.
      if (error?.status === 409) {
        log.warn(`Category conflict for organization ${spaceCatId}: ${error.message}`);
      } else {
        log.error(`Error creating category for organization ${spaceCatId}:`, error);
      }
      return createErrorResponse(error);
    }
  };

  const updateCategoryForOrg = async (context) => {
    const { spaceCatId, categoryId } = context.params || {};
    const updates = context.data || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(categoryId)) {
        return badRequest('Category ID required');
      }
      if (!isValidUUID(categoryId)) {
        return badRequest('Category ID must be a valid UUID');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const updated = await updateCategory({
        organizationId: spaceCatId,
        categoryId,
        updates,
        postgrestClient,
        updatedBy,
      });

      if (!updated) {
        return notFound(`Category not found: ${categoryId}`);
      }
      return ok(updated);
    } catch (error) {
      // PATCH to a name colliding with a sibling row in the same org
      // surfaces from storage as a typed 409. Mirror the POST handler so
      // legitimate name-conflict retries don't pollute ERROR severity.
      if (error?.status === 409) {
        log.warn(`Category update conflict for organization ${spaceCatId}: ${error.message}`);
      } else {
        log.error(`Error updating category ${categoryId} for organization ${spaceCatId}:`, error);
      }
      return createErrorResponse(error);
    }
  };

  const deleteCategoryForOrg = async (context) => {
    const { spaceCatId, categoryId } = context.params || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(categoryId)) {
        return badRequest('Category ID required');
      }
      if (!isValidUUID(categoryId)) {
        return badRequest('Category ID must be a valid UUID');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const deleted = await deleteCategory({
        organizationId: spaceCatId,
        categoryId,
        postgrestClient,
        updatedBy,
      });

      if (!deleted) {
        return notFound(`Category not found: ${categoryId}`);
      }
      return createResponse(null, 204);
    } catch (error) {
      log.error(`Error deleting category ${categoryId} for organization ${spaceCatId}:`, error);
      return createErrorResponse(error);
    }
  };

  // ── Topic CRUD (v2) ──

  const listTopicsForOrg = async (context) => {
    const { spaceCatId } = context.params || {};
    const { status, brandId } = getQueryParams(context);

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const topics = await listTopics({
        organizationId: spaceCatId, postgrestClient, status, brandId,
      });
      return ok({ topics });
    } catch (error) {
      log.error(`Error listing topics for organization ${spaceCatId}:`, error);
      return createErrorResponse(error);
    }
  };

  const createTopicForOrg = async (context) => {
    const { spaceCatId } = context.params || {};
    const topicData = context.data;

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!isNonEmptyObject(topicData)) {
        return badRequest('Topic data is required');
      }
      if (!hasText(topicData.name)) {
        return badRequest('Topic name is required');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const created = await createTopic({
        organizationId: spaceCatId,
        topic: topicData,
        postgrestClient,
        updatedBy,
        log,
      });

      return createResponse(created, 201);
    } catch (error) {
      if (error?.status === 409) {
        // Warn (not error) — DRS-style idempotent retries stop polluting
        // ERROR severity, but legitimate duplicate-submit bugs (UI double-
        // click, malformed payload) remain visible at WARN for triage.
        log.warn(`Topic conflict for organization ${spaceCatId}: ${error.message}`);
      } else {
        log.error(`Error creating topic for organization ${spaceCatId}:`, error);
      }
      return createErrorResponse(error);
    }
  };

  const updateTopicForOrg = async (context) => {
    const { spaceCatId, topicId } = context.params || {};
    const updates = context.data || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(topicId)) {
        return badRequest('Topic ID required');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const updated = await updateTopic({
        organizationId: spaceCatId,
        topicId,
        updates,
        postgrestClient,
        updatedBy,
      });

      if (!updated) {
        return notFound(`Topic not found: ${topicId}`);
      }
      return ok(updated);
    } catch (error) {
      log.error(`Error updating topic ${topicId} for organization ${spaceCatId}:`, error);
      return createErrorResponse(error);
    }
  };

  const deleteTopicForOrg = async (context) => {
    const { spaceCatId, topicId } = context.params || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(topicId)) {
        return badRequest('Topic ID required');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const deleted = await deleteTopic({
        organizationId: spaceCatId,
        topicId,
        postgrestClient,
        updatedBy,
      });

      if (!deleted) {
        return notFound(`Topic not found: ${topicId}`);
      }
      return createResponse(null, 204);
    } catch (error) {
      log.error(`Error deleting topic ${topicId} for organization ${spaceCatId}:`, error);
      return createErrorResponse(error);
    }
  };

  // ── Brand CRUD (v2) ──

  const createBrandForOrg = async (context) => {
    const { spaceCatId } = context.params || {};
    const brandData = context.data;

    // Hoisted above the try so the catch can run compensation: if a Semrush
    // sub-workspace was provisioned but the brand row failed to persist, the
    // catch releases the orphaned allocation (see below).
    let provisionedWorkspaceId = null;

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!isNonEmptyObject(brandData)) {
        return badRequest('Brand data is required');
      }
      if (!hasText(brandData.name)) {
        return badRequest('Brand name is required');
      }
      const invalidGuidance = validateBrandGuidanceFields(brandData);
      if (invalidGuidance) {
        return invalidGuidance;
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      // Semrush-prompts mode (serenity dual-mode): the UI sends an initial market
      // (location + language). Provision the brand's Semrush sub-workspace +
      // project FIRST, and only write the brand row once that succeeds — so a
      // brand never exists without a valid Semrush side. The pre-generated id is
      // the sub-workspace title key and is forced onto the row.
      let provisionedBrandId = null;
      // The initial market's domain, resolved once during provisioning and reused
      // by the site-mirror hook below (avoids re-deriving from the payload).
      let provisionedBrandDomain = null;
      // A pending (draft) brand defers ALL Semrush provisioning: no
      // sub-workspace, no project, and crucially no primary URL required. The
      // wizard's "Save as pending" path lands here so a user can stash a brand
      // before picking its primary URL.
      const isPendingBrand = brandData.status === 'pending';
      const { semrushMarket } = brandData;
      const hasSemrushMarket = isNonEmptyObject(semrushMarket);
      // generatePrompts (default false) gates topic/prompt generation ONLY. The
      // wizard sends it as an explicit boolean for every Semrush-mode create, so
      // its presence ALSO signals Semrush mode even when no market was picked —
      // a bare "save and continue later" draft (location/language optional).
      const generatePrompts = brandData.generatePrompts === true;
      // The wizard always sends `generatePrompts` as an explicit boolean for a
      // Semrush-mode create; a flat (non-Semrush) create omits it entirely. So
      // the mere PRESENCE of the flag (true OR false) is itself a Semrush-mode
      // signal — but see below: only trusted for a draft.
      const hasGeneratePromptsFlag = typeof brandData.generatePrompts === 'boolean';
      // A draft (pending) brand may legitimately be a "sub-workspace-only Semrush
      // brand, save and continue later": no market, generatePrompts:false. The
      // flag's presence is what marks it as Semrush mode (see
      // normalizePendingSemrushProvisioning, which stashes a bare no-prompt draft).
      const isSubworkspaceOnlyDraft = isPendingBrand && hasGeneratePromptsFlag;
      // Semrush-mode detection. A LIVE create must carry a POSITIVE signal — a
      // picked market, or generatePrompts:true (which itself requires a market,
      // enforced below). We deliberately do NOT treat the mere presence of the
      // flag as the signal on the live path: a flat caller that defensively sends
      // `generatePrompts:false` must not be pulled into Semrush provisioning (it
      // would 400 for a missing primary URL, or worse, provision a sub-workspace
      // for a brand never meant to have one). Presence is trusted ONLY for a draft.
      const isSemrushMode = hasSemrushMarket || generatePrompts || isSubworkspaceOnlyDraft;
      if (isSemrushMode) {
        let market;
        let languageCode;
        if (hasSemrushMarket) {
          ({ market, languageCode } = semrushMarket);
          if (!hasText(market) || !hasText(languageCode)) {
            return badRequest('semrushMarket requires market and languageCode');
          }
        } else if (generatePrompts) {
          // Generating prompts needs a project, which needs a (market, language).
          return badRequest('market and languageCode are required when generatePrompts is true');
        }
        if (isPendingBrand) {
          // Defer provisioning: persist the chosen (market, languageCode) AND
          // the primary URL (if the user entered one before saving as pending)
          // on the brand, so activation can provision the real sub-workspace +
          // project later (stored in brands.pending_semrush_provisioning). The primary
          // URL otherwise lives only on the Semrush side, so a site-less draft
          // would have nowhere to keep it. The row lands as 'pending' because it
          // has no anchor (no site_id, no semrush_workspace_id) — see
          // upsertBrand's anchor check.
          const primaryUrl = (Array.isArray(brandData.urls) ? brandData.urls : [])
            .map((u) => (typeof u === 'string' ? u : u?.value))
            .find(hasText) || null;
          // AI models (LLMs) the wizard collected. Unlike the direct-provision
          // path they are NOT required here — a draft can be saved before the
          // user picks any, and they can be edited per-market later from the
          // Markets tab. Seed the initial market's modelIds with them when
          // present so activation applies them; omit the key entirely when none
          // were chosen (mirrors normalizePendingSemrushProvisioning).
          const seedModelIds = Array.isArray(brandData.semrushModelIds)
            ? brandData.semrushModelIds.filter(hasText)
            : [];
          // A no-prompt draft may carry NO market at all (location/language are
          // optional then) — stash only the market actually picked. The activate
          // flow already handles 0..N stashed markets: an empty list + a primary
          // URL provisions a single US/EN fallback project, and an empty list +
          // no URL provisions a sub-workspace-only brand.
          // TODO: the wizard creates at most one market today; if multi-market
          // draft creation is added, build this array from all selected markets.
          const markets = [];
          if (hasSemrushMarket) {
            const initialMarket = { market, languageCode };
            if (seedModelIds.length > 0) {
              initialMarket.modelIds = seedModelIds;
            }
            markets.push(initialMarket);
          }
          brandData.pendingSemrushProvisioning = {
            primaryUrl,
            markets,
            generatePrompts,
          };
        } else {
          const brandDomain = brandDomainFromPayload(brandData);
          if (!hasText(brandDomain)) {
            return badRequest('A primary URL is required to provision a Semrush brand');
          }
          provisionedBrandDomain = brandDomain;
          // A prompt-generating project needs at least one AI model (LLM) to
          // track. The wizard collects them; reject a prompt-generating Semrush
          // create that omits them. With generatePrompts=false the project is
          // created empty, so models are optional (it tracks nothing until the
          // user adds them later).
          const modelIds = Array.isArray(brandData.semrushModelIds)
            ? brandData.semrushModelIds.filter(hasText)
            : [];
          if (generatePrompts && modelIds.length === 0) {
            return badRequest('semrushModelIds must list at least one AI model to track');
          }
          // Brand aliases drive branded/non-branded prompt classification and the
          // project brand_names. Normalize to `{ name, regions }` (accepting both
          // payload shapes: plain strings — region-less — or `{ name, regions }`),
          // keeping `regions` so the create handler region-clamps each alias to the
          // initial market.
          const brandAliases = Array.isArray(brandData.brandAliases)
            ? brandData.brandAliases
              .map((a) => (typeof a === 'string'
                ? { name: a, regions: [] }
                : { name: a?.name, regions: a?.regions || [] }))
              .filter((a) => hasText(a.name))
            : [];
          // Brand URLs (own sites + social + earned) are pushed onto the initial
          // market's project benchmark. The row isn't written yet, so they come
          // straight from the create payload (same V2 shape upsertBrand persists).
          const brandUrlSources = {
            urls: brandData.urls,
            socialAccounts: brandData.socialAccounts,
            earnedContent: brandData.earnedContent,
          };
          provisionedBrandId = randomUUID();
          const provisioned = await provisionBrandSubworkspace(context, {
            spaceCatId,
            brandId: provisionedBrandId,
            brandName: brandData.name,
            // market/languageCode may be undefined when generatePrompts=false and
            // no market was picked — provisionBrandSubworkspace falls back to US/EN.
            market,
            languageCode,
            brandDomain,
            modelIds,
            generateTopics: generatePrompts,
            brandAliases,
            brandUrlSources,
            // Competitors ("other brands to track") are merged into the initial
            // market's CI competitor list. Like URLs, they come from the create
            // payload (the brand row isn't written yet).
            competitors: brandData.competitors,
          }, log);
          provisionedWorkspaceId = provisioned.semrushWorkspaceId;
        }
      }

      // Never store a competitor that is one of the brand's own properties (its
      // primary or own website URLs — at create the only market is the primary).
      // The benchmark sync already drops these, but they must not land in the
      // stored competitor list either. Social/earned domains are not reserved.
      if (Array.isArray(brandData.competitors) && brandData.competitors.length > 0) {
        const primaryDomain = brandDomainFromPayload(brandData);
        const reservedDomains = buildReservedDomains(
          primaryDomain ? [primaryDomain] : [],
          brandData.urls,
        );
        const { kept, dropped } = dropReservedCompetitors(brandData.competitors, reservedDomains);
        if (dropped.length > 0) {
          log.info('brands: dropped self-referential competitor(s) on create', {
            dropped: dropped.map((c) => c?.url).filter(Boolean),
          });
          brandData.competitors = kept;
        }
      }

      const created = await upsertBrand({
        organizationId: spaceCatId,
        brand: brandData,
        postgrestClient,
        updatedBy,
        log,
        forceBrandId: provisionedBrandId,
        semrushWorkspaceId: provisionedWorkspaceId,
      });

      // When a Semrush sub-workspace + initial market were provisioned, mirror that
      // initial market as a SpaceCat Site (+ brand_sites link) keyed on the
      // market's domain, so the Semrush project has a resolvable site entity.
      // INVARIANT: ensureMarketSite MUST NOT throw — it sits inside the try/catch
      // whose catch releases the just-provisioned workspace; a throw here would
      // tear down a live brand's workspace. ensureMarketSite is best-effort by
      // contract (its own catch-all swallows + logs), so this holds.
      if (hasText(provisionedWorkspaceId)) {
        await ensureMarketSite(context, {
          organizationId: spaceCatId,
          brandId: provisionedBrandId,
          // The initial market's domain, resolved during provisioning above.
          domain: provisionedBrandDomain,
          updatedBy,
          log,
        });
      }

      return createResponse(created, 201);
    } catch (error) {
      if (error.code === 'brand_status_demotion_not_allowed') {
        emitBrandDemotionBlocked(context, 'createBrand');
      }
      log.error(`Error creating brand for organization ${spaceCatId}:`, error);
      // Compensation: a sub-workspace was provisioned upstream but the brand row
      // failed to persist (e.g. a unique-constraint 409 or transient PostgREST
      // error). Nothing references that workspace, so release its allocation back
      // to the parent pool (best-effort) rather than leaking it.
      if (hasText(provisionedWorkspaceId)) {
        log.error('serenity: brand-create failed after subworkspace provision; releasing orphaned allocation', {
          semrushWorkspaceId: provisionedWorkspaceId,
        });
        await releaseProvisionedWorkspace(context, provisionedWorkspaceId, log);
      }
      return createErrorResponse(error);
    }
  };

  const updateBrandForOrg = async (context) => {
    const { spaceCatId, brandId } = context.params || {};
    const updates = context.data || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }
      const invalidGuidance = validateBrandGuidanceFields(updates);
      if (invalidGuidance) {
        return invalidGuidance;
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      // baseUrl is read-only (resolved from baseSiteId) — strip from updates.
      delete updates.baseUrl;

      // pendingSemrushProvisioning is the deferred-provisioning staging blob for
      // a *pending* (draft) brand. The draft UI mutates it via PATCH — the
      // Markets tab appends a market / edits a market's LLMs before activation.
      // Permit that ONLY while the brand is (and stays) pending: an active brand
      // keeps its markets on the Semrush side, so a PATCH must never inject a
      // primaryUrl/markets onto a live brand that activation would later trust.
      // When the target isn't pending (or the same PATCH is flipping it to
      // active — activation is the serenity endpoint's job, not PATCH's), strip
      // it. Only pay for the status read when the field is actually present.
      if (updates.pendingSemrushProvisioning !== undefined) {
        const { data: currentBrand } = await postgrestClient
          .from('brands')
          .select('status')
          .eq('organization_id', spaceCatId)
          .eq('id', brandUuid)
          .maybeSingle();
        const isPending = currentBrand?.status === 'pending'
          && (updates.status === undefined || updates.status === 'pending');
        if (!isPending) {
          delete updates.pendingSemrushProvisioning;
        }
      }

      // Capture the competitor list BEFORE the update so the Semrush re-sync can
      // compute which competitors were removed (old − new) — the only ones it
      // deletes upstream (Semrush-auto-generated ones are never in our list).
      const competitorsTouched = updates.competitors !== undefined;
      const oldCompetitors = competitorsTouched
        ? await getBrandCompetitors(brandUuid, postgrestClient)
        : [];
      // Brand aliases (the extra names the brand is known by) re-sync to every
      // market's project brand_names + own-brand benchmark on edit.
      const aliasesTouched = updates.brandAliases !== undefined;

      // LLMO-5645: a region must not be removed from a brand while prompts still
      // use it — DRS schedules off each prompt's `regions`, so dropping a brand
      // region would orphan those prompts on a market the brand no longer
      // covers. Reject the change and have the operator relocate the prompts
      // first (consistency guard, enforced before the brand is mutated).
      //
      // Best-effort, NOT transactional: there is a TOCTOU window between this
      // check and the update below — a prompt created in the removed region in
      // between could slip past. Acceptable given how infrequent brand-region
      // edits are, and the next edit re-checks; a prompt added later still can't
      // be scheduled for a region the brand lacks.
      if (updates.region !== undefined) {
        const before = await getBrandById(spaceCatId, brandUuid, postgrestClient);
        const blocking = await findPromptsBlockingRegionRemoval({
          organizationId: spaceCatId,
          brandUuid,
          oldRegions: before?.region || [],
          newRegions: updates.region || [],
          postgrestClient,
          log,
        });
        const blockedRegions = Object.keys(blocking).sort();
        if (blockedRegions.length > 0) {
          const detail = blockedRegions
            .map((r) => `${r.toUpperCase()} (${blocking[r]} prompt${blocking[r] === 1 ? '' : 's'})`)
            .join(', ');
          return badRequest(
            `Cannot remove region(s) still used by prompts: ${detail}. `
            + 'Reassign or delete those prompts first, then retry the region change.',
          );
        }
      }

      // A competitor ("other brand to track") must never be one of the brand's
      // OWN properties — its primary, any of its market/project domains, or its
      // own website URLs. Such a self-reference can't be tracked as a competitor
      // (it would benchmark the brand against itself), so strip it BEFORE the row
      // is written — it must not be stored at all, not just skipped at sync time.
      // Social/earned domains are NOT reserved (third-party platforms). Runs only
      // when competitors are actually edited.
      const competitorsToGuard = competitorsTouched
        && Array.isArray(updates.competitors) && updates.competitors.length > 0;
      // When the competitor guard below lists a Semrush brand's projects pre-write,
      // it stashes the listing here so the post-commit re-sync can reuse it instead
      // of listing the same workspace a second time — the project set is stable
      // across the brand-row write (which never re-points semrush_workspace_id), so
      // a single competitor edit lists projects ONCE across both the guard and sync.
      let prefetchedProjects = null;
      if (competitorsToGuard) {
        const brandState = await getBrandById(spaceCatId, brandUuid, postgrestClient);
        // Use the incoming URLs when this same PATCH changes them, else the stored ones.
        const websiteUrls = updates.urls !== undefined ? updates.urls : (brandState?.urls || []);
        const brandOwnUrls = [brandState?.baseUrl, ...websiteUrls];

        let reservedDomains;
        if (hasText(brandState?.semrushWorkspaceId)) {
          // Semrush brand: market/project domains come from the project listing.
          // List once and stash for the post-commit re-sync (see prefetchedProjects).
          const imsToken = getImsUserTokenStrict(context);
          const transport = createSerenityTransport({ env: context.env, imsToken });
          prefetchedProjects = await resolveProjects(transport, brandState.semrushWorkspaceId);
          reservedDomains = buildReservedDomains(
            prefetchedProjects.map((p) => p?.domain),
            brandOwnUrls,
          );
        } else {
          // Flat-mode brand: no projects — reserve the primary + own website URLs.
          reservedDomains = buildReservedDomains([], brandOwnUrls);
        }

        const { kept, dropped } = dropReservedCompetitors(updates.competitors, reservedDomains);
        if (dropped.length > 0) {
          log.info('brands: dropped self-referential competitor(s) on update', {
            brandId,
            dropped: dropped.map((c) => c?.url).filter(Boolean),
          });
          updates.competitors = kept;
        }
      }

      const updated = await updateBrand({
        organizationId: spaceCatId,
        brandId: brandUuid,
        updates,
        postgrestClient,
        updatedBy,
      });

      if (!updated) {
        return notFound(`Brand not found: ${brandId}`);
      }

      // Brand-level Semrush re-sync: when an edit changes URL sources or
      // competitors and the brand is in sub-workspace mode, propagate the change
      // onto every market/project (region-filtered per market). Skipped for
      // flat-mode brands and unrelated edits. Hard-fail so the brand never drifts
      // out of sync silently. One transport for both syncs.
      //
      // NOTE (intentional asymmetry vs create): the SAME URL/competitor
      // propagation is BEST-EFFORT on the create path (handleCreateMarket-
      // Subworkspace swallows a benchmark hiccup so it cannot strand a
      // half-provisioned brand) but HARD-FAIL here on edit — an already-live
      // brand must not silently diverge from Semrush after a row commit.
      const urlsTouched = updates.urls !== undefined
        || updates.socialAccounts !== undefined
        || updates.earnedContent !== undefined;
      // Aliases Semrush silently refused on this re-sync (own-brand or competitor
      // benchmarks), surfaced on the response so the UI can warn the operator.
      const rejectedAliases = [];
      if ((urlsTouched || competitorsTouched || aliasesTouched)
        && hasText(updated.semrushWorkspaceId)) {
        // Forward only an IMS user token upstream (matches the create path +
        // the rest of /serenity/*): PATCH /brands is organization:write and thus
        // S2S-reachable, so refuse a non-IMS bearer rather than proxy it.
        const imsToken = getImsUserTokenStrict(context);
        const transport = createSerenityTransport({ env: context.env, imsToken });
        try {
          // List the sub-workspace's projects ONCE and share the result across the
          // URL/competitor/alias syncs below — the listing is stable across the
          // brand-row write above, so this collapses up to three redundant
          // listProjects round-trips into one on a single edit. Threading the pre-
          // write competitor-guard listing (when it ran — same immutable workspace)
          // through resolveProjects' prefetch param reuses it; a null prefetch lists
          // fresh. So a competitor edit lists projects once across BOTH the guard and
          // the sync, while a urls/aliases-only edit lists once here. Kept inside the
          // try so a listProjects failure still emits the workspace-scoped re-sync
          // breadcrumb below rather than escaping to the generic outer catch.
          const sharedProjects = await resolveProjects(
            transport,
            updated.semrushWorkspaceId,
            prefetchedProjects,
          );
          if (urlsTouched) {
            await syncBrandUrlsAcrossMarkets(
              transport,
              {
                urls: updated.urls,
                socialAccounts: updated.socialAccounts,
                earnedContent: updated.earnedContent,
              },
              updated.semrushWorkspaceId,
              log,
              sharedProjects,
            );
          }
          if (competitorsTouched) {
            const removed = removedCompetitorDomains(oldCompetitors, updated.competitors);
            const competitorResult = await syncCompetitorBenchmarksAcrossMarkets(
              transport,
              updated.competitors,
              removed,
              updated.semrushWorkspaceId,
              log,
              // Reserve the brand's own website URLs (every market/project domain
              // is reserved from the project listing) so a competitor can't be one
              // of the brand's own properties.
              updated.urls,
              sharedProjects,
            );
            rejectedAliases.push(...(competitorResult?.rejected ?? []));
          }
          if (aliasesTouched) {
            const aliasResult = await syncBrandAliasesAcrossMarkets(
              transport,
              updated.brandAliases,
              updated.name,
              updated.semrushWorkspaceId,
              log,
              sharedProjects,
            );
            rejectedAliases.push(...(aliasResult?.rejected ?? []));
          }
        } catch (syncError) {
          // The brand row is already committed; re-sync hard-fails (the brand
          // must not silently drift out of sync with Semrush). Log the upstream
          // context (workspace + which sync) so the DB/Semrush divergence is
          // diagnosable, then rethrow to the handler's catch.
          log.error('serenity: brand-edit Semrush re-sync failed after row commit', {
            brandId,
            semrushWorkspaceId: updated.semrushWorkspaceId,
            urlsTouched,
            competitorsTouched,
            aliasesTouched,
            status: syncError?.status,
          });
          throw syncError;
        }
      }

      if (rejectedAliases.length > 0) {
        // Non-fatal: the aliases were written, Semrush just declined some. Warn
        // (so it is greppable) and hand the set back so the UI can tell the user
        // which aliases are not being tracked.
        log.warn('serenity: Semrush rejected some brand/competitor aliases on re-sync', {
          brandId,
          semrushWorkspaceId: updated.semrushWorkspaceId,
          rejected: rejectedAliases,
        });
        return ok({ ...updated, semrushRejectedAliases: rejectedAliases });
      }

      return ok(updated);
    } catch (error) {
      if (error.code === 'brand_status_demotion_not_allowed') {
        emitBrandDemotionBlocked(context, 'updateBrand');
      }
      log.error(`Error updating brand ${brandId} for organization ${spaceCatId}:`, error);
      return createErrorResponse(error);
    }
  };

  const deleteBrandForOrg = async (context) => {
    const { spaceCatId, brandId } = context.params || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      // eslint-disable-next-line max-len
      const deleted = await deleteBrand(spaceCatId, brandUuid, postgrestClient, updatedBy);

      if (!deleted) {
        return notFound(`Brand not found: ${brandId}`);
      }
      return createResponse(null, 204);
    } catch (error) {
      log.error(`Error deleting brand ${brandId} for organization ${spaceCatId}:`, error);
      return createErrorResponse(error);
    }
  };

  // Explicit, intentful brand status transition (approve -> active, move-to-pending ->
  // pending). This is the sanctioned path for an active->pending demotion: the generic
  // PATCH /brands/:brandId refuses that transition (LLMO-5587), routing intent here.
  const transitionBrandStatusForOrg = async (context) => {
    const { spaceCatId, brandId } = context.params || {};
    const { status } = context.data || {};

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }
      if (!isValidUUID(spaceCatId)) {
        return badRequest('Organization ID must be a valid UUID');
      }
      if (!hasText(brandId)) {
        return badRequest('Brand ID required');
      }
      if (status !== 'active' && status !== 'pending') {
        return badRequest("status must be one of 'active' or 'pending'");
      }

      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) {
        return organization;
      }
      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const unavailable = requirePostgrestForV2Config(context);
      if (unavailable) {
        return unavailable;
      }

      const { postgrestClient } = context.dataAccess.services;
      const updatedBy = context.attributes?.authInfo?.profile?.email || 'system';

      const brandUuid = await resolveBrandUuid(spaceCatId, brandId, postgrestClient);
      if (!brandUuid) {
        return notFound(`Brand not found: ${brandId}`);
      }

      const updated = await setBrandStatus({
        organizationId: spaceCatId,
        brandId: brandUuid,
        status,
        postgrestClient,
        updatedBy,
      });

      if (!updated) {
        return notFound(`Brand not found: ${brandId}`);
      }
      return ok(updated);
    } catch (error) {
      log.error(`Error transitioning status for brand ${brandId} in organization ${spaceCatId}:`, error);
      return createErrorResponse(error);
    }
  };

  return {
    getBrandsForOrganization,
    getBrandGuidelinesForSite,
    getBrandForOrg,
    getBrandForOrgSite,
    listBrandsForOrg,
    listCategoriesForOrg,
    createCategoryForOrg,
    updateCategoryForOrg,
    deleteCategoryForOrg,
    listTopicsForOrg,
    createTopicForOrg,
    updateTopicForOrg,
    deleteTopicForOrg,
    createBrandForOrg,
    updateBrandForOrg,
    deleteBrandForOrg,
    transitionBrandStatusForOrg,
    listPromptsByBrand,
    getPromptByBrandAndId,
    getPromptStatsByBrand,
    createPromptsByBrand,
    updatePromptByBrandAndId,
    deletePromptByBrandAndId,
    bulkDeletePromptsByBrand,
    checkPromptsByBrand,
  };
}

export default BrandsController;
