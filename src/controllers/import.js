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
import { queueImportJob } from '../support/import-supervisor.js';

function ImportController(context) {
  const { log } = context;

  async function createImportJob(requestContext) {
    // const { urls, options, importApiKey } = requestContext.data.formData;
    // Read import.js file from the form body

    // Attempt to queue the job
    try {
      const result = await queueImportJob(requestContext.data);
      log.info(`Successfully queued import job with ${result.count} URLs.`);

      return createResponse({}, 202);
    } catch (error) {
      log.error(`Failed to queue import job: ${error.message}`);
      return createResponse({}, 503);
    }
  }

  async function getImportJobStatus(requestContext) {
    log.info(`Get job status for ${requestContext.params.jobId}`);
    return createResponse({}, 501);
  }

  async function getImportJobResult(requestContext) {
    /**
     * Structure of the resulting .zip file.
     * /documents/...
     * /import-report.xlsx
     */

    log.info(`Get import result ${requestContext.params.jobId}`);
    return createResponse({}, 501);
  }

  return {
    createImportJob,
    getJobStatus: getImportJobStatus,
    getImportResult: getImportJobResult,
  };
}

export default ImportController;
