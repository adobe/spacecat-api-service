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
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { isObject, isValidUUID } from '@adobe/spacecat-shared-utils';

import { ExperimentDto } from '../dto/experiment.js';

/**
 * Experiments controller.
 * @param {DataAccess} dataAccess - Data access.
 * @param {Logger} log - Logger.
 * @returns {object} Experiments controller.
 * @constructor
 */
function ExperimentsController(dataAccess) {
  if (!isObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Experiment } = dataAccess;

  /**
   * Gets all experiments for a given site
   *
   * @returns {Promise<Response>} Array of experiments.
   */
  const getExperiments = async (context) => {
    const siteId = context.params?.siteId;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const experiments = (await Experiment.allBySiteId(siteId))
      .map((experiment) => ExperimentDto.toJSON(experiment));

    return ok(experiments);
  };

  return {
    getExperiments,
  };
}

export default ExperimentsController;
