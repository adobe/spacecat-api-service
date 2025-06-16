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
  const {
    dataAccess, sqs, s3, log, env,
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
  // const STATUS_UNAUTHORIZED = 401;

  function validateRequestData(data) {
    if (!isObject(data)) {
      throw new ErrorWithStatusCode('Invalid request: missing application/json request data', STATUS_BAD_REQUEST);
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
   * Create and start a new scrape job.
   * @param {UniversalContext} requestContext - The context of the universal serverless function.
   * @param {object} requestContext.data - Parsed json request data.
   * @param {object} requestContext.pathInfo.headers - HTTP request headers.
   * @returns {Promise<Response>} 202 Accepted if successful, 4xx or 5xx otherwise.
   */
  async function createScrapeJob(requestContext) {
    const { data } = requestContext;

    try {
      validateRequestData(data);

      // add default processing type if not provided
      if (!data.processingType) {
        data.processingType = ScrapeJobModel.ScrapeProcessingType.DEFAULT;
      }

      const {
        urls, options, customHeaders, processingType,
      } = data;

      log.info(`Creating a new scrape job with ${urls.length} URLs.`);

      // Merge the scrape configuration options with the request options allowing the user options
      // to override the defaults
      const mergedOptions = {
        ...scrapeConfiguration.options,
        ...options,
      };

      const job = await scrapeSupervisor.startNewJob(
        urls,
        processingType,
        mergedOptions,
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
   * @returns {Promise<Response>} 200 OK with a JSON representation of the scrape job.
   */
  async function getScrapeJobStatus(requestContext) {
    const { jobId } = parseRequestContext(requestContext);

    try {
      const job = await scrapeSupervisor.getScrapeJob(jobId);
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
   * @returns {Promise<Response>} 200 OK with a pre-signed URL to download the job result.
   */
  async function getScrapeJobResult(requestContext) {
    const { jobId } = parseRequestContext(requestContext);

    try {
      const job = await scrapeSupervisor.getScrapeJob(jobId);
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
    const { jobId } = parseRequestContext(requestContext);

    try {
      const progress = await scrapeSupervisor.getScrapeJobProgress(jobId);
      return ok(progress);
    } catch (error) {
      log.error(`Failed to fetch the scrape job progress: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Delete a scrape job.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to delete.
   * @return {Promise<Response>} 204 No Content if successful, 4xx or 5xx otherwise.
   */
  async function deleteScrapeJob(requestContext) {
    const { jobId } = parseRequestContext(requestContext);

    try {
      await scrapeSupervisor.deleteScrapeJob(jobId);

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
