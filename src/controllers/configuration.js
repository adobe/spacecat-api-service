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

  /**
   * Retrieves all jobs from the latest configuration.
   * @return {Promise<Response>} Jobs response.
   */
  const getLatestJobs = async () => {
    const configuration = await Configuration.findLatest();
    if (!configuration) {
      return notFound('Configuration not found');
    }
    return ok(configuration.getJobs());
  };

  /**
   * Creates multiple jobs in the latest configuration.
   * @param {Object} context - Request context containing the job data
   * @returns {Promise<Response>} - API response
   */
  const createJobs = async (context) => {
    const latestConfig = await Configuration.findLatest();
    if (!latestConfig) {
      return notFound('Latest configuration not found');
    }

    const jobsData = context.body;
    if (!Array.isArray(jobsData)) {
      return badRequest('Jobs data must be an array');
    }

    // Validate each job
    for (const job of jobsData) {
      if (!job.group || !job.type || !job.interval) {
        return badRequest('Invalid job data. Each job requires: group, type, interval');
      }
    }

    const currentJobs = latestConfig.getJobs();
    const updatedConfig = await Configuration.update({
      jobs: [...currentJobs, ...jobsData],
      version: latestConfig.getVersion(),
    });

    return ok(ConfigurationDto.toJSON(updatedConfig));
  };

  /**
   * Gets jobs of a specific type from the latest configuration.
   * @param {Object} context - Request context containing the job type
   * @returns {Promise<Response>} - API response
   */
  const getLatestJobsByType = async (context) => {
    const { type } = context.params;
    const latestConfig = await Configuration.findLatest();

    if (!latestConfig) {
      return notFound('Latest configuration not found');
    }

    const allJobs = latestConfig.getJobs();
    const filteredJobs = allJobs.filter((job) => job.type === type);

    return ok(filteredJobs);
  };

  /**
   * Removes jobs of a specific type from the latest configuration.
   * @param {Object} context - Request context containing the job type
   * @returns {Promise<Response>} - API response
   */
  const removeLatestJobsByType = async (context) => {
    const { type } = context.params;
    const latestConfig = await Configuration.findLatest();

    if (!latestConfig) {
      return notFound('Latest configuration not found');
    }

    const allJobs = latestConfig.getJobs();
    const remainingJobs = allJobs.filter((job) => job.type !== type);

    const updatedConfig = await Configuration.update({
      jobs: remainingJobs,
      version: latestConfig.getVersion(),
    });

    return ok(ConfigurationDto.toJSON(updatedConfig));
  };

  /**
   * Updates jobs of a specific type in the latest configuration.
   * @param {Object} context - Request context containing the job type and update data
   * @returns {Promise<Response>} - API response
   */
  const updateLatestJobsByType = async (context) => {
    const { type } = context.params;
    const updateData = context.body;

    if (!isObject(updateData)) {
      return badRequest('Update data must be an object');
    }

    const latestConfig = await Configuration.findLatest();
    if (!latestConfig) {
      return notFound('Latest configuration not found');
    }

    const allJobs = latestConfig.getJobs();
    const updatedJobs = allJobs.map((job) => {
      if (job.type === type) {
        return { ...job, ...updateData };
      }
      return job;
    });

    const updatedConfig = await Configuration.update({
      jobs: updatedJobs,
      version: latestConfig.getVersion(),
    });

    return ok(ConfigurationDto.toJSON(updatedConfig));
  };

  return {
    getAll,
    getByVersion,
    getLatest,
    getLatestJobs,
    createJobs,
    getLatestJobsByType,
    removeLatestJobsByType,
    updateLatestJobsByType,
  };
}

export default ConfigurationController;
