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

function checkAudit(audit) {
  expect(audit).to.be.an('object');
  expect(audit.getId()).to.be.a('string');
  expect(audit.getSiteId()).to.be.a('string');
  expect(audit.getAuditType()).to.be.a('string');
  expect(audit.getAuditedAt()).to.be.a('string');
  expect(audit.getAuditResult()).to.be.an('object');
  expect(audit.getScores()).to.be.an('object');
  expect(audit.getFullAuditRef()).to.be.a('string');
  expect(audit.getIsLive()).to.be.a('boolean');
}

describe('Audit IT', async () => {
  let sampleData;
  let Audit;

  before(async () => {
    sampleData = await seedDatabase();

    const dataAccess = getDataAccess();
    Audit = dataAccess.Audit;
  });

  it('gets all audits for a site', async () => {
    const site = sampleData.sites[1];

    const audits = await Audit.allBySiteId(site.getId());

    expect(audits).to.be.an('array');
    expect(audits.length).to.equal(10);

    audits.forEach((audit) => {
      expect(audit.getSiteId()).to.equal(site.getId());
      checkAudit(audit);
    });
  });

  it('gets audits of type for a site', async () => {
    const auditType = 'lhs-mobile';
    const site = sampleData.sites[1];

    const audits = await Audit.allBySiteIdAndAuditType(site.getId(), auditType);

    expect(audits).to.be.an('array');
    expect(audits.length).to.equal(5);

    audits.forEach((audit) => {
      expect(audit.getSiteId()).to.equal(site.getId());
      expect(audit.getAuditType()).to.equal(auditType);
      checkAudit(audit);
    });
  });

  it('returns null for non-existing audit', async () => {
    const audit = await Audit.findById('78fec9c7-2141-4600-b7b1-ea4c78752b91');

    expect(audit).to.be.null;
  });
});
