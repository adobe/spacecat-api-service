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

import { ValidationError, Suggestion as SuggestionModel, Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import TokowakaClient from '@adobe/spacecat-shared-tokowaka-client';
import { SuggestionDto } from '../dto/suggestion.js';
import { FixDto } from '../dto/fix.js';
import { sendAutofixMessage, getCSPromiseToken, ErrorWithStatusCode } from '../support/utils.js';
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
  ];

  const DEFAULT_PAGE_SIZE = 100;

  const shouldGroupSuggestionsForAutofix = (type) => !AUTOFIX_UNGROUPED_OPPTY_TYPES.includes(type);

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
    const { suggestionIds, variations, action } = context.data;

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

  return {
    autofixSuggestions,
    createSuggestions,
    deploySuggestionToEdge,
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
