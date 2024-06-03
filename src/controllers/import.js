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

import { createResponse } from '@adobe/spacecat-shared-http-utils';
import { isObject, isValidUrl } from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from '../support/utils.js';
import ImportSupervisor from '../support/import-supervisor.js';

function ImportController(context) {
  const {
    dataAccess, sqs, s3Client, log, env,
  } = context;
  const services = {
    dataAccess,
    sqs,
    s3Client,
    log,
    env,
  };
  const importSupervisor = new ImportSupervisor(services);

  const STATUS_BAD_REQUEST = 400;
  const STATUS_ACCEPTED = 202;

  function validateRequestData(data) {
    if (!isObject(data)) {
      throw new ErrorWithStatusCode('Invalid request: request body data is required', STATUS_BAD_REQUEST);
    }

    if (!Array.isArray(data.urls)) {
      throw new ErrorWithStatusCode('Invalid request: urls must be provided as an array', STATUS_BAD_REQUEST);
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
    const allowedImportApiKeys = env.ALLOWED_IMPORT_API_KEYS?.split(',') || [];
    if (!allowedImportApiKeys.includes(importApiKey)) {
      throw new ErrorWithStatusCode('Invalid import API key', 401);
    }
  }

  /**
   * Create a new import job.
   * @param requestContext
   * @returns {Promise<*>}
   */
  async function createImportJob(requestContext) {
    const { data, pathInfo: { headers } } = requestContext;
    const importApiKey = headers['x-import-api-key'];

    try {
      validateRequestData(data);
      validateImportApiKey(importApiKey);

      const { urls, options } = data;
      const job = await importSupervisor.startNewJob(urls, importApiKey, options);

      return createResponse(job, STATUS_ACCEPTED);
    } catch (error) {
      log.error(`Failed to queue import job: ${error.message}`);
      return createResponse({}, error.status || 500);
    }
  }

  // eslint-disable-next-line no-unused-vars
  async function getImportJobStatus(requestContext) {
    return createResponse({}, 501);
  }

  async function getImportJobResult(requestContext) {
    // Generate a pre-signed URL for the S3 object and return that URL to the client

    /*
     * Structure of the resulting .zip file.
     *   /documents/../page.docx
     *   /import-report.xlsx
     */
    try {
      const { pathInfo: { headers }, params: { jobId } } = requestContext;
      const importApiKey = headers['x-import-api-key'];
      const s3Stream = importSupervisor.getJobArchiveStream(jobId, importApiKey);

      s3Stream.on('error', (err) => {
        // TODO: improve error handling
        throw err;
      });

      // Pipe the s3 stream to the HTTP response
      const response = createResponse({}, 200);
      // TODO: need to verify this approach will work as expected, esp. with larger files
      s3Stream.pipe(response);
      return response;
    } catch (error) {
      log.error(`Failed to get import job result: ${error.message}`);
      return createResponse({}, error.status || 500);
    }
  }

  return {
    createImportJob,
    getImportJobStatus,
    getImportJobResult,
  };
}

export default ImportController;
