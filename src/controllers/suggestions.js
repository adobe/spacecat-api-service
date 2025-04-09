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
  createResponse,
  noContent,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isArray, isNonEmptyArray,
  isNonEmptyObject,
  isObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { ValidationError, Suggestion as SuggestionModel, Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import { SuggestionDto } from '../dto/suggestion.js';
import { sendAutofixMessage, getCSPromiseToken, ErrorWithStatusCode } from '../support/utils.js';

/**
 * Suggestions controller.
 * @param {DataAccess} dataAccess - Data access.
 * @param {SQS} sqs - SQS client.
 * @returns {object} Suggestions controller.
 * @constructor
 */
function SuggestionsController(dataAccess, sqs, env) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const {
    Opportunity, Suggestion, Site, Configuration,
  } = dataAccess;

  if (!isObject(Opportunity)) {
    throw new Error('Data access required');
  }

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

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opptyId)) {
      return badRequest('Opportunity ID required');
    }

    const suggestionEntities = await Suggestion.allByOpportunityId(opptyId);
    // Check if the opportunity belongs to the site
    if (suggestionEntities.length > 0) {
      const oppty = await suggestionEntities[0].getOpportunity();
      if (!oppty || oppty.getSiteId() !== siteId) {
        return notFound('Opportunity not found');
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
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(opptyId)) {
      return badRequest('Opportunity ID required');
    }
    if (!hasText(status)) {
      return badRequest('Status is required');
    }

    const suggestionEntities = await Suggestion.allByOpportunityIdAndStatus(opptyId, status);
    // Check if the opportunity belongs to the site
    if (suggestionEntities.length > 0) {
      const oppty = await suggestionEntities[0].getOpportunity();
      if (!oppty || oppty.getSiteId() !== siteId) {
        return notFound('Opportunity not found');
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

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opptyId)) {
      return badRequest('Opportunity ID required');
    }

    if (!isValidUUID(suggestionId)) {
      return badRequest('Suggestion ID required');
    }

    const suggestion = await Suggestion.findById(suggestionId);
    if (!suggestion || suggestion.getOpportunityId() !== opptyId) {
      return notFound('Suggestion not found');
    }
    const opportunity = await suggestion.getOpportunity();
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound();
    }
    return ok(SuggestionDto.toJSON(suggestion));
  };

  /**
   * Creates one or more suggestions for a given site and opportunity
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of suggestions response.
   */
  const createSuggestions = async (context) => {
    const siteId = context.params?.siteId;
    const opptyId = context.params?.opportunityId || undefined;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opptyId)) {
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
        // eslint-disable-next-line no-param-reassign
        suggData.opportunityId = opptyId;
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

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    if (!isValidUUID(suggestionId)) {
      return badRequest('Suggestion ID required');
    }

    const suggestion = await Suggestion.findById(suggestionId);
    if (!suggestion || suggestion.getOpportunityId() !== opportunityId) {
      return notFound('Suggestion not found');
    }
    const opportunity = await suggestion.getOpportunity();
    if (!opportunity || opportunity.getSiteId() !== siteId) {
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
      if (e instanceof ValidationError) {
        return badRequest(e.message);
      }
      return createResponse({ message: 'Error updating suggestion' }, 500);
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

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    // validate request body
    if (!context.data) {
      return badRequest('No updates provided');
    }

    if (!isArray(context.data)) {
      return badRequest('Request body must be an array of [{ id: <suggestion id>, status: <suggestion status> },...]');
    }

    const suggestionPromises = context.data.map(async ({ id, status }, index) => {
      if (!hasText(id)) {
        return {
          index,
          uuid: '',
          message: 'suggestion id is required',
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
      if (!suggestion || suggestion.getOpportunityId() !== opportunityId) {
        return {
          index,
          uuid: id,
          message: 'Suggestion not found',
          statusCode: 404,
        };
      }
      const opportunity = await suggestion.getOpportunity();
      if (!opportunity || opportunity.getSiteId() !== siteId) {
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
  const autofixSuggestions = async (context) => {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    // validate request body
    if (!isNonEmptyObject(context.data)) {
      return badRequest('No updates provided');
    }
    const { suggestionIds } = context.data;
    if (!isArray(suggestionIds)) {
      return badRequest('Request body must be an array of suggestionIds');
    }
    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }
    const configuration = await Configuration.findLatest();
    if (!configuration.isHandlerEnabledForSite(`${opportunity.getType()}-auto-fix`, site)) {
      return badRequest(`Handler is not enabled for site ${site.getId()} autofix type ${opportunity.getType()}`);
    }
    const suggestions = await Suggestion.allByOpportunityId(
      opportunityId,
    );
    const validSuggestions = [];
    const failedSuggestions = [];
    suggestions.forEach((suggestion) => {
      if (suggestionIds.includes(suggestion.getId())) {
        if (suggestion.getStatus() === SuggestionModel.STATUSES.NEW) {
          validSuggestions.push(suggestion);
        } else {
          failedSuggestions.push({
            uuid: suggestion.getId(),
            index: suggestionIds.indexOf(suggestion.getId()),
            message: 'Suggestion is not in NEW status',
            statusCode: 400,
          });
        }
      }
    });
    suggestionIds.forEach((suggestionId, index) => {
      if (!suggestions.find((s) => s.getId() === suggestionId)) {
        failedSuggestions.push({
          uuid: suggestionId,
          index,
          message: 'Suggestion not found',
          statusCode: 404,
        });
      }
    });
    let succeededSuggestions = [];
    if (isNonEmptyArray(validSuggestions)) {
      succeededSuggestions = await Suggestion.bulkUpdateStatus(
        validSuggestions,
        SuggestionModel.STATUSES.IN_PROGRESS,
      );
    }

    let promiseTokenResponse;
    if (site.getDeliveryType() === SiteModel.DELIVERY_TYPES.AEM_CS) {
      try {
        promiseTokenResponse = await getCSPromiseToken(context);
      } catch (e) {
        if (e instanceof ErrorWithStatusCode) {
          return badRequest(e.message);
        }
        return createResponse({ message: 'Error getting promise token' }, 500);
      }
    }

    const response = {
      suggestions: [
        ...succeededSuggestions.map((suggestion) => ({
          uuid: suggestion.getId(),
          index: suggestionIds.indexOf(suggestion.getId()),
          statusCode: 200,
          suggestion: SuggestionDto.toJSON(suggestion),
        })),
        ...failedSuggestions,
      ],
      metadata: {
        total: suggestionIds.length,
        success: succeededSuggestions.length,
        failed: failedSuggestions.length,
      },
    };
    response.suggestions.sort((a, b) => a.index - b.index);
    const { AUTOFIX_JOBS_QUEUE: queueUrl } = env;
    await sendAutofixMessage(
      sqs,
      queueUrl,
      opportunityId,
      siteId,
      succeededSuggestions.map((s) => s.getId()),
      promiseTokenResponse,
    );
    return createResponse(response, 207);
  };

  const removeSuggestion = async (context) => {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;
    const suggestionId = context.params?.suggestionId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    if (!isValidUUID(suggestionId)) {
      return badRequest('Suggestion ID required');
    }

    const opportunity = await Opportunity.findById(opportunityId);

    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    const suggestion = await Suggestion.findById(suggestionId);

    if (!suggestion || suggestion.getOpportunityId() !== opportunityId) {
      return notFound('Suggestion not found');
    }

    try {
      await suggestion.remove();
      return noContent();
    } catch (e) {
      return createResponse({ message: 'Error removing suggestion' }, 500);
    }
  };

  return {
    autofixSuggestions,
    createSuggestions,
    getAllForOpportunity,
    getByID,
    getByStatus,
    patchSuggestion,
    patchSuggestionsStatus,
    removeSuggestion,
  };
}

export default SuggestionsController;
