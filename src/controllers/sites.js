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

import { isObject } from '@adobe/spacecat-shared-utils';

import { SiteDto } from '../dto/site.js';

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

  const createSite = async (siteData) => {
    const site = await dataAccess.addSite(siteData);
    return SiteDto.toJSON(site);
  };

  /**
   * Gets all sites.
   * @returns {Promise<Array<object>>} Array of sites.
   */
  const getAll = async () => {
    const sites = await dataAccess.getSites();
    return sites.map((site) => SiteDto.toJSON(site));
  };

  /**
   * Gets all sites as an XLS file.
   * @returns {Promise<Buffer>} XLS file.
   */
  const getAllAsXLS = async () => {
    const sites = await dataAccess.getSites();
    return SiteDto.toXLS(sites);
  };

  /**
   * Gets all sites as a CSV file.
   * @returns {Promise<string>} CSV file.
   */
  const getAllAsCSV = async () => {
    const sites = await dataAccess.getSites();
    return SiteDto.toCSV(sites);
  };

  /**
   * Gets a site by ID.
   * @param {string} id - Site ID.
   * @returns {Promise<object>} Site.
   */
  const getByID = async (id) => {
    const site = await dataAccess.getSiteByID(id);
    return site ? SiteDto.toJSON(site) : null;
  };

  /**
   * Gets a site by base URL.
   * @param {string} baseURL - Site base URL.
   * @returns {Promise<object>} Site.
   */
  const getByBaseURL = async (baseURL) => {
    const site = await dataAccess.getSiteByBaseURL(baseURL);
    return site ? SiteDto.toJSON(site) : null;
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
