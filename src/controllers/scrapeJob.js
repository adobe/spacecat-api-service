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

import ScrapeClient from '@adobe/spacecat-shared-scrape-client';
import {
  createResponse,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  isValidUrl,
} from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from '../support/utils.js';

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
  const STATUS_BAD_REQUEST = 400;
  const STATUS_ACCEPTED = 202;

  function createErrorResponse(error) {
    return createResponse({}, error.status || 500, {
      [HEADER_ERROR]: error.message,
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

      return createResponse(job, STATUS_ACCEPTED);
    } catch (error) {
      log.error(error.message);
      if (error?.message?.includes('Invalid request')) {
        error.status = 400;
        return createErrorResponse(error);
      } else if (error?.message?.includes('Service Unavailable')) {
        error.status = 503;
        return createErrorResponse(error);
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
        error.status = 400;
        return createErrorResponse(error);
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
        error.status = 404;
        return createErrorResponse(error);
      } else if (error?.message?.includes('Job ID is required')) {
        error.status = 400;
        return createErrorResponse(error);
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

      return ok(results);
    } catch (error) {
      log.error(`Failed to fetch the scrape job result: ${error.message}`);
      if (error?.message?.includes('Not found')) {
        error.status = 404;
        return createErrorResponse(error);
      }
      return createErrorResponse(error);
    }
  }

  /**
   * Get all scrape jobs by baseURL
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.baseURL - The baseURL of the jobs to fetch.
   * @returns {Promise<Response>} 200 OK with a JSON representation of the scrape jobs
   * or empty array if no jobs are found.
   */
  async function getScrapeJobsByBaseURL(requestContext) {
    const { baseURL } = parseRequestContext(requestContext);
    log.debug(`Fetching scrape jobs by baseURL: ${baseURL}.`);

    let decodedBaseURL = baseURL;
    try {
      decodedBaseURL = decodeURIComponent(baseURL);

      if (!isValidUrl(decodedBaseURL)) {
        throw new ErrorWithStatusCode('Invalid request: baseURL must be a valid URL', STATUS_BAD_REQUEST);
      }

      const jobs = await scrapeClient.getScrapeJobsByBaseURL(decodedBaseURL);

      if (!jobs || jobs.length === 0) {
        return ok([]);
      }
      return ok(jobs);
    } catch (error) {
      log.error(`Failed to fetch scrape jobs by baseURL: ${decodedBaseURL}, ${error.message}`);
      return createErrorResponse(error);
    }
  }

  return {
    createScrapeJob,
    getScrapeJobStatus,
    getScrapeJobUrlResults,
    getScrapeJobsByBaseURL,
    getScrapeJobsByDateRange,
  };
}

export default ScrapeJobController;
