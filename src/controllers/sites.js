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

import { Response } from '@adobe/fetch';
import { hasText, isObject } from '@adobe/spacecat-shared-utils';

import { SiteDto } from '../dto/site.js';

function createResponse(body, status = 200) {
  return new Response(
    JSON.stringify(body),
    {
      headers: { 'content-type': 'application/json' },
      status,
    },
  );
}

function createNotFoundResponse(message) {
  return createResponse({ message }, 404);
}

/**
 * Sites controller.
 * @param dataAccess
 * @returns {object} Sites controller.
 * @constructor
 */
function SitesController(dataAccess) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  /**
   * Creates a site.
   * @param siteData
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
      throw new Error('Site ID required');
    }

    const site = await dataAccess.getSiteByID(siteId);
    if (!site) {
      return createNotFoundResponse('Site not found');
    }

    return createResponse(SiteDto.toJSON(site));
  };

  /**
   * Gets a site by base URL.
   * @param {object} context - Context of the request.
   * @returns {Promise<object>} Site.
   * @throws {Error} If base URL is not provided.
   */
  const getByBaseURL = async (context) => {
    const baseURL = context.params?.baseURL;

    if (!hasText(baseURL)) {
      throw new Error('Base URL required');
    }

    const site = await dataAccess.getSiteByBaseURL(baseURL);
    if (!site) {
      return createNotFoundResponse('Site not found');
    }

    return createResponse(SiteDto.toJSON(site));
  };

  return {
    createSite,
    getAll,
    getAllAsXLS,
    getAllAsCSV,
    getByBaseURL,
    getByID,
  };
}

export default SitesController;
