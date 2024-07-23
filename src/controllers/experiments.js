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
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isObject } from '@adobe/spacecat-shared-utils';

import { ExperimentDto } from '../dto/experiment.js';

/**
 * Experiments controller.
 * @param {DataAccess} dataAccess - Data access.
 * @param {Logger} log - Logger.
 * @returns {object} Experiments controller.
 * @constructor
 */
function ExperimentsController(dataAccess, log) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }
  if (!isObject(log)) {
    throw new Error('Log required');
  }

  /**
   * Gets all experiments for a given site
   *
   * @returns {Promise<Response>} Array of experiments.
   */
  const getExperiments = async (context) => {
    const siteId = context.params?.siteId;

    if (!hasText(siteId)) {
      return badRequest('Site ID required');
    }

    const experiments = (await dataAccess.getExperiments(siteId))
      .map((experiment) => ExperimentDto.toJSON(experiment));

    return ok(experiments);
  };

  return {
    getExperiments,
  };
}

export default ExperimentsController;
