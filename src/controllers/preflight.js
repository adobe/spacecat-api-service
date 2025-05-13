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
  isNonEmptyObject, isValidUUID, isValidUrl,
} from '@adobe/spacecat-shared-utils';
import {
  badRequest, internalServerError, notFound, ok, accepted,
} from '@adobe/spacecat-shared-http-utils';

/**
 * Creates a preflight controller instance
 * @param {Object} ctx - The context object containing dataAccess and sqs
 * @param {Object} ctx.dataAccess - The data access layer for database operations
 * @param {Object} ctx.sqs - The SQS client instance
 * @param {Object} log - The logger instance
 * @param {Object} env - The environment configuration object
 * @param {string} env.AWS_ENV - The AWS environment
 * @param {string} env.AUDIT_JOBS_QUEUE_URL - The SQS queue URL for audit jobs
 * @returns {Object} The preflight controller instance
 * @throws {Error} If context, dataAccess, sqs, or env is not provided
 */
function PreflightController(ctx, log, env) {
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
   * Validates the request data for preflight job creation
   * @param {Object} data - The request data object
   * @param {string} data.pageUrl - The URL of the page
   * @throws {Error} If data is invalid or missing required fields
   */
  function validateRequestData(data) {
    if (!isNonEmptyObject(data)) {
      throw new Error('Invalid request: missing application/json data');
    }

    if (typeof data.pageUrl !== 'string' || !isValidUrl(data.pageUrl)) {
      throw new Error('Invalid request: missing or invalid pageUrl in request data');
    }
  }

  /**
   * Creates a new preflight job
   * @param {Object} context - The request context
   * @param {Object} context.data - The request data
   * @param {string} context.data.pageUrl - The URL of the page
   * @returns {Promise<Object>} The HTTP response object
   */
  const createPreflightJob = async (context) => {
    const { data } = context;

    try {
      validateRequestData(data);
    } catch (error) {
      log.error(`Invalid request data: ${error.message}`);
      return badRequest(error.message);
    }

    try {
      const isDev = env.AWS_ENV === 'dev';

      log.info(`Creating preflight job for pageUrl: ${data.pageUrl}`);

      // Find the site that matches the base URL
      const url = new URL(data.pageUrl);
      const baseURL = `${url.protocol}//${url.hostname}`;
      const site = await dataAccess.Site.findByBaseURL(baseURL);
      if (!site) {
        throw new Error(`No site found for base URL: ${baseURL}`);
      }

      // Create a new async job
      const job = await dataAccess.AsyncJob.create({
        status: 'IN_PROGRESS',
        metadata: {
          payload: {
            siteId: site.getId(),
            urls: [
              { url: data.pageUrl },
            ],
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });

      try {
        // Send message to SQS to trigger the audit worker
        await sqs.sendMessage(env.AUDIT_JOBS_QUEUE_URL, {
          jobId: job.getId(),
          type: 'preflight',
        });
      } catch (error) {
        log.error(`Failed to send message to SQS: ${error.message}`);
        // roll back the job
        await job.remove();
        throw new Error(`Failed to send message to SQS: ${error.message}`);
      }

      return accepted({
        jobId: job.getId(),
        status: job.getStatus(),
        createdAt: job.getCreatedAt(),
        pollUrl: `https://spacecat.experiencecloud.live/api/${isDev ? 'ci' : 'v1'}/preflight/jobs/${job.getId()}`,
      });
    } catch (error) {
      log.error(`Failed to create preflight job: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  /**
   * Gets the status and result of a preflight job
   * @param {Object} context - The request context
   * @param {Object} context.params - The request parameters
   * @param {string} context.params.jobId - The ID of the job to retrieve
   * @returns {Promise<Object>} The HTTP response object
   */
  const getPreflightJobStatusAndResult = async (context) => {
    const jobId = context.params?.jobId;

    log.info(`Getting preflight job status for jobId: ${jobId}`);

    if (!isValidUUID(jobId)) {
      log.error(`Invalid jobId: ${jobId}`);
      return badRequest('Invalid jobId');
    }

    try {
      const job = await dataAccess.AsyncJob.findById(jobId);

      if (!job) {
        log.error(`Job with ID ${jobId} not found`);
        return notFound(`Job with ID ${jobId} not found`);
      }

      return ok({
        jobId: job.getId(),
        status: job.getStatus(),
        createdAt: job.getCreatedAt(),
        updatedAt: job.getUpdatedAt(),
        startedAt: job.getStartedAt(),
        endedAt: job.getEndedAt(),
        recordExpiresAt: job.getRecordExpiresAt(),
        resultLocation: job.getResultLocation(),
        resultType: job.getResultType(),
        result: job.getResult(),
        error: job.getError(),
        metadata: job.getMetadata(),
      });
    } catch (error) {
      log.error(`Failed to get preflight job status: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  return {
    createPreflightJob,
    getPreflightJobStatusAndResult,
  };
}

export default PreflightController;
