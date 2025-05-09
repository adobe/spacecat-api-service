/*
 * Copyright 2025 Adobe. All rights reserved.
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
  isNonEmptyObject,
  isValidUrl,
  hasText,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import {
  badRequest,
  internalServerError,
  notFound,
  ok,
  createResponse,
} from '@adobe/spacecat-shared-http-utils';

/**
 * Preflight Controller. Provides methods to create and manage preflight jobs for URL validation.
 * @param {object} context - The context object containing dataAccess and other dependencies
 * @param {
 *   object
 * } context.dataAccess - Data access object containing AsyncJob repository
 * @param {object} logger - Logger instance for logging operations and errors
 * @param {object} env - Environment configuration object
 * @param {string} env.AUDIT_WORKER_QUEUE_URL - URL of the SQS queue for audit jobs
 * @returns {object} Preflight controller with methods for job management
 * @throws {Error} If context or env is not provided
 */
export default function PreflightController(
  context,
  logger,
  env,
) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }

  if (!isNonEmptyObject(env)) {
    throw new Error('Environment object required');
  }

  /**
   * Creates a validation error with a 400 status code
   * @param {string} message - Error message
   * @returns {Error} Error object with statusCode property
   */
  function createValidationError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
  }

  /**
   * Validates the request data for preflight job creation
   * @param {object} data - Request data object
   * @param {string} data.pageUrl - URL to be validated
   * @throws {Error} If request data is invalid
   */
  function validateRequestData(data) {
    if (!isNonEmptyObject(data)) {
      throw createValidationError('Invalid request: missing application/json in request data');
    }
    if (!hasText(data.pageUrl)) {
      throw createValidationError('Invalid request: missing pageUrl in request data');
    }
    if (!isValidUrl(data.pageUrl)) {
      throw createValidationError('Invalid request: invalid pageUrl format');
    }
  }

  /**
   * Validates the job ID format
   * @param {string} jobId - UUID of the job
   * @throws {Error} If jobId is invalid
   */
  function validateJobId(jobId) {
    if (!isValidUUID(jobId)) {
      throw createValidationError('Invalid jobId');
    }
  }

  return {
    /**
     * Creates a new preflight job for URL validation
     * @param {object} requestContext - Request context
     * @param {object} requestContext.data - Request data containing pageUrl
     * @param {object} requestContext.func - Function context containing version info
     * @param {object} requestContext.sqs - SQS client for message sending
     * @param {object} requestContext.dataAccess - Data access object
     * @returns {Promise<Response>} Response object with job details
     * @throws {Error} If dataAccess is missing
     */
    async createPreflightJob(requestContext) {
      if (!isNonEmptyObject(requestContext.dataAccess)) {
        throw new Error('Data access required');
      }

      try {
        const { data, func, sqs } = requestContext;
        const { AsyncJob } = requestContext.dataAccess;

        try {
          validateRequestData(data);
        } catch (error) {
          logger.error(`Failed to create preflight job: ${error.message}`);
          return badRequest({ message: error.message });
        }

        const { pageUrl } = data;
        logger.info(`Creating preflight job for pageUrl: ${pageUrl}`);

        // Create a new async job
        let asyncJob;
        try {
          asyncJob = AsyncJob.create();
          asyncJob.setStatus('IN_PROGRESS');
          asyncJob.setType('preflight');
          asyncJob.setData({ urls: [{ url: pageUrl }] });
          await AsyncJob.save(asyncJob);
        } catch (error) {
          logger.error(`Failed to create preflight job: ${error.message}`);
          return internalServerError({ message: error.message });
        }

        // Send message to SQS queue
        const message = {
          jobId: asyncJob.getId(),
          urls: [{ url: pageUrl }],
          type: 'preflight',
        };

        try {
          await sqs.sendMessage(env.AUDIT_WORKER_QUEUE_URL, message);
        } catch (error) {
          logger.error(`Failed to create preflight job: ${error.message}`);
          return internalServerError({ message: error.message });
        }

        const baseUrl = func.version === 'ci'
          ? 'https://spacecat.experiencecloud.live/api/ci'
          : 'https://spacecat.experiencecloud.live/api/v1';
        const pollUrl = `${baseUrl}/preflight/jobs/${asyncJob.getId()}`;

        return createResponse({
          jobId: asyncJob.getId(),
          status: asyncJob.getStatus(),
          createdAt: asyncJob.getCreatedAt(),
          pollUrl,
        }, 202);
      } catch (error) {
        logger.error(`Failed to create preflight job: ${error.message}`);
        return internalServerError({ message: error.message });
      }
    },

    /**
     * Retrieves the status and result of a preflight job
     * @param {object} requestContext - Request context
     * @param {object} requestContext.params - Request parameters containing jobId
     * @param {object} requestContext.dataAccess - Data access object
     * @returns {Promise<Response>} Response object with job status and result
     * @throws {Error} If dataAccess is missing
     */
    async getPreflightJobStatusAndResult(requestContext) {
      if (!isNonEmptyObject(requestContext.dataAccess)) {
        throw new Error('Data access required');
      }

      try {
        const { params } = requestContext;
        const { AsyncJob } = requestContext.dataAccess;
        const { jobId } = params;

        try {
          validateJobId(jobId);
        } catch (error) {
          logger.error(`Failed to get preflight job: ${error.message}`);
          return badRequest({ message: error.message });
        }

        logger.info(`Getting preflight job status for jobId: ${jobId}`);

        let asyncJob;
        try {
          asyncJob = await AsyncJob.findById(jobId);
        } catch (error) {
          logger.error(`Failed to get preflight job: ${error.message}`);
          return internalServerError({ message: error.message });
        }

        if (!asyncJob) {
          logger.error(`Failed to get preflight job: Job not found with id: ${jobId}`);
          return notFound({ message: `Job with ID ${jobId} not found` });
        }

        try {
          return ok({
            jobId: asyncJob.getId(),
            status: asyncJob.getStatus(),
            createdAt: asyncJob.getCreatedAt(),
            updatedAt: asyncJob.getUpdatedAt(),
            startedAt: asyncJob.getStartedAt(),
            endedAt: asyncJob.getEndedAt(),
            recordExpiresAt: asyncJob.getRecordExpiresAt(),
            result: asyncJob.getResult(),
            error: asyncJob.getError(),
          });
        } catch (error) {
          logger.error(`Failed to get preflight job: ${error.message}`);
          return internalServerError({ message: error.message });
        }
      } catch (error) {
        logger.error(`Failed to get preflight job: ${error.message}`);
        return internalServerError({ message: error.message });
      }
    },
  };
}
