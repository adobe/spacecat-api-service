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

import { badRequest, createResponse, internalServerError } from '@adobe/spacecat-shared-http-utils';
import {
  isObject, isValidUrl, isNonEmptyObject, isString,
} from '@adobe/spacecat-shared-utils';

/**
 * @param {DataAccess} dataAccess - Data access.
 * @returns {object} Sites Audits controller.
 * @constructor
 */
export default (dataAccess) => {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Configuration, Site } = dataAccess;

  const validateInput = ({ baseURL, auditType, enable }) => {
    if (isString(baseURL) === false || baseURL.length === 0) {
      throw new Error('Site URL is required.');
    }

    if (!isValidUrl(baseURL)) {
      throw new Error(`Invalid Site URL format: "${baseURL}".`);
    }

    if (isString(auditType) === false || auditType.length === 0) {
      throw new Error('Audit type is required.');
    }

    if (typeof enable !== 'boolean') {
      throw new Error('The "enable" parameter is required and must be set to a boolean value: true or false.');
    }
  };

  /**
   * One public operation per controller
   *
   * @param {object} context
   * @returns {Promise<Response|*>}
   */
  const execute = async (context) => {
    if (!isNonEmptyObject(context)) {
      return internalServerError('An error occurred while trying to enable or disable audits.');
    }

    const { data: requestBody, log } = context;

    if (!requestBody || requestBody.length === 0) {
      return badRequest('Request body is required.');
    }

    try {
      let hasUpdates = false;
      const configuration = await Configuration.findLatest();

      const responses = await Promise.all(
        requestBody.map(async ({ baseURL, auditType, enable }) => {
          try {
            validateInput({ baseURL, auditType, enable });
          } catch (error) {
            return {
              message: error.message,
              status: 400,
            };
          }

          const site = await Site.findByBaseURL(baseURL);
          if (site === null) {
            return { status: 404, message: `Site with baseURL: ${baseURL} not found.` };
          }

          const registeredAudits = configuration.getHandlers();
          if (!registeredAudits[auditType]) {
            return {
              status: 404,
              message: `The "${auditType}" is not present in the configuration. List of allowed audits:`
                + ` ${Object.keys(registeredAudits).join(', ')}.`,
            };
          }

          hasUpdates = true;
          let successMessage;
          if (enable === true) {
            configuration.enableHandlerForSite(auditType, site);
            successMessage = `The audit "${auditType}" has been enabled for the "${site.getBaseURL()}".`;
          } else {
            configuration.disableHandlerForSite(auditType, site);
            successMessage = `The audit "${auditType}" has been disabled for the "${site.getBaseURL()}".`;
          }

          return { status: 200, message: successMessage };
        }),
      );

      if (hasUpdates === true) {
        await configuration.save();
      }

      return createResponse(responses, 207);
    } catch (error) {
      log.error(error.message);
      return internalServerError('An error occurred while trying to enable or disable audits.');
    }
  };

  return {
    execute,
  };
};
