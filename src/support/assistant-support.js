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
import Handlebars from 'handlebars';
import { ErrorWithStatusCode } from './utils.js';

/*
 * Command Config Type:
 * - parameters: string[] : parameters required for the command
 * - firefallArgs: object : key/value pairs to pass to the FirefallClient
 *  - firefallArgs.model: string : the LLM Model to use for the command
 *  - firefallArgs.responseFormat: string : AI response format for the command
 * NOTE: each command key requires a matching 'System Prompt' in AWS Secrets Manager.
 */
const commandConfig = {
  findMainContent: {
    parameters: ['htmlContent'],
    firefallArgs: {
      model: 'gpt-4-turbo',
      responseFormat: 'json_object',
    },
  },
  findRemovalSelectors: {
    parameters: ['prompt', 'htmlContent'],
    firefallArgs: {
      model: 'gpt-4-turbo',
      responseFormat: 'json_object',
    },
  },
  findBlockSelectors: {
    parameters: ['prompt', 'htmlContent', 'imageUrl'],
    firefallArgs: {
      model: 'gpt-4-vision',
    },
  },
  findBlockCells: {
    parameters: ['prompt', 'htmlContent', 'selector'],
    firefallArgs: {
      model: 'gpt-4-turbo',
    },
  },
  generatePageTransformation: {
    parameters: ['prompt', 'htmlContent'],
    firefallArgs: {
      model: 'gpt-4-turbo',
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

/**
 * Merge the command's system prompt with all the properties in the provided object.
 * @param {object} assistantPrompts Prompts with 'command' as key
 * @param {object} command Assistant command
 * @param {string} mergeData Object containing the values to merge with the command's system prompt.
 * @param {string} mergeData.content The HTML text to use in the prompt.
 * @param {string} mergeData.pattern The pattern to use in the prompt, usually the user prompt.
 * @param {string} mergeData.selector The selector of the element in the provided HTML.
 * @returns {string}
 */
const mergePrompt = (assistantPrompts, command, mergeData) => {
  if (!assistantPrompts || !assistantPrompts[command]) {
    throw new Error(`Command has no associated prompt: ${command}`);
  }
  const systemPrompt = assistantPrompts[command];

  try {
    const templateFunction = Handlebars.compile(systemPrompt, { strict: true });
    return templateFunction(mergeData);
  } catch (e) {
    throw new Error(`Failed to create prompt for ${command}. Message: ${e.message}`);
  }
};

const fetchFirefallCompletion = async (requestData, log) => {
  const firefallContext = {
    ...requestData,
    log,
  };
  let client;
  try {
    client = FirefallClient.createFrom(firefallContext);
  } catch (error) {
    throw new ErrorWithStatusCode(`Error creating FirefallClient: ${error.message}`, STATUS.SYS_ERROR);
  }

  const {
    prompt, model, responseFormat, imageUrl,
  } = requestData;

  try {
    const imageCnt = imageUrl ? 1 : 0;
    log.info(`Calling chat completions with model ${model}, format ${responseFormat || 'none'} and ${imageCnt} imageUrls.`);
    // TODO: remove this log line once we're sure the prompt is created correctly.
    log.debug(`Prompt: ${prompt}`);

    return await client.fetchChatCompletion(prompt, {
      model,
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
  mergePrompt,
  validateAccessScopes,
  STATUS,
  SCOPE,
};
