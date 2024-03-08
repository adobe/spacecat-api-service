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
  notFound,
  ok, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isObject,
} from '@adobe/spacecat-shared-utils';
import { createConfiguration as validateConfiguration } from '@adobe/spacecat-shared-data-access/src/models/configuration.js';

import { ConfigurationDto } from '../dto/configuration.js';
import configMerge from '../utils/configMerge.js';

function ConfigurationController(dataAccess) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  /**
   * Retrieves all configurations (all versions).
   * @return {Promise<Response>} Array of configurations.
   */
  const getAll = async () => {
    const configurations = (await dataAccess.getConfigurations())
      .map((configuration) => ConfigurationDto.toJSON(configuration));
    return ok(configurations);
  };

  /**
   * Retrieves the configuration identified by the given version.
   * @param {UniversalContext} context - Context of the request.
   * @return {Promise<Response>} Configuration response.
   */
  const getByVersion = async (context) => {
    const configurationVersion = context.params?.version;

    if (!hasText(configurationVersion)) {
      return badRequest('Configuration version required');
    }

    const configuration = await dataAccess.getConfigurationByVersion(configurationVersion);
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
    const configuration = await dataAccess.getConfiguration();
    if (!configuration) {
      return notFound('Configuration not found');
    }
    return ok(ConfigurationDto.toJSON(configuration));
  };

  /**
   * Updates the configuration.
   * @param {UniversalContext} context - Context of the request.
   * @return {Promise<Response>} Configuration response.
   */
  const updateConfiguration = async (context) => {
    const { data: configurationData } = context;

    if (!isObject(configurationData)) {
      return badRequest('Request body required');
    }

    try {
      const currentConfiguration = await dataAccess.getConfiguration();

      // merge with existing configuration if available, else use the new data directly
      let updatedConfigData;
      if (isObject(currentConfiguration)) {
        updatedConfigData = configMerge(
          ConfigurationDto.toJSON(currentConfiguration),
          configurationData,
        );
      } else {
        updatedConfigData = configurationData;
        updatedConfigData.version = 'v0';
      }

      validateConfiguration(updatedConfigData);
      const updatedConfig = await dataAccess.updateConfiguration(updatedConfigData);

      return ok(updatedConfig);
    } catch (e) {
      return internalServerError(e.message);
    }
  };

  return {
    getAll,
    getByVersion,
    getLatest,
    updateConfiguration,
  };
}

export default ConfigurationController;
