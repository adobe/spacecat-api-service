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
 * URL Inspector — shared utilities for org+brand scoped PostgREST handlers.
 * Route pattern:
 *   /org/:spaceCatId/brands/all/url-inspector/<resource>?siteId=...
 *   /org/:spaceCatId/brands/:brandId/url-inspector/<resource>?siteId=...
 *
 * Individual handler factories live in their own files:
 *   llmo-url-inspector-stats.js, llmo-url-inspector-owned-urls.js, etc.
 *
 * All handlers import the helpers below.
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
// eslint-disable-next-line max-len
export async function withUrlInspectorAuth(context, getOrgAndValidateAccess, handlerName, handlerFn) {
  const { log, dataAccess } = context;
  const { Site } = dataAccess;

  // TEMP: Local DB routing - Use local PostgREST if available for testing
  const client = context.localPostgrestClient || Site?.postgrestService;
  // END TEMP

  if (!client) {
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
    return await handlerFn(context, client);
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
 * Parses the common URL Inspector parameters.
 * brandId comes from context.params (path); everything else from context.data (query).
 * Supports both camelCase (frontend) and snake_case (PostgREST convention).
 */
export function parseUrlInspectorParams(context) {
  const q = context.data || {};
  const { brandId } = context.params || {};
  return {
    brandId: brandId && brandId !== 'all' ? brandId : null,
    siteId: q.siteId || q.site_id,
    startDate: q.startDate || q.start_date,
    endDate: q.endDate || q.end_date,
    category: q.category,
    region: q.region,
    channel: q.channel || q.content_type,
    platform: q.platform || q.model,
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
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
