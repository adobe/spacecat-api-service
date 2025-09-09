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
  forbidden,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  isInteger,
  isNonEmptyObject,
} from '@adobe/spacecat-shared-utils';

import { ConfigurationDto } from '../dto/configuration.js';
import AccessControlUtil from '../support/access-control-util.js';

function ConfigurationController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Configuration } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Retrieves all configurations (all versions).
   * @return {Promise<Response>} Array of configurations.
   */
  const getAll = async () => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view configurations');
    }
    const configurations = (await Configuration.all())
      .map((configuration) => ConfigurationDto.toJSON(configuration));
    return ok(configurations);
  };

  /**
   * Retrieves the configuration identified by the given version.
   * @param {UniversalContext} context - Context of the request.
   * @return {Promise<Response>} Configuration response.
   */
  const getByVersion = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view configurations');
    }
    const configurationVersion = context.params?.version;

    if (!isInteger(configurationVersion)) {
      return badRequest('Configuration version required to be an integer');
    }

    const configuration = await Configuration.findByVersion(configurationVersion);
    if (!configuration) {
      return notFound('Configuration not found');
    }

    return ok(ConfigurationDto.toJSON(configuration));
  };

  /**
   * Retrieves the latest configuration.
   * @return {Promise<Response>} Configuration response.
   */
  const getLatest = async () => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view configurations');
    }
    const configuration = await Configuration.findLatest();
    if (!configuration) {
      return notFound('Configuration not found');
    }
    return ok(ConfigurationDto.toJSON(configuration));
  };

  /**
   * Updates sandbox configuration for audit types.
   * @param {UniversalContext} context - Context of the request.
   * @return {Promise<Response>} Update result response.
   */
  const updateSandboxConfig = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can update sandbox configurations');
    }

    const { sandboxConfigs } = context.data || {};

    if (!sandboxConfigs || typeof sandboxConfigs !== 'object') {
      return badRequest('sandboxConfigs object is required');
    }

    try {
      // Load latest configuration
      const config = await Configuration.findLatest();
      if (!config) {
        return notFound('Configuration not found');
      }

      // Ensure state exists before updating
      if (!config.state) {
        config.state = {};
      }

      // Update sandbox configurations for each audit type
      Object.keys(sandboxConfigs).forEach((auditType) => {
        config.updateSandboxAuditConfig(auditType, sandboxConfigs[auditType]);
      });

      // Save the updated configuration
      await config.save();

      return ok({
        message: 'Sandbox configurations updated successfully',
        updatedConfigs: sandboxConfigs,
        totalUpdated: Object.keys(sandboxConfigs).length,
      });
    } catch (error) {
      return badRequest(`Error updating sandbox configuration: ${error.message}`);
    }
  };

  return {
    getAll,
    getByVersion,
    getLatest,
    updateSandboxConfig,
  };
}

export default ConfigurationController;
