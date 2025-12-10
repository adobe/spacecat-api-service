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
  forbidden,
  noContent,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isArray, isNonEmptyArray,
  isNonEmptyObject,
  isObject,
  isInteger,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { ValidationError, Suggestion as SuggestionModel } from '@adobe/spacecat-shared-data-access';
import TokowakaClient from '@adobe/spacecat-shared-tokowaka-client';
import { SuggestionDto } from '../dto/suggestion.js';
import { FixDto } from '../dto/fix.js';
import { sendAutofixMessage, getIMSPromiseToken, ErrorWithStatusCode } from '../support/utils.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * Suggestions controller.
 * @param {object} ctx - Context of the request.
 * @param {SQS} sqs - SQS client.
 * @param env
 * @returns {object} Suggestions controller.
 * @constructor
 */
function SuggestionsController(ctx, sqs, env) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const AUTOFIX_UNGROUPED_OPPTY_TYPES = [
    'broken-backlinks',
    'form-accessibility',
    'product-metatags',
    'security-permissions-redundant',
  ];

  const DEFAULT_PAGE_SIZE = 100;

  const shouldGroupSuggestionsForAutofix = (type) => !AUTOFIX_UNGROUPED_OPPTY_TYPES.includes(type);

  /**
   * Checks if a suggestion is a domain-wide auto generated suggestion
   * @param {Object} suggestion - Suggestion entity
   * @returns {boolean} - True if suggestion is a domain-wide aggregate suggestion
   */
  const isDomainWideSuggestion = (suggestion) => {
    const data = suggestion.getData();
    // Support both for backwards compatibility
    return data?.isDomainWide === true;
  };

  const {
    Opportunity, Suggestion, Site, Configuration,
  } = dataAccess;

  if (!isObject(Opportunity)) {
    throw new Error('Data access required');
  }

  if (!isObject(Suggestion)) {
    throw new Error('Data access required');
  }

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

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

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
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
   * Gets a page of suggestions for a given site and opportunity
   * @param {Object} context of the request
   * @param {number} context.params.limit - Number of suggestions per page. Default=100.
   * @param {number} context.params.cursor - The next cursor or null for first page.
   * @returns {Promise<Response>} Array of suggestions response.
   */
  const getAllForOpportunityPaged = async (context) => {
    const siteId = context.params?.siteId;
    const opptyId = context.params?.opportunityId;
    const limit = parseInt(context.params?.limit, 10) || DEFAULT_PAGE_SIZE;
    const cursor = context.params?.cursor || null;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opptyId)) {
      return badRequest('Opportunity ID required');
    }

    if (!isInteger(limit) || limit < 1) {
      return badRequest('Page size must be greater than 0');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
    }

    const results = await Suggestion
      .allByOpportunityId(opptyId, {
        limit,
        cursor,
        returnCursor: true,
      });
    const { data: suggestionEntities = [], cursor: newCursor = null } = results;

    // Check if the opportunity belongs to the site
    if (suggestionEntities.length > 0) {
      const oppty = await suggestionEntities[0].getOpportunity();
      if (!oppty || oppty.getSiteId() !== siteId) {
        return notFound('Opportunity not found');
      }
    }

    const suggestions = suggestionEntities.map((sugg) => SuggestionDto.toJSON(sugg));

    return ok({
      suggestions,
      pagination: {
        limit,
        cursor: newCursor ?? null,
        hasMore: !!newCursor,
      },
    });
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

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
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
     * Gets all suggestions for a given site, opportunity and status
     * @param {Object} context of the request
     * @returns {Promise<Response>} Array of suggestions response.
     */
  const getByStatusPaged = async (context) => {
    const siteId = context.params?.siteId;
    const opptyId = context.params?.opportunityId;
    const status = context.params?.status || undefined;
    const limit = parseInt(context.params?.limit, 10) || DEFAULT_PAGE_SIZE;
    const cursor = context.params?.cursor || null;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(opptyId)) {
      return badRequest('Opportunity ID required');
    }
    if (!hasText(status)) {
      return badRequest('Status is required');
    }

    if (!isInteger(limit) || limit < 1) {
      return badRequest('Page size must be greater than 0');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
    }

    const results = await Suggestion.allByOpportunityIdAndStatus(opptyId, status, {
      limit,
      cursor,
      returnCursor: true,
    });
    const { data: suggestionEntities = [], cursor: newCursor = null } = results;
    // Check if the opportunity belongs to the site
    if (suggestionEntities.length > 0) {
      const oppty = await suggestionEntities[0].getOpportunity();
      if (!oppty || oppty.getSiteId() !== siteId) {
        return notFound('Opportunity not found');
      }
    }
    const suggestions = suggestionEntities.map((sugg) => SuggestionDto.toJSON(sugg));
    return ok({
      suggestions,
      pagination: {
        limit,
        cursor: newCursor ?? null,
        hasMore: !!newCursor,
      },
    });
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

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
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

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
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
    const { authInfo: { profile } } = context.attributes;
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opportunityId)) {
      return badRequest('Opportunity ID required');
    }

    if (!isValidUUID(suggestionId)) {
      return badRequest('Suggestion ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
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
        suggestion.setUpdatedBy(profile.email || 'system');
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
   * Gets all fixes for a given suggestion
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of fixes response.
   */
  const getSuggestionFixes = async (context) => {
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

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not belong to the organization');
      }

      const fixes = await Suggestion.getFixEntitiesBySuggestionId(suggestionId);
      return ok({ data: fixes.map((fix) => FixDto.toJSON(fix)) });
    } catch (error) {
      return createResponse({ message: 'Error retrieving fixes for suggestion' }, 500);
    }
  };

  /**
   * Update the status of one or multiple suggestions in one transaction
   * @param {Object} context of the request
   * @returns {Promise<Response>} the updated opportunity data
   */
  const patchSuggestionsStatus = async (context) => {
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;
    const { authInfo: { profile } } = context.attributes;

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
      return forbidden('User does not belong to the organization');
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
          suggestion.setUpdatedBy(profile.email);
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
    const {
      suggestionIds, variations, action, customData,
    } = context.data;

    if (!isArray(suggestionIds)) {
      return badRequest('Request body must be an array of suggestionIds');
    }
    if (variations && !isArray(variations)) {
      return badRequest('variations must be an array');
    }
    if (action !== undefined && !hasText(action)) {
      return badRequest('action cannot be empty');
    }
    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site, 'auto_fix')) {
      return forbidden('User does not belong to the organization or does not have sufficient permissions');
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
        // Filter out domain-wide suggestions from autofix
        if (isDomainWideSuggestion(suggestion)) {
          failedSuggestions.push({
            uuid: suggestion.getId(),
            index: suggestionIds.indexOf(suggestion.getId()),
            message: 'Domain-wide aggregate suggestions cannot be auto-fixed individually',
            statusCode: 400,
          });
        } else if (suggestion.getStatus() === SuggestionModel.STATUSES.NEW) {
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

    let suggestionGroups;
    if (shouldGroupSuggestionsForAutofix(opportunity.getType())) {
      const opportunityData = opportunity.getData();
      const suggestionsByUrl = validSuggestions.reduce((acc, suggestion) => {
        const data = suggestion.getData();
        const url = data?.url || data?.recommendations?.[0]?.pageUrl
          || data?.url_from
          || data?.urlFrom
          || opportunityData?.page; // for high-organic-low-ctr
        if (!url) return acc;

        if (!acc[url]) {
          acc[url] = [];
        }
        acc[url].push(suggestion);
        return acc;
      }, {});

      suggestionGroups = Object.entries(suggestionsByUrl).map(([url, groupedSuggestions]) => ({
        groupedSuggestions,
        url,
      }));
    }

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
    try {
      promiseTokenResponse = await getIMSPromiseToken(context);
    } catch (e) {
      if (e instanceof ErrorWithStatusCode) {
        return badRequest(e.message);
      }
      return createResponse({ message: 'Error getting promise token' }, 500);
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

    if (shouldGroupSuggestionsForAutofix(opportunity.getType())) {
      await Promise.all(
        suggestionGroups.map(({ groupedSuggestions, url }) => sendAutofixMessage(
          sqs,
          queueUrl,
          siteId,
          opportunityId,
          groupedSuggestions.map((s) => s.getId()),
          promiseTokenResponse,
          variations,
          action,
          customData,
          { url },
        )),
      );
    } else {
      await sendAutofixMessage(
        sqs,
        queueUrl,
        siteId,
        opportunityId,
        succeededSuggestions.map((s) => s.getId()),
        promiseTokenResponse,
        variations,
        action,
        customData,
      );
    }

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

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
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

  /**
   * Previews suggestions through Tokowaka edge delivery
   * Returns both original and optimized HTML for comparison
   * @param {Object} context of the request
   * @returns {Promise<Response>} Preview response with HTML comparison
   */
  const previewSuggestions = async (context) => {
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
      return badRequest('No data provided');
    }
    const { suggestionIds } = context.data;
    if (!isArray(suggestionIds) || suggestionIds.length === 0) {
      return badRequest('Request body must contain a non-empty array of suggestionIds');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    // Fetch all suggestions for this opportunity
    const allSuggestions = await Suggestion.allByOpportunityId(opportunityId);

    // Track valid, failed, and missing suggestions
    const validSuggestions = [];
    const failedSuggestions = [];

    // Check each requested suggestion (basic validation only)
    suggestionIds.forEach((suggestionId, index) => {
      const suggestion = allSuggestions.find((s) => s.getId() === suggestionId);

      if (!suggestion) {
        failedSuggestions.push({
          uuid: suggestionId,
          index,
          message: 'Suggestion not found',
          statusCode: 404,
        });
      } else if (isDomainWideSuggestion(suggestion)) {
        // Filter out domain-wide suggestions from preview
        failedSuggestions.push({
          uuid: suggestionId,
          index,
          message: 'Domain-wide aggregate suggestions cannot be previewed individually',
          statusCode: 400,
        });
      } else if (suggestion.getStatus() !== SuggestionModel.STATUSES.NEW) {
        failedSuggestions.push({
          uuid: suggestionId,
          index,
          message: 'Suggestion is not in NEW status',
          statusCode: 400,
        });
      } else {
        validSuggestions.push(suggestion);
      }
    });

    // Validate that all suggestions belong to the same URL
    if (isNonEmptyArray(validSuggestions)) {
      const urls = new Set();
      validSuggestions.forEach((suggestion) => {
        const url = suggestion.getData()?.url || suggestion.getData()?.pageUrl;
        if (url) {
          urls.add(url);
        }
      });

      if (urls.size > 1) {
        return badRequest('All suggestions must belong to the same URL for preview');
      }

      if (urls.size === 0) {
        return badRequest('No valid URLs found in suggestions');
      }
    }

    let succeededSuggestions = [];
    let previewUrl = null;
    let originalHtml = null;
    let optimizedHtml = null;

    // Only attempt preview if we have valid suggestions
    if (isNonEmptyArray(validSuggestions)) {
      try {
        const tokowakaClient = TokowakaClient.createFrom(context);
        const previewResult = await tokowakaClient.previewSuggestions(
          site,
          opportunity,
          validSuggestions,
        );

        // Process preview results
        const {
          succeededSuggestions: previewedSuggestions,
          failedSuggestions: ineligibleSuggestions,
          html: htmlResult,
        } = previewResult;

        succeededSuggestions = previewedSuggestions;

        // Add ineligible suggestions to failed list
        ineligibleSuggestions.forEach((item) => {
          failedSuggestions.push({
            uuid: item.suggestion.getId(),
            index: suggestionIds.indexOf(item.suggestion.getId()),
            message: item.reason,
            statusCode: 400,
          });
        });

        // Get HTML data from preview result
        if (htmlResult) {
          previewUrl = htmlResult.url;
          originalHtml = htmlResult.originalHtml;
          optimizedHtml = htmlResult.optimizedHtml;
        }

        context.log.info(`Successfully previewed ${succeededSuggestions.length} suggestions`);
      } catch (error) {
        context.log.error(`Error generating preview: ${error.message}`, error);
        // If preview fails, mark all valid suggestions as failed
        validSuggestions.forEach((suggestion) => {
          failedSuggestions.push({
            uuid: suggestion.getId(),
            index: suggestionIds.indexOf(suggestion.getId()),
            message: 'Preview generation failed: Internal server error',
            statusCode: 500,
          });
        });
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
      html: {
        url: previewUrl,
        originalHtml,
        optimizedHtml,
      },
    };
    response.suggestions.sort((a, b) => a.index - b.index);

    return createResponse(response, 207);
  };

  /**
   * Deploys suggestions through Tokowaka edge delivery
   * @param {Object} context of the request
   * @returns {Promise<Response>} Deployment response
   */
  const deploySuggestionToEdge = async (context) => {
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
      return badRequest('No data provided');
    }
    const { suggestionIds } = context.data;
    if (!isArray(suggestionIds) || suggestionIds.length === 0) {
      return badRequest('Request body must contain a non-empty array of suggestionIds');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    // Fetch all suggestions for this opportunity
    const allSuggestions = await Suggestion.allByOpportunityId(opportunityId);

    // Track valid, failed, and missing suggestions
    const validSuggestions = [];
    const domainWideSuggestions = [];
    const failedSuggestions = [];
    let coveredSuggestionsCount = 0;

    // Check each requested suggestion (basic validation only)
    suggestionIds.forEach((suggestionId, index) => {
      const suggestion = allSuggestions.find((s) => s.getId() === suggestionId);

      if (!suggestion) {
        failedSuggestions.push({
          uuid: suggestionId,
          index,
          message: 'Suggestion not found',
          statusCode: 404,
        });
      } else if (isDomainWideSuggestion(suggestion)) {
        const data = suggestion.getData();
        if (isNonEmptyArray(data.allowedRegexPatterns)) {
          domainWideSuggestions.push({
            suggestion,
            allowedRegexPatterns: data.allowedRegexPatterns,
          });
        } else {
          failedSuggestions.push({
            uuid: suggestionId,
            index,
            message: 'Domain-wide suggestion missing allowedRegexPatterns',
            statusCode: 400,
          });
        }
      } else if (suggestion.getStatus() !== SuggestionModel.STATUSES.NEW) {
        failedSuggestions.push({
          uuid: suggestionId,
          index,
          message: 'Suggestion is not in NEW status',
          statusCode: 400,
        });
      } else {
        validSuggestions.push(suggestion);
      }
    });

    // Filter out validSuggestions that are covered by domain-wide suggestions
    // in the same deployment
    if (isNonEmptyArray(domainWideSuggestions) && isNonEmptyArray(validSuggestions)) {
      // Build all regex patterns from domain-wide suggestions
      const allDomainWidePatterns = [];
      domainWideSuggestions.forEach(({ allowedRegexPatterns }) => {
        if (isNonEmptyArray(allowedRegexPatterns)) {
          allowedRegexPatterns.forEach((pattern) => {
            try {
              allDomainWidePatterns.push(new RegExp(pattern));
            } catch (error) {
              context.log.warn(`Invalid regex pattern: ${pattern}`, error);
            }
          });
        }
      });

      // Filter validSuggestions to exclude those covered by domain-wide patterns
      const filteredValidSuggestions = [];
      const skippedSuggestions = [];

      validSuggestions.forEach((suggestion) => {
        const url = suggestion.getData()?.url;
        if (!url) {
          // No URL, can't check coverage - keep it
          filteredValidSuggestions.push(suggestion);
          return;
        }

        // Check if this URL is covered by any domain-wide pattern
        const isCovered = allDomainWidePatterns.some((regex) => regex.test(url));

        if (isCovered) {
          // Skip this suggestion - it's covered by domain-wide
          skippedSuggestions.push({
            uuid: suggestion.getId(),
            index: suggestionIds.indexOf(suggestion.getId()),
            message: 'Skipped: URL is covered by domain-wide suggestion in this deployment',
            statusCode: 200,
            suggestion: SuggestionDto.toJSON(suggestion),
          });
          context.log.info(`Skipping suggestion ${suggestion.getId()} - covered by domain-wide pattern`);
        } else {
          // Not covered, include in deployment
          filteredValidSuggestions.push(suggestion);
        }
      });

      // Update validSuggestions to the filtered list
      validSuggestions.length = 0;
      validSuggestions.push(...filteredValidSuggestions);

      // Add skipped suggestions to a tracking array (we'll mark them later)
      if (isNonEmptyArray(skippedSuggestions)) {
        // Store for later processing after domain-wide deployment
        context.skippedDueToSameBatchDomainWide = skippedSuggestions;
        context.log.info(`Filtered out ${skippedSuggestions.length} suggestions covered by domain-wide in same deployment`);
      }
    }

    let succeededSuggestions = [];

    // Only attempt deployment if we have valid suggestions
    if (isNonEmptyArray(validSuggestions)) {
      try {
        const tokowakaClient = TokowakaClient.createFrom(context);
        const deploymentResult = await tokowakaClient.deploySuggestions(
          site,
          opportunity,
          validSuggestions,
        );

        // Process deployment results
        const {
          succeededSuggestions: deployedSuggestions,
          failedSuggestions: ineligibleSuggestions,
        } = deploymentResult;

        // Update successfully deployed suggestions with deployment timestamp
        const deploymentTimestamp = Date.now();
        succeededSuggestions = await Promise.all(
          deployedSuggestions.map(async (suggestion) => {
            const currentData = suggestion.getData();
            suggestion.setData({
              ...currentData,
              tokowakaDeployed: deploymentTimestamp,
            });
            suggestion.setUpdatedBy('tokowaka-deployment');
            return suggestion.save();
          }),
        );

        // Add ineligible suggestions to failed list
        ineligibleSuggestions.forEach((item) => {
          failedSuggestions.push({
            uuid: item.suggestion.getId(),
            index: suggestionIds.indexOf(item.suggestion.getId()),
            message: item.reason,
            statusCode: 400,
          });
        });

        context.log.info(`Successfully deployed ${succeededSuggestions.length} suggestions to Edge`);
      } catch (error) {
        context.log.error(`Error deploying to Tokowaka: ${error.message}`, error);
        // If deployment fails, mark all valid suggestions as failed
        validSuggestions.forEach((suggestion) => {
          failedSuggestions.push({
            uuid: suggestion.getId(),
            index: suggestionIds.indexOf(suggestion.getId()),
            message: 'Deployment failed: Internal server error',
            statusCode: 500,
          });
        });
      }
    }

    // Handle domain-wide suggestions separately
    if (isNonEmptyArray(domainWideSuggestions)) {
      try {
        const tokowakaClient = TokowakaClient.createFrom(context);
        const baseURL = site.getBaseURL();

        // Deploy each domain-wide suggestion
        // eslint-disable-next-line no-await-in-loop
        for (const { suggestion, allowedRegexPatterns } of domainWideSuggestions) {
          try {
            // Fetch existing metaconfig or create new one
            // eslint-disable-next-line no-await-in-loop
            let metaconfig = await tokowakaClient.fetchMetaconfig(baseURL);

            if (!metaconfig) {
              metaconfig = {
                siteId: site.getId(),
              };
            }

            // Update ONLY the prerender property, preserving all other properties
            // Expected structure: { prerender: { allowList: ["/*", "/path/*"] } }
            metaconfig.prerender = {
              allowList: allowedRegexPatterns,
            };

            const suggestionId = suggestion.getId();
            context.log.info(
              `Updating metaconfig for domain-wide prerender suggestion ${suggestionId}`,
            );

            // Upload updated metaconfig
            // eslint-disable-next-line no-await-in-loop
            await tokowakaClient.uploadMetaconfig(baseURL, metaconfig);

            // Update suggestion with deployment timestamp
            const deploymentTimestamp = Date.now();
            const currentData = suggestion.getData();
            suggestion.setData({
              ...currentData,
              tokowakaDeployed: deploymentTimestamp,
            });
            suggestion.setUpdatedBy('tokowaka-deployment');
            // eslint-disable-next-line no-await-in-loop
            await suggestion.save();

            succeededSuggestions.push(suggestion);
            context.log.info(`Successfully deployed domain-wide suggestion ${suggestionId}`);

            // Mark all other NEW suggestions that match allowedRegexPatterns
            try {
              // Get IDs of suggestions skipped in this batch
              const skippedInBatchIds = new Set(
                (context.skippedDueToSameBatchDomainWide || []).map((s) => s.uuid),
              );

              const regexPatterns = allowedRegexPatterns.map(
                (pattern) => new RegExp(pattern),
              );
              const coveredSuggestions = allSuggestions.filter((s) => {
                // Skip the domain-wide suggestion itself
                if (s.getId() === suggestion.getId()) {
                  return false;
                }

                // Skip suggestions that were already filtered out in this batch
                if (skippedInBatchIds.has(s.getId())) {
                  return false;
                }

                // Only process NEW suggestions
                if (s.getStatus() !== SuggestionModel.STATUSES.NEW) {
                  return false;
                }

                // Skip other domain-wide suggestions
                if (isDomainWideSuggestion(s)) {
                  return false;
                }

                // Check if URL matches any of the allowed regex patterns
                const url = s.getData()?.url;
                if (!url) {
                  return false;
                }

                return regexPatterns.some((regex) => regex.test(url));
              });

              // Mark covered suggestions as deployed
              if (isNonEmptyArray(coveredSuggestions)) {
                const coverMsg = `Marking ${coveredSuggestions.length} suggestions `
                  + 'as covered by domain-wide deployment';
                context.log.info(coverMsg);

                // eslint-disable-next-line no-await-in-loop
                await Promise.all(
                  coveredSuggestions.map(async (coveredSuggestion) => {
                    const coveredData = coveredSuggestion.getData();
                    coveredSuggestion.setData({
                      ...coveredData,
                      tokowakaDeployed: deploymentTimestamp,
                      coveredByDomainWide: suggestion.getId(),
                    });
                    coveredSuggestion.setUpdatedBy('domain-wide-deployment');
                    return coveredSuggestion.save();
                  }),
                );

                coveredSuggestionsCount += coveredSuggestions.length;
                const successMsg = `Successfully marked ${coveredSuggestions.length} `
                  + 'suggestions as covered';
                context.log.info(successMsg);
              }
            } catch (coverError) {
              context.log.error(`Error marking covered suggestions: ${coverError.message}`, coverError);
              // Don't fail the deployment if marking covered suggestions fails
            }
          } catch (error) {
            context.log.error(`Error deploying domain-wide suggestion ${suggestion.getId()}: ${error.message}`, error);
            failedSuggestions.push({
              uuid: suggestion.getId(),
              index: suggestionIds.indexOf(suggestion.getId()),
              message: `Deployment failed: ${error.message}`,
              statusCode: 500,
            });
          }
        }
      } catch (error) {
        context.log.error(`Error deploying domain-wide suggestions: ${error.message}`, error);
        // Mark all domain-wide suggestions as failed
        domainWideSuggestions.forEach(({ suggestion }) => {
          failedSuggestions.push({
            uuid: suggestion.getId(),
            index: suggestionIds.indexOf(suggestion.getId()),
            message: 'Deployment failed: Internal server error',
            statusCode: 500,
          });
        });
      }
    }

    // Mark suggestions skipped due to domain-wide coverage in same deployment
    const skippedDomainWide = context.skippedDueToSameBatchDomainWide;
    if (skippedDomainWide && isNonEmptyArray(skippedDomainWide)) {
      try {
        const deploymentTimestamp = Date.now();
        const skippedUUIDs = skippedDomainWide.map((s) => s.uuid);

        // Fetch and update all skipped suggestions
        const skippedSuggestionEntities = allSuggestions.filter(
          (s) => skippedUUIDs.includes(s.getId()),
        );

        await Promise.all(
          skippedSuggestionEntities.map(async (skippedSuggestion) => {
            const currentData = skippedSuggestion.getData();
            skippedSuggestion.setData({
              ...currentData,
              tokowakaDeployed: deploymentTimestamp,
              coveredByDomainWide: 'same-batch-deployment',
              skippedInDeployment: true,
            });
            skippedSuggestion.setUpdatedBy('domain-wide-deployment');
            return skippedSuggestion.save();
          }),
        );

        coveredSuggestionsCount += skippedSuggestionEntities.length;
        const skipMsg = `Marked ${skippedSuggestionEntities.length} `
          + 'skipped suggestions as covered';
        context.log.info(skipMsg);

        // Add to succeeded suggestions list for response
        succeededSuggestions.push(...skippedSuggestionEntities);
      } catch (error) {
        context.log.error(`Error marking skipped suggestions: ${error.message}`, error);
        // Add to failed if we couldn't mark them
        context.skippedDueToSameBatchDomainWide.forEach((skipped) => {
          failedSuggestions.push({
            uuid: skipped.uuid,
            index: skipped.index,
            message: 'Failed to mark as covered by domain-wide',
            statusCode: 500,
          });
        });
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
        ...(coveredSuggestionsCount > 0 && {
          autoCovered: coveredSuggestionsCount,
          message: `${coveredSuggestionsCount} additional suggestion(s) automatically marked as deployed (covered by domain-wide configuration)`,
        }),
      },
    };
    response.suggestions.sort((a, b) => a.index - b.index);

    return createResponse(response, 207);
  };

  const rollbackSuggestionFromEdge = async (context) => {
    const { siteId, opportunityId } = context.params;
    if (!isNonEmptyObject(context.data)) {
      return badRequest('No data provided');
    }
    const { suggestionIds } = context.data;
    if (!isArray(suggestionIds) || suggestionIds.length === 0) {
      return badRequest('Request body must contain a non-empty array of suggestionIds');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    // Fetch all suggestions for this opportunity
    const allSuggestions = await Suggestion.allByOpportunityId(opportunityId);

    // Track valid, failed, and missing suggestions
    const validSuggestions = [];
    const failedSuggestions = [];

    // Check each requested suggestion
    suggestionIds.forEach((suggestionId, index) => {
      const suggestion = allSuggestions.find((s) => s.getId() === suggestionId);

      if (!suggestion) {
        failedSuggestions.push({
          uuid: suggestionId,
          index,
          message: 'Suggestion not found',
          statusCode: 404,
        });
      } else {
        // For rollback, check if suggestion has been deployed
        const hasBeenDeployed = suggestion.getData()?.tokowakaDeployed;
        if (!hasBeenDeployed) {
          failedSuggestions.push({
            uuid: suggestionId,
            index,
            message: 'Suggestion has not been deployed, cannot rollback',
            statusCode: 400,
          });
        } else {
          validSuggestions.push(suggestion);
        }
      }
    });

    let succeededSuggestions = [];

    // Separate domain-wide from regular suggestions
    const domainWideSuggestions = validSuggestions.filter((s) => isDomainWideSuggestion(s));
    const regularSuggestions = validSuggestions.filter((s) => !isDomainWideSuggestion(s));

    // Handle domain-wide rollbacks separately (for prerender)
    if (isNonEmptyArray(domainWideSuggestions)) {
      try {
        const tokowakaClient = TokowakaClient.createFrom(context);
        const baseURL = site.getBaseURL();

        for (const suggestion of domainWideSuggestions) {
          try {
            // Fetch existing metaconfig
            // eslint-disable-next-line no-await-in-loop
            const metaconfig = await tokowakaClient.fetchMetaconfig(baseURL);

            if (metaconfig && metaconfig.prerender) {
              // Remove prerender configuration from metaconfig
              delete metaconfig.prerender;

              // Upload updated metaconfig
              // eslint-disable-next-line no-await-in-loop
              await tokowakaClient.uploadMetaconfig(baseURL, metaconfig);

              context.log.info(`Removed prerender config from metaconfig for domain-wide suggestion ${suggestion.getId()}`);
            }

            // Remove tokowakaDeployed from the domain-wide suggestion
            const currentData = suggestion.getData();
            delete currentData.tokowakaDeployed;
            suggestion.setData(currentData);
            suggestion.setUpdatedBy('tokowaka-rollback');
            // eslint-disable-next-line no-await-in-loop
            await suggestion.save();

            succeededSuggestions.push(suggestion);

            // Find and update all suggestions that were covered by this domain-wide deployment
            const coveredSuggestions = allSuggestions.filter(
              (s) => s.getData()?.coveredByDomainWide === suggestion.getId(),
            );

            if (isNonEmptyArray(coveredSuggestions)) {
              context.log.info(`Rolling back ${coveredSuggestions.length} suggestions covered by domain-wide deployment`);

              // eslint-disable-next-line no-await-in-loop
              await Promise.all(
                coveredSuggestions.map(async (coveredSuggestion) => {
                  const coveredData = coveredSuggestion.getData();
                  delete coveredData.tokowakaDeployed;
                  delete coveredData.coveredByDomainWide;
                  coveredSuggestion.setData(coveredData);
                  coveredSuggestion.setUpdatedBy('domain-wide-rollback');
                  return coveredSuggestion.save();
                }),
              );
            }
          } catch (error) {
            context.log.error(`Error rolling back domain-wide suggestion ${suggestion.getId()}: ${error.message}`, error);
            failedSuggestions.push({
              uuid: suggestion.getId(),
              index: suggestionIds.indexOf(suggestion.getId()),
              message: `Rollback failed: ${error.message}`,
              statusCode: 500,
            });
          }
        }
      } catch (error) {
        context.log.error(`Error during domain-wide rollback: ${error.message}`, error);
        domainWideSuggestions.forEach((suggestion) => {
          failedSuggestions.push({
            uuid: suggestion.getId(),
            index: suggestionIds.indexOf(suggestion.getId()),
            message: 'Rollback failed: Internal server error',
            statusCode: 500,
          });
        });
      }
    }

    // Only attempt rollback if we have regular (non-domain-wide) suggestions
    if (isNonEmptyArray(regularSuggestions)) {
      try {
        const tokowakaClient = TokowakaClient.createFrom(context);

        // Rollback suggestions
        const result = await tokowakaClient.rollbackSuggestions(
          site,
          opportunity,
          regularSuggestions,
        );

        // Process results
        const {
          succeededSuggestions: processedSuggestions,
          failedSuggestions: ineligibleSuggestions,
        } = result;

        // Update successfully rolled back suggestions - remove tokowakaDeployed timestamp
        succeededSuggestions = await Promise.all(
          processedSuggestions.map(async (suggestion) => {
            const currentData = suggestion.getData();
            delete currentData.tokowakaDeployed;
            suggestion.setData(currentData);
            suggestion.setUpdatedBy('tokowaka-rollback');
            return suggestion.save();
          }),
        );

        // Add ineligible suggestions to failed list
        ineligibleSuggestions.forEach((item) => {
          failedSuggestions.push({
            uuid: item.suggestion.getId(),
            index: suggestionIds.indexOf(item.suggestion.getId()),
            message: item.reason,
            statusCode: 400,
          });
        });

        context.log.info(`Successfully rolled back ${succeededSuggestions.length} suggestions from Edge`);
      } catch (error) {
        context.log.error(`Error during Tokowaka rollback: ${error.message}`, error);
        // If rollback fails, mark all valid suggestions as failed
        validSuggestions.forEach((suggestion) => {
          failedSuggestions.push({
            uuid: suggestion.getId(),
            index: suggestionIds.indexOf(suggestion.getId()),
            message: 'Rollback failed: Internal server error',
            statusCode: 500,
          });
        });
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

    return createResponse(response, 207);
  };

  /**
   * Fetches content from a URL using Tokowaka-AI User-Agent.
   * This is a simple URL-based fetch, useful for checking deployed content.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Fetch response with content
   */
  const fetchFromEdge = async (context) => {
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
      return badRequest('No data provided');
    }

    const { url } = context.data;

    // Validate URL
    if (!hasText(url)) {
      return badRequest('URL is required');
    }

    // Validate URL format
    try {
      const parsedUrl = new URL(url); // throws if invalid
      if (!parsedUrl.protocol.startsWith('http')) {
        return badRequest('Invalid URL format: only HTTP/HTTPS URLs are allowed');
      }
    } catch (error) {
      return badRequest('Invalid URL format');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
    }

    try {
      context.log.info(`Fetching content from URL: ${url}`);

      // Make fetch request with Tokowaka-AI User-Agent
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Tokowaka-AI Tokowaka/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response.ok) {
        const requestId = response.headers.get('x-tokowaka-request-id');
        const logMessage = requestId
          ? `Failed to fetch URL. Status: ${response.status}, x-tokowaka-request-id: ${requestId}`
          : `Failed to fetch URL. Status: ${response.status}`;
        context.log.warn(logMessage);
        return ok({
          status: 'error',
          statusCode: response.status,
          message: `Failed to fetch content from URL: ${url}`,
          html: {
            url,
            content: null,
          },
        });
      }

      const content = await response.text();

      context.log.info(`Successfully fetched content from URL: ${url}`);

      return ok({
        status: 'success',
        statusCode: response.status,
        html: {
          url,
          content,
        },
      });
    } catch (error) {
      context.log.error(`Error fetching from URL ${url}: ${error.message}`, error);
      return ok({
        status: 'error',
        statusCode: 500,
        message: `Error fetching content: ${error.message}`,
        html: {
          url,
          content: null,
        },
      });
    }
  };

  return {
    autofixSuggestions,
    createSuggestions,
    deploySuggestionToEdge,
    rollbackSuggestionFromEdge,
    previewSuggestions,
    fetchFromEdge,
    getAllForOpportunity,
    getAllForOpportunityPaged,
    getByID,
    getByStatus,
    getByStatusPaged,
    getSuggestionFixes,
    patchSuggestion,
    patchSuggestionsStatus,
    removeSuggestion,
  };
}

export default SuggestionsController;
