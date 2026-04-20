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
import BrandClient from '@adobe/spacecat-shared-brand-client';
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

import { ErrorWithStatusCode, getImsUserToken } from '../support/utils.js';
import {
  STATUS_BAD_REQUEST,
} from '../utils/constants.js';
import {
  LLMO_CONFIG_DB_SYNC_TYPE,
  isSyncEnabledForSite,
} from './llmo/llmo-config-sync-constants.js';
import AccessControlUtil from '../support/access-control-util.js';
import {
  listPrompts,
  getPromptById,
  upsertPrompts,
  updatePromptById,
  deletePromptById,
  bulkDeletePrompts,
  resolveBrandUuid,
} from '../support/prompts-storage.js';
import {
  listBrands,
  upsertBrand,
  updateBrand,
  deleteBrand,
  getBrandById,
} from '../support/brands-storage.js';
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
    if (error.status) {
      return createResponse({ message: error.message }, error.status, {
        [HEADER_ERROR]: error.message,
      });
    }
    return internalServerError(error.message);
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

      const brandId = site.getConfig()?.getBrandConfig()?.brandId;
      const userId = site.getConfig()?.getBrandConfig()?.userId;
      const brandConfig = {
        brandId,
        userId,
      };
      if (!hasText(brandId) || !hasText(userId)) {
        return notFound(`Brand config is missing, brandId or userId for site ID: ${siteId}`);
      }
      const organizationId = site.getOrganizationId();
      const organization = await Organization.findById(organizationId);
      const imsOrgId = organization?.getImsOrgId();
      const imsConfig = getImsConfig();
      const brandClient = BrandClient.createFrom(context);
      const brandGuidelines = await brandClient.getBrandGuidelines(
        brandConfig,
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
      });

      return createResponse({ created, updated, prompts: outPrompts }, 201);
    } catch (error) {
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

      const created = await createCategory({
        organizationId: spaceCatId,
        category: categoryData,
        postgrestClient,
        updatedBy,
      });

      return createResponse(created, 201);
    } catch (error) {
      log.error(`Error creating category for organization ${spaceCatId}:`, error);
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
      log.error(`Error updating category ${categoryId} for organization ${spaceCatId}:`, error);
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
      log.error(`Error creating topic for organization ${spaceCatId}:`, error);
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

      const created = await upsertBrand({
        organizationId: spaceCatId,
        brand: brandData,
        postgrestClient,
        updatedBy,
      });

      return createResponse(created, 201);
    } catch (error) {
      log.error(`Error creating brand for organization ${spaceCatId}:`, error);
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
      return ok(updated);
    } catch (error) {
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

  const triggerConfigSync = async (context) => {
    const { spaceCatId, siteId } = context.params || {};

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

      if (!hasText(siteId) || !isValidUUID(siteId)) {
        return badRequest('Site ID (valid UUID) is required');
      }

      const site = await Site.findById(siteId);
      if (!site) {
        return notFound(`Site not found: ${siteId}`);
      }
      if (site.getOrganizationId() !== spaceCatId) {
        return forbidden('Site does not belong to this organization');
      }

      if (!isSyncEnabledForSite(siteId)) {
        return badRequest(`Config sync is not enabled for site ${siteId}`);
      }

      const rawQueryString = context.invocation?.event?.rawQueryString || '';
      const queryParams = Object.fromEntries(
        rawQueryString.split('&').filter(Boolean).map((p) => p.split('=')),
      );
      const isDryRun = queryParams.dryRun === 'true';
      await context.sqs.sendMessage(context.env.AUDIT_JOBS_QUEUE_URL, {
        type: LLMO_CONFIG_DB_SYNC_TYPE,
        siteId,
        ...(isDryRun && { dryRun: true }),
      });

      log.info(`[${LLMO_CONFIG_DB_SYNC_TYPE}] On-demand config DB sync${isDryRun ? ' (dry run)' : ''} triggered for site ${siteId}`);
      return ok({ message: `Config sync${isDryRun ? ' (dry run)' : ''} triggered`, siteId, ...(isDryRun && { dryRun: true }) });
    } catch (error) {
      log.error(`Error triggering config sync for org ${spaceCatId}:`, error);
      return createErrorResponse(error);
    }
  };

  return {
    getBrandsForOrganization,
    getBrandGuidelinesForSite,
    getBrandForOrg,
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
    listPromptsByBrand,
    getPromptByBrandAndId,
    createPromptsByBrand,
    updatePromptByBrandAndId,
    deletePromptByBrandAndId,
    bulkDeletePromptsByBrand,
    triggerConfigSync,
  };
}

export default BrandsController;
