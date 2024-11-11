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

import { createResponse, hashWithSHA256 } from '@adobe/spacecat-shared-http-utils';
import { hasText, isObject, isValidUrl } from '@adobe/spacecat-shared-utils';
import crypto from 'crypto';
import { ErrorWithStatusCode } from '../support/utils.js';
import {
  STATUS_BAD_REQUEST,
  STATUS_CREATED,
  STATUS_FORBIDDEN,
  STATUS_NO_CONTENT,
  STATUS_UNAUTHORIZED,
} from '../utils/constants.js';
import { ApiKeyDto } from '../dto/api-key.js';

/**
 * ApiKey Controller. Provides methods for managing API keys such as create, delete, and get.
 * @param {Object} context - The context the universal serverless function.
 * @param context.env - Environment details.
 * @param context.env.API_KEY_CONFIGURATION - Configuration for the API key.
 * @returns {Object} ApiKey Controller
 * @constructor
 */
function ApiKeyController(context) {
  const status = {
    ACTIVE: 'ACTIVE',
    INACTIVE: 'INACTIVE',
  };
  const {
    dataAccess, log, env, attributes, imsClient,
  } = context;

  let apiKeyConfiguration = {};
  try {
    apiKeyConfiguration = JSON.parse(env.API_KEY_CONFIGURATION);
  } catch (error) {
    log.error(`Failed to parse API Key configuration: ${error.message}`);
  }

  const { maxDomainsPerApiKey = 1, maxApiKeys = 3 } = apiKeyConfiguration;
  const HEADER_ERROR = 'x-error';

  function createErrorResponse(error) {
    return createResponse({}, error.status || 500, {
      [HEADER_ERROR]: error.message,
    });
  }

  function validateRequestData(data) {
    if (!isObject(data)) {
      throw new ErrorWithStatusCode('Invalid request: missing application/json request data', STATUS_BAD_REQUEST);
    }

    if (!Array.isArray(data.features) || data.features.length === 0) {
      throw new ErrorWithStatusCode('Invalid request: missing features in request data', STATUS_BAD_REQUEST);
    }

    if (!Array.isArray(data.domains) || data.domains.length === 0) {
      throw new ErrorWithStatusCode('Invalid request: missing domains in request data', STATUS_BAD_REQUEST);
    }

    data.urls.forEach((url) => {
      if (!isValidUrl(url)) {
        throw new ErrorWithStatusCode(`Invalid request: ${url} is not a valid URL`, STATUS_BAD_REQUEST);
      }
    });

    if (!hasText(data.name)) {
      throw new ErrorWithStatusCode('Invalid request: missing name in request data', STATUS_BAD_REQUEST);
    }
  }

  function validateImsOrgId(imsOrgId, imsUserToken) {
    if (!imsUserToken || !imsUserToken.startsWith('Bearer ')) {
      throw new ErrorWithStatusCode('Missing Authorization header', STATUS_UNAUTHORIZED);
    }
    if (!imsOrgId) {
      throw new ErrorWithStatusCode('Missing x-ims-gw-org-id header', STATUS_UNAUTHORIZED);
    }
    const bearerToken = imsUserToken.replace('Bearer ', '');
    const imsUserProfile = imsClient.getImsUserProfile(bearerToken);
    const { organizations } = imsUserProfile;
    if (!organizations.includes(imsOrgId)) {
      throw new ErrorWithStatusCode('Invalid request: Organization not found', STATUS_UNAUTHORIZED);
    }
  }

  /**
   * Create a new API key.
   * @param {Object} requestContext - Context of the request.
   * @returns {Promise<Response>} 201 Created with the new API key.
   */
  async function createApiKey(requestContext) {
    const { data, pathInfo: { headers } } = requestContext;
    const imsOrgId = headers['x-ims-gw-org-id'];

    try {
      // Parse out the bearer token here Bearer <token>
      const imsUserToken = headers.Authorization;

      validateRequestData(data);
      validateImsOrgId(imsOrgId, imsUserToken);

      // Check if the domains are within the limit
      if (data.domains.length > maxDomainsPerApiKey) {
        throw new ErrorWithStatusCode('Invalid request: Exceeds the number of domains allowed', STATUS_FORBIDDEN);
      }

      const { authInfo: { profile } } = attributes;

      // Currently the email is assigned as the imsUserId
      const imsUserId = profile.email;

      // Check whether the user has already created the maximum number of
      // active API keys for the given imsOrgId
      const apiKeys = dataAccess.getApiKeysByImsOrgIdAndImsUserId(imsUserId, imsOrgId);

      const activeApiKeys = apiKeys.filter(
        (apiKey) => apiKey.status !== status.INACTIVE
            || (apiKey.expiresAt && new Date(apiKey.expiresAt) > new Date()),
      );

      if (activeApiKeys && activeApiKeys.length >= maxApiKeys) {
        throw new ErrorWithStatusCode('Invalid request: Exceeds the number of API keys allowed', STATUS_FORBIDDEN);
      }

      // Create the API key
      const apiKey = crypto.randomUUID();
      const hashedApiKey = hashWithSHA256(apiKey);

      let scopes = {};

      // We manually set the scopes initially to imports.read and imports.write
      if (data.features.includes('imports')) {
        // We need to set the scopes based on the domains.
        // Initially there will be only 1 domain allowed
        scopes = [
          {
            name: 'imports.read',
          },
          ...data.domains.map((domain) => ({
            name: 'imports.write',
            domains: domain,
          })),
        ];
      }

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 6);

      const apiKeyEntity = dataAccess.createNewApiKey({
        name: data.name,
        scopes,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        imsOrgId,
        imsUserId,
        hashedApiKey,
        status: status.ACTIVE,
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
   * @returns {Promise<Response>} 204 No Content.
   */
  async function deleteApiKey(requestContext) {
    const { pathInfo: { headers }, params: { id } } = requestContext;
    const imsOrgId = headers['x-ims-gw-org-id'];

    try {
      validateImsOrgId(imsOrgId);
      const apiKeyEntity = dataAccess.getApiKeyById(id);
      const { authInfo: { profile } } = attributes;

      // Currently the email is assigned as the imsUserId
      const imsUserId = profile.email;
      if (apiKeyEntity.getImsUserId() !== imsUserId || apiKeyEntity.getImsOrgId() !== imsOrgId) {
        throw new ErrorWithStatusCode('Invalid request: API key not found', STATUS_FORBIDDEN);
      }

      apiKeyEntity.updateStatus(status.INACTIVE);
      apiKeyEntity.setDeletedAt(new Date().toISOString());

      await dataAccess.updateApiKey(apiKeyEntity);
      return createResponse({}, STATUS_NO_CONTENT);
    } catch (error) {
      log.error(`Failed to delete the api key with id: ${id} - ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Retrieve an API key.
   * @param {Object} context - Context of the request.
   * @returns {Promise<Response>} 200 OK with the list of ApiKey metadata.
   */
  async function getApiKeys(requestContext) {
    const { pathInfo: { headers } } = requestContext;
    const imsOrgId = headers['x-ims-gw-org-id'];

    validateImsOrgId(imsOrgId);
    return createResponse({}, 501);
  }

  return {
    createApiKey,
    deleteApiKey,
    getApiKeys,
  };
}

export default ApiKeyController;
