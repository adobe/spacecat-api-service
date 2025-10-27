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

import AccessControlUtil from '../support/access-control-util.js';

const MAX_URLS_PER_REQUEST = 100;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

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
 * Encodes a URL to URL-safe base64 without padding (RFC 4648 §5)
 * @param {string} url - The URL to encode
 * @returns {string} - Base64 encoded URL
 */
function encodeUrlToBase64(url) {
  const base64 = Buffer.from(url).toString('base64');
  // Convert to URL-safe base64 and remove padding
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
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
   * List all URLs for a site with pagination.
   * GET /sites/{siteId}/url-store
   */
  const listUrls = async (context) => {
    const { siteId } = context.params;
    const { limit = DEFAULT_LIMIT, cursor } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
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
      const result = await AuditUrl.allBySiteId(siteId, {
        limit: parsedLimit,
        cursor,
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
   * List URLs by source with pagination.
   * GET /sites/{siteId}/url-store/by-source/{source}
   */
  const listUrlsBySource = async (context) => {
    const { siteId, source } = context.params;
    const { limit = DEFAULT_LIMIT, cursor } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(source)) {
      return badRequest('Source required');
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
      const result = await AuditUrl.allBySiteIdAndSource(siteId, source, {
        limit: parsedLimit,
        cursor,
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
   * List URLs by audit type with pagination.
   * GET /sites/{siteId}/url-store/by-audit/{auditType}
   */
  const listUrlsByAuditType = async (context) => {
    const { siteId, auditType } = context.params;
    const { limit = DEFAULT_LIMIT, cursor } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(auditType)) {
      return badRequest('Audit type required');
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
      });

      return ok({
        items: result.items || [],
        cursor: result.cursor,
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
    const results = [];
    const failures = [];
    let successCount = 0;

    for (const urlData of urls) {
      try {
        // Validate URL
        if (!hasText(urlData.url) || !isValidUrl(urlData.url)) {
          failures.push({
            url: urlData.url || 'undefined',
            reason: 'Invalid URL format',
          });
          continue;
        }

        // Canonicalize URL
        const canonicalUrl = canonicalizeUrl(urlData.url);

        // Validate audits array
        const audits = isArray(urlData.audits) ? urlData.audits : [];

        // Check if URL already exists (idempotent)
        let existingUrl = await AuditUrl.findBySiteIdAndUrl(siteId, canonicalUrl);

        if (existingUrl) {
          // Upsert: update to manual source and merge audits if user-provided
          if (urlData.source === 'manual' || !existingUrl.getSource || existingUrl.getSource() !== 'manual') {
            existingUrl.setSource('manual');
            existingUrl.setAudits(audits);
            existingUrl.setUpdatedBy(userId);
            existingUrl = await existingUrl.save();
          }
          results.push(existingUrl);
          successCount += 1;
        } else {
          // Create new URL
          const newUrl = await AuditUrl.create({
            siteId,
            url: canonicalUrl,
            source: urlData.source || 'manual',
            audits,
            createdBy: userId,
            updatedBy: userId,
          });
          results.push(newUrl);
          successCount += 1;
        }
      } catch (error) {
        log.error(`Error adding URL ${urlData.url}: ${error.message}`);
        failures.push({
          url: urlData.url,
          reason: error.message || 'Internal error',
        });
      }
    }

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
    const results = [];
    const failures = [];
    let successCount = 0;

    for (const update of updates) {
      try {
        if (!hasText(update.url)) {
          failures.push({
            url: 'undefined',
            reason: 'URL required',
          });
          continue;
        }

        if (!isArray(update.audits)) {
          failures.push({
            url: update.url,
            reason: 'Audits array required',
          });
          continue;
        }

        const canonicalUrl = canonicalizeUrl(update.url);
        let auditUrl = await AuditUrl.findBySiteIdAndUrl(siteId, canonicalUrl);

        if (!auditUrl) {
          failures.push({
            url: update.url,
            reason: 'URL not found',
          });
          continue;
        }

        // Update audits (overrides existing)
        auditUrl.setAudits(update.audits);
        auditUrl.setUpdatedBy(userId);
        auditUrl = await auditUrl.save();

        results.push(auditUrl);
        successCount += 1;
      } catch (error) {
        log.error(`Error updating URL ${update.url}: ${error.message}`);
        failures.push({
          url: update.url,
          reason: error.message || 'Internal error',
        });
      }
    }

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

    const failures = [];
    let successCount = 0;

    for (const url of urls) {
      try {
        if (!hasText(url)) {
          failures.push({
            url: 'undefined',
            reason: 'URL required',
          });
          continue;
        }

        const canonicalUrl = canonicalizeUrl(url);
        const auditUrl = await AuditUrl.findBySiteIdAndUrl(siteId, canonicalUrl);

        if (!auditUrl) {
          failures.push({
            url,
            reason: 'URL not found',
          });
          continue;
        }

        // Check if source is manual
        const source = auditUrl.getSource ? auditUrl.getSource() : auditUrl.source;
        if (source !== 'manual') {
          failures.push({
            url,
            reason: 'Can only delete URLs with source: manual',
          });
          continue;
        }

        await auditUrl.remove();
        successCount += 1;
      } catch (error) {
        log.error(`Error deleting URL ${url}: ${error.message}`);
        failures.push({
          url,
          reason: error.message || 'Internal error',
        });
      }
    }

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
    getUrl,
    addUrls,
    updateUrls,
    deleteUrls,
  };
}

export default UrlStoreController;

