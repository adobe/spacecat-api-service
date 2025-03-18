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

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { getDataAccess } from '../util/db.js';
import { seedDatabase } from '../util/seed.js';

use(chaiAsPromised);

function checkImportUrl(importUrl) {
  expect(importUrl).to.be.an('object');
  expect(importUrl.getRecordExpiresAt()).to.be.a('number');
  expect(importUrl.getImportJobId()).to.be.a('string');
  expect(importUrl.getStatus()).to.be.a('string');
  expect(importUrl.getUrl()).to.be.a('string');
}

describe('ImportUrl IT', async () => {
  let sampleData;
  let ImportUrl;

  before(async () => {
    sampleData = await seedDatabase();

    const acls = [{
      acl: [{
        actions: ['C', 'R', 'U', 'D'],
        path: '/importJob/**',
      }],
    }];
    const aclCtx = { acls };
    const dataAccess = getDataAccess({ aclCtx });
    ImportUrl = dataAccess.ImportUrl;
  });

  it('adds a new import url', async () => {
    const sampleImportJob = sampleData.importJobs[0];
    const data = {
      importJobId: sampleImportJob.getId(),
      url: 'https://example-some.com/cars',
      status: 'RUNNING',
      initiatedBy: {
        apiKeyName: 'K-321',
        imsUserId: 'U-123',
        imsOrgId: 'O-123',
      },
    };

    const importUrl = await ImportUrl.create(data);

    checkImportUrl(importUrl);
  });

  it('updates an import url', async () => {
    const data = {
      url: 'https://example-some.com/cars',
      status: 'RUNNING',
      file: 'some-file',
      reason: 'some-reason',
    };

    const importUrl = await ImportUrl.findById(sampleData.importUrls[0].getId());
    await importUrl
      .setUrl(data.url)
      .setStatus(data.status)
      .setFile(data.file)
      .setReason(data.reason)
      .save();

    const updatedImportUrl = await ImportUrl.findById(sampleData.importUrls[0].getId());

    checkImportUrl(updatedImportUrl);

    expect(updatedImportUrl.getStatus()).to.equal(data.status);
    expect(updatedImportUrl.getUrl()).to.equal(data.url);
    expect(updatedImportUrl.getFile()).to.equal(data.file);
    expect(updatedImportUrl.getReason()).to.equal(data.reason);
  });

  it('it gets all import urls by import job id', async () => {
    const importJob = sampleData.importJobs[0];
    const importUrls = await ImportUrl.allByImportJobId(importJob.getId());

    expect(importUrls).to.be.an('array');
    expect(importUrls.length).to.equal(6);

    importUrls.forEach((importUrl) => {
      expect(importUrl.getImportJobId()).to.equal(importJob.getId());
      checkImportUrl(importUrl);
    });
  });

  it('it gets all import urls by job id and status', async () => {
    const importJob = sampleData.importJobs[0];
    const importUrls = await ImportUrl.allByImportJobIdAndStatus(importJob.getId(), 'RUNNING');

    expect(importUrls).to.be.an('array');
    expect(importUrls.length).to.equal(2);

    importUrls.forEach((importUrl) => {
      expect(importUrl.getImportJobId()).to.equal(importJob.getId());
      expect(importUrl.getStatus()).to.equal('RUNNING');
      checkImportUrl(importUrl);
    });
  });

  it('finds an import url by its id', async () => {
    const sampleImportUrl = sampleData.importUrls[0];
    const importUrl = await ImportUrl.findById(sampleImportUrl.getId());

    checkImportUrl(importUrl);
    expect(importUrl.getId()).to.equal(sampleImportUrl.getId());
  });

  it('removes an import url', async () => {
    const sampleImportUrl = sampleData.importUrls[0];
    const importUrl = await ImportUrl.findById(sampleImportUrl.getId());

    await importUrl.remove();

    const removedImportUrl = await ImportUrl.findById(sampleImportUrl.getId());
    expect(removedImportUrl).to.be.null;
  });
});
