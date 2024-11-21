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
  mergePrompt,
  validateAccessScopes,
  SCOPE,
  STATUS,
} from '../support/assistant-support.js';
import { ErrorWithStatusCode } from '../support/utils.js';

/**
 * Assistant controller. Provides methods to perform AI assisted operations.
 * There are specific commands that can be executed by the assistant. Depending on the command
 * there will to be required inputs, such as prompt and imageUrl.  A call is made to
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
    return base64String.startsWith('data:image/') && base64String.includes('base64');
  }

  function processAndValidateContextEnv(contextEnv) {
    let env = {};

    // Process AWS secrets
    if (!contextEnv.ASSISTANT_CONFIGURATION) {
      throw new ErrorWithStatusCode('The Assistant Configuration value is not defined.', STATUS.SYS_ERROR);
    }
    try {
      const assistantConfiguration = JSON.parse(contextEnv.ASSISTANT_CONFIGURATION);
      // The IMS_CLIENT_ID is used as the API key for Firefall.
      env = {
        ...contextEnv,
        ...assistantConfiguration,
        FIREFALL_API_KEY: assistantConfiguration.IMS_CLIENT_ID,
      };
      delete env.ASSISTANT_CONFIGURATION;
    } catch (error) {
      throw new ErrorWithStatusCode(`Could not parse the Assistant Configuration: ${error.message}`, STATUS.SYS_ERROR);
    }

    if (!env.ASSISTANT_PROMPTS) {
      throw new ErrorWithStatusCode('The Assistant Prompts value is not defined.', STATUS.SYS_ERROR);
    }
    try {
      env.ASSISTANT_PROMPTS = JSON.parse(env.ASSISTANT_PROMPTS);
    } catch (error) {
      throw new ErrorWithStatusCode(`Could not parse the Assistant Prompts: ${error.message}`, STATUS.SYS_ERROR);
    }

    return env;
  }

  function validateRequestData(data) {
    const { command } = data;

    // Validate 'command'
    if (!command || !/^[A-Za-z]+$/.test(command)) {
      throw new ErrorWithStatusCode('Invalid request: a valid command is required.', STATUS.BAD_REQUEST);
    }
    if (!commandConfig[command]) {
      throw new ErrorWithStatusCode(`Invalid request: command not implemented: ${command}`, STATUS.BAD_REQUEST);
    }

    const { parameters } = commandConfig[command];
    // Validate command parameters.
    parameters.forEach((param) => {
      if (!data[param]) {
        throw new ErrorWithStatusCode(`Invalid request: ${param} is required for ${command}.`, STATUS.BAD_REQUEST);
      }
    });

    if (parameters.includes('imageUrl')) {
      // Only base64 images for now.
      if (!isBase64UrlImage(data.imageUrl)) {
        throw new ErrorWithStatusCode('Invalid request: Image url is not a base64 encoded image.', STATUS.BAD_REQUEST);
      }
    }
  }

  // TODO: remove `headerImsOrgId` check when the api-key will have it in the profile.
  function validateRequestAttributes(attributes, headerImsOrgId) {
    if (!attributes.authInfo) {
      throw new ErrorWithStatusCode('Invalid request: missing authentication information.', STATUS.UNAUTHORIZED);
    }
    if (!attributes.authInfo.profile) {
      throw new ErrorWithStatusCode('Invalid request: missing authentication profile.', STATUS.UNAUTHORIZED);
    }

    const { authInfo: { profile: apikeyProfile } } = attributes;

    const callerImsOrgId = apikeyProfile?.getImsOrgId() ?? headerImsOrgId;
    if (!callerImsOrgId) {
      throw new ErrorWithStatusCode(
        'Invalid request: A valid ims-org-id is not associated with your api-key.',
        STATUS.UNAUTHORIZED,
      );
    }
  }

  /**
   * Process and validate the request context.
   * @param requestContext
   * @param requestContext.data Object containing the request parameters
   * @param requestContext.data.command String indicating the command to execute
   * @param requestContext.data.prompt String containing the user prompt
   * @param requestContext.data.htmlContent String containing the HTML content
   * @param requestContext.data.selector CSS selectors of the block being processed
   * @param requestContext.data.imageUrl String base64 encoded image
   * @param requestContext.attributes Object containing request processing (api-key, profile, etc.)
   * @param requestContext.pathInfo Object containing the request path and headers
   * @param requestContext.pathInfo.headers Object containing the request headers
   * @param requestContext.pathInfo.headers.x-api-key String api-key
   * @param requestContext.pathInfo.headers.x-gw-ims-org-id String ims-org-id
   * @param requestContext.env Object containing the environment variables (secrets, etc.)
   * @param requestContext.env.ASSISTANT_CONFIGURATION Object containing the assistant configuration
   * @param requestContext.env.ASSISTANT_PROMPTS Object containing the assistant prompts
   * @returns the validated and parsed request context data
   */
  function parseRequestContext(requestContext) {
    // Validate input data.
    if (!requestContext) {
      throw new ErrorWithStatusCode(
        'Invalid request: missing request context.',
        STATUS.BAD_REQUEST,
      );
    }
    if (!isObject(requestContext)
      || !requestContext.data
      || !requestContext.attributes
      || !requestContext.pathInfo
    ) {
      throw new ErrorWithStatusCode(
        'Invalid request: invalid request context format.',
        STATUS.BAD_REQUEST,
      );
    }

    const { data, pathInfo: { headers }, attributes } = requestContext;

    validateRequestData(data);
    validateRequestAttributes(requestContext.attributes, headers['x-gw-ims-org-id']);
    const contextEnv = processAndValidateContextEnv(context.env);

    // Validation complete. Return the parsed request data.
    const {
      command,
      prompt,
      htmlContent,
      imageUrl,
      selector,
    } = data;
    const mergedPrompt = mergePrompt(
      contextEnv.ASSISTANT_PROMPTS,
      command,
      {
        content: htmlContent,
        selector,
        pattern: prompt,
      },
    );
    // Prune ASSISTANT_PROMPTS and other properties from the env.
    delete contextEnv.ASSISTANT_PROMPTS;

    const { firefallArgs = {} } = commandConfig[command];
    const { authInfo: { profile: apikeyProfile } } = attributes;
    // TODO: remove header check when on Prod, and/or when api-key's have that association.
    const callerImsOrgId = apikeyProfile?.getImsOrgId()
      ?? requestContext.pathInfo.headers['x-gw-ims-org-id'];

    return {
      env: {
        ...contextEnv,
        FIREFALL_IMS_ORG_ID: callerImsOrgId,
      },
      ...firefallArgs,
      command,
      imageUrl,
      prompt: mergedPrompt,
      importApiKey: requestContext.pathInfo.headers['x-api-key'],
      apiKeyName: apikeyProfile?.getName(),
    };
  }

  /**
   * Send an import assistant request to the model.
   * @param {object} requestContext - Context of the request.
   * @returns {Promise<Response>} 200 OK with a list of choices, 4xx or 5xx otherwise.
   */
  async function processImportAssistant(requestContext) {
    try {
      validateAccessScopes(auth, [SCOPE.ASSISTANT], log);

      const requestData = parseRequestContext(requestContext);
      const { command, apiKeyName, env } = requestData;

      log.info(`Running assistant command ${command} using key "${apiKeyName}" for org ${env.FIREFALL_IMS_ORG_ID}.`);

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
