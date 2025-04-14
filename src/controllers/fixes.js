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
 * @import { FixEntity, FixEntityCollection } from "@adobe/spacecat-shared-data-access"
 */

import {
  badRequest,
  createResponse,
  noContent,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { ValidationError } from '@adobe/spacecat-shared-data-access';
import {
  hasText, isIsoDate, isNonEmptyObject, isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { FixDto } from '../dto/fix.js';

/**
 * @typedef {Object} Context
 * @property {Object.<string, undefined | null | boolean | number | string>} [params]
 */

export class FixesController {
  /** @type {FixEntityCollection} */
  #FixEntity;

  constructor(dataAccess) {
    this.#FixEntity = dataAccess.FixEntity;
  }

  /**
   * Gets all suggestions for a given site and opportunity.
   *
   * @param {Context} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getAllForSuggestion(context) {
    const { siteId, opptyId, suggestionId } = context.params ?? {};

    let res = checkRequestParams(siteId, opptyId, suggestionId);
    if (res) return res;

    const fixEntities = await this.#FixEntity.allBySuggestionId(suggestionId);

    // Check whether the suggestion belongs to the opportunity,
    // and the opportunity belongs to the site.
    if (fixEntities.length > 0) {
      res = checkOwnership(fixEntities[0], suggestionId, opptyId, siteId);
      if (res) return res;
    }

    const fixes = fixEntities.map((fix) => FixDto.toJSON(fix));
    return ok(fixes);
  }

  /**
   * Gets all suggestions for a given site, opportunity and status.
   *
   * @param {Context} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getByStatus(context) {
    const {
      siteId, opptyId, suggestionId, status,
    } = context.params ?? {};
    let res = checkRequestParams(siteId, opptyId, suggestionId);
    if (res) return res;

    if (!hasText(status)) {
      return badRequest('Status is required');
    }

    const fixEntities = await this.#FixEntity.allBySuggestionIdAndStatus(suggestionId, status);
    if (fixEntities.length > 0) {
      res = checkOwnership(fixEntities[0], suggestionId, opptyId, siteId);
      if (res) return res;
    }

    return ok(fixEntities.map((fix) => FixDto.toJSON(fix)));
  }

  /**
   * Get a suggestion given a site, opportunity and suggestion ID
   *
   * @param {Context} context - request context
   * @returns {Promise<Response>} Suggestion response.
   */
  async getByID(context) {
    const {
      siteId, opptyId, suggestionId, fixId,
    } = context.params ?? {};

    let res = checkRequestParams(siteId, opptyId, suggestionId);
    if (res) return res;
    if (!isValidUUID(fixId)) {
      return badRequest('Fix ID is required');
    }

    const fix = await this.#FixEntity.findById(fixId);
    res = fix ? checkOwnership(fix, opptyId, siteId) : notFound('Fix not found');
    if (res) return res;

    return ok(FixDto.toJSON(fix));
  }

  /**
   * Creates one or more fixes for a given site, opportunity, and suggestion.
   *
   * @param {Context} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async createFixes(context) {
    const { siteId, opptyId, suggestionId } = context.params ?? {};

    const res = checkRequestParams(siteId, opptyId, suggestionId);
    if (res) return res;

    if (!Array.isArray(context.data)) {
      return context.data ? badRequest('No updates provided') : badRequest('Request body must be an array');
    }

    const FixEntity = this.#FixEntity;
    const fixes = await Promise.all(context.data.map(async (fixData, index) => {
      try {
        return {
          index,
          fix: FixDto.toJSON(await FixEntity.create({ ...fixData, suggestionId })),
          statusCode: 201,
        };
      } catch (error) {
        return {
          index,
          message: error.message,
          statusCode: error instanceof ValidationError ? 400 : 500,
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
   * Update the status of one or multiple suggestions in one transaction
   *
   * @param {Context} context - request context
   * @returns {Promise<Response>} the updated opportunity data
   */
  async patchFixesStatus(context) {
    const { siteId, opptyId, suggestionId } = context.params ?? {};

    const res = checkRequestParams(siteId, opptyId, suggestionId);
    if (res) return res;

    if (!Array.isArray(context.data)) {
      return context.data ? badRequest('No updates provided') : badRequest('Request body must be an array of [{ id: <fix id>, status: <fix status> },...]');
    }

    const fixes = await Promise.all(
      context.data.map((data, index) => this.#patchFixStatus(data.id, data.status, index)),
    );
    const succeeded = countSucceeded(fixes);
    return createResponse({
      fixes,
      metadata: { total: fixes.length, success: succeeded, failed: fixes.length - succeeded },
    }, 207);
  }

  async #patchFixStatus(uuid, status, index, suggestionId, opportunityId, siteId) {
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
    const res = checkOwnership(fix, opportunityId, siteId);
    if (res) return res;

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
      const statusCode = error instanceof ValidationError ? 400 : 500;
      return { index, message: error.message, statusCode };
    }
  }

  /**
   * Updates data for a suggestion
   *
   * @param {Context} context - request context
   * @returns {Promise<Response>} the updated suggestion data
   */
  async patchFix(context) {
    const {
      sideId, opportunityId, suggestion, fixId,
    } = context.params ?? {};
    let res = checkRequestParams(sideId, opportunityId, suggestion);
    if (res) return res;

    if (!isValidUUID(fixId)) {
      return badRequest('Fix ID is required');
    }
    const fix = await this.#FixEntity.findById(suggestion, fixId);
    res = checkOwnership(fix, suggestion, opportunityId, sideId);
    if (res) return res;

    if (!context.data) {
      return badRequest('No updates provided');
    }

    const {
      executedBy, executedAt, publishedAt, changeDetails,
    } = context.data;

    let hasUpdates = false;
    try {
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

      if (hasUpdates) {
        return ok(FixDto.toJSON(await fix.save()));
      } else {
        return badRequest('No updates provided');
      }
    } catch (e) {
      return e instanceof ValidationError
        ? badRequest(e.message)
        : createResponse({ message: 'Error updating suggestion' }, 500);
    }
  }

  /**
   * Removes a fix
   * @param {Context} context - request context
   * @returns {Promise<Response>}
   */
  async removeFix(context) {
    const {
      siteId, opportunityId, suggestionId, fixId,
    } = context.params ?? {};

    let res = !isValidUUID(fixId)
      ? badRequest('Fix ID is required')
      : checkRequestParams(siteId, opportunityId, suggestionId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    res = fix ? checkOwnership(fix, suggestionId, opportunityId, siteId) : notFound('Fix not found');
    if (res) return res;

    try {
      await fix.remove();
      return noContent();
    } catch (e) {
      return createResponse({ message: `Error removing fix: ${e.message}` }, 500);
    }
  }
}

/**
 * Checks whether sideId, opportunityId and suggestionId are valid UUIDs.
 * @param {any} siteId
 * @param {any} opportunityId
 * @param {any} suggestionId
 * @returns {Response | null} badRequest response or null
 */
function checkRequestParams(siteId, opportunityId, suggestionId) {
  if (!isValidUUID(siteId)) {
    return badRequest('Site ID required');
  }

  if (!isValidUUID(opportunityId)) {
    return badRequest('Opportunity ID required');
  }

  if (!isValidUUID(suggestionId)) {
    return badRequest('Suggestion ID required');
  }
  return null;
}

/**
 * Checks if the fix belongs to the opportunity and the opportunity belongs to the site.
 *
 * @param {FixEntity} fix
 * @param {string} suggestionId
 * @param {string} opportunityId
 * @param {string} siteId
 * @returns {Promise<null | Response>}
 */
async function checkOwnership(fix, suggestionId, opportunityId, siteId) {
  const suggestion = await fix.getSuggestion();
  if (
    !suggestion
    || suggestion.getId() !== suggestionId
    || suggestion.getOpportunityId() !== opportunityId
  ) {
    return notFound('Suggestion not found');
  }

  const opportunity = await suggestion.getOpportunity();
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
