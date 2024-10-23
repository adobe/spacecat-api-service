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

import { createResponse } from '@adobe/spacecat-shared-http-utils';
import { ErrorWithStatusCode } from '../support/utils.js';

/**
 * ApiKey Controller. Provides methods for managing API keys such as create, delete, and get.
 * @returns {Object} ApiKey Controller
 * @constructor
 */
function ApiKeyController(context) {
  // eslint-disable-next-line no-unused-vars
  const { log } = context;
  const HEADER_ERROR = 'x-error';

  function createErrorResponse(error) {
    return createResponse({}, error.status, {
      [HEADER_ERROR]: error.message,
    });
  }

  // eslint-disable-next-line no-unused-vars
  function validateRequestData(data) {
    // Not implemented yet
  }

  // eslint-disable-next-line no-unused-vars
  function validateImsOrgId(imsOrgId) {
    // Not implemented yet
  }

  /**
   * Create a new API key.
   * @param {Object} requestContext - Context of the request.
   * @returns {Promise<Response>} 201 Created with the new API key.
   */
  async function createApiKey(requestContext) {
    const { data, pathInfo: { headers } } = requestContext;
    const imsOrgId = headers['x-ims-gw-org-id'];

    validateRequestData(data);
    validateImsOrgId(imsOrgId);

    if (data) {
      const error = new ErrorWithStatusCode('Create API key not implemented', 501);
      return createErrorResponse(error);
    }
    return createResponse({}, 501);
  }

  /**
   * Delete an API key.
   * @param {Object} requestContext - Context of the request.
   * @returns {Promise<Response>} 204 No Content.
   */
  async function deleteApiKey(requestContext) {
    const { pathInfo: { headers }, params: { id } } = requestContext;
    const imsOrgId = headers['x-ims-gw-org-id'];

    validateImsOrgId(imsOrgId);
    if (id) {
      const error = new ErrorWithStatusCode('Delete API key not implemented', 501);
      return createErrorResponse(error);
    }
    return createResponse({}, 501);
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
