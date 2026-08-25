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
  hasText,
  isInteger,
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import {
  accepted, badRequest, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { AsyncJob } from '@adobe/spacecat-shared-data-access';

// RFC 1035 caps a fully-qualified domain name at 253 octets.
const MAX_DOMAIN_LENGTH = 253;

/**
 * Hostname sanity check at the HTTP boundary.
 * The worker owns strict validation (IP check, ignored tokens, Helix DOM check);
 * this only guards against obviously non-hostname payloads (whitespace,
 * scheme, path) and oversized strings that would hit the DB as-is.
 */
function isValidDomain(domain) {
  if (!hasText(domain)) {
    return false;
  }
  if (domain.length > MAX_DOMAIN_LENGTH) {
    return false;
  }
  if (/\s/.test(domain) || domain.includes('://') || domain.includes('/')) {
    return false;
  }
  return true;
}

/**
 * Creates a site detection controller instance.
 * Used by the DaaS team to trigger async site detection jobs from externally ingested CDN logs.
 * @param {Object} ctx - The context object
 * @param {Object} ctx.dataAccess - The data access layer
 * @param {Object} ctx.sqs - The SQS client instance
 * @param {Object} log - The logger instance
 * @param {Object} env - The environment configuration object
 * @returns {Object} The site detection controller instance
 */
function SiteDetectionController(ctx, log, env) {
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
   * Creates a new async site detection job.
   * The worker owns duplicate detection — callers always get 202 + jobId and
   * must poll the GET endpoint for the terminal outcome (created / duplicate /
   * rejected).
   *
   * @param {Object} context - The request context
   * @param {Object} context.data - The request body
   * @param {string} context.data.domain - The hostname to detect (e.g. "www.example.com")
   * @param {number} [context.data.hlxVersion] - The Helix version detected from CDN logs
   * @returns {Promise<Object>} 202 Accepted with jobId and pollUrl, or error response
   */
  const createSiteDetectionJob = async (context) => {
    if (!hasText(env.AUDIT_JOBS_QUEUE_URL)) {
      log.error('AUDIT_JOBS_QUEUE_URL is not configured');
      return internalServerError('Service misconfiguration: AUDIT_JOBS_QUEUE_URL is not set');
    }

    const { data } = context;

    if (!isNonEmptyObject(data)) {
      return badRequest('Invalid request: missing application/json data');
    }

    const { domain, hlxVersion } = data;

    if (!isValidDomain(domain)) {
      return badRequest('Invalid request: domain must be a non-empty hostname without scheme, path, or whitespace, and at most 253 characters');
    }

    if (hlxVersion !== undefined && !isInteger(hlxVersion)) {
      return badRequest('Invalid request: hlxVersion must be an integer');
    }

    const isDev = env.AWS_ENV === 'dev';

    try {
      const job = await dataAccess.AsyncJob.create({
        status: AsyncJob.Status.IN_PROGRESS,
        metadata: {
          payload: {
            domain,
            hlxVersion: hlxVersion ?? null,
          },
          jobType: 'site-detection',
          tags: ['site-detection'],
        },
      });

      try {
        await sqs.sendMessage(env.AUDIT_JOBS_QUEUE_URL, {
          jobId: job.getId(),
          type: 'site-detection',
        });
      } catch (sqsError) {
        log.error(`Failed to send message to SQS for job ${job.getId()}: ${sqsError.message}`);
        try {
          await job.remove();
        } catch (removeErr) {
          log.error(`Failed to remove orphaned job ${job.getId()}: ${removeErr.message}`);
          try {
            job.setStatus(AsyncJob.Status.FAILED);
            job.setError({ code: 'SQS_FAILURE', message: sqsError.message });
            await job.save();
          } catch (saveErr) {
            log.error(`Failed to mark orphan job ${job.getId()} as FAILED: ${saveErr.message}`);
          }
        }
        throw new Error('Failed to send message to SQS', { cause: sqsError });
      }

      return accepted({
        jobId: job.getId(),
        status: job.getStatus(),
        createdAt: job.getCreatedAt(),
        pollUrl: `https://spacecat.experiencecloud.live/api/${isDev ? 'ci' : 'v1'}/sites/detect/jobs/${job.getId()}`,
      });
    } catch (error) {
      log.error(`Failed to create site detection job: ${error.message}`);
      return internalServerError('Failed to create site detection job');
    }
  };

  /**
   * Returns the status and abstracted result of a site detection job.
   *
   * @param {Object} context - The request context
   * @param {string} context.params.jobId - The job ID to poll
   * @returns {Promise<Object>} Job status and result
   */
  const getSiteDetectionJobStatus = async (context) => {
    const jobId = context.params?.jobId;

    if (!isValidUUID(jobId)) {
      log.warn(`Invalid jobId: ${jobId}`);
      return badRequest('Invalid jobId');
    }

    try {
      const job = await dataAccess.AsyncJob.findById(jobId);

      if (!job) {
        log.warn(`Job with ID ${jobId} not found`);
        return notFound(`Job with ID ${jobId} not found`);
      }

      const result = job.getResult();
      const rawError = job.getError();

      return ok({
        jobId: job.getId(),
        status: job.getStatus(),
        createdAt: job.getCreatedAt(),
        updatedAt: job.getUpdatedAt(),
        result: result ? {
          action: result.action,
          domain: result.domain,
          baseURL: result.baseURL,
          reason: result.reason,
        } : null,
        error: rawError ? { code: rawError.code, message: rawError.message } : null,
      });
    } catch (error) {
      log.error(`Failed to get site detection job status: ${error.message}`);
      return internalServerError('Failed to get site detection job status');
    }
  };

  return {
    createSiteDetectionJob,
    getSiteDetectionJobStatus,
  };
}

export default SiteDetectionController;
