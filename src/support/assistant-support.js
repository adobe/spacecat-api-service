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

import { FirefallClient } from '@adobe/spacecat-shared-gpt-client';
import { ErrorWithStatusCode } from './utils.js';

/*
 * Command Config Type:
 * - parameters: string[] : parameters required for the command
 * - firefallArgs: object : key/value pairs to pass to the FirefallClient
 *  - firefallArgs.llmModel: string : the LLM Model to use for the command
 *  - firefallArgs.responseFormat: string : AI response format for the command
 */
const commandConfig = {
  findMainContent: {
    parameters: [],
    firefallArgs: {
      llmModel: 'gpt-4-turbo',
      responseFormat: 'json_object',
    },
  },
  findRemovalSelectors: {
    parameters: ['prompt'],
    firefallArgs: {
      llmModel: 'gpt-4-turbo',
      responseFormat: 'json_object',
    },
  },
  findBlockSelectors: {
    parameters: ['prompt', 'imageUrl'],
    firefallArgs: {
      llmModel: 'gpt-4-vision',
    },
  },
  findBlockCells: {
    parameters: ['prompt', 'imageUrl'],
    firefallArgs: {
      llmModel: 'gpt-4-vision',
    },
  },
  generatePageTransformation: {
    parameters: ['prompt'],
    firefallArgs: {
      llmModel: 'gpt-4-turbo',
      responseFormat: 'json_object',
    },
  },
};

const SCOPE = {
  ASSISTANT: 'imports.assistant', // allows users submit prompts with their API key
};

const STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  SYS_ERROR: 500,
};

/**
 * Verify that the authenticated user has the required level of access scope.
 * @param auth the auth object from the context.
 * @param scopes a list of scopes to validate the user has access to.
 * @param log optional logger.
 * @return {true} if scope is allowed.
 */
const validateAccessScopes = (auth, scopes, log) => {
  try {
    auth.checkScopes(scopes);
  } catch (error) {
    log?.info(`Validation of scopes failed: ${scopes}`);
    throw new ErrorWithStatusCode('Missing required scopes.', STATUS.UNAUTHORIZED);
  }
  log?.debug(`Validation of scopes succeeded: ${scopes}`);
};

const fetchFirefallCompletion = async (requestData, log) => {
  const context = {
    ...requestData,
    log,
  };
  let client;
  try {
    client = FirefallClient.createFrom(context);
  } catch (error) {
    throw new ErrorWithStatusCode(`Error creating FirefallClient: ${error.message}`, STATUS.SYS_ERROR);
  }

  const {
    prompt, llmModel, responseFormat, imageUrl,
  } = requestData;

  try {
    const imageCnt = imageUrl?.length || 0;
    log.info(`Calling chat completions with model ${llmModel}, format ${responseFormat || 'none'} and ${imageCnt} imageUrls.`);

    return await client.fetchChatCompletion(prompt, {
      model: llmModel,
      responseFormat,
      imageUrls: imageUrl ? [imageUrl] : undefined,
    });
  } catch (error) {
    throw new ErrorWithStatusCode(`Error fetching completion: ${error.message}`, STATUS.SYS_ERROR);
  }
};

export {
  commandConfig,
  fetchFirefallCompletion,
  validateAccessScopes,
  STATUS,
  SCOPE,
};
