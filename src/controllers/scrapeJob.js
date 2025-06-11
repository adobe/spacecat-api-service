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

import {
  createResponse,
  noContent,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  isIsoDate, isObject, isValidUrl,
} from '@adobe/spacecat-shared-utils';
import psl from 'psl';
import { ScrapeJob as ScrapeJobModel } from '@adobe/spacecat-shared-data-access';
import { ErrorWithStatusCode } from '../support/utils.js';
import ScrapeJobSupervisor from '../support/scrape-job-supervisor.js';
import { ScrapeJobDto } from '../dto/scrape-job.js';
import { STATUS_NOT_FOUND } from '../utils/constants.js';

/**
 * Scrape controller. Provides methods to create, read, and fetch the result of scrape jobs.
 * @param {UniversalContext} context - The context of the universal serverless function.
 * @param {DataAccess} context.dataAccess - Data access.
 * @param {object} context.sqs - AWS Simple Queue Service client.
 * @param {object} context.s3 - AWS S3 client and related helpers.
 * @param {object} context.env - Environment details.
 * @param {string} context.env.SCRAPE_JOB_CONFIGURATION - Scrape configuration, as a JSON string.
 * @param {object} context.log - Logger.
 * @returns {object} Scrape controller.
 * @constructor
 */
function ScrapeJobController(context) {
  /**
   * The scrape controller has a number of scopes that are required to access different parts of the
   * scrape functionality. These scopes are used to validate the authenticated user has the required
   * level of access.
   * @type {{READ: 'scrapes.read', ALL_DOMAINS: 'scrapes.all_domains',
   * READ_ALL: 'scrapes.read_all', WRITE: 'scrapes.write'}}
   */
  const SCOPE = {
    READ: 'scrapes.read', // allows users to read the scrape jobs created with their API key
    WRITE: 'scrapes.write', // allows users to create new scrape jobs
    READ_ALL: 'scrapes.read_all', // allows users to view all scrape jobs
    ALL_DOMAINS: 'scrapes.all_domains', // allows users to scrape across any domain
    DELETE: 'scrapes.delete', // access to delete scrape jobs
  };

  const {
    dataAccess, sqs, s3, log, env, auth, attributes,
  } = context;
  const services = {
    dataAccess,
    sqs,
    s3,
    log,
    env,
  };

  let scrapeConfiguration = {};
  try {
    scrapeConfiguration = JSON.parse(env.SCRAPE_JOB_CONFIGURATION);
  } catch (error) {
    log.error(`Failed to parse scrape job configuration: ${error.message}`);
  }

  const scrapeSupervisor = new ScrapeJobSupervisor(services, scrapeConfiguration);
  const { maxUrlsPerJob = 1 } = scrapeConfiguration;

  const HEADER_ERROR = 'x-error';
  const STATUS_BAD_REQUEST = 400;
  const STATUS_ACCEPTED = 202;
  const STATUS_UNAUTHORIZED = 401;

  function validateRequestData(data) {
    if (!isObject(data)) {
      throw new ErrorWithStatusCode('Invalid request: missing multipart/form-data request data', STATUS_BAD_REQUEST);
    }

    if (!Array.isArray(data.urls) || !data.urls.length > 0) {
      throw new ErrorWithStatusCode('Invalid request: urls must be provided as a non-empty array', STATUS_BAD_REQUEST);
    }

    if (data.urls.length > maxUrlsPerJob) {
      throw new ErrorWithStatusCode(`Invalid request: number of URLs provided (${data.urls.length}) exceeds the maximum allowed (${maxUrlsPerJob})`, STATUS_BAD_REQUEST);
    }

    data.urls.forEach((url) => {
      if (!isValidUrl(url)) {
        throw new ErrorWithStatusCode(`Invalid request: ${url} is not a valid URL`, STATUS_BAD_REQUEST);
      }
    });

    if (data.options && !isObject(data.options)) {
      throw new ErrorWithStatusCode('Invalid request: options must be an object', STATUS_BAD_REQUEST);
    }

    const processingTypes = Object.values(ScrapeJobModel.ScrapeProcessingType);
    // the type property is optional for backwards compatibility, if it is provided it must be valid
    if (data.processingType && !processingTypes.includes(data.processingType)) {
      throw new ErrorWithStatusCode(`Invalid request: processingType must be either ${processingTypes.join(' or ')}`, STATUS_BAD_REQUEST);
    }

    if (data.customHeaders && !isObject(data.customHeaders)) {
      throw new ErrorWithStatusCode('Invalid request: customHeaders must be an object', STATUS_BAD_REQUEST);
    }
  }

  /**
   * Verify that the authenticated user has the required level of access scope.
   * @param scopes a list of scopes to validate the user has access to.
   * @return {object} the user profile.
   */
  function validateAccessScopes(scopes) {
    log.debug(`validating scopes: ${scopes}`);

    try {
      auth.checkScopes(scopes);
    } catch (error) {
      throw new ErrorWithStatusCode('Missing required scopes', STATUS_UNAUTHORIZED);
    }
  }

  function createErrorResponse(error) {
    return createResponse({}, error.status || 500, {
      [HEADER_ERROR]: error.message,
    });
  }

  function validateIsoDates(startDate, endDate) {
    if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
      throw new ErrorWithStatusCode('Invalid request: startDate and endDate must be in ISO 8601 format', STATUS_BAD_REQUEST);
    }
  }

  /**
   * Extract the domain from a URL.
   * @param {string} inputUrl the URL to extract the domain from.
   * @return {string} the domain extracted from the URL.
   */
  function getDomain(inputUrl) {
    const parsedUrl = new URL(inputUrl);
    const parsedDomain = psl.parse(parsedUrl.hostname);
    return parsedDomain.domain; // Extracts the full domain (e.g., example.co.uk)
  }

  /**
   * Check if the URLs in urlList belong to any of the base domains.
   * @param {string[]} urlList the list of URLs to check.
   * @param {string[]} baseDomainList the list of base domains to check against.
   * @return {true} if all URLs belong to an allowed base domain
   * @throws {ErrorWithStatusCode} if any URL does not belong to an allowed base domain
   */
  function isUrlInBaseDomains(urlList, baseDomainList) {
    const invalidUrls = urlList.filter((inputUrl) => {
      const urlDomain = getDomain(inputUrl);
      return !baseDomainList.some((baseDomain) => urlDomain === baseDomain);
    });

    if (invalidUrls.length > 0) {
      throw new ErrorWithStatusCode(`Invalid request: URLs not allowed: ${invalidUrls.join(', ')}`, STATUS_BAD_REQUEST);
    }

    return true;
  }

  /**
   * Create and start a new scrape job.
   * @param {UniversalContext} requestContext - The context of the universal serverless function.
   * @param {object} requestContext.multipartFormData - Parsed multipart/form-data request data.
   * @param {object} requestContext.pathInfo.headers - HTTP request headers.
   * @returns {Promise<Response>} 202 Accepted if successful, 4xx or 5xx otherwise.
   */
  async function createScrapeJob(requestContext) {
    const { multipartFormData, pathInfo: { headers } } = requestContext;
    const { 'x-api-key': scrapeApiKey, 'user-agent': userAgent } = headers;

    try {
      // TODO: remove adminFlag once we have a proper auth flow
      let adminFlag = false;
      adminFlag = multipartFormData?.adminFlag;
      log.info(`scrape-job-adminFlag: ${adminFlag}`);

      // The API scope scrapes.write is required to create a new scrape job
      if (!adminFlag) {
        validateAccessScopes([SCOPE.WRITE]);
      }
      validateRequestData(multipartFormData);

      let profile;
      let initiatedBy = {};
      if (!adminFlag) {
        const { authInfo } = attributes;
        profile = authInfo.profile;

        if (profile) {
          initiatedBy = {
            apiKeyName: profile.getName(),
            imsOrgId: profile.getImsOrgId(),
            imsUserId: profile.getImsUserId(),
            userAgent,
          };
        }
      } else {
        profile = {
          name: 'Test User',
          imsOrgId: '1234567890',
          imsUserId: '1234567890',
          userAgent,
          getScopes: () => [
            {
              name: SCOPE.ALL_DOMAINS,
            },
          ],
        };
      }

      const {
        urls, options, customHeaders, processingType,
      } = multipartFormData;

      const scopes = profile.getScopes();

      // We only check if the URLs belong to the allowed domains if the user has the write scope
      // We do not need to check the domains for users with scope: all_domains
      if (!scopes.some((scope) => scope.name === SCOPE.ALL_DOMAINS)) {
        const allowedDomains = scopes
          .filter((scope) => scope.name === SCOPE.WRITE
            && scope.domains && scope.domains.length > 0)
          .flatMap((scope) => scope.domains.map(getDomain));

        if (allowedDomains.length === 0) {
          throw new ErrorWithStatusCode('Missing domain information', STATUS_UNAUTHORIZED);
        }

        isUrlInBaseDomains(urls, allowedDomains);
      }

      log.info(`Creating a new scrape job with ${urls.length} URLs.`);

      // Merge the scrape configuration options with the request options allowing the user options
      // to override the defaults
      const mergedOptions = {
        ...scrapeConfiguration.options,
        ...options,
      };

      const job = await scrapeSupervisor.startNewJob(
        urls,
        scrapeApiKey,
        processingType,
        mergedOptions,
        initiatedBy,
        customHeaders,
      );
      return createResponse(ScrapeJobDto.toJSON(job), STATUS_ACCEPTED);
    } catch (error) {
      log.error(`Failed to create a new scrape job: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  function parseRequestContext(requestContext) {
    return {
      // more params to add here?
      jobId: requestContext.params.jobId,
      startDate: requestContext.params.startDate,
      endDate: requestContext.params.endDate,
      scrapeApiKey: requestContext.pathInfo.headers['x-api-key'],
    };
  }

  /**
   * Get all scrape jobs between startDate and endDate
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.startDate - The start date of the range.
   * @param {string} requestContext.params.endDate - The end date of the range.
   * @param {string} requestContext.pathInfo.headers.x-api-key - API key to use for the job.
   * @returns {Promise<Response>} 200 OK with a JSON representation of the scrape jobs.
   */
  async function getScrapeJobsByDateRange(requestContext) {
    const { startDate, endDate } = parseRequestContext(requestContext);
    log.debug(`Fetching scrape jobs between startDate: ${startDate} and endDate: ${endDate}.`);

    try {
      validateAccessScopes([SCOPE.READ_ALL]);
      validateIsoDates(startDate, endDate);
      const jobs = await scrapeSupervisor.getScrapeJobsByDateRange(startDate, endDate);
      return ok(jobs.map((job) => ScrapeJobDto.toJSON(job)));
    } catch (error) {
      log.error(`Failed to fetch scrape jobs between startDate: ${startDate} and endDate: ${endDate}, ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Get the status of an scrape job.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to fetch.
   * @param {string} requestContext.pathInfo.headers.x-api-key - API key used for the job.
   * @returns {Promise<Response>} 200 OK with a JSON representation of the scrape job.
   */
  async function getScrapeJobStatus(requestContext) {
    const { jobId, scrapeApiKey } = parseRequestContext(requestContext);

    try {
      // The API scope scrapes.read is required to get the scrape job status
      validateAccessScopes([SCOPE.READ]);
      const job = await scrapeSupervisor.getScrapeJob(jobId, scrapeApiKey);
      return ok(ScrapeJobDto.toJSON(job));
    } catch (error) {
      log.error(`Failed to fetch scrape job status for jobId: ${jobId}, message: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Get the result of an scrape job, as a pre-signed download URL to S3.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to fetch.
   * @param {string} requestContext.pathInfo.headers.x-api-key - API key used for the job.
   * @returns {Promise<Response>} 200 OK with a pre-signed URL to download the job result.
   */
  async function getScrapeJobResult(requestContext) {
    const { jobId, scrapeApiKey } = parseRequestContext(requestContext);

    try {
      // The API scope scrapes.read is required to get the scrape job status
      validateAccessScopes([SCOPE.READ]);
      const job = await scrapeSupervisor.getScrapeJob(jobId, scrapeApiKey);
      if (job.getStatus() === ScrapeJobModel.ScrapeJobStatus.RUNNING) {
        throw new ErrorWithStatusCode('Job results not available yet, job status is: RUNNING', STATUS_NOT_FOUND);
      }
      return ok({
        id: job.getId(),
        results: job.getResults(),
      });
    } catch (error) {
      log.error(`Failed to fetch the scrape job result: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Get the progress of an scrape job. Results are broken down into the following:
   * - complete: URLs that have been successfully scrapeed.
   * - failed: URLs that have failed to scrape.
   * - pending: URLs that are still being processed.
   * - redirected: URLs that have been redirected.
   * @param requestContext - Context of the request.
   * @return {Promise<Response>} 200 OK with a JSON representation of the scrape job progress.
   */
  async function getScrapeJobProgress(requestContext) {
    const { jobId, scrapeApiKey } = parseRequestContext(requestContext);

    try {
      validateAccessScopes([SCOPE.READ]);
      const progress = await scrapeSupervisor.getScrapeJobProgress(jobId, scrapeApiKey);
      return ok(progress);
    } catch (error) {
      log.error(`Failed to fetch the scrape job progress: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Delete an scrape job.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to delete.
   * @return {Promise<Response>} 204 No Content if successful, 4xx or 5xx otherwise.
   */
  async function deleteScrapeJob(requestContext) {
    const { jobId, scrapeApiKey } = parseRequestContext(requestContext);

    try {
      validateAccessScopes([SCOPE.DELETE]);
      await scrapeSupervisor.deleteScrapeJob(jobId, scrapeApiKey);

      return noContent();
    } catch (error) {
      log.error(`Failed to delete scrape jobId: ${jobId} : ${error.message}`);
      return createErrorResponse(error);
    }
  }

  return {
    createScrapeJob,
    getScrapeJobStatus,
    getScrapeJobResult,
    getScrapeJobProgress,
    getScrapeJobsByDateRange,
    deleteScrapeJob,
  };
}

export default ScrapeJobController;
