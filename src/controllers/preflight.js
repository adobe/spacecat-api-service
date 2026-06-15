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
  hasText, isNonEmptyObject, isValidUUID, isValidUrl, isNonEmptyArray, DELIVERY_TYPES,
} from '@adobe/spacecat-shared-utils';
import {
  badRequest, internalServerError, notFound, ok, accepted, createResponse,
} from '@adobe/spacecat-shared-http-utils';
import { AsyncJob } from '@adobe/spacecat-shared-data-access';
import { retrievePageAuthentication } from '@adobe/spacecat-shared-ims-client';
import AccessControlUtil from '../support/access-control-util.js';
import { PreflightDto } from '../dto/preflight.js';
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

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

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

  function preflightError(errorCode, message, status) {
    return createResponse({ errorCode, message }, status);
  }

  /**
   * Calls Mysticat's POST /v1/preflight/analyze and returns once the request is accepted.
   * Mysticat processes the analysis asynchronously and writes results directly to the AsyncJob
   * identified by scanId.
   * @param {string} mysticatBaseUrl - The base URL of the Mystique service (MYSTIQUE_API_BASE_URL).
   * @param {string} scanId - The AsyncJob ID used as the scan identifier for write-back.
   * @param {string} siteId - The site ID.
   * @param {string} url - The page URL to analyze.
   * @param {string} [authorizationHeader] - Optional auth header forwarded to Mysticat.
   */
  async function callMysticatAnalyze(
    mysticatBaseUrl,
    scanId,
    siteId,
    url,
    authorizationHeader,
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(`${mysticatBaseUrl}/v1/preflight/analyze`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(hasText(authorizationHeader) && { Authorization: authorizationHeader }),
        },
        body: JSON.stringify({
          site_id: siteId,
          url,
          scan_id: scanId,
          persist: true,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Mysticat returned ${response.status}: ${text}`);
    }
  }

  /**
   * Creates a new preflight for a site-scoped URL.
   * siteId comes from the path; url from the request body.
   * For promise-based authoring types (CS, CS_CW, AMS) that require authentication, the
   * promise token must be sent on the `x-promise-token` header (from POST /auth/v2/promise).
   * @param {Object} context - The request context
   * @returns {Promise<Object>} 202 Accepted with preflight summary and Location header
   */
  const createPreflight = async (context) => {
    const siteId = context.params?.siteId;
    const { data } = context;

    if (!isNonEmptyObject(data) || !hasText(data.url) || !isValidUrl(data.url)) {
      return preflightError('PREFLIGHT_INVALID_REQUEST', 'url is missing or not a valid URI', 400);
    }

    // mystiqueUrl override (SITES-46216): in non-prod, allow the caller to
    // point this request at a specific Mysticat host instead of the
    // env-configured one. Same shape as the legacy /preflight/beta/jobs
    // override (PR #2140, hardened in 746138e4), restored here after the
    // SITES-44686 redesign dropped it. Guards:
    //   1. AWS_ENV !== 'prod' — dead code in prod regardless of body content
    //   2. Valid URL parse
    //   3. Hostname suffix-match against *.adobe.io — broader than the
    //      original *.stage.cloud.adobe.io because corp-only Ethos hosts
    //      proved unreachable from public Lambda networking, and m-dev.adobe.io
    //      is the current publicly-reachable canonical dev host
    //   4. Tenancy boundary unchanged — caller must still pass hasAccess(site)
    const isDevForOverride = env.AWS_ENV !== 'prod';
    const useMystiqueUrlOverride = isDevForOverride && hasText(data.mystiqueUrl);
    if (useMystiqueUrlOverride) {
      if (!isValidUrl(data.mystiqueUrl)) {
        return preflightError('PREFLIGHT_INVALID_REQUEST', 'mystiqueUrl must be a valid URL', 400);
      }
      const parsedOverride = new URL(data.mystiqueUrl);
      if (parsedOverride.protocol !== 'https:') {
        return preflightError('PREFLIGHT_INVALID_REQUEST', 'mystiqueUrl must use https://', 400);
      }
      if (!/\.adobe\.io$/.test(parsedOverride.hostname)) {
        return preflightError('PREFLIGHT_INVALID_REQUEST', 'mystiqueUrl must point at an *.adobe.io host', 400);
      }
      log.info(`Using caller-supplied mystiqueUrl override: ${data.mystiqueUrl}`);
    }

    const mysticatBaseUrl = useMystiqueUrlOverride
      ? data.mystiqueUrl
      : env.MYSTIQUE_API_BASE_URL;

    if (!hasText(mysticatBaseUrl)) {
      return preflightError('PREFLIGHT_INTERNAL_ERROR', 'Analyze service not configured', 500);
    }

    const { url } = data;
    const { protocol, hostname } = new URL(url);
    const previewBaseURL = `${protocol}//${hostname}`;

    let site;
    try {
      site = await dataAccess.Site.findById(siteId);
    } catch (e) {
      log.error(`Failed to find site ${siteId}: ${e.message}`);
      return preflightError('PREFLIGHT_INTERNAL_ERROR', 'Internal error', 500);
    }

    if (!site) {
      return preflightError('PREFLIGHT_SITE_NOT_FOUND', 'Site not found', 404);
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return preflightError('PREFLIGHT_ACCESS_DENIED', 'Access denied', 403);
    }

    // Validate the URL belongs to this site
    let siteByUrl;
    try {
      siteByUrl = await dataAccess.Site.findByPreviewURL(previewBaseURL);
    } catch (e) {
      log.error(`findByPreviewURL failed for ${previewBaseURL}: ${e.message}`);
      return preflightError('PREFLIGHT_INTERNAL_ERROR', 'Internal error', 500);
    }
    if (!siteByUrl || siteByUrl.getId() !== siteId) {
      return preflightError('PREFLIGHT_INVALID_REQUEST', 'URL does not belong to this site', 400);
    }

    // Eligibility is Mysticat's decision — see SITES-46202 + ADR-002.

    // Resolve page authentication if required.
    // checkEnableAuthentication does a bare HEAD fetch against the customer
    // URL; DNS failure / connection refused / TLS error throws. Treat any
    // throw as "auth not required" (false) so an unreachable customer URL
    // returns a structured 502 from the downstream Mysticat call rather
    // than an unstructured 500 here that would break the errorCode contract.
    let enableAuthentication;
    try {
      enableAuthentication = await checkEnableAuthentication(previewBaseURL);
    } catch (e) {
      log.warn(`checkEnableAuthentication failed for ${previewBaseURL}: ${e.message}`);
      enableAuthentication = false;
    }
    let authorizationHeader;
    if (enableAuthentication) {
      let promiseTokenObj;
      try {
        promiseTokenObj = await resolvePromiseToken(site, context);
      } catch (e) {
        log.error(`Failed to get promise token: ${e.message}`);
        if (e instanceof ErrorWithStatusCode) {
          return preflightError('PREFLIGHT_INVALID_REQUEST', e.message, 400);
        }
        return preflightError('PREFLIGHT_INTERNAL_ERROR', 'Error getting promise token', 500);
      }
      try {
        const authOptions = promiseTokenObj ? { promiseToken: promiseTokenObj } : {};
        const accessToken = await retrievePageAuthentication(site, context, authOptions);
        const isBearer = site.getDeliveryType() === DELIVERY_TYPES.AEM_CS && !!promiseTokenObj;
        authorizationHeader = `${isBearer ? 'Bearer' : 'token'} ${accessToken}`;
      } catch (e) {
        log.error(`Failed to retrieve page authentication: ${e.message}`);
        return preflightError('PREFLIGHT_INTERNAL_ERROR', 'Error retrieving page authentication', 500);
      }
    }

    // Build createdBy from the authenticated IMS profile
    const profile = context.attributes?.authInfo?.getProfile?.();
    const displayName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ')
      || profile?.name
      || profile?.email
      || 'unknown';
    const createdBy = { email: profile?.email || 'unknown', displayName };

    // Create AsyncJob first (execution primitive), then the Preflight domain record
    let asyncJob;
    try {
      asyncJob = await dataAccess.AsyncJob.create({
        status: AsyncJob.Status.IN_PROGRESS,
        metadata: {
          payload: { siteId, url },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });
    } catch (e) {
      log.error(`Failed to create AsyncJob: ${e.message}`);
      return preflightError('PREFLIGHT_INTERNAL_ERROR', 'Failed to create async job', 500);
    }

    let preflight;
    try {
      preflight = await dataAccess.Preflight.create({
        siteId,
        asyncJobId: asyncJob.getId(),
        url,
        status: AsyncJob.Status.IN_PROGRESS,
        createdBy,
        startedAt: new Date().toISOString(),
      });
    } catch (e) {
      log.error(`Failed to create Preflight: ${e.message}`);
      await asyncJob.remove().catch((re) => log.warn(`Failed to roll back AsyncJob ${asyncJob.getId()}: ${re.message}`));
      return preflightError('PREFLIGHT_INTERNAL_ERROR', 'Failed to create preflight record', 500);
    }

    try {
      await callMysticatAnalyze(
        mysticatBaseUrl,
        asyncJob.getId(),
        siteId,
        url,
        authorizationHeader,
      );
    } catch (mysticatError) {
      log.error(`Mysticat analyze failed for preflight ${preflight.getId()}: ${mysticatError.message}`);
      preflight.setStatus(AsyncJob.Status.FAILED);
      // Stored error message mirrors the external 502 response — the raw
      // upstream body could carry internal hostnames / stack traces and is
      // exposed via GET /sites/:siteId/preflights/:preflightId. Full detail
      // is in the log.error above for ops visibility.
      preflight.setError({ code: 'MYSTICAT_ERROR', message: 'Upstream analyze service failed' });
      preflight.setEndedAt(new Date().toISOString());
      await preflight.save().catch((e) => log.warn(`Failed to persist FAILED state on preflight ${preflight.getId()}: ${e.message}`));
      asyncJob.setStatus(AsyncJob.Status.FAILED);
      await asyncJob.save().catch((e) => log.warn(`Failed to persist FAILED state on AsyncJob ${asyncJob.getId()}: ${e.message}`));
      return preflightError('PREFLIGHT_UPSTREAM_ERROR', 'Upstream analyze service failed', 502);
    }

    const isDev = env.AWS_ENV === 'dev';
    const locationUrl = `https://spacecat.experiencecloud.live/api/${isDev ? 'ci' : 'v1'}`
      + `/sites/${siteId}/preflights/${preflight.getId()}`;

    return createResponse(PreflightDto.toJSON(preflight), 202, { Location: locationUrl });
  };

  /**
   * Returns all preflights for a site, optionally filtered by URL.
   * @param {Object} context - The request context
   * @returns {Promise<Object>} 200 OK with array of preflights
   */
  const getAllPreflights = async (context) => {
    const siteId = context.params?.siteId;
    const rawQueryString = context.invocation?.event?.rawQueryString;
    const urlFilter = new URLSearchParams(rawQueryString ?? '').get('url') ?? undefined;

    let site;
    try {
      site = await dataAccess.Site.findById(siteId);
    } catch (e) {
      log.error(`Failed to find site ${siteId}: ${e.message}`);
      return preflightError('PREFLIGHT_INTERNAL_ERROR', 'Internal error', 500);
    }

    if (!site) {
      return preflightError('PREFLIGHT_SITE_NOT_FOUND', 'Site not found', 404);
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return preflightError('PREFLIGHT_ACCESS_DENIED', 'Access denied', 403);
    }

    try {
      const preflights = await dataAccess.Preflight.allBySiteIdAndUrl(siteId, urlFilter);
      return ok(preflights.map(PreflightDto.toJSON));
    } catch (e) {
      log.error(`Failed to fetch preflights for site ${siteId}: ${e.message}`);
      return preflightError('PREFLIGHT_INTERNAL_ERROR', 'Failed to fetch preflights', 500);
    }
  };

  /**
   * Returns a single preflight by ID, verifying it belongs to the path's siteId.
   * @param {Object} context - The request context
   * @returns {Promise<Object>} 200 OK with full preflight detail
   */
  const getPreflightById = async (context) => {
    const siteId = context.params?.siteId;
    const preflightId = context.params?.preflightId;

    let site;
    try {
      site = await dataAccess.Site.findById(siteId);
    } catch (e) {
      log.error(`Failed to find site ${siteId}: ${e.message}`);
      return preflightError('PREFLIGHT_INTERNAL_ERROR', 'Internal error', 500);
    }

    if (!site) {
      return preflightError('PREFLIGHT_SITE_NOT_FOUND', 'Site not found', 404);
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return preflightError('PREFLIGHT_ACCESS_DENIED', 'Access denied', 403);
    }

    try {
      const preflight = await dataAccess.Preflight.findById(preflightId);

      // Treat a siteId mismatch identically to not found — no cross-site probing
      if (!preflight || preflight.getSiteId() !== siteId) {
        return preflightError('PREFLIGHT_NOT_FOUND', `Preflight with ID ${preflightId} not found`, 404);
      }

      return ok(PreflightDto.toDetailJSON(preflight));
    } catch (e) {
      log.error(`Failed to fetch preflight ${preflightId}: ${e.message}`);
      return preflightError('PREFLIGHT_INTERNAL_ERROR', 'Failed to fetch preflight', 500);
    }
  };

  return {
    createPreflightJob,
    getPreflightJobStatusAndResult,
    createPreflight,
    getAllPreflights,
    getPreflightById,
  };
}

export default PreflightController;
