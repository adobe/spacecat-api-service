/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { createResponse, hashWithSHA256, ok } from '@adobe/spacecat-shared-http-utils';
import { hasText, isObject, isValidUrl } from '@adobe/spacecat-shared-utils';
import crypto from 'crypto';
import { ErrorWithStatusCode } from '../support/utils.js';
import {
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_BAD_REQUEST,
  STATUS_CREATED,
  STATUS_FORBIDDEN,
  STATUS_NO_CONTENT,
  STATUS_UNAUTHORIZED, STATUS_NOT_FOUND,
} from '../utils/constants.js';
import { ApiKeyDto } from '../dto/api-key.js';

/**
 * ApiKey Controller. Provides methods for managing API keys such as create, delete, and get.
 * @param {object} context - The context of the universal serverless function.
 * @param {object} context.env - Environment details.
 * @param {object} context.env.API_KEY_CONFIGURATION - Configuration for the API key controller.
 * @param {DataAccess} context.dataAccess - Data access.
 * @param {Logger} context.log - Logger.
 * @param {object} context.attributes - Attributes that include the user's profile details
 * @param {ImsClient} context.imsClient - IMS Client.
 * @returns {object} ApiKey Controller
 * @constructor
 */
function ApiKeyController(context) {
  const {
    dataAccess, log, env, attributes, imsClient,
  } = context;
  const { ApiKey } = dataAccess;

  let apiKeyConfiguration = {};
  try {
    apiKeyConfiguration = JSON.parse(env.API_KEY_CONFIGURATION);
  } catch (error) {
    log.error(`Failed to parse API Key configuration: ${error.message}`);
  }

  const { maxDomainsPerApiKey = 1, maxApiKeys = 3 } = apiKeyConfiguration;
  const HEADER_ERROR = 'x-error';

  function createErrorResponse(error) {
    return createResponse({}, error.status || STATUS_INTERNAL_SERVER_ERROR, {
      [HEADER_ERROR]: error.message,
    });
  }

  /**
   * Validate the request data.
   * @type {{features: string[], domains: string[], name: string}}
   * @param {object} data - The request data.
   * @throws {ErrorWithStatusCode} If the request data is invalid.
   */
  function validateRequestData(data) {
    if (!isObject(data)) {
      throw new ErrorWithStatusCode('Invalid request: missing application/json request data', STATUS_BAD_REQUEST);
    }

    if (!Array.isArray(data.features) || data.features.length === 0) {
      throw new ErrorWithStatusCode('Invalid request: missing features in the request data', STATUS_BAD_REQUEST);
    }

    if (!Array.isArray(data.domains) || data.domains.length === 0) {
      throw new ErrorWithStatusCode('Invalid request: missing domains in the request data', STATUS_BAD_REQUEST);
    }

    data.domains.forEach((url) => {
      if (!isValidUrl(url)) {
        throw new ErrorWithStatusCode(`Invalid request: ${url} is not a valid domain`, STATUS_BAD_REQUEST);
      }
    });

    if (!hasText(data.name)) {
      throw new ErrorWithStatusCode('Invalid request: missing name in the request data', STATUS_BAD_REQUEST);
    }
  }

  /**
   * Validate the IMS Org ID.
   * @param {string} imsOrgId - The IMS Organization ID of the user.
   * @param {string} imsUserToken - The IMS User access token provided by the user.
   * @throws {ErrorWithStatusCode} If the IMS Org ID is invalid or
   * if the user does not belong to the given imsOrg.
   * @returns {object} imsUserProfile - The IMS User profile.
   */
  async function validateImsOrgId(imsOrgId, imsUserToken) {
    if (!hasText(imsOrgId)) {
      throw new ErrorWithStatusCode('Missing x-gw-ims-org-id header', STATUS_UNAUTHORIZED);
    }
    const imsUserProfile = await imsClient.getImsUserProfile(imsUserToken);
    const { organizations } = imsUserProfile;
    if (!organizations.includes(imsOrgId)) {
      throw new ErrorWithStatusCode('Invalid request: Unable to find a reference to the Organization provided.', STATUS_UNAUTHORIZED);
    }
    return imsUserProfile;
  }

  /**
   * Get the IMS user token from the headers.
   * @param {object} headers - The headers of the request.
   * @returns {string} imsUserToken - The IMS User access token.
   * @throws {ErrorWithStatusCode} - If the Authorization header is missing.
   */
  function getImsUserToken(headers) {
    const { authorization: authorizationHeader } = headers;
    const BEARER_PREFIX = 'Bearer ';
    if (!hasText(authorizationHeader)) {
      throw new ErrorWithStatusCode('Missing Authorization header', STATUS_UNAUTHORIZED);
    }
    return authorizationHeader.startsWith(BEARER_PREFIX)
      ? authorizationHeader.substring(BEARER_PREFIX.length) : authorizationHeader;
  }

  /**
   * Get the IMS User ID from the profile. Currently, the email is assigned as the imsUserId.
   * @param {object} profile
   * @returns {string} imsUserId - The IMS User ID.
   */
  function getImsUserIdFromProfile(profile) {
    // While the property is named 'profile.email', it is in fact the user's IMS User Id
    return profile.email;
  }

  /**
   * Create a new API key.
   * @param {Object} requestContext - Context of the request.
   * @returns {Promise<ApiKey>} - 201 Created with the new API key.
   */
  async function createApiKey(requestContext) {
    const { data, pathInfo: { headers } } = requestContext;
    const imsOrgId = headers['x-gw-ims-org-id'];

    try {
      const imsUserToken = getImsUserToken(headers);

      validateRequestData(data);
      const imsUserProfile = await validateImsOrgId(imsOrgId, imsUserToken);

      // Check if the domains are within the limit. Currently, we only allow one domain per API key.
      if (data.domains.length > maxDomainsPerApiKey) {
        throw new ErrorWithStatusCode(`Invalid request: Exceeds the limit of ${maxDomainsPerApiKey} allowed domain(s)`, STATUS_FORBIDDEN);
      }

      const { authInfo: { profile } } = attributes;

      const imsUserId = getImsUserIdFromProfile(profile);

      // Check whether the user has already created the maximum number of
      // active API keys for the given imsOrgId.
      const apiKeys = await ApiKey.allByImsOrgIdAndImsUserId(imsOrgId, imsUserId);

      const validApiKeys = apiKeys.filter(
        (apiKey) => apiKey.isValid(),
      );

      // Check if the user has reached the maximum number of API keys.
      // Currently, we only allow 3 API keys per user.
      if (validApiKeys && validApiKeys.length >= maxApiKeys) {
        throw new ErrorWithStatusCode(`Invalid request: Exceeds the limit of ${maxApiKeys} allowed API keys`, STATUS_FORBIDDEN);
      }

      const { email } = imsUserProfile;
      let username;
      if (hasText(email)) {
        [username] = email.split('@');
      }

      // Create the API key
      const apiKey = username ? `${username}-${crypto.randomUUID()}` : crypto.randomUUID();
      const hashedApiKey = hashWithSHA256(apiKey);

      let scopes = {};

      // In response to an 'imports' feature request, we set the scopes to
      // imports.read and imports.write
      if (data.features.includes('imports')) {
        scopes = [
          {
            name: 'imports.read',
          },
          {
            name: 'imports.write',
            domains: data.domains,
          },
        ];
      }

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 6);

      const apiKeyEntity = await ApiKey.create({
        name: data.name,
        scopes,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        imsOrgId,
        imsUserId,
        hashedApiKey,
      });

      return createResponse(ApiKeyDto.toJSON(apiKeyEntity, apiKey), STATUS_CREATED);
    } catch (error) {
      log.error(`Failed to create a new api key: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Delete an API key.
   * @param {Object} requestContext - Context of the request.
   * @returns {Promise<Response>} - 204 No Content.
   */
  async function deleteApiKey(requestContext) {
    const { pathInfo: { headers }, params: { id } } = requestContext;
    const imsOrgId = headers['x-gw-ims-org-id'];

    try {
      const imsUserToken = getImsUserToken(headers);
      await validateImsOrgId(imsOrgId, imsUserToken);
      const apiKeyEntity = await ApiKey.findById(id);
      const { authInfo: { profile } } = attributes;

      const imsUserId = getImsUserIdFromProfile(profile);
      if (!apiKeyEntity
          || apiKeyEntity.getImsUserId() !== imsUserId || apiKeyEntity.getImsOrgId() !== imsOrgId) {
        throw new ErrorWithStatusCode('Invalid request: API key not found', STATUS_NOT_FOUND);
      }

      apiKeyEntity.setDeletedAt(new Date().toISOString());

      await apiKeyEntity.save();
      return createResponse({}, STATUS_NO_CONTENT);
    } catch (error) {
      log.error(`Failed to delete the api key with id: ${id} - ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Retrieve the API keys relating to a specific imsUserId and imsOrgId combination.
   * @param {Object} context - Context of the request.
   * @returns {Promise<ApiKey[]>} - 200 OK with the list of ApiKey metadata.
   */
  async function getApiKeys(requestContext) {
    const { pathInfo: { headers } } = requestContext;
    const imsOrgId = headers['x-gw-ims-org-id'];

    try {
      const imsUserToken = getImsUserToken(headers);
      await validateImsOrgId(imsOrgId, imsUserToken);
      const { authInfo: { profile } } = attributes;

      const imsUserId = getImsUserIdFromProfile(profile);
      const apiKeys = await ApiKey.allByImsOrgIdAndImsUserId(imsOrgId, imsUserId);
      return ok(apiKeys.map((apiKey) => ApiKeyDto.toJSON(apiKey)));
    } catch (error) {
      log.error(`Failed to retrieve the api keys - ${error.message}`);
      return createErrorResponse(error);
    }
  }

  return {
    createApiKey,
    deleteApiKey,
    getApiKeys,
  };
}

export default ApiKeyController;
