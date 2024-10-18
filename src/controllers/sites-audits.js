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

  const validateInput = ({ baseURL, enableAudits, auditTypes }) => {
    if (!baseURL) {
      throw new Error('Base URL is required');
    }

    if (!isValidUrl(baseURL)) {
      throw new Error(`Invalid Base URL format: ${baseURL}`);
    }

    if (!Array.isArray(auditTypes) || auditTypes.length === 0) {
      throw new Error('Audit types are required');
    }

    if (typeof enableAudits === 'undefined') {
      throw new Error('The "enableAudits" flag is required');
    }

    if (typeof enableAudits !== 'boolean') {
      throw new Error('The "enableAudits" flag should be boolean');
    }
  };

  const update = async (context) => {
    const sitesConfigurations = context.data;

    try {
      for (const siteConfiguration of sitesConfigurations) {
        validateInput(siteConfiguration);
      }
    } catch (error) {
      return badRequest(error.message);
    }

    try {
      let hasUpdates = false;
      const configuration = await dataAccess.getConfiguration();

      const responses = await Promise.all(
        sitesConfigurations.map(async ({ baseURL, auditTypes, enableAudits }) => {
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
          hasUpdates = true;
          for (const auditType of auditTypes) {
            if (enableAudits === true) {
              configuration.enableHandlerForSite(auditType, site);
            } else {
              configuration.disableHandlerForSite(auditType, site);
            }
          }

          return {
            baseURL: site.getBaseURL(),
            response: { site: SiteDto.toJSON(site), status: 200 },
          };
        }),
      );

      if (hasUpdates === true) {
        await dataAccess.updateConfiguration(ConfigurationDto.toJSON(configuration));
      }

      return createResponse(responses, 207);
    } catch (error) {
      return internalServerError(error.message || 'Failed to enable/disable audits for all provided sites');
    }
  };

  return {
    update,
  };
};
