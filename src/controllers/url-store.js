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
  notFound,
  ok,
  forbidden,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isValidUrl,
  isValidUUID,
  isNonEmptyObject,
  isArray,
} from '@adobe/spacecat-shared-utils';
import { PLATFORM_TYPES } from '@adobe/spacecat-shared-data-access';

import AccessControlUtil from '../support/access-control-util.js';

const MAX_URLS_PER_REQUEST = 100;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const VALID_PLATFORM_TYPES = Object.values(PLATFORM_TYPES);

/**
 * Canonicalizes a URL by removing trailing slashes, converting to lowercase domain, etc.
 * @param {string} url - The URL to canonicalize
 * @returns {string} - Canonicalized URL
 */
function canonicalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    // Lowercase the hostname
    urlObj.hostname = urlObj.hostname.toLowerCase();
    // Remove trailing slash from pathname unless it's the root
    if (urlObj.pathname !== '/' && urlObj.pathname.endsWith('/')) {
      urlObj.pathname = urlObj.pathname.slice(0, -1);
    }
    // Sort query parameters for consistent ordering
    urlObj.searchParams.sort();
    return urlObj.toString();
  } catch (error) {
    return url; // Return original if parsing fails
  }
}

/**
 * Decodes a URL-safe base64 string to a URL
 * @param {string} base64Url - The base64 encoded URL
 * @returns {string} - Decoded URL
 */
function decodeBase64ToUrl(base64Url) {
  // Convert from URL-safe base64 to standard base64
  let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if needed
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * URL Store controller for managing audit URLs.
 * @param {object} ctx - Context of the request.
 * @param {object} log - Logger instance.
 * @returns {object} URL Store controller.
 * @constructor
 */
function UrlStoreController(ctx, log) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Site, AuditUrl } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Get the authenticated user identifier from the context.
   * @param {object} context - Request context
   * @returns {string} - User identifier
   */
  function getUserIdentifier(context) {
    const authInfo = context.attributes?.authInfo;
    if (authInfo) {
      const profile = authInfo.getProfile();
      return profile?.email || profile?.name || 'system';
    }
    return 'system';
  }

  /**
   * List all URLs for a site with pagination and sorting.
   * GET /sites/{siteId}/url-store
   */
  const listUrls = async (context) => {
    const { siteId } = context.params;
    const {
      limit = DEFAULT_LIMIT,
      cursor,
      sortBy,
      sortOrder = 'asc',
    } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    // Validate sortBy field
    const validSortFields = ['rank', 'traffic', 'url', 'createdAt', 'updatedAt'];
    if (sortBy && !validSortFields.includes(sortBy)) {
      return badRequest(`Invalid sortBy field. Must be one of: ${validSortFields.join(', ')}`);
    }

    // Validate sortOrder
    if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
      return badRequest('Invalid sortOrder. Must be "asc" or "desc"');
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view URLs');
    }

    try {
      const result = await AuditUrl.allBySiteIdSorted(siteId, {
        limit: parsedLimit,
        cursor,
        sortBy,
        sortOrder,
      });

      return ok({
        items: result.items || [],
        cursor: result.cursor,
      });
    } catch (error) {
      log.error(`Error listing URLs for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to list URLs');
    }
  };

  /**
   * List URLs by source with pagination and sorting.
   * GET /sites/{siteId}/url-store/by-source/{source}
   */
  const listUrlsBySource = async (context) => {
    const { siteId, source } = context.params;
    const {
      limit = DEFAULT_LIMIT,
      cursor,
      sortBy,
      sortOrder = 'asc',
    } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(source)) {
      return badRequest('Source required');
    }

    // Validate sortBy field
    const validSortFields = ['rank', 'traffic', 'url', 'createdAt', 'updatedAt'];
    if (sortBy && !validSortFields.includes(sortBy)) {
      return badRequest(`Invalid sortBy field. Must be one of: ${validSortFields.join(', ')}`);
    }

    // Validate sortOrder
    if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
      return badRequest('Invalid sortOrder. Must be "asc" or "desc"');
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view URLs');
    }

    try {
      const result = await AuditUrl.allBySiteIdAndSourceSorted(siteId, source, {
        limit: parsedLimit,
        cursor,
        sortBy,
        sortOrder,
      });

      return ok({
        items: result.items || [],
        cursor: result.cursor,
      });
    } catch (error) {
      log.error(`Error listing URLs by source for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to list URLs by source');
    }
  };

  /**
   * List URLs by audit type with pagination and sorting.
   * GET /sites/{siteId}/url-store/by-audit/{auditType}
   */
  const listUrlsByAuditType = async (context) => {
    const { siteId, auditType } = context.params;
    const {
      limit = DEFAULT_LIMIT,
      cursor,
      sortBy,
      sortOrder = 'asc',
    } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(auditType)) {
      return badRequest('Audit type required');
    }

    // Validate sortBy field
    const validSortFields = ['rank', 'traffic', 'url', 'createdAt', 'updatedAt'];
    if (sortBy && !validSortFields.includes(sortBy)) {
      return badRequest(`Invalid sortBy field. Must be one of: ${validSortFields.join(', ')}`);
    }

    // Validate sortOrder
    if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
      return badRequest('Invalid sortOrder. Must be "asc" or "desc"');
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view URLs');
    }

    try {
      const result = await AuditUrl.allBySiteIdAndAuditType(siteId, auditType, {
        limit: parsedLimit,
        cursor,
        sortBy,
        sortOrder,
      });

      return ok({
        items: result || [],
        cursor: undefined,
      });
    } catch (error) {
      log.error(`Error listing URLs by audit type for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to list URLs by audit type');
    }
  };

  /**
   * List URLs by platform type with pagination and sorting.
   * GET /sites/{siteId}/url-store/by-platform/{platformType}
   */
  const listUrlsByPlatform = async (context) => {
    const { siteId, platformType } = context.params;
    const {
      limit = DEFAULT_LIMIT,
      cursor,
      sortBy,
      sortOrder = 'asc',
    } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(platformType)) {
      return badRequest('Platform type required');
    }

    // Validate platformType
    if (!VALID_PLATFORM_TYPES.includes(platformType)) {
      return badRequest(`Invalid platform type. Must be one of: ${VALID_PLATFORM_TYPES.join(', ')}`);
    }

    // Validate sortBy field
    const validSortFields = ['rank', 'traffic', 'url', 'createdAt', 'updatedAt'];
    if (sortBy && !validSortFields.includes(sortBy)) {
      return badRequest(`Invalid sortBy field. Must be one of: ${validSortFields.join(', ')}`);
    }

    // Validate sortOrder
    if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
      return badRequest('Invalid sortOrder. Must be "asc" or "desc"');
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view URLs');
    }

    try {
      const result = await AuditUrl.allBySiteIdAndPlatform(siteId, platformType, {
        limit: parsedLimit,
        cursor,
        sortBy,
        sortOrder,
      });

      return ok({
        items: result.items || [],
        cursor: result.cursor,
      });
    } catch (error) {
      log.error(`Error listing URLs by platform type for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to list URLs by platform type');
    }
  };

  /**
   * List all offsite platform URLs (excludes primary-site).
   * GET /sites/{siteId}/url-store/offsite
   */
  const listOffsiteUrls = async (context) => {
    const { siteId } = context.params;
    const {
      limit = DEFAULT_LIMIT,
      cursor,
      sortBy,
      sortOrder = 'asc',
    } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    // Validate sortBy field
    const validSortFields = ['rank', 'traffic', 'url', 'createdAt', 'updatedAt'];
    if (sortBy && !validSortFields.includes(sortBy)) {
      return badRequest(`Invalid sortBy field. Must be one of: ${validSortFields.join(', ')}`);
    }

    // Validate sortOrder
    if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
      return badRequest('Invalid sortOrder. Must be "asc" or "desc"');
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view URLs');
    }

    try {
      const result = await AuditUrl.allOffsiteUrls(siteId, {
        limit: parsedLimit,
        cursor,
        sortBy,
        sortOrder,
      });

      return ok({
        items: result.items || [],
        cursor: result.cursor,
      });
    } catch (error) {
      log.error(`Error listing offsite URLs for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to list offsite URLs');
    }
  };

  /**
   * Get a specific URL by base64 encoded URL.
   * GET /sites/{siteId}/url-store/{base64Url}
   */
  const getUrl = async (context) => {
    const { siteId, base64Url } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(base64Url)) {
      return badRequest('URL required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view URLs');
    }

    try {
      const url = decodeBase64ToUrl(base64Url);
      const canonicalUrl = canonicalizeUrl(url);
      const auditUrl = await AuditUrl.findBySiteIdAndUrl(siteId, canonicalUrl);

      if (!auditUrl) {
        return notFound('URL not found');
      }

      return ok(auditUrl);
    } catch (error) {
      log.error(`Error getting URL for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to get URL');
    }
  };

  /**
   * Add URLs in bulk (idempotent, upsert behavior).
   * POST /sites/{siteId}/url-store
   */
  const addUrls = async (context) => {
    const { siteId } = context.params;
    const urls = context.data;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isArray(urls) || urls.length === 0) {
      return badRequest('URLs array required');
    }

    if (urls.length > MAX_URLS_PER_REQUEST) {
      return badRequest(`Maximum ${MAX_URLS_PER_REQUEST} URLs per request`);
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can add URLs');
    }

    const userId = getUserIdentifier(context);

    // Process all URLs in parallel using Promise.allSettled
    const urlProcessingPromises = urls.map(async (urlData) => {
      // Validate URL
      if (!hasText(urlData.url) || !isValidUrl(urlData.url)) {
        return {
          success: false,
          url: urlData.url || 'undefined',
          reason: 'Invalid URL format',
        };
      }

      try {
        // Canonicalize URL
        const canonicalUrl = canonicalizeUrl(urlData.url);

        // Validate audits array
        const audits = isArray(urlData.audits) ? urlData.audits : [];

        // Extract rank and traffic if provided
        const rank = urlData.rank !== undefined ? urlData.rank : null;
        const traffic = urlData.traffic !== undefined ? urlData.traffic : null;

        // Extract and validate platformType if provided
        const platformType = urlData.platformType || PLATFORM_TYPES.PRIMARY_SITE;
        if (platformType && !VALID_PLATFORM_TYPES.includes(platformType)) {
          return {
            success: false,
            url: urlData.url,
            reason: `Invalid platformType. Must be one of: ${VALID_PLATFORM_TYPES.join(', ')}`,
          };
        }

        // Check if URL already exists (idempotent)
        let existingUrl = await AuditUrl.findBySiteIdAndUrl(siteId, canonicalUrl);

        if (existingUrl) {
          // Upsert: update to manual source and merge audits if user-provided
          if (urlData.source === 'manual' || !existingUrl.getSource || existingUrl.getSource() !== 'manual') {
            existingUrl.setSource('manual');
            existingUrl.setAudits(audits);
            if (rank !== null) existingUrl.setRank(rank);
            if (traffic !== null) existingUrl.setTraffic(traffic);
            if (platformType) existingUrl.setPlatformType(platformType);
            existingUrl.setUpdatedBy(userId);
            existingUrl = await existingUrl.save();
          }
          return { success: true, data: existingUrl };
        }

        // Create new URL
        const newUrl = await AuditUrl.create({
          siteId,
          url: canonicalUrl,
          source: urlData.source || 'manual',
          audits,
          rank,
          traffic,
          platformType,
          createdBy: userId,
          updatedBy: userId,
        });
        return { success: true, data: newUrl };
      } catch (error) {
        log.error(`Error adding URL ${urlData.url}: ${error.message}`);
        return {
          success: false,
          url: urlData.url,
          reason: error.message || 'Internal error',
        };
      }
    });

    // Wait for all promises to settle
    const settledResults = await Promise.allSettled(urlProcessingPromises);

    // Process results
    const results = [];
    const failures = [];
    let successCount = 0;

    settledResults.forEach((settled) => {
      if (settled.status === 'fulfilled') {
        const result = settled.value;
        if (result.success) {
          results.push(result.data);
          successCount += 1;
        } else {
          failures.push({ url: result.url, reason: result.reason });
        }
      } else {
        failures.push({ url: 'unknown', reason: settled.reason?.message || 'Promise rejected' });
      }
    });

    return createResponse({
      metadata: {
        total: urls.length,
        success: successCount,
        failure: failures.length,
      },
      failures,
      items: results,
    }, 201);
  };

  /**
   * Update audit configurations for URLs in bulk.
   * PATCH /sites/{siteId}/url-store
   */
  const updateUrls = async (context) => {
    const { siteId } = context.params;
    const updates = context.data;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isArray(updates) || updates.length === 0) {
      return badRequest('Updates array required');
    }

    if (updates.length > MAX_URLS_PER_REQUEST) {
      return badRequest(`Maximum ${MAX_URLS_PER_REQUEST} URLs per request`);
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can update URLs');
    }

    const userId = getUserIdentifier(context);

    // Process all updates in parallel using Promise.allSettled
    const updateProcessingPromises = updates.map(async (update) => {
      // Validate URL
      if (!hasText(update.url)) {
        return {
          success: false,
          url: 'undefined',
          reason: 'URL required',
        };
      }

      if (!isArray(update.audits)) {
        return {
          success: false,
          url: update.url,
          reason: 'Audits array required',
        };
      }

      try {
        const canonicalUrl = canonicalizeUrl(update.url);
        let auditUrl = await AuditUrl.findBySiteIdAndUrl(siteId, canonicalUrl);

        if (!auditUrl) {
          return {
            success: false,
            url: update.url,
            reason: 'URL not found',
          };
        }

        // Update audits (overrides existing)
        auditUrl.setAudits(update.audits);

        // Update rank if provided
        if ('rank' in update) {
          auditUrl.setRank(update.rank);
        }

        // Update traffic if provided
        if ('traffic' in update) {
          auditUrl.setTraffic(update.traffic);
        }

        // Update platformType if provided
        if ('platformType' in update) {
          if (update.platformType && !VALID_PLATFORM_TYPES.includes(update.platformType)) {
            return {
              success: false,
              url: update.url,
              reason: `Invalid platformType. Must be one of: ${VALID_PLATFORM_TYPES.join(', ')}`,
            };
          }
          auditUrl.setPlatformType(update.platformType);
        }

        auditUrl.setUpdatedBy(userId);
        auditUrl = await auditUrl.save();

        return { success: true, data: auditUrl };
      } catch (error) {
        log.error(`Error updating URL ${update.url}: ${error.message}`);
        return {
          success: false,
          url: update.url,
          reason: error.message || 'Internal error',
        };
      }
    });

    // Wait for all promises to settle
    const settledResults = await Promise.allSettled(updateProcessingPromises);

    // Process results
    const results = [];
    const failures = [];
    let successCount = 0;

    settledResults.forEach((settled) => {
      if (settled.status === 'fulfilled') {
        const result = settled.value;
        if (result.success) {
          results.push(result.data);
          successCount += 1;
        } else {
          failures.push({ url: result.url, reason: result.reason });
        }
      } else {
        failures.push({ url: 'unknown', reason: settled.reason?.message || 'Promise rejected' });
      }
    });

    return ok({
      metadata: {
        total: updates.length,
        success: successCount,
        failure: failures.length,
      },
      failures,
      items: results,
    });
  };

  /**
   * Remove URLs in bulk (only manual sources).
   * DELETE /sites/{siteId}/url-store
   */
  const deleteUrls = async (context) => {
    const { siteId } = context.params;
    const { urls } = context.data;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isArray(urls) || urls.length === 0) {
      return badRequest('URLs array required');
    }

    if (urls.length > MAX_URLS_PER_REQUEST) {
      return badRequest(`Maximum ${MAX_URLS_PER_REQUEST} URLs per request`);
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can delete URLs');
    }

    // Process all deletions in parallel using Promise.allSettled
    const deleteProcessingPromises = urls.map(async (url) => {
      // Validate URL
      if (!hasText(url)) {
        return {
          success: false,
          url: 'undefined',
          reason: 'URL required',
        };
      }

      try {
        const canonicalUrl = canonicalizeUrl(url);
        const auditUrl = await AuditUrl.findBySiteIdAndUrl(siteId, canonicalUrl);

        if (!auditUrl) {
          return {
            success: false,
            url,
            reason: 'URL not found',
          };
        }

        // Check if source is manual
        const source = auditUrl.getSource ? auditUrl.getSource() : auditUrl.source;
        if (source !== 'manual') {
          return {
            success: false,
            url,
            reason: 'Can only delete URLs with source: manual',
          };
        }

        await auditUrl.remove();
        return { success: true };
      } catch (error) {
        log.error(`Error deleting URL ${url}: ${error.message}`);
        return {
          success: false,
          url,
          reason: error.message || 'Internal error',
        };
      }
    });

    // Wait for all promises to settle
    const settledResults = await Promise.allSettled(deleteProcessingPromises);

    // Process results
    const failures = [];
    let successCount = 0;

    settledResults.forEach((settled) => {
      if (settled.status === 'fulfilled') {
        const result = settled.value;
        if (result.success) {
          successCount += 1;
        } else {
          failures.push({ url: result.url, reason: result.reason });
        }
      } else {
        failures.push({ url: 'unknown', reason: settled.reason?.message || 'Promise rejected' });
      }
    });

    return ok({
      metadata: {
        total: urls.length,
        success: successCount,
        failure: failures.length,
      },
      failures,
    });
  };

  return {
    listUrls,
    listUrlsBySource,
    listUrlsByAuditType,
    listUrlsByPlatform,
    listOffsiteUrls,
    getUrl,
    addUrls,
    updateUrls,
    deleteUrls,
  };
}

export default UrlStoreController;
