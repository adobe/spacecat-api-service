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
  created,
  noContent,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  isInteger,
  isNonEmptyObject,
} from '@adobe/spacecat-shared-utils';
import { checkConfiguration } from '@adobe/spacecat-shared-data-access';

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
    // URL parameters come as strings, so we need to parse to integer
    const configurationVersion = parseInt(context.params?.version, 10);

    if (!isInteger(configurationVersion) || configurationVersion < 1) {
      return badRequest('Configuration version required to be a positive integer');
    }

    const configuration = await Configuration.findByVersion(configurationVersion);
    if (!configuration) {
      return notFound('Configuration not found');
    }

    return ok(ConfigurationDto.toJSON(configuration));
  };

  /**
   * Retrieves the latest configuration with schema validation.
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

    // Validate configuration data against schema
    try {
      const configData = configuration.toJSON();
      checkConfiguration(configData);
      return ok(ConfigurationDto.toJSON(configuration));
    } catch (validationError) {
      const errorMessage = `Configuration data validation failed: ${validationError.message}`;
      return internalServerError(errorMessage);
    }
  };

  const registerAudit = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can register audits');
    }

    const {
      auditType,
      enabledByDefault,
      interval,
      productCodes,
    } = context.data;

    try {
      const configuration = await Configuration.findLatest();
      configuration.registerAudit(auditType, enabledByDefault, interval, productCodes);
      await configuration.save();
      return created(null);
    } catch (error) {
      return badRequest(error.message);
    }
  };

  const unregisterAudit = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can unregister audits');
    }

    const auditType = context.params?.auditType;

    try {
      const configuration = await Configuration.findLatest();
      configuration.unregisterAudit(auditType);
      await configuration.save();
      return noContent();
    } catch (error) {
      return badRequest(error.message);
    }
  };

  /**
   * Updates the queue URLs in the configuration.
   * @param {UniversalContext} context - Context of the request.
   * @return {Promise<Response>} Updated configuration response.
   */
  const updateQueues = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can update queue configuration');
    }

    const queues = context.data;

    if (!isNonEmptyObject(queues)) {
      return badRequest('Queues configuration is required and cannot be empty');
    }

    try {
      const configuration = await Configuration.findLatest();
      if (!configuration) {
        return notFound('Configuration not found');
      }

      configuration.updateQueues(queues);
      await configuration.save();

      return ok(ConfigurationDto.toJSON(configuration));
    } catch (error) {
      return badRequest(error.message);
    }
  };

  /**
   * Updates a job's schedule and properties.
   * @param {UniversalContext} context - Context of the request.
   * @return {Promise<Response>} Updated configuration response.
   */
  const updateJob = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can update job configuration');
    }

    const { jobType } = context.params;
    const properties = context.data;

    if (!jobType) {
      return badRequest('Job type is required');
    }

    if (!isNonEmptyObject(properties)) {
      return badRequest('Job properties are required and cannot be empty');
    }

    try {
      const configuration = await Configuration.findLatest();
      if (!configuration) {
        return notFound('Configuration not found');
      }

      configuration.updateJob(jobType, properties);
      await configuration.save();

      return ok(ConfigurationDto.toJSON(configuration));
    } catch (error) {
      return badRequest(error.message);
    }
  };

  /**
   * Updates a handler's properties.
   * @param {UniversalContext} context - Context of the request.
   * @return {Promise<Response>} Updated configuration response.
   */
  const updateHandler = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can update handler configuration');
    }

    const { handlerType } = context.params;
    const properties = context.data;

    if (!handlerType) {
      return badRequest('Handler type is required');
    }

    if (!isNonEmptyObject(properties)) {
      return badRequest('Handler properties are required and cannot be empty');
    }

    try {
      const configuration = await Configuration.findLatest();
      if (!configuration) {
        return notFound('Configuration not found');
      }

      configuration.updateHandlerProperties(handlerType, properties);
      await configuration.save();

      return ok(ConfigurationDto.toJSON(configuration));
    } catch (error) {
      return badRequest(error.message);
    }
  };

  /**
   * Updates the entire configuration or specific sections.
   * Allows updating handlers, jobs, and/or queues in a single request.
   * @param {UniversalContext} context - Context of the request.
   * @return {Promise<Response>} Updated configuration response.
   */
  const updateConfiguration = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can update configuration');
    }

    const configData = context.data;

    if (!isNonEmptyObject(configData)) {
      return badRequest('Configuration data is required and cannot be empty');
    }

    // Validate that at least one updatable field is provided
    const hasHandlers = configData.handlers !== undefined;
    const hasJobs = configData.jobs !== undefined;
    const hasQueues = configData.queues !== undefined;

    if (!hasHandlers && !hasJobs && !hasQueues) {
      return badRequest('At least one of handlers, jobs, or queues must be provided');
    }

    try {
      const configuration = await Configuration.findLatest();
      if (!configuration) {
        return notFound('Configuration not found');
      }

      // The model's updateConfiguration method will validate the data
      configuration.updateConfiguration(configData);

      // Save will create a new version automatically
      await configuration.save();

      return ok(ConfigurationDto.toJSON(configuration));
    } catch (error) {
      return badRequest(error.message);
    }
  };

  /**
   * Restores configuration to a specific version by creating a new version
   * with the data from the specified version.
   * @param {UniversalContext} context - Context of the request.
   * @return {Promise<Response>} Configuration response.
   */
  const restoreVersion = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can restore configurations');
    }

    // URL parameters come as strings, so we need to parse to integer
    const versionToRestore = parseInt(context.params?.version, 10);

    if (!isInteger(versionToRestore) || versionToRestore < 1) {
      return badRequest('Configuration version required to be a positive integer');
    }

    try {
      // Fetch the version to restore
      const oldConfiguration = await Configuration.findByVersion(versionToRestore);
      if (!oldConfiguration) {
        return notFound(`Configuration version ${versionToRestore} not found`);
      }

      // Fetch the latest configuration to update
      const latestConfiguration = await Configuration.findLatest();
      if (!latestConfiguration) {
        return notFound('Latest configuration not found');
      }

      // Extract the data to restore (handlers, jobs, queues)
      const restoreData = {
        handlers: oldConfiguration.getHandlers(),
        jobs: oldConfiguration.getJobs(),
        queues: oldConfiguration.getQueues(),
      };

      // Update the latest configuration with the old data
      // This will create a new version with the restored data
      latestConfiguration.updateConfiguration(restoreData);

      // Restore slackRoles separately (it's not part of updateConfiguration)
      const oldSlackRoles = oldConfiguration.getSlackRoles();
      if (oldSlackRoles) {
        latestConfiguration.setSlackRoles(oldSlackRoles);
      }

      // Save will create a new version automatically
      await latestConfiguration.save();

      return ok({
        ...ConfigurationDto.toJSON(latestConfiguration),
        restoredFrom: versionToRestore,
        message: `Configuration successfully restored from version ${versionToRestore}`,
      });
    } catch (error) {
      return badRequest(error.message);
    }
  };

  return {
    getAll,
    getByVersion,
    getLatest,
    registerAudit,
    unregisterAudit,
    updateQueues,
    updateJob,
    updateHandler,
    updateConfiguration,
    restoreVersion,
  };
}

export default ConfigurationController;
