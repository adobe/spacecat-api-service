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

  // Duplicated from preflight controller. Extraction tracked in SITES-45204
  // (move checkEnableAuthentication / resolvePromiseToken / PROMISE_BASED_TYPES
  // to src/support/auth.js, alongside getIMSPromiseToken).
  //
  // Hardened HEAD probe — 3 s timeout (under API Gateway's 29 s budget for an
  // outbound to arbitrary customer infrastructure) and redirect: 'manual' so
  // a customer baseURL cannot 30x-launder the probe toward an internal host.
  // Returns one of:
  //   'auth-required'  — 401 / 403, mint and inject the Authorization header
  //   'no-auth'        — 2xx,        delegate without injecting a header
  //   'ambiguous'      — 3xx / 5xx / network / timeout, caller asked for auth
  //                     but we cannot prove the page wants it; fail closed at
  //                     the caller instead of silently scraping a login page.
  const HEAD_PROBE_TIMEOUT_MS = 3000;
  async function checkEnableAuthentication(previewBaseURL) {
    let headResponse;
    try {
      headResponse = await fetch(previewBaseURL, {
        method: 'HEAD',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(HEAD_PROBE_TIMEOUT_MS),
      });
    } catch (e) {
      log.warn(`HEAD probe failed for ${previewBaseURL}: ${e.name}: ${e.message}`);
      return 'ambiguous';
    }
    const { status } = headResponse;
    if (status === 401 || status === 403) {
      return 'auth-required';
    }
    if (status >= 200 && status < 300) {
      return 'no-auth';
    }
    log.warn(`HEAD probe for ${previewBaseURL} returned ambiguous status ${status}`);
    return 'ambiguous';
  }

  // Mirrors `@adobe/spacecat-shared-ims-client/src/auth.js` (the promise-
  // exchange gate inside `retrievePageAuthentication`): the ims-client gates
  // promise-token exchange on `(promiseTypes.includes(authoringType) ||
  // deliveryType === AEM_CS) && authOptions.promiseToken`. Keeping this
  // predicate identical avoids the controller and the ims-client drifting on
  // "is this a promise-path site?" — that asymmetry is silent today (the
  // ims-client falls through to the Secrets Manager PAT branch when no
  // promise token is provided) but would surface for a customer who adds
  // AEM_CS delivery on a non-promise authoring type, or vice versa.
  // Extraction to a shared util is tracked in SITES-45204.
  function isPromisePathSite(site) {
    return PROMISE_BASED_TYPES.includes(site.getAuthoringType())
      || site.getDeliveryType() === DELIVERY_TYPES.AEM_CS;
  }

  async function resolvePromiseToken(site, requestContext) {
    if (!isPromisePathSite(site)) {
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

  // Strip the server-minted Authorization header from the response — content-
  // scraper still receives it via the SQS message body, but the credential
  // must not be echoed back in the 202 body. At-rest exposure in DynamoDB /
  // LIST endpoints is tracked in SITES-45205 (spacecat-shared ScrapeJobDto
  // redaction).
  function sanitizeJobResponse(job) {
    if (!isNonEmptyObject(job) || !isNonEmptyObject(job.customHeaders)) {
      return job;
    }
    const { Authorization: _, ...safeHeaders } = job.customHeaders;
    return { ...job, customHeaders: safeHeaders };
  }

  /**
   * Create and start a new scrape job.
   *
   * When `options.enableAuthentication === true`, the per-site `Authorization`
   * header is resolved server-side in this Lambda (HEAD probe + optional IMS
   * promise-token exchange + `retrievePageAuthentication`), merged into
   * `customHeaders`, and `options.enableAuthentication` is stripped before
   * delegation. This mirrors the `createBetaPreflightJob` pattern.
   *
   * Why bake the header here instead of letting content-scraper resolve it:
   * content-scraper's SQS Event Source Mappings target the unqualified Lambda
   * ARN, so helix-universal reports `ctx.func.version === '$LATEST'`, which
   * AWS Secrets Manager rejects as an invalid name (`ValidationException`).
   * The spacecat-api Lambda is API-Gateway-invoked (alias-qualified `:latest`),
   * so `retrievePageAuthentication` works correctly here.
   *
   * Callers that do not set `enableAuthentication` get byte-identical legacy
   * behavior — no Site lookup, no HEAD probe, no Secrets Manager call.
   *
   * @param {UniversalContext} requestContext - The context of the universal serverless function.
   * @param {object} requestContext.data - Parsed json request data.
   * @returns {Promise<Response>} 202 Accepted if successful, 4xx or 5xx otherwise.
   */
  async function createScrapeJob(requestContext) {
    const { data, dataAccess } = requestContext;

    // Legacy fast-path: no auth resolution requested, behave exactly as before.
    if (!isNonEmptyObject(data) || data.options?.enableAuthentication !== true) {
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

    // Auth-resolution path. metaData.siteId required — fail loud at the API edge
    // rather than silently demote to an anonymous scrape that returns a login page.
    const siteId = data?.metaData?.siteId;
    if (!isValidUUID(siteId)) {
      return badRequest(
        'Invalid request: metaData.siteId is required when options.enableAuthentication is true',
      );
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
    let siteOrigin;
    let previewBaseURL;
    try {
      const parsed = new URL(baseURL);
      siteOrigin = parsed.origin;
      previewBaseURL = `${parsed.protocol}//${parsed.hostname}`;
    } catch {
      log.error(`Site ${siteId} has invalid baseURL: ${baseURL}`);
      return internalServerError('Site has invalid baseURL');
    }

    // Bind every caller URL to the site's *origin* before we mint a credential
    // — otherwise a caller can submit a valid siteId with URLs pointing at an
    // attacker host (or an adjacent service on a different port, or the HTTP
    // counterpart of an HTTPS site) and harvest the resolved Authorization.
    // Comparing `URL.origin` (scheme + host + port) closes all three vectors;
    // `.hostname` alone misses cross-port and the http/https downgrade. Other
    // subdomains are rejected — promote them to their own site if needed.
    if (!Array.isArray(data.urls) || data.urls.length === 0) {
      return badRequest('Invalid request: urls must be a non-empty array');
    }
    for (const u of data.urls) {
      let urlOrigin;
      try {
        urlOrigin = new URL(u).origin;
      } catch {
        return badRequest(`Invalid request: malformed URL: ${u}`);
      }
      if (urlOrigin !== siteOrigin) {
        log.warn(`Cross-origin URL rejected for site ${siteId}: ${u} (site origin: ${siteOrigin})`);
        return badRequest(
          `Invalid request: every URL must belong to the site origin (${siteOrigin})`,
        );
      }
    }

    // checkEnableAuthentication never throws — it returns 'auth-required',
    // 'no-auth', or 'ambiguous'. We fail closed on 'ambiguous' because the
    // caller explicitly asked for authenticated scraping; silently demoting
    // would store a login page as "real content" — the exact SITES-40597
    // failure class.
    const probeResult = await checkEnableAuthentication(previewBaseURL);
    if (probeResult === 'ambiguous') {
      return createResponse({}, 502, {
        [HEADER_ERROR]: cleanupHeaderValue(
          `Could not verify authentication requirement for ${previewBaseURL}`,
        ).slice(0, 500),
      });
    }

    let authorizationHeader;
    if (probeResult === 'auth-required') {
      // Guard `(promise-authoring) × (non-AEM_CS delivery)`: IMS access tokens
      // belong under `Bearer` (RFC 6750), AEM EDS endpoints expect `token <PAT>`
      // for static-PAT auth. Minting `token <IMS-JWT>` is unverified and the
      // E2E in PR #2455 didn't exercise it (HEAD 200/301 sites). Reject with
      // 502 until a per-site auth-policy attribute drives scheme selection,
      // rather than guess. Promise-authoring sites whose delivery is AEM_CS
      // get `Bearer <IMS-token>` correctly below.
      if (PROMISE_BASED_TYPES.includes(site.getAuthoringType())
          && site.getDeliveryType() !== DELIVERY_TYPES.AEM_CS) {
        log.warn(
          `Refusing to mint Authorization for site ${siteId}: `
          + `authoringType=${site.getAuthoringType()} × deliveryType=${site.getDeliveryType()} `
          + 'is not a verified scheme combination',
        );
        return createResponse({}, 502, {
          [HEADER_ERROR]: cleanupHeaderValue(
            `Authentication scheme for site ${siteId} is not yet supported (`
            + `${site.getAuthoringType()} × ${site.getDeliveryType()})`,
          ).slice(0, 500),
        });
      }

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

    // Always strip enableAuthentication before delegation — prevents content-scraper
    // from re-resolving the token under its unqualified SQS ESM ARN (`$LATEST` bug).
    // `data.options` is guaranteed non-null: we only reach this point when
    // `data.options.enableAuthentication === true` was true above.
    const { enableAuthentication: _, ...remainingOptions } = data.options;

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
      return accepted(sanitizeJobResponse(job));
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
    getScrapeJobStatus,
    getScrapeJobUrlResults,
    getScrapeJobsByBaseURL,
    getScrapeJobsByDateRange,
    getScrapeUrlByProcessingType,
  };
}

export default ScrapeJobController;
