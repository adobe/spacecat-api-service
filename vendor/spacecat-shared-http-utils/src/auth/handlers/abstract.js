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

export default class AbstractHandler {
  constructor(name, log) {
    if (new.target === AbstractHandler) {
      throw new TypeError('Cannot construct AbstractHandler instances directly');
    }
    this.name = name;
    this.logger = log;
  }

  /**
   * Log a message with a specific log level. Log messages are prefixed with the handler name.
   * @param {string} message - The log message
   * @param {string} level - The log level
   */
  log(message, level) {
    this.logger[level](`[${this.name}] ${message}`);
  }

  /**
   * Check the authentication of a request. This method must be implemented by the concrete handler.
   * It should return an object of type AuthInfo if the request is authenticated,
   * otherwise it should return null.
   * @param {Object} request - The request object
   * @param {UniversalContext} context - The context object
   * @return {Promise<AuthInfo|null>} The authentication info
   * or null if the request is not authenticated
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,class-methods-use-this
  async checkAuth(request, context) {
    throw new Error('checkAuth method must be implemented');
  }
}
