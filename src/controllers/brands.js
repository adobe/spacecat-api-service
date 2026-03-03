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
  llmoConfig,
} from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode, getImsUserToken } from '../support/utils.js';
import {
  STATUS_BAD_REQUEST,
} from '../utils/constants.js';
import AccessControlUtil from '../support/access-control-util.js';
import { mergeCustomerConfigV2 } from '../support/customer-config-v2-metadata.js';

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
   * Loads customer config from S3 with error handling.
   * @param {object} context - Request context
   * @param {string} orgId - Organization ID
   * @returns {Promise<object|null>} Customer config or null if not found/error
   */
  async function loadCustomerConfigFromS3(context, orgId) {
    try {
      const config = await llmoConfig.readCustomerConfigV2(
        orgId,
        context.s3.s3Client,
        { s3Bucket: context.s3.s3Bucket },
      );
      log.info(`Customer config loaded from S3 for organization: ${orgId}`);
      return config;
    } catch (s3Error) {
      log.warn(`Failed to load customer config from S3 for organization: ${orgId}`, s3Error);
      return null;
    }
  }

  /**
   * Get query parameters from context
   * @param {object} context - The request context
   * @returns {object} Parsed query parameters
   */
  function getQueryParams(context) {
    const rawQueryString = context.invocation?.event?.rawQueryString;
    if (!rawQueryString) return {};

    const params = {};
    rawQueryString.split('&').forEach((param) => {
      const [key, value] = param.split('=');
      if (key && value) {
        params[decodeURIComponent(key)] = decodeURIComponent(value);
      }
    });
    return params;
  }

  /**
   * Filters items by status, excluding deleted by default.
   * @param {Array} items - Items to filter
   * @param {string} status - Optional status filter
   * @returns {Array} Filtered items
   */
  function filterByStatus(items, status) {
    if (!items) return [];
    if (status) {
      return items.filter((item) => item.status === status);
    }
    return items.filter((item) => item.status !== 'deleted');
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

  /**
   * Gets customer configuration for an organization (full config with prompts).
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Customer configuration.
   */
  const getCustomerConfig = async (context) => {
    const { spaceCatId } = context.params || {};
    const { status } = getQueryParams(context);

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }

      // Look up organization
      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) return organization; // Return if it's an error response

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      // Try to get from S3 first
      const customerConfig = await loadCustomerConfigFromS3(context, spaceCatId);
      if (!customerConfig) {
        return notFound('Customer configuration not found for organization');
      }

      // Filter by status if needed
      const filteredConfig = {
        customer: {
          ...customerConfig.customer,
          ...(customerConfig.customer.categories && {
            categories: filterByStatus(customerConfig.customer.categories, status),
          }),
          ...(customerConfig.customer.topics && {
            topics: filterByStatus(customerConfig.customer.topics, status),
          }),
          brands: customerConfig.customer.brands.map((brand) => ({
            ...brand,
            ...(brand.prompts && {
              prompts: filterByStatus(brand.prompts, status),
            }),
          })),
        },
      };
      return ok(filteredConfig);
    } catch (error) {
      log.error(`Error getting customer config for organization: ${spaceCatId}`, error);
      return createErrorResponse(error);
    }
  };

  /**
   * Gets lean customer configuration (without prompts) for an organization.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Lean customer configuration.
   */
  const getCustomerConfigLean = async (context) => {
    const { spaceCatId } = context.params || {};
    const { status } = getQueryParams(context);

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }

      // Look up organization
      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) return organization; // Return if it's an error response

      // Try to get from S3 first
      const customerConfig = await loadCustomerConfigFromS3(context, spaceCatId);
      if (!customerConfig) {
        return notFound('Customer configuration not found');
      }

      // Build maps for counting
      const categoriesMap = new Map();
      (customerConfig.customer.categories || []).forEach((cat) => {
        categoriesMap.set(cat.id, cat);
      });

      const topicsMap = new Map();
      (customerConfig.customer.topics || []).forEach((topic) => {
        topicsMap.set(topic.id, topic);
      });

      // Remove prompts from brands but add counts
      const leanConfig = {
        customer: {
          ...customerConfig.customer,
          brands: customerConfig.customer.brands.map((brand) => {
            // eslint-disable-next-line no-unused-vars
            const { prompts, ...brandWithoutPrompts } = brand;

            // Filter prompts by status for counting
            const filteredPrompts = filterByStatus(prompts || [], status);

            // Count unique categories and topics used by this brand's filtered prompts
            const brandCategories = new Set();
            const brandTopics = new Set();
            filteredPrompts.forEach((prompt) => {
              if (prompt.categoryId) brandCategories.add(prompt.categoryId);
              if (prompt.topicId) brandTopics.add(prompt.topicId);
            });

            return {
              ...brandWithoutPrompts,
              totalCategories: brandCategories.size,
              totalTopics: brandTopics.size,
              totalPrompts: filteredPrompts.length,
            };
          }),
          categories: undefined,
          topics: undefined,
        },
      };

      return ok(leanConfig);
    } catch (error) {
      log.error(`Error getting lean customer config for organization: ${spaceCatId}`, error);
      return createErrorResponse(error);
    }
  };

  /**
   * Gets topics for an organization and optionally filters by brand.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of topics.
   */
  const getTopics = async (context) => {
    const { spaceCatId } = context.params || {};
    const { brandId, status } = getQueryParams(context);

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }

      // Look up organization
      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) return organization; // Return if it's an error response

      // Get config
      let customerConfig = null;
      if (context.s3?.s3Client && context.s3?.s3Bucket) {
        try {
          customerConfig = await llmoConfig.readCustomerConfigV2(
            spaceCatId,
            context.s3.s3Client,
            { s3Bucket: context.s3.s3Bucket },
          );
        } catch (s3Error) {
          log.warn(`Failed to load customer config from S3 for organization: ${spaceCatId}`, s3Error);
        }
      }

      if (!customerConfig) {
        return notFound('Customer configuration not found');
      }

      // Filter topics by status and optionally by brand
      let topics = customerConfig.customer.topics || [];

      // If brandId is provided, filter topics to only those used by that brand's prompts
      if (brandId) {
        const brand = customerConfig.customer.brands.find((b) => b.id === brandId);
        if (!brand) {
          return notFound(`Brand not found: ${brandId}`);
        }

        // Collect unique topic IDs used by this brand's prompts
        const brandTopicIds = new Set();
        (brand.prompts || []).forEach((prompt) => {
          if (prompt.topicId) {
            brandTopicIds.add(prompt.topicId);
          }
        });

        topics = topics.filter((topic) => brandTopicIds.has(topic.id));
      }

      // Filter by status
      topics = filterByStatus(topics, status);

      return ok({ topics });
    } catch (error) {
      log.error(`Error getting topics for organization: ${spaceCatId}`, error);
      return createErrorResponse(error);
    }
  };

  /**
   * Gets prompts for an organization and optionally filters by brand/category/topic.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of prompts with category/topic info.
   */
  const getPrompts = async (context) => {
    const { spaceCatId } = context.params || {};
    const {
      brandId, categoryId, topicId, status,
    } = getQueryParams(context);

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }

      // Look up organization
      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) return organization; // Return if it's an error response

      // Get config
      let customerConfig = null;
      if (context.s3?.s3Client && context.s3?.s3Bucket) {
        try {
          customerConfig = await llmoConfig.readCustomerConfigV2(
            spaceCatId,
            context.s3.s3Client,
            { s3Bucket: context.s3.s3Bucket },
          );
        } catch (s3Error) {
          log.warn(`Failed to load customer config from S3 for organization: ${spaceCatId}`, s3Error);
        }
      }

      if (!customerConfig) {
        return notFound('Customer configuration not found');
      }

      // Build lookup maps for enrichment
      const categoriesMap = new Map();
      (customerConfig.customer.categories || []).forEach((cat) => {
        categoriesMap.set(cat.id, cat);
      });

      const topicsMap = new Map();
      (customerConfig.customer.topics || []).forEach((topic) => {
        topicsMap.set(topic.id, topic);
      });

      // Collect and filter prompts
      const allPrompts = [];
      customerConfig.customer.brands.forEach((brand) => {
        if (brandId && brand.id !== brandId) return;

        (brand.prompts || []).forEach((prompt) => {
          if (categoryId && prompt.categoryId !== categoryId) return;
          if (topicId && prompt.topicId !== topicId) return;

          // Filter by status
          if (status && prompt.status !== status) return;
          if (!status && prompt.status === 'deleted') return;

          // Enrich prompt with category/topic info
          const category = categoriesMap.get(prompt.categoryId);
          const topic = topicsMap.get(prompt.topicId);

          allPrompts.push({
            ...prompt,
            brandId: brand.id,
            brandName: brand.name,
            category: category ? {
              id: category.id,
              name: category.name,
              origin: category.origin,
            } : null,
            topic: topic ? {
              id: topic.id,
              name: topic.name,
              categoryId: topic.categoryId,
            } : null,
          });
        });
      });

      return ok({ prompts: allPrompts });
    } catch (error) {
      log.error(`Error getting prompts for organization: ${spaceCatId}`, error);
      return createErrorResponse(error);
    }
  };

  /**
   * Saves customer configuration for an organization.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Success response.
   */
  const saveCustomerConfig = async (context) => {
    const { spaceCatId } = context.params || {};
    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }

      // Look up organization
      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) return organization; // Return if it's an error response

      const customerConfig = context.data;
      if (!isNonEmptyObject(customerConfig)) {
        return badRequest('Customer configuration data is required');
      }

      // Validate basic structure
      const hasValidCustomer = customerConfig.customer
        && customerConfig.customer.customerName;
      if (!hasValidCustomer) {
        return badRequest('Invalid customer configuration structure: customer.customerName is required');
      }

      // Save to S3
      await llmoConfig.writeCustomerConfigV2(
        spaceCatId,
        customerConfig,
        context.s3.s3Client,
        { s3Bucket: context.s3.s3Bucket },
      );

      log.info(`Customer config saved to S3 for organization: ${spaceCatId}`);

      return ok({ message: 'Customer configuration saved successfully' });
    } catch (error) {
      log.error(`Error saving customer config for organization: ${spaceCatId}`, error);
      return createErrorResponse(error);
    }
  };

  /**
   * Patches (merges) customer configuration for an organization.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Success response with stats.
   */
  const patchCustomerConfig = async (context) => {
    const { spaceCatId } = context.params || {};
    const { authInfo } = context.attributes || {};
    const userId = authInfo?.profile?.email || 'system';

    try {
      if (!hasText(spaceCatId)) {
        return badRequest('Organization ID required');
      }

      // Look up organization
      const organization = await getOrganizationOrNotFound(spaceCatId);
      if (organization.status) return organization; // Return if it's an error response

      if (!await accessControlUtil.hasAccess(organization)) {
        return forbidden('User does not have access to this organization');
      }

      const updates = context.data;
      if (!isNonEmptyObject(updates)) {
        return badRequest('Customer configuration updates are required');
      }

      // Get existing config
      let existingConfig = null;
      try {
        existingConfig = await llmoConfig.readCustomerConfigV2(
          spaceCatId,
          context.s3.s3Client,
          { s3Bucket: context.s3.s3Bucket },
        );
      } catch (s3Error) {
        log.warn(`Failed to load existing config from S3 for organization: ${spaceCatId}`, s3Error);
      }

      // Merge updates with existing config
      const { mergedConfig, stats } = mergeCustomerConfigV2(
        updates,
        existingConfig,
        userId,
      );

      // Validate merged config has required fields
      const hasValidCustomer = mergedConfig.customer
        && mergedConfig.customer.customerName
        && mergedConfig.customer.imsOrgID;
      if (!hasValidCustomer) {
        return badRequest('Invalid customer configuration: customer.customerName and customer.imsOrgID are required');
      }

      // Save merged config to S3
      await llmoConfig.writeCustomerConfigV2(
        spaceCatId,
        mergedConfig,
        context.s3.s3Client,
        { s3Bucket: context.s3.s3Bucket },
      );

      log.info(`Customer config patched for organization: ${spaceCatId} by ${userId}. Stats:`, stats);

      return ok({
        message: 'Customer configuration updated successfully',
        stats,
      });
    } catch (error) {
      log.error(`Error patching customer config for organization: ${spaceCatId}`, error);
      return createErrorResponse(error);
    }
  };

  return {
    getBrandsForOrganization,
    getBrandGuidelinesForSite,
    getCustomerConfig,
    getCustomerConfigLean,
    getTopics,
    getPrompts,
    saveCustomerConfig,
    patchCustomerConfig,
    // Exported for testing
    filterByStatus,
  };
}

export default BrandsController;
