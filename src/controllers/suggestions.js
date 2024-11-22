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
  isObject,
} from '@adobe/spacecat-shared-utils';

import { ValidationError } from '@adobe/spacecat-shared-data-access';
import { SuggestionDto } from '../dto/suggestion.js';

/**
 * Suggestions controller.
 * @param {DataAccess} dataAccess - Data access.
 * @returns {object} Suggestions controller.
 * @constructor
 */
function SuggestionsController(dataAccess) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }
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

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(opptyId)) {
      return badRequest('Opportunity ID required');
    }

    const suggestionEntities = await Suggestion.allByOpportunityId(opptyId);
    // Check if the opportunity belongs to the site
    if (suggestionEntities.length > 0) {
      const oppty = await suggestionEntities[0].getOpportunity();
      if (oppty.getSiteId() !== siteId) {
        return badRequest('Opportunity not found');
      }
    }
    const suggestions = suggestionEntities.map((sugg) => SuggestionDto.toJSON(sugg));
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
    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }
    if (!hasText(opptyId)) {
      return badRequest('Opportunity ID required');
    }
    if (!hasText(status)) {
      return badRequest('Status is required');
    }

    const suggestionEntities = await Suggestion.allByOpportunityIdAndStatus(opptyId, status);
    // Check if the opportunity belongs to the site
    if (suggestionEntities.length > 0) {
      const oppty = await suggestionEntities[0].getOpportunity();
      if (oppty.getSiteId() !== siteId) {
        return badRequest('Opportunity not found');
      }
    }
    const suggestions = suggestionEntities.map((sugg) => SuggestionDto.toJSON(sugg));
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
      return badRequest('Suggestion ID required');
    }

    const sugg = await Suggestion.findById(suggestionId);
    if (!sugg || sugg.getOpportunityId() !== opptyId
       || (await sugg.getOpportunity()).getSiteId() !== siteId) {
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
      return badRequest('Request body must be an array');
    }

    const suggestionPromises = context.data.map(async (suggData, index) => {
      try {
        const suggestionEntity = await Suggestion.create(suggData);
        return {
          index,
          suggestion: SuggestionDto.toJSON(suggestionEntity),
          statusCode: 201,
        };
      } catch (error) {
        return {
          index,
          message: error.message,
          statusCode: error instanceof ValidationError ? 400 : 500,
        };
      }
    });

    const responses = await Promise.all(suggestionPromises);
    // Sort the results by the index of the suggestion in the request
    responses.sort((a, b) => a.index - b.index);
    const succeded = responses.filter((r) => r.statusCode === 201).length;
    const fullResponse = {
      suggestions: responses,
      metadata: {
        total: responses.length,
        success: succeded,
        failed: responses.length - succeded,
      },
    };

    return createResponse(fullResponse, 207);
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

    const suggestion = await Suggestion.findById(suggestionId);
    if (!suggestion || suggestion.getOpportunityId() !== opportunityId
       || (await suggestion.getOpportunity()).getSiteId() !== siteId) {
      return notFound('Suggestion not found');
    }

    // validate request body
    if (!context.data) {
      return badRequest('No updates provided');
    }

    let hasUpdates = false;
    const { rank, data, kpiDeltas } = context.data;
    try {
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
        const updatedSuggestion = await suggestion.save();
        return ok(SuggestionDto.toJSON(updatedSuggestion));
      }
    } catch (e) {
      return badRequest(e.message);
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

    // validate request body
    if (!context.data) {
      return badRequest('No updates provided');
    }

    if (!isArray(context.data)) {
      return badRequest('Request body must be an array of [{ suggestionId, status },...]');
    }

    const suggestionPromises = context.data.map(async ({ id, status }, index) => {
      if (!hasText(id)) {
        return {
          index,
          uuid: '',
          message: 'suggestionId is required',
          statusCode: 400,
        };
      }
      if (!hasText(status)) {
        return {
          index,
          uuid: id,
          message: 'status is required',
          statusCode: 400,
        };
      }

      const suggestion = await Suggestion.findById(id);
      if (!suggestion || suggestion.getOpportunityId() !== opportunityId
         || (await suggestion.getOpportunity()).getSiteId() !== siteId) {
        return {
          index,
          uuid: id,
          message: 'Suggestion not found',
          statusCode: 404,
        };
      }

      try {
        if (suggestion.getStatus() !== status) {
          suggestion.setStatus(status);
        } else {
          return {
            index,
            uuid: id,
            message: 'No updates provided',
            statusCode: 400,
          };
        }
      } catch (e) {
        // Validation error on setStatus
        return {
          index,
          uuid: id,
          message: e.message,
          statusCode: 400,
        };
      }
      try {
        const updatedSuggestion = await suggestion.save();
        return {
          index,
          uuid: id,
          suggestion: SuggestionDto.toJSON(updatedSuggestion),
          statusCode: 200,
        };
      } catch (error) {
        return {
          index,
          message: error.message,
          statusCode: error instanceof ValidationError ? 400 : 500,
        };
      }
    });

    const responses = await Promise.all(suggestionPromises);
    // Sort the results by the index of the suggestion in the request
    responses.sort((a, b) => a.index - b.index);
    const succeded = responses.filter((r) => r.statusCode === 200).length;
    const fullResponse = {
      suggestions: responses,
      metadata: {
        total: responses.length,
        success: succeded,
        failed: responses.length - succeded,
      },
    };
    return createResponse(fullResponse, 207);
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
