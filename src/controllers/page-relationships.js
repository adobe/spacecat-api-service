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
  isNonEmptyArray,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import {
  badRequest,
  createResponse,
  forbidden,
  notFound,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import AccessControlUtil from '../support/access-control-util.js';
import { getIMSPromiseToken, exchangePromiseToken, ErrorWithStatusCode } from '../support/utils.js';
import {
  isAEMAuthoredSite,
  resolvePageIds,
  fetchRelationships,
  buildCheckPath,
} from '../support/aem-content-api.js';
import { getHeader } from '../support/http-headers.js';
import { X_PROMISE_TOKEN_HEADER } from '../utils/constants.js';

const MAX_PAGES = 50;
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

/**
 * Normalize a suggestion URL to a pathname suitable for AEM page resolution.
 *
 * AEM resolves pages by path, not by host, so the suggestion URL's host
 * (which may differ from the site's canonical baseURL, e.g. `www.example.com`
 * vs `example.com`, or a CDN/staging host) is irrelevant. Always reduce
 * absolute URLs to their pathname; pass relative paths through unchanged.
 *
 * Prior behavior returned the full URL on host mismatch, which downstream
 * `resolvePageIds` would concatenate with the site base URL producing
 * malformed URLs like `https://example.com/https://www.example.com/page`.
 */
function normalizePageUrlForLookup(pageUrl) {
  const trimmed = pageUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  try {
    return new URL(trimmed).pathname || '/';
  } catch (e) {
    return trimmed;
  }
}

function getStatusFromError(error) {
  if (Number.isInteger(error?.statusCode)) {
    return error.statusCode;
  }
  if (Number.isInteger(error?.status)) {
    return error.status;
  }
  return null;
}

function getSourceType(value) {
  if (!hasText(value)) {
    return null;
  }
  return String(value).trim();
}

function mapRelationship(rawRelationship) {
  let rawChain = [];
  if (Array.isArray(rawRelationship?.upstream?.chain)) {
    rawChain = rawRelationship.upstream.chain;
  } else if (Array.isArray(rawRelationship?.chain)) {
    rawChain = rawRelationship.chain;
  }

  const relationshipSourceType = getSourceType(rawRelationship?.metadata?.sourceType);

  const chain = rawChain
    .map((edge) => {
      const pageId = [
        edge?.pageId,
        edge?.id,
        edge?.page?.pageId,
        edge?.page?.id,
      ].find(hasText)?.trim();
      const pagePath = [
        edge?.pagePath,
        edge?.path,
        typeof edge?.page === 'string' ? edge.page : undefined,
        edge?.page?.pagePath,
        edge?.page?.path,
      ].find(hasText)?.trim();
      if (!pageId || !pagePath) {
        return null;
      }
      const sourceType = getSourceType(edge?.sourceType || edge?.relation || edge?.type)
        || relationshipSourceType
        || null;
      const chainItem = {
        pageId,
        pagePath,
      };
      if (sourceType) {
        chainItem.metadata = { sourceType };
      }
      return chainItem;
    })
    .filter(Boolean);

  const relationship = {
    chain,
  };
  if (hasText(rawRelationship?.pageId)) {
    relationship.pageId = rawRelationship.pageId.trim();
  }

  return relationship;
}

/**
 * Page relationships controller: proxy to AEM Content API for upstream relationship data.
 * Used for on-demand popup lookups with caller-provided pages.
 * @param {object} ctx - Context with dataAccess, log.
 * @returns {object} Controller with search.
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
        normalizedPageUrl: normalizePageUrlForLookup(pageSpec.pageUrl),
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
      const relationshipContextByKey = {};

      for (let i = 0; i < normalizedBatch.length; i += 1) {
        const pageSpec = normalizedBatch[i];
        const r = resolved[i] || {};
        const suggestionType = hasText(pageSpec.suggestionType) ? pageSpec.suggestionType : '';
        const responseKey = pageSpec.key;
        if (r.error || !r.pageId) {
          resolveErrors[responseKey] = { error: r.error || 'Could not resolve page' };
        } else {
          relationshipContextByKey[responseKey] = {
            pagePath: pageSpec.normalizedPageUrl,
            pageId: r.pageId,
          };
          const checkPath = buildCheckPath(suggestionType, deliveryConfig);
          const item = {
            key: pageSpec.key,
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
        const mappedResultEntries = Object.entries(aemResponse.results || {})
          .map(([key, value]) => {
            const relationshipContext = relationshipContextByKey[key];
            if (!hasText(relationshipContext?.pagePath) || !hasText(relationshipContext?.pageId)) {
              return null;
            }
            const mappedRelationship = mapRelationship(value);
            mappedRelationship.pagePath = relationshipContext.pagePath;
            mappedRelationship.pageId = relationshipContext.pageId;
            return [key, mappedRelationship];
          })
          .filter(Boolean);
        const mappedResults = Object.fromEntries(
          mappedResultEntries,
        );
        Object.assign(allRelationships, mappedResults);
        Object.assign(allErrors, aemResponse.errors);
      }
    }

    return {
      relationships: allRelationships,
      errors: allErrors,
    };
  }

  /**
   * POST /sites/:siteId/page-relationships/search
   * Resolves page relationships for caller-provided pages.
   * Returns { supported, relationships, errors }.
   */
  async function search(context) {
    const siteId = context.params?.siteId;
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await dataAccess.Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can access this site');
    }

    const pages = context.data?.pages;
    if (!isNonEmptyArray(pages)) {
      return badRequest('pages array required');
    }
    if (pages.some((page) => !page || !hasText(page.pageUrl))) {
      return badRequest('Each page must include a non-empty pageUrl');
    }
    if (pages.some((page) => !hasText(page.key))) {
      return badRequest('Each page must include a non-empty key');
    }

    const supportState = getSupportState(site);
    if (!supportState.supported) {
      return createResponse(EMPTY_RELATIONSHIPS_RESPONSE);
    }
    const { deliveryConfig, authorURL } = supportState;

    let imsToken;
    try {
      // Prefer a caller-supplied promise token (forwarded by the ASO UI in the
      // `x-promise-token` header) over minting one from the Authorization bearer.
      // Since the UI switched to sending a session JWT in Authorization, minting
      // via `getIMSPromiseToken` (which reads that header) fails IMS with 401.
      // Mirrors the auto-fix handler in `suggestions.js` (`x-promise-token`
      // header, falling back to `getIMSPromiseToken` for IMS-authenticated
      // callers that don't supply one).
      const headerToken = getHeader(context, X_PROMISE_TOKEN_HEADER);
      let promiseTokenResponse;
      if (hasText(headerToken)) {
        log.info(`[page-relationships] using promise token from ${X_PROMISE_TOKEN_HEADER} header for site ${siteId}`);
        promiseTokenResponse = { promise_token: headerToken };
      } else {
        log.info(`[page-relationships] no ${X_PROMISE_TOKEN_HEADER} header, minting promise token via IMS for site ${siteId}`);
        promiseTokenResponse = await getIMSPromiseToken(context);
      }
      imsToken = await exchangePromiseToken(context, promiseTokenResponse.promise_token);
    } catch (e) {
      if (e instanceof ErrorWithStatusCode) {
        return createResponse({ message: e.message }, e.status || 400);
      }
      const status = getStatusFromError(e);
      const detail = [e.statusCode, e.status, e.message].filter(Boolean).join(' ') || e.message || 'Unknown error';
      if (status && status >= 400 && status < 500) {
        return createResponse({ message: `Problem getting IMS token: ${detail}` }, status);
      }
      log.error(`Problem getting IMS token for site ${siteId}: ${detail}`);
      return internalServerError('Error getting IMS token');
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

  return { search };
}

export default PageRelationshipsController;
