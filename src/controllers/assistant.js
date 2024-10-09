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
import { ErrorWithStatusCode } from '../support/utils.js';

/**
 * Assistant controller. Provides methods to perform Firefall AI operations.
 * @returns {object} Import assistant controller.
 * @constructor
 */
function AssistantController() {
  const HEADER_ERROR = 'x-error';

  function createErrorResponse(error) {
    return createResponse({}, error.status, {
      [HEADER_ERROR]: error.message,
    });
  }

  /**
   * Send an import assistant request to Firefall.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} 200 OK with a list of Firefall choices.
   */
  async function processImportAssistant(context) {
    const { command } = context.data;
    if (command) {
      const error = new ErrorWithStatusCode(`Assistant command not implemented: ${command}`, 501);
      return createErrorResponse(error);
    }
    return createResponse({}, 501);
  }

  return {
    processImportAssistant,
  };
}

export default AssistantController;
