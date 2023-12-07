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

import { hasText, isObject } from '@adobe/spacecat-shared-utils';

import {
  createBadRequestResponse,
  createNotFoundResponse,
  createResponse,
} from '../utils/response-utils.js';

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
    return createResponse(sites);
  };

  /**
   * Gets all sites as an XLS file.
   * @returns {Promise<Response>} XLS file.
   */
  const getAllAsXLS = async () => {
    const sites = await dataAccess.getSites();
    return createResponse(SiteDto.toXLS(sites));
  };

  /**
   * Gets all sites as a CSV file.
   * @returns {Promise<Response>} CSV file.
   */
  const getAllAsCSV = async () => {
    const sites = await dataAccess.getSites();
    return createResponse(SiteDto.toCSV(sites));
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
      return createBadRequestResponse('Site ID required');
    }

    const site = await dataAccess.getSiteByID(siteId);
    if (!site) {
      return createNotFoundResponse('Site not found');
    }

    return createResponse(SiteDto.toJSON(site));
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
      return createBadRequestResponse('Base URL required');
    }

    const decodedBaseURL = Buffer.from(encodedBaseURL, 'base64').toString('utf-8').trim();

    const site = await dataAccess.getSiteByBaseURL(decodedBaseURL);
    if (!site) {
      return createNotFoundResponse('Site not found');
    }

    return createResponse(SiteDto.toJSON(site));
  };

  /**
   * Removes a site.
   * @param {string} siteId - The site ID.
   * @return {Promise<Response>} Delete response.
   */
  const removeSite = async (siteId) => {
    await dataAccess.removeSite(siteId);
    return createResponse('', 204);
  };

  /**
   * Updates a site
   * @param {object} siteData - Site data.
   * @return {Promise<Response>} Site response.
   */
  const updateSite = async (siteData) => {
    const site = await dataAccess.updateSite(siteData);
    return createResponse(SiteDto.toJSON(site));
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
