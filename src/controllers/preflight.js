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

import { AsyncJob } from '@adobe/spacecat-shared-data-access';
import { isNonEmptyObject, isValidUrl } from '@adobe/spacecat-shared-utils';

export default function PreflightController(
  dataAccess,
  logger,
  env,
  utils = { isNonEmptyObject, isValidUrl },
  AsyncJobClass = AsyncJob,
) {
  if (!dataAccess || typeof dataAccess !== 'object') {
    throw new Error('Data access required');
  }

  if (!env || typeof env !== 'object') {
    throw new Error('Environment object required');
  }

  const { AsyncJob: asyncJobCollection } = dataAccess;

  return {
    async createPreflightJob(context) {
      try {
        const { data, func } = context;
        if (!data || !utils.isNonEmptyObject(data)) {
          logger.error('Failed to create preflight job: Invalid request: missing application/json data');
          return new Response(JSON.stringify({ message: 'Invalid request: missing application/json data' }), { status: 400 });
        }

        const { pageUrl } = data;
        if (!pageUrl || typeof pageUrl !== 'string' || !utils.isValidUrl(pageUrl)) {
          logger.error('Failed to create preflight job: Invalid request: missing pageUrl in request data');
          return new Response(JSON.stringify({ message: 'Invalid request: missing pageUrl in request data' }), { status: 400 });
        }

        logger.info(`Creating preflight job for pageUrl: ${pageUrl}`);

        // Create a new async job
        let asyncJob;
        try {
          asyncJob = new AsyncJobClass();
        } catch (error) {
          logger.error(`Failed to create preflight job: ${error.message}`);
          return new Response(JSON.stringify({ message: error.message }), { status: 500 });
        }

        try {
          asyncJob.setStatus(AsyncJobClass.Status.IN_PROGRESS);
          asyncJob.setType('preflight');
          asyncJob.setData({ pageUrl });
        } catch (error) {
          logger.error(`Failed to create preflight job: ${error.message}`);
          return new Response(JSON.stringify({ message: error.message }), { status: 500 });
        }

        try {
          await asyncJob.save();
        } catch (error) {
          logger.error(`Failed to create preflight job: ${error.message}`);
          return new Response(JSON.stringify({ message: error.message }), { status: 500 });
        }

        // Send message to SQS queue
        const message = {
          jobId: asyncJob.getId(),
          pageUrl,
          type: 'preflight',
        };

        try {
          await context.sqs.sendMessage(env.AUDIT_WORKER_QUEUE_URL, message);
        } catch (error) {
          logger.error(`Failed to create preflight job: ${error.message}`);
          return new Response(JSON.stringify({ message: error.message }), { status: 500 });
        }

        const baseUrl = func.version === 'ci' ? 'https://spacecat.experiencecloud.live/api/ci' : 'https://spacecat.experiencecloud.live/api/v1';
        const pollUrl = `${baseUrl}/preflight/jobs/${asyncJob.getId()}`;

        return new Response(JSON.stringify({
          jobId: asyncJob.getId(),
          status: asyncJob.getStatus(),
          createdAt: asyncJob.getCreatedAt(),
          pollUrl,
        }), { status: 202 });
      } catch (error) {
        logger.error(`Failed to create preflight job: ${error.message}`);
        return new Response(JSON.stringify({ message: error.message }), { status: 500 });
      }
    },

    async getPreflightJobStatusAndResult(context) {
      try {
        const { params } = context;
        const { jobId } = params;

        if (!jobId) {
          logger.error('Failed to get preflight job: Invalid request: missing jobId parameter');
          return new Response(JSON.stringify({ message: 'Invalid request: missing jobId parameter' }), { status: 400 });
        }

        logger.info(`Getting preflight job status for jobId: ${jobId}`);

        let asyncJob;
        try {
          asyncJob = await asyncJobCollection.findById(jobId);
        } catch (error) {
          logger.error(`Failed to get preflight job: ${error.message}`);
          return new Response(JSON.stringify({ message: error.message }), { status: 500 });
        }

        if (!asyncJob) {
          logger.error(`Failed to get preflight job: Job not found with id: ${jobId}`);
          return new Response(JSON.stringify({ message: 'Job not found' }), { status: 404 });
        }

        let jobIdValue;
        let status;
        let createdAt;
        let updatedAt;
        let startedAt;
        let endedAt;
        let recordExpiresAt;
        let result;
        let error;
        try {
          jobIdValue = asyncJob.getId();
          status = asyncJob.getStatus();
          createdAt = asyncJob.getCreatedAt();
          updatedAt = asyncJob.getUpdatedAt();
          startedAt = asyncJob.getStartedAt();
          endedAt = asyncJob.getEndedAt();
          recordExpiresAt = asyncJob.getRecordExpiresAt();
          result = asyncJob.getResult();
          error = asyncJob.getError();
        } catch (err) {
          logger.error(`Failed to get preflight job: ${err.message}`);
          return new Response(JSON.stringify({ message: err.message }), { status: 500 });
        }

        return new Response(JSON.stringify({
          jobId: jobIdValue,
          status,
          createdAt,
          updatedAt,
          startedAt,
          endedAt,
          recordExpiresAt,
          result,
          error,
        }), { status: 200 });
      } catch (error) {
        logger.error(`Failed to get preflight job: ${error.message}`);
        return new Response(JSON.stringify({ message: error.message }), { status: 500 });
      }
    },
  };
}
