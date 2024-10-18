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

import { expect } from 'chai';
import {
  expectJobsToMatch,
  getNewImportJobRequestData,
  makeRequest,
  pollUntilJobIsComplete,
} from './utils.js';
import { apiKey, apiUrl } from './config.js';
import { expectedJob1Result } from './fixtures/jobs.js';

const log = console;

export async function createAndValidateNewImportJob() {
  const data = getNewImportJobRequestData({
    urls: [
      'https://business.adobe.com/products/experience-manager/sites/aem-sites.html',
      'https://business.adobe.com/products/experience-manager/sites/site-performance.html',
    ],
  });

  const response = await makeRequest({
    method: 'POST',
    data,
    key: apiKey,
  });

  // Expect a 202 Created response
  expect(response.ok).to.be.true;
  expect(response.status).to.equal(202);

  const newJob = await response.json();
  log.info('Created job:', newJob.id);

  expect(newJob).to.be.an('object');
  expect(newJob.baseURL).to.equal('https://business.adobe.com');
  expect(newJob.status).to.equal('RUNNING');

  // Poll until COMPLETE
  const completeJob = await pollUntilJobIsComplete(newJob.id);
  expectJobsToMatch(expectedJob1Result, completeJob);

  return completeJob;
}

export async function deleteJobs(jobIdsToCleanUp) {
  for (const jobId of jobIdsToCleanUp) {
    // eslint-disable-next-line no-await-in-loop
    const response = await makeRequest({
      url: `${apiUrl}/${jobId}`,
      method: 'DELETE',
      key: apiKey,
    });

    expect(response.ok).to.be.true;
    expect(response.status).to.equal(204);

    log.info('Deleted job:', jobId);

    // Remove from the array
    jobIdsToCleanUp.splice(jobIdsToCleanUp.indexOf(jobId), 1);
  }
}
