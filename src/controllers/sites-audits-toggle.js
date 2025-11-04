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
  forbidden,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  isValidUrl, isNonEmptyObject, isString,
} from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * @param {object} ctx - Context of the request.
 * @returns {object} Sites Audits controller.
 * @constructor
 */
export default (ctx) => {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Configuration, Site, Organization } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  const validateInput = ({
    baseURL, organizationId, auditType, enable,
  }) => {
    const hasBaseURL = isString(baseURL) && baseURL.length > 0;
    const hasOrgId = isString(organizationId) && organizationId.length > 0;

    if (!hasBaseURL && !hasOrgId) {
      throw new Error('Either Site URL (baseURL) or Organization ID (organizationId) is required.');
    }

    if (hasBaseURL && hasOrgId) {
      throw new Error('Cannot specify both baseURL and organizationId. Please provide only one.');
    }

    if (hasBaseURL && !isValidUrl(baseURL)) {
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
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can change configuration settings.');
    }
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
        requestBody.map(async ({
          baseURL, organizationId, auditType, enable,
        }) => {
          try {
            validateInput({
              baseURL, organizationId, auditType, enable,
            });
          } catch (error) {
            return {
              message: error.message,
              status: 400,
            };
          }

          const isSiteOperation = baseURL !== undefined;
          let entity;
          let entityDescription;

          if (isSiteOperation) {
            // Site operation
            entity = await Site.findByBaseURL(baseURL);
            if (entity === null) {
              return { status: 404, message: `Site with baseURL: ${baseURL} not found.` };
            }
            entityDescription = `site "${entity.getBaseURL()}"`;
          } else {
            // Organization operation
            entity = await Organization.findById(organizationId);
            if (entity === null) {
              return { status: 404, message: `Organization with ID: ${organizationId} not found.` };
            }
            entityDescription = `organization "${organizationId}"`;
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

          try {
            if (enable === true) {
              if (isSiteOperation) {
                configuration.enableHandlerForSite(auditType, entity);
              } else {
                configuration.enableHandlerForOrg(auditType, entity);
              }
              successMessage = `The audit "${auditType}" has been enabled for the ${entityDescription}.`;
            } else {
              if (isSiteOperation) {
                configuration.disableHandlerForSite(auditType, entity);
              } else {
                configuration.disableHandlerForOrg(auditType, entity);
              }
              successMessage = `The audit "${auditType}" has been disabled for the ${entityDescription}.`;
            }
          } catch (error) {
            return {
              status: 400,
              message: error.message,
            };
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
