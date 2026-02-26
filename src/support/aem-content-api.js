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

import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';

const AEM_DELIVERY_TYPES = [
  SiteModel.DELIVERY_TYPES.AEM_CS,
  SiteModel.DELIVERY_TYPES.AEM_AMS,
];

function getContentPageIdFromHtml(html) {
  const m = html.match(/<meta\s+name=["']content-page-id["']\s+content=["']([^"']+)["']/i)
    || html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']content-page-id["']/i);
  return m ? m[1].trim() : null;
}

function getContentPageRefFromHtml(html) {
  const m = html.match(/<meta\s+name=["']content-page-ref["']\s+content=["']([^"']+)["']/i)
    || html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']content-page-ref["']/i);
  return m ? m[1].trim() : null;
}

async function resolvePageRef(authorURL, pageRef, imsToken, log) {
  const base = authorURL.replace(/\/$/, '');
  const url = `${base}/adobe/pages/resolve?pageRef=${encodeURIComponent(pageRef)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${imsToken}` },
    });
    if (!res.ok) {
      log.warn(`Resolve API returned ${res.status} for pageRef`);
      return null;
    }
    const data = await res.json();
    return data?.pageId || null;
  } catch (e) {
    log.warn(`Resolve API error: ${e.message}`);
    return null;
  }
}

/**
 * Whether the delivery type supports AEM Content API (page relationships, resolve).
 * @param {string} deliveryType - Site delivery type.
 * @returns {boolean}
 */
export function isAEMAuthoredSite(deliveryType) {
  return deliveryType && AEM_DELIVERY_TYPES.includes(deliveryType);
}

/**
 * Resolve page URLs to AEM page IDs: fetch published page HTML, read content-page-id or
 * content-page-ref meta, and resolve via AEM Content API if needed.
 * @param {string} siteBaseURL - Published site base URL (e.g. https://example.com).
 * @param {string} authorURL - AEM author URL (e.g. https://author-xxx.adobeaemcloud.com).
 * @param {string[]} pageUrls - Page paths (e.g. /us/en/products).
 * @param {string} imsToken - Bearer token for AEM.
 * @param {object} log - Logger.
 * @returns {Promise<Array<{ url: string, pageId?: string, error?: string }>>}
 */
export async function resolvePageIds(siteBaseURL, authorURL, pageUrls, imsToken, log) {
  const base = siteBaseURL.replace(/\/$/, '');
  const out = [];

  for (const pageUrl of pageUrls) {
    const normalizedPageUrl = typeof pageUrl === 'string' ? pageUrl.trim() : '';
    if (!normalizedPageUrl) {
      out.push({ url: pageUrl, error: 'Invalid pageUrl' });
    } else {
      const fullUrl = `${base}${normalizedPageUrl.startsWith('/') ? normalizedPageUrl : `/${normalizedPageUrl}`}`;
      try {
        /* eslint-disable-next-line no-await-in-loop -- sequential fetch per page */
        const res = await fetch(fullUrl, { method: 'GET', redirect: 'follow' });
        if (!res.ok) {
          out.push({ url: normalizedPageUrl, error: `HTTP ${res.status}` });
        } else {
          /* eslint-disable-next-line no-await-in-loop -- sequential fetch per page */
          const html = await res.text();
          const pageId = getContentPageIdFromHtml(html);
          const pageRef = getContentPageRefFromHtml(html);

          if (pageId) {
            out.push({ url: normalizedPageUrl, pageId });
          } else if (pageRef) {
            /* eslint-disable-next-line no-await-in-loop -- sequential resolve per page */
            const resolved = await resolvePageRef(authorURL, pageRef, imsToken, log);
            if (resolved) {
              out.push({ url: normalizedPageUrl, pageId: resolved });
            } else {
              out.push({ url: normalizedPageUrl, error: 'Resolve failed' });
            }
          } else {
            out.push({ url: normalizedPageUrl, error: 'No content-page-id or content-page-ref' });
          }
        }
      } catch (e) {
        log.warn(`resolvePageIds failed for ${normalizedPageUrl}: ${e.message}`);
        out.push({ url: normalizedPageUrl, error: e.message });
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

/**
 * Build checkPath for relationship API from suggestion type and metaTagPropertyMap.
 * Returns undefined for alt-text and other types where property-level check is not possible.
 * @param {string} [suggestionType] - e.g. "Missing Title", "Missing Description".
 * @param {object} [metaTagPropertyMap] - deliveryConfig.metaTagPropertyMap.
 * @returns {string|undefined}
 */
export function buildCheckPath(suggestionType, metaTagPropertyMap = {}) {
  switch (suggestionType) {
    case 'Missing Title':
      return `/properties/${metaTagPropertyMap.title || 'jcr:title'}`;
    case 'Missing Description':
      return `/properties/${metaTagPropertyMap.description || 'jcr:description'}`;
    default:
      return undefined;
  }
}
