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
  hasText, isNonEmptyObject, isValidUUID, isValidUrl, isNonEmptyArray,
} from '@adobe/spacecat-shared-utils';
import {
  badRequest, internalServerError, notFound, ok, accepted,
} from '@adobe/spacecat-shared-http-utils';
import { AsyncJob } from '@adobe/spacecat-shared-data-access';
import { ErrorWithStatusCode } from '../support/utils.js';
import { getHeader } from '../support/http-headers.js';
import {
  MISSING_X_PROMISE_TOKEN_MESSAGE,
  PROMISE_BASED_AUTHORING_TYPES,
  STATUS_BAD_REQUEST,
  X_PROMISE_TOKEN_HEADER,
} from '../utils/constants.js';

export const AUDIT_STEP_IDENTIFY = 'identify';
export const AUDIT_STEP_SUGGEST = 'suggest';

const ACCESSIBILITY_AUDIT_NAME = 'accessibility';

/**
 * Counts the number of issues for a single preflight audit. Three counting modes:
 *  - accessibility: sum of the integer `occurrences` across opportunities
 *    (each opportunity is an issue "type" with N occurrences).
 *  - opportunities whose `issue` is an array (e.g. links): sum of the issue-array
 *    lengths (each entry is one issue).
 *  - all others: one issue per opportunity that has a truthy `issue` (exactly one
 *    issue per opportunity).
 * @param {Object} audit - A PreflightAudit: { name, type, opportunities }
 * @returns {number} Total issue count for the audit
 */
export function countIssuesForAudit(audit) {
  const opportunities = Array.isArray(audit?.opportunities) ? audit.opportunities : [];
  if (audit?.name === ACCESSIBILITY_AUDIT_NAME) {
    return opportunities.reduce((sum, opp) => sum + (opp?.occurrences ?? 0), 0);
  }
  return opportunities.reduce((count, opp) => {
    if (Array.isArray(opp?.issue)) {
      return count + opp.issue.length;
    }
    if (opp?.issue) {
      return count + 1;
    }
    return count;
  }, 0);
}

/**
 * Process identifier tagged onto the preflight outcome logs so a single log
 * line tells you which surface emitted it.
 *  - PREFLIGHT_PROCESS_AUDW → audit-worker path: POST/GET /preflight/jobs (SQS)
 */
export const PREFLIGHT_PROCESS_AUDW = 'audw';

/**
 * Emits the server-side observability log for a terminal AsyncJob when preflight is
 * polled, from the getPreflightJobStatusAndResult (audit-worker path) poll handler.
 * @param {Object} log - The logger instance
 * @param {string} processName - PREFLIGHT_PROCESS_AUDW
 * @param {Object} job - The AsyncJob entity (its getId() is the logged jobId)
 */
export function logPreflightOutcome(log, processName, job) {
  const jobId = job.getId();
  const status = job.getStatus();
  const result = job.getResult();
  if (status === AsyncJob.Status.COMPLETED && isNonEmptyArray(result)) {
    const summary = result.map((r) => ({
      pageUrl: r?.pageUrl,
      step: r?.step,
      audits: (Array.isArray(r?.audits) ? r.audits : []).map((a) => ({
        name: a?.name,
        type: a?.type,
        opportunities: Array.isArray(a?.opportunities) ? a.opportunities.length : 0,
        issues: countIssuesForAudit(a),
      })),
    }));
    log.info(`[Preflight] Run complete. jobId=${jobId} process=${processName} status=${status} results=${JSON.stringify(summary)}`);
  } else if (status === AsyncJob.Status.FAILED) {
    const err = job.getError();
    log.warn(`[Preflight] Run failed. jobId=${jobId} process=${processName} status=${status} errorCode=${err?.code ?? 'none'} errorMessage=${err?.message ?? 'none'}`);
  }
}

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
   * @param {string[]} data.urls - Array of URLs to process
   * @param {string} data.step - The audit step (AUDIT_STEP_IDENTIFY or AUDIT_STEP_SUGGEST)
   * @throws {Error} If data is invalid or missing required fields
   */
  function validateRequestData(data) {
    if (!isNonEmptyObject(data)) {
      throw new Error('Invalid request: missing application/json data');
    }

    if (!isNonEmptyArray(data.urls)) {
      throw new Error('Invalid request: urls must be a non-empty array');
    }

    if (!data.urls.every((url) => typeof url === 'string' && isValidUrl(url))) {
      throw new Error('Invalid request: all urls must be valid URLs');
    }

    // Check that all URLs belong to the same website
    const firstUrl = new URL(data.urls[0]);
    const firstHostname = firstUrl.hostname;
    if (!data.urls.every((url) => new URL(url).hostname === firstHostname)) {
      throw new Error('Invalid request: all urls must belong to the same website');
    }

    if (![AUDIT_STEP_IDENTIFY, AUDIT_STEP_SUGGEST].includes(data?.step?.toLowerCase())) {
      throw new Error(
        `Invalid request: step must be either ${AUDIT_STEP_IDENTIFY} or ${AUDIT_STEP_SUGGEST}`,
      );
    }
  }

  /**
   * Checks if authentication is enabled for a given URL
   * @param {string} url - The URL to check
   * @returns {Promise<boolean>} True if authentication is enabled, false otherwise
   */
  async function checkEnableAuthentication(url) {
    const headResponse = await fetch(url, {
      method: 'HEAD',
      headers: { 'Content-Type': 'application/json' },
    });

    log.debug(`checkEnableAuthentication for ${url} returned status: ${headResponse.status}`);

    return headResponse.status === 401 || headResponse.status === 403;
  }

  /**
   * Resolves the IMS promise token for promise-based authoring types (CS, CS_CW, AMS).
   * @param {Object} site - Site entity
   * @param {Object} context - Request context with pathInfo.headers
   * @returns {Promise<{ promise_token: string } | null>} Token object, or null
   * @throws {ErrorWithStatusCode} 400 when the header is missing or empty
   */
  async function resolvePromiseToken(site, context) {
    if (!PROMISE_BASED_AUTHORING_TYPES.includes(site.getAuthoringType())) {
      return null;
    }
    let promiseTokenHeader = getHeader(context, X_PROMISE_TOKEN_HEADER);
    if (hasText(promiseTokenHeader)) {
      try {
        promiseTokenHeader = decodeURIComponent(promiseTokenHeader);
      } catch {
        // Bearer-style tokens may contain literal %; use trimmed value as-is
      }
    }
    // Re-check after decode
    if (hasText(promiseTokenHeader)) {
      return { promise_token: promiseTokenHeader };
    }
    throw new ErrorWithStatusCode(MISSING_X_PROMISE_TOKEN_MESSAGE, STATUS_BAD_REQUEST);
  }

  /**
   * Creates a new preflight job. For promise-based authoring types (CS, CS_CW, AMS),
   * the promise token must be sent on the `x-promise-token` header (from POST /auth/v2/promise).
   * @param {Object} context - The request context
   * @param {Object} context.data - The request data
   * @param {string[]} context.data.urls - Array of URLs to process
   * @param {string} context.data.step - The audit step
   * @param {string} context.data.siteId - The siteId, if it's an AMS site
   * @param {Object} [context.pathInfo] - The path info object
   * @param {Object} [context.pathInfo.headers] - Request headers; must include `x-promise-token`
   * @returns {Promise<Object>} The HTTP response object
  */
  const createPreflightJob = async (context) => {
    log.debug('createPreflightJob started');
    const { data } = context;
    try {
      validateRequestData(data);
    } catch (error) {
      log.error(`Invalid request data: ${error.message}`);
      return badRequest(error.message);
    }

    try {
      const isDev = env.AWS_ENV === 'dev';
      const step = data.step.toLowerCase();
      const url = new URL(data.urls[0]);
      const previewBaseURL = `${url.protocol}//${url.hostname}`;

      let site;
      if (isValidUUID(data.siteId)) {
        site = await dataAccess.Site.findById(data.siteId);
      } else {
        site = await dataAccess.Site.findByPreviewURL(previewBaseURL);
      }

      log.debug(`createPreflightJob url: ${url}, siteId: ${data.siteId}, step: ${step}`);

      if (!site) {
        throw new Error(`No site found for preview URL: ${previewBaseURL}`);
      }

      const enableAuthentication = await checkEnableAuthentication(previewBaseURL);

      let promiseTokenResponse;
      try {
        promiseTokenResponse = await resolvePromiseToken(site, context);
      } catch (e) {
        log.error(`Failed to get promise token: ${e.message}`);
        if (e instanceof ErrorWithStatusCode) {
          return badRequest(e.message);
        }
        return internalServerError('Error getting promise token');
      }

      // Create a new async job
      const jobPayload = {
        siteId: site.getId(),
        urls: data.urls,
        step,
        enableAuthentication,
      };

      log.debug(`createPreflightJob creating async job with payload: ${JSON.stringify(jobPayload)}`);

      const job = await dataAccess.AsyncJob.create({
        status: 'IN_PROGRESS',
        metadata: {
          payload: jobPayload,
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });

      // Log for dashboard purposes
      log.info(`[Preflight] created async job with jobId=${job.getId()}, siteId=${site.getId()}, `
        + `orgId=${site.getOrganizationId()}, urls=${JSON.stringify(data.urls)}, step=${step}.`);

      try {
        // Send message to SQS to trigger the audit worker
        const sqsMessage = {
          jobId: job.getId(),
          siteId: site.getId(),
          type: 'preflight',
          ...(ctx.traceId && { traceId: ctx.traceId }),
        };

        // remove the promiseToken from the message if it exists from the debug log
        log.debug(`createPreflightJob sending message to SQS with payload: ${JSON.stringify(sqsMessage)}`);

        if (PROMISE_BASED_AUTHORING_TYPES.includes(site.getAuthoringType())) {
          sqsMessage.promiseToken = promiseTokenResponse;
        }

        await sqs.sendMessage(env.AUDIT_JOBS_QUEUE_URL, sqsMessage);
      } catch (error) {
        log.error(`Failed to send message to SQS: ${error.message}, rolling back job ${job.getId()}`);
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
    log.debug(`getPreflightJobStatusAndResult for jobId: ${context.params?.jobId}`);

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

      log.debug(`getPreflightJobStatusAndResult returning job: ${JSON.stringify(job)}`);

      // Emit the terminal-state observability log (shared with the Mystique path).
      logPreflightOutcome(log, PREFLIGHT_PROCESS_AUDW, job);

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
