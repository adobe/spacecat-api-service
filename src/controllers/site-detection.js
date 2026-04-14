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
  composeBaseURL,
  hasText,
  isInteger,
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import {
  accepted, badRequest, conflict, internalServerError, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';

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
   * Returns 409 if the domain is already known (existing Site or SiteCandidate).
   *
   * @param {Object} context - The request context
   * @param {Object} context.data - The request body
   * @param {string} context.data.domain - The hostname to detect (e.g. "www.example.com")
   * @param {number} [context.data.hlxVersion] - The Helix version detected from CDN logs
   * @returns {Promise<Object>} 202 Accepted with jobId and pollUrl, or error response
   */
  const createSiteDetectionJob = async (context) => {
    const { data } = context;

    if (!isNonEmptyObject(data)) {
      return badRequest('Invalid request: missing application/json data');
    }

    const { domain, hlxVersion } = data;

    if (!hasText(domain)) {
      return badRequest('Invalid request: domain is required');
    }

    if (hlxVersion !== undefined && !isInteger(hlxVersion)) {
      return badRequest('Invalid request: hlxVersion must be an integer');
    }

    const baseURL = composeBaseURL(domain);

    try {
      // Early exit: already a known site
      const existingSite = await dataAccess.Site.findByBaseURL(baseURL);
      if (existingSite && existingSite.getDeliveryType() === SiteModel.DELIVERY_TYPES.AEM_EDGE) {
        log.info(`Site detection skipped: site already exists for ${baseURL}`);
        return conflict(`Site already exists for domain: ${domain}`);
      }

      // Early exit: already evaluated as a candidate
      const existingCandidate = await dataAccess.SiteCandidate.findByBaseURL(baseURL);
      if (existingCandidate !== null) {
        log.info(`Site detection skipped: site candidate already exists for ${baseURL}`);
        return conflict(`Site candidate already exists for domain: ${domain}`);
      }

      const isDev = env.AWS_ENV === 'dev';

      const job = await dataAccess.AsyncJob.create({
        status: 'IN_PROGRESS',
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
      } catch (error) {
        log.error(`Failed to send message to SQS: ${error.message}`);
        await job.remove();
        throw new Error(`Failed to send message to SQS: ${error.message}`);
      }

      return accepted({
        jobId: job.getId(),
        status: job.getStatus(),
        createdAt: job.getCreatedAt(),
        pollUrl: `https://spacecat.experiencecloud.live/api/${isDev ? 'ci' : 'v1'}/sites/detect/jobs/${job.getId()}`,
      });
    } catch (error) {
      log.error(`Failed to create site detection job: ${error.message}`);
      return internalServerError(error.message);
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
      log.error(`Invalid jobId: ${jobId}`);
      return badRequest('Invalid jobId');
    }

    try {
      const job = await dataAccess.AsyncJob.findById(jobId);

      if (!job) {
        log.error(`Job with ID ${jobId} not found`);
        return notFound(`Job with ID ${jobId} not found`);
      }

      const result = job.getResult();

      return ok({
        jobId: job.getId(),
        status: job.getStatus(),
        createdAt: job.getCreatedAt(),
        updatedAt: job.getUpdatedAt(),
        result: result ? {
          action: result.action,
          domain: result.domain,
          reason: result.reason,
        } : null,
        error: job.getError(),
      });
    } catch (error) {
      log.error(`Failed to get site detection job status: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  return {
    createSiteDetectionJob,
    getSiteDetectionJobStatus,
  };
}

export default SiteDetectionController;
