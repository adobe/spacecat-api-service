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
/* eslint-disable no-use-before-define */

/**
 * @import {
 *   FixEntity,
 *   FixEntityCollection,
 *   OpportunityCollection,
 *   SiteCollection,
 *   SuggestionCollection
 * } from "@adobe/spacecat-shared-data-access"
 */

import {
  badRequest,
  createResponse,
  forbidden,
  noContent,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { ValidationError } from '@adobe/spacecat-shared-data-access';
import {
  hasText, isArray, isIsoDate, isNonEmptyObject, isValidUUID,
} from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';
import { FixDto } from '../dto/fix.js';
import { SuggestionDto } from '../dto/suggestion.js';

/**
 * @typedef {Object} DataAccess
 * @property {FixEntityCollection} FixEntity
 * @property {OpportunityCollection} Opportunity
 * @property {SuggestionCollection} Suggestion
 *
 * @typedef {Object} LambdaContext
 * @property {DataAccess} dataAccess
 *
 * @typedef {Object} RequestContext
 * @property {Object.<string, undefined | null | boolean | number | string>} [params]
 * @property {any} [data]
 */

export class FixesController {
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
  }

  /**
   * Gets all suggestions for a given site and opportunity.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getAllForOpportunity(context) {
    const { siteId, opportunityId } = context.params;
    const { fixCreatedDate } = context.data || {};

    let res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    let fixEntities = [];
    let fixes = [];

    if (hasText(fixCreatedDate)) {
      const fixEntitiesWithSuggestions = await this.#FixEntity
        .getAllFixesWithSuggestionByCreatedAt(opportunityId, fixCreatedDate);

      if (fixEntitiesWithSuggestions.length === 0) {
        return ok([]);
      }

      // Extract fix entities and attach suggestions to each one
      fixEntities = fixEntitiesWithSuggestions.map((item) => {
        const { fixEntity } = item;
        // Attach suggestions to the fixEntity for DTO conversion
        // eslint-disable-next-line no-underscore-dangle
        fixEntity._suggestions = item.suggestions;
        return fixEntity;
      });

      // Check ownership for the first fix entity to ensure
      // the opportunity belongs to the site
      res = await checkOwnership(fixEntities[0], opportunityId, siteId, this.#Opportunity);
      if (res) return res;

      fixes = fixEntities.map((fix) => FixDto.toJSON(fix));
      return ok(fixes);
    }

    fixEntities = await this.#FixEntity.allByOpportunityId(opportunityId);

    // Check whether the suggestion belongs to the opportunity,
    // and the opportunity belongs to the site.
    res = await checkOwnership(fixEntities[0], opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    fixes = fixEntities.map((fix) => FixDto.toJSON(fix));
    return ok(fixes);
  }

  /**
   * Gets all suggestions for a given site, opportunity and status.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getByStatus(context) {
    const { siteId, opportunityId, status } = context.params;
    let res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    if (!hasText(status)) {
      return badRequest('Status is required');
    }

    const fixEntities = await this.#FixEntity.allByOpportunityIdAndStatus(opportunityId, status);
    res = await checkOwnership(fixEntities[0], opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    return ok(fixEntities.map((fix) => FixDto.toJSON(fix)));
  }

  /**
   * Get a suggestion given a site, opportunity and suggestion ID
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Suggestion response.
   */
  async getByID(context) {
    const { siteId, opportunityId, fixId } = context.params;

    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    return ok(FixDto.toJSON(fix));
  }

  /**
   * Gets all suggestions for a given fix.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getAllSuggestionsForFix(context) {
    const { siteId, opportunityId, fixId } = context.params;

    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    const suggestions = await fix.getSuggestions();
    return ok(suggestions.map(SuggestionDto.toJSON));
  }

  /**
   * Creates one or more fixes for a given site and opportunity.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of fixes response.
   */
  async createFixes(context) {
    const { siteId, opportunityId } = context.params;

    let res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    res = await checkOwnership(null, opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    if (!Array.isArray(context.data)) {
      return context.data ? badRequest('Request body must be an array') : badRequest('No updates provided');
    }

    const FixEntity = this.#FixEntity;
    const fixes = await Promise.all(context.data.map(async (fixData, index) => {
      try {
        const fixEntity = await FixEntity.create({ ...fixData, opportunityId });
        if (fixData.suggestionIds) {
          const suggestions = await Promise.all(
            fixData.suggestionIds.map((id) => this.#Suggestion.findById(id)),
          );
          await FixEntity.setSuggestionsForFixEntity(opportunityId, fixEntity, suggestions);
        }
        return {
          index,
          fix: FixDto.toJSON(fixEntity),
          statusCode: 201,
        };
      } catch (error) {
        return {
          index,
          message: error.message,
          statusCode: error instanceof ValidationError ? /* c8 ignore next */ 400 : 500,
        };
      }
    }));
    const succeeded = countSucceeded(fixes);
    return createResponse({
      fixes,
      metadata: {
        total: fixes.length,
        success: succeeded,
        failed: fixes.length - succeeded,
      },
    }, 207);
  }

  /**
   * Update the status of one or multiple fixes in one transaction
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} the updated opportunity data
   */
  async patchFixesStatus(context) {
    const { siteId, opportunityId } = context.params;

    const res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    if (!Array.isArray(context.data)) {
      return (
        context.data
          ? badRequest('Request body must be an array of [{ id: <fix id>, status: <fix status> },...]')
          : badRequest('No updates provided')
      );
    }

    const fixes = await Promise.all(
      context.data.map(
        (data, index) => this.#patchFixStatus(data.id, data.status, index, opportunityId, siteId),
      ),
    );
    const succeeded = countSucceeded(fixes);
    return createResponse({
      fixes,
      metadata: { total: fixes.length, success: succeeded, failed: fixes.length - succeeded },
    }, 207);
  }

  async #patchFixStatus(uuid, status, index, opportunityId, siteId) {
    if (!hasText(uuid)) {
      return {
        index,
        uuid: '',
        message: 'fix id is required',
        statusCode: 400,
      };
    }
    if (!hasText(status)) {
      return {
        index,
        uuid,
        message: 'fix status is required',
        statusCode: 400,
      };
    }

    const fix = await this.#FixEntity.findById(uuid);
    const res = fix
      ? await checkOwnership(fix, opportunityId, siteId, this.#Opportunity)
      : notFound('Fix not found');
    if (res) {
      return {
        index,
        uuid,
        message: await res.json().then(({ message }) => message),
        statusCode: res.status,
      };
    }

    try {
      if (fix.getStatus() === status) {
        return {
          index, uuid, message: 'No updates provided', statusCode: 400,
        };
      }

      fix.setStatus(status);
      return {
        index, uuid, fix: FixDto.toJSON(await fix.save()), statusCode: 200,
      };
    } catch (error) {
      const statusCode = error instanceof ValidationError ? /* c8 ignore next */ 400 : 500;
      return {
        index, uuid, message: error.message, statusCode,
      };
    }
  }

  /**
   * Updates data for a fix.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} the updated fix data
   */
  async patchFix(context) {
    const { siteId, opportunityId, fixId } = context.params;
    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    if (!context.data) {
      return badRequest('No updates provided');
    }

    const {
      executedBy, executedAt, publishedAt, changeDetails, suggestionIds, origin,
    } = context.data;

    const Suggestion = this.#Suggestion;
    let hasUpdates = false;
    try {
      if (isArray(suggestionIds)) {
        const suggestions = await Promise.all(suggestionIds.map((id) => Suggestion.findById(id)));
        if (suggestions.some((s) => !s || s.getOpportunityId() !== opportunityId)) {
          return badRequest('Invalid suggestion IDs');
        }
        await this.#FixEntity.setSuggestionsForFixEntity(opportunityId, fix, suggestions);
        hasUpdates = true;
      }

      if (executedBy !== fix.getExecutedBy() && hasText(executedBy)) {
        fix.setExecutedBy(executedBy);
        hasUpdates = true;
      }

      if (executedAt !== fix.getExecutedAt() && isIsoDate(executedAt)) {
        fix.setExecutedAt(executedAt);
        hasUpdates = true;
      }

      if (publishedAt !== fix.getPublishedAt() && isIsoDate(publishedAt)) {
        fix.setPublishedAt(publishedAt);
        hasUpdates = true;
      }

      if (isNonEmptyObject(changeDetails)) {
        fix.setChangeDetails(changeDetails);
        hasUpdates = true;
      }

      if (origin !== fix.getOrigin() && hasText(origin)) {
        fix.setOrigin(origin);
        hasUpdates = true;
      }

      if (hasUpdates) {
        return ok(FixDto.toJSON(await fix.save()));
      } else {
        return badRequest('No updates provided');
      }
    } catch (e) {
      return e instanceof ValidationError
        ? /* c8 ignore next */ badRequest(e.message)
        : createResponse({ message: 'Error updating fix' }, 500);
    }
  }

  /**
   * Removes a fix
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>}
   */
  async removeFix(context) {
    const { siteId, opportunityId, fixId } = context.params;

    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    try {
      await fix.remove();
      return noContent();
    } catch (e) {
      return createResponse({ message: `Error removing fix: ${e.message}` }, 500);
    }
  }

  /**
   * Checks if the user has admin access.
   * @param {string} siteId
   * @returns {Response | null} forbidden response or null.
   */
  async #checkAccess(siteId) {
    const site = await this.#Site.findById(siteId);
    /* c8 ignore start */
    if (!site) {
      return notFound('Site not found');
    }
    /* c8 ignore end */

    return await this.#accessControl.hasAccess(site)
      ? null
      : forbidden('Only users belonging to the organization may access fix entities.');
  }
}

/**
 * Checks whether siteId and opportunityId are valid UUIDs.
 * Supports optional fixId.
 * @param {any} siteId
 * @param {any} opportunityId
 * @param {any} [fixId]
 * @returns {Response | null} badRequest response or null
 */
function checkRequestParams(siteId, opportunityId, fixId = UNSET) {
  if (!isValidUUID(siteId)) {
    return badRequest('Site ID required');
  }

  if (!isValidUUID(opportunityId)) {
    return badRequest('Opportunity ID required');
  }

  if (fixId !== UNSET && !isValidUUID(fixId)) {
    return badRequest('Fix ID required');
  }

  return null;
}
const UNSET = Symbol('UNSET');

/**
 * Checks if the fix belongs to the opportunity and the opportunity belongs to the site.
 *
 * @param {undefined | null | FixEntity} fix
 * @param {string} opportunityId
 * @param {string} siteId
 * @param {OpportunityCollection} opportunities
 * @returns {Promise<null | Response>}
 */
async function checkOwnership(fix, opportunityId, siteId, opportunities) {
  if (fix && fix.getOpportunityId() !== opportunityId) {
    return notFound('Opportunity not found');
  }
  const opportunity = await (fix ? fix.getOpportunity() : opportunities.findById(opportunityId));
  if (!opportunity || opportunity.getSiteId() !== siteId) {
    return notFound('Opportunity not found');
  }
  return null;
}

/**
 * @param {Array<{statusCode: number}>} items
 * @returns {number} number of succeeded items
 */
function countSucceeded(items) {
  return items.reduce((succ, item) => succ + (item.statusCode < 400), 0);
}
