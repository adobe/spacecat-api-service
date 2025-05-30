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
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { isValidUUID } from '@adobe/spacecat-shared-utils';

/**
 * Entity Controller. Provides methods for managing entities.
 * @param {object} context - The context of the universal serverless function.
 * @param {object} context.dataAccess - Data access.
 * @param {Logger} context.log - Logger.
 * @param {ImsClient} context.imsClient - IMS Client.
 * @returns {object} Entity Controller
 * @constructor
 */
function EntityController(context) {
  const {
    dataAccess, log, imsClient,
  } = context;

  const { BaseModel } = dataAccess;

  /**
   * Gets the last updated by information for an entity.
   * @param {object} requestContext - Context of the request.
   * @returns {Promise<Response>} Entity last updated by information.
   */
  const getLastUpdatedBy = async (requestContext) => {
    const { data } = requestContext;
    const { entityId } = data;

    if (!isValidUUID(entityId)) {
      return badRequest('Valid entity ID required');
    }

    const entity = await BaseModel.findById(entityId);
    if (!entity) {
      return notFound(`Entity not found: ${entityId}`);
    }

    const updatedBy = entity.getUpdatedBy();
    if (!updatedBy) {
      return notFound(`No update history found for entity: ${entityId}`);
    }

    if (!updatedBy.includes('@')) {
      return ok(updatedBy);
    }

    try {
      const userProfile = await imsClient.getImsAdminProfile(updatedBy);
      return ok(userProfile.email);
    } catch (error) {
      log.error(`Error fetching user profile for ID ${updatedBy}: ${error.message}`);
      return ok(updatedBy);
    }
  };

  return {
    getLastUpdatedBy,
  };
}

export default EntityController;
