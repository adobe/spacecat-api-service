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
  accepted,
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
  isValidUrl,
} from '@adobe/spacecat-shared-utils';

import { Suggestion as SuggestionModel, GeoExperiment as GeoExperimentModel } from '@adobe/spacecat-shared-data-access';
import TokowakaClient from '@adobe/spacecat-shared-tokowaka-client';
import DrsClient, { EXPERIMENT_PHASES } from '@adobe/spacecat-shared-drs-client';
import { SuggestionDto, SUGGESTION_VIEWS, SUGGESTION_SKIP_REASONS } from '../dto/suggestion.js';
import {
  getScheduleParams,
  buildExperimentMetadata,
} from '../support/geo-experiment-helper.js';
import { FixDto } from '../dto/fix.js';
import { GeoExperimentDto } from '../dto/geo-experiment.js';
import {
  sendAutofixMessage,
  getCookieValue,
  getIMSPromiseToken,
  ErrorWithStatusCode,
  getHostName,
  getIsSummitPlgEnabled,
  isViewAsTrialRequest,
} from '../support/utils.js';
import AccessControlUtil from '../support/access-control-util.js';
import { grantSuggestionsForOpportunity } from '../support/grant-suggestions-handler.js';

const VALIDATION_ERROR_NAME = 'ValidationError';

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
    'security-permissions',
    'security-vulnerabilities',
    'security-csp',
    'high-page-views-low-form-views',
  ];

  const DEFAULT_PAGE_SIZE = 100;

  /**
   * Validates the view parameter for projection.
   * @param {string} view - The view parameter from query string.
   * @returns {string} Valid view name or 'full' as default.
   * @throws {Error} If view is invalid.
   */
  const validateView = (view) => {
    if (!view) {
      return 'full';
    }
    if (!SUGGESTION_VIEWS.includes(view)) {
      throw new Error(`Invalid view. Must be one of: ${SUGGESTION_VIEWS.join(', ')}`);
    }
    return view;
  };

  /**
   * Validates view parameter and returns error response if invalid.
   * @param {string} viewParam - The view parameter from query string.
   * @returns {{view: string, error: null}|{view: null, error: Response}}
   */
  const getValidatedView = (viewParam) => {
    try {
      return { view: validateView(viewParam), error: null };
    } catch (e) {
      return { view: null, error: badRequest(e.message) };
    }
  };

  /**
   * Validates and parses the status parameter for filtering.
   * @param {string} statusParam - Comma-separated status values.
   * @returns {string[]} Array of valid status values, or empty array if no param.
   * @throws {Error} If any status value is invalid.
   */
  const validateStatuses = (statusParam) => {
    if (!statusParam) {
      return [];
    }
    const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 0) {
      return [];
    }

    const validStatuses = Object.values(SuggestionModel.STATUSES);
    const invalidStatuses = statuses.filter((s) => !validStatuses.includes(s));

    if (invalidStatuses.length > 0) {
      throw new Error(`Invalid status value(s): ${invalidStatuses.join(', ')}. Valid: ${validStatuses.join(', ')}`);
    }
    return statuses;
  };

  const SKIP_DETAIL_MAX_LENGTH = 500;

  /**
   * Validates skipReason and skipDetail for SKIPPED status.
   * @param {string} status - Target status
   * @param {string} [skipReason] - Optional skip reason
   * @param {string} [skipDetail] - Optional skip detail
   * @returns {{ valid: boolean, error?: string }}
   */
  const validateSkipFields = (status, skipReason, skipDetail) => {
    if (status !== SuggestionModel.STATUSES.SKIPPED) {
      if (skipReason != null || skipDetail != null) {
        return {
          valid: false,
          error: 'skipReason and skipDetail can only be provided when status is SKIPPED',
        };
      }
      return { valid: true };
    }
    if (skipReason != null && skipReason !== '' && !SUGGESTION_SKIP_REASONS.includes(skipReason)) {
      return {
        valid: false,
        error: `Invalid skipReason. Must be one of: ${SUGGESTION_SKIP_REASONS.join(', ')}`,
      };
    }
    if (skipDetail != null && typeof skipDetail !== 'string') {
      return {
        valid: false,
        error: 'skipDetail must be a string',
      };
    }
    if (typeof skipDetail === 'string' && skipDetail.length > SKIP_DETAIL_MAX_LENGTH) {
      return {
        valid: false,
        error: `skipDetail must be at most ${SKIP_DETAIL_MAX_LENGTH} characters`,
      };
    }
    return { valid: true };
  };

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
    Opportunity, Suggestion, SuggestionGrant, Site, Configuration, GeoExperiment,
  } = dataAccess;

  if (!isObject(Opportunity)) {
    throw new Error('Data access required');
  }

  if (!isObject(Suggestion)) {
    throw new Error('Data access required');
  }

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Filters suggestions to only granted ones when summit-plg is enabled for the site
   * and the request originates from the sites-optimizer-ui client.
   * Returns all suggestions unchanged when either condition is not met.
   * @param {Object} site - Site entity.
   * @param {Array} suggestions - Suggestion entities to filter.
   * @param {Object} context - Request context.
   * @returns {Promise<Array>} Filtered suggestion entities.
   */
  const filterByGrantStatus = async (site, suggestions, context) => {
    if (!await getIsSummitPlgEnabled(site, ctx, context)) {
      return suggestions;
    }
    try {
      const ids = suggestions.map((s) => s.getId());
      const { grantedIds } = await SuggestionGrant.splitSuggestionsByGrantStatus(ids);
      return suggestions.filter((s) => grantedIds.includes(s.getId()));
    } catch (err) {
      ctx.log?.error?.('Failed to filter suggestions by grant status', err?.message ?? err);
      return suggestions;
    }
  };

  /**
   * Gets all suggestions for a given site and opportunity
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of suggestions response.
   */
  const getAllForOpportunity = async (context) => {
    const siteId = context.params?.siteId;
    const opptyId = context.params?.opportunityId;
    const viewParam = context.data?.view;
    const statusParam = context.data?.status;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opptyId)) {
      return badRequest('Opportunity ID required');
    }

    const { view, error: viewError } = getValidatedView(viewParam);
    if (viewError) {
      return viewError;
    }

    let statuses;
    try {
      statuses = validateStatuses(statusParam);
    } catch (e) {
      return badRequest(e.message);
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
    }

    // Fetch all suggestions (single DB call)
    let suggestionEntities = await Suggestion.allByOpportunityId(opptyId);
    let opportunity = null;
    if (suggestionEntities.length > 0) {
      opportunity = await suggestionEntities[0].getOpportunity();
      if (!opportunity || opportunity.getSiteId() !== siteId) {
        return notFound('Opportunity not found');
      }
    }
    const isRealPlg = await getIsSummitPlgEnabled(site, ctx, context)
      && !isViewAsTrialRequest(context);
    if (opportunity && isRealPlg) {
      try {
        await grantSuggestionsForOpportunity(dataAccess, site, opportunity);
      /* c8 ignore next 3 */
      } catch (err) {
        ctx.log?.warn?.('Grant suggestions handler failed', err?.message ?? err);
      }
    }

    // Filter by status in memory if validated statuses provided
    if (statuses.length > 0) {
      suggestionEntities = suggestionEntities.filter(
        (sugg) => statuses.includes(sugg.getStatus()),
      );
    }
    const grantedEntities = await filterByGrantStatus(site, suggestionEntities, context);
    const suggestions = grantedEntities.map(
      (sugg) => SuggestionDto.toJSON(sugg, view, opportunity),
    );
    return ok(suggestions);
  };

  /**
   * Gets a page of suggestions for a given site and opportunity
   * @param {Object} context of the request
   * @param {number} context.params.limit - Number of suggestions per page. Default=100.
   * @param {number} context.params.cursor - The next cursor or null for first page.
   * @param {string} context.params.view - Projection view: 'minimal', 'summary', or 'full'.
   * @returns {Promise<Response>} Array of suggestions response.
   */
  const getAllForOpportunityPaged = async (context) => {
    const siteId = context.params?.siteId;
    const opptyId = context.params?.opportunityId;
    const limit = parseInt(context.params?.limit, 10) || DEFAULT_PAGE_SIZE;
    const cursor = context.params?.cursor || null;
    const viewParam = context.data?.view;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opptyId)) {
      return badRequest('Opportunity ID required');
    }

    if (!isInteger(limit) || limit < 1) {
      return badRequest('Page size must be greater than 0');
    }

    const { view, error: viewError } = getValidatedView(viewParam);
    if (viewError) {
      return viewError;
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
    }

    // Fetch suggestions with pagination
    const paginationOptions = { limit, cursor, returnCursor: true };
    const results = await Suggestion.allByOpportunityId(opptyId, paginationOptions);
    const suggestionEntities = results.data || [];
    const newCursor = results.cursor || null;

    let opportunity = null;
    if (suggestionEntities.length > 0) {
      opportunity = await suggestionEntities[0].getOpportunity();
      if (!opportunity || opportunity.getSiteId() !== siteId) {
        return notFound('Opportunity not found');
      }
    }
    const grantedEntities = await filterByGrantStatus(site, suggestionEntities, context);
    const suggestions = grantedEntities.map(
      (sugg) => SuggestionDto.toJSON(sugg, view, opportunity),
    );

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
    const viewParam = context.data?.view;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(opptyId)) {
      return badRequest('Opportunity ID required');
    }
    if (!hasText(status)) {
      return badRequest('Status is required');
    }

    const { view, error: viewError } = getValidatedView(viewParam);
    if (viewError) {
      return viewError;
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
    }

    const suggestionEntities = await Suggestion.allByOpportunityIdAndStatus(opptyId, status);
    let opportunity = null;
    if (suggestionEntities.length > 0) {
      opportunity = await suggestionEntities[0].getOpportunity();
      if (!opportunity || opportunity.getSiteId() !== siteId) {
        return notFound('Opportunity not found');
      }
    }
    const grantedEntities = await filterByGrantStatus(site, suggestionEntities, context);
    const suggestions = grantedEntities.map(
      (sugg) => SuggestionDto.toJSON(sugg, view, opportunity),
    );
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
    const viewParam = context.data?.view;

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

    const { view, error: viewError } = getValidatedView(viewParam);
    if (viewError) {
      return viewError;
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
    let opportunity = null;
    if (suggestionEntities.length > 0) {
      opportunity = await suggestionEntities[0].getOpportunity();
      if (!opportunity || opportunity.getSiteId() !== siteId) {
        return notFound('Opportunity not found');
      }
    }
    const grantedEntities = await filterByGrantStatus(site, suggestionEntities, context);
    const suggestions = grantedEntities.map(
      (sugg) => SuggestionDto.toJSON(sugg, view, opportunity),
    );
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
    const viewParam = context.data?.view;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isValidUUID(opptyId)) {
      return badRequest('Opportunity ID required');
    }

    if (!isValidUUID(suggestionId)) {
      return badRequest('Suggestion ID required');
    }

    const { view, error: viewError } = getValidatedView(viewParam);
    if (viewError) {
      return viewError;
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
    if (await getIsSummitPlgEnabled(site, ctx, context)
      && !(await SuggestionGrant.isSuggestionGranted(suggestion.getId()))) {
      return notFound('Suggestion not found');
    }
    return ok(SuggestionDto.toJSON(suggestion, view, opportunity));
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
          statusCode: error?.name === VALIDATION_ERROR_NAME ? 400 : 500,
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
    const {
      rank, data, kpiDeltas, status, skipReason, skipDetail,
    } = context.data;
    try {
      if (rank != null && rank !== suggestion.getRank()) {
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

      if (hasText(status) && status !== suggestion.getStatus()) {
        const { valid, error } = validateSkipFields(status, skipReason, skipDetail);
        if (!valid) {
          return badRequest(error);
        }
        hasUpdates = true;
        suggestion.setStatus(status);
        if (status === SuggestionModel.STATUSES.SKIPPED) {
          if (suggestion.setSkipReason) {
            suggestion.setSkipReason(skipReason ?? null);
            suggestion.setSkipDetail(skipDetail ?? null);
          } else {
            context.log.warn('Suggestion model does not support skip fields (setSkipReason). Upgrade spacecat-shared-data-access.');
          }
        } else if (suggestion.setSkipReason) {
          suggestion.setSkipReason(null);
          suggestion.setSkipDetail(null);
        }
      } else if (hasText(status) && status === SuggestionModel.STATUSES.SKIPPED) {
        const { valid, error } = validateSkipFields(status, skipReason, skipDetail);
        if (!valid) {
          return badRequest(error);
        }
        if ((skipReason != null || skipDetail != null)) {
          if (suggestion.setSkipReason) {
            hasUpdates = true;
            suggestion.setSkipReason(skipReason ?? null);
            suggestion.setSkipDetail(skipDetail ?? null);
          } else {
            context.log.warn('Suggestion model does not support skip fields (setSkipReason). Upgrade spacecat-shared-data-access.');
          }
        }
      }

      if (hasUpdates) {
        suggestion.setUpdatedBy(profile.email || 'system');
        const updatedSuggestion = await suggestion.save();
        return ok(SuggestionDto.toJSON(updatedSuggestion));
      }
    } catch (e) {
      if (e?.name === VALIDATION_ERROR_NAME) {
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

    const suggestionPromises = context.data.map(async (item, index) => {
      const {
        id, status, skipReason, skipDetail,
      } = item;
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

      const { valid, error } = validateSkipFields(status, skipReason, skipDetail);
      if (!valid) {
        return {
          index,
          uuid: id,
          message: error,
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

      const currentStatus = suggestion.getStatus();
      try {
        if (currentStatus !== status) {
          // Validate REJECTED status transition
          if (status === SuggestionModel.STATUSES.REJECTED) {
            // Check admin access for REJECTED status
            if (!accessControlUtil.hasAdminAccess()) {
              return {
                index,
                uuid: id,
                message: 'Only admins can reject suggestions',
                statusCode: 403,
              };
            }

            // Only allow REJECTED from PENDING_VALIDATION
            if (currentStatus !== SuggestionModel.STATUSES.PENDING_VALIDATION) {
              return {
                index,
                uuid: id,
                message: 'Can only reject suggestions with status PENDING_VALIDATION',
                statusCode: 400,
              };
            }
          }

          suggestion.setStatus(status);
          if (status === SuggestionModel.STATUSES.SKIPPED) {
            if (suggestion.setSkipReason) {
              suggestion.setSkipReason(skipReason ?? null);
              suggestion.setSkipDetail(skipDetail ?? null);
            } else {
              context.log.warn('Suggestion model does not support skip fields (setSkipReason). Upgrade spacecat-shared-data-access.');
            }
          } else if (suggestion.setSkipReason) {
            suggestion.setSkipReason(null);
            suggestion.setSkipDetail(null);
          }
          suggestion.setUpdatedBy(profile.email);
        } else if (
          status === SuggestionModel.STATUSES.SKIPPED
          && (skipReason != null || skipDetail != null)
        ) {
          if (suggestion.setSkipReason) {
            suggestion.setSkipReason(skipReason ?? null);
            suggestion.setSkipDetail(skipDetail ?? null);
            suggestion.setUpdatedBy(profile.email);
          } else {
            context.log.warn('Suggestion model does not support skip fields (setSkipReason). Upgrade spacecat-shared-data-access.');
          }
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
      } catch (saveError) {
        return {
          index,
          message: saveError.message,
          statusCode: saveError?.name === VALIDATION_ERROR_NAME ? 400 : 500,
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
  const getSuggestionUrl = (suggestionData, opp) => suggestionData?.url
    || suggestionData?.recommendations?.[0]?.pageUrl
    || suggestionData?.url_from
    || suggestionData?.urlFrom
    || (opp?.getType() === 'no-cta-above-the-fold'
      ? suggestionData?.contentFix?.page_patch?.original_page_url
      : null)
    || opp?.getData()?.page;

  /**
   * Triggers auto-fix for the given suggestions. Validates the site, opportunity, and
   * suggestions, then queues an autofix message via SQS.
   *
   * For promise token resolution, reads the promiseToken cookie sent by the browser
   * (set via /auth/promise endpoint). Falls back to obtaining a token via IMS when
   * the cookie is absent.
   *
   * @param {Object} context - The request context
   * @param {Object} [context.pathInfo] - The path info object
   * @param {Object} [context.pathInfo.headers] - Request headers; must include a
   *   `cookie` header with `promiseToken=<token>` for promise-based authoring types
   * @param {Object} context.params - Path parameters (siteId, opportunityId)
   * @param {Object} context.data - Request body containing suggestionIds
   * @returns {Promise<Response>} 207 multi-status response with per-suggestion results
   */
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
      suggestionIds, variations, action, customData, url: requestUrl,
      precheckOnly, pages, fixTargetGroups,
    } = context.data;
    const isAssessAction = action === 'assess';
    const isAssessUrlsAction = action === 'assess-urls';

    if (action !== undefined && !hasText(action)) {
      return badRequest('action cannot be empty');
    }
    if (action === 'assess' || action === 'assess-urls') {
      if (precheckOnly !== undefined && typeof precheckOnly !== 'boolean') {
        return badRequest('precheckOnly must be a boolean');
      }
    }
    if (fixTargetGroups !== undefined) {
      if (!isArray(fixTargetGroups)) {
        return badRequest('fixTargetGroups must be an array');
      }
      for (const group of fixTargetGroups) {
        if (!isArray(group?.suggestionIds) || group.suggestionIds.length === 0) {
          return badRequest('Each fixTargetGroup must have a non-empty suggestionIds array');
        }
        const { relationshipContext } = group;
        if (!isObject(relationshipContext)) {
          return badRequest('Each fixTargetGroup must have a relationshipContext object');
        }

        const {
          fixTargetPageId,
          fixTargetMode,
          appliedOnPagePath,
          cancelInheritance,
        } = relationshipContext;
        if (!hasText(fixTargetPageId)) {
          return badRequest('Each fixTargetGroup relationshipContext.fixTargetPageId must be a non-empty string');
        }
        if (cancelInheritance !== undefined && typeof cancelInheritance !== 'boolean') {
          return badRequest('Each fixTargetGroup relationshipContext.cancelInheritance must be a boolean');
        }
        if (
          fixTargetMode !== undefined
          && fixTargetMode !== 'source'
          && fixTargetMode !== 'local'
        ) {
          return badRequest('Each fixTargetGroup relationshipContext.fixTargetMode must be "source" or "local"');
        }
        if (appliedOnPagePath !== undefined && !hasText(appliedOnPagePath)) {
          return badRequest('Each fixTargetGroup relationshipContext.appliedOnPagePath must be a non-empty string');
        }
      }
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

    // assess-urls action: validate pages and send worker message, return 202
    if (isAssessUrlsAction) {
      if (!isNonEmptyArray(pages)) {
        return badRequest('Request body must contain a non-empty array of pages (URLs) when action is assess-urls');
      }
      const invalidEntry = pages.find((p) => {
        if (typeof p === 'string') {
          return !isValidUrl(p);
        }
        if (isObject(p) && p !== null) {
          const { pageUrl, imageUrls } = p;
          if (typeof pageUrl !== 'string' || !isValidUrl(pageUrl)) {
            return true;
          }
          if (imageUrls !== undefined) {
            if (!isArray(imageUrls)) {
              return true;
            }
            return imageUrls.some((u) => typeof u !== 'string' || !isValidUrl(u));
          }
          return false;
        }
        return true;
      });
      if (invalidEntry !== undefined) {
        return badRequest('Each page must be a valid URL string or an object with pageUrl (valid URL) and optional imageUrls (array of valid URLs)');
      }
      const configuration = await Configuration.findLatest();
      if (!configuration.isHandlerEnabledForSite(`${opportunity.getType()}-auto-fix`, site)) {
        return badRequest(`Handler is not enabled for site ${site.getId()} autofix type ${opportunity.getType()}`);
      }
      const { AUTOFIX_JOBS_QUEUE: queueUrl } = env;
      // Intentionally omit opportunityId: worker uses context differently for URL-based assessments
      await sqs.sendMessage(queueUrl, {
        siteId,
        action: 'assess-urls',
        pages,
        ...(precheckOnly === true && { precheckOnly: true }),
      });
      return accepted({ message: 'Assess-urls job queued', siteId, pagesCount: pages.length });
    }

    // suggestion-based flow (assess, fix, etc.)
    if (!isArray(suggestionIds)) {
      return badRequest('Request body must be an array of suggestionIds');
    }
    if (variations && !isArray(variations)) {
      return badRequest('variations must be an array');
    }

    // Block auto-deploy on non-granted suggestions for summit-plg users
    if (await getIsSummitPlgEnabled(site, ctx, context)) {
      const { notGrantedIds } = await SuggestionGrant.splitSuggestionsByGrantStatus(suggestionIds);
      if (notGrantedIds.length > 0) {
        return forbidden(`The following suggestions are not granted: ${notGrantedIds.join(', ')}`);
      }
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
        /* c8 ignore start */
        if (isDomainWideSuggestion(suggestion)) {
          failedSuggestions.push({
            uuid: suggestion.getId(),
            index: suggestionIds.indexOf(suggestion.getId()),
            message: 'Domain-wide aggregate suggestions cannot be auto-fixed individually',
            statusCode: 400,
          });
        /* c8 ignore stop */
        } else if (
          suggestion.getStatus() === SuggestionModel.STATUSES.NEW
          || suggestion.getStatus() === SuggestionModel.STATUSES.PENDING_VALIDATION
        ) {
          validSuggestions.push(suggestion);
        } else {
          failedSuggestions.push({
            uuid: suggestion.getId(),
            index: suggestionIds.indexOf(suggestion.getId()),
            message: 'Suggestion must be in NEW or PENDING_VALIDATION status for auto-fix',
            statusCode: 400,
          });
        }
      }
    });

    let suggestionGroups;
    if (shouldGroupSuggestionsForAutofix(opportunity.getType())) {
      if (isNonEmptyArray(fixTargetGroups)) {
        // OUR ADDITION: relationship-aware grouping when UI sends fixTargetGroups
        suggestionGroups = fixTargetGroups
          .map(({
            suggestionIds: groupIds,
            relationshipContext,
          }) => {
            const groupedSuggestions = validSuggestions.filter(
              (s) => groupIds.includes(s.getId()),
            );
            return {
              groupedSuggestions,
              url: getSuggestionUrl(groupedSuggestions[0]?.getData(), opportunity),
              relationshipContext: { ...relationshipContext },
            };
          })
          .filter(({ groupedSuggestions }) => groupedSuggestions.length > 0);

        // Handle suggestions not covered by any fixTargetGroup
        const coveredIds = new Set(
          suggestionGroups.flatMap(
            ({ groupedSuggestions }) => groupedSuggestions.map((s) => s.getId()),
          ),
        );
        const uncoveredSuggestions = validSuggestions.filter(
          (s) => !coveredIds.has(s.getId()),
        );
        if (isNonEmptyArray(uncoveredSuggestions)) {
          const uncoveredByUrl = uncoveredSuggestions.reduce((acc, suggestion) => {
            const url = getSuggestionUrl(suggestion.getData(), opportunity);
            if (!url) {
              return acc;
            }
            if (!acc[url]) {
              acc[url] = [];
            }
            acc[url].push(suggestion);
            return acc;
          }, {});
          Object.entries(uncoveredByUrl).forEach(([url, grouped]) => {
            suggestionGroups.push({ groupedSuggestions: grouped, url });
          });
        }
      } else {
        const suggestionsByUrl = validSuggestions.reduce((acc, suggestion) => {
          const url = getSuggestionUrl(suggestion.getData(), opportunity);
          if (!url) {
            return acc;
          }

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
      if (isAssessAction) {
        succeededSuggestions = validSuggestions;
      } else {
        succeededSuggestions = await Suggestion.bulkUpdateStatus(
          validSuggestions,
          SuggestionModel.STATUSES.IN_PROGRESS,
        );
      }
    }

    let promiseTokenResponse;
    const skipPromiseToken = isAssessAction && precheckOnly === true;
    if (!skipPromiseToken) {
      const cookieToken = getCookieValue(context, 'promiseToken');
      if (hasText(cookieToken)) {
        promiseTokenResponse = { promise_token: cookieToken };
      } else {
        try {
          promiseTokenResponse = await getIMSPromiseToken(context);
        } catch (e) {
          if (e instanceof ErrorWithStatusCode) {
            return badRequest(e.message);
          }
          return createResponse({ message: 'Error getting promise token' }, 500);
        }
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

    const autofixOptions = (urlParam) => ({
      url: urlParam,
      ...(precheckOnly === true && { precheckOnly: true }),
    });
    if (shouldGroupSuggestionsForAutofix(opportunity.getType())) {
      await Promise.all(
        suggestionGroups.map(({
          groupedSuggestions,
          url,
          relationshipContext,
        }) => sendAutofixMessage(
          sqs,
          queueUrl,
          siteId,
          opportunityId,
          groupedSuggestions.map((s) => s.getId()),
          promiseTokenResponse,
          variations,
          action,
          customData,
          {
            ...autofixOptions(url),
            ...(isObject(relationshipContext) && { relationshipContext }),
          },
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
        autofixOptions(requestUrl),
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
    const previewStartTime = Date.now();
    const siteId = context.params?.siteId;
    const opportunityId = context.params?.opportunityId;
    const { authInfo: { profile } } = context.attributes;

    context.log.info('[edge-preview] request', {
      siteId,
      opportunityId,
      suggestionIds: context.data?.suggestionIds,
      userId: profile?.email,
    });

    if (!isValidUUID(siteId)) {
      context.log.warn('[edge-preview-failed] siteId is not a valid UUID');
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      context.log.warn(`[edge-preview-failed] site ${siteId} not found`);
      return notFound('Site not found');
    }

    const apexBaseUrl = getHostName(site.getBaseURL()) || site.getBaseURL();

    if (!isValidUUID(opportunityId)) {
      context.log.warn(`[edge-preview-failed] site: ${apexBaseUrl}, opportunityId is not a valid UUID`);
      return badRequest('Opportunity ID required');
    }

    // validate request body
    if (!isNonEmptyObject(context.data)) {
      context.log.warn(`[edge-preview-failed] site: ${apexBaseUrl}, no request body data provided`);
      return badRequest('No data provided');
    }
    const { suggestionIds } = context.data;
    if (!isArray(suggestionIds) || suggestionIds.length === 0) {
      context.log.warn(`[edge-preview-failed] site: ${apexBaseUrl}, suggestionIds is not a non-empty array`);
      return badRequest('Request body must contain a non-empty array of suggestionIds');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      context.log.warn(`[edge-preview-failed] site: ${apexBaseUrl}, user does not have access to the site`);
      return forbidden('User does not belong to the organization');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      context.log.warn(`[edge-preview-failed] site: ${apexBaseUrl}, opportunity ${opportunityId} not found`);
      return notFound('Opportunity not found');
    }

    // Fetch all suggestions for this opportunity
    const allSuggestions = await Suggestion.allByOpportunityId(opportunityId);

    context.log.info(`[edge-preview] allSuggestions count: ${allSuggestions.length}`);
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
        context.log.warn(`[edge-preview-failed] site: ${apexBaseUrl}, all suggestions must belong to the same URL`);
        return badRequest('All suggestions must belong to the same URL for preview');
      }

      if (urls.size === 0) {
        context.log.warn(`[edge-preview-failed] site: ${apexBaseUrl}, no valid URLs found in suggestions`);
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

        const previewTimeTaken = Date.now() - previewStartTime;
        context.log.info(`Successfully previewed ${succeededSuggestions.length} suggestions`
          + ` by ${profile?.email || 'tokowaka-preview'}, took ${previewTimeTaken}ms`);
        /* c8 ignore next 5 */
        if (previewTimeTaken > 13000) {
          context.log.warn(`Edge-Preview took ${previewTimeTaken} ms for ${site.getBaseURL()} , siteId: ${site.getId()}`
          + ` opportunityId: ${opportunity.getId()} , opportunityType: ${opportunity.getType()}`
          + ` and ${succeededSuggestions.length} suggestions`);
        }
      } catch (error) {
        context.log.error(`[edge-preview-failed] site: ${apexBaseUrl}, Error generating preview: ${error.message}`, error);
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
    const { authInfo: { profile } } = context.attributes;

    context.log.info('[edge-deploy] request', {
      siteId,
      opportunityId,
      suggestionIdsCount: context.data?.suggestionIds?.length ?? 0,
      userId: profile?.email,
    });

    context.log.info(`[edge-deploy] suggestionIds: ${JSON.stringify(context.data?.suggestionIds)}`);

    if (!isValidUUID(siteId)) {
      context.log.warn(`[edge-deploy-failed] site: n/a, siteId ${siteId} is not a valid UUID`);
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      context.log.warn(`[edge-deploy-failed] site ${siteId} not found`);
      return notFound('Site not found');
    }
    const apexBaseUrl = getHostName(site.getBaseURL()) || site.getBaseURL();

    if (!isValidUUID(opportunityId)) {
      context.log.warn(`[edge-deploy-failed] site: ${apexBaseUrl}, opportunityId ${opportunityId} is not a valid UUID`);
      return badRequest('Opportunity ID required');
    }

    if (!isNonEmptyObject(context.data)) {
      context.log.warn(`[edge-deploy-failed] site: ${apexBaseUrl}, no request body data provided`);
      return badRequest('No data provided');
    }
    const { suggestionIds: rawSuggestionIds } = context.data;
    if (!isArray(rawSuggestionIds) || rawSuggestionIds.length === 0) {
      context.log.warn(`[edge-deploy-failed] site: ${apexBaseUrl}, suggestionIds is not a non-empty array`);
      return badRequest('Request body must contain a non-empty array of suggestionIds');
    }
    const suggestionIds = [...new Set(rawSuggestionIds)];

    // No productCode is passed to hasAccess(); the delegation block is not entered.
    // Org membership is the intended access gate for this endpoint.
    if (!await accessControlUtil.hasAccess(site)) {
      context.log.warn(
        `[edge-deploy-failed] site: ${apexBaseUrl}, user does not have access to the site.`,
      );
      return forbidden('User does not belong to the organization');
    }

    if (!accessControlUtil.isLLMOAdministrator()) {
      context.log.warn(`[edge-deploy-failed] site: ${apexBaseUrl}, user is not an LLMO administrator`);
      return forbidden('Only LLMO administrators can deploy suggestions to edge');
    }

    if (!await accessControlUtil.isOwnerOfSite(site)) {
      context.log.warn(
        `[edge-deploy-failed] site: ${apexBaseUrl}, user is not the owner of the site`,
      );
      return forbidden('User does not have access to deploy edge optimize fixes for this site');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      context.log.warn(`[edge-deploy-failed] site: ${apexBaseUrl}, opportunity ${opportunityId} not found`);
      return notFound('Opportunity not found');
    }

    const allSuggestions = await Suggestion.allByOpportunityId(opportunityId);
    context.log.info(`[edge-deploy] allSuggestions count: ${allSuggestions.length}`);

    const isEdgeDeployableStatus = (status) => status === SuggestionModel.STATUSES.NEW
      || status === SuggestionModel.STATUSES.PENDING_VALIDATION;

    // Track valid, failed, and missing suggestions
    const validSuggestions = [];
    const domainWideSuggestions = [];
    const failedSuggestions = [];
    let coveredSuggestionsCount = 0;
    // Check each requested suggestion (basic validation only)
    suggestionIds.forEach((suggestionId, index) => {
      const suggestion = allSuggestions.find((s) => s.getId() === suggestionId);

      if (!suggestion) {
        context.log.warn(`[edge-deploy-failed] site: ${apexBaseUrl}, suggestion ${suggestionId} not found`);
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
          context.log.warn(`[edge-deploy-failed] site: ${apexBaseUrl}, domain-wide suggestion ${suggestionId} missing allowedRegexPatterns`);
          failedSuggestions.push({
            uuid: suggestionId,
            index,
            message: 'Domain-wide suggestion missing allowedRegexPatterns',
            statusCode: 400,
          });
        }
      } else if (!isEdgeDeployableStatus(suggestion.getStatus())) {
        context.log.warn(`[edge-deploy-failed] site: ${apexBaseUrl}, suggestion ${suggestionId} (status: ${suggestion.getStatus()}) must be NEW or PENDING_VALIDATION for edge deploy`);
        failedSuggestions.push({
          uuid: suggestionId,
          index,
          message: 'Suggestion must be in NEW or PENDING_VALIDATION status for edge deploy',
          statusCode: 400,
        });
      } else {
        validSuggestions.push(suggestion);
      }
    });
    context.log.info(`[edge-deploy] validSuggestions count: ${validSuggestions.length}
      , Failed suggestions count: ${failedSuggestions.length}`);

    const validSuggestionIds = [
      ...validSuggestions.map((s) => s.getId()),
      ...domainWideSuggestions.map(({ suggestion }) => suggestion.getId()),
    ];

    if (validSuggestionIds.length === 0) {
      context.log.warn(`[edge-deploy-failed] site: ${apexBaseUrl}, no valid suggestions to deploy`);
      const response = {
        suggestions: [...failedSuggestions],
        metadata: {
          total: suggestionIds.length,
          success: 0,
          failed: failedSuggestions.length,
        },
      };
      response.suggestions.sort((a, b) => a.index - b.index);
      return createResponse(response, 207);
    }
    const { pathInfo } = context;
    const preferHeaderValue = pathInfo?.headers?.prefer
      || pathInfo?.headers?.Prefer;
    const isAsyncExperimentRequested = hasText(preferHeaderValue)
      && preferHeaderValue.toLowerCase() === 'respond-async';

    if (isAsyncExperimentRequested) {
      context.log.info(`[edge-geo-exp] async experiment requested for site: ${apexBaseUrl}`);
      let urls;
      const geoExperimentId = crypto.randomUUID();

      context.log.info('[edge-geo-exp] Initiating experiment', {
        geoExperimentId,
        opportunityId,
        opportunityType: opportunity.getType(),
        siteId,
      });

      let geoExperiment = null;
      try {
        const preScheduleParams = getScheduleParams(
          context,
          GeoExperimentModel.TYPES.ONSITE_OPPORTUNITY_DEPLOYMENT,
          opportunity.getType(),
          'pre',
        );
        if (!preScheduleParams.cronExpression || !preScheduleParams.expiryMs) {
          context.log.warn(`[edge-geo-exp-failed] site: ${apexBaseUrl}, missing schedule config for pre phase`);
          throw new Error('Missing required environment variables');
        }
        const { s3Client, s3Bucket, PutObjectCommand } = context.s3;
        let promptSources;
        if (domainWideSuggestions.length > 0) {
          const newStatus = SuggestionModel.STATUSES.NEW;
          const allNew = await Suggestion.allByOpportunityIdAndStatus(opportunityId, newStatus);
          const top15ByContentGainRatio = [...allNew]
            .filter((s) => s.getData()?.isDomainWide !== true)
            .sort((a, b) => (b.getData()?.contentGainRatio || 0)
              - (a.getData()?.contentGainRatio || 0))
            .slice(0, 15);
          promptSources = top15ByContentGainRatio
            .sort((a, b) => (b.getData()?.agenticTraffic || 0) - (a.getData()?.agenticTraffic || 0))
            .slice(0, 10);
        } else {
          promptSources = validSuggestions;
        }
        const domainWideSuggestionIds = new Set(
          domainWideSuggestions.map(({ suggestion }) => suggestion.getId()),
        );
        urls = promptSources
          .filter((s) => !domainWideSuggestionIds.has(s.getId()))
          .map((s) => s.getData()?.url)
          .filter(Boolean);
        const prompts = promptSources.flatMap((s) => s.getData()?.prompts || []);
        if (prompts.length === 0) {
          context.log.warn(`[edge-geo-exp-failed] site: ${apexBaseUrl}, no prompts found in selected suggestions`);
          throw new Error('No prompts found in selected suggestions');
        }
        const promptsS3Key = `geo-experiments/${siteId}/${geoExperimentId}-prompts.json`;
        await s3Client.send(new PutObjectCommand({
          Bucket: s3Bucket,
          Key: promptsS3Key,
          Body: JSON.stringify(prompts),
          ContentType: 'application/json',
        }));
        context.log.info(`[edge-geo-exp] Uploaded ${prompts.length} prompts to S3: ${promptsS3Key}`);

        geoExperiment = await GeoExperiment.create({
          geoExperimentId,
          siteId,
          opportunityId,
          type: GeoExperimentModel.TYPES.ONSITE_OPPORTUNITY_DEPLOYMENT,
          name: context.data?.name || opportunity.getType(),
          promptsCount: prompts.length,
          promptsLocation: promptsS3Key,
          status: GeoExperimentModel.STATUSES.GENERATING_BASELINE,
          phase: GeoExperimentModel.PHASES.PRE_ANALYSIS_STARTED,
          suggestionIds: validSuggestionIds,
          metadata: buildExperimentMetadata(
            context,
            { urls },
            GeoExperimentModel.TYPES.ONSITE_OPPORTUNITY_DEPLOYMENT,
            opportunity.getType(),
          ),
          updatedBy: profile?.email || 'geo-experiment',
        });

        if (!geoExperiment?.getId?.()) {
          throw new Error('GeoExperiment was not created');
        }

        context.log.info(`[edge-geo-exp] Created GeoExperiment ${geoExperimentId} with status GENERATING_BASELINE / phase PRE_ANALYSIS_STARTED`);

        let preScheduleId;
        try {
          const drsClient = DrsClient.createFrom(context);
          const drsResult = await drsClient.createExperimentSchedule({
            siteId,
            experimentId: geoExperimentId,
            experimentPhase: EXPERIMENT_PHASES.PRE,
            cronExpression: preScheduleParams.cronExpression,
            expiresAt: new Date(Date.now() + preScheduleParams.expiryMs).toISOString(),
            platforms: preScheduleParams.platforms,
            providerIds: preScheduleParams.providerIds,
            triggerImmediately: true,
            enableBrandPresence: true,
            metadata: { triggered_by: 'spacecat-edge-deploy', opportunityId },
          });
          preScheduleId = drsResult?.schedule?.schedule_id || drsResult?.schedule_id;
          if (!preScheduleId) {
            throw new Error('DRS schedule created but returned no schedule ID');
          }
          context.log.info(`[edge-geo-exp] DRS pre-analysis schedule created: ${preScheduleId}`);
        } catch (drsError) {
          context.log.error(`[edge-geo-exp-failed] site: ${apexBaseUrl}, DRS schedule creation failed: ${drsError.message}`, drsError);
          throw drsError;
        }
        try {
          geoExperiment.setPreScheduleId(preScheduleId);
          geoExperiment.setUpdatedBy(profile?.email || 'geo-experiment');
          await geoExperiment.save();
        } catch (updateError) {
          context.log.error(`[edge-geo-exp-failed] site: ${apexBaseUrl}, Failed to update GeoExperiment pre schedule ID: ${updateError.message}. DRS schedule ${preScheduleId} will expire naturally.`, updateError);
          throw updateError;
        }
        const validSuggestionEntities = [
          ...validSuggestions,
          ...domainWideSuggestions.map(({ suggestion }) => suggestion),
        ];

        const markResults = await Promise.allSettled(
          validSuggestionEntities.map(async (suggestion) => {
            const currentData = suggestion.getData();
            suggestion.setData({
              ...currentData,
              edgeOptimizeStatus: 'EXPERIMENT_IN_PROGRESS',
            });
            suggestion.setUpdatedBy(profile?.email || 'geo-experiment');
            return suggestion.save();
          }),
        );

        const markFailures = markResults.filter((r) => r.status === 'rejected');
        if (markFailures.length > 0) {
          context.log.warn(`[edge-geo-exp-failed] ${markFailures.length} suggestion(s) failed to mark as EXPERIMENT_IN_PROGRESS`, {
            geoExperimentId,
            errors: markFailures.map((r) => r.reason?.message),
          });
        }

        const experimentResponse = {
          suggestions: [
            ...validSuggestionEntities.map((suggestion) => ({
              uuid: suggestion.getId(),
              index: suggestionIds.indexOf(suggestion.getId()),
              statusCode: 202,
              suggestion: SuggestionDto.toJSON(suggestion),
            })),
            ...failedSuggestions,
          ],
          metadata: {
            total: suggestionIds.length,
            success: validSuggestionIds.length,
            failed: failedSuggestions.length,
          },
          geoExperimentId,
          geoExperimentStatus: GeoExperimentModel.STATUSES.GENERATING_BASELINE,
          geoExperimentPhase: GeoExperimentModel.PHASES.PRE_ANALYSIS_STARTED,
          prePhaseScheduleId: preScheduleId,
        };
        experimentResponse.suggestions.sort((a, b) => a.index - b.index);
        return createResponse(experimentResponse, 207);
      } catch (error) {
        context.log.error(`[edge-geo-exp-failed] site: ${apexBaseUrl}, Error initiating experiment: ${error.message}`, error);
        if (geoExperiment?.getId?.()) {
          /* c8 ignore start */
          try {
            await geoExperiment.remove();
          } catch (removeError) {
            context.log.error(`[edge-geo-exp-failed] Failed to clean up GeoExperiment ${geoExperimentId}: ${removeError.message}`, removeError);
          }
        }
        const allSuggestionEntities = [
          ...validSuggestions,
          ...domainWideSuggestions.map(({ suggestion }) => suggestion),
        ];
        await Promise.allSettled(
          allSuggestionEntities
            .filter((s) => s.getData()?.edgeOptimizeStatus === 'EXPERIMENT_IN_PROGRESS')
            .map(async (s) => {
              try {
                const { edgeOptimizeStatus: _, ...rest } = s.getData();
                s.setData(rest);
                s.setUpdatedBy(profile?.email || 'geo-experiment');
                await s.save();
              } catch (unblockError) {
                context.log.error(`[edge-geo-exp-failed] Failed to unblock suggestion ${s.getId()}: ${unblockError.message}`, unblockError);
              }
            }),
        );
        /* c8 ignore stop */
        const errorResponse = {
          suggestions: suggestionIds.map((id, index) => ({
            uuid: id,
            index,
            statusCode: 500,
            message: `Failed to initiate experiment: ${error.message}`,
          })),
          metadata: {
            total: suggestionIds.length,
            success: 0,
            failed: suggestionIds.length,
          },
        };
        return createResponse(errorResponse, 207);
      }
    }

    // Deploy all suggestions (regular + domain-wide) via tokowaka client
    let succeededSuggestions = [];
    const allTargetSuggestions = [
      ...validSuggestions,
      ...domainWideSuggestions.map(({ suggestion }) => suggestion),
    ];

    try {
      const tokowakaClient = TokowakaClient.createFrom(context);
      const deployResult = await tokowakaClient.deployToEdge({
        site,
        opportunity,
        targetSuggestions: allTargetSuggestions,
        allSuggestions,
        updatedBy: profile?.email || 'tokowaka-deployment',
      });

      succeededSuggestions = deployResult.succeededSuggestions;
      coveredSuggestionsCount = deployResult.coveredSuggestions.length;

      // Map failed suggestions to the API response format.
      deployResult.failedSuggestions.forEach((item) => {
        failedSuggestions.push({
          uuid: item.suggestion.getId(),
          index: suggestionIds.indexOf(item.suggestion.getId()),
          message: item.statusCode === 500 ? `Deployment failed: ${item.reason}` : item.reason,
          statusCode: item.statusCode ?? 400,
        });
      });

      context.log.info(`[edge-deploy] Successfully deployed ${succeededSuggestions.length} suggestions by ${profile?.email || 'tokowaka-deployment'}`);
    } catch (error) {
      context.log.error(`[edge-deploy-failed] site: ${apexBaseUrl}, Error deploying to edge: ${error.message}`, error);
      allTargetSuggestions.forEach((suggestion) => {
        failedSuggestions.push({
          uuid: suggestion.getId(),
          index: suggestionIds.indexOf(suggestion.getId()),
          message: 'Deployment failed: Internal server error',
          statusCode: 500,
        });
      });
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
    context.log.info(`[edge-deploy] response: ${JSON.stringify(response)}`);
    return createResponse(response, 207);
  };

  /**
   * Lists all geo experiments for a site (no prompts included).
   */
  const listGeoExperiments = async (context) => {
    const { siteId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not have access to this site');
    }

    const { data: experiments } = await GeoExperiment.allBySiteId(siteId);

    return ok(experiments.map((exp) => GeoExperimentDto.toJSON(exp)));
  };

  /**
   * Returns the full details of a geo experiment, including jobs summary and prompts.
   */
  const getGeoExperiment = async (context) => {
    const { siteId, geoExperimentId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(geoExperimentId)) {
      return badRequest('GeoExperiment ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not have access to this site');
    }

    const geoExperiment = await GeoExperiment.findById(geoExperimentId);
    if (!geoExperiment || geoExperiment.getSiteId() !== siteId) {
      return notFound('GeoExperiment not found');
    }

    // Fetch prompts from S3
    let prompts = null;
    try {
      const { s3Client, s3Bucket, GetObjectCommand } = context.s3;
      const promptsS3Key = geoExperiment.getPromptsLocation()
        || `geo-experiments/${siteId}/${geoExperimentId}-prompts.json`;
      const response = await s3Client.send(
        new GetObjectCommand({ Bucket: s3Bucket, Key: promptsS3Key }),
      );
      const body = await response.Body.transformToString();
      prompts = JSON.parse(body);
    } catch (s3Error) {
      // Prompts may not exist yet (e.g. experiment not yet started)
      context.log.info(`[geo-experiment] Could not fetch prompts for ${geoExperimentId}: ${s3Error.message}`);
    }

    return ok({
      ...GeoExperimentDto.toJSON(geoExperiment),
      prompts,
    });
  };

  /**
   * Patches a geo experiment. All fields are patchable except
   * createdAt, updatedAt, and updatedBy (managed automatically).
   */
  const patchGeoExperiment = async (context) => {
    const { siteId, geoExperimentId } = context.params;
    const { authInfo: { profile } } = context.attributes;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(geoExperimentId)) {
      return badRequest('GeoExperiment ID required');
    }

    const requestBody = context.data;
    if (!isObject(requestBody)) {
      return badRequest('Request body required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not have access to this site');
    }

    const geoExperiment = await GeoExperiment.findById(geoExperimentId);
    if (!geoExperiment || geoExperiment.getSiteId() !== siteId) {
      return notFound('GeoExperiment not found');
    }

    const PATCHABLE_FIELDS = [
      { key: 'name', setter: 'setName' },
      { key: 'status', setter: 'setStatus' },
      { key: 'phase', setter: 'setPhase' },
      { key: 'type', setter: 'setType' },
      { key: 'preScheduleId', setter: 'setPreScheduleId' },
      { key: 'postScheduleId', setter: 'setPostScheduleId' },
      { key: 'suggestionIds', setter: 'setSuggestionIds' },
      { key: 'promptsCount', setter: 'setPromptsCount' },
      { key: 'promptsLocation', setter: 'setPromptsLocation' },
      { key: 'startTime', setter: 'setStartTime' },
      { key: 'endTime', setter: 'setEndTime' },
      { key: 'metadata', setter: 'setMetadata' },
      { key: 'error', setter: 'setError' },
    ];

    let updates = false;
    for (const { key, setter } of PATCHABLE_FIELDS) {
      if (requestBody[key] !== undefined) {
        geoExperiment[setter](requestBody[key]);
        updates = true;
      }
    }

    if (!updates) {
      return badRequest('No valid fields to update');
    }

    geoExperiment.setUpdatedBy(profile?.email || 'geo-experiment');
    const updated = await geoExperiment.save();
    return ok(GeoExperimentDto.toJSON(updated));
  };

  /**
   * Deletes a geo experiment.
   */
  const deleteGeoExperiment = async (context) => {
    const { siteId, geoExperimentId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(geoExperimentId)) {
      return badRequest('GeoExperiment ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not have access to this site');
    }

    const geoExperiment = await GeoExperiment.findById(geoExperimentId);
    if (!geoExperiment || geoExperiment.getSiteId() !== siteId) {
      return notFound('GeoExperiment not found');
    }

    await geoExperiment.remove();
    return noContent();
  };

  const rollbackSuggestionFromEdge = async (context) => {
    const { siteId, opportunityId } = context.params;
    const { authInfo: { profile } } = context.attributes;

    context.log.info('[edge-rollback] request', {
      siteId,
      opportunityId,
      suggestionIdsCount: context.data?.suggestionIds?.length ?? 0,
      userId: profile?.email,
    });
    context.log.info(`[edge-rollback] suggestionIds: ${JSON.stringify(context.data?.suggestionIds)}`);

    const site = await Site.findById(siteId);
    if (!site) {
      context.log.warn(`[edge-rollback-failed] site ${siteId} not found`);
      return notFound('Site not found');
    }

    const apexBaseUrl = getHostName(site.getBaseURL()) || site.getBaseURL();

    if (!isNonEmptyObject(context.data)) {
      context.log.warn('[edge-rollback-failed] site: n/a, no request body data provided');
      return badRequest('No data provided');
    }
    const { suggestionIds } = context.data;
    if (!isArray(suggestionIds) || suggestionIds.length === 0) {
      context.log.warn('[edge-rollback-failed] site: n/a, suggestionIds is not a non-empty array');
      return badRequest('Request body must contain a non-empty array of suggestionIds');
    }

    // No productCode is passed to hasAccess(); the delegation block is not entered.
    // Org membership is the intended access gate for this endpoint.
    if (!await accessControlUtil.hasAccess(site)) {
      context.log.warn(`[edge-rollback-failed] site: ${apexBaseUrl}, user does not have access to the site.`);
      return forbidden('User does not belong to the organization');
    }

    if (!accessControlUtil.isLLMOAdministrator()) {
      context.log.warn('[edge-rollback-failed] site: n/a, user is not an LLMO administrator');
      return forbidden('Only LLMO administrators can rollback suggestions');
    }

    if (!await accessControlUtil.isOwnerOfSite(site)) {
      context.log.warn(`[edge-rollback-failed] site: ${apexBaseUrl}, user is not the owner of the site`);
      return forbidden('User does not have access to rollback edge optimize fixes for this site');
    }

    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      context.log.warn(`[edge-rollback-failed] site: ${apexBaseUrl}, opportunity ${opportunityId} not found`);
      return notFound('Opportunity not found');
    }

    // Fetch all suggestions for this opportunity
    const allSuggestions = await Suggestion.allByOpportunityId(opportunityId);

    context.log.info(`[edge-rollback] allSuggestions count: ${allSuggestions.length}`);

    // Track valid, failed, and missing suggestions
    const validSuggestions = [];
    const failedSuggestions = [];

    // Check each requested suggestion
    suggestionIds.forEach((suggestionId, index) => {
      const suggestion = allSuggestions.find((s) => s.getId() === suggestionId);

      if (!suggestion) {
        context.log.warn(`[edge-rollback-failed] site: ${apexBaseUrl}, suggestion ${suggestionId} not found`);
        failedSuggestions.push({
          uuid: suggestionId,
          index,
          message: 'Suggestion not found',
          statusCode: 404,
        });
      } else {
        // For rollback, check if suggestion has been deployed
        const hasBeenDeployed = suggestion.getData()?.edgeDeployed;
        if (!hasBeenDeployed) {
          context.log.warn(`[edge-rollback-failed] site: ${apexBaseUrl}, suggestion ${suggestionId} hasn't been deployed, can't rollback`);
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
    context.log.info(`[edge-rollback] validSuggestions count: ${validSuggestions.length},
      failedSuggestions count: ${failedSuggestions.length}`);
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

            // Remove edgeDeployed (and legacy tokowakaDeployed) from the domain-wide suggestion
            const currentData = suggestion.getData();
            delete currentData.edgeDeployed;
            // TODO: To be removed, kept for backward compatibility
            delete currentData.tokowakaDeployed;
            delete currentData.edgeDeployed;
            suggestion.setData(currentData);
            suggestion.setUpdatedBy(profile?.email || 'tokowaka-rollback');
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
                  delete coveredData.edgeDeployed;
                  // TODO: To be removed, kept for backward compatibility
                  delete coveredData.tokowakaDeployed;
                  delete coveredData.edgeDeployed;
                  delete coveredData.coveredByDomainWide;
                  coveredSuggestion.setData(coveredData);
                  coveredSuggestion.setUpdatedBy(profile?.email || 'domain-wide-rollback');
                  return coveredSuggestion.save();
                }),
              );
            }
          } catch (error) {
            context.log.error(`[edge-rollback-failed] site: ${apexBaseUrl}, Error rolling back domain-wide suggestion ${suggestion.getId()}: ${error.message}`, error);
            failedSuggestions.push({
              uuid: suggestion.getId(),
              index: suggestionIds.indexOf(suggestion.getId()),
              message: `Rollback failed: ${error.message}`,
              statusCode: 500,
            });
          }
        }
      } catch (error) {
        context.log.error(`[edge-rollback-failed] site: ${apexBaseUrl}, Error during domain-wide rollback: ${error.message}`, error);
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

        // Update successfully rolled back suggestions
        // - remove edgeDeployed (and legacy tokowakaDeployed) timestamp
        succeededSuggestions = await Promise.all(
          processedSuggestions.map(async (suggestion) => {
            const currentData = suggestion.getData();
            delete currentData.edgeDeployed;
            // TODO: To be removed, kept for backward compatibility
            delete currentData.tokowakaDeployed;
            delete currentData.edgeDeployed;
            suggestion.setData(currentData);
            suggestion.setUpdatedBy(profile?.email || 'tokowaka-rollback');
            return suggestion.save();
          }),
        );

        // Add ineligible suggestions to failed list
        ineligibleSuggestions.forEach((item) => {
          context.log.info(`[edge-rollback-failed] site: ${apexBaseUrl}, ${opportunity.getType()}`
          + ` suggestion ${item.suggestion.getId()} is ineligible: ${item.reason}`);
          failedSuggestions.push({
            uuid: item.suggestion.getId(),
            index: suggestionIds.indexOf(item.suggestion.getId()),
            message: item.reason,
            statusCode: 400,
          });
        });

        context.log.info(`[edge-rollback] Successfully rolled back ${succeededSuggestions.length} suggestions from Edge by ${profile?.email || 'tokowaka-rollback'}`);
      } catch (error) {
        context.log.error(`[edge-rollback-failed] site: ${apexBaseUrl}, Error during Tokowaka rollback: ${error.message}`, error);
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

    context.log.info(`[edge-rollback] response: ${JSON.stringify(response)}`);
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
          'User-Agent': 'Tokowaka-AI Tokowaka/1.0 AdobeEdgeOptimize-AI AdobeEdgeOptimize/1.0',
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

  /**
   * Revokes a suggestion grant by grant ID.
   * @param {Object} context - Request context.
   * @returns {Promise<Response>} 204 on success, 404 if not found.
   */
  const revokeGrant = async (context) => {
    const siteId = context.params?.siteId;
    const grantId = context.params?.grantId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(grantId)) {
      return badRequest('Grant ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not belong to the organization');
    }

    try {
      const result = await SuggestionGrant.revokeSuggestionGrant(grantId);
      if (!result.success) {
        return notFound('Grant not found');
      }
      return noContent();
    } catch (e) {
      context.log.error(`Error revoking suggestion grant ${grantId}`, e);
      return createResponse({ message: 'Error revoking grant' }, 500);
    }
  };

  return {
    autofixSuggestions,
    createSuggestions,
    deploySuggestionToEdge,
    listGeoExperiments,
    getGeoExperiment,
    patchGeoExperiment,
    deleteGeoExperiment,
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
    revokeGrant,
  };
}

export default SuggestionsController;
