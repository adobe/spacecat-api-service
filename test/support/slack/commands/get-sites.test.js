/*
 * Copyright 2023 Adobe. All rights reserved.
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

import { createAudit } from '@adobe/spacecat-shared-data-access/src/models/audit.js';
import { createSite } from '@adobe/spacecat-shared-data-access/src/models/site.js';

import { expect } from 'chai';
import sinon from 'sinon';

import GetSitesCommand, { formatSites } from '../../../../src/support/slack/commands/get-sites.js';

/**
 * Generates a specified number of mock sites with mock audits.
 *
 * @param {number} count - The number of mock sites to generate.
 * @returns {Array<Object>} An array of mock site objects.
 */
function generateSites(count) {
  return Array.from({ length: count }, (_, index) => {
    const siteData = {
      id: `site-${index}`,
      baseURL: `https://site-${index}.com`,
      gitHubURL: (index % 2 === 0) ? `https://github.com/site-${index}` : '',
      isLive: (index % 2 === 0),
    };

    const runtimeError = index % 3 === 0 ? { code: 'NO_FCP', message: 'Test LH Error' } : null;

    const auditData = {
      siteId: siteData.id,
      auditType: 'lhs-mobile',
      auditedAt: new Date().toISOString(),
      fullAuditRef: 'https://example.com',
      isLive: siteData.isLive,
      auditResult: {
        scores: {
          performance: 0.9,
          seo: 0.8,
          accessibility: 0.7,
          'best-practices': 0.6,
        },
        runtimeError,
      },
    };

    const site = createSite(siteData);
    site.setAudits([createAudit(auditData)]);

    return site;
  });
}

describe('GetSitesCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let boltAppStub;
  let logStub;

  beforeEach(() => {
    dataAccessStub = {
      getSitesWithLatestAudit: sinon.stub(),
    };
    boltAppStub = {
      action: sinon.stub(),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
    };

    context = { dataAccess: dataAccessStub, boltApp: boltAppStub, log: logStub };
    slackContext = { say: sinon.spy() };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = GetSitesCommand(context);

      expect(command.id).to.equal('get-all-sites');
      expect(command.name).to.equal('Get All Sites');
    });

    it('registers action handlers correctly', () => {
      GetSitesCommand(context);

      expect(boltAppStub.action.calledWith(/^paginate_sites_(prev|next|page_\d+)$/)).to.be.true;
    });
  });

  describe('Handle Execution Method', () => {
    it('handles command execution with default parameters', async () => {
      dataAccessStub.getSitesWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say.called).to.be.true;
      // Additional assertions for message content
    });

    it('handles command execution with specific non-live and desktop', async () => {
      dataAccessStub.getSitesWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['non-live', 'desktop'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with live and mobile', async () => {
      dataAccessStub.getSitesWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['live', 'mobile'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with all', async () => {
      dataAccessStub.getSitesWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['all', 'mobile'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with no results', async () => {
      dataAccessStub.getSitesWithLatestAudit.resolves([]);
      const command = GetSitesCommand(context);

      await command.handleExecution(['all', 'mobile'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with delivery type aem_edge', async () => {
      dataAccessStub.getSitesWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['aem_edge'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with delivery type aem_cs', async () => {
      dataAccessStub.getSitesWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['aem_cs'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with delivery type other', async () => {
      dataAccessStub.getSitesWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['other'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with unknown arg', async () => {
      dataAccessStub.getSitesWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['unknown', 'unknown'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles errors', async () => {
      dataAccessStub.getSitesWithLatestAudit.rejects(new Error('test error'));
      const command = GetSitesCommand(context);

      await command.handleExecution(['all', 'mobile'], slackContext);

      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: test error')).to.be.true;
    });
  });

  describe('Pagination and Overflow Handling', () => {
    it('handles pagination correctly', async () => {
      dataAccessStub.getSitesWithLatestAudit.resolves(generateSites(50));
      const command = GetSitesCommand(context);

      await command.handleExecution([], slackContext);

      // Assert that the pagination blocks are generated correctly
      // Additional assertions for the 'Previous', 'Next', and numbered page buttons
    });

    it('handles pagination other than start', async () => {
      dataAccessStub.getSitesWithLatestAudit.resolves(generateSites(30));
      const command = GetSitesCommand(context);

      await command.paginationHandler({
        say: slackContext.say,
        ack: sinon.stub(),
        action: { value: '2:all:mobile' },
      });

      expect(slackContext.say.called).to.be.true;
      expect(logStub.info.called).to.be.true;
      expect(dataAccessStub.getSitesWithLatestAudit.called).to.be.true;
    });

    it('handles error in pagination action', async () => {
      dataAccessStub.getSitesWithLatestAudit.rejects(new Error('test error'));
      const command = GetSitesCommand(context);

      await command.paginationHandler({
        say: slackContext.say,
        ack: sinon.stub(),
        action: { value: '2:all:mobile' },
      });

      expect(slackContext.say.calledWith({
        text: ':nuclear-warning: Oops! Something went wrong: test error',
        thread_ts: undefined,
      })).to.be.true;
    });
  });

  describe('Site Formatting Logic', () => {
    it('formats a list of sites correctly', () => {
      const sites = generateSites(4);
      const formattedSites = formatSites(sites, 0, sites.length);

      expect(formattedSites).to.equal('\n'
        + '1. :rocket: Lighthouse Error: No First Contentful Paint [NO_FCP]: <https://site-0.com|https://site-0.com> (<https://github.com/site-0|GH>)\n'
        + '2. :submarine: 90% - 80% - 70% - 60%: <https://site-1.com|https://site-1.com>\n'
        + '3. :rocket: 90% - 80% - 70% - 60%: <https://site-2.com|https://site-2.com> (<https://github.com/site-2|GH>)\n'
        + '4. :submarine: Lighthouse Error: No First Contentful Paint [NO_FCP]: <https://site-3.com|https://site-3.com>');
    });
  });
});
