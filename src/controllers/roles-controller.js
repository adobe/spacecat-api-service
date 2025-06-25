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
  createResponse,
} from '@adobe/spacecat-shared-http-utils';
import {
  isObject,
  isNonEmptyObject,
  isValidUUID,
  arrayEquals,
} from '@adobe/spacecat-shared-utils';
import { ValidationError } from '@adobe/spacecat-shared-data-access';
import { RoleDto } from '../dto/role.js';

/**
   * Roles controller.
   * @param {object} ctx - Context of the request.
   * @returns {object} Roles controller.
   * @constructor
   */
function RolesController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { rbacDataAccess } = ctx;
  if (!isNonEmptyObject(rbacDataAccess)) {
    throw new Error('Role data access required');
  }
  const { Role } = rbacDataAccess;
  if (!isObject(Role)) {
    throw new Error('Role Collection not available');
  }
  /**
     * returns a response for a data access error.
     * If there's a ValidationError it will return a 400 response, and the
     * validation error message coming from the data access layer.
     * If there's another kind of error, it will return a 500 response.
     * The error message in the 500 response is overriden by passing the message parameter
     * to avoid exposing internal error messages to the client.
     * @param {*} e - error
     * @param {*} message - error message to override 500 error messages
     * @returns a response
     */
  function handleDataAccessError(e, message) {
    if (e instanceof ValidationError) {
      return badRequest(e.message);
    }
    return createResponse({ message }, 500);
  }

  /**
     * Gets a role by ID.
     * @param {Object} context of the request
     * @returns {Promise<Response>} Role response.
     */
  const getByID = async (context) => {
    const roleId = context.params?.roleId;

    if (!isValidUUID(roleId)) {
      return badRequest('Role ID required');
    }

    const role = await Role.findById(roleId);
    if (!role) {
      return notFound('Role not found');
    }

    return ok(RoleDto.toJSON(role));
  };

  /**
     * Creates a role
     * @param {Object} context of the request
     * @return {Promise<Response>} Role response.
     */
  const createRole = async (context) => {
    if (!isNonEmptyObject(context.data)) {
      return badRequest('No data provided');
    }

    try {
      const role = await Role.create(context.data);
      return createResponse(RoleDto.toJSON(role), 201);
    } catch (e) {
      return handleDataAccessError(e, 'Error creating role');
    }
  };

  /**
     * Updates data for a role
     * @param {Object} context of the request
     * @returns {Promise<Response>} the updated role data
     */
  const patchRole = async (context) => {
    const roleId = context.params?.roleId;
    const { authInfo: { profile } } = context.attributes;

    if (!isValidUUID(roleId)) {
      return badRequest('Role ID required');
    }

    const role = await Role.findById(roleId);
    if (!role) {
      return notFound('Role not found');
    }

    if (!isNonEmptyObject(context.data)) {
      return badRequest('No updates provided');
    }

    const { name, imsOrgId, acl } = context.data;
    let hasUpdates = false;

    try {
      if (name && name !== role.getName()) {
        hasUpdates = true;
        role.setName(name);
      }
      if (imsOrgId && imsOrgId !== role.getImsOrgId()) {
        hasUpdates = true;
        role.setImsOrgId(imsOrgId);
      }
      if (acl && !arrayEquals(acl, role.getAcl())) {
        hasUpdates = true;
        role.setAcl(acl);
      }

      if (hasUpdates) {
        role.setUpdatedBy(profile.email || 'system');
        const updatedRole = await role.save();
        return ok(RoleDto.toJSON(updatedRole));
      }
    } catch (e) {
      return handleDataAccessError(e, 'Error updating role');
    }
    return badRequest('No updates provided');
  };

  return {
    getByID,
    createRole,
    patchRole,
  };
}

export default RolesController;
