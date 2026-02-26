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

import { hasText, isNonEmptyArray, isValidUUID } from '@adobe/spacecat-shared-utils';
import {
  badRequest,
  createResponse,
  forbidden,
  notFound,
} from '@adobe/spacecat-shared-http-utils';
import AccessControlUtil from '../support/access-control-util.js';
import { getImsUserToken } from '../support/utils.js';
import {
  isAEMAuthoredSite,
  resolvePageIds,
  fetchRelationships,
  buildCheckPath,
} from '../support/aem-content-api.js';

const MAX_PAGES = 50;

/**
 * Page relationships controller: proxy to AEM Content API for upstream relationship data.
 * Used for list-time enrichment (metatags/alt-text) so the UI can show fix targets.
 * @param {object} ctx - Context with dataAccess, log.
 * @returns {object} Controller with search.
 */
function PageRelationshipsController(ctx) {
  const { dataAccess, log } = ctx;
  if (!dataAccess) {
    throw new Error('Data access required');
  }

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * POST /sites/:siteId/page-relationships/search
   * Body: { pages: [ { pageUrl, suggestionType }, ... ] }
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

    const deliveryType = site.getDeliveryType();
    if (!isAEMAuthoredSite(deliveryType)) {
      return createResponse({
        supported: false,
        relationships: {},
        errors: {},
      });
    }

    const deliveryConfig = site.getDeliveryConfig();
    const authorURL = deliveryConfig?.authorURL;
    if (!hasText(authorURL)) {
      return createResponse({
        supported: false,
        relationships: {},
        errors: {},
      });
    }

    const pages = context.data?.pages;
    if (!isNonEmptyArray(pages) || pages.length > MAX_PAGES) {
      return badRequest(`pages array required (max ${MAX_PAGES} items)`);
    }
    if (pages.some((page) => !page || !hasText(page.pageUrl))) {
      return badRequest('Each page must include a non-empty pageUrl');
    }

    let imsToken;
    try {
      imsToken = getImsUserToken(context);
    } catch (e) {
      return badRequest('Missing Authorization header');
    }

    const baseURL = site.getBaseURL();
    if (!hasText(baseURL)) {
      return createResponse({
        supported: true,
        relationships: {},
        errors: { _config: { error: 'Site has no baseURL' } },
      });
    }

    const pageUrls = pages.map((p) => p.pageUrl.trim());

    const resolved = await resolvePageIds(
      baseURL,
      authorURL,
      pageUrls,
      imsToken,
      log,
    );

    const items = [];
    const errors = {};

    for (let i = 0; i < resolved.length; i += 1) {
      const r = resolved[i];
      const pageSpec = pages[i] || {};
      if (r.error || !r.pageId) {
        const errKey = pageSpec.key ?? r.url;
        errors[errKey] = { error: r.error || 'Could not resolve page' };
      } else {
        const hasExplicitCheckPath = Object.prototype.hasOwnProperty.call(pageSpec, 'checkPath');
        const checkPath = hasExplicitCheckPath
          ? pageSpec.checkPath
          : buildCheckPath(pageSpec.suggestionType, deliveryConfig);
        const key = pageSpec.key ?? `${r.url}:${pageSpec.suggestionType ?? ''}`;
        items.push({
          key,
          pageId: r.pageId,
          include: ['upstream'],
          ...(hasText(checkPath) && { checkPath }),
        });
      }
    }

    if (items.length === 0) {
      return createResponse({
        supported: true,
        relationships: {},
        errors,
      });
    }

    const aemResponse = await fetchRelationships(authorURL, items, imsToken, log);

    return createResponse({
      supported: true,
      relationships: aemResponse.results,
      errors: { ...errors, ...aemResponse.errors },
    });
  }

  return { search };
}

export default PageRelationshipsController;
