/*
 * Copyright 2026 Adobe. All rights reserved.
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
  badRequest, forbidden, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * URL Inspector handlers for org-scoped routes.
 * Queries brand_presence data via PostgREST to serve URL citation metrics.
 * Route pattern: /org/:spaceCatId/url-inspector/<resource>?siteId=...
 *
 * Each handler follows the same factory pattern as llmo-brand-presence.js:
 *   createXxxHandler(getOrgAndValidateAccess) → (context) => Response
 */

const SKIP_VALUES = new Set(['all', '', undefined, null, '*']);

const ERR_ORG_ACCESS = 'belonging to the organization';
const ERR_NOT_FOUND = 'not found';

/**
 * Shared wrapper: PostgREST availability check + org access validation.
 * @param {Object} context - Request context
 * @param {Function} getOrgAndValidateAccess - Async (context) => { organization }
 * @param {string} handlerName - For error logging
 * @param {Function} handlerFn - Async (context, client) => Response
 * @returns {Promise<Response>}
 */
async function withUrlInspectorAuth(context, getOrgAndValidateAccess, handlerName, handlerFn) {
  const { log, dataAccess } = context;
  const { Site } = dataAccess;

  if (!Site?.postgrestService) {
    log.error('URL Inspector APIs require PostgREST (DATA_SERVICE_PROVIDER=postgres)');
    return badRequest('URL Inspector data is not available. PostgreSQL data service is required.');
  }

  try {
    await getOrgAndValidateAccess(context);
  } catch (error) {
    if (error.message?.includes(ERR_ORG_ACCESS)) {
      return forbidden('Only users belonging to the organization can view URL Inspector data');
    }
    if (error.message?.includes(ERR_NOT_FOUND)) {
      return badRequest(error.message);
    }
    log.error(`URL Inspector ${handlerName} error: ${error.message}`);
    return badRequest(error.message);
  }

  try {
    return await handlerFn(context, Site.postgrestService);
  } catch (error) {
    log.error(`URL Inspector ${handlerName} unexpected error: ${error.message}`);
    return internalServerError(`URL Inspector ${handlerName} failed`);
  }
}

/** Returns true if the value should be used as a PostgREST filter. */
export function shouldApplyFilter(value) {
  if (value == null) return false;
  if (typeof value === 'string' && SKIP_VALUES.has(value.trim())) return false;
  return hasText(String(value));
}

/**
 * Parses the common URL Inspector query parameters from context.data.
 * Supports both camelCase (frontend) and snake_case (PostgREST convention).
 */
export function parseUrlInspectorParams(context) {
  const q = context.data || {};
  return {
    siteId: q.siteId || q.site_id,
    startDate: q.startDate || q.start_date,
    endDate: q.endDate || q.end_date,
    category: q.category,
    region: q.region,
    channel: q.channel || q.content_type,
    platform: q.platform || q.model,
    limit: q.limit ? Number(q.limit) : undefined,
    url: q.url,
    domain: q.domain,
    includeAll: q.includeAll === 'true' || q.includeAll === true,
  };
}

/**
 * Validates that siteId is present. Returns a badRequest response if missing, null otherwise.
 */
export function requireSiteId(params) {
  if (!hasText(params.siteId)) {
    return badRequest('siteId query parameter is required');
  }
  return null;
}

// ============================================================================
// Handler Factories — each returns 501 until the real implementation lands
// ============================================================================

const NOT_IMPLEMENTED = (name) => ({ status: 501, body: { error: `Not implemented yet: url-inspector/${name}` } });

/**
 * GET /org/:spaceCatId/url-inspector/stats
 * @see docs/api-specs/01-stats-cards.md (elmo-ui)
 */
export function createStatsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'stats',
    async (ctx) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      return NOT_IMPLEMENTED('stats');
    },
  );
}

/**
 * GET /org/:spaceCatId/url-inspector/owned-urls
 * @see docs/api-specs/02-owned-urls-table.md (elmo-ui)
 */
export function createOwnedUrlsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'owned-urls',
    async (ctx) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      return NOT_IMPLEMENTED('owned-urls');
    },
  );
}

/**
 * GET /org/:spaceCatId/url-inspector/trending-urls
 * @see docs/api-specs/03-trending-urls-table.md (elmo-ui)
 */
export function createTrendingUrlsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'trending-urls',
    async (ctx) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      return NOT_IMPLEMENTED('trending-urls');
    },
  );
}

/**
 * GET /org/:spaceCatId/url-inspector/cited-domains
 * @see docs/api-specs/04-cited-domains-table.md (elmo-ui)
 */
export function createCitedDomainsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'cited-domains',
    async (ctx) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      return NOT_IMPLEMENTED('cited-domains');
    },
  );
}

/**
 * GET /org/:spaceCatId/url-inspector/url-details
 * @see docs/api-specs/05-url-details-dialog.md (elmo-ui)
 */
export function createUrlDetailsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'url-details',
    async (ctx) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      if (!hasText(params.url)) {
        return badRequest('url query parameter is required');
      }

      return NOT_IMPLEMENTED('url-details');
    },
  );
}

/**
 * GET /org/:spaceCatId/url-inspector/domain-details
 * @see docs/api-specs/06-domain-details-dialog.md (elmo-ui)
 */
export function createDomainDetailsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'domain-details',
    async (ctx) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      if (!hasText(params.domain)) {
        return badRequest('domain query parameter is required');
      }

      return NOT_IMPLEMENTED('domain-details');
    },
  );
}

/**
 * GET /org/:spaceCatId/url-inspector/filter-options
 * @see docs/api-specs/07-filter-options.md (elmo-ui)
 */
export function createFilterOptionsHandler(getOrgAndValidateAccess) {
  return (context) => withUrlInspectorAuth(
    context,
    getOrgAndValidateAccess,
    'filter-options',
    async (ctx) => {
      const params = parseUrlInspectorParams(ctx);
      const siteError = requireSiteId(params);
      if (siteError) return siteError;

      return NOT_IMPLEMENTED('filter-options');
    },
  );
}
