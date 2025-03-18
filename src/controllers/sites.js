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
  getStoredMetrics, isValidUUID, deepEqual,
} from '@adobe/spacecat-shared-utils';
import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';

import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';
import { SiteDto } from '../dto/site.js';
import { AuditDto } from '../dto/audit.js';
import { validateRepoUrl } from '../utils/validations.js';
import { KeyEventDto } from '../dto/key-event.js';
import { wwwUrlResolver } from '../support/utils.js';

/**
 * Sites controller. Provides methods to create, read, update and delete sites.
 * @param {DataAccess} dataAccess - Data access.
 * @returns {object} Sites controller.
 * @constructor
 */

const AHREFS = 'ahrefs';
const ORGANIC_TRAFFIC = 'organic-traffic';
const MONTH_DAYS = 30;
const TOTAL_METRICS = 'totalMetrics';

function SitesController(dataAccess, log, env) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Audit, KeyEvent, Site } = dataAccess;

  /**
   * Creates a site. The site ID is generated automatically.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Site response.
   */
  const createSite = async (context) => {
    const site = await Site.create({
      organizationId: env.DEFAULT_ORGANIZATION_ID,
      ...context.data,
    });
    return createResponse(SiteDto.toJSON(site), 201);
  };

  /**
   * Gets all sites.
   * @returns {Promise<Response>} Array of sites response.
   */
  const getAll = async () => {
    const all = await Site.all({}, { fetchAllPages: true });
    const sites = all.map((site) => SiteDto.toJSON(site));
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

    const sites = (await Site.allByDeliveryType(deliveryType))
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
    const ascending = context.params?.ascending;

    if (!hasText(auditType)) {
      return badRequest('Audit type required');
    }

    const order = ascending === 'true' ? 'asc' : 'desc';

    const sites = await Site.allWithLatestAudit(auditType, order);
    const result = await Promise.all(sites
      .map(async (site) => {
        const audit = await site.getLatestAuditByAuditType(auditType);
        return SiteDto.toJSON(site, audit);
      }));
    return ok(result);
  };

  /**
   * Gets all sites as an XLS file.
   * @returns {Promise<Response>} XLS file.
   */
  const getAllAsXLS = async () => {
    const sites = await Site.all();
    return ok(SiteDto.toXLS(sites));
  };

  /**
   * Gets all sites as a CSV file.
   * @returns {Promise<Response>} CSV file.
   */
  const getAllAsCSV = async () => {
    const sites = await Site.all();
    return ok(SiteDto.toCSV(sites));
  };

  const getAuditForSite = async (context) => {
    const siteId = context.params?.siteId;
    const auditType = context.params?.auditType;
    const auditedAt = context.params?.auditedAt;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(auditType)) {
      return badRequest('Audit type required');
    }

    if (!hasText(auditedAt)) {
      return badRequest('Audited at required');
    }

    const audit = await Audit.findBySiteIdAndAuditTypeAndAuditedAt(siteId, auditType, auditedAt);
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

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
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

    const site = await Site.findByBaseURL(decodedBaseURL);
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

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);

    if (!site) {
      return notFound('Site not found');
    }

    await site.remove();

    return noContent();
  };

  /**
   * Updates a site
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Site response.
   */
  const updateSite = async (context) => {
    const siteId = context.params?.siteId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const requestBody = context.data;
    if (!isObject(requestBody)) {
      return badRequest('Request body required');
    }

    let updates = false;
    if (isBoolean(requestBody.isLive) && requestBody.isLive !== site.getIsLive()) {
      site.toggleLive();
      updates = true;
    }

    if (hasText(requestBody.organizationId)
        && requestBody.organizationId !== site.getOrganizationId()) {
      site.setOrganizationId(requestBody.organizationId);
      updates = true;
    }

    if (requestBody.name !== site.getName()) {
      site.setName(requestBody.name);
      updates = true;
    }

    if (requestBody.gitHubURL !== site.getGitHubURL() && validateRepoUrl(requestBody.gitHubURL)) {
      site.setGitHubURL(requestBody.gitHubURL);
      updates = true;
    }

    if (requestBody.deliveryType !== site.getDeliveryType()
        && Object.values(SiteModel.DELIVERY_TYPES).includes(requestBody.deliveryType)) {
      site.setDeliveryType(requestBody.deliveryType);
      updates = true;
    }

    if (isObject(requestBody.deliveryConfig)
        && !deepEqual(requestBody.deliveryConfig, site.getDeliveryConfig())) {
      site.setDeliveryConfig(requestBody.deliveryConfig);
      updates = true;
    }

    if (isObject(requestBody.config)) {
      site.setConfig(requestBody.config);
      updates = true;
    }

    if (isObject(requestBody.hlxConfig) && !deepEqual(requestBody.hlxConfig, site.getHlxConfig())) {
      site.setHlxConfig(requestBody.hlxConfig);
      updates = true;
    }

    if (updates) {
      const updatedSite = await site.save();
      return ok(SiteDto.toJSON(updatedSite));
    }

    return badRequest('No updates provided');
  };

  /**
   * Creates a key event. The key event ID is generated automatically.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Key event response.
   */
  const createKeyEvent = async (context) => {
    const { siteId } = context.params;
    const { name, type, time } = context.data;

    const keyEvent = await KeyEvent.create({
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

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const keyEvents = await site.getKeyEvents();

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

    const keyEvent = await KeyEvent.findById(keyEventId);

    if (!keyEvent) {
      return notFound('Key Event not found');
    }

    await keyEvent.remove();

    return noContent();
  };

  const getSiteMetricsBySource = async (context) => {
    const siteId = context.params?.siteId;
    const metric = context.params?.metric;
    const source = context.params?.source;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(metric)) {
      return badRequest('metric required');
    }

    if (!hasText(source)) {
      return badRequest('source required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const metrics = await getStoredMetrics({ siteId, metric, source }, context);

    return ok(metrics);
  };

  const getLatestSiteMetrics = async (context) => {
    const siteId = context.params?.siteId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const rumAPIClient = RUMAPIClient.createFrom(context);
    const domain = wwwUrlResolver(site);

    try {
      const current = await rumAPIClient.query(TOTAL_METRICS, {
        domain,
        interval: MONTH_DAYS,
      });
      const total = await rumAPIClient.query(TOTAL_METRICS, {
        domain,
        interval: 2 * MONTH_DAYS,
      });
      const organicTraffic = await getStoredMetrics(
        { siteId, metric: ORGANIC_TRAFFIC, source: AHREFS },
        context,
      );

      const previousPageViews = total.totalPageViews - current.totalPageViews;
      const previousCTR = (total.totalClicks - current.totalClicks) / previousPageViews;
      const pageViewsChange = ((current.totalPageViews - previousPageViews)
        / previousPageViews) * 100;
      const ctrChange = ((current.totalCTR - previousCTR) / previousCTR) * 100;

      let cpc = 0;

      if (organicTraffic.length > 0) {
        const metric = organicTraffic[organicTraffic.length - 1];
        cpc = metric.cost / metric.value;
      }

      const projectedTrafficValue = pageViewsChange * cpc;

      log.info(`Got RUM metrics for site ${siteId} current: ${current.length}`);

      return ok({
        pageViewsChange,
        ctrChange,
        projectedTrafficValue,
      });
    } catch (error) {
      log.error(`Error getting RUM metrics for site ${siteId}: ${error.message}`);
    }

    return ok({
      pageViewsChange: 0,
      ctrChange: 0,
      projectedTrafficValue: 0,
    });
  };

  const getPageMetricsBySource = async (context) => {
    const siteId = context.params?.siteId;
    const metric = context.params?.metric;
    const source = context.params?.source;
    const encodedPageURL = context.params?.base64PageUrl;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(metric)) {
      return badRequest('metric required');
    }

    if (!hasText(source)) {
      return badRequest('source required');
    }

    if (!hasText(encodedPageURL)) {
      return badRequest('base64PageUrl required');
    }

    const decodedPageURL = Buffer.from(encodedPageURL, 'base64').toString('utf-8').trim();

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    let metrics = await getStoredMetrics({ siteId, metric, source }, context);
    metrics = metrics.filter((metricEntry) => metricEntry.url === decodedPageURL);

    return ok(metrics);
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

    // site metrics
    getSiteMetricsBySource,
    getPageMetricsBySource,
    getLatestSiteMetrics,
  };
}

export default SitesController;
