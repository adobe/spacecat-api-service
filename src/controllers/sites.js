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
  accepted,
  badRequest,
  createResponse,
  created,
  forbidden,
  internalServerError,
  noContent,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isBoolean,
  isObject,
  isArray,
  getStoredMetrics,
  isValidUUID,
  deepEqual,
  isNonEmptyObject,
} from '@adobe/spacecat-shared-utils';
import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';
import { SiteDto } from '../dto/site.js';
import { AuditDto } from '../dto/audit.js';
import { validateRepoUrl } from '../utils/validations.js';
import { KeyEventDto } from '../dto/key-event.js';
import { wwwUrlResolver, getLastTwoSundaysNoonToNoon } from '../support/utils.js';
import AccessControlUtil from '../support/access-control-util.js';
import { triggerBrandProfileAgent } from '../support/brand-profile-trigger.js';

/**
 * Sites controller. Provides methods to create, read, update and delete sites.
 * @param {object} ctx - Context of the request.
 * @returns {object} Sites controller.
 * @constructor
 */

const BRAND_PROFILE_AGENT_ID = 'brand-profile';

/**
 * Validates that pageTypes array contains valid regex patterns
 * @param {Array} pageTypes - Array of page type objects with name and pattern
 * @returns {object} Validation result with isValid boolean and error message
 */
const validatePageTypes = (pageTypes) => {
  const validationResults = pageTypes.map((pageType, index) => {
    if (!isObject(pageType)) {
      return { isValid: false, error: `pageTypes[${index}] must be an object` };
    }

    if (!hasText(pageType.name)) {
      return { isValid: false, error: `pageTypes[${index}] must have a name` };
    }

    if (!hasText(pageType.pattern)) {
      return { isValid: false, error: `pageTypes[${index}] must have a pattern` };
    }

    try {
      // eslint-disable-next-line no-new
      new RegExp(pageType.pattern);
      return { isValid: true };
    } catch (error) {
      return {
        isValid: false,
        error: `pageTypes[${index}] has invalid regex pattern: ${error.message}`,
      };
    }
  });

  const firstError = validationResults.find((result) => !result.isValid);

  return firstError || { isValid: true };
};

function SitesController(ctx, log, env) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Audit, KeyEvent, Site } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Creates a site. The site ID is generated automatically.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Site response.
   */
  const createSite = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create new sites');
    }
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
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view all sites');
    }
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
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view all sites');
    }
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
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view all sites');
    }
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
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view all sites');
    }
    const sites = await Site.all();
    return ok(SiteDto.toXLS(sites));
  };

  /**
   * Gets all sites as a CSV file.
   * @returns {Promise<Response>} CSV file.
   */
  const getAllAsCSV = async () => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view all sites');
    }
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

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its audits');
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

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its sites');
    }

    return ok(SiteDto.toJSON(site));
  };

  const getBrandProfile = async (context) => {
    const siteId = context.params?.siteId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its sites');
    }

    const config = site.getConfig();
    const profile = config?.getBrandProfile?.();
    if (!isNonEmptyObject(profile)) {
      return noContent();
    }

    return ok({ brandProfile: profile });
  };

  const triggerBrandProfile = async (context) => {
    const siteId = context.params?.siteId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its sites');
    }

    try {
      const executionName = await triggerBrandProfileAgent({
        context: ctx,
        site,
        slackContext: context.data?.slackContext,
        reason: 'sites-http',
      });

      if (!executionName) {
        throw new Error('brand profile trigger returned empty execution name');
      }

      return accepted({
        executionName,
        siteId,
      });
    } catch (error) {
      log.error(`Failed to trigger ${BRAND_PROFILE_AGENT_ID} agent for site ${siteId}`, error);
      return internalServerError('Failed to trigger brand profile agent');
    }
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

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its sites');
    }

    return ok(SiteDto.toJSON(site));
  };

  /**
   * Removes a site.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Delete response.
   */
  const removeSite = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can remove sites');
    }
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
    const { authInfo: { profile } } = context.attributes;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can update its sites');
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

    if (isBoolean(requestBody.isSandbox) && requestBody.isSandbox !== site.getIsSandbox()) {
      site.setIsSandbox(requestBody.isSandbox);
      updates = true;
    }

    if (hasText(requestBody.organizationId)
      && requestBody.organizationId !== site.getOrganizationId()) {
      return forbidden('Updating organization ID is not allowed');
    }

    if (requestBody.name !== site.getName()) {
      site.setName(requestBody.name);
      updates = true;
    }

    if (isObject(requestBody.code)) {
      site.setCode(requestBody.code);
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

    if (isObject(requestBody.config)) {
      site.setConfig(requestBody.config);
      updates = true;
    }

    const nextAuthoringType = Object.values(SiteModel.AUTHORING_TYPES)
      .includes(requestBody.authoringType)
      ? requestBody.authoringType
      : site.getAuthoringType();

    const nextDeliveryConfig = isObject(requestBody.deliveryConfig)
      ? requestBody.deliveryConfig
      : site.getDeliveryConfig();

    const nextHlxConfig = isObject(requestBody.hlxConfig)
      ? requestBody.hlxConfig
      : site.getHlxConfig();

    const authoringTypeChanged = nextAuthoringType !== site.getAuthoringType();
    const deliveryConfigChanged = !deepEqual(nextDeliveryConfig, site.getDeliveryConfig());
    const hlxConfigChanged = !deepEqual(nextHlxConfig, site.getHlxConfig());

    const authoringUpdate = authoringTypeChanged || deliveryConfigChanged || hlxConfigChanged;

    if (authoringUpdate) {
      site.setAuthoringType(nextAuthoringType);
      site.setDeliveryConfig(nextDeliveryConfig);
      site.setHlxConfig(nextHlxConfig);
      updates = true;
    }

    if (isArray(requestBody.pageTypes) && !deepEqual(requestBody.pageTypes, site.getPageTypes())) {
      // Validate pageTypes before setting
      const validation = validatePageTypes(requestBody.pageTypes);
      if (!validation.isValid) {
        return badRequest(validation.error);
      }

      site.setPageTypes(requestBody.pageTypes);
      updates = true;
    }

    // Handle localization fields
    if (requestBody.projectId !== site.getProjectId() && isValidUUID(requestBody.projectId)) {
      site.setProjectId(requestBody.projectId);
      updates = true;
    }

    if (isBoolean(requestBody.isPrimaryLocale)
        && requestBody.isPrimaryLocale !== site.getIsPrimaryLocale()) {
      site.setIsPrimaryLocale(requestBody.isPrimaryLocale);
      updates = true;
    }

    if (hasText(requestBody.language) && requestBody.language !== site.getLanguage()) {
      // Validate ISO 639-1 format
      if (!/^[a-z]{2}$/.test(requestBody.language)) {
        return badRequest('Language must be in ISO 639-1 format (2 lowercase letters)');
      }
      site.setLanguage(requestBody.language);
      updates = true;
    }

    if (hasText(requestBody.region) && requestBody.region !== site.getRegion()) {
      // Validate ISO 3166-1 alpha-2 format
      if (!/^[A-Z]{2}$/.test(requestBody.region)) {
        return badRequest('Region must be in ISO 3166-1 alpha-2 format (2 uppercase letters)');
      }
      site.setRegion(requestBody.region);
      updates = true;
    }

    if (updates) {
      site.setUpdatedBy(profile.email || 'system');
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

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can create key events');
    }

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

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its key events');
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
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can remove key events');
    }
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
    const filterByTop100PageViews = context.data?.filterByTop100PageViews === 'true';

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

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its metrics');
    }

    let metrics = await getStoredMetrics({ siteId, metric, source }, context);

    // Filter to top 100 pages by pageViews when requested
    if (filterByTop100PageViews) {
      // Sort by pageViews in descending order and take top 100
      const originalCount = metrics.length;
      metrics = metrics
        .filter((metricEntry) => metricEntry.pageviews !== undefined)
        .sort((a, b) => (b.pageviews || 0) - (a.pageviews || 0))
        .slice(0, 100);

      log.info(`Filtered metrics from ${originalCount} to ${metrics.length} entries based on top pageViews`);
    }

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

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its metrics');
    }

    const rumAPIClient = RUMAPIClient.createFrom(context);
    const domain = wwwUrlResolver(site);

    log.info(`Starting getLatestSiteMetrics for siteId: ${siteId}, domain: ${domain}`);

    try {
      log.info(`Retrieving domain key for domain: ${domain}`);
      const domainKey = await rumAPIClient.retrieveDomainkey(domain);
      log.info(`Domain key retrieved successfully for domain: ${domain}`);

      // Get last two Sundays at noon
      const sundayRanges = getLastTwoSundaysNoonToNoon();

      log.info(`Fetching latest metrics for ${sundayRanges.length} Sunday periods for site ${siteId}`);
      log.info(`Sunday ranges: ${JSON.stringify(sundayRanges.map((r) => ({ label: r.label, start: r.startTime, end: r.endTime })))}`);

      // Fetch data for both Sunday periods in parallel
      const weeklyMetrics = await Promise.all(
        sundayRanges.map(async (dateRange) => {
          const options = {
            domain,
            domainkey: domainKey,
            startTime: dateRange.startTime,
            endTime: dateRange.endTime,
            granularity: 'hourly',
          };

          log.info(`Fetching metrics for ${dateRange.label}: ${dateRange.startTime} to ${dateRange.endTime}`);

          // Fetch CWV and user engagement data in parallel
          const [cwvData, userEngagementData] = await Promise.all([
            rumAPIClient.query('cwv', options),
            rumAPIClient.query('user-engagement', options),
          ]);

          log.info(`Retrieved data for ${dateRange.label}: ${cwvData.length} CWV pages, ${userEngagementData.length} engagement pages`);

          return {
            label: dateRange.label,
            startTime: dateRange.startTime,
            endTime: dateRange.endTime,
            cwv: cwvData,
            userEngagement: userEngagementData,
          };
        }),
      );

      // Helper functions (same as mapper)
      const calculatePageLCP = (page) => {
        if (!page.metrics || page.metrics.length === 0) return null;

        const desktopMetric = page.metrics.find((m) => m.deviceType === 'desktop');
        const mobileMetric = page.metrics.find((m) => m.deviceType === 'mobile');

        const desktopPageviews = desktopMetric?.pageviews || 0;
        const mobilePageviews = mobileMetric?.pageviews || 0;
        const totalPageviews = desktopPageviews + mobilePageviews;

        if (totalPageviews === 0) return null;

        const desktopLCP = desktopMetric?.lcp || 0;
        const mobileLCP = mobileMetric?.lcp || 0;

        return (desktopLCP * desktopPageviews + mobileLCP * mobilePageviews) / totalPageviews;
      };

      const calculateSiteWideLCP = (cwvData) => {
        if (!cwvData || cwvData.length === 0) return null;

        let totalWeightedLCP = 0;
        let totalPageviews = 0;

        cwvData.forEach((page) => {
          const pageLCP = calculatePageLCP(page);
          const pageviews = page.pageviews || 0;

          if (pageLCP && pageviews) {
            totalWeightedLCP += pageLCP * pageviews;
            totalPageviews += pageviews;
          }
        });

        return totalPageviews > 0 ? totalWeightedLCP / totalPageviews : null;
      };

      const calculateAvgEngagement = (engagementData) => {
        if (!engagementData || engagementData.length === 0) return null;

        let totalEngagementTraffic = 0;
        let totalTraffic = 0;

        engagementData.forEach((page) => {
          totalEngagementTraffic += page.engagementTraffic || 0;
          totalTraffic += page.totalTraffic || 0;
        });

        return totalTraffic > 0 ? (totalEngagementTraffic / totalTraffic) * 100 : null;
      };

      const calculateTotalPageviews = (cwvData) => {
        if (!cwvData || cwvData.length === 0) return 0;
        return cwvData.reduce((sum, page) => sum + (page.pageviews || 0), 0);
      };

      // Get current and previous week data
      const currentWeek = weeklyMetrics[0];
      const previousWeek = weeklyMetrics[1];

      log.info(`Processing metrics for site ${siteId} - Current: ${currentWeek.label}, Previous: ${previousWeek.label}`);

      // Calculate metrics for both weeks
      const currentPageviews = calculateTotalPageviews(currentWeek.cwv);
      const currentLCP = calculateSiteWideLCP(currentWeek.cwv);
      const currentEngagement = calculateAvgEngagement(currentWeek.userEngagement);

      log.info(`Current week (${currentWeek.label}): pageviews=${currentPageviews}, LCP=${currentLCP?.toFixed(2)}ms, engagement=${currentEngagement?.toFixed(2)}%`);

      const previousPageviews = calculateTotalPageviews(previousWeek.cwv);
      const previousLCP = calculateSiteWideLCP(previousWeek.cwv);
      const previousEngagement = calculateAvgEngagement(previousWeek.userEngagement);

      log.info(`Previous week (${previousWeek.label}): pageviews=${previousPageviews}, LCP=${previousLCP?.toFixed(2)}ms, engagement=${previousEngagement?.toFixed(2)}%`);

      // Calculate percentage changes
      const calculateChange = (current, previous) => {
        if (!previous || previous === 0) return 0;
        return ((current - previous) / previous) * 100;
      };

      const pageviewsChange = calculateChange(currentPageviews, previousPageviews);
      const lcpChange = calculateChange(currentLCP, previousLCP);
      const engagementChange = calculateChange(currentEngagement, previousEngagement);

      log.info(`Changes for site ${siteId}: pageviews=${pageviewsChange.toFixed(2)}%, LCP=${lcpChange.toFixed(2)}%, engagement=${engagementChange.toFixed(2)}%`);

      return ok({
        currentWeek: {
          label: currentWeek.label,
          pageviews: currentPageviews,
          avgEngagement: currentEngagement,
          siteSpeed: currentLCP, // LCP in milliseconds
        },
        previousWeek: {
          label: previousWeek.label,
          pageviews: previousPageviews,
          avgEngagement: previousEngagement,
          siteSpeed: previousLCP, // LCP in milliseconds
        },
        changes: {
          pageviews: pageviewsChange,
          avgEngagement: engagementChange,
          siteSpeed: lcpChange,
        },
      });
    } catch (error) {
      log.error(`Error getting latest metrics for site ${siteId}: ${error.message}`, error);
      log.info(`Returning null metrics due to error for siteId: ${siteId}`);
      return ok({
        currentWeek: null,
        previousWeek: null,
        changes: null,
      });
    }
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

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its metrics');
    }

    let metrics = await getStoredMetrics({ siteId, metric, source }, context);
    metrics = metrics.filter((metricEntry) => metricEntry.url === decodedPageURL);

    return ok(metrics);
  };

  const updateCdnLogsConfig = async (context) => {
    const siteId = context.params?.siteId;
    const { cdnLogsConfig } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isObject(cdnLogsConfig)) {
      return badRequest('Cdn logs config required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can update its sites');
    }

    try {
      const siteConfig = site.getConfig();
      siteConfig.updateCdnLogsConfig(cdnLogsConfig);

      const configObj = Config.toDynamoItem(siteConfig);
      site.setConfig(configObj);

      const updatedSite = await site.save();
      return ok(SiteDto.toJSON(updatedSite));
    } catch (error) {
      log.error(`Error updating CDN logs config for site ${siteId}: ${error.message}`);
      return badRequest('Failed to update CDN logs config');
    }
  };

  const getTopPages = async (context) => {
    const { siteId, source, geo } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its top pages');
    }

    const { SiteTopPage } = dataAccess;

    let topPages = [];
    if (hasText(source) && hasText(geo)) {
      topPages = await SiteTopPage.allBySiteIdAndSourceAndGeo(siteId, source, geo);
    } else if (hasText(source)) {
      topPages = await SiteTopPage.allBySiteIdAndSource(siteId, source);
    } else {
      topPages = await SiteTopPage.allBySiteId(siteId);
    }

    return ok(topPages);
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
    updateCdnLogsConfig,
    getTopPages,
    getBrandProfile,
    triggerBrandProfile,

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
