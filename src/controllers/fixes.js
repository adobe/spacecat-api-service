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
  hasText, isArray, isIsoDate, isNonEmptyObject, isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { FixDto } from '../dto/fix.js';
import { SuggestionDto } from '../dto/suggestion.js';

/**
 * @typedef {Object} Context
 * @property {Object.<string, undefined | null | boolean | number | string>} [params]
 */

export class FixesController {
  /** @type {FixEntityCollection} */
  #FixEntity;

  constructor(dataAccess) {
    this.#FixEntity = dataAccess.FixEntity;

    this.getAllForOpportunity = this.getAllForOpportunity.bind(this);
    this.getByStatus = this.getByStatus.bind(this);
    this.getByID = this.getByID.bind(this);
    this.getAllSuggestionsForFix = this.getAllSuggestionsForFix.bind(this);
    this.createFixes = this.createFixes.bind(this);
    this.patchFixesStatus = this.patchFixesStatus.bind(this);
    this.patchFix = this.patchFix.bind(this);
    this.removeFix = this.removeFix.bind(this);
  }

  /**
   * Gets all suggestions for a given site and opportunity.
   *
   * @param {Context} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getAllForOpportunity(context) {
    const { siteId, opportunityId } = context.params ?? {};

    let res = checkRequestParams(siteId, opportunityId);
    if (res) return res;

    const fixEntities = await this.#FixEntity.allByOpportunityId(opportunityId);

    // Check whether the suggestion belongs to the opportunity,
    // and the opportunity belongs to the site.
    if (fixEntities.length > 0) {
      res = checkOwnership(fixEntities[0], opportunityId, siteId);
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
    const { siteId, opportunityId, status } = context.params ?? {};
    let res = checkRequestParams(siteId, opportunityId);
    if (res) return res;

    if (!hasText(status)) {
      return badRequest('Status is required');
    }

    const fixEntities = await this.#FixEntity.allByOpportunityIdAndStatus(opportunityId, status);
    if (fixEntities.length > 0) {
      res = checkOwnership(fixEntities[0], opportunityId, siteId);
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
    const { siteId, opportunityId, fixId } = context.params ?? {};

    let res = checkRequestParams(siteId, opportunityId, fixId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = checkOwnership(fix, opportunityId, siteId);
    if (res) return res;

    return ok(FixDto.toJSON(fix));
  }

  /**
   * Gets all suggestions for a given fix.
   *
   * @param {Context} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getAllSuggestionsForFix(context) {
    const { siteId, opportunityId, fixId } = context.params ?? {};

    let res = checkRequestParams(siteId, opportunityId, fixId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = checkOwnership(fix, opportunityId, siteId);
    if (res) return res;

    const suggestions = await fix.getSuggestions();
    return ok(suggestions.map(SuggestionDto.toJSON));
  }

  /**
   * Creates one or more fixes for a given site and opportunity.
   *
   * @param {Context} context - request context
   * @returns {Promise<Response>} Array of fixes response.
   */
  async createFixes(context) {
    const { siteId, opportunityId } = context.params ?? {};

    const res = checkRequestParams(siteId, opportunityId);
    if (res) return res;

    if (!Array.isArray(context.data)) {
      return context.data ? badRequest('No updates provided') : badRequest('Request body must be an array');
    }

    const FixEntity = this.#FixEntity;
    const fixes = await Promise.all(context.data.map(async (fixData, index) => {
      try {
        return {
          index,
          fix: FixDto.toJSON(await FixEntity.create({ ...fixData, opportunityId })),
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
   * Update the status of one or multiple fixes in one transaction
   *
   * @param {Context} context - request context
   * @returns {Promise<Response>} the updated opportunity data
   */
  async patchFixesStatus(context) {
    const { siteId, opportunityId } = context.params ?? {};

    const res = checkRequestParams(siteId, opportunityId);
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
    if (!fix) return notFound('Fix not found');
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
   * Updates data for a fix.
   *
   * @param {Context} context - request context
   * @returns {Promise<Response>} the updated fix data
   */
  async patchFix(context) {
    const { sideId, opportunityId, fixId } = context.params ?? {};
    let res = checkRequestParams(sideId, opportunityId, fixId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = checkOwnership(fix, opportunityId, sideId);
    if (res) return res;

    if (!context.data) {
      return badRequest('No updates provided');
    }

    const {
      executedBy, executedAt, publishedAt, changeDetails, suggestionIds,
    } = context.data;

    let hasUpdates = false;
    try {
      if (isArray(suggestionIds)) {
        if (executedBy !== fix.getExecutedBy() && hasText(executedBy)) {
          fix.setExecutedBy(executedBy);
          hasUpdates = true;
        }
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
        : createResponse({ message: 'Error updating fix' }, 500);
    }
  }

  /**
   * Removes a fix
   * @param {Context} context - request context
   * @returns {Promise<Response>}
   */
  async removeFix(context) {
    const { siteId, opportunityId, fixId } = context.params ?? {};

    let res = checkRequestParams(siteId, opportunityId, fixId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = checkOwnership(fix, opportunityId, siteId);
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
 * Checks whether sideId and opportunityId are valid UUIDs.
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
 * @param {FixEntity} fix
 * @param {string} opportunityId
 * @param {string} siteId
 * @returns {Promise<null | Response>}
 */
async function checkOwnership(fix, opportunityId, siteId) {
  if (fix.getOpportunityId() !== opportunityId) {
    return notFound('Opportunity not found');
  }
  const opportunity = await fix.getOpportunity();
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
