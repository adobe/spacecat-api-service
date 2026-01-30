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
  isNonEmptyObject, isValidUUID, detectBotBlocker,
} from '@adobe/spacecat-shared-utils';
import {
  badRequest, internalServerError, notFound, ok, forbidden,
} from '@adobe/spacecat-shared-http-utils';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * Creates a bot blocker controller instance
 * @param {Object} ctx - The context object containing dataAccess
 * @param {Object} ctx.dataAccess - The data access layer for database operations
 * @param {Object} log - The logger instance
 * @returns {Object} The bot blocker controller instance
 * @throws {Error} If context or dataAccess is not provided
 */
function BotBlockerController(ctx, log) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;

  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Checks if a site is bot blocked
   * @param {Object} context - The request context
   * @param {Object} context.params - The request parameters
   * @param {string} context.params.siteId - The ID of the site to check
   * @returns {Promise<Object>} The HTTP response object
   */
  const checkBotBlocker = async (context) => {
    const siteId = context.params?.siteId;

    if (!isValidUUID(siteId)) {
      log.error(`Invalid siteId: ${siteId}`);
      return badRequest('Invalid siteId');
    }

    try {
      const site = await dataAccess.Site.findById(siteId);

      if (!site) {
        log.error(`Site with ID ${siteId} not found`);
        return notFound(`Site with ID ${siteId} not found`);
      }

      // Check if user has access to this site
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Only users belonging to the organization can check this site');
      }

      const baseURL = site.getBaseURL();
      if (!baseURL) {
        log.error(`Site ${siteId} has no baseURL`);
        return internalServerError('Site has no baseURL configured');
      }

      log.debug(`Checking bot blocker for site ${siteId} with baseURL: ${baseURL}`);

      // Call the bot blocker detection function
      const result = await detectBotBlocker({ baseUrl: baseURL });

      log.debug(`Bot blocker check completed for site ${siteId}: crawlable=${result.crawlable}, type=${result.type}, confidence=${result.confidence}`);

      return ok(result);
    } catch (error) {
      log.error(`Failed to check bot blocker for site ${siteId}: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  return {
    checkBotBlocker,
  };
}

export default BotBlockerController;
