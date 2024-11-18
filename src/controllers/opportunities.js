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
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isObject,
  isNonEmptyObject,
  arrayEquals,
  isValidUrl,
} from '@adobe/spacecat-shared-utils';

import { OpportunityDto } from '../dto/opportunity.js';

// TODO: Validation methods should be moved to a different file. dataAccess?
// eslint-disable-next-line object-curly-newline
function validateDataTypes({ auditId, type, origin, runbook, tags, data, guidance, description }) {
  if (auditId && !hasText(auditId)) {
    return { valid: false, message: 'Audit ID should be string' };
  }

  if (type && !['broken-backlinks', 'broken-internal-links'].includes(type)) {
    return { valid: false, message: 'Invalid type' };
  }

  if (origin && !['ESS_OPS', 'AI'].includes(origin)) {
    return { valid: false, message: 'Invalid origin' };
  }

  if (runbook && !isValidUrl(runbook)) {
    return { valid: false, message: 'Invalid runbook URL' };
  }

  if (tags && !Array.isArray(tags)) {
    return { valid: false, message: 'Tags should be an array' };
  }

  if (data && !isObject(data)) {
    return { valid: false, message: 'Data should be an object' };
  }

  if (guidance && !isObject(guidance)) {
    return { valid: false, message: 'Guidance should be an object' };
  }

  if (description && !hasText(description)) {
    return { valid: false, message: 'Description should be a string' };
  }
  return { valid: true };
}
/**
 * Validates whether a given opportunity is valid.
 * @param {Object} opportunity data
 * @returns {{ valid: boolean, message: string }} Validation result.
 */
function validateOpportunityDataForCreate(opportunity) {
  const requiredFields = ['runbook', 'auditId', 'type', 'origin', 'title'];

  const missingRequiredFields = requiredFields.filter((field) => !opportunity[field]);
  if (missingRequiredFields.length > 0) {
    return { valid: false, message: `Missing required fields: ${missingRequiredFields.join(', ')}` };
  }

  return validateDataTypes(opportunity);
}

/**
 * Opportunities controller.
 * @param {DataAccess} dataAccess - Data access.
 * @returns {object} Opportunities controller.
 * @constructor
 */
function OpportunitiesController(dataAccess) {
  const { Opportunity } = dataAccess;
  if (!isObject(Opportunity)) {
    throw new Error('Data access required');
  }

  /**
   * Gets all opportunities for a given site.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of opportunities response.
   */
  const getAllForSite = async (context) => {
    const siteId = context.params?.siteId;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
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
    const status = context.params?.status || undefined;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    const opptys = (await Opportunity.getOpportunitiesForSite(siteId, status))
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
    const opptyId = context.params?.opportunityId || undefined;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(opptyId)) {
      return badRequest('Opportunity ID required');
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

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }
    const site = await dataAccess.getSiteByID(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const { valid, message } = validateOpportunityDataForCreate(context.data);
    if (!valid) {
      return badRequest(message);
    }
    try {
      const oppty = await Opportunity.createOpportunity(context.data);
      return createResponse(OpportunityDto.toJSON(oppty), 201);
    } catch (e) {
      return badRequest(e.message);
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

    // validate parameters
    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }
    if (!hasText(opportunityId)) {
      return badRequest('Opportunity ID required');
    }
    const site = await dataAccess.getSiteByID(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    // validate request body
    if (!context.data) {
      return badRequest('No updates provided');
    }

    /*    const { valid, message } = OpportunityDto.validateDataTypes(context.data);
    if (!valid) {
      return badRequest(message);
    } */

    // eslint-disable-next-line object-curly-newline
    const { runbook, data, title, description, status, guidance, tags } = context.data;
    // update opportunity with new data
    let hasUpdates = false;
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
      const updatedOppty = await opportunity.save(opportunity);
      return ok(OpportunityDto.toJSON(updatedOppty));
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

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    const site = await dataAccess.getSiteByID(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    await opportunity.remove();

    return noContent();
  };

  return {
    getAllForSite,
    getByStatus,
    getByID,
    createOpportunity,
    patchOpportunity,
    removeOpportunity,
  };
}

export default OpportunitiesController;
