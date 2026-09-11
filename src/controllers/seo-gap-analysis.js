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
  hasText,
  isNonEmptyObject,
  isValidUrl,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import {
  accepted, badRequest, internalServerError, ok,
} from '@adobe/spacecat-shared-http-utils';
import { AsyncJob } from '@adobe/spacecat-shared-data-access';
import { loadJobScopedToCaller } from '../support/async-job-access.js';

const JOB_TYPE = 'seo-gap-analysis';
const MAX_FILTER_DOMAINS = 50;

/**
 * Validates the list of domains to exclude from the SERP.
 * Each entry must be a bare hostname (no scheme/path/whitespace).
 */
function isValidFilterDomains(filterDomains) {
  if (filterDomains === undefined) {
    return true;
  }
  if (!Array.isArray(filterDomains) || filterDomains.length > MAX_FILTER_DOMAINS) {
    return false;
  }
  return filterDomains.every(
    (d) => hasText(d) && !/\s/.test(d) && !d.includes('://') && !d.includes('/'),
  );
}

/**
 * Creates a SEO gap analysis controller instance.
 *
 * Runs a keyword through the SERP, discovers competitor pages ranking for it, scrapes and
 * analyzes each for SEO/GEO/AEO signals, and returns a structured gap report of the target
 * page versus the competitors. The heavy lifting runs asynchronously in the audit worker;
 * callers always get 202 + jobId and poll the GET endpoint for the terminal result.
 *
 * @param {Object} ctx - The context object (dataAccess, sqs).
 * @param {Object} log - The logger instance.
 * @param {Object} env - The environment configuration object.
 * @returns {Object} The controller instance.
 */
function SeoGapAnalysisController(ctx, log, env) {
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
   * Creates a new async SEO gap analysis job.
   *
   * @param {Object} context - The request context.
   * @param {Object} context.data - The request body.
   * @param {string} context.data.keyword - The search keyword to analyze.
   * @param {string} context.data.targetUrl - The URL being optimized.
   * @param {string[]} [context.data.filterDomains] - Domains to exclude from the SERP.
   * @param {Object} [context.data.currentRanking] - Optional current performance context.
   * @returns {Promise<Object>} 202 Accepted with jobId and pollUrl, or an error response.
   */
  const createSeoGapAnalysisJob = async (context) => {
    if (!hasText(env.AUDIT_JOBS_QUEUE_URL)) {
      log.error('AUDIT_JOBS_QUEUE_URL is not configured');
      return internalServerError('Service misconfiguration: AUDIT_JOBS_QUEUE_URL is not set');
    }

    const { data } = context;
    if (!isNonEmptyObject(data)) {
      return badRequest('Invalid request: missing application/json data');
    }

    const {
      keyword, targetUrl, filterDomains, currentRanking, locale,
    } = data;

    if (!hasText(keyword)) {
      return badRequest('Invalid request: keyword is required');
    }
    if (!isValidUrl(targetUrl)) {
      return badRequest('Invalid request: targetUrl must be a valid URL');
    }
    if (!isValidFilterDomains(filterDomains)) {
      return badRequest('Invalid request: filterDomains must be an array of at most 50 bare hostnames');
    }

    const isDev = env.AWS_ENV === 'dev';

    try {
      const job = await dataAccess.AsyncJob.create({
        status: AsyncJob.Status.IN_PROGRESS,
        metadata: {
          payload: {
            keyword,
            targetUrl,
            filterDomains: filterDomains ?? [],
            currentRanking: currentRanking ?? null,
            locale: locale ?? null,
          },
          jobType: JOB_TYPE,
          tags: [JOB_TYPE],
        },
      });

      try {
        await sqs.sendMessage(env.AUDIT_JOBS_QUEUE_URL, {
          type: JOB_TYPE,
          jobId: job.getId(),
          keyword,
          targetUrl,
          filterDomains: filterDomains ?? [],
          currentRanking: currentRanking ?? null,
          locale: locale ?? null,
        });
      } catch (sqsError) {
        log.error(`Failed to send message to SQS for job ${job.getId()}: ${sqsError.message}`);
        try {
          await job.remove();
        } catch (removeErr) {
          log.error(`Failed to remove orphaned job ${job.getId()}: ${removeErr.message}`);
        }
        throw new Error('Failed to send message to SQS', { cause: sqsError });
      }

      return accepted({
        jobId: job.getId(),
        status: job.getStatus(),
        createdAt: job.getCreatedAt(),
        pollUrl: `https://spacecat.experiencecloud.live/api/${isDev ? 'ci' : 'v1'}/${JOB_TYPE}/jobs/${job.getId()}`,
      });
    } catch (error) {
      log.error(`Failed to create SEO gap analysis job: ${error.message}`);
      return internalServerError('Failed to create SEO gap analysis job');
    }
  };

  /**
   * Returns the status and result of a SEO gap analysis job.
   *
   * @param {Object} context - The request context.
   * @param {string} context.params.jobId - The job ID to poll.
   * @returns {Promise<Object>} Job status and result.
   */
  const getSeoGapAnalysisJobStatus = async (context) => {
    const jobId = context.params?.jobId;

    if (!isValidUUID(jobId)) {
      log.warn(`Invalid jobId: ${jobId}`);
      return badRequest('Invalid jobId');
    }

    try {
      // Scope the read to a seo-gap-analysis job (jobType allowlist) so this reader cannot be
      // used to fetch other job types through the shared AsyncJob table.
      const { job, error: accessError } = await loadJobScopedToCaller(ctx, {
        jobId,
        allowedJobTypes: [JOB_TYPE],
      });

      if (accessError) {
        return accessError;
      }

      const rawError = job.getError();

      return ok({
        jobId: job.getId(),
        status: job.getStatus(),
        createdAt: job.getCreatedAt(),
        updatedAt: job.getUpdatedAt(),
        result: job.getResult() ?? null,
        error: rawError ? { code: rawError.code, message: rawError.message } : null,
      });
    } catch (error) {
      log.error(`Failed to get SEO gap analysis job status: ${error.message}`);
      return internalServerError('Failed to get SEO gap analysis job status');
    }
  };

  return {
    createSeoGapAnalysisJob,
    getSeoGapAnalysisJobStatus,
  };
}

export default SeoGapAnalysisController;
