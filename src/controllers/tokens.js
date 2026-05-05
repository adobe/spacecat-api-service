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

import {
  badRequest,
  notFound,
  ok,
  forbidden,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  isNonEmptyObject,
  isValidUUID,
  hasText,
  isInteger,
} from '@adobe/spacecat-shared-utils';

import { TokenDto } from '../dto/token.js';
import { SuggestionGrantDto } from '../dto/suggestion-grant.js';
import AccessControlUtil from '../support/access-control-util.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Tokens controller. Provides methods to read token allocations by site.
 * @param {object} ctx - Context of the request.
 * @returns {object} Tokens controller.
 * @constructor
 */
function TokensController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Token, Site, SuggestionGrant } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Lists all tokens for a site with optional filters and cursor-based pagination.
   * Filters (tokenTypes, cycle) are applied in the application layer since no
   * compound index exists over (siteId, tokenType, cycle).
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Paginated list of tokens.
   */
  const getAll = async (context) => {
    const { siteId } = context.params;
    const {
      limit: limitParam = DEFAULT_LIMIT,
      cursor,
      tokenTypes: rawTokenTypes,
      cycle,
    } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const parsedLimit = parseInt(limitParam, 10);
    if (!isInteger(parsedLimit) || parsedLimit < 1) {
      return badRequest('Limit must be a positive integer');
    }
    const effectiveLimit = Math.min(parsedLimit, MAX_LIMIT);

    // Normalise tokenTypes to an array regardless of how it arrives (comma-separated string or
    // repeated query param that the bodyData middleware coerces to an array).
    const tokenTypeFilter = rawTokenTypes
      ? (Array.isArray(rawTokenTypes) ? rawTokenTypes : rawTokenTypes.split(','))
        .map((t) => t.trim()).filter(Boolean)
      : [];

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Access denied to this site');
      }

      const queryOptions = {
        limit: effectiveLimit,
        cursor,
        returnCursor: true,
        ...(hasText(cycle) && { cycle }),
        ...(tokenTypeFilter.length > 0 && { tokenTypes: tokenTypeFilter }),
      };

      const results = await Token.allBySiteId(siteId, queryOptions);

      return ok({
        tokens: (results.data || []).map(TokenDto.toJSON),
        pagination: {
          limit: effectiveLimit,
          cursor: results.cursor ?? null,
          hasMore: !!results.cursor,
        },
      });
    } catch (e) {
      context.log.error(`Error getting tokens for site ${siteId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Gets the current-cycle token for a site by token type.
   * Uses createIfNotFound=false so no token is auto-created on reads.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Token response.
   */
  const getByTokenType = async (context) => {
    const { siteId, tokenType } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!hasText(tokenType)) {
      return badRequest('Token type required');
    }

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Access denied to this site');
      }

      const token = await Token.findBySiteIdAndTokenType(siteId, tokenType, true);
      if (!token) {
        return notFound('Token not found for the current cycle');
      }

      return ok(TokenDto.toJSON(token));
    } catch (e) {
      context.log.error(`Error getting token by type ${tokenType} for site ${siteId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  /**
   * Gets all suggestion grants for a token.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} List of suggestion grants.
   */
  const getGrants = async (context) => {
    const { siteId, tokenId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }
    if (!isValidUUID(tokenId)) {
      return badRequest('Token ID required');
    }

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('Access denied to this site');
      }

      const token = await Token.findById(tokenId);
      if (!token || token.getSiteId() !== siteId) {
        return notFound('Token not found');
      }

      const grants = await SuggestionGrant.allByIndexKeys({ tokenId });
      return ok(grants.map(SuggestionGrantDto.toJSON));
    } catch (e) {
      context.log.error(`Error getting grants for token ${tokenId} on site ${siteId}: ${e.message}`);
      return internalServerError(e.message);
    }
  };

  return {
    getAll,
    getByTokenType,
    getGrants,
  };
}

export default TokensController;
