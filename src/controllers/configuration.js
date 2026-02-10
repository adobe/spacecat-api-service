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
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isNonEmptyArray,
  isNonEmptyObject,
} from '@adobe/spacecat-shared-utils';
import { checkConfiguration } from '@adobe/spacecat-shared-data-access';

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
   * Helper function to set updatedBy field from the authenticated user's profile.
   * @param {object} configuration - The configuration entity to update.
   * @param {object} context - The request context containing authInfo.
   */
  const setUpdatedBy = (configuration, context) => {
    const { authInfo: { profile } } = context.attributes;
    configuration.setUpdatedBy(profile.email || 'system');
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

    if (!hasText(configurationVersion)) {
      return badRequest('Configuration version is required');
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
      setUpdatedBy(configuration, context);
      await configuration.save();
      return created({
        message: `Audit type "${auditType}" has been successfully registered`,
        version: String(configuration.getVersion()),
      });
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
      setUpdatedBy(configuration, context);
      await configuration.save();
      return ok({
        message: `Audit type "${auditType}" has been successfully unregistered`,
        version: String(configuration.getVersion()),
      });
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
      setUpdatedBy(configuration, context);
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

    if (!hasText(jobType)) {
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
      setUpdatedBy(configuration, context);
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

    if (!hasText(handlerType)) {
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
      setUpdatedBy(configuration, context);
      await configuration.save();

      return ok(ConfigurationDto.toJSON(configuration));
    } catch (error) {
      return badRequest(error.message);
    }
  };

  /**
   * Replaces enabled/disabled lists for a handler.
   * This is a temporary API that replaces (not merges) the provided arrays.
   *
   * TEMPORARY API: This endpoint was created to clean up enabled and disabled lists
   * by removing unnecessary site IDs. Unlike the existing updateHandler endpoint
   * which merges arrays, this endpoint completely replaces the specified arrays.
   * This API will be removed once the cleanup task is completed.
   *
   * @param {UniversalContext} context - Context of the request.
   * @return {Promise<Response>} Updated configuration response.
   */
  /* c8 ignore start - temporary API, no unit tests needed */
  const replaceHandlerEnabledDisabled = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can update handler configuration');
    }

    const { handlerType } = context.params;
    const { data } = context;

    if (!hasText(handlerType)) {
      return badRequest('Handler type is required');
    }

    if (!isNonEmptyObject(data)) {
      return badRequest('Request body is required and cannot be empty');
    }

    // Validate that at least one of enabled or disabled is provided
    const hasEnabled = data.enabled !== undefined;
    const hasDisabled = data.disabled !== undefined;

    if (!hasEnabled && !hasDisabled) {
      return badRequest('At least one of enabled or disabled must be provided');
    }

    // Validate that at least one array is provided within enabled/disabled
    // (empty arrays are allowed)
    if (hasEnabled) {
      const hasEnabledSites = data.enabled.sites !== undefined;
      const hasEnabledOrgs = data.enabled.orgs !== undefined;
      if (!hasEnabledSites && !hasEnabledOrgs) {
        return badRequest('At least one of enabled.sites or enabled.orgs must be provided');
      }
      // Validate that if provided, they must be arrays
      if (hasEnabledSites && !Array.isArray(data.enabled.sites)) {
        return badRequest('enabled.sites must be an array');
      }
      if (hasEnabledOrgs && !Array.isArray(data.enabled.orgs)) {
        return badRequest('enabled.orgs must be an array');
      }
    }

    if (hasDisabled) {
      const hasDisabledSites = data.disabled.sites !== undefined;
      const hasDisabledOrgs = data.disabled.orgs !== undefined;
      if (!hasDisabledSites && !hasDisabledOrgs) {
        return badRequest('At least one of disabled.sites or disabled.orgs must be provided');
      }
      // Validate that if provided, they must be arrays
      if (hasDisabledSites && !Array.isArray(data.disabled.sites)) {
        return badRequest('disabled.sites must be an array');
      }
      if (hasDisabledOrgs && !Array.isArray(data.disabled.orgs)) {
        return badRequest('disabled.orgs must be an array');
      }
    }

    try {
      const configuration = await Configuration.findLatest();
      if (!configuration) {
        return notFound('Configuration not found');
      }

      configuration.replaceHandlerEnabledDisabled(handlerType, data);
      setUpdatedBy(configuration, context);
      await configuration.save();

      return ok(ConfigurationDto.toJSON(configuration));
    } catch (error) {
      return badRequest(error.message);
    }
  };
  /* c8 ignore stop */

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

    const hasHandlers = isNonEmptyObject(configData.handlers);
    const hasJobs = isNonEmptyArray(configData.jobs);
    const hasQueues = isNonEmptyObject(configData.queues);

    if (!hasHandlers && !hasJobs && !hasQueues) {
      return badRequest('At least one of handlers, jobs, or queues must be provided');
    }

    try {
      const configuration = await Configuration.findLatest();
      if (!configuration) {
        return notFound('Configuration not found');
      }

      configuration.updateConfiguration(configData);
      setUpdatedBy(configuration, context);

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

    const versionToRestore = context.params?.version;

    if (!hasText(versionToRestore)) {
      return badRequest('Configuration version is required');
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

      latestConfiguration.updateConfiguration(restoreData);

      const oldSlackRoles = oldConfiguration.getSlackRoles();
      if (oldSlackRoles) {
        latestConfiguration.setSlackRoles(oldSlackRoles);
      }

      setUpdatedBy(latestConfiguration, context);
      await latestConfiguration.save();

      return ok({
        ...ConfigurationDto.toJSON(latestConfiguration),
        restoredFrom: versionToRestore,
        message: `Configuration successfully restored from version ${versionToRestore}`,
      });
    } catch (error) {
      log.error('Configuration restore failed:', error);
      const errorMessage = error.message
        || (typeof error.toString === 'function' ? error.toString() : null)
        || 'Configuration restore failed';
      return badRequest(errorMessage);
    }
  };

  return {
    getByVersion,
    getLatest,
    registerAudit,
    unregisterAudit,
    updateQueues,
    updateJob,
    updateHandler,
    replaceHandlerEnabledDisabled,
    updateConfiguration,
    restoreVersion,
  };
}

export default ConfigurationController;
