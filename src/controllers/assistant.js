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

import {
  createResponse,
} from '@adobe/spacecat-shared-http-utils';
import { isObject } from '@adobe/spacecat-shared-utils';
import { AssistantDto } from '../dto/assistant-response.js';
import {
  commandConfig,
  fetchFirefallCompletion,
  SCOPE,
  validateAccessScopes,
  STATUS,
} from '../support/assistant-support.js';
import { ErrorWithStatusCode } from '../support/utils.js';

/**
 * Assistant controller. Provides methods to perform AI assisted operations.
 * There are certain commands that can be executed by the assistant. Depending on the command
 * there has to be certain inputs such as prompt and imageUrl.  A call is made to
 * Firefall, and the response is returned.
 * @param {UniversalContext} context - The context of the universal serverless function.
 * @param {string} context.env.ASSISTANT_CONFIGURATION - Configuration params, as a JSON string.
 * @returns {object} Import assistant controller.
 * @constructor
 */
function AssistantController(context) {
  const HEADER_ERROR = 'x-error';
  const { auth, log } = context;

  function createErrorResponse(error) {
    return createResponse({}, error.status, {
      [HEADER_ERROR]: error.message,
    });
  }

  function isBase64UrlImage(base64String) {
    return base64String.startsWith('data:image/') && base64String.endsWith('=') && base64String.includes('base64');
  }

  function validateRequestData(data) {
    const {
      command, prompt, imageUrl,
    } = data;

    // Validate 'command'
    if (!command) {
      throw new ErrorWithStatusCode('Invalid request: command is required.', STATUS.BAD_REQUEST);
    }
    const currentCommandConfig = commandConfig[command];
    if (!currentCommandConfig) {
      throw new ErrorWithStatusCode(`Invalid request: command not implemented: ${command}`, STATUS.BAD_REQUEST);
    }

    if (currentCommandConfig.parameters.includes('prompt') && !prompt) {
      throw new ErrorWithStatusCode('Invalid request: prompt is required.', STATUS.BAD_REQUEST);
    }

    if (currentCommandConfig.parameters.includes('imageUrl')) {
      if (!imageUrl) {
        throw new ErrorWithStatusCode('Invalid request: Image url is required.', STATUS.BAD_REQUEST);
      }
      // Only base64 images for now.
      if (!isBase64UrlImage(imageUrl)) {
        throw new ErrorWithStatusCode('Invalid request: Image url is not a base64 encoded image.', STATUS.BAD_REQUEST);
      }
    }
  }

  function parseRequestContext(requestContext) {
    if (!requestContext || !isObject(requestContext)) {
      throw new ErrorWithStatusCode('Invalid request: missing request context.', STATUS.BAD_REQUEST);
    }
    if (!requestContext.data || !requestContext.attributes) {
      throw new ErrorWithStatusCode('Invalid request: invalid request context format.', STATUS.BAD_REQUEST);
    }

    let assistantConfiguration;
    if (!context.env.ASSISTANT_CONFIGURATION) {
      throw new ErrorWithStatusCode('The Assistant Configuration is not defined.', STATUS.SYS_ERROR);
    }
    try {
      assistantConfiguration = JSON.parse(context.env.ASSISTANT_CONFIGURATION);
    } catch (error) {
      throw new ErrorWithStatusCode(`Could not parse the Assistant Configuration: ${error.message}`, STATUS.SYS_ERROR);
    }

    const { data: { command, prompt, options }, attributes } = requestContext;
    const { imageUrl, ...otherOptions } = options || {};
    const { authInfo: { profile } } = attributes;
    const requestData = {
      env: {
        ...context.env,
        ...assistantConfiguration,
        FIREFALL_API_KEY: assistantConfiguration.IMS_CLIENT_ID,
      },
      command,
      prompt,
      imageUrl,
      llmModel: commandConfig[command]?.llmModel,
      responseFormat: commandConfig[command]?.responseFormat,
      importApiKey: requestContext.pathInfo.headers['x-api-key'],
      apiKeyName: profile?.getName(),
      imsOrgId: profile?.getImsOrgId() ?? requestContext.pathInfo.headers['x-gw-ims-org-id'] ?? 'N/A',
      otherOptions,
    };

    validateRequestData(requestData);

    return requestData;
  }

  /**
   * Send an import assistant request to the model.
   * @param {object} requestContext - Context of the request.
   * @param {object} requestContext.data application/json - Parsed application/json request data.
   * @param {object} requestContext.pathInfo.headers - HTTP request headers.
   * @returns {Promise<Response>} 200 OK with a list of options, 4xx or 5xx otherwise.
   */
  async function processImportAssistant(requestContext) {
    try {
      validateAccessScopes(auth, [SCOPE.ASSISTANT], log);

      const requestData = parseRequestContext(requestContext);
      const { command, apiKeyName, imsOrgId } = requestData;

      log.info(`Running assistant command ${command} using key ${apiKeyName} for org ${imsOrgId}.`);

      // Call the assistant model.
      const firefallResponse = await fetchFirefallCompletion(requestData, log);
      const firefallDto = AssistantDto.toJSON(firefallResponse);
      return createResponse(firefallDto, STATUS.OK);
    } catch (error) {
      log.error(`Failed to run assistant command: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  return {
    processImportAssistant,
  };
}

export default AssistantController;
