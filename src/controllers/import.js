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
  hasText,
  isIsoDate, isNonEmptyObject, isObject, isValidUrl,
} from '@adobe/spacecat-shared-utils';
import psl from 'psl';
import { ImportJob as ImportJobModel } from '@adobe/spacecat-shared-data-access';
import { ErrorWithStatusCode } from '../support/utils.js';
import ImportSupervisor from '../support/import-supervisor.js';
import { ImportJobDto } from '../dto/import-job.js';

/**
 * Import controller. Provides methods to create, read, and fetch the result of import jobs.
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
function ImportController(context) {
  /**
   * The import controller has a number of scopes that are required to access different parts of the
   * import functionality. These scopes are used to validate the authenticated user has the required
   * level of access.
   * @type {{READ: 'imports.read', ALL_DOMAINS: 'imports.all_domains',
   * READ_ALL: 'imports.read_all', WRITE: 'imports.write'}}
   */
  const SCOPE = {
    READ: 'imports.read', // allows users to read the import jobs created with their API key
    WRITE: 'imports.write', // allows users to create new import jobs
    READ_ALL: 'imports.read_all', // allows users to view all import jobs
    ALL_DOMAINS: 'imports.all_domains', // allows users to import across any domain
    DELETE: 'imports.delete', // access to delete import jobs
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

    const types = Object.values(ImportJobModel.ImportOptionTypes);
    // the type property is optional for backwards compatibility, if it is provided it must be valid
    if (data.options?.type && !types.includes(data.options.type)) {
      throw new ErrorWithStatusCode(`Invalid request: type must be either ${types.join(' or ')}`, STATUS_BAD_REQUEST);
    }

    if (data.options?.type === ImportJobModel.ImportOptionTypes.XWALK) {
      if (!hasText(data.models)) {
        throw new ErrorWithStatusCode('Invalid request: models must be an string', STATUS_BAD_REQUEST);
      }
      if (!hasText(data.filters)) {
        throw new ErrorWithStatusCode('Invalid request: filters must be an string', STATUS_BAD_REQUEST);
      }
      if (!hasText(data.definitions)) {
        throw new ErrorWithStatusCode('Invalid request: definitions must be an string', STATUS_BAD_REQUEST);
      }
      if (!isNonEmptyObject(data.options.data)
        || !hasText(data.options.data.assetFolder)
        || !hasText(data.options.data.siteName)) {
        throw new ErrorWithStatusCode('Missing option(s): { data: { assetFolder, siteName } } are required', STATUS_BAD_REQUEST);
      }
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
   * Create and start a new import job.
   * @param {UniversalContext} requestContext - The context of the universal serverless function.
   * @param {object} requestContext.multipartFormData - Parsed multipart/form-data request data.
   * @param {object} requestContext.pathInfo.headers - HTTP request headers.
   * @returns {Promise<Response>} 202 Accepted if successful, 4xx or 5xx otherwise.
   */
  async function createImportJob(requestContext) {
    const { multipartFormData, pathInfo: { headers } } = requestContext;
    const { 'x-api-key': importApiKey, 'user-agent': userAgent } = headers;

    try {
      // The API scope imports.write is required to create a new import job
      validateAccessScopes([SCOPE.WRITE]);
      validateRequestData(multipartFormData);

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
        urls, options, importScript, customHeaders, models, filters, definitions,
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

      log.info(`Creating a new import job with ${urls.length} URLs.`);

      // Merge the import configuration options with the request options allowing the user options
      // to override the defaults
      const mergedOptions = {
        ...importConfiguration.options,
        ...options,
      };

      const job = await importSupervisor.startNewJob(
        urls,
        importApiKey,
        mergedOptions,
        importScript,
        initiatedBy,
        customHeaders,
        models,
        filters,
        definitions,
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
    const { startDate, endDate } = parseRequestContext(requestContext);
    log.debug(`Fetching import jobs between startDate: ${startDate} and endDate: ${endDate}.`);

    try {
      validateAccessScopes([SCOPE.READ_ALL]);
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
      validateAccessScopes([SCOPE.READ]);
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
      validateAccessScopes([SCOPE.READ]);
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

  /**
   * Get the progress of an import job. Results are broken down into the following:
   * - complete: URLs that have been successfully imported.
   * - failed: URLs that have failed to import.
   * - pending: URLs that are still being processed.
   * - redirected: URLs that have been redirected.
   * @param requestContext - Context of the request.
   * @return {Promise<Response>} 200 OK with a JSON representation of the import job progress.
   */
  async function getImportJobProgress(requestContext) {
    const { jobId, importApiKey } = parseRequestContext(requestContext);

    try {
      validateAccessScopes([SCOPE.READ]);
      const progress = await importSupervisor.getImportJobProgress(jobId, importApiKey);
      return ok(progress);
    } catch (error) {
      log.error(`Failed to fetch the import job progress: ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Delete an import job.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to delete.
   * @return {Promise<Response>} 204 No Content if successful, 4xx or 5xx otherwise.
   */
  async function deleteImportJob(requestContext) {
    const { jobId, importApiKey } = parseRequestContext(requestContext);

    try {
      validateAccessScopes([SCOPE.DELETE]);
      await importSupervisor.deleteImportJob(jobId, importApiKey);

      return noContent();
    } catch (error) {
      log.error(`Failed to delete import jobId: ${jobId} : ${error.message}`);
      return createErrorResponse(error);
    }
  }

  /**
   * Validate the data in a PATCH request
   * @param {Object[]} data - The data to validate. It has to be of the format:
   * [ { "op": "replace", "path": "/status", "value": "STOPPED" } ]
   * @throws {ErrorWithStatusCode} 400 Bad Request if the data is invalid.
   */
  function validateStopJobPatchData(data) {
    if (!Array.isArray(data)) {
      throw new ErrorWithStatusCode('Invalid request: Patch request data needs to be an array', STATUS_BAD_REQUEST);
    }

    if (data.length !== 1) {
      throw new ErrorWithStatusCode('Invalid request: Patch request data needs to contain exactly one operation', STATUS_BAD_REQUEST);
    }

    data.forEach((patch) => {
      if (!isObject(patch)) {
        throw new ErrorWithStatusCode('Invalid request: Patch request data needs to be an array of objects', STATUS_BAD_REQUEST);
      }

      if (patch.op !== 'replace') {
        throw new ErrorWithStatusCode('Invalid request: Patch request supports the following operations: ["replace"]', STATUS_BAD_REQUEST);
      }

      if (patch.path !== '/status') {
        throw new ErrorWithStatusCode('Invalid request: Patch request supports the following paths: ["/status"]', STATUS_BAD_REQUEST);
      }

      if (patch.value !== ImportJobModel.ImportJobStatus.STOPPED) {
        throw new ErrorWithStatusCode('Invalid request: Patch request supports the following values: ["STOPPED"]', STATUS_BAD_REQUEST);
      }
    });
  }

  /**
   * Stop an import job.
   * @param {object} requestContext - Context of the request.
   * @param {string} requestContext.params.jobId - The ID of the job to stop.
   * @returns {Promise<Response>} 204 No Content if successful, 4xx or 5xx otherwise.
   */
  async function stopImportJob(requestContext) {
    const { data } = requestContext;
    const { jobId, importApiKey } = parseRequestContext(requestContext);
    try {
      validateAccessScopes([SCOPE.WRITE]);
      validateStopJobPatchData(data);
      await importSupervisor.stopImportJob(jobId, importApiKey);
      return noContent();
    } catch (error) {
      log.error(`Failed to stop import job with jobId: ${jobId} : ${error.message}`);
      return createErrorResponse(error);
    }
  }

  return {
    createImportJob,
    getImportJobStatus,
    getImportJobResult,
    getImportJobProgress,
    getImportJobsByDateRange,
    deleteImportJob,
    stopImportJob,
  };
}

export default ImportController;
