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
  internalServerError,
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

    let res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    const fixEntities = await this.#FixEntity.allByOpportunityId(opportunityId);

    // Check whether the suggestion belongs to the opportunity,
    // and the opportunity belongs to the site.
    res = await checkOwnership(fixEntities[0], opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    const fixes = fixEntities.map((fix) => FixDto.toJSON(fix));
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
        return {
          index,
          fix: FixDto.toJSON(await FixEntity.create({ ...fixData, opportunityId })),
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
      executedBy, executedAt, publishedAt, changeDetails, suggestionIds,
    } = context.data;

    const Suggestion = this.#Suggestion;
    let hasUpdates = false;
    try {
      if (isArray(suggestionIds)) {
        const suggestions = await Promise.all(suggestionIds.map((id) => Suggestion.findById(id)));
        if (suggestions.some((s) => !s || s.getOpportunityId() !== opportunityId)) {
          return badRequest('Invalid suggestion IDs');
        }
        for (const suggestion of suggestions) {
          suggestion.setFixEntityId(fixId);
        }
        await Promise.all(suggestions.map((s) => s.save()));
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
   * Applies accessibility fixes by calling AIO app to create PR
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>}
   */
  async applyAccessibilityFix(context) {
    const { siteId, opportunityId } = context.params;
    const { log, env, imsClient } = context;

    const res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    if (!context.data) {
      return badRequest('Request body is required');
    }

    const { form, formSource, ruleId } = context.data;

    if (!hasText(form)) {
      return badRequest('form URL is required');
    }

    if (!hasText(formSource)) {
      return badRequest('formSource is required');
    }

    if (!hasText(ruleId)) {
      return badRequest('ruleId is required');
    }

    // Get the opportunity and verify it belongs to the site
    const opportunity = await this.#Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    const { AIO_AUTOFIX_API_URL: aioApiUrl } = env;
    if (!hasText(aioApiUrl)) {
      log.error('AIO_AUTOFIX_API_URL environment variable is not configured');
      return internalServerError('AIO autofix service is not configured');
    }

    try {
      // Get site details to access the IMS org ID
      const site = await this.#Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      // Get the organization to access IMS org ID
      const organization = await site.getOrganization();
      if (!organization || !organization.getImsOrgId()) {
        return badRequest('Site must belong to an organization with IMS Org ID');
      }

      const prContent = FixesController.#extractDiffFromOpportunity(
        opportunity,
        form,
        formSource,
        ruleId,
      );
      if (!prContent) {
        return badRequest('No accessibility guidance found for the specified form and rule ID');
      }

      const { diffContent, title } = prContent;

      // Prepare payload for AIO app
      const aioPayload = {
        diffContent,
        siteId,
        title,
        vcsType: 'github',
      };

      // Get service access token from IMS client
      const serviceToken = await FixesController.#getServiceAccessToken(imsClient, env, log);
      if (!serviceToken) {
        log.error('Failed to obtain service access token from IMS');
        return internalServerError('Authentication failed');
      }

      // Make request to AIO app
      const aioResponse = await fetch(aioApiUrl, {
        method: 'POST',
        headers: {
          'x-gw-ims-org-id': organization.getImsOrgId(),
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceToken}`,
        },
        body: JSON.stringify(aioPayload),
      });

      if (!aioResponse.ok) {
        log.error(`AIO app request failed: ${aioResponse.status} ${aioResponse.statusText}`);
        const errorText = await aioResponse.text();
        log.error(`AIO app error response: ${errorText}`);
        return createResponse({
          message: 'Failed to apply accessibility fix',
          details: `AIO app returned ${aioResponse.status}: ${aioResponse.statusText}`,
        }, 500);
      }

      const aioResult = await aioResponse.json();
      log.info(`Successfully applied accessibility fix for site ${siteId}, opportunity ${opportunityId}`);

      return ok({
        message: 'Accessibility fix applied successfully',
        prUrl: aioResult.prUrl || aioResult.pullRequestUrl,
        diffContent: aioPayload.diffContent,
        appliedRule: ruleId,
      });
    } catch (error) {
      log.error(`Error applying accessibility fix: ${error?.message || error}`, error);
      return internalServerError('Failed to apply accessibility fix');
    }
  }

  /**
   * Extracts guidance (diff content) from opportunity data for a specific accessibility issue
   * @param {Object} opportunity - The opportunity object
   * @param {string} form - Form URL to match
   * @param {string} formSource - Form source to match
   * @param {string} ruleId - Rule ID to match
   * @returns {string|null} The guidance diff content or null if not found
   * @private
   */
  static #extractDiffFromOpportunity(opportunity, form, formSource, ruleId) {
    try {
      const opportunityData = opportunity.getData();

      // Check if accessibility data exists
      if (!opportunityData?.accessibility || !Array.isArray(opportunityData.accessibility)) {
        return null;
      }

      // Find the accessibility entry that matches form and formSource
      const accessibilityEntry = opportunityData.accessibility.find(
        (entry) => entry.form === form && entry.formSource === formSource,
      );

      if (!accessibilityEntry || !Array.isArray(accessibilityEntry.a11yIssues)) {
        return null;
      }

      // Find the issue that matches the ruleId
      const issue = accessibilityEntry.a11yIssues.find(
        (a11yIssue) => a11yIssue.ruleId === ruleId,
      );

      if (!issue || !hasText(issue.guidance)) {
        return null;
      }

      return {
        diffContent: issue.guidance,
        title: issue.issue,
      };
    } catch (error) {
      // Log error but don't expose internal details
      return null;
    }
  }

  /**
   * Gets service access token from IMS client using client credentials
   * @param {Object} imsClient - The IMS client from context
   * @param {Object} env - Environment variables
   * @param {Object} log - Logger instance
   * @returns {Promise<string|null>} Service access token or null if failed
   * @private
   */
  static async #getServiceAccessToken(imsClient, env, log) {
    try {
      // Use existing IMS configuration pattern similar to other controllers
      const {
        IMS_HOST: host,
        IMS_CLIENT_ID: clientId,
        IMS_CLIENT_SECRET: clientSecret,
      } = env;

      if (!hasText(host) || !hasText(clientId) || !hasText(clientSecret)) {
        log.error('IMS client credentials not found in environment');
        return null;
      }

      // Generate service token using client credentials
      const serviceToken = await imsClient.getServiceAccessToken();
      return serviceToken;
    } catch (error) {
      log.error(`Error obtaining IMS service token: ${error?.message || error}`);
      return null;
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
