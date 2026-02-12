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
  canonicalizeUrl,
  composeBaseURL,
} from '@adobe/spacecat-shared-utils';
import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';
import TierClient from '@adobe/spacecat-shared-tier-client';
import { SiteDto } from '../dto/site.js';
import { OrganizationDto } from '../dto/organization.js';
import { AuditDto } from '../dto/audit.js';
import { validateRepoUrl } from '../utils/validations.js';
import { wwwUrlResolver, resolveWwwUrl } from '../support/utils.js';
import AccessControlUtil from '../support/access-control-util.js';
import { triggerBrandProfileAgent } from '../support/brand-profile-trigger.js';

/**
 * Sites controller. Provides methods to create, read, update and delete sites.
 * @param {object} ctx - Context of the request.
 * @returns {object} Sites controller.
 * @constructor
 */

const AHREFS = 'ahrefs';
const ORGANIC_TRAFFIC = 'organic-traffic';
const MONTH_DAYS = 30;
const TOTAL_METRICS = 'totalMetrics';
const BRAND_PROFILE_AGENT_ID = 'brand-profile';

/**
 * Filters Ahrefs top pages by site base URL
 * @param {Array} topPages - Array of SiteTopPage objects
 * @param {string} siteBaseURL - Site base URL to filter by
 * @returns {Array} Filtered top pages
 */
const filterTopPagesByBaseURL = (topPages, siteBaseURL) => {
  const normalizedBaseURL = canonicalizeUrl(siteBaseURL, { stripQuery: true });

  return topPages.filter((page) => {
    const pageUrl = page.getUrl();
    if (!pageUrl) {
      return false;
    }

    const normalizedPageUrl = canonicalizeUrl(pageUrl, { stripQuery: true });
    return normalizedPageUrl.startsWith(normalizedBaseURL);
  });
};

/**
 * Gets top N pages sorted by traffic from Ahrefs data
 * @param {Array} topPages - Array of SiteTopPage objects
 * @param {number} limit - Number of top pages to return
 * @returns {Map} Map of normalized URL to original URL (maintains traffic-sorted order)
 */
const getTopPagesByTraffic = (topPages, limit) => {
  const sortedTopPages = topPages
    .sort((a, b) => (b.getTraffic() || 0) - (a.getTraffic() || 0))
    .slice(0, limit);

  const topPageUrlMap = new Map();
  sortedTopPages.forEach((page, index) => {
    const url = page.getUrl();
    if (url) {
      const normalizedUrl = canonicalizeUrl(url, { stripQuery: true });
      if (normalizedUrl && !topPageUrlMap.has(normalizedUrl)) {
        topPageUrlMap.set(normalizedUrl, { url, rank: index + 1 });
      }
    }
  });

  return topPageUrlMap;
};

/**
 * Filters and sorts metrics by top page URLs (maintains Ahrefs traffic order)
 * @param {Array} metricsData - Array of metric entries
 * @param {Map} topPageUrlMap - Map of normalized URLs to {url, rank} objects
 * @returns {Array} Filtered metrics with rank property for later sorting
 */
const filterMetricsByTopPages = (metricsData, topPageUrlMap) => {
  const seenNormalizedUrls = new Set();

  return metricsData
    .filter((metricEntry) => {
      if (!metricEntry.url) {
        return false;
      }
      const normalizedMetricUrl = canonicalizeUrl(metricEntry.url, { stripQuery: true });
      // Only include if this normalized URL matches a top page AND we haven't seen it yet
      if (normalizedMetricUrl
        && topPageUrlMap.has(normalizedMetricUrl)
        && !seenNormalizedUrls.has(normalizedMetricUrl)) {
        seenNormalizedUrls.add(normalizedMetricUrl);
        return true;
      }
      return false;
    })
    .map((metricEntry) => {
      const normalizedMetricUrl = canonicalizeUrl(metricEntry.url, { stripQuery: true });
      const { rank } = topPageUrlMap.get(normalizedMetricUrl);
      return { ...metricEntry, rank };
    });
};

/**
 * Creates placeholder entries for pages without RUM data
 * @param {Map} topPageUrlMap - Map of normalized URLs to {url, rank} objects
 * @param {Array} filteredMetrics - Array of metrics that were found
 * @returns {Array} Array of placeholder entries with rank property for later sorting
 */
const createPlaceholdersForMissingPages = (topPageUrlMap, filteredMetrics) => {
  const foundUrls = new Set(
    filteredMetrics
      .map((metric) => canonicalizeUrl(metric.url, { stripQuery: true }))
      .filter(Boolean),
  );

  const missingPages = [];
  topPageUrlMap.forEach(({ url, rank }, normalizedUrl) => {
    if (!foundUrls.has(normalizedUrl)) {
      missingPages.push({
        type: 'url',
        url,
        rank,
        pageviews: null,
        organic: null,
        metrics: [],
      });
    }
  });

  return missingPages;
};

/**
 * Applies Ahrefs top organic search pages filter to metrics data
 * @param {Array} metricsData - Original metrics data
 * @param {number} limit - Number of top pages to include
 * @param {object} options - Filter options
 * @param {string} options.siteId - Site ID
 * @param {object} options.site - Site object
 * @param {boolean} options.filterByBaseURL - Whether to filter by base URL
 * @param {string} options.geo - Geographic region (default: 'global')
 * @param {object} options.dataAccess - Data access object
 * @param {object} options.log - Logger object
 * @returns {Promise<Array>} Filtered and sorted metrics data
 */
const applyTopOrganicPagesFilter = async (metricsData, limit, options) => {
  const {
    siteId, site, filterByBaseURL, geo = 'global', dataAccess, log,
  } = options;

  const { SiteTopPage } = dataAccess;

  // Fetch Ahrefs pages
  let topPages = await SiteTopPage.allBySiteIdAndSourceAndGeo(siteId, 'ahrefs', geo);

  if (!topPages || topPages.length === 0) {
    log.warn(`No Ahrefs top pages found for site ${siteId}, returning empty result`);
    return [];
  }

  // Apply base URL filter if requested
  if (filterByBaseURL) {
    topPages = filterTopPagesByBaseURL(topPages, site.getBaseURL());

    // If no pages match the base URL after filtering, return empty result
    if (topPages.length === 0) {
      log.warn(`No Ahrefs top pages match base URL for site ${siteId}, returning empty result`);
      return [];
    }
  }

  // Filter and combine metrics
  const topPageUrlMap = getTopPagesByTraffic(topPages, limit);
  const filteredMetrics = filterMetricsByTopPages(metricsData, topPageUrlMap);
  const missingPages = createPlaceholdersForMissingPages(topPageUrlMap, filteredMetrics);

  // Combine and sort by Ahrefs traffic rank, then remove rank property
  const result = [...filteredMetrics, ...missingPages]
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank: _, ...entry }) => entry);

  return result;
};

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

  const {
    Audit, Organization, Site,
  } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Creates a new site or returns an existing one if a site with the same baseURL already exists.
   * Implements idempotent-create semantics.
   *
   * Design Decision: Returns HTTP 200 (not 409 Conflict) for duplicates
   * Rationale:
   * - Follows idempotent-create pattern: same request yields same result
   * - Allows safe retries without client-side duplicate detection logic
   * - 200 indicates "request succeeded, here's the site you asked for"
   * - 409 would require clients to handle conflict errors and retry with GET
   * - Common pattern in APIs prioritizing developer experience (e.g., Stripe, GitHub)
   *
   * Alternative: If strict REST semantics are preferred, 409 Conflict is also valid.
   *
   * @param {object} context - Request context containing site data
   * @returns {Promise<Response>} HTTP 200 with existing site or 201 with new site
   */
  const createSite = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create new sites');
    }
    if (!hasText(context.data?.baseURL)) {
      return badRequest('Base URL required');
    }
    try {
      const baseURL = composeBaseURL(context.data.baseURL);
      const existingSite = await Site.findByBaseURL(baseURL);
      if (existingSite) {
        // Idempotent behavior: return existing site with 200 (not 409)
        log.info(`Site already exists for baseURL: ${baseURL}, returning existing site ${existingSite.getId()}`);
        return createResponse(SiteDto.toJSON(existingSite), 200);
      }
      const site = await Site.create({
        organizationId: env.DEFAULT_ORGANIZATION_ID,
        ...context.data,
        baseURL, // override with normalized value
      });
      return createResponse(SiteDto.toJSON(site), 201);
    } catch (error) {
      log.error(`Error creating site: ${error.message}`, error);
      return internalServerError('Failed to create site');
    }
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
  const removeSite = async () => forbidden('Restricted Operation');

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

  const getSiteMetricsBySource = async (context) => {
    const siteId = context.params?.siteId;
    const metric = context.params?.metric;
    const source = context.params?.source;
    const filterByTop100PageViews = context.data?.filterByTop100PageViews === 'true';
    const filterByBaseURL = context.data?.filterByBaseURL === 'true';
    const filterByTopOrganicSearchPages = context.data?.filterByTopOrganicSearchPages;
    const geo = context.data?.geo || 'global';
    // Key to extract from object response, e.g., 'data' in { label, data: [...] }
    const objectResponseDataKey = context.data?.objectResponseDataKey;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(metric)) {
      return badRequest('metric required');
    }

    if (!hasText(source)) {
      return badRequest('source required');
    }

    if (hasText(filterByTopOrganicSearchPages)) {
      const limit = parseInt(filterByTopOrganicSearchPages, 10);
      if (Number.isNaN(limit) || limit < 1) {
        return badRequest('filterByTopOrganicSearchPages must be a positive integer');
      }
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view its metrics');
    }

    const metrics = await getStoredMetrics({ siteId, metric, source }, context);

    // Handle object response: extract array from key if objectResponseDataKey is provided
    let metricsData;
    let objectWrapper = null;

    if (objectResponseDataKey && isObject(metrics) && !isArray(metrics)
        && isArray(metrics[objectResponseDataKey])) {
      // Stored data is an object with array at specified key
      metricsData = metrics[objectResponseDataKey];
      objectWrapper = metrics;
    } else {
      // Stored data is a plain array (backward compatible)
      metricsData = metrics;
    }

    // Filter by site baseURL when requested
    if (filterByBaseURL) {
      const siteBaseURL = site.getBaseURL();
      const originalCount = metricsData.length;

      // Normalize baseURL: remove protocol and www variants, keep path
      const normalizedBaseURL = siteBaseURL
        .replace(/^https?:\/\/(www\d*\.)?/, '') // Remove protocol and optional www/www2/www3 etc.
        .replace(/\/$/, ''); // Remove trailing slash

      metricsData = metricsData.filter((metricEntry) => {
        if (!metricEntry.url || !normalizedBaseURL) {
          return false;
        }

        // Normalize metric URL: remove protocol and www variants
        const normalizedMetricURL = metricEntry.url
          .replace(/^https?:\/\/(www\d*\.)?/, '') // Remove protocol and optional www/www2/www3 etc.
          .replace(/\/$/, ''); // Remove trailing slash

        // Check if metric URL starts with the normalized base URL
        return normalizedMetricURL.startsWith(normalizedBaseURL);
      });

      log.info(`Filtered metrics from ${originalCount} to ${metricsData.length} entries based on site baseURL (${normalizedBaseURL})`);
    }

    // Filter by top N organic search pages from Ahrefs when requested
    if (filterByTopOrganicSearchPages) {
      try {
        const limit = parseInt(filterByTopOrganicSearchPages, 10);
        metricsData = await applyTopOrganicPagesFilter(metricsData, limit, {
          siteId,
          site,
          filterByBaseURL,
          geo,
          dataAccess,
          log,
        });
      } catch (error) {
        log.error(`Error filtering by top organic search pages for site ${siteId}: ${error.message}`);
        return internalServerError(error.message);
      }
    }

    // Filter to top 100 pages by pageViews when requested (applied last)
    if (filterByTop100PageViews) {
      // Sort by pageViews in descending order and take top 100
      const originalCount = metricsData.length;
      metricsData = metricsData
        .filter((metricEntry) => metricEntry.pageviews !== undefined)
        .sort((a, b) => (b.pageviews || 0) - (a.pageviews || 0))
        .slice(0, 100);

      log.info(`Filtered metrics from ${originalCount} to ${metricsData.length} entries based on top pageViews`);
    }

    // Return object wrapper if objectResponseDataKey was used, otherwise return plain array
    if (objectWrapper) {
      return ok({ ...objectWrapper, [objectResponseDataKey]: metricsData });
    }
    return ok(metricsData);
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
    const domain = await resolveWwwUrl(site, context);

    try {
      const now = new Date();
      const todayUTC = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0,
      ));
      const thirtyDaysAgo = new Date(todayUTC.getTime() - MONTH_DAYS * 24 * 60 * 60 * 1000);
      const sixtyDaysAgo = new Date(todayUTC.getTime() - 2 * MONTH_DAYS * 24 * 60 * 60 * 1000);

      const current = await rumAPIClient.query(TOTAL_METRICS, {
        domain,
        startTime: thirtyDaysAgo.toISOString(),
        endTime: todayUTC.toISOString(),
      });
      const previous = await rumAPIClient.query(TOTAL_METRICS, {
        domain,
        startTime: sixtyDaysAgo.toISOString(),
        endTime: thirtyDaysAgo.toISOString(),
      });
      const organicTraffic = await getStoredMetrics(
        { siteId, metric: ORGANIC_TRAFFIC, source: AHREFS },
        context,
      );

      const pageViewsChange = previous.totalPageViews !== 0
        ? ((current.totalPageViews - previous.totalPageViews) / previous.totalPageViews) * 100
        : 0;
      const ctrChange = previous.totalCTR !== 0
        ? ((current.totalCTR - previous.totalCTR) / previous.totalCTR) * 100
        : 0;

      const currentLCP = current.totalLCP;
      const previousLCP = previous.totalLCP;

      const currentEngagement = current.totalEngagement || 0;
      const previousEngagement = previous.totalEngagement || 0;

      const currentConversion = current.totalClicks || 0;
      const previousConversion = previous.totalClicks || 0;

      let cpc = 0;

      if (organicTraffic.length > 0) {
        const metric = organicTraffic[organicTraffic.length - 1];
        cpc = metric.cost / metric.value;
      }

      const projectedTrafficValue = pageViewsChange * cpc;

      return ok({
        pageViewsChange,
        ctrChange,
        projectedTrafficValue,
        currentPageViews: current.totalPageViews,
        previousPageViews: previous.totalPageViews,
        currentLCP,
        previousLCP,
        currentEngagement,
        previousEngagement,
        currentConversion,
        previousConversion,
      });
    } catch (error) {
      log.error(`Error getting RUM metrics for site ${siteId}: ${error.message}`);
    }

    return ok({
      pageViewsChange: 0,
      ctrChange: 0,
      projectedTrafficValue: 0,
      currentLCP: null,
      previousPageViews: 0,
      currentPageViews: 0,
      currentConversion: 0,
      previousConversion: 0,
      previousLCP: null,
      previousEngagement: 0,
      currentEngagement: 0,
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

  /**
   * Resolves site and organization data based on query parameters.
   * Tries siteId first, then checks either organizationId or imsOrg (mutually exclusive).
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Resolved site and organization data response.
   */
  const resolveSite = async (context) => {
    const { organizationId, imsOrg, siteId } = context.data;
    const { pathInfo } = context;
    const X_PRODUCT_HEADER = 'x-product';
    const productCode = pathInfo.headers[X_PRODUCT_HEADER];

    if (!hasText(productCode)) {
      return badRequest('Product code required in x-product header');
    }

    if (!hasText(organizationId) && !hasText(imsOrg)) {
      return badRequest('Either organizationId or imsOrg must be provided');
    }

    let organization;
    let site;

    try {
      if (hasText(siteId) && isValidUUID(siteId)) {
        site = await Site.findById(siteId);
        if (site) {
          const orgId = site.getOrganizationId();
          if (orgId) {
            organization = await Organization.findById(orgId);
            if (organization) {
              if (hasText(organizationId) && organization.getId() !== organizationId) {
                organization = null;
              } else if (hasText(imsOrg) && organization.getImsOrgId() !== imsOrg) {
                organization = null;
              }
            }
            if (organization && await accessControlUtil.hasAccess(organization)) {
              const tierClient = await TierClient.createForSite(context, site, productCode);
              const { entitlement, enrollments } = await tierClient.getAllEnrollment();

              if (entitlement && enrollments?.length) {
                const data = {
                  organization: OrganizationDto.toJSON(organization),
                  site: SiteDto.toJSON(site),
                };

                return ok({ data });
              }
            }
          }
        }
      }

      if (hasText(organizationId) && isValidUUID(organizationId)) {
        organization = await Organization.findById(organizationId);
        if (organization && await accessControlUtil.hasAccess(organization)) {
          const tierClient = TierClient.createForOrg(context, organization, productCode);
          const { site: enrolledSite } = await tierClient.getFirstEnrollment();

          if (enrolledSite) {
            const data = {
              organization: OrganizationDto.toJSON(organization),
              site: SiteDto.toJSON(enrolledSite),
            };

            return ok({ data });
          }
        }
      } else if (hasText(imsOrg)) {
        organization = await Organization.findByImsOrgId(imsOrg);
        if (organization && await accessControlUtil.hasAccess(organization)) {
          const tierClient = TierClient.createForOrg(context, organization, productCode);
          const { site: enrolledSite } = await tierClient.getFirstEnrollment();

          if (enrolledSite) {
            const data = {
              organization: OrganizationDto.toJSON(organization),
              site: SiteDto.toJSON(enrolledSite),
            };

            return ok({ data });
          }
        }
      }

      return notFound('No site found for the provided parameters');
    } catch (error) {
      log.error(`Error resolving site: ${error.message}`);
      return badRequest('Failed to resolve site');
    }
  };

  const getGraph = async (context) => {
    const siteId = context.params?.siteId;
    const {
      urls, startDate, endDate, granularity,
    } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view graph data');
    }

    // Validate required parameters
    if (!isArray(urls) || urls.length === 0) {
      return badRequest('urls array is required and must not be empty');
    }

    if (!hasText(startDate)) {
      return badRequest('startDate is required');
    }

    if (!hasText(endDate)) {
      return badRequest('endDate is required');
    }

    if (!hasText(granularity)) {
      return badRequest('granularity is required');
    }

    const rumAPIClient = RUMAPIClient.createFrom(context);
    const domain = wwwUrlResolver(site);

    try {
      const params = {
        domain,
        urls,
        startTime: startDate,
        endTime: endDate,
        granularity,
      };

      const graphData = await rumAPIClient.query('optimization-report-graph', params);

      return ok(graphData);
    } catch (error) {
      log.error(`Error getting optimization report graph for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to retrieve graph data');
    }
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
    resolveSite,
    getBrandProfile,
    triggerBrandProfile,

    // site metrics
    getSiteMetricsBySource,
    getPageMetricsBySource,
    getLatestSiteMetrics,
    getGraph,
  };
}

export default SitesController;
