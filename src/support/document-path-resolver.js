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

import { determineAEMCSPageId, getPageEditUrl, prependSchema } from '@adobe/spacecat-shared-utils';

const VANITY_URL_MANAGER = 'vanityurlmgr';

const PAGE_URL_FIELDS = {
  'broken-internal-links': 'urlFrom',
  'meta-tags': 'url',
  sitemap: 'pageUrl',
  'structured-data': 'url',
  canonical: 'url',
  hreflang: 'url',
};

/**
 * Extracts the page URL from changeDetails based on opportunity type.
 * @param {string} opportunityType
 * @param {Object} changeDetails
 * @returns {string|null}
 */
function extractPageUrl(opportunityType, changeDetails) {
  if (!changeDetails) return null;

  const field = PAGE_URL_FIELDS[opportunityType];
  if (!field) return null;

  const url = changeDetails[field];
  if (url) return url;

  if (opportunityType === 'structured-data') {
    return changeDetails.path || null;
  }

  return null;
}

/**
 * Extracts the page pathname (for AEM Edge) from changeDetails.
 * Returns a path starting with /, or null.
 * @param {string} opportunityType
 * @param {Object} changeDetails
 * @returns {string|null}
 */
function extractPagePath(opportunityType, changeDetails) {
  const pathOrUrl = opportunityType === 'structured-data'
    ? (changeDetails?.path || changeDetails?.url)
    : extractPageUrl(opportunityType, changeDetails);
  if (!pathOrUrl) return null;
  if (pathOrUrl.startsWith('/')) return pathOrUrl;
  try {
    return new URL(prependSchema(pathOrUrl)).pathname;
  } catch {
    return null;
  }
}

/**
 * Resolves the AEM editor URL for broken-backlinks using site delivery config.
 * For vanityurlmgr: uses urlEdited/urlsSuggested from suggestion data as best-effort.
 * For all other redirect modes: returns the central redirects file URL.
 * @param {Object} deliveryConfig
 * @param {Object} changeDetails - suggestion data
 * @returns {string|null}
 */
function resolveBrokenBacklinksDocPath(deliveryConfig, changeDetails) {
  const authorURL = deliveryConfig?.authorURL;
  // Caller (resolveDocumentPath) only invokes us when authorURL is set; this is defensive
  /* c8 ignore next 1 - falsy authorURL branch unreachable from caller */
  if (!authorURL) return null;

  // deliveryConfig is defined when authorURL is set
  const { redirectsMode, redirectsSource } = deliveryConfig;
  if (redirectsMode === VANITY_URL_MANAGER) {
    const targetUrl = changeDetails?.urlEdited
      || changeDetails?.urlsSuggested?.[0]
      || changeDetails?.urlSuggested?.[0];

    if (targetUrl) {
      try {
        const targetPath = new URL(targetUrl).pathname;
        return `${authorURL}/mnt/overlay/wcm/core/content/sites/properties.html?item=${targetPath}`;
      } catch {
        // malformed URL, fall through to default
      }
    }
  }

  if (redirectsSource) {
    return `${authorURL}${redirectsSource}`;
  }

  return null;
}

/**
 * Resolves the AEM Edge edit URL using ContentClient:
 * pathname → resource path → edit or preview URL.
 * @param {Object} contentClient - ContentClient instance
 * @param {string} pagePath - URL pathname (e.g. /docs/page)
 * @returns {Promise<string|null>}
 */
async function resolveAEMEdgeEditUrl(contentClient, pagePath) {
  const documentPath = await contentClient.getResourcePath(pagePath);
  if (!documentPath) return null;
  const docPath = documentPath.replace(/[.]md$/, '');
  const editUrl = await contentClient.getEditURL(docPath);
  if (editUrl) return editUrl;
  const urls = await contentClient.getLivePreviewURLs(docPath);
  return urls?.previewURL ?? null;
}

/**
 * Resolves the AEM editor documentPath for a given opportunity type and suggestion data.
 * For broken-backlinks: uses site-level config (no per-page resolution).
 * For page-level opportunities on AEM_CS: resolves page ID and fetches the edit URL.
 * For AEM_EDGE: uses ContentClient to resolve pathname → resource path → edit/preview URL
 * (when contentClient is provided).
 *
 * @param {Object} site - Site entity with getDeliveryType(), getDeliveryConfig()
 * @param {string} opportunityType - e.g. 'broken-backlinks', 'meta-tags'
 * @param {Object} changeDetails - the suggestion data / fix changeDetails
 * @param {string} bearerToken - full Authorization header value (e.g. 'Bearer xxx')
 * @param {Object} [log] - logger
 * @param {Object} [contentClient] - ContentClient for AEM Edge (required when aem_edge)
 * @returns {Promise<string|null>} the editor URL or null
 */
export async function resolveDocumentPath(
  site,
  opportunityType,
  changeDetails,
  bearerToken,
  log = console,
  contentClient = null,
) {
  try {
    const deliveryType = site.getDeliveryType();
    const deliveryConfig = site.getDeliveryConfig();
    const authorURL = deliveryConfig?.authorURL;

    if (opportunityType === 'broken-backlinks') {
      if (!authorURL) return null;
      return resolveBrokenBacklinksDocPath(deliveryConfig, changeDetails);
    }

    if (deliveryType === 'aem_cs') {
      if (!authorURL) return null;

      const pageUrlRaw = extractPageUrl(opportunityType, changeDetails);
      if (!pageUrlRaw) return null;
      const pageUrl = prependSchema(pageUrlRaw);

      const preferContentApi = deliveryConfig?.preferContentApi ?? false;
      const pageId = await determineAEMCSPageId(
        pageUrl,
        authorURL,
        bearerToken,
        preferContentApi,
        log,
      );
      if (!pageId) return null;

      return await getPageEditUrl(authorURL, bearerToken, pageId);
    }

    if (deliveryType === 'aem_edge' && contentClient) {
      const pagePath = extractPagePath(opportunityType, changeDetails);
      if (!pagePath) return null;
      return await resolveAEMEdgeEditUrl(contentClient, pagePath);
    }

    return null;
  } catch (e) {
    log.warn(`Failed to resolve documentPath for ${opportunityType}: ${e.message}`);
    return null;
  }
}
