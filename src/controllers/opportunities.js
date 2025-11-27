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
import { ValidationError } from '@adobe/spacecat-shared-data-access';
import { OpportunityDto } from '../dto/opportunity.js';
import { OpportunitySummaryDto } from '../dto/opportunity-summary.js';
import AccessControlUtil from '../support/access-control-util.js';

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
    if (e instanceof ValidationError) {
      return badRequest(e.message);
    }
    return createResponse({ message }, 500);
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

    const opptys = (await Opportunity.allBySiteId(siteId))
      .map((oppty) => OpportunityDto.toJSON(oppty));

    return ok(opptys);
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

    const opptys = (await Opportunity.allBySiteIdAndStatus(siteId, status))
      .map((oppty) => OpportunityDto.toJSON(oppty));

    return ok(opptys);
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
    return ok(OpportunityDto.toJSON(oppty));
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

  /**
   * Gets top opportunities for paid media with 'NEW' or 'IN_PROGRESS' status for a site.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of opportunity summaries.
   */
  const getTopPaidOpportunities = async (context) => {
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

    const newOpportunities = await Opportunity.allBySiteIdAndStatus(siteId, 'NEW');
    const inProgressOpportunities = await Opportunity.allBySiteIdAndStatus(siteId, 'IN_PROGRESS');
    const allOpportunities = [...newOpportunities, ...inProgressOpportunities];

    // temp using all these tags for testing but evenutally we will just use 'paid media'
    const targetTags = ['paid media', 'traffic acquisition', 'engagement', 'content optimization'];
    const filteredOpportunities = allOpportunities.filter((oppty) => {
      const tags = oppty.getTags() || [];
      const title = oppty.getTitle() || '';
      const description = oppty.getDescription() || '';

      if (!description) {
        return false;
      }

      if (title.toLowerCase().includes('report')) {
        return false;
      }

      return tags.some((tag) => targetTags.includes(tag.toLowerCase()));
    });

    const opportunitySummaries = await Promise.all(
      filteredOpportunities.map(async (oppty) => {
        const suggestions = await Suggestion.allByOpportunityId(oppty.getId());
        return OpportunitySummaryDto.toJSON(oppty, suggestions);
      }),
    );

    const validSummaries = opportunitySummaries.filter(
      (summary) => summary.projectedTrafficValue > 0,
    );

    validSummaries.sort((a, b) => b.projectedTrafficValue - a.projectedTrafficValue);

    return ok(validSummaries);
  };

  return {
    createOpportunity,
    getAllForSite,
    getByID,
    getByStatus,
    getTopPaidOpportunities,
    patchOpportunity,
    removeOpportunity,
  };
}

export default OpportunitiesController;
