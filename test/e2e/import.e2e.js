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
import { apiKey } from './config.js';
import { getNewImportJobRequestData, makeRequest, pollUntilJobIsComplete } from './utils.js';

use(sinonChai);
use(chaiAsPromised);

// const thisDirectory = dirname(fileURLToPath(import.meta.url));

describe('Import as a Service end-to-end tests', async () => {
  const jobIdsToCleanUp = [];

  beforeEach(() => {
    // Set up the environment
  });

  describe('Create import job tests', async () => {
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

  it('should create a new Import Job given two URLs', async () => {
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

    expect(response.ok).to.be.true;
    expect(response.status).to.equal(202);

    const newJob = await response.json();
    expect(newJob).to.be.an('object');
    expect(newJob.baseURL).to.equal('https://business.adobe.com');
    expect(newJob.status).to.equal('RUNNING');

    jobIdsToCleanUp.push(newJob.id);

    const completeJob = await pollUntilJobIsComplete(newJob.id);
    expect(completeJob.status).to.equal('COMPLETE');
    expect(completeJob.urlCount).to.equal(2);
    expect(completeJob.successCount).to.equal(2);
    expect(completeJob.failedCount).to.equal(0);
    expect(completeJob.redirectCount).to.equal(0);
    expect(completeJob.hasCustomHeaders).to.be.false;
    expect(completeJob.hasCustomImportJs).to.be.false;
  });
});
