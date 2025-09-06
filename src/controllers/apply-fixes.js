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

/**
 * @import {
 *   FixEntityCollection,
 *   OpportunityCollection,
 *   SiteCollection,
 *   SuggestionCollection
 * } from "@adobe/spacecat-shared-data-access"
 */

import {
  badRequest,
  notFound,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isArray,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';
import { ApplyAccessibilityFixHandler } from './apply-fixes/accessibility-handler.js';

/**
 * @typedef {Object} DataAccess
 * @property {FixEntityCollection} FixEntity
 * @property {OpportunityCollection} Opportunity
 * @property {SiteCollection} Site
 * @property {SuggestionCollection} Suggestion
 *
 * @typedef {Object} LambdaContext
 * @property {DataAccess} dataAccess
 *
 * @typedef {Object} RequestContext
 * @property {Object.<string, undefined | null | boolean | number | string>} [params]
 * @property {any} [data]
 */

/**
 * Checks whether siteId and opportunityId are valid UUIDs.
 * @param {any} siteId
 * @param {any} opportunityId
 * @returns {Response | null} badRequest response or null
 */
function checkRequestParams(siteId, opportunityId) {
  if (!isValidUUID(siteId)) {
    return badRequest('Site ID required');
  }

  if (!isValidUUID(opportunityId)) {
    return badRequest('Opportunity ID required');
  }

  return null;
}

export class ApplyFixesController {
  /** @type {FixEntityCollection} */
  #FixEntity;

  /** @type {OpportunityCollection} */
  #Opportunity;

  /** @type {SiteCollection} */
  #Site;

  /** @type {SuggestionCollection} */
  #Suggestion;

  /** @type {AccessControlUtil} */
  #accessControl;

  /** @type {Map<string, Function>} */
  #handlers;

  /**
   * @param {LambdaContext} ctx
   * @param {AccessControlUtil} [accessControl]
   */
  constructor(ctx, accessControl = new AccessControlUtil(ctx)) {
    const { dataAccess } = ctx;
    this.#FixEntity = dataAccess.FixEntity;
    this.#Opportunity = dataAccess.Opportunity;
    this.#Site = dataAccess.Site;
    this.#Suggestion = dataAccess.Suggestion;
    this.#accessControl = accessControl;

    // Register fix handlers
    this.#handlers = new Map();
    this.#registerHandlers(dataAccess);
  }

  /**
   * Register fix handlers for different types.
   * @param {DataAccess} dataAccess - Data access collections
   * @private
   */
  #registerHandlers(dataAccess) {
    // Register accessibility handler
    const accessibilityHandler = new ApplyAccessibilityFixHandler(dataAccess);
    this.#handlers.set('accessibility', accessibilityHandler.applyFixes.bind(accessibilityHandler));
  }

  /**
   * Applies fixes based on the specified type and suggestion IDs.
   * This is the generic method that supports multiple fix types.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>}
   */
  async applyFixes(context) {
    const { siteId, opportunityId } = context.params;

    const res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    if (!context.data) {
      return badRequest('Request body is required');
    }

    const { type, suggestionIds } = context.data;

    // Validate request payload
    if (!hasText(type)) {
      return badRequest('type field is required');
    }

    if (!isArray(suggestionIds) || suggestionIds.length === 0) {
      return badRequest('suggestionIds array is required and must not be empty');
    }

    // Check if handler exists for the specified type
    if (!this.#handlers.has(type)) {
      const supportedTypes = Array.from(this.#handlers.keys());
      return badRequest(`Unsupported fix type: ${type}. Supported types: ${supportedTypes.join(', ')}`);
    }

    // Get the opportunity and verify it belongs to the site
    const opportunity = await this.#Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    // Get site details
    const site = await this.#Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    try {
      // Get the appropriate handler and delegate the fix application
      const handler = this.#handlers.get(type);
      return await handler(context, suggestionIds, opportunity, site);
    } catch (error) {
      context.log?.error(`Error applying ${type} fixes: ${error.message}`);
      return internalServerError(`Failed to apply ${type} fixes`);
    }
  }

  /**
   * Checks if the user has admin access.
   * @param {string} siteId
   * @returns {Response | null} forbidden response or null.
   * @private
   */
  async #checkAccess(siteId) {
    const site = await this.#Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    return await this.#accessControl.hasAccess(site)
      ? null
      : badRequest('Only users belonging to the organization may access fix entities.');
  }
}
