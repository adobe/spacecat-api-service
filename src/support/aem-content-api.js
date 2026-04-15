/*
 * Copyright 2025 Adobe. All rights reserved.
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
  DELIVERY_TYPES,
  determineAEMCSPageId,
} from '@adobe/spacecat-shared-utils';

const AEM_AUTHORED_TYPES = [
  DELIVERY_TYPES.AEM_CS,
  DELIVERY_TYPES.AEM_AMS,
];

/**
 * Whether the delivery type supports AEM Content API (page relationships, resolve).
 * @param {string} deliveryType - Site delivery type.
 * @returns {boolean}
 */
export function isAEMAuthoredSite(deliveryType) {
  return deliveryType && AEM_AUTHORED_TYPES.includes(deliveryType);
}

/**
 * Resolve page URLs to AEM page IDs using the shared determineAEMCSPageId
 * utility (fetches HTML, reads content-page-ref / content-page-id meta,
 * resolves via AEM Content API when needed).
 * @param {string} siteBaseURL - Published site base URL.
 * @param {string} authorURL - AEM author URL.
 * @param {string[]} pageUrls - Page paths (e.g. /us/en/products).
 * @param {string} imsToken - Bearer token (without "Bearer " prefix).
 * @param {object} log - Logger.
 * @returns {Promise<Array<{ url: string, pageId?: string, error?: string }>>}
 */
export async function resolvePageIds(siteBaseURL, authorURL, pageUrls, imsToken, log) {
  const base = siteBaseURL.replace(/\/$/, '');
  const bearerToken = `Bearer ${imsToken}`;
  const out = [];

  for (const pageUrl of pageUrls) {
    const normalized = typeof pageUrl === 'string' ? pageUrl.trim() : '';
    if (!normalized) {
      out.push({ url: pageUrl, error: 'Invalid pageUrl' });
    } else {
      const slash = normalized.startsWith('/') ? '' : '/';
      const fullUrl = `${base}${slash}${normalized}`;
      try {
        /* eslint-disable-next-line no-await-in-loop -- sequential per page */
        const pageId = await determineAEMCSPageId(
          fullUrl,
          authorURL,
          bearerToken,
          true,
          log,
        );
        if (pageId) {
          out.push({ url: normalized, pageId });
        } else {
          out.push({ url: normalized, error: 'Could not determine page ID' });
        }
      } catch (e) {
        log.warn(`resolvePageIds failed for ${normalized}: ${e.message}`);
        out.push({ url: normalized, error: e.message });
      }
    }
  }

  return out;
}

/**
 * Call AEM POST .../adobe/pages/relationships/search.
 * @param {string} authorURL - AEM author base URL.
 * @param {Array<{ key: string, pageId: string, include: string[], checkPath?: string }>} items
 *   Batch items.
 * @param {string} imsToken - Bearer token.
 * @param {object} log - Logger.
 * @returns {Promise<{ results: object, errors: object }>}
 */
export async function fetchRelationships(authorURL, items, imsToken, log) {
  const base = authorURL.replace(/\/$/, '');
  const url = `${base}/adobe/pages/relationships/search`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${imsToken}`,
      },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      log.warn(`Relationships search returned ${res.status}`);
      return {
        results: {},
        errors: { default: { error: `HTTP ${res.status}` } },
      };
    }
    const data = await res.json();
    return {
      results: data.results || {},
      errors: data.errors || {},
    };
  } catch (e) {
    log.warn(`Relationships search error: ${e.message}`);
    return {
      results: {},
      errors: { default: { error: e.message } },
    };
  }
}

const METATAG_PATTERNS = [
  { regex: /\btitle\b/i, property: 'title', defaultJcr: 'jcr:title' },
  { regex: /\bdescription\b/i, property: 'description', defaultJcr: 'jcr:description' },
];

/**
 * Build checkPath for relationship API from suggestion type and delivery config.
 * Detects which metatag property the suggestion targets (title / description)
 * by matching keywords in the issue string, then resolves to a JCR property
 * path via metaTagPropertyMap or known defaults. Returns undefined when the
 * suggestion does not target a known metatag property.
 * @param {string} [suggestionType] - Issue string, e.g. "Missing title",
 *   "Title too short", "Missing meta description", "Duplicate title".
 * @param {object} [deliveryConfig] - Site delivery config.
 * @returns {string|undefined}
 */
export function buildCheckPath(suggestionType, deliveryConfig = {}) {
  if (!suggestionType) {
    return undefined;
  }

  for (const { regex, property, defaultJcr } of METATAG_PATTERNS) {
    if (regex.test(suggestionType)) {
      const { metaTagPropertyMap = {} } = deliveryConfig;
      const jcrProperty = metaTagPropertyMap[property] || defaultJcr;
      return `/properties/${jcrProperty}`;
    }
  }

  return undefined;
}
