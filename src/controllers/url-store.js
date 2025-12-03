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
  isInteger,
} from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';
import { AuditUrlDto } from '../dto/audit-url.js';

const MAX_URLS_PER_REQUEST = 100;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Canonicalizes a URL by:
 * - Lowercasing the hostname
 * - Stripping port, trailing dot, trailing slash
 * - Removing query parameters
 * - Prepending https:// schema if missing
 * @param {string} url - The URL to canonicalize
 * @returns {string} - Canonicalized URL
 */
function canonicalizeUrl(url) {
  try {
    // Normalize: lowercase hostname, strip port, remove query params, ensure https
    // Note: isValidUrl() validates URLs before this runs, so protocol is always present
    const urlObj = new URL(url);

    // Lowercase the hostname
    urlObj.hostname = urlObj.hostname.toLowerCase();

    // Remove port
    urlObj.port = '';

    // Remove query parameters
    urlObj.search = '';

    // Remove hash
    urlObj.hash = '';

    // Get the URL string
    let canonicalUrl = urlObj.toString();

    // Remove trailing slash (unless it's just the domain)
    if (canonicalUrl.endsWith('/') && urlObj.pathname !== '/') {
      canonicalUrl = canonicalUrl.slice(0, -1);
    }

    // Ensure https
    if (canonicalUrl.startsWith('http://')) {
      canonicalUrl = canonicalUrl.replace('http://', 'https://');
    }

    return canonicalUrl;
    /* c8 ignore start */
  } catch (error) {
    // Defensive: isValidUrl() validates before canonicalizeUrl() runs
    return url;
  }
  /* c8 ignore stop */
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
   * Supports optional byCustomer filter (defaults to true for customer-added URLs).
   * GET /sites/{siteId}/url-store?byCustomer=true|false
   */
  const listUrls = async (context) => {
    const { siteId } = context.params;
    const {
      limit = DEFAULT_LIMIT,
      cursor,
      sortBy,
      sortOrder = 'asc',
      byCustomer, // Optional: true for customer-added, false for system-added
    } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    // Validate byCustomer parameter if provided
    if (byCustomer !== undefined && typeof byCustomer !== 'boolean' && byCustomer !== 'true' && byCustomer !== 'false') {
      return badRequest('byCustomer must be a boolean (true or false)');
    }

    // Convert string to boolean if needed, default to true
    const byCustomerFilter = byCustomer === undefined ? true : (byCustomer === true || byCustomer === 'true');

    // Validate sortBy field (removed rank and traffic)
    const validSortFields = ['url', 'createdAt', 'updatedAt'];
    if (sortBy && !validSortFields.includes(sortBy)) {
      return badRequest(`Invalid sortBy field. Must be one of: ${validSortFields.join(', ')}`);
    }

    // Validate sortOrder
    if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
      return badRequest('Invalid sortOrder. Must be "asc" or "desc"');
    }

    // Validate limit
    const parsedLimit = parseInt(limit, 10);
    if (!isInteger(parsedLimit) || parsedLimit < 1) {
      return badRequest('Page size must be greater than 0');
    }
    const effectiveLimit = Math.min(parsedLimit, MAX_LIMIT);

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view URLs');
    }

    try {
      // If byCustomer filter was explicitly provided or defaulted, filter by it
      const result = await AuditUrl.allBySiteIdByCustomerSorted(siteId, byCustomerFilter, {
        limit: effectiveLimit,
        cursor,
        sortBy,
        sortOrder,
      });

      return ok({
        items: (result.items || []).map(AuditUrlDto.toJSON),
        pagination: {
          limit: effectiveLimit,
          cursor: result.cursor ?? null,
          hasMore: !!result.cursor,
        },
      });
    } catch (error) {
      log.error(`Error listing URLs for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to list URLs');
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

    // Validate sortBy field (removed rank and traffic)
    const validSortFields = ['url', 'createdAt', 'updatedAt'];
    if (sortBy && !validSortFields.includes(sortBy)) {
      return badRequest(`Invalid sortBy field. Must be one of: ${validSortFields.join(', ')}`);
    }

    // Validate sortOrder
    if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
      return badRequest('Invalid sortOrder. Must be "asc" or "desc"');
    }

    // Validate limit
    const parsedLimit = parseInt(limit, 10);
    if (!isInteger(parsedLimit) || parsedLimit < 1) {
      return badRequest('Page size must be greater than 0');
    }
    const effectiveLimit = Math.min(parsedLimit, MAX_LIMIT);

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view URLs');
    }

    try {
      const result = await AuditUrl.allBySiteIdAndAuditType(siteId, auditType, {
        limit: effectiveLimit,
        cursor,
        sortBy,
        sortOrder,
      });

      // Handle both array and paginated response formats
      const items = Array.isArray(result) ? result : (result.items || []);
      const resultCursor = Array.isArray(result) ? undefined : result.cursor;

      return ok({
        items: items.map(AuditUrlDto.toJSON),
        pagination: {
          limit: effectiveLimit,
          cursor: resultCursor ?? null,
          hasMore: !!resultCursor,
        },
      });
    } catch (error) {
      log.error(`Error listing URLs by audit type for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to list URLs by audit type');
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

      return ok(AuditUrlDto.toJSON(auditUrl));
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

    // Process all URLs in parallel
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

        // Extract byCustomer flag, default to true
        const byCustomer = urlData.byCustomer !== undefined ? urlData.byCustomer : true;

        // Check if URL already exists (idempotent)
        let existingUrl = await AuditUrl.findBySiteIdAndUrl(siteId, canonicalUrl);

        if (existingUrl) {
          // Upsert: update if claiming ownership or existing is not customer-owned
          if (byCustomer || existingUrl.getByCustomer() !== true) {
            existingUrl.setByCustomer(byCustomer);
            existingUrl.setAudits(audits);
            existingUrl.setUpdatedBy(userId);
            existingUrl = await existingUrl.save();
          }
          return { success: true, data: existingUrl };
        }

        // Create new URL
        const newUrl = await AuditUrl.create({
          siteId,
          url: canonicalUrl,
          byCustomer,
          audits,
          createdBy: userId,
          updatedBy: userId,
        });
        return { success: true, data: newUrl };
      } catch (error) {
        log.error(`Error adding URL ${urlData.url}: ${error.message}`);
        return {
          success: false,
          url: urlData.url,
          reason: error.message,
        };
      }
    });

    // Wait for all promises (each has try/catch so never rejects)
    const processedResults = await Promise.all(urlProcessingPromises);

    // Process results
    const results = [];
    const failures = [];
    let successCount = 0;

    processedResults.forEach((result) => {
      if (result.success) {
        results.push(AuditUrlDto.toJSON(result.data));
        successCount += 1;
      } else {
        failures.push({ url: result.url, reason: result.reason });
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

    // Process all updates in parallel
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

        auditUrl.setUpdatedBy(userId);
        auditUrl = await auditUrl.save();

        return { success: true, data: auditUrl };
      } catch (error) {
        log.error(`Error updating URL ${update.url}: ${error.message}`);
        return {
          success: false,
          url: update.url,
          reason: error.message,
        };
      }
    });

    // Wait for all promises (each has try/catch so never rejects)
    const processedResults = await Promise.all(updateProcessingPromises);

    // Process results
    const results = [];
    const failures = [];
    let successCount = 0;

    processedResults.forEach((result) => {
      if (result.success) {
        results.push(AuditUrlDto.toJSON(result.data));
        successCount += 1;
      } else {
        failures.push({ url: result.url, reason: result.reason });
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
   * Remove URLs in bulk (only customer-added URLs with byCustomer=true).
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

    // Process all deletions in parallel
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

        // Check if byCustomer is true (customer-added)
        const byCustomer = auditUrl.getByCustomer ? auditUrl.getByCustomer() : auditUrl.byCustomer;
        if (!byCustomer) {
          return {
            success: false,
            url,
            reason: 'Can only delete customer-added URLs (byCustomer: true)',
          };
        }

        await auditUrl.remove();
        return { success: true };
      } catch (error) {
        log.error(`Error deleting URL ${url}: ${error.message}`);
        return {
          success: false,
          url,
          reason: error.message,
        };
      }
    });

    // Wait for all promises (each has try/catch so never rejects)
    const processedResults = await Promise.all(deleteProcessingPromises);

    // Process results
    const failures = [];
    let successCount = 0;

    processedResults.forEach((result) => {
      if (result.success) {
        successCount += 1;
      } else {
        failures.push({ url: result.url, reason: result.reason });
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
    listUrlsByAuditType,
    getUrl,
    addUrls,
    updateUrls,
    deleteUrls,
  };
}

export default UrlStoreController;
