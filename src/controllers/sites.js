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
  created,
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
import { DELIVERY_TYPES } from '@adobe/spacecat-shared-data-access/src/models/site.js';

import { SiteDto } from '../dto/site.js';
import { AuditDto } from '../dto/audit.js';
import { validateRepoUrl } from '../utils/validations.js';
import { KeyEventDto } from '../dto/key-event.js';

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
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Site response.
   */
  const createSite = async (context) => {
    const site = await dataAccess.addSite(context.data);
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
   * Gets all sites by delivery type.
    * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Array of sites response.
   */
  const getAllByDeliveryType = async (context) => {
    const deliveryType = context.params?.deliveryType;

    if (!hasText(deliveryType)) {
      return badRequest('Delivery type required');
    }

    const sites = (await dataAccess.getSitesByDeliveryType(deliveryType))
      .map((site) => SiteDto.toJSON(site));
    return ok(sites);
  };

  /**
   * Gets all sites with their latest audit. Sites without a latest audit will be included
   * in the result, but will have an empty audits array. The sites are sorted by their latest
   * audit scores in ascending order by default. The sortAuditsAscending parameter can be used
   * to change the sort order. If a site has no latest audit, it will be sorted at the end of
   * the list.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Array of sites response.
   */
  const getAllWithLatestAudit = async (context) => {
    const auditType = context.params?.auditType;

    if (!hasText(auditType)) {
      return badRequest('Audit type required');
    }

    let ascending = true;
    if (hasText(context.params?.ascending)) {
      ascending = context.params.ascending === 'true';
    }
    const sites = (await dataAccess.getSitesWithLatestAudit(auditType, ascending))
      .map((site) => SiteDto.toJSON(site));
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

  const getAuditForSite = async (context) => {
    const siteId = context.params?.siteId;
    const auditType = context.params?.auditType;
    const auditedAt = context.params?.auditedAt;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(auditType)) {
      return badRequest('Audit type required');
    }

    if (!hasText(auditedAt)) {
      return badRequest('Audited at required');
    }

    const audit = await dataAccess.getAuditForSite(siteId, auditType, auditedAt);
    if (!audit) {
      return notFound('Audit not found');
    }

    return ok(AuditDto.toJSON(audit));
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

    if (hasText(requestBody.organizationId)
        && requestBody.organizationId !== site.getOrganizationId()) {
      site.updateOrganizationId(requestBody.organizationId);
      updates = true;
    }

    if (requestBody.gitHubURL !== site.getGitHubURL() && validateRepoUrl(requestBody.gitHubURL)) {
      site.updateGitHubURL(requestBody.gitHubURL);
      updates = true;
    }

    if (requestBody.deliveryType !== site.getDeliveryType()
      && Object.values(DELIVERY_TYPES).includes(requestBody.deliveryType)) {
      site.updateDeliveryType(requestBody.deliveryType);
      updates = true;
    }

    if (isObject(requestBody.config)) {
      site.updateConfig(requestBody.config);
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
      const updatedSite = await dataAccess.updateSite(site);
      return ok(SiteDto.toJSON(updatedSite));
    }

    return badRequest('No updates provided');
  };

  /**
   * Creates a site. The site ID is generated automatically.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Site response.
   */
  const createKeyEvent = async (context) => {
    const { siteId } = context.params;
    const { name, type, time } = context.data;

    const keyEvent = await dataAccess.createKeyEvent({
      siteId,
      name,
      type,
      time,
    });

    return created(KeyEventDto.toJSON(keyEvent));
  };

  /**
   * Gets key events for a site
   * @param {object} context - Context of the request.
   * @returns {Promise<[object]>} Key events.
   * @throws {Error} If site ID is not provided.
   */
  const getKeyEventsBySiteID = async (context) => {
    const siteId = context.params?.siteId;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await dataAccess.getSiteByID(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const keyEvents = await dataAccess.getKeyEventsForSite(site.getId());

    return ok(keyEvents.map((keyEvent) => KeyEventDto.toJSON(keyEvent)));
  };

  /**
   * Removes a key event.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Delete response.
   */
  const removeKeyEvent = async (context) => {
    const { keyEventId } = context.params;

    if (!hasText(keyEventId)) {
      return badRequest('Key Event ID required');
    }

    await dataAccess.removeKeyEvent(keyEventId);

    return noContent();
  };

  return {
    createSite,
    getAll,
    getAllAsXLS,
    getAllAsCSV,
    getAllWithLatestAudit,
    getAuditForSite,
    getByBaseURL,
    getAllByDeliveryType,
    getByID,
    removeSite,
    updateSite,

    // key events
    createKeyEvent,
    getKeyEventsBySiteID,
    removeKeyEvent,
  };
}

export default SitesController;
