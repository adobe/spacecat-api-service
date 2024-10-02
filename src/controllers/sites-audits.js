/*
 * Copyright 2023 Adobe. All rights reserved.
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
  badRequest,
  createResponse,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { isObject, isValidUrl } from '@adobe/spacecat-shared-utils';

import { ConfigurationDto } from '../dto/configuration.js';
import { SiteDto } from '../dto/site.js';

/**
 * Sites Audits controller.
 * @param {DataAccess} dataAccess - Data access.
 * @returns {object} Sites Audits controller.
 * @constructor
 */
export default (dataAccess) => {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const validateInput = ({ baseURLs, enableAudits, auditTypes }) => {
    if (!Array.isArray(baseURLs) || baseURLs.length === 0) {
      throw new Error('Base URLs are required');
    }

    for (const baseURL of baseURLs) {
      if (!isValidUrl(baseURL)) {
        throw new Error(`Invalid URL format: ${baseURL}`);
      }
    }

    if (!Array.isArray(auditTypes) || auditTypes.length === 0) {
      throw new Error('Audit types are required');
    }
    // @todo: check audit types

    if (typeof enableAudits !== 'boolean') {
      throw new Error('enableAudits is required');
    }
  };

  const update = async (context) => {
    const { baseURLs, enableAudits, auditTypes } = context.data;

    try {
      validateInput(context.data);
    } catch (error) {
      return badRequest(error.message || 'An error occurred during the request');
    }

    try {
      const configuration = await dataAccess.getConfiguration();

      const responses = await Promise.all(
        baseURLs.map(async (baseURL) => {
          const site = await dataAccess.getSiteByBaseURL(baseURL);
          if (!site) {
            return {
              baseURL,
              response: {
                message: `Site with baseURL: ${baseURL} not found`,
                status: 404,
              },
            };
          }

          for (const auditType of auditTypes) {
            if (enableAudits === true) {
              await configuration.enableHandlerForSite(auditType, site);
            } else {
              await configuration.disableHandlerForSite(auditType, site);
            }
          }

          return {
            baseURL: site.getBaseURL(),
            response: { body: SiteDto.toJSON(site), status: 200 },
          };
        }),
      );

      await dataAccess.updateConfiguration(ConfigurationDto.toJSON(configuration));

      return createResponse(responses, 207);
    } catch (error) {
      return internalServerError(error.message || 'Failed to enable audits for all provided sites');
    }
  };

  return {
    update,
  };
};
