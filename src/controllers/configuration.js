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
  const { dataAccess, log } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Configuration } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Validates sandbox configuration structure and values.
   * @param {Object} sandboxConfigs - Configuration object to validate.
   * @returns {string|null} Error message if validation fails, null if valid.
   */
  const validateSandboxConfigs = (sandboxConfigs) => {
    if (!sandboxConfigs || typeof sandboxConfigs !== 'object') {
      return 'sandboxConfigs object is required';
    }

    for (const [auditType, auditConfig] of Object.entries(sandboxConfigs)) {
      // Validate audit type name
      if (!/^[a-zA-Z0-9-_]+$/.test(auditType)) {
        return `Invalid audit type "${auditType}": must contain only letters, numbers, hyphens, and underscores`;
      }

      // Allow null to remove configuration
      if (auditConfig !== null) {
        // Validate configuration structure
        if (typeof auditConfig !== 'object') {
          return `Configuration for audit type "${auditType}" must be an object or null`;
        }

        const validConfigKeys = ['disabled', 'threshold', 'timeout', 'retries', 'customParams'];
        const invalidKeys = Object.keys(auditConfig)
          .filter((key) => !validConfigKeys.includes(key));

        if (invalidKeys.length > 0) {
          return `Invalid configuration keys for "${auditType}": ${invalidKeys.join(', ')}. Allowed keys: ${validConfigKeys.join(', ')}`;
        }

        // Validate specific config values
        if (auditConfig.disabled !== undefined && typeof auditConfig.disabled !== 'boolean') {
          return `"disabled" for audit type "${auditType}" must be a boolean`;
        }

        if (auditConfig.threshold !== undefined && (typeof auditConfig.threshold !== 'number' || auditConfig.threshold < 0 || auditConfig.threshold > 100)) {
          return `"threshold" for audit type "${auditType}" must be a number between 0 and 100`;
        }

        if (auditConfig.timeout !== undefined && (typeof auditConfig.timeout !== 'number' || auditConfig.timeout < 1000 || auditConfig.timeout > 300000)) {
          return `"timeout" for audit type "${auditType}" must be a number between 1000 and 300000 milliseconds`;
        }

        if (auditConfig.retries !== undefined && (typeof auditConfig.retries !== 'number' || auditConfig.retries < 0 || auditConfig.retries > 10)) {
          return `"retries" for audit type "${auditType}" must be a number between 0 and 10`;
        }

        if (auditConfig.customParams !== undefined && (typeof auditConfig.customParams !== 'object' || auditConfig.customParams === null)) {
          return `"customParams" for audit type "${auditType}" must be an object`;
        }
      }
    }

    return null; // Valid
  };

  /**
   * Applies sandbox configuration updates to the configuration model.
   * @param {Object} config - Configuration model instance.
   * @param {Object} sandboxConfigs - Sandbox configurations to apply.
   */
  const applySandboxConfigUpdates = (config, sandboxConfigs) => {
    Object.entries(sandboxConfigs).forEach(([auditType, auditConfig]) => {
      log?.info(`Updating sandbox config for audit type: ${auditType}`, { auditConfig });
      config.updateSandboxAuditConfig(auditType, auditConfig);
    });
  };

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

    log?.info('Retrieved latest configuration', {
      version: configuration.getVersion(),
      hasSandboxAudits: configuration.hasSandboxAudits(),
    });

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

    const validationError = validateSandboxConfigs(sandboxConfigs);
    if (validationError) {
      return badRequest(validationError);
    }

    try {
      const config = await Configuration.findLatest();
      if (!config) {
        return notFound('Configuration not found');
      }

      applySandboxConfigUpdates(config, sandboxConfigs);

      log?.info('Saving updated configuration', {
        sandboxAuditsCount: Object.keys(config.getSandboxAudits() || {}).length,
        updatedTypes: Object.keys(sandboxConfigs),
      });

      await config.save();

      log?.info('Sandbox configurations updated successfully', {
        updatedConfigs: Object.keys(sandboxConfigs),
        totalUpdated: Object.keys(sandboxConfigs).length,
      });

      return ok({
        message: 'Sandbox configurations updated successfully',
        updatedConfigs: sandboxConfigs,
        totalUpdated: Object.keys(sandboxConfigs).length,
      });
    } catch (error) {
      log?.error('Error updating sandbox configuration', {
        error: error.message,
        configCount: Object.keys(sandboxConfigs).length,
        auditTypes: Object.keys(sandboxConfigs),
      });
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
