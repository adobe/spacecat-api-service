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

import Busboy from 'busboy';
import {
  createResponse,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { isIsoDate, isObject, isValidUrl } from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from '../support/utils.js';
import ImportSupervisor from '../support/import-supervisor.js';
import { ImportJobDto } from '../dto/import-job.js';

/**
 * Import controller. Provides methods to create, read, and fetch the result of import jobs.
 * @param {Request} request - The HTTP request object (see fetch API).
 * @param {UniversalContext} context - The context of the universal serverless function.
 * @param {DataAccess} context.dataAccess - Data access.
 * @param {object} context.sqs - AWS Simple Queue Service client.
 * @param {object} context.s3 - AWS S3 client and related helpers.
 * @param {object} context.env - Environment details.
 * @param {string} context.env.IMPORT_CONFIGURATION - Import configuration params, as a JSON string.
 * @param {object} context.log - Logger.
 * @returns {object} Import controller.
 * @constructor
 */
function ImportController(request, context) {
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

  let importConfiguration = {};
  try {
    importConfiguration = JSON.parse(env.IMPORT_CONFIGURATION);
  } catch (error) {
    log.error(`Failed to parse import configuration: ${error.message}`);
  }

  const importSupervisor = new ImportSupervisor(services, importConfiguration);
  const { maxUrlsPerJob = 1 } = importConfiguration;

  const HEADER_ERROR = 'x-error';
  const STATUS_BAD_REQUEST = 400;
  const STATUS_ACCEPTED = 202;

  function validateRequestData(data) {
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

    if (data.customHeaders && !isObject(data.customHeaders)) {
      throw new ErrorWithStatusCode('Invalid request: customHeaders must be an object', STATUS_BAD_REQUEST);
    }
  }

  function validateImportApiKey(importApiKey, scopes) {
    log.debug(`validating scopes: ${scopes}`);

    try {
      auth.checkScopes(scopes);
    } catch (error) {
      throw new ErrorWithStatusCode('Missing required scopes', 401);
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

  function isMultipartFormData(headers) {
    // Check if the Content-Type header exists and starts with "multipart/form-data"
    const contentType = headers['Content-Type'] || headers['content-type'];
    return contentType && contentType.startsWith('multipart/form-data');
  }

  /**
   * Parse a multipart request to extract the URLs, options, custom import script (import.js), and
   * custom headers.
   * @param {Request} httpRequest - The HTTP request object.
   * @param {object} headers - HTTP request headers object.
   * @returns {Promise<{
   *   urls: string,
   *   options: object,
   *   importScript: string,
   *   customHeaders: object
   * }>} Parsed request data.
   */
  async function parseMultipartRequest(httpRequest, headers) {
    return new Promise((resolve, reject) => {
      // Validate that request is multipart/form-data
      if (!isMultipartFormData(headers)) {
        reject(new ErrorWithStatusCode('Invalid request: expected multipart/form-data Content-Type', STATUS_BAD_REQUEST));
      }

      const busboy = Busboy({
        headers,
        limits: {
          files: 1, // Limit to one file upload — import.js
        },
      });
      let importScript;
      let urls;
      let options;
      let customHeaders;

      // Handle import.js file uploads. In absence of an import.js this callback will not be called
      busboy.on('file', (name, file, info) => {
        let fileBuffer = Buffer.from('');
        const { filename, encoding, mimeType } = info;
        log.debug(`File upload received for ${name}: filename: ${filename}, encoding: ${encoding}, mimeType: ${mimeType}`);
        // Handle file upload
        if (name === 'importScript') {
          file.on('data', (data) => {
            // Concatenate each chunk of data into the buffer.
            // Future performance enhancement, should issues arise: keep the buffer in memory
            // and stream the data directly to S3 once jobId is created.
            fileBuffer = Buffer.concat([fileBuffer, data]);
          }).on('close', () => {
            // Reached the end of the file data
            log.debug(`File upload completed for ${name}`);
            importScript = fileBuffer.toString('utf8');
          });
        }
      });

      // Handle other fields
      busboy.on('field', (name, val) => {
        try {
          if (name === 'urls') {
            urls = JSON.parse(val);
          } else if (name === 'options') {
            options = JSON.parse(val);
          } else if (name === 'customHeaders') {
            customHeaders = JSON.parse(val);
          }
          // Otherwise: ignore the field
        } catch (error) {
          reject(new ErrorWithStatusCode(`Unable to parse request data field (${name}): ${error.message}`, STATUS_BAD_REQUEST));
        }
      });

      // Handle the end of the request
      busboy.on('close', () => {
        const requestData = {
          urls,
          options,
          importScript,
          customHeaders,
        };
        resolve(requestData);
      });

      busboy.on('error', (error) => {
        reject(new ErrorWithStatusCode(`Invalid request, unable to parse request body: ${error.message}`, STATUS_BAD_REQUEST));
      });

      httpRequest.pipe(busboy);
    });
  }

  /**
   * Create and start a new import job.
   * This function requires the Request object in order to parse the multipart/form-data mime-type
   * of the request (required for large file uploads). The request is passed as a parameter to the
   * controller, so we do not require any additional parameters to invoke this function.
   * @returns {Promise<Response>} 202 Accepted if successful, 4xx or 5xx otherwise.
   */
  async function createImportJob(requestContext) {
    const { data: requestData, pathInfo: { headers } } = requestContext;
    const { 'x-api-key': importApiKey, 'user-agent': userAgent } = headers;

    log.debug('DEBUG (TODO: REMOVE ME): request data:', requestData);

    try {
      // The API scope imports.write is required to create a new import job
      validateImportApiKey(importApiKey, ['imports.write']);

      // Parse the multipart request, which can include a custom import.js script as a file upload
      const data = await parseMultipartRequest(request, headers);
      validateRequestData(data);

      const { authInfo: { profile } } = attributes;
      let initiatedBy = {};
      if (profile) {
        initiatedBy = {
          apiKeyName: profile.getName(),
          imsOrgId: profile.getImsOrgId(),
          imsUserId: profile.getImsUserId(),
          userAgent,
        };
      }

      const {
        urls, options = importConfiguration.options, importScript, customHeaders,
      } = data;
      const job = await importSupervisor.startNewJob(
        urls,
        importApiKey,
        options,
        importScript,
        initiatedBy,
        customHeaders,
      );
      return createResponse(ImportJobDto.toJSON(job), STATUS_ACCEPTED);
    } catch (error) {
      log.error(`Failed to create a new import job: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  function parseRequestContext(requestContext) {
    return {
      jobId: requestContext.params.jobId,
      startDate: requestContext.params.startDate,
      endDate: requestContext.params.endDate,
      importApiKey: requestContext.pathInfo.headers['x-api-key'],
    };
  }

  /**
   * Get all import jobs between startDate and endDate
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.startDate - The start date of the range.
   * @param {string} requestContext.params.endDate - The end date of the range.
   * @param {string} requestContext.pathInfo.headers.x-api-key - API key to use for the job.
   * @returns {Promise<Response>} 200 OK with a JSON representation of the import jobs.
   */
  async function getImportJobsByDateRange(requestContext) {
    const { startDate, endDate, importApiKey } = parseRequestContext(requestContext);
    log.debug(`Fetching import jobs between startDate: ${startDate} and endDate: ${endDate}.`);

    try {
      validateImportApiKey(importApiKey, ['imports.read_all']);
      validateIsoDates(startDate, endDate);
      const jobs = await importSupervisor.getImportJobsByDateRange(startDate, endDate);
      return ok(jobs.map((job) => ImportJobDto.toJSON(job)));
    } catch (error) {
      log.error(`Failed to fetch import jobs between startDate: ${startDate} and endDate: ${endDate}, ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Get the status of an import job.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to fetch.
   * @param {string} requestContext.pathInfo.headers.x-api-key - API key used for the job.
   * @returns {Promise<Response>} 200 OK with a JSON representation of the import job.
   */
  async function getImportJobStatus(requestContext) {
    const { jobId, importApiKey } = parseRequestContext(requestContext);

    try {
      // The API scope imports.read is required to get the import job status
      validateImportApiKey(importApiKey, ['imports.read']);
      const job = await importSupervisor.getImportJob(jobId, importApiKey);
      return ok(ImportJobDto.toJSON(job));
    } catch (error) {
      log.error(`Failed to fetch import job status for jobId: ${jobId}, message: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Get the result of an import job, as a pre-signed download URL to S3.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to fetch.
   * @param {string} requestContext.pathInfo.headers.x-api-key - API key used for the job.
   * @returns {Promise<Response>} 200 OK with a pre-signed URL to download the job result.
   */
  async function getImportJobResult(requestContext) {
    const { jobId, importApiKey } = parseRequestContext(requestContext);

    try {
      // The API scope imports.read is required to get the import job status
      validateImportApiKey(importApiKey, ['imports.read']);
      const job = await importSupervisor.getImportJob(jobId, importApiKey);
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
    getImportJobsByDateRange,
  };
}

export default ImportController;
