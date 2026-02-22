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

import { determineAEMCSPageId, getPageEditUrl } from '@adobe/spacecat-shared-utils';

const VANITY_URL_MANAGER = 'vanityurlmgr';

const PAGE_URL_FIELDS = {
  'broken-internal-links': 'urlFrom',
  'meta-tags': 'url',
  sitemap: 'pageUrl',
  'structured-data': 'url',
  canonical: 'url',
  hreflang: 'url',
  'high-organic-low-ctr': 'url',
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
 * Resolves the AEM editor URL for broken-backlinks using site delivery config.
 * For vanityurlmgr: uses urlEdited/urlsSuggested from suggestion data as best-effort.
 * For all other redirect modes: returns the central redirects file URL.
 * @param {Object} deliveryConfig
 * @param {Object} changeDetails - suggestion data
 * @returns {string|null}
 */
function resolveBrokenBacklinksDocPath(deliveryConfig, changeDetails) {
  const authorURL = deliveryConfig?.authorURL;
  if (!authorURL) return null;

  if (deliveryConfig?.redirectsMode === VANITY_URL_MANAGER) {
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

  const { redirectsSource } = deliveryConfig;
  if (redirectsSource) {
    return `${authorURL}${redirectsSource}`;
  }

  return null;
}

/**
 * Resolves the AEM editor documentPath for a given opportunity type and suggestion data.
 * For broken-backlinks: uses site-level config (no per-page resolution).
 * For page-level opportunities on AEM_CS: resolves page ID and fetches the edit URL.
 * AEM_EDGE is not yet supported (requires ContentClient).
 *
 * @param {Object} site - Site entity with getDeliveryType(), getDeliveryConfig()
 * @param {string} opportunityType - e.g. 'broken-backlinks', 'meta-tags'
 * @param {Object} changeDetails - the suggestion data / fix changeDetails
 * @param {string} bearerToken - full Authorization header value (e.g. 'Bearer xxx')
 * @param {Object} [log] - logger
 * @returns {Promise<string|null>} the editor URL or null
 */
export async function resolveDocumentPath(
  site,
  opportunityType,
  changeDetails,
  bearerToken,
  log = console,
) {
  try {
    const deliveryType = site.getDeliveryType();
    const deliveryConfig = site.getDeliveryConfig();
    const authorURL = deliveryConfig?.authorURL;

    if (!authorURL) return null;

    if (opportunityType === 'broken-backlinks') {
      return resolveBrokenBacklinksDocPath(deliveryConfig, changeDetails);
    }

    if (deliveryType === 'aem_cs') {
      const pageUrl = extractPageUrl(opportunityType, changeDetails);
      if (!pageUrl) return null;

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

    return null;
  } catch (e) {
    log.warn(`Failed to resolve documentPath for ${opportunityType}: ${e.message}`);
    return null;
  }
}
