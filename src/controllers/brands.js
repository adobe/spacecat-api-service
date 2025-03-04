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
/* c8 ignore start */
import BrandClient from '@adobe/spacecat-shared-brand-client';
import {
  badRequest,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode } from '../support/utils.js';
import {
  STATUS_UNAUTHORIZED,
} from '../utils/constants.js';

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

  /**
   * Get the IMS user token from the context.
   * @param {object} context - The context of the request.
   * @returns {string} imsUserToken - The IMS User access token.
   * @throws {ErrorWithStatusCode} - If the Authorization header is missing.
   */
  function getImsUserToken(context) {
    const { pathInfo: { headers } } = context;
    const { authorization: authorizationHeader } = headers;
    const BEARER_PREFIX = 'Bearer ';
    if (!hasText(authorizationHeader) || !authorizationHeader.startsWith(BEARER_PREFIX)) {
      throw new ErrorWithStatusCode('Missing Authorization header', STATUS_UNAUTHORIZED);
    }
    return authorizationHeader;
  }
  /**
   * Gets all brands for an organization.
   * @returns {Promise<Response>} Array of brands.
   */
  const getBrandsForOrganization = async (context) => {
    const organizationId = context.params?.organizationId;
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
    const brands = await brandClient.getBrandsForOrganization(imsOrgId, imsUserToken);
    log.info(`Found ${brands.length} brands for organization: ${organizationId}`);
    return ok(brands);
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
      throw new ErrorWithStatusCode('IMS Config not found in the environment', STATUS_UNAUTHORIZED);
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
      return badRequest('Brand ID missing in brand config of site');
    }
    const imsOrgId = site.getOrganization()?.getImsOrgId();
    log.info(`IMS Org ID for site: ${siteId} is ${imsOrgId}`);
    const imsConfig = getImsConfig();
    const brandClient = BrandClient.createFrom(context);
    const brandGuidelines = await brandClient.getBrandGuidelines(brandId, imsOrgId, imsConfig);
    log.info(`Found brand guidelines for site: ${siteId}`);
    return ok(brandGuidelines);
  };

  return {
    getBrandsForOrganization,
    getBrandGuidelinesForSite,
  };
}

export default BrandsController;
/* c8 ignore end */
