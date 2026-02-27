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
  hasText,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import {
  badRequest,
  createResponse,
  forbidden,
  notFound,
} from '@adobe/spacecat-shared-http-utils';
import AccessControlUtil from '../support/access-control-util.js';
import { getIMSPromiseToken, exchangePromiseToken, ErrorWithStatusCode } from '../support/utils.js';
import {
  isAEMAuthoredSite,
  resolvePageIds,
  fetchRelationships,
  buildCheckPath,
} from '../support/aem-content-api.js';

const MAX_PAGES = 50;
const SUPPORTED_OPPORTUNITY_TYPES = new Set(['meta-tags', 'alt-text']);
const EMPTY_RELATIONSHIPS_RESPONSE = {
  supported: false,
  relationships: {},
  errors: {},
};

function chunkPages(pages, chunkSize) {
  const chunks = [];
  for (let i = 0; i < pages.length; i += chunkSize) {
    chunks.push(pages.slice(i, i + chunkSize));
  }
  return chunks;
}

function getSuggestionType(suggestion) {
  const data = suggestion?.getData?.() || {};
  const rawType = [
    data.suggestionType,
    data.issue,
  ].find((value) => hasText(value));
  return hasText(rawType) ? rawType.trim() : '';
}

function getSuggestionPageUrls(suggestion) {
  const data = suggestion?.getData?.() || {};
  const urls = new Set();
  const directUrlValues = [data.url, data.pageUrl];

  directUrlValues.forEach((value) => {
    if (hasText(value)) {
      urls.add(value.trim());
    }
  });

  const { recommendations } = data;
  if (Array.isArray(recommendations)) {
    recommendations.forEach((recommendation) => {
      const recommendationUrl = recommendation?.pageUrl;
      if (hasText(recommendationUrl)) {
        urls.add(recommendationUrl.trim());
      }
    });
  }

  return Array.from(urls);
}

function normalizePageUrlForLookup(pageUrl, siteBaseURL) {
  const trimmed = pageUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  try {
    const siteUrl = new URL(siteBaseURL);
    const suggestionUrl = new URL(trimmed);
    if (suggestionUrl.host !== siteUrl.host) {
      return trimmed;
    }
    return suggestionUrl.pathname || '/';
  } catch (e) {
    return trimmed;
  }
}

function extractPagesFromSuggestions(suggestions, options = {}) {
  const { siteBaseURL = '' } = options;
  const uniquePages = new Map();
  const suggestionList = Array.isArray(suggestions) ? suggestions : [];
  suggestionList.forEach((suggestion) => {
    const suggestionType = getSuggestionType(suggestion);
    const pageUrls = getSuggestionPageUrls(suggestion);
    pageUrls.forEach((pageUrl) => {
      const normalizedPageUrl = normalizePageUrlForLookup(pageUrl, siteBaseURL);
      const dedupeKey = `${normalizedPageUrl}:${suggestionType}`;
      if (!uniquePages.has(dedupeKey)) {
        uniquePages.set(dedupeKey, { pageUrl: normalizedPageUrl, suggestionType });
      }
    });
  });
  return Array.from(uniquePages.values());
}

/**
 * Page relationships controller: proxy to AEM Content API for upstream relationship data.
 * Used for list-time enrichment (metatags/alt-text) so the UI can show fix targets.
 * @param {object} ctx - Context with dataAccess, log.
 * @returns {object} Controller with getForOpportunity.
 */
function PageRelationshipsController(ctx) {
  const { dataAccess, log } = ctx;
  if (!dataAccess) {
    throw new Error('Data access required');
  }

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  function getSupportState(site) {
    const deliveryType = site.getDeliveryType();
    if (!isAEMAuthoredSite(deliveryType)) {
      return {
        supported: false,
        relationships: {},
        errors: {},
      };
    }

    const deliveryConfig = site.getDeliveryConfig();
    const authorURL = deliveryConfig?.authorURL;
    if (!hasText(authorURL)) {
      return {
        supported: false,
        relationships: {},
        errors: {},
      };
    }

    return { supported: true, deliveryConfig, authorURL };
  }

  async function lookupRelationships(site, pages, imsToken, options = {}) {
    const { deliveryConfig, authorURL } = options;
    const baseURL = site.getBaseURL();
    if (!hasText(baseURL)) {
      return {
        relationships: {},
        errors: { _config: { error: 'Site has no baseURL' } },
      };
    }

    const allRelationships = {};
    const allErrors = {};
    const pageChunks = chunkPages(pages, MAX_PAGES);

    for (const pageBatch of pageChunks) {
      const normalizedBatch = pageBatch.map((pageSpec) => ({
        ...pageSpec,
        normalizedPageUrl: normalizePageUrlForLookup(pageSpec.pageUrl, baseURL),
      }));
      const pageUrls = normalizedBatch.map((pageSpec) => pageSpec.normalizedPageUrl);
      // eslint-disable-next-line no-await-in-loop
      const resolved = await resolvePageIds(
        baseURL,
        authorURL,
        pageUrls,
        imsToken,
        log,
      );

      const items = [];
      const resolveErrors = {};

      for (let i = 0; i < normalizedBatch.length; i += 1) {
        const pageSpec = normalizedBatch[i];
        const r = resolved[i] || {};
        const responseUrl = pageSpec.normalizedPageUrl;
        if (r.error || !r.pageId) {
          resolveErrors[responseUrl] = { error: r.error || 'Could not resolve page' };
        } else {
          const checkPath = buildCheckPath(pageSpec.suggestionType, deliveryConfig);
          const item = {
            key: `${responseUrl}:${pageSpec.suggestionType}`,
            pageId: r.pageId,
            include: ['upstream'],
          };
          if (hasText(checkPath)) {
            item.checkPath = checkPath;
          }
          items.push(item);
        }
      }

      Object.assign(allErrors, resolveErrors);

      if (items.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        const aemResponse = await fetchRelationships(authorURL, items, imsToken, log);
        Object.assign(allRelationships, aemResponse.results);
        Object.assign(allErrors, aemResponse.errors);
      }
    }

    return {
      relationships: allRelationships,
      errors: allErrors,
    };
  }

  /**
   * GET /sites/:siteId/opportunities/:opportunityId/page-relationships
   * Resolves page relationships from all opportunity suggestions.
   * Returns { supported, relationships, errors }.
   */
  async function getForOpportunity(context) {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    const site = await dataAccess.Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can access this site');
    }

    const opportunity = await dataAccess.Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }
    const opportunityType = opportunity.getType?.();
    if (!SUPPORTED_OPPORTUNITY_TYPES.has(opportunityType)) {
      log.warn(`Unsupported opportunity type for page relationships: ${opportunityType || 'unknown'} (opportunityId=${opportunityId})`);
      return createResponse({
        supported: false,
        relationships: {},
        errors: {
          _opportunity: {
            error: `Unsupported opportunity type: ${opportunityType || 'unknown'}`,
          },
        },
      });
    }

    const supportState = getSupportState(site);
    if (!supportState.supported) {
      return createResponse(EMPTY_RELATIONSHIPS_RESPONSE);
    }
    const { deliveryConfig, authorURL } = supportState;

    const suggestions = await dataAccess.Suggestion.allByOpportunityId(opportunityId);
    const pages = extractPagesFromSuggestions(suggestions, {
      siteBaseURL: site.getBaseURL(),
    });

    let imsToken;
    try {
      const promiseTokenResponse = await getIMSPromiseToken(context);
      imsToken = await exchangePromiseToken(context, promiseTokenResponse.promise_token);
    } catch (e) {
      if (e instanceof ErrorWithStatusCode) {
        return badRequest(e.message);
      }
      return badRequest('Missing Authorization header - 2');
    }

    const { relationships, errors } = await lookupRelationships(site, pages, imsToken, {
      deliveryConfig,
      authorURL,
    });

    return createResponse({
      supported: true,
      relationships,
      errors,
    });
  }

  return { getForOpportunity };
}

export default PageRelationshipsController;
