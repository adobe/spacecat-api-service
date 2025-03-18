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
import { sanitizeIdAndAuditFields, sanitizeTimestamps } from '../../../src/util/util.js';

use(chaiAsPromised);

describe('ApiKey IT', async () => {
  let sampleData;
  let ApiKey;

  before(async () => {
    sampleData = await seedDatabase();

    const acls = [{
      acl: [{
        actions: ['C', 'R', 'U', 'D'],
        path: '/apiKey/*',
      }],
    }];
    const aclCtx = { acls };
    const dataAccess = getDataAccess({ aclCtx });
    ApiKey = dataAccess.ApiKey;
  });

  it('adds a new api key', async () => {
    const data = {
      name: 'Test API Key',
      expiresAt: '2025-12-06T08:35:24.125Z',
      hashedApiKey: '1234',
      imsOrgId: '1234@AdobeOrg',
      imsUserId: '1234',
      scopes: [
        { name: 'imports.read' },
        { name: 'imports.write', domains: ['https://example.com'] },
      ],
    };

    const apiKey = await ApiKey.create(data);

    expect(apiKey).to.be.an('object');
    expect(apiKey.getId()).to.be.a('string');
    expect(apiKey.getCreatedAt()).to.be.a('string');
    expect(apiKey.getUpdatedAt()).to.be.a('string');

    expect(
      sanitizeIdAndAuditFields('ApiKey', apiKey.toJSON()),
    ).to.eql(data);
  });

  it('gets all api keys by imsUserId and imsOrgId', async () => {
    const sampleApiKey = sampleData.apiKeys[0];
    const apiKeys = await ApiKey.allByImsOrgIdAndImsUserId(
      sampleApiKey.getImsOrgId(),
      sampleApiKey.getImsUserId(),
    );

    expect(apiKeys).to.be.an('array');
    expect(apiKeys.length).to.equal(2);

    apiKeys.forEach((apiKey) => {
      expect(apiKey.getImsOrgId()).to.equal(sampleApiKey.getImsOrgId());
      expect(apiKey.getImsUserId()).to.equal(sampleApiKey.getImsUserId());
    });
  });

  it('finds an api key by hashedApiKey', async () => {
    const sampleApiKey = sampleData.apiKeys[0];
    const apiKey = await ApiKey.findByHashedApiKey(sampleApiKey.getHashedApiKey());

    expect(apiKey).to.be.an('object');

    expect(
      sanitizeTimestamps(apiKey.toJSON()),
    ).to.eql(
      sanitizeTimestamps(sampleApiKey.toJSON()),
    );
  });

  it('finds an api key by its id', async () => {
    const sampleApiKey = sampleData.apiKeys[0];
    const apiKey = await ApiKey.findById(sampleApiKey.getId());

    expect(apiKey).to.be.an('object');

    expect(
      sanitizeTimestamps(apiKey.toJSON()),
    ).to.eql(
      sanitizeTimestamps(sampleApiKey.toJSON()),
    );
  });

  it('updates an api key', async () => {
    const apiKey = await ApiKey.findById(sampleData.apiKeys[0].getId());

    const data = {
      name: 'Updated API Key',
      expiresAt: '2024-12-06T08:35:24.125Z',
      hashedApiKey: '1234',
      imsOrgId: '1234@AdobeOrg',
      imsUserId: '1234',
      scopes: [
        { name: 'imports.write' },
        { name: 'imports.read', domains: ['https://updated-example.com'] },
      ],
    };

    const result = await apiKey
      .setName(data.name)
      .setExpiresAt(data.expiresAt)
      .setHashedApiKey(data.hashedApiKey)
      .setImsOrgId(data.imsOrgId)
      .setImsUserId(data.imsUserId)
      .setScopes(data.scopes)
      .save();

    expect(result).to.be.an('object');

    const updatedApiKey = await ApiKey.findById(sampleData.apiKeys[0].getId());

    expect(updatedApiKey.getId()).to.equal(apiKey.getId());

    expect(
      sanitizeIdAndAuditFields('ApiKey', updatedApiKey.toJSON()),
    ).to.eql(data);
  });
});
