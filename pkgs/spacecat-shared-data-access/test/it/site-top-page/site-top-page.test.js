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

function checkSiteTopPage(siteTopPage) {
  expect(siteTopPage).to.be.an('object');
  expect(siteTopPage.getId()).to.be.a('string');
  expect(siteTopPage.getSiteId()).to.be.a('string');
  expect(siteTopPage.getUrl()).to.be.a('string');
  expect(siteTopPage.getTraffic()).to.be.a('number');
  expect(siteTopPage.getSource()).to.be.a('string');
  expect(siteTopPage.getTopKeyword()).to.be.a('string');
  expect(siteTopPage.getGeo()).to.be.a('string');
  expect(siteTopPage.getImportedAt()).to.be.a('string');
}

describe('SiteTopPage IT', async () => {
  let sampleData;
  let SiteTopPage;

  before(async () => {
    sampleData = await seedDatabase();

    const acls = [{
      acl: [{
        actions: ['C', 'R', 'U', 'D'],
        path: '/site/**',
      },

      ],
    }];
    const aclCtx = { acls };
    const dataAccess = getDataAccess({ aclCtx });
    SiteTopPage = dataAccess.SiteTopPage;
  });

  it('finds one site top page by id', async () => {
    const siteTopPage = await SiteTopPage.findById(sampleData.siteTopPages[0].getId());

    expect(siteTopPage).to.be.an('object');
    expect(
      sanitizeTimestamps(siteTopPage.toJSON()),
    ).to.eql(
      sanitizeTimestamps(sampleData.siteTopPages[0].toJSON()),
    );
  });

  it('gets all site top pages for a site', async () => {
    const site = sampleData.sites[0];

    const siteTopPages = await SiteTopPage.allBySiteId(site.getId());

    expect(siteTopPages).to.be.an('array');
    expect(siteTopPages.length).to.equal(5);

    siteTopPages.forEach((siteTopPage) => {
      checkSiteTopPage(siteTopPage);
      expect(siteTopPage.getSiteId()).to.equal(site.getId());
    });
  });

  it('gets all top pages for a site from a specific source and geo in descending traffic order', async () => {
    const site = sampleData.sites[0];
    const source = 'ahrefs';
    const geo = 'global';

    const siteTopPages = await SiteTopPage.allBySiteIdAndSourceAndGeo(
      site.getId(),
      source,
      geo,
      { order: 'desc' },
    );

    expect(siteTopPages).to.be.an('array');
    expect(siteTopPages.length).to.equal(5);

    siteTopPages.forEach((siteTopPage) => {
      checkSiteTopPage(siteTopPage);
      expect(siteTopPage.getSiteId()).to.equal(site.getId());
      expect(siteTopPage.getSource()).to.equal(source);
      expect(siteTopPage.getGeo()).to.equal(geo);
    });

    for (let i = 1; i < siteTopPages.length; i += 1) {
      expect(siteTopPages[i - 1].getTraffic()).to.be.at.least(siteTopPages[i].getTraffic());
    }
  });

  it('creates a site top page', async () => {
    const data = {
      siteId: sampleData.sites[0].getId(),
      url: 'https://www.example.com',
      traffic: 100,
      source: 'google',
      topKeyword: 'example',
      geo: 'US',
      importedAt: '2024-12-06T08:35:24.125Z',
    };
    const siteTopPage = await SiteTopPage.create(data);

    checkSiteTopPage(siteTopPage);

    expect(siteTopPage.getSiteId()).to.equal(data.siteId);
    expect(siteTopPage.getUrl()).to.equal(data.url);
    expect(siteTopPage.getTraffic()).to.equal(data.traffic);
    expect(siteTopPage.getSource()).to.equal(data.source);
    expect(siteTopPage.getTopKeyword()).to.equal(data.topKeyword);
    expect(siteTopPage.getGeo()).to.equal(data.geo);
    expect(siteTopPage.getImportedAt()).to.equal(data.importedAt);
  });

  it('updates a site top page', async () => {
    const siteTopPage = await SiteTopPage.findById(sampleData.siteTopPages[0].getId());

    const updates = {
      traffic: 200,
      source: 'bing',
      topKeyword: 'example2',
      geo: 'CA',
      importedAt: '2024-12-07T08:35:24.125Z',
    };

    siteTopPage
      .setTraffic(updates.traffic)
      .setSource(updates.source)
      .setTopKeyword(updates.topKeyword)
      .setGeo(updates.geo)
      .setImportedAt(updates.importedAt);

    await siteTopPage.save();

    const updatedSiteTopPage = await SiteTopPage.findById(sampleData.siteTopPages[0].getId());

    checkSiteTopPage(updatedSiteTopPage);

    expect(updatedSiteTopPage.getTraffic()).to.equal(updates.traffic);
    expect(updatedSiteTopPage.getSource()).to.equal(updates.source);
    expect(updatedSiteTopPage.getTopKeyword()).to.equal(updates.topKeyword);
    expect(updatedSiteTopPage.getGeo()).to.equal(updates.geo);
    expect(updatedSiteTopPage.getImportedAt()).to.equal(updates.importedAt);
  });

  it('stores and returns multiple top pages with identical source, geo and traffic', async () => {
    const site = sampleData.sites[0];
    const source = 'some-source';
    const geo = 'APAC';
    const traffic = 1000;
    const createdPages = [];

    for (let i = 0; i < 2; i += 1) {
      const data = {
        siteId: site.getId(),
        url: `https://www.example.com/page${i}`,
        traffic,
        source,
        topKeyword: 'example',
        geo,
      };

      // eslint-disable-next-line no-await-in-loop
      createdPages.push(await SiteTopPage.create(data));
    }

    const siteTopPages = await SiteTopPage.allBySiteIdAndSourceAndGeo(
      site.getId(),
      source,
      geo,
    );

    expect(siteTopPages).to.be.an('array');
    expect(siteTopPages.length).to.equal(2);

    expect(siteTopPages.some((page) => page.getId() === createdPages[0].getId())).to.equal(true);
    expect(siteTopPages.some((page) => page.getId() === createdPages[1].getId())).to.equal(true);
  });

  it('removes a site top page', async () => {
    const siteTopPage = await SiteTopPage.findById(sampleData.siteTopPages[0].getId());

    await siteTopPage.remove();

    const notFound = await SiteTopPage.findById(sampleData.siteTopPages[0].getId());
    expect(notFound).to.equal(null);
  });

  it('removes all site top pages for a site', async () => {
    const site = sampleData.sites[0];

    await SiteTopPage.removeForSiteId(site.getId());

    const siteTopPages = await SiteTopPage.allBySiteId(site.getId());
    expect(siteTopPages).to.be.an('array');
    expect(siteTopPages.length).to.equal(0);
  });
});
