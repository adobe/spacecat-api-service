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
import { AsyncJob, Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import { getCookieValue, getIMSPromiseToken, ErrorWithStatusCode } from '../support/utils.js';

export const AUDIT_STEP_IDENTIFY = 'identify';
export const AUDIT_STEP_SUGGEST = 'suggest';

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
   * Creates a new preflight job. For promise-based authoring types (CS, CS_CW, AMS),
   * the promise token is resolved from the promiseToken cookie sent by the browser
   * (set via /auth/promise endpoint), otherwise falls back to creating one from
   * the Authorization header via IMS.
   * @param {Object} context - The request context
   * @param {Object} context.data - The request data
   * @param {string[]} context.data.urls - Array of URLs to process
   * @param {string} context.data.step - The audit step
   * @param {string} context.data.siteId - The siteId, if it's an AMS site
   * @param {Object} [context.pathInfo] - The path info object
   * @param {Object} [context.pathInfo.headers] - Request headers; must include a
   *   `cookie` header with `promiseToken=<token>` for CS/CS_CW/AMS authoring types
   * @returns {Promise<Object>} The HTTP response object
   */
  const createPreflightJob = async (context) => {
    const { data } = context;
    const promiseBasedTypes = [
      SiteModel.AUTHORING_TYPES.CS, SiteModel.AUTHORING_TYPES.CS_CW, SiteModel.AUTHORING_TYPES.AMS,
    ];
    try {
      validateRequestData(data);
    } catch (error) {
      log.error(`Invalid request data: ${error.message}`);
      return badRequest(error.message);
    }

    try {
      const isDev = env.AWS_ENV === 'dev';
      const step = data.step.toLowerCase();
      let site;
      const url = new URL(data.urls[0]);
      const previewBaseURL = `${url.protocol}//${url.hostname}`;
      if (isValidUUID(data.siteId)) {
        site = await dataAccess.Site.findById(data.siteId);
      } else {
        site = await dataAccess.Site.findByPreviewURL(previewBaseURL);
      }

      if (!site) {
        throw new Error(`No site found for preview URL: ${previewBaseURL}`);
      }
      let enableAuthentication = false;
      // check head request for preview url
      const headResponse = await fetch(`${previewBaseURL}`, {
        method: 'HEAD',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      if (headResponse.status !== 200) {
        enableAuthentication = true;
      }

      let promiseTokenResponse;
      if (promiseBasedTypes.includes(site.getAuthoringType())) {
        const cookieToken = getCookieValue(context, 'promiseToken');
        if (hasText(cookieToken)) {
          promiseTokenResponse = { promise_token: cookieToken };
        } else {
          try {
            promiseTokenResponse = await getIMSPromiseToken(context);
          } catch (e) {
            log.error(`Failed to get promise token: ${e.message}`);
            if (e instanceof ErrorWithStatusCode) {
              return badRequest(e.message);
            }
            return internalServerError('Error getting promise token');
          }
        }
      }

      // Create a new async job
      const job = await dataAccess.AsyncJob.create({
        status: 'IN_PROGRESS',
        metadata: {
          payload: {
            siteId: site.getId(),
            urls: data.urls,
            step,
            enableAuthentication,
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });

      try {
        // Send message to SQS to trigger the audit worker
        const sqsMessage = {
          jobId: job.getId(),
          siteId: site.getId(),
          type: 'preflight',
        };
        if (promiseBasedTypes.includes(site.getAuthoringType())) {
          sqsMessage.promiseToken = promiseTokenResponse;
        }
        await sqs.sendMessage(env.AUDIT_JOBS_QUEUE_URL, sqsMessage);
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

  /**
   * Calls Mysticat's POST /v1/preflight/analyze and returns once the request is accepted.
   * Mysticat processes the analysis asynchronously and writes results directly to the AsyncJob
   * identified by scanId.
   * @param {string} mysticatBaseUrl - The base URL of the Mystique service (MYSTIQUE_API_BASE_URL).
   * @param {string} scanId - The AsyncJob ID used as the scan identifier for write-back.
   * @param {string} siteId - The site ID.
   * @param {string} url - The page URL to analyze.
   * @param {string} step - The audit step (identify or suggest).
   * @param {string} [promiseToken] - Optional promise token forwarded as x-promise-token for
   *   authenticated CMS page fetching (CS, CS_CW, AMS sites).
   */
  async function callMysticatAnalyze(
    mysticatBaseUrl,
    scanId,
    siteId,
    url,
    step,
    promiseToken,
  ) {
    const response = await fetch(`${mysticatBaseUrl}/v1/preflight/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(hasText(promiseToken) && { 'x-promise-token': promiseToken }),
      },
      body: JSON.stringify({
        site_id: siteId, url, mode: step, scan_id: scanId, persist: true,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Mysticat returned ${response.status}: ${text}`);
    }
  }

  /**
   * Creates a new beta preflight job by proxying to Mysticat's analyze endpoint.
   * For promise-based authoring types (CS, CS_CW, AMS), the promise token is resolved
   * from the promiseToken cookie if present, otherwise falls back to IMS.
   * The resolved token is forwarded to Mysticat as x-promise-token so it can authenticate
   * against the CMS when fetching the page.
   * @param {Object} context - The request context
   * @param {Object} context.data - The request data
   * @param {string} context.data.url - Single URL to analyze
   * @param {string} context.data.step - The audit step (identify or suggest)
   * @param {string} [context.data.siteId] - Optional site ID
   * @param {Object} [context.pathInfo] - The path info object
   * @param {Object} [context.pathInfo.headers] - Request headers; must include a
   *   `cookie` header with `promiseToken=<token>` for CS/CS_CW/AMS authoring types
   * @returns {Promise<Object>} The HTTP response object
   */
  const createBetaPreflightJob = async (context) => {
    const { data } = context;
    const promiseBasedTypes = [
      SiteModel.AUTHORING_TYPES.CS, SiteModel.AUTHORING_TYPES.CS_CW, SiteModel.AUTHORING_TYPES.AMS,
    ];

    if (!isNonEmptyObject(data)) {
      return badRequest('Invalid request: missing application/json data');
    }

    if (!hasText(data.url) || !isValidUrl(data.url)) {
      return badRequest('Invalid request: url must be a valid URL');
    }

    if (![AUDIT_STEP_IDENTIFY, AUDIT_STEP_SUGGEST].includes(data?.step?.toLowerCase())) {
      return badRequest(
        `Invalid request: step must be either ${AUDIT_STEP_IDENTIFY} or ${AUDIT_STEP_SUGGEST}`,
      );
    }

    const step = data.step.toLowerCase();
    const { url } = data;

    const isDev = env.AWS_ENV === 'dev';

    if (hasText(data.mystiqueUrl)) {
      if (!isDev) {
        return badRequest('mystiqueUrl override is only allowed in dev');
      }
      if (!isValidUrl(data.mystiqueUrl)) {
        return badRequest('Invalid request: mystiqueUrl must be a valid URL');
      }
      if (!(/\.stage\.cloud\.adobe\.io$/).test(new URL(data.mystiqueUrl).hostname)) {
        return badRequest('Invalid request: mystiqueUrl must be a valid Mystique ephemeral host');
      }
    }

    const mysticatBaseUrl = (isDev && hasText(data.mystiqueUrl))
      ? data.mystiqueUrl
      : env.MYSTIQUE_API_BASE_URL;

    try {
      const previewBaseURL = `${new URL(url).protocol}//${new URL(url).hostname}`;
      let site;
      if (isValidUUID(data.siteId)) {
        site = await dataAccess.Site.findById(data.siteId);
      } else {
        site = await dataAccess.Site.findByPreviewURL(previewBaseURL);
      }

      if (!site) {
        throw new Error(`No site found for URL: ${previewBaseURL}`);
      }

      let promiseToken;
      if (promiseBasedTypes.includes(site.getAuthoringType())) {
        const cookieToken = getCookieValue(context, 'promiseToken');
        if (hasText(cookieToken)) {
          promiseToken = cookieToken;
        } else {
          try {
            const promiseTokenResponse = await getIMSPromiseToken(context);
            promiseToken = promiseTokenResponse?.promise_token;
          } catch (e) {
            log.error(`Failed to get promise token: ${e.message}`);
            if (e instanceof ErrorWithStatusCode) {
              return badRequest(e.message);
            }
            return internalServerError('Error getting promise token');
          }
        }
      }

      const job = await dataAccess.AsyncJob.create({
        status: AsyncJob.Status.IN_PROGRESS,
        metadata: {
          payload: { siteId: site.getId(), url, step },
          jobType: 'preflight-beta',
          tags: ['preflight', 'beta'],
        },
      });

      try {
        await callMysticatAnalyze(
          mysticatBaseUrl,
          job.getId(),
          site.getId(),
          url,
          step,
          promiseToken,
        );
      } catch (mysticatError) {
        log.error(`Mysticat analyze failed: ${mysticatError.message}`);
        job.setStatus(AsyncJob.Status.FAILED);
        job.setError({ code: 'MYSTICAT_ERROR', message: mysticatError.message });
        job.setEndedAt(new Date().toISOString());
        await job.save();
        return internalServerError(`Mysticat analyze failed: ${mysticatError.message}`);
      }

      return accepted({
        jobId: job.getId(),
        status: job.getStatus(),
        createdAt: job.getCreatedAt(),
        pollUrl: `https://spacecat.experiencecloud.live/api/${isDev ? 'ci' : 'v1'}`
          + `/preflight/beta/jobs/${job.getId()}`,
      });
    } catch (error) {
      log.error(`Failed to create beta preflight job: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  /**
   * Gets the status and result of a beta preflight job.
   * @param {Object} context - The request context
   * @param {Object} context.params - The request parameters
   * @param {string} context.params.jobId - The ID of the job to retrieve
   * @returns {Promise<Object>} The HTTP response object
   */
  const getBetaPreflightJobStatusAndResult = async (context) => {
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
      log.error(`Failed to get beta preflight job status: ${error.message}`);
      return internalServerError(error.message);
    }
  };

  return {
    createPreflightJob,
    getPreflightJobStatusAndResult,
    createBetaPreflightJob,
    getBetaPreflightJobStatusAndResult,
  };
}

export default PreflightController;
