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
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode, getImsUserToken } from '../support/utils.js';
import {
  STATUS_BAD_REQUEST,
} from '../utils/constants.js';

const HEADER_ERROR = 'x-error';

/**
 * BrandsController. Provides methods to read brands and brand guidelines.
 * @param {DataAccess} dataAccess - Data access.
 * @param {Object} env - Environment object.
 * @returns {object} Brands controller.
 * @constructor
 */
function BrandsController(dataAccess, log, env) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  if (!isObject(env)) {
    throw new Error('Environment object required');
  }
  const { Organization, Site } = dataAccess;

  function createErrorResponse(error) {
    return createResponse({ message: error.message }, error.status, {
      [HEADER_ERROR]: error.message,
    });
  }

  /**
   * Gets all brands for an organization.
   * @returns {Promise<Response>} Array of brands.
   */
  const getBrandsForOrganization = async (context) => {
    const organizationId = context.params?.organizationId;
    try {
      log.info(`Getting brands for organization: ${organizationId}`);
      if (!isValidUUID(organizationId)) {
        return badRequest('Organization ID required');
      }

      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return notFound(`Organization not found: ${organizationId}`);
      }
      const imsOrgId = organization.getImsOrgId();
      const imsUserToken = getImsUserToken(context);
      const brandClient = BrandClient.createFrom(context);
      const brands = await brandClient.getBrandsForOrganization(imsOrgId, `Bearer ${imsUserToken}`);
      log.info(`Found ${brands.length} brands for organization: ${organizationId}`);
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
      log.info(`Getting brand guidelines for site: ${siteId}`);
      if (!isValidUUID(siteId)) {
        return badRequest('Site ID required');
      }

      const site = await Site.findById(siteId);
      if (!site) {
        return notFound(`Site not found: ${siteId}`);
      }
      const brandId = site.getConfig()?.getBrandConfig()?.brandId;
      log.info(`Brand ID mapping for site: ${siteId} is ${brandId}`);
      if (!hasText(brandId)) {
        return notFound(`Brand mapping not found for site ID: ${siteId}`);
      }
      const organizationId = site.getOrganizationId();
      const organization = await Organization.findById(organizationId);
      const imsOrgId = organization?.getImsOrgId();
      log.info(`IMS Org ID for site: ${siteId} is ${imsOrgId}`);
      const imsConfig = getImsConfig();
      const brandClient = BrandClient.createFrom(context);
      const brandGuidelines = await brandClient.getBrandGuidelines(brandId, imsOrgId, imsConfig);
      log.info(`Found brand guidelines for site: ${siteId}`);
      return ok(brandGuidelines);
    } catch (error) {
      log.error(`Error getting brand guidelines for site: ${siteId}`, error);
      return createErrorResponse(error);
    }
  };

  return {
    getBrandsForOrganization,
    getBrandGuidelinesForSite,
  };
}

export default BrandsController;
