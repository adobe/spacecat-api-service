/*
 * Copyright 2023 Adobe. All rights reserved.
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
  noContent,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isBoolean,
  isObject,
} from '@adobe/spacecat-shared-utils';

import { SiteDto } from '../dto/site.js';

/**
 * Sites controller. Provides methods to create, read, update and delete sites.
 * @param {DataAccess} dataAccess - Data access.
 * @returns {object} Sites controller.
 * @constructor
 */
function SitesController(dataAccess) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  /**
   * Creates a site. The site ID is generated automatically.
   * @param {object} siteData - Site data.
   * @return {Promise<Response>} Site response.
   */
  const createSite = async (siteData) => {
    const site = await dataAccess.addSite(siteData);
    return createResponse(SiteDto.toJSON(site), 201);
  };

  /**
   * Gets all sites.
   * @returns {Promise<Response>} Array of sites response.
   */
  const getAll = async () => {
    const sites = (await dataAccess.getSites()).map((site) => SiteDto.toJSON(site));
    return ok(sites);
  };

  /**
   * Gets all sites as an XLS file.
   * @returns {Promise<Response>} XLS file.
   */
  const getAllAsXLS = async () => {
    const sites = await dataAccess.getSites();
    return ok(SiteDto.toXLS(sites));
  };

  /**
   * Gets all sites as a CSV file.
   * @returns {Promise<Response>} CSV file.
   */
  const getAllAsCSV = async () => {
    const sites = await dataAccess.getSites();
    return ok(SiteDto.toCSV(sites));
  };

  /**
   * Gets a site by ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<object>} Site.
   * @throws {Error} If site ID is not provided.
   */
  const getByID = async (context) => {
    const siteId = context.params?.siteId;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await dataAccess.getSiteByID(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    return ok(SiteDto.toJSON(site));
  };

  /**
   * Gets a site by base URL. The base URL is base64 encoded. This is to allow
   * for URLs with special characters to be used as path parameters.
   * @param {object} context - Context of the request.
   * @returns {Promise<object>} Site.
   * @throws {Error} If base URL is not provided.
   */
  const getByBaseURL = async (context) => {
    const encodedBaseURL = context.params?.baseURL;

    if (!hasText(encodedBaseURL)) {
      return badRequest('Base URL required');
    }

    const decodedBaseURL = Buffer.from(encodedBaseURL, 'base64').toString('utf-8').trim();

    const site = await dataAccess.getSiteByBaseURL(decodedBaseURL);
    if (!site) {
      return notFound('Site not found');
    }

    return ok(SiteDto.toJSON(site));
  };

  /**
   * Removes a site.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Delete response.
   */
  const removeSite = async (context) => {
    const siteId = context.params?.siteId;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    await dataAccess.removeSite(siteId);

    return noContent();
  };

  /**
   * Updates a site
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Site response.
   */
  const updateSite = async (context) => {
    const siteId = context.params?.siteId;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await dataAccess.getSiteByID(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const requestBody = context.data;
    if (!isObject(requestBody)) {
      return badRequest('Request body required');
    }

    let updates = false;
    if (isBoolean(requestBody.isLive) && requestBody.isLive !== site.isLive()) {
      site.toggleLive();
      updates = true;
    }

    if (hasText(requestBody.imsOrgId) && requestBody.imsOrgId !== site.getImsOrgId()) {
      site.updateImsOrgId(requestBody.imsOrgId);
      updates = true;
    }

    if (requestBody.auditConfig) {
      if (isBoolean(requestBody.auditConfig.auditsDisabled)) {
        site.setAllAuditsDisabled(requestBody.auditConfig.auditsDisabled);
        updates = true;
      }

      if (isObject(requestBody.auditConfig.auditTypeConfigs)) {
        Object.entries(requestBody.auditConfig.auditTypeConfigs).forEach(([type, config]) => {
          site.updateAuditTypeConfig(type, config);
          updates = true;
        });
      }
    }

    if (updates) {
      const updatedSite = await dataAccess.updateSite(requestBody);
      return ok(SiteDto.toJSON(updatedSite));
    }

    return badRequest('No updates provided');
  };

  return {
    createSite,
    getAll,
    getAllAsXLS,
    getAllAsCSV,
    getByBaseURL,
    getByID,
    removeSite,
    updateSite,
  };
}

export default SitesController;
