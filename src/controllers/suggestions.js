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
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isArray,
  isNumber,
  isObject,
} from '@adobe/spacecat-shared-utils';

import { SuggestionDto } from '../dto/suggestion.js';

// TODO: Validation methods should be moved to a different file. dataAccess?
// eslint-disable-next-line object-curly-newline
function validateDataTypes({ type, rank, data, kpiDeltas }) {
  // I undestand that there are more types to come, but for now, we only have this one
  if (type && !['redirect'].includes(type)) {
    return { valid: false, message: 'Invalid type' };
  }

  if (rank && !isNumber(rank)) {
    return { valid: false, message: 'Rank should be a number' };
  }

  if (data && !isObject(data)) {
    return { valid: false, message: 'Data should be an object' };
  }

  if (kpiDeltas && !isObject(kpiDeltas)) {
    return { valid: false, message: 'kpiDeltas should be an object' };
  }
  return { valid: true };
}
/**
 * Validates whether a given suggestion data is valid.
 * @param {Object} suggestion data
 * @returns {{ valid: boolean, message: string }} Validation result.
 */
function validateSuggestionDataForCreate(suggestion) {
  const requiredFields = ['type', 'rank', 'data'];

  const missingRequiredFields = requiredFields.filter((field) => !suggestion[field]);
  if (missingRequiredFields.length > 0) {
    return { valid: false, message: `Missing required fields: ${missingRequiredFields.join(', ')}` };
  }

  return validateDataTypes(suggestion);
}

/**
 * Suggestions controller.
 * @param {DataAccess} dataAccess - Data access.
 * @returns {object} Suggestions controller.
 * @constructor
 */
function SuggestionsController(dataAccess) {
  const { Suggestion } = dataAccess;
  if (!isObject(Suggestion)) {
    throw new Error('Data access required');
  }

  /**
   * Gets all suggestions for a given site and opportunity
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of suggestions response.
   */
  const getAllForOpportunity = async (context) => {
    const siteId = context.params?.siteId;
    const opptyId = context.params?.opportunityId;
    const ascending = context.data?.ascending === 'true' || false;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(opptyId)) {
      return badRequest('Opportunity ID required');
    }
    const suggestions = (await dataAccess.getSuggestionsForSite(siteId, opptyId, ascending))
      .map((sugg) => SuggestionDto.toJSON(sugg));

    return ok(suggestions);
  };

  /**
   * Gets all suggestions for a given site, opportunity and status
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of suggestions response.
   */
  const getByStatus = async (context) => {
    const siteId = context.params?.siteId;
    const opptyId = context.params?.opportunityId;
    const status = context.params?.status || undefined;
    const ascending = context.data?.ascending === 'true' || false;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }
    if (!hasText(opptyId)) {
      return badRequest('Opportunity ID required');
    }
    const suggestions = (await dataAccess.getSuggestionsForSite(siteId, opptyId, status, ascending))
      .map((sugg) => SuggestionDto.toJSON(sugg));

    return ok(suggestions);
  };

  /**
   * Get a suggestion given a site, opportunity and suggestion ID
   * @param {Object} context of the request
   * @returns {Promise<Response>} Suggestion response.
   */
  const getByID = async (context) => {
    const siteId = context.params?.siteId;
    const opptyId = context.params?.opportunityId || undefined;
    const suggestionId = context.params?.suggestionId || undefined;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(opptyId)) {
      return badRequest('Opportunity ID required');
    }

    if (!hasText(suggestionId)) {
      return badRequest('suggestion ID required');
    }

    const sugg = await dataAccess.getSuggestionById(siteId, opptyId, suggestionId);
    if (!sugg) {
      return notFound('Suggestion not found');
    }
    return ok(SuggestionDto.toJSON(sugg));
  };

  /**
   * Creates one or more suggestions for a given site and opportunity
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of suggestions response.
   */
  const createSuggestions = async (context) => {
    const siteId = context.params?.siteId;
    const opptyId = context.params?.opportunityId || undefined;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(opptyId)) {
      return badRequest('Opportunity ID required');
    }

    // validate request body
    if (!context.data) {
      return badRequest('No updates provided');
    }

    if (!isArray(context.data)) {
      return badRequest('request body must be an array');
    }

    // validate each suggestion
    const errors = [];
    const validSuggestions = context.data.map((suggData) => {
      const validationResult = validateSuggestionDataForCreate(suggData);
      if (!validationResult.valid) {
        errors.push(validationResult.message);
        return null;
      }
      return suggData;
    }).filter((sugg) => sugg);

    // TODO: if errors? create valid suggestions and return 201 or fail the whole transaction?
    if (validSuggestions.length === 0 && errors.length > 0) {
      return badRequest(errors.join(', '));
    }

    const suggestions = await dataAccess.addSuggestions(validSuggestions, siteId, opptyId);
    return createResponse(suggestions.map((sugg) => SuggestionDto.toJSON(sugg)), 201);
  };

  /**
   * Updates data for a suggestion
   * @param {Object} context of the request
   * @returns {Promise<Response>} the updated suggestion data
   */
  const patchSuggestion = async (context) => {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;
    const suggestionId = context.params?.suggestionId;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    if (!hasText(suggestionId)) {
      return badRequest('Suggestion ID required');
    }

    const site = await dataAccess.getSiteByID(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    const opportunity = await dataAccess.getOpportunityById(siteId, opportunityId);
    if (!opportunity) {
      return notFound('Opportunity not found');
    }

    const suggestion = await dataAccess.getSuggestionById(siteId, opportunityId, suggestionId);
    if (!suggestion) {
      return notFound('Suggestion not found');
    }

    // validate request body
    if (!context.data) {
      return badRequest('No updates provided');
    }

    let hasUpdates = false;
    const { rank, data, kpiDeltas } = context.data;
    if (rank && rank !== suggestion.rank) {
      hasUpdates = true;
      suggestion.setRank(rank);
    }

    if (data) {
      hasUpdates = true;
      suggestion.setData(data);
    }

    if (kpiDeltas) {
      hasUpdates = true;
      suggestion.setKpiDeltas(kpiDeltas);
    }

    if (hasUpdates) {
      await dataAccess.updateSuggestion(suggestion);
      return ok(SuggestionDto.toJSON(suggestion));
    }
    return badRequest('No updates provided');
  };

  /**
   * Update the status of one or multiple suggestions in one transaction
   * @param {Object} context of the request
   * @returns {Promise<Response>} the updated opportunity data
   */
  const patchSuggestionsStatus = async (context) => {
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

    const opportunity = await dataAccess.getOpportunityById(siteId, opportunityId);
    if (!opportunity) {
      return notFound('Opportunity not found');
    }

    // validate request body
    if (!context.data) {
      return badRequest('No updates provided');
    }

    if (!isArray(context.data)) {
      return badRequest('request body must be an array of [{ suggestionId, status },...]');
    }
    let hasUpdates = false;
    const errors = [];
    const suggestions = context.data.map(async ({ id, status }) => {
      if (!hasText(id)) {
        errors.push('suggestionId is required');
        return null;
      }
      if (!hasText(status)) {
        errors.push('status is required');
        return null;
      }

      const suggestion = await dataAccess.getSuggestionById(siteId, opportunityId, id);
      if (!suggestion) {
        errors.push(`Suggestion ${id} not found`);
        return null;
      }

      if (suggestion.status !== status) {
        hasUpdates = true;
        suggestion.setStatus(status);
      }
      return suggestion;
    }).filter((sugg) => sugg);

    // TODO: if errors? update data and return 200 or fail the whole transaction?
    if (hasUpdates) {
      await dataAccess.updateSuggestions(suggestions);
      return ok(suggestions.map((sugg) => SuggestionDto.toJSON(sugg)));
    }
    if (suggestions.length === 0 && errors.length > 0) {
      return badRequest(errors.join(', '));
    }
    return badRequest('No updates provided');
  };

  return {
    getAllForOpportunity,
    getByStatus,
    getByID,
    createSuggestions,
    patchSuggestion,
    patchSuggestionsStatus,
  };
}

export default SuggestionsController;
