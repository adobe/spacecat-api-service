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
import { getNewImportJobRequestData, makeRequest } from './utils/utils.js';
import {
  createAndValidateNewImportJob,
  deleteJobs, downloadZipFile,
  getPreSignedZipUrl,
} from './utils/request-helpers.js';
import { extractDocxContent, extractZip } from './utils/zip-helpers.js';

use(sinonChai);
use(chaiAsPromised);

// const thisDirectory = dirname(fileURLToPath(import.meta.url));

describe('Import as a Service end-to-end tests', async () => {
  const jobIdsToCleanUp = [];
  const log = console;

  beforeEach(() => {
    // Set up the environment
  });

  afterEach(async () => {
    // Delete all jobs that were created
    await deleteJobs(jobIdsToCleanUp);
  });

  describe('Create import job - negative tests', async () => {
    it('should fail to create a new Import Job when the API key is invalid', async () => {
      const response = await makeRequest({
        method: 'POST',
        data: getNewImportJobRequestData(),
        key: 'invalid-test-key',
      });

      expect(response.ok).to.be.false;
      expect(response.status).to.equal(401);
    });
  });

  describe('Create import job - positive tests', async () => {
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
      const docxFileName = 'docx/products/experience-manager/sites/aem-sites.docx';
      if (extractedFiles[docxFileName]) {
        const docxContent = await extractDocxContent(extractedFiles[docxFileName]);
        log.info(docxContent);
        // console.log('done!');
        // TODO: verify contents
      } else {
        throw new Error('A .docx was file missing from the archive');
      }
    });
  });
});
