/*
 * Copyright 2026 Adobe. All rights reserved.
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
  isNonEmptyObject, isNonEmptyArray, isValidUUID, hasText,
} from '@adobe/spacecat-shared-utils';
import {
  accepted, badRequest, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { createOaeValidationJob, getOaeValidationJob } from '@adobe/spacecat-shared-tokowaka-client';

/**
 * Creates an OAE validation controller instance.
 * @param {Object} ctx - The context object containing dataAccess and sqs
 * @param {Object} ctx.dataAccess - The data access layer for database operations
 * @param {Object} ctx.sqs - The SQS client instance
 * @param {Object} log - The logger instance
 * @param {Object} env - The environment configuration object
 * @returns {Object} The OAE validation controller instance
 * @throws {Error} If context, dataAccess, sqs, or env is not provided
 */
function OaeValidationController(ctx, log, env) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess, sqs } = ctx;

  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  if (!isNonEmptyObject(sqs)) {
    throw new Error('SQS client required');
  }

  if (!isNonEmptyObject(env)) {
    throw new Error('Environment object required');
  }

  /**
   * Validates the request data for job creation.
   * @param {Object} data - The request data object
   * @throws {Error} If data is invalid or missing required fields
   */
  function validateRequestData(data) {
    if (!isNonEmptyObject(data)) {
      throw new Error('Invalid request: missing application/json data');
    }
    if (!isValidUUID(data.siteId)) {
      throw new Error('Invalid request: siteId must be a valid UUID');
    }
    if (!hasText(data.type)) {
      throw new Error('Invalid request: type is required');
    }
    if (!isNonEmptyArray(data.suggestionIds)) {
      throw new Error('Invalid request: suggestionIds must be a non-empty array');
    }
    if (!data.suggestionIds.every((id) => isValidUUID(id))) {
      throw new Error('Invalid request: all suggestionIds must be valid UUIDs');
    }
  }

  /**
   * Validates a job request and dispatches it to spacecat-import-worker. Shared core used by
   * both the HTTP handler below and in-process callers (e.g. the edge-deploy flow in
   * suggestions.js) that want a job created without going through the HTTP layer.
   * @param {Object} data - { siteId, type, suggestionIds }
   * @returns {Promise<{jobId: string}>}
   * @throws {Error} With an 'Invalid request: ...' message if data fails validation.
   */
  const createJob = async (data) => {
    validateRequestData(data);

    const { siteId, type, suggestionIds } = data;
    return createOaeValidationJob({
      dataAccess, sqs, siteId, type, suggestionIds,
    }, log);
  };

  /**
   * Creates a new OAE validation job and dispatches it to spacecat-import-worker.
   * @param {Object} context - The request context
   * @param {Object} context.data - { siteId, type, suggestionIds }
   * @returns {Promise<Object>} The HTTP response object
   */
  const createValidationJob = async (context) => {
    const { data } = context;
    let jobId;
    try {
      ({ jobId } = await createJob(data));
    } catch (error) {
      if (error.message.startsWith('Invalid request')) {
        log.error(`Invalid request data: ${error.message}`);
        return badRequest(error.message);
      }
      log.error(`Failed to queue OAE validation job: ${error.message}`);
      return internalServerError(error.message);
    }
    return accepted({ jobId });
  };

  /**
   * Gets the full per-suggestion data for a job.
   * @param {Object} context - The request context
   * @param {Object} context.params - { jobId }
   * @returns {Promise<Object>} The HTTP response object
   */
  const getValidationJob = async (context) => {
    const jobId = context.params?.jobId;

    if (!isValidUUID(jobId)) {
      log.error(`Invalid jobId: ${jobId}`);
      return badRequest('Invalid jobId');
    }

    try {
      const job = await getOaeValidationJob({ dataAccess, jobId });

      if (!job) {
        return notFound('Job not found');
      }

      return ok(job);
    } catch (error) {
      log.error(`Failed to get OAE validation job: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  return {
    createValidationJob,
    getValidationJob,
    createJob,
  };
}

export default OaeValidationController;
