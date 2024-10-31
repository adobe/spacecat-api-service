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
 *  - parameters: string[] : parameters required for the command
 *  - responseFormat: string : AI response format for the command
 *  - llmModel: string : the LLM Model to use for the command
 */
export const commandConfig = {
  findMainContent: {
    parameters: ['htmlContent', 'prompt'],
    llmModel: 'gpt-4-turbo',
    responseFormat: 'json_object',
  },
  findRemovalSelectors: {
    parameters: ['htmlContent', 'prompt'],
    llmModel: 'gpt-4-turbo',
    responseFormat: 'json_object',
  },
  findBlockSelectors: {
    parameters: ['htmlContent', 'prompt', 'imageUrl'],
    llmModel: 'gpt-4-vision',
  },
  findBlockCells: {
    parameters: ['htmlContent', 'prompt', 'imageUrl'],
    llmModel: 'gpt-4-vision',
  },
  generatePageTransformation: {
    parameters: ['htmlContent', 'prompt'],
    llmModel: 'gpt-4-turbo',
    responseFormat: 'json_object',
  },
};

export const getFirefallCompletion = async (requestData, log) => {
  const context = {
    env: {
      ...process.env,
      FIREFALL_API_KEY: 'aem-import-as-a-service',
      IMS_CLIENT_ID: 'aem-import-as-a-service',
    },
    log,
  };
  let client;
  try {
    client = FirefallClient.createFrom(context);
  } catch (error) {
    throw new ErrorWithStatusCode(`Error creating FirefallClient: ${error.message}`, 500);
  }

  try {
    return await client.fetchChatCompletion(requestData.prompt, {
      model: requestData.llmModel,
      responseFormat: requestData.responseFormat,
      imageUrls: [requestData.imageUrl],
    });
  } catch (error) {
    throw new ErrorWithStatusCode(`Error fetching insight: ${error.message}`, 500);
  }
};
