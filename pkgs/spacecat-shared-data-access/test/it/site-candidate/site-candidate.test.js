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
import { sanitizeTimestamps } from '../../../src/util/util.js';

use(chaiAsPromised);

function checkSiteCandidate(siteCandidate) {
  expect(siteCandidate).to.be.an('object');
  expect(siteCandidate.getBaseURL()).to.be.a('string');
  expect(siteCandidate.getCreatedAt()).to.be.a('string');
  expect(siteCandidate.getSource()).to.be.a('string');
  expect(siteCandidate.getStatus()).to.be.a('string');
  expect(siteCandidate.getUpdatedAt()).to.be.a('string');
}

describe('SiteCandidate IT', async () => {
  let sampleData;
  let SiteCandidate;

  before(async () => {
    sampleData = await seedDatabase();

    const acls = [];
    const aclCtx = { acls };
    const dataAccess = getDataAccess({ aclCtx });
    SiteCandidate = dataAccess.SiteCandidate;
  });

  it('finds one site candidate by base url', async () => {
    const sampleSiteCandidate = sampleData.siteCandidates[6];

    const siteCandidate = await SiteCandidate.findByBaseURL(sampleSiteCandidate.getBaseURL());

    checkSiteCandidate(siteCandidate);

    expect(
      sanitizeTimestamps(siteCandidate.toJSON()),
    ).to.eql(
      sanitizeTimestamps(sampleSiteCandidate.toJSON()),
    );
  });

  it('returns null when site candidate is not found by base url', async () => {
    const siteCandidate = await SiteCandidate.findByBaseURL('https://www.example.com');

    expect(siteCandidate).to.be.null;
  });

  it('adds a new site candidate', async () => {
    const data = {
      baseURL: 'https://www.example.com',
      source: 'RUM',
      status: 'PENDING',
    };
    const siteCandidate = await SiteCandidate.create(data);

    checkSiteCandidate(siteCandidate);

    expect(siteCandidate.getBaseURL()).to.equal(data.baseURL);
    expect(siteCandidate.getSource()).to.equal(data.source);
    expect(siteCandidate.getStatus()).to.equal(data.status);
  });

  it('updates a site candidate', async () => {
    const sampleSiteCandidate = sampleData.siteCandidates[0];
    const updates = {
      baseURL: 'https://www.example-updated.com',
      status: 'APPROVED',
      updatedBy: 'some-user',
      siteId: 'b1ec63c4-87de-4500-bbc9-276039e4bc10',
    };

    const siteCandidate = await SiteCandidate.findByBaseURL(sampleSiteCandidate.getBaseURL());

    siteCandidate.setBaseURL(updates.baseURL);
    siteCandidate.setStatus(updates.status);
    siteCandidate.setUpdatedBy(updates.updatedBy);
    siteCandidate.setSiteId(updates.siteId);

    await siteCandidate.save();

    checkSiteCandidate(siteCandidate);

    expect(siteCandidate.getBaseURL()).to.equal(updates.baseURL);
    expect(siteCandidate.getStatus()).to.equal(updates.status);
    expect(siteCandidate.getUpdatedBy()).to.equal(updates.updatedBy);
    expect(siteCandidate.getSiteId()).to.equal(updates.siteId);
  });
});
