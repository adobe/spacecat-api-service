/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { ScrapeClient } from '@adobe/spacecat-shared-scrape-client';
import {
  createResponse,
  ok,
  accepted,
  notFound,
  badRequest,
  forbidden,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  isValidUrl,
  isValidUUID,
  isNonEmptyObject,
  hasText,
  DELIVERY_TYPES,
} from '@adobe/spacecat-shared-utils';
import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import { retrievePageAuthentication } from '@adobe/spacecat-shared-ims-client';
import { cleanupHeaderValue } from '@adobe/helix-shared-utils';
import AccessControlUtil from '../support/access-control-util.js';
import { getCookieValue, getIMSPromiseToken, ErrorWithStatusCode } from '../support/utils.js';

const PROMISE_BASED_TYPES = [
  SiteModel.AUTHORING_TYPES.CS,
  SiteModel.AUTHORING_TYPES.CS_CW,
  SiteModel.AUTHORING_TYPES.AMS,
];

/**
 * Scrape controller. Provides methods to create, read, and fetch the result of scrape jobs.
 * @param {UniversalContext} context - The context of the universal serverless function.
 * @param {DataAccess} context.dataAccess - Data access.
 * @param {object} context.sqs - AWS Simple Queue Service client.
 * @param {object} context.env - Environment details.
 * @param {string} context.env.SCRAPE_JOB_CONFIGURATION - Scrape configuration, as a JSON string.
 * @param {object} context.log - Logger.
 * @returns {object} Scrape controller.
 * @constructor
 */
function ScrapeJobController(context) {
  const {
    log,
  } = context;

  const scrapeClient = ScrapeClient.createFrom(context);

  const HEADER_ERROR = 'x-error';

  const MAX_JOBS_BY_BASEURL = 100;

  // Duplicated from preflight controller (decision: refactor to support/scrape-auth.js
  // as follow-up once the second consumer ships and the abstraction is justified).
  async function checkEnableAuthentication(previewBaseURL) {
    const headResponse = await fetch(previewBaseURL, {
      method: 'HEAD',
      headers: { 'Content-Type': 'application/json' },
    });
    return headResponse.status === 401 || headResponse.status === 403;
  }

  async function resolvePromiseToken(site, requestContext) {
    if (!PROMISE_BASED_TYPES.includes(site.getAuthoringType())) {
      return null;
    }
    const cookieToken = getCookieValue(requestContext, 'promiseToken');
    if (hasText(cookieToken)) {
      return { promise_token: cookieToken };
    }
    return getIMSPromiseToken(requestContext);
  }

  function createErrorResponse(error) {
    // cleanupHeaderValue strips chars HTTP headers can't carry (CR/LF and non-ASCII
    // that would otherwise throw ERR_INVALID_CHAR). The `|| 'Internal server error'`
    // fallback guards against empty messages, and the .slice caps the header size.
    const safeMessage = cleanupHeaderValue(error.message || 'Internal server error').slice(0, 500);
    return createResponse({}, error.status || 500, {
      [HEADER_ERROR]: safeMessage,
    });
  }

  /**
   * Create and start a new scrape job.
   * @param {UniversalContext} requestContext - The context of the universal serverless function.
   * @param {object} requestContext.data - Parsed json request data.
   * @returns {Promise<Response>} 202 Accepted if successful, 4xx or 5xx otherwise.
   */
  async function createScrapeJob(requestContext) {
    const { data } = requestContext;

    try {
      const job = await scrapeClient.createScrapeJob(data);

      return accepted(job);
    } catch (error) {
      log.error(error.message);
      if (error?.message?.includes('Invalid request')) {
        return badRequest(error);
      }
      return createErrorResponse(error);
    }
  }

  /**
   * Create a scrape job with the per-site Authorization header resolved server-side.
   *
   * Mirrors the auth-resolution path used by `createBetaPreflightJob` in preflight.js
   * (HEAD probe + optional IMS promise-token exchange + `retrievePageAuthentication`),
   * then delegates the resulting payload to the existing `scrapeClient.createScrapeJob`.
   *
   * Defensive guarantees:
   *  - `metaData.siteId` is required; returns 400 otherwise.
   *  - `options.enableAuthentication` is stripped from the delegated payload so the
   *    downstream content-scraper does not attempt to re-resolve the token under an
   *    unqualified Lambda ARN (which surfaces AWS Secrets Manager `ValidationException`
   *    because helix-universal reports `ctx.func.version === '$LATEST'`).
   *  - When the HEAD probe returns 2xx the endpoint delegates transparently with no
   *    header injection — callers can safely use this endpoint for sites that may or
   *    may not require authentication.
   *
   * Bakes the Authorization header in the spacecat-api Lambda (alias-qualified ARN
   * via API Gateway, so `ctx.func.version === 'latest'`), avoiding the `$LATEST`
   * bug entirely. Legacy `POST /tools/scrape/jobs` is unaffected.
   *
   * @param {UniversalContext} requestContext - The context of the universal serverless function.
   * @param {object} requestContext.data - Parsed json request data.
   * @param {object} requestContext.data.metaData - Required; must contain `siteId`.
   * @returns {Promise<Response>} 202 Accepted on success; 400/403/404/500 otherwise.
   */
  async function createScrapeAuthenticatedJob(requestContext) {
    const { data, dataAccess } = requestContext;

    if (!isNonEmptyObject(data)) {
      return badRequest('Invalid request: missing application/json data');
    }

    const siteId = data?.metaData?.siteId;
    if (!isValidUUID(siteId)) {
      return badRequest('Invalid request: metaData.siteId is required and must be a valid UUID');
    }

    let site;
    try {
      site = await dataAccess.Site.findById(siteId);
    } catch (error) {
      log.error(`Failed to load site ${siteId}: ${error.message}`);
      return internalServerError('Failed to load site');
    }
    if (!site) {
      return notFound(`Site not found: ${siteId}`);
    }

    const accessControlUtil = AccessControlUtil.fromContext(requestContext);
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('User does not have access to this site');
    }

    const baseURL = site.getBaseURL();
    let previewBaseURL;
    try {
      const parsed = new URL(baseURL);
      previewBaseURL = `${parsed.protocol}//${parsed.hostname}`;
    } catch {
      log.error(`Site ${siteId} has invalid baseURL: ${baseURL}`);
      return internalServerError('Site has invalid baseURL');
    }

    let enableAuthentication = false;
    try {
      enableAuthentication = await checkEnableAuthentication(previewBaseURL);
    } catch (e) {
      // HEAD probe is best-effort; on failure delegate without auth (legacy behavior).
      log.info(`HEAD probe failed for ${previewBaseURL}: ${e.message}`);
    }

    let authorizationHeader;
    if (enableAuthentication) {
      let promiseTokenObj;
      try {
        promiseTokenObj = await resolvePromiseToken(site, requestContext);
      } catch (e) {
        log.error(`Failed to resolve promise token for site ${siteId}: ${e.message}`);
        if (e instanceof ErrorWithStatusCode) {
          return badRequest(e.message);
        }
        return internalServerError('Error getting promise token');
      }
      try {
        const authOptions = promiseTokenObj ? { promiseToken: promiseTokenObj } : {};
        const accessToken = await retrievePageAuthentication(site, requestContext, authOptions);
        const isBearer = site.getDeliveryType() === DELIVERY_TYPES.AEM_CS && !!promiseTokenObj;
        authorizationHeader = `${isBearer ? 'Bearer' : 'token'} ${accessToken}`;
      } catch (e) {
        log.error(`Failed to retrieve page authentication for site ${siteId}: ${e.message}`);
        return internalServerError('Error retrieving page authentication');
      }
    }

    // Strip enableAuthentication from options so content-scraper never re-resolves.
    const { enableAuthentication: _, ...remainingOptions } = data.options || {};

    const delegatedData = {
      ...data,
      options: remainingOptions,
      ...(authorizationHeader && {
        customHeaders: {
          ...(data.customHeaders || {}),
          Authorization: authorizationHeader,
        },
      }),
    };

    try {
      const job = await scrapeClient.createScrapeJob(delegatedData);
      return accepted(job);
    } catch (error) {
      log.error(error.message);
      if (error?.message?.includes('Invalid request')) {
        return badRequest(error);
      }
      return createErrorResponse(error);
    }
  }

  function parseRequestContext(requestContext) {
    return {
      // more params to add here?
      jobId: requestContext.params.jobId,
      startDate: requestContext.params.startDate,
      endDate: requestContext.params.endDate,
      baseURL: requestContext.params.baseURL,
      processingType: requestContext.params.processingType,
      url: requestContext.params.url,
      maxAge: requestContext.params.maxAge,
    };
  }

  /**
   * Get all scrape jobs between startDate and endDate
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.startDate - The start date of the range.
   * @param {string} requestContext.params.endDate - The end date of the range.
   * @returns {Promise<Response>} 200 OK with a JSON representation of the scrape jobs.
   */
  async function getScrapeJobsByDateRange(requestContext) {
    const { startDate, endDate } = parseRequestContext(requestContext);
    log.debug(`Fetching scrape jobs between startDate: ${startDate} and endDate: ${endDate}.`);

    try {
      const jobs = await scrapeClient.getScrapeJobsByDateRange(startDate, endDate);
      return ok(jobs);
    } catch (error) {
      log.error(`Failed to fetch scrape jobs between startDate: ${startDate} and endDate: ${endDate}, ${error.message}`);
      if (error?.message?.includes('Invalid request')) {
        return badRequest(error);
      }
      return createErrorResponse(error);
    }
  }

  /**
   * Get the status of an scrape job.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to fetch.
   * @returns {Promise<Response>} 200 OK with a JSON representation of the scrape job.
   */
  async function getScrapeJobStatus(requestContext) {
    const { jobId } = parseRequestContext(requestContext);

    try {
      const job = await scrapeClient.getScrapeJobStatus(jobId);
      return ok(job);
    } catch (error) {
      log.error(`Failed to fetch scrape job status for jobId: ${jobId}, message: ${error.message}`);
      if (error?.message?.includes('Not found')) {
        return notFound(error);
      } else if (error?.message?.includes('Job ID is required')) {
        return badRequest(error);
      }
      return createErrorResponse(error);
    }
  }

  /**
   * Get the result of an scrape job, as a pre-signed download URL to S3.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to fetch.
   * @returns {Promise<Response>} 200 OK with all url results (status and path of scrape results)
   */
  async function getScrapeJobUrlResults(requestContext) {
    const { jobId } = parseRequestContext(requestContext);

    try {
      const results = await scrapeClient.getScrapeJobUrlResults(jobId);

      return ok({
        jobId,
        results,
      });
    } catch (error) {
      log.error(`Failed to fetch the scrape job result: ${error.message}`);
      if (error?.message?.includes('Not found')) {
        return notFound(error);
      }
      return createErrorResponse(error);
    }
  }

  /**
   * Get all scrape jobs by baseURL
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.baseURL - The baseURL encoded in base64
   * @returns {Promise<Response>} 200 OK with a JSON representation of the scrape jobs
   * or empty array if no jobs are found.
   */
  async function getScrapeJobsByBaseURL(requestContext) {
    const { baseURL: encodedBaseURL, processingType } = parseRequestContext(requestContext);

    if (!hasText(encodedBaseURL)) {
      return badRequest('Base URL required');
    }

    let decodedBaseURL = null;
    try {
      decodedBaseURL = Buffer.from(encodedBaseURL, 'base64').toString('utf-8').trim();

      if (!isValidUrl(decodedBaseURL)) {
        return badRequest('Invalid request: baseURL must be a valid URL');
      }

      const jobs = await scrapeClient.getScrapeJobsByBaseURL(decodedBaseURL, processingType);

      if (!jobs || jobs.length === 0) {
        return ok([]);
      }

      // return the latest max 100 jobs, sorted by startedAt (newest first)
      return ok(jobs.sort(
        (a, b) => new Date(b.startedAt) - new Date(a.startedAt),
      ).slice(0, MAX_JOBS_BY_BASEURL));
    } catch (error) {
      log.error(`Failed to fetch scrape jobs by baseURL: ${decodedBaseURL}, ${error.message}`);
      return createErrorResponse(error);
    }
  }

  async function getScrapeUrlByProcessingType(requestContext) {
    const { url: encodedUrl, processingType } = parseRequestContext(requestContext);
    let requestedProcessingType = processingType;

    if (!hasText(encodedUrl)) {
      return badRequest('A valid URL is required');
    } else if (!hasText(processingType)) {
      requestedProcessingType = 'default';
    }

    let decodedUrl = encodedUrl;
    try {
      decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8').trim();

      if (!isValidUrl(decodedUrl)) {
        return badRequest('Invalid request: url must be a valid URL');
      }

      const scrapeUrls = await scrapeClient.getScrapeUrlsByProcessingType(
        decodedUrl,
        requestedProcessingType,
      );

      if (!scrapeUrls || scrapeUrls.length === 0) {
        return ok([]);
      }

      return ok(scrapeUrls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    } catch (error) {
      log.error(`Failed to fetch scrape URLs for url: ${decodedUrl} and processingType: ${processingType}, ${error.message}`);
      return createErrorResponse(error);
    }
  }

  return {
    createScrapeJob,
    createScrapeAuthenticatedJob,
    getScrapeJobStatus,
    getScrapeJobUrlResults,
    getScrapeJobsByBaseURL,
    getScrapeJobsByDateRange,
    getScrapeUrlByProcessingType,
  };
}

export default ScrapeJobController;
