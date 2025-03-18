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

import { sanitizeIdAndAuditFields, sanitizeTimestamps } from '../../../src/util/util.js';
import { getDataAccess } from '../util/db.js';
import { seedDatabase } from '../util/seed.js';

use(chaiAsPromised);

function checkAudit(audit) {
  expect(audit).to.be.an('object');
  expect(audit.getId()).to.be.a('string');
  expect(audit.getAuditId()).to.be.a('string');
  expect(audit.getSiteId()).to.be.a('string');
  expect(audit.getAuditType()).to.be.a('string');
  expect(audit.getAuditedAt()).to.be.a('string');
  expect(audit.getAuditResult()).to.be.an('object');
  expect(audit.getScores()).to.be.an('object');
  expect(audit.getFullAuditRef()).to.be.a('string');
  expect(audit.getIsLive()).to.be.a('boolean');
}

describe('LatestAudit IT', async () => {
  let sampleData;
  let LatestAudit;
  let Audit;
  let dataAccess;

  before(async () => {
    sampleData = await seedDatabase();

    const acls = [{
      acl: [{
        actions: ['C', 'R', 'U', 'D'],
        path: '/latestAudit/*',
      }],
    }];
    const aclCtx = { acls };
    dataAccess = getDataAccess({ aclCtx });
    LatestAudit = dataAccess.LatestAudit;
    Audit = dataAccess.Audit;
  });

  it('finds latest audit by id', async () => {
    const site = sampleData.sites[1];
    const audits = await site.getLatestAudits();

    const audit = await LatestAudit.findById(
      site.getId(),
      audits[0].getAuditType(),
    );

    checkAudit(audit);
    expect(audit.getSiteId()).to.equal(site.getId());
    expect(audit.getAuditType()).to.equal(audits[0].getAuditType());
  });

  it('gets all latest audits', async () => {
    const audits = await LatestAudit.all();

    expect(audits).to.be.an('array');
    // cwv & lhs for 9 sites with audits
    expect(audits.length).to.equal(18);

    for (const audit of audits) {
      checkAudit(audit);
      // eslint-disable-next-line no-await-in-loop
      const original = await Audit.findById(audit.getAuditId());
      expect(original).to.not.be.null;
      expect(
        sanitizeIdAndAuditFields('latestAudit', audit.toJSON()),
      ).to.deep.equal(
        sanitizeTimestamps(original.toJSON()),
      );
    }
  });

  it('gets all latest audits for a site', async () => {
    const site = sampleData.sites[1];

    const audits = await LatestAudit.allBySiteId(site.getId());

    expect(audits).to.be.an('array');
    // cwv & lhs
    expect(audits.length).to.equal(2);
    expect(audits[0].getAuditedAt()).to.equal(sampleData.audits[4].getAuditedAt());
    expect(audits[1].getAuditedAt()).to.equal(sampleData.audits[9].getAuditedAt());

    audits.forEach((audit) => {
      expect(audit.getSiteId()).to.equal(site.getId());
      checkAudit(audit);
    });
  });

  it('gets all latest audits of a type', async () => {
    const audits = await LatestAudit.allByAuditType('cwv');

    expect(audits).to.be.an('array');
    expect(audits.length).to.equal(9);
    audits.forEach((audit) => {
      expect(audit.getAuditType()).to.equal('cwv');
      checkAudit(audit);
    });
  });

  it('gets latest audits of type for a site', async () => {
    const auditType = 'lhs-mobile';
    const site = sampleData.sites[1];

    const audits = await LatestAudit.allBySiteIdAndAuditType(site.getId(), auditType);

    expect(audits).to.be.an('array');
    expect(audits.length).to.equal(1);

    audits.forEach((audit) => {
      expect(audit.getSiteId()).to.equal(site.getId());
      expect(audit.getAuditType()).to.equal(auditType);
      checkAudit(audit);
    });
  });

  it('gets latest audit of type lhs-mobile for a site', async () => {
    const auditType = 'lhs-mobile';
    const site = sampleData.sites[1];
    const audits = await site.getLatestAudits();
    const audit = await site.getLatestAuditByAuditType(auditType);

    checkAudit(audit);

    expect(audit.getSiteId()).to.equal(site.getId());
    expect(audit.getAuditType()).to.equal(auditType);
    expect(audit.getAuditedAt()).to.equal(audits[0].getAuditedAt());
  });

  it('returns null for non-existing audit', async () => {
    const site = sampleData.sites[1];
    const audit = await site.getLatestAuditByAuditType('non-existing-type');

    expect(audit).to.be.null;
  });

  it('updates a latest audit upon audit creation', async () => {
    const auditType = 'lhs-mobile';
    const site = sampleData.sites[1];
    const previousLatestAudit = await site.getLatestAuditByAuditType(auditType);
    const audit = await Audit.create({
      siteId: site.getId(),
      isLive: true,
      auditedAt: '2025-01-06T10:11:51.833Z',
      auditType,
      auditResult: {
        scores: {
          performance: 0.4,
          seo: 0.47,
          accessibility: 0.27,
          'best-practices': 0.55,
        },
      },
      fullAuditRef: 'https://example.com/audit',
    });
    checkAudit(audit);
    const updatedSite = await dataAccess.Site.findById(site.getId());
    const latestAudit = await updatedSite.getLatestAuditByAuditType(auditType);
    checkAudit(latestAudit);
    expect(latestAudit.getSiteId()).to.equal(site.getId());
    expect(latestAudit.getAuditType()).to.equal(auditType);
    expect(latestAudit.getAuditedAt()).to.equal(audit.getAuditedAt());
    expect(latestAudit.getAuditedAt()).to.not.equal(previousLatestAudit.getAuditedAt());
    expect(latestAudit.getUpdatedAt()).to.not.equal(previousLatestAudit.getUpdatedAt());
  });

  it('creates a latest audit upon audit creation', async () => {
    const auditType = 'broken-backlinks';
    const site = sampleData.sites[0];
    const previousLatestAudit = await site.getLatestAuditByAuditType(auditType);

    const audit = await Audit.create({
      siteId: site.getId(),
      isLive: true,
      auditedAt: '2025-01-06T10:11:51.833Z',
      auditType,
      auditResult: {
        scores: {
          performance: 0.4,
          seo: 0.47,
          accessibility: 0.27,
          'best-practices': 0.55,
        },
      },
      fullAuditRef: 'https://example.com/audit',
    });
    checkAudit(audit);
    const updatedSite = await dataAccess.Site.findById(site.getId());
    const latestAudit = await updatedSite.getLatestAuditByAuditType(auditType);
    checkAudit(latestAudit);
    expect(previousLatestAudit).to.be.null;
    expect(latestAudit.getSiteId()).to.equal(site.getId());
    expect(latestAudit.getAuditType()).to.equal(auditType);
    expect(latestAudit.getAuditedAt()).to.equal(audit.getAuditedAt());
  });
});
