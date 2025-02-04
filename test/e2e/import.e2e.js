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

/* eslint-env mocha */

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { getNewImportJobRequestData, makeRequest } from './utils/utils.js';
import {
  createAndValidateNewImportJob,
  deleteJobs,
  downloadZipFile,
  getPreSignedZipUrl,
} from './utils/request-helpers.js';
import {
  extractAndVerifyDocxContent,
  extractZip,
} from './utils/zip-helpers.js';
import { expectedJob2ResultCustomImportJs } from './fixtures/jobs.js';
import { apiUrl } from './config/config.js';

use(sinonChai);
use(chaiAsPromised);

const thisDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * These tests exercise the Import as a Service APIs from the outside. They require the following
 * environment variables to be set:
 *   - ENVIRONMENT: The environment to run the tests in. If not 'prod', the tests will use 'dev'
 *   - AEM_E2E_IMPORT_API_KEY_PROD: The API key to use for the 'prod' environment
 *   - AEM_E2E_IMPORT_API_KEY_DEV: The API key to use for the 'dev' environment
 */
describe('Import as a Service end-to-end tests', async () => {
  const jobIdsToCleanUp = [];

  afterEach(async () => {
    // Delete all jobs that were created
    await deleteJobs(jobIdsToCleanUp);
  });

  describe('Import - negative tests', async () => {
    it('should fail to create a new Import Job when the API key is invalid', async () => {
      const response = await makeRequest({
        method: 'POST',
        data: getNewImportJobRequestData(),
        key: 'invalid-test-key',
      });

      expect(response.ok).to.be.false;
      expect(response.status).to.equal(401);
    });

    it('should fail to read the status of a job which does not exist', async () => {
      const response = await makeRequest({
        url: `${apiUrl}/568c723a-1c4d-4c9c-8c8b-9af52f71b6a7`,
        method: 'GET',
      });

      expect(response.ok).to.be.false;
      expect(response.status).to.equal(404);
    });
  });

  describe('Import - positive tests', async () => {
    it('should create a new Import Job and download the resulting archive', async () => {
      // Create and validate the new job
      const { id: jobId } = await createAndValidateNewImportJob();
      jobIdsToCleanUp.push(jobId);

      // Download the archive
      const presignedZipUrl = await getPreSignedZipUrl(jobId);
      const zipData = await downloadZipFile(presignedZipUrl);

      // Extract and examine the files
      const extractedFiles = await extractZip(zipData);

      // Look for a specific .docx file and examine its contents
      await extractAndVerifyDocxContent(
        extractedFiles,
        'docx/blog/2023/10/17/aem-trial-whats-in-the-box/index.docx',
        'What can you do with an AEM Headless Trial?',
      );
    });

    /**
     * This test utilizes a transformation file which replaces the contents of the scraped site with
     * "Importer as a Service - custom import.js test content". If this text is found in the .docx
     * file, that indicates that the custom transformation file was used successfully.
     */
    it('should use a custom import.js transformation file', async () => {
      // Create and validate the new job, this time with a custom import.js transformation file
      const { id: jobId } = await createAndValidateNewImportJob({
        bundledImportJsPath: path.join(thisDirectory, 'fixtures', 'import-full-replacement.bundle.js'),
        expectedJobResult: expectedJob2ResultCustomImportJs,
      });
      jobIdsToCleanUp.push(jobId);

      // Download the archive
      const presignedZipUrl = await getPreSignedZipUrl(jobId);
      const zipData = await downloadZipFile(presignedZipUrl);

      // Extract and examine the files
      const extractedFiles = await extractZip(zipData);

      // Using the import-full-replacement.bundle.js, the only text in the body should be:
      // "Importer as a Service - custom import.js test content"
      await extractAndVerifyDocxContent(
        extractedFiles,
        'docx/blog/2023/10/17/aem-trial-whats-in-the-box/index.docx',
        'Importer as a Service - custom import.js test content',
      );
    });
  });
});
