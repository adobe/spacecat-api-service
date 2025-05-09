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
  hasText, isNonEmptyObject, isValidUUID,
} from '@adobe/spacecat-shared-utils';
import {
  badRequest, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';

function PreflightController(ctx, log, env) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;

  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  if (!isNonEmptyObject(env)) {
    throw new Error('Environment object required');
  }

  function validateRequestData(data) {
    if (!isNonEmptyObject(data)) {
      throw new Error('Invalid request: missing application/json data');
    }

    if (!hasText(data.pageUrl?.trim())) {
      throw new Error('Invalid request: missing pageUrl in request data');
    }
  }

  const createPreflightJob = async (context) => {
    const { data } = context;

    try {
      validateRequestData(data);
    } catch (error) {
      log.error(`Invalid request data: ${error.message}`);
      return badRequest(error.message);
    }

    try {
      const funcVersion = context.func?.version;
      const isDev = /^ci\d*$/i.test(funcVersion);

      log.info(`Creating preflight job for pageUrl: ${data.pageUrl}`);

      // Create a new async job
      const job = await dataAccess.AsyncJob.create({
        status: 'IN_PROGRESS',
        metadata: {
          payload: {
            pageUrl: data.pageUrl,
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });

      return ok({
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

  const getPreflightJobStatusAndResult = async (context) => {
    const jobId = context.params?.jobId;

    log.info(`Getting preflight job status for jobId: ${jobId}`);

    if (!isValidUUID(jobId)) {
      return badRequest('Invalid jobId');
    }

    try {
      const job = await dataAccess.AsyncJob.findById(jobId);

      if (!job) {
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
