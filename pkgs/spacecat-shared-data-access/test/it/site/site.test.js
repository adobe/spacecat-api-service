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

import { isIsoDate } from '@adobe/spacecat-shared-utils';

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import siteFixtures from '../../fixtures/sites.fixture.js';
import { sanitizeTimestamps } from '../../../src/util/util.js';
import { getDataAccess } from '../util/db.js';
import { seedDatabase } from '../util/seed.js';

use(chaiAsPromised);

async function checkSite(site) {
  expect(site).to.be.an('object');
  expect(site.getId()).to.be.a('string');
  expect(site.getBaseURL()).to.be.a('string');
  expect(site.getDeliveryType()).to.be.a('string');
  expect(site.getGitHubURL()).to.be.a('string');
  expect(site.getHlxConfig()).to.be.an('object');
  expect(site.getOrganizationId()).to.be.a('string');
  expect(isIsoDate(site.getCreatedAt())).to.be.true;
  expect(isIsoDate(site.getUpdatedAt())).to.be.true;

  const audits = await site.getAudits();
  expect(audits).to.be.an('array');
  expect(site.getIsLive()).to.be.a('boolean');
  expect(isIsoDate(site.getIsLiveToggledAt())).to.be.true;
}

describe('Site IT', async () => {
  let sampleData;
  let Site;

  before(async () => {
    sampleData = await seedDatabase();

    const dataAccess = getDataAccess();
    Site = dataAccess.Site;
  });

  it('gets all sites', async () => {
    let sites = await Site.all();

    expect(sites).to.be.an('array');
    expect(sites.length).to.equal(10);

    sites = sites.sort((a, b) => a.getBaseURL().localeCompare(b.getBaseURL()));

    for (let i = 0; i < sites.length; i += 1) { /* eslint-disable no-await-in-loop */
      await checkSite(sites[i]);
    }
  });

  it('gets all sites to audit (only id attributes returned)', async () => {
    const siteIds = await Site.allSitesToAudit();

    expect(siteIds).to.be.an('array');
    expect(siteIds.length).to.equal(10);

    const ids = sampleData.sites.reverse().map((site) => site.getId());

    expect(siteIds).to.eql(ids);
  });

  it('gets all sites by organization id', async () => {
    const organizationId = sampleData.organizations[0].getId();
    const sites = await Site.allByOrganizationId(organizationId);

    expect(sites).to.be.an('array');
    expect(sites.length).to.equal(4);

    for (let i = 0; i < sites.length; i += 1) { /* eslint-disable no-await-in-loop */
      const site = sites[i];

      await checkSite(site);

      const organization = await site.getOrganization();

      expect(site.getOrganizationId()).to.equal(organizationId);

      delete organization.record.config;
      delete sampleData.organizations[0].record.config;

      expect(organization).to.be.an('object');
      expect(
        sanitizeTimestamps(organization.toJSON()),
      ).to.eql(
        sanitizeTimestamps(sampleData.organizations[0].toJSON()),
      );
    }
  });

  it('gets all sites by delivery type', async () => {
    const deliveryType = 'aem_edge';
    const sites = await Site.allByDeliveryType(deliveryType);

    expect(sites).to.be.an('array');
    expect(sites.length).to.equal(5);

    for (let i = 0; i < sites.length; i += 1) {
      const site = sites[i];
      // eslint-disable-next-line no-await-in-loop
      await checkSite(site);
      expect(site.getDeliveryType()).to.equal(deliveryType);
    }
  });

  it('gets a site by baseURL', async () => {
    const site = await Site.findByBaseURL(sampleData.sites[0].getBaseURL());

    await checkSite(site);

    expect(site.getBaseURL()).to.equal(sampleData.sites[0].getBaseURL());
  });

  it('gets a site by id', async () => {
    const site = await Site.findById(sampleData.sites[0].getId());

    await checkSite(site);

    expect(site.getId()).to.equal(sampleData.sites[0].getId());
  });

  it('returns true when a site exists by id', async () => {
    const exists = await Site.existsById(sampleData.sites[0].getId());
    expect(exists).to.be.true;
  });

  it('returns false when a site does not exist by id', async () => {
    const exists = await Site.existsById('adddd03e-bde1-4340-88ef-904070457745');
    expect(exists).to.be.false;
  });

  it('gets all audits for a site', async () => {
    const site = await Site.findById(sampleData.sites[1].getId());
    const audits = await site.getAudits();

    expect(audits).to.be.an('array');
    expect(audits.length).to.equal(10);

    for (let i = 0; i < audits.length; i += 1) {
      const audit = audits[i];

      expect(audit.getId()).to.be.a('string');
      expect(audit.getSiteId()).to.equal(site.getId());
    }
  });

  it('gets all audits for a site by type', async () => {
    const site = await Site.findById(sampleData.sites[1].getId());
    const audits = await site.getAuditsByAuditType('cwv');

    expect(audits).to.be.an('array');
    expect(audits.length).to.equal(5);

    for (let i = 0; i < audits.length; i += 1) {
      const audit = audits[i];

      expect(audit.getId()).to.be.a('string');
      expect(audit.getSiteId()).to.equal(site.getId());
      expect(audit.getAuditType()).to.equal('cwv');
    }
  });

  it('gets all audits for a site by type and auditAt', async () => {
    const site = await Site.findById(sampleData.sites[1].getId());
    const audits = await site.getAuditsByAuditTypeAndAuditedAt('cwv', '2024-12-03T08:00:55.754Z');

    expect(audits).to.be.an('array');
    expect(audits.length).to.equal(5);

    for (let i = 0; i < audits.length; i += 1) {
      const audit = audits[i];

      expect(audit.getId()).to.be.a('string');
      expect(audit.getSiteId()).to.equal(site.getId());
      expect(audit.getAuditType()).to.equal('cwv');
      expect(audit.getAuditedAt()).to.equal('2024-12-03T08:00:55.754Z');
    }
  });

  it('gets latest audit for a site', async () => {
    const site = await Site.findById(sampleData.sites[1].getId());
    const audit = await site.getLatestAudit();

    expect(audit.getId()).to.be.a('string');
    expect(audit.getSiteId()).to.equal(site.getId());
  });

  it('gets latest audit for a site by type', async () => {
    const site = await Site.findById(sampleData.sites[1].getId());
    const audit = await site.getLatestAuditByAuditType('cwv');

    expect(audit.getId()).to.be.a('string');
    expect(audit.getSiteId()).to.equal(site.getId());
    expect(audit.getAuditType()).to.equal('cwv');
  });

  it('returns null for latest audit for a site by type if not found', async () => {
    const site = await Site.findById(sampleData.sites[1].getId());
    const audit = await site.getLatestAuditByAuditType('does not exist');

    expect(audit).to.be.null;
  });

  it('gets all latest audits for a site', async () => {
    const site = await Site.findById(sampleData.sites[1].getId());
    const audits = await site.getLatestAudits();

    expect(audits).to.be.an('array');
    expect(audits.length).to.equal(2);

    for (let i = 0; i < audits.length; i += 1) {
      const audit = audits[i];

      expect(audit.getId()).to.be.a('string');
      expect(audit.getSiteId()).to.equal(site.getId());
    }
  });

  it('gets all sites with latest audit by type', async () => {
    const sites = await Site.allWithLatestAudit('cwv');

    expect(sites).to.be.an('array');
    expect(sites.length).to.equal(10);

    const siteWithoutAudits = await Site.findById('5d6d4439-6659-46c2-b646-92d110fa5a52');
    await checkSite(siteWithoutAudits);
    await expect(siteWithoutAudits.getLatestAuditByAuditType('cwv')).to.eventually.be.null;

    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-loop-func
      const site = sites[i];
      if (site.getId() === siteWithoutAudits.getId()) {
        // eslint-disable-next-line no-continue
        continue;
      }

      await checkSite(site);

      const audit = await site.getLatestAuditByAuditType('cwv');

      expect(audit).to.be.an('object');
      expect(audit.getSiteId()).to.equal(site.getId());
      expect(audit.getAuditType()).to.equal('cwv');

      const nonExistingAudit = await site.getLatestAuditByAuditType('does not exist');

      expect(nonExistingAudit).to.be.null;
    }
  });

  it('adds a new site', async () => {
    const newSiteData = {
      baseURL: 'https://newexample.com',
      gitHubURL: 'https://github.com/some-org/test-repo',
      hlxConfig: {
        cdnProdHost: 'www.another-example.com',
        code: {
          owner: 'another-owner',
          repo: 'another-repo',
          source: {
            type: 'github',
            url: 'https://github.com/another-owner/another-repo',
          },
        },
        content: {
          contentBusId: '1234',
          source: {
            type: 'onedrive',
            url: 'https://another-owner.sharepoint.com/:f:/r/sites/SomeFolder/Shared%20Documents/another-site/www',
          },
        },
        hlxVersion: 5,
      },
      organizationId: sampleData.organizations[0].getId(),
      isLive: true,
      isLiveToggledAt: '2024-12-06T08:35:24.125Z',
      audits: [],
      config: {
        handlers: {
          'lhs-mobile': {
            excludedURLs: ['https://example.com/excluded'],
          },
        },
      },
    };

    const newSite = await Site.create(newSiteData);
    await checkSite(newSite);

    expect(newSite.getBaseURL()).to.equal(newSiteData.baseURL);
  });

  it('updates a site', async () => {
    const site = await Site.findById(sampleData.sites[0].getId());
    const updates = {
      baseURL: 'https://updated-example.com',
      deliveryType: 'aem_cs',
      gitHubURL: 'https://updated-github.com',
      isLive: false,
      organizationId: sampleData.organizations[1].getId(),
      hlxConfig: {
        cdnProdHost: 'www.another-example.com',
        code: {
          owner: 'another-owner',
          repo: 'another-repo',
          source: {
            type: 'github',
            url: 'https://github.com/another-owner/another-repo',
          },
        },
        content: {
          contentBusId: '1234',
          source: {
            type: 'onedrive',
            url: 'https://another-owner.sharepoint.com/:f:/r/sites/SomeFolder/Shared%20Documents/another-site/www',
          },
        },
        hlxVersion: 5,
      },
    };

    site.setBaseURL(updates.baseURL);
    site.setDeliveryType(updates.deliveryType);
    site.setGitHubURL(updates.gitHubURL);
    site.setHlxConfig(updates.hlxConfig);
    site.setIsLive(updates.isLive);
    site.setOrganizationId(updates.organizationId);

    await site.save();

    const updatedSite = await Site.findById(site.getId());

    await checkSite(updatedSite);

    expect(updatedSite.getBaseURL()).to.equal(updates.baseURL);
    expect(updatedSite.getDeliveryType()).to.equal(updates.deliveryType);
    expect(updatedSite.getGitHubURL()).to.equal(updates.gitHubURL);
    expect(updatedSite.getIsLive()).to.equal(updates.isLive);
    expect(updatedSite.getOrganizationId()).to.equal(updates.organizationId);
  });

  it('reads config of a site', async () => {
    const { config: configFixture } = siteFixtures[0];
    const site = await Site.findById('5d6d4439-6659-46c2-b646-92d110fa5a52');
    const config = site.getConfig();
    expect(config).to.be.an('object');
    expect(config.state).to.deep.equals(configFixture);
  });

  it('removes a site', async () => {
    const site = await Site.findById(sampleData.sites[0].getId());

    await site.remove();

    const notFound = await Site.findById(sampleData.sites[0].getId());
    expect(notFound).to.be.null;
  });
});
