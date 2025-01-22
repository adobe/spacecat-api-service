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
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  isInteger,
  isObject,
} from '@adobe/spacecat-shared-utils';

import { ConfigurationDto } from '../dto/configuration.js';

function ConfigurationController(dataAccess) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Configuration } = dataAccess;

  /**
   * Retrieves all configurations (all versions).
   * @return {Promise<Response>} Array of configurations.
   */
  const getAll = async () => {
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
    const configuration = await Configuration.findLatest();
    if (!configuration) {
      return notFound('Configuration not found');
    }
    return ok(ConfigurationDto.toJSON(configuration));
  };

  return {
    getAll,
    getByVersion,
    getLatest,
  };
}

export default ConfigurationController;
