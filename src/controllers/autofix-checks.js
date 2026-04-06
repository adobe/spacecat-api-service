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

import { isNonEmptyObject, isNonEmptyArray } from '@adobe/spacecat-shared-utils';
import {
  badRequest, forbidden, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import AccessControlUtil from '../support/access-control-util.js';
import checkHandlerRegistry from '../support/autofix-checks/registry.js';

/**
 * Autofix Checks Controller — runs server-side permission and capability
 * checks for a site before autofix deploy.
 *
 * POST /sites/:siteId/autofix-checks
 *
 * Request body:
 *   { "checks": [{ "type": "content-api-access" }] }
 *
 * Response:
 *   { "siteId": "...", "checks": [{ "type", "status", "message" }] }
 *
 * @param {Object} ctx - Application context (dataAccess, log, etc.)
 * @returns {Object} Controller with runChecks method
 */
function AutofixChecksController(ctx) {
  if (!isNonEmptyObject(ctx?.dataAccess)) {
    throw new Error('Valid data access configuration required');
  }

  const { dataAccess, log } = ctx;
  const { Site } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Runs the requested autofix checks for a site.
   * @param {Object} context - Request context with params.siteId and data.checks
   * @returns {Promise<Object>} HTTP response
   */
  const runChecks = async (context) => {
    const { siteId } = context.params || {};
    const { checks } = context.data || {};

    if (!isNonEmptyArray(checks)) {
      return badRequest('Request body must include a non-empty "checks" array');
    }

    // Validate all requested check types before doing any work
    const unknownTypes = checks
      .map((c) => c?.type)
      .filter((type) => !checkHandlerRegistry[type]);

    if (unknownTypes.length > 0) {
      return badRequest(`Unknown check type(s): ${unknownTypes.join(', ')}`);
    }

    try {
      const site = await Site.findById(siteId);

      if (!site) {
        return notFound(`Site with ID ${siteId} not found`);
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }

      const results = await Promise.all(
        checks.map(async (check) => {
          const handler = checkHandlerRegistry[check.type];
          try {
            return await handler(site, context, log);
          } catch (error) {
            log.error(`Autofix check "${check.type}" threw unexpectedly: ${error.message}`);
            return {
              type: check.type,
              status: 'ERROR',
              message: error.message,
            };
          }
        }),
      );

      return ok({ siteId, checks: results });
    } catch (error) {
      log.error(`Autofix checks failed for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to run preflight checks');
    }
  };

  return { runChecks };
}

export default AutofixChecksController;
