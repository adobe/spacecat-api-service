/*
 * Copyright 2023 Adobe. All rights reserved.
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
  badRequest,
  notFound,
  ok,
  createResponse,
  noContent,
  forbidden,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isObject,
  isNonEmptyObject,
  arrayEquals,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { OpportunityDto } from '../dto/opportunity.js';
import AccessControlUtil from '../support/access-control-util.js';
import { grantSuggestionsForOpportunity } from '../support/grant-suggestions-handler.js';
import { getIsSummitPlgEnabled } from '../support/utils.js';

const VALIDATION_ERROR_NAME = 'ValidationError';

/**
 * Opportunities controller.
 * @param {object} ctx - Context of the request.
 * @returns {object} Opportunities controller.
 * @constructor
 */
function OpportunitiesController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }
  const { Opportunity, Suggestion } = dataAccess;
  if (!isObject(Opportunity)) {
    throw new Error('Opportunity Collection not available');
  }

  const { Site } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * returns a response for a data access error.
   * If there's a ValidationError it will return a 400 response, and the
   * validation error message coming from the data access layer.
   * If there's another kind of error, it will return a 500 response.
   * The error message in the 500 response is overriden by passing the message parameter
   * to avoid exposing internal error messages to the client.
   * @param {*} e - error
   * @param {*} message - error message to override 500 error messages
   * @returns a response
   */
  function handleDataAccessError(e, message) {
    if (e?.name === VALIDATION_ERROR_NAME) {
      return badRequest(e.message);
    }
    return createResponse({ message }, 500);
  }

  /**
   * Checks if an opportunity has any suggestions with PENDING_VALIDATION status.
   * @param {string} opportunityId - The opportunity ID to check
   * @returns {Promise<boolean>} True if the opportunity has PENDING_VALIDATION suggestions
   */
  async function hasPendingValidationSuggestions(opportunityId) {
    try {
      const suggestions = await Suggestion.allByOpportunityIdAndStatus(
        opportunityId,
        'PENDING_VALIDATION',
      );
      return suggestions && suggestions.length > 0;
    } catch (e) {
      ctx.log?.warn?.('Error checking for PENDING_VALIDATION suggestions', {
        opportunityId,
        error: e?.message ?? e,
      });
      // On error, filter out the opportunity
      return true;
    }
  }

  /**
   * Filters out opportunities that have suggestions with PENDING_VALIDATION status.
   * @param {Array} opportunities - Array of opportunity entities
   * @returns {Promise<Array>} Filtered array of opportunities
   */
  async function filterPendingValidationOpportunities(opportunities) {
    // Check all opportunities in parallel for better performance
    const pendingChecks = await Promise.all(
      opportunities.map((oppty) => hasPendingValidationSuggestions(oppty.getId())),
    );

    // Filter out opportunities that have pending validation suggestions
    return opportunities.filter((_, index) => !pendingChecks[index]);
  }

  /**
   * Gets all opportunities for a given site.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of opportunities response.
   */
  const getAllForSite = async (context) => {
    const siteId = context.params?.siteId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can view its opportunities');
    }

    try {
      const allOpptys = await Opportunity.allBySiteId(siteId);
      const filteredOpptys = await filterPendingValidationOpportunities(allOpptys);
      const opptys = filteredOpptys.map((oppty) => OpportunityDto.toJSON(oppty));

      return ok(opptys);
    } catch (e) {
      ctx.log?.error?.('Error transforming opportunities to JSON', {
        siteId,
        error: e?.message ?? e,
      });
      return handleDataAccessError(e, 'Error retrieving opportunities');
    }
  };

  /**
   * Gets all opportunities for a given site type filtering by status.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of opportunities response.
   */
  const getByStatus = async (context) => {
    const siteId = context.params?.siteId;
    const status = context.params?.status;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!hasText(status)) {
      return badRequest('Status required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can view its opportunities');
    }

    try {
      const allOpptys = await Opportunity.allBySiteIdAndStatus(siteId, status);
      const filteredOpptys = await filterPendingValidationOpportunities(allOpptys);
      const opptys = filteredOpptys.map((oppty) => OpportunityDto.toJSON(oppty));

      return ok(opptys);
    } catch (e) {
      ctx.log?.error?.('Error transforming opportunities to JSON', {
        siteId,
        status,
        error: e?.message ?? e,
      });
      return handleDataAccessError(e, 'Error retrieving opportunities');
    }
  };

  /**
   * Gets an opportunity for a given site type and opportunity ID.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Opportunity response.
   */
  const getByID = async (context) => {
    const siteId = context.params?.siteId;
    const opptyId = context.params?.opportunityId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opptyId)) {
      return badRequest('Opportunity ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can view its opportunities');
    }

    const oppty = await Opportunity.findById(opptyId);
    if (!oppty || oppty.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    // Filter out opportunities with PENDING_VALIDATION suggestions
    const hasPending = await hasPendingValidationSuggestions(opptyId);
    if (hasPending) {
      return notFound('Opportunity not found');
    }

    if (await getIsSummitPlgEnabled(site, ctx, context)) {
      try {
        await grantSuggestionsForOpportunity(dataAccess, site, oppty);
      /* c8 ignore next 3 */
      } catch (err) {
        ctx.log?.warn?.('Grant suggestions handler failed', err?.message ?? err);
      }
    }

    try {
      return ok(OpportunityDto.toJSON(oppty));
    } catch (e) {
      ctx.log?.error?.('Error transforming opportunity to JSON', {
        opportunityId: opptyId,
        error: e?.message ?? e,
      });
      return handleDataAccessError(e, 'Error retrieving opportunity');
    }
  };

  /**
   * Creates an opportunity
   * @param {Object} context of the request
   * @return {Promise<Response>} Opportunity response.
   */
  const createOpportunity = async (context) => {
    const siteId = context.params?.siteId;
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isNonEmptyObject(context.data)) {
      return badRequest('No data provided');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can create its opportunities');
    }

    context.data.siteId = siteId;
    try {
      const oppty = await Opportunity.create(context.data);
      return createResponse(OpportunityDto.toJSON(oppty), 201);
    } catch (e) {
      return handleDataAccessError(e, 'Error creating opportunity');
    }
  };

  /**
   * Updates data for an opportunity
   * @param {Object} context of the request
   * @returns {Promise<Response>} the updated opportunity data
   */
  const patchOpportunity = async (context) => {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;
    const { authInfo: { profile } } = context.attributes;

    // validate parameters
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can edit its opportunities');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }
    // validate request body
    if (!isNonEmptyObject(context.data)) {
      return badRequest('No updates provided');
    }

    // eslint-disable-next-line object-curly-newline
    const { auditId, runbook, data, title, description, status, guidance, tags } = context.data;
    // update opportunity with new data
    let hasUpdates = false;
    try {
      if (auditId && auditId !== opportunity.getAuditId()) {
        hasUpdates = true;
        opportunity.setAuditId(auditId);
      }
      if (runbook && runbook !== opportunity.getRunbook()) {
        hasUpdates = true;
        opportunity.setRunbook(runbook);
      }
      if (isNonEmptyObject(data)) {
        hasUpdates = true;
        opportunity.setData(data);
      }

      if (title && title !== opportunity.getTitle()) {
        hasUpdates = true;
        opportunity.setTitle(title);
      }
      if (description && description !== opportunity.getDescription()) {
        hasUpdates = true;
        opportunity.setDescription(description);
      }
      if (status && status !== opportunity.getStatus()) {
        hasUpdates = true;
        opportunity.setStatus(status);
      }
      if (isNonEmptyObject(guidance)) {
        hasUpdates = true;
        opportunity.setGuidance(guidance);
      }
      if (tags && !arrayEquals(tags, opportunity.getTags())) {
        hasUpdates = true;
        opportunity.setTags(tags);
      }
      if (hasUpdates) {
        opportunity.setUpdatedBy(profile.email || 'system');
        const updatedOppty = await opportunity.save(opportunity);
        return ok(OpportunityDto.toJSON(updatedOppty));
      }
    } catch (e) {
      return handleDataAccessError(e, 'Error updating opportunity');
    }
    return badRequest('No updates provided');
  };

  /**
   * Removes an opportunity.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Delete response.
   */
  const removeOpportunity = async (context) => {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization of the site can remove its opportunities');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    try {
      await opportunity.remove(); // also removes suggestions associated with opportunity
      return noContent();
    } catch (e) {
      return handleDataAccessError(e, 'Error removing opportunity');
    }
  };

  return {
    createOpportunity,
    getAllForSite,
    getByID,
    getByStatus,
    patchOpportunity,
    removeOpportunity,
  };
}

export default OpportunitiesController;
