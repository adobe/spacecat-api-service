/*
 * Copyright 2025 Adobe. All rights reserved.
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
import sinon from 'sinon';
import esmock from 'esmock';
import { deriveScrapingStatus } from '../../../../src/support/slack/commands/onboard-status-scraping.js';

describe('onboard-status scraping helpers', () => {
  describe('deriveScrapingStatus', () => {
    it('is "available" when at least one URL completed', () => {
      expect(deriveScrapingStatus({
        completed: 3, failed: 1, pending: 5, total: 9,
      })).to.equal('available');
    });

    it('is "in_progress" when nothing completed but URLs are still pending', () => {
      expect(deriveScrapingStatus({
        completed: 0, failed: 184, pending: 410, total: 594,
      })).to.equal('in_progress');
    });

    it('is "failed" only when terminal with zero completions', () => {
      expect(deriveScrapingStatus({
        completed: 0, failed: 12, pending: 0, total: 12,
      })).to.equal('failed');
    });

    it('is "unknown" when there are no results or no stats', () => {
      expect(deriveScrapingStatus({
        completed: 0, failed: 0, pending: 0, total: 0,
      })).to.equal('unknown');
      expect(deriveScrapingStatus(null)).to.equal('unknown');
    });
  });

  describe('getScrapingStats', () => {
    let sandbox;
    let scrapeClientStub;
    let getScrapingStats;

    beforeEach(async () => {
      sandbox = sinon.createSandbox();
      scrapeClientStub = {
        getScrapeJobsByBaseURL: sandbox.stub(),
        getScrapeJobUrlResults: sandbox.stub(),
      };
      const mod = await esmock('../../../../src/support/slack/commands/onboard-status-scraping.js', {
        '@adobe/spacecat-shared-scrape-client': {
          ScrapeClient: { createFrom: () => scrapeClientStub },
        },
      });
      getScrapingStats = mod.getScrapingStats;
    });

    afterEach(() => sandbox.restore());

    it('aggregates URL statuses across jobs created after lastStartTime', async () => {
      const start = 1000;
      scrapeClientStub.getScrapeJobsByBaseURL.resolves([
        { id: 'old', startedAt: new Date(start - 5000).toISOString() },
        { id: 'j1', startedAt: new Date(start + 1000).toISOString() },
      ]);
      scrapeClientStub.getScrapeJobUrlResults.withArgs('j1').resolves([
        { status: 'COMPLETE' }, { status: 'FAILED' }, { status: 'PENDING' }, { status: 'RUNNING' },
      ]);

      const stats = await getScrapingStats('https://example.com', start, { log: console });

      expect(scrapeClientStub.getScrapeJobUrlResults.calledWith('old')).to.equal(false);
      expect(stats).to.deep.equal({
        completed: 1, failed: 1, pending: 2, total: 4,
      });
    });

    it('returns null when there are no jobs for the site', async () => {
      scrapeClientStub.getScrapeJobsByBaseURL.resolves([]);
      const stats = await getScrapingStats('https://example.com', 1000, { log: console });
      expect(stats).to.equal(null);
    });
  });

  describe('buildScrapingSection', () => {
    let sandbox;
    let scrapeClientStub;
    let buildScrapingSection;

    beforeEach(async () => {
      sandbox = sinon.createSandbox();
      scrapeClientStub = {
        getScrapeJobsByBaseURL: sandbox.stub(),
        getScrapeJobUrlResults: sandbox.stub(),
      };
      const mod = await esmock('../../../../src/support/slack/commands/onboard-status-scraping.js', {
        '@adobe/spacecat-shared-scrape-client': {
          ScrapeClient: { createFrom: () => scrapeClientStub },
        },
      });
      buildScrapingSection = mod.buildScrapingSection;
    });

    afterEach(() => sandbox.restore());

    it('renders stats with an in-progress count and hourglass data-source line', async () => {
      scrapeClientStub.getScrapeJobsByBaseURL.resolves([{ id: 'j1', startedAt: new Date(2000).toISOString() }]);
      scrapeClientStub.getScrapeJobUrlResults.resolves([
        { status: 'FAILED' }, { status: 'PENDING' }, { status: 'RUNNING' },
      ]);

      const section = await buildScrapingSection('https://example.com', 1000, { log: console });

      expect(section.statsMessage).to.contain('⏳ In progress: 2');
      expect(section.statsMessage).to.contain('❌ Failed: 1');
      expect(section.dataSourceLine).to.equal('Scraping :hourglass_flowing_sand:');
    });

    it('renders the "no results yet" message when there are no scrape jobs', async () => {
      scrapeClientStub.getScrapeJobsByBaseURL.resolves([]);

      const section = await buildScrapingSection('https://example.com', 1000, { log: console });

      expect(section.statsMessage).to.contain('no results available yet');
      expect(section.dataSourceLine).to.equal('Scraping :x:');
    });

    it('returns null (best-effort) when the scrape client throws', async () => {
      scrapeClientStub.getScrapeJobsByBaseURL.rejects(new Error('boom'));
      const warn = sandbox.stub();

      const section = await buildScrapingSection('https://example.com', 1000, { log: { warn } });

      expect(section).to.equal(null);
      expect(warn.calledOnce).to.equal(true);
    });
  });
});
