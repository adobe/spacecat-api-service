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
import { isObject } from '@adobe/spacecat-shared-utils';
import ImportSupervisor from '../support/import-supervisor.js';
import { ErrorWithStatusCode } from '../support/utils.js';

function ImportController(context) {
  const {
    log, env, sqsClient, s3Client,
  } = context;
  const services = {
    log,
    sqsClient,
    s3Client,
  };
  const importSupervisor = ImportSupervisor(services);

  function validateRequestData(data) {
    const BAD_REQUEST = 400;
    if (!isObject(data)) {
      throw new ErrorWithStatusCode('Invalid request: request body data is required', BAD_REQUEST);
    }

    if (!Array.isArray(data.urls)) {
      throw new ErrorWithStatusCode('Invalid request: urls must be provided as an array', BAD_REQUEST);
    }
    
    data.urls.forEach((url) => {
      if (!isValidUrl(url)) {
        throw new ErrorWithStatusCode(`Invalid request: ${url} is not a valid URL`, BAD_REQUEST);
      }
    });

    if (data.options && !isObject(data.options)) {
      throw new ErrorWithStatusCode('Invalid request: options must be an object', BAD_REQUEST);
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
   *
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
      const jobResponse = await importSupervisor.startNewJob(urls, options, importApiKey);
      return createResponse(jobResponse, 202);
    } catch (error) {
      log.error(`Failed to queue import job: ${error.message}`);
      return createResponse({}, error.status || 500);
    }
  }

  async function getImportJobStatus(requestContext) {
    try {
      return createResponse(await importSupervisor.getJobStatus(requestContext.params.jobId), 200);
    } catch (error) {
      log.error(`Failed to fetch import job status: ${error.message}`);
      return createResponse({}, error.status || 500);
    }
  }

  async function getImportJobResult(requestContext) {
    /**
     * Structure of the resulting .zip file.
     *   /documents/../page.docx
     *   /import-report.xlsx
     */
    const { params: { jobId } } = requestContext;
    try {
      const resultResponse = await importSupervisor.getJobArchive(jobId);
      return createResponse(resultResponse, 200);
    } catch (error) {
      log.error(`Failed to fetch import job result: ${error.message}`);
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
