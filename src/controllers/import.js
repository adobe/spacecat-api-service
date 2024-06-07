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
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { isObject, isValidUrl } from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from '../support/utils.js';
import ImportSupervisor from '../support/import-supervisor.js';
import { ImportJobDto } from '../dto/import-job.js';

/**
 * Import controller. Provides methods to create, read, and fetch the result of import jobs.
 * @param {DataAccess} context.dataAccess - Data access.
 * @param {object} context.sqs - AWS Simple Queue Service client.
 * @param {object} context.s3 - AWS S3 client.
 * @param {object} context.env - Environment details.
 * @param {object} context.log - Logger.
 * @returns {object} Import controller.
 * @constructor
 */
function ImportController(context) {
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
  const importSupervisor = new ImportSupervisor(services);

  const HEADER_ERROR = 'x-error';
  const STATUS_BAD_REQUEST = 400;
  const STATUS_ACCEPTED = 202;

  function validateRequestData(data) {
    if (!isObject(data)) {
      throw new ErrorWithStatusCode('Invalid request: request body data is required', STATUS_BAD_REQUEST);
    }

    if (!Array.isArray(data.urls) || !data.urls.length > 0) {
      throw new ErrorWithStatusCode('Invalid request: urls must be provided as a non-empty array', STATUS_BAD_REQUEST);
    }

    data.urls.forEach((url) => {
      if (!isValidUrl(url)) {
        throw new ErrorWithStatusCode(`Invalid request: ${url} is not a valid URL`, STATUS_BAD_REQUEST);
      }
    });

    if (data.options && !isObject(data.options)) {
      throw new ErrorWithStatusCode('Invalid request: options must be an object', STATUS_BAD_REQUEST);
    }
  }

  function validateImportApiKey(importApiKey) {
    // Parse the allowed import keys from the environment
    const allowedImportApiKeys = env.IMPORT_ALLOWED_API_KEYS?.split(',') || [];
    if (!allowedImportApiKeys.includes(importApiKey)) {
      throw new ErrorWithStatusCode('Invalid import API key', 401);
    }
  }

  function createErrorResponse(error) {
    return createResponse({}, error.status || 500, {
      [HEADER_ERROR]: error.message,
    });
  }

  /**
   * Create and start a new import job.
   * @param {object} requestContext - Context of the request.
   * @param {Array<string>} requestContext.data.urls - Array of URLs to import.
   * @param {object} requestContext.data.options - Optional import configuration parameters.
   * @param {string} requestContext.pathInfo.headers.x-import-api-key - API key to use for the job.
   * @returns {Promise<Response>} 202 Accepted if successful, 4xx or 5xx otherwise.
   */
  async function createImportJob(requestContext) {
    const { data, pathInfo: { headers } } = requestContext;
    const { 'x-import-api-key': importApiKey } = headers;

    try {
      validateImportApiKey(importApiKey);
      validateRequestData(data);

      const { urls, options } = data;
      const job = await importSupervisor.startNewJob(urls, importApiKey, options);

      return createResponse(ImportJobDto.toJSON(job), STATUS_ACCEPTED);
    } catch (error) {
      log.error(`Failed to queue import job: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Get the status of an import job.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to fetch.
   * @param {string} requestContext.pathInfo.headers.x-import-api-key - API key used for the job.
   * @returns {Promise<Response>} Responds with a JSON representation of the import job.
   */
  async function getImportJobStatus(requestContext) {
    const {
      params: { jobID },
      pathInfo: { headers: { 'x-import-api-key': importApiKey } },
    } = requestContext;

    try {
      const job = await importSupervisor.getImportJob(jobID, importApiKey);
      return ok(ImportJobDto.toJSON(job));
    } catch (error) {
      log.error(`Failed to fetch import job status: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Get the result of an import job.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to fetch.
   * @param {string} requestContext.pathInfo.headers.x-import-api-key - API key used for the job.
   * @returns {Promise<Response>} Responds with a pre-signed URL to download the job result.
   */
  async function getImportJobResult(requestContext) {
    const {
      params: { jobID },
      pathInfo: { headers: { 'x-import-api-key': importApiKey } },
    } = requestContext;

    try {
      const job = await importSupervisor.getImportJobResult(jobID, importApiKey);
      const downloadUrl = await importSupervisor.getJobArchiveSignedUrl(job);
      return ok({
        id: job.getId(),
        downloadUrl,
      });
    } catch (error) {
      log.error(`Failed to fetch the import job result: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  return {
    createImportJob,
    getImportJobStatus,
    getImportJobResult,
  };
}

export default ImportController;
