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
  createResponse, forbidden,
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
import AccessControlUtil from '../support/access-control-util.js';

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

  return {
    getBrandsForOrganization,
    getBrandGuidelinesForSite,
  };
}

export default BrandsController;
