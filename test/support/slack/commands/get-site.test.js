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

import { expect } from 'chai';
import sinon from 'sinon';

import { CHARACTER_LIMIT } from '../../../../src/utils/slack/base.js';

import GetSiteCommand, {
  formatAudits,
  formatRows,
} from '../../../../src/support/slack/commands/get-site.js';

/**
 * Generates a specified number of mock audits.
 *
 * @param {number} count - The number of mock audits to generate.
 * @returns {Array<Audit>} An array of mock audit objects.
 */
function generateMockAudits(count) {
  const audits = [];

  for (let i = 0; i < count; i += 1) {
    const runtimeError = i % 3 === 0 ? { code: 'NO_FCP', message: 'Test LH Error' } : null;

    const mockAuditData = {
      siteId: '123',
      auditType: 'lhs-mobile',
      auditedAt: '2023-12-16T09:21:09.000Z',
      isLive: (i % 2 === 0),
      isLiveToggledAt: (i % 2 === 0 ? '2011-10-05T14:48:00.000Z' : null),
      fullAuditRef: 'https://example.com',
      auditResult: {
        runtimeError,
        scores: {
          performance: 0.9,
          seo: 0.8,
          accessibility: 0.7,
          'best-practices': 0.6,
        },
      },
    };

    audits.push(createAudit(mockAuditData));
  }

  return audits;
}

describe('GetSiteCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;

  beforeEach(() => {
    dataAccessStub = {
      getSiteByBaseURL: sinon.stub().resolves({
        getId: () => '123',
        getDeliveryType: () => 'aem_edge',
        getBaseURL: () => 'example.com',
        getGitHubURL: () => '',
        isLive: () => true,
        getIsLiveToggledAt: () => '2011-10-05T14:48:00.000Z',
        getAuditConfig: () => ({
          auditsDisabled: () => false,
          getAuditTypeConfig: () => ({ disabled: () => false }),
        }),
      }),
      getAuditsForSite: sinon.stub(),
    };
    context = { dataAccess: dataAccessStub, log: console };
    slackContext = { say: sinon.spy() };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = GetSiteCommand(context);
      expect(command.id).to.equal('get-site-status');
      expect(command.name).to.equal('Get Site Status');
      expect(command.description).to.equal('Retrieves audit status for a site by a given base URL');
      expect(command.phrases).to.deep.equal(['get site', 'get baseURL']);
    });
  });

  describe('Handle Execution Method', () => {
    it('handles valid input and retrieves site status', async () => {
      dataAccessStub.getAuditsForSite.resolves(generateMockAudits(10));

      const args = ['example.com', 'mobile'];
      const command = GetSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.getSiteByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(dataAccessStub.getAuditsForSite.calledWith('123')).to.be.true;
      expect(slackContext.say.called).to.be.true;
    });

    it('handles valid input and retrieves site status for desktop strategy', async () => {
      dataAccessStub.getAuditsForSite.resolves(generateMockAudits(10));

      const args = ['example.com', 'desktop'];
      const command = GetSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.getSiteByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(dataAccessStub.getAuditsForSite.calledWith('123', 'lhs-desktop')).to.be.true;
      expect(slackContext.say.called).to.be.true;
    });

    it('handles valid input and retrieves site status without latest audit', async () => {
      dataAccessStub.getAuditsForSite.resolves([]);

      const args = ['example.com', 'desktop'];
      const command = GetSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.getSiteByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(dataAccessStub.getAuditsForSite.calledWith('123', 'lhs-desktop')).to.be.true;
      expect(slackContext.say.called).to.be.true;
    });

    it('responds with usage instructions for invalid input', async () => {
      const args = [''];
      const command = GetSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(sinon.match.string)).to.be.true;
    });

    it('notifies when no site is found', async () => {
      dataAccessStub.getSiteByBaseURL.resolves(null);

      const args = ['nonexistent.com'];
      const command = GetSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':x: No site found with base URL \'https://nonexistent.com\'.')).to.be.true;
    });

    it('notifies when an error occurs', async () => {
      dataAccessStub.getSiteByBaseURL.rejects(new Error('Test error'));

      const args = ['nonexistent.com'];
      const command = GetSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: Test error')).to.be.true;
    });
  });

  describe('formatAudits Function', () => {
    it('formats audits correctly', () => {
      const audits = [/* mock audits */];
      const formatted = formatAudits(audits);

      expect(formatted).to.be.a('string');
    });

    it('formats audits with audit errors correctly', () => {
      const audits = generateMockAudits(4);
      const formatted = formatAudits(audits);

      expect(formatted).to.be.a('string');
      expect(formatted).to.equal('```\n'
        + 'Audited At (UTC)  Perf  SEO   A11y  Best Pr.  Live\n'
        + '2023-12-16 09:21:09  Lighthouse Error: No First Contentful Paint [NO_FCP]\n'
        + '2023-12-16 09:21:09  90    80    70    60    No  \n'
        + '2023-12-16 09:21:09  90    80    70    60    Yes \n'
        + '2023-12-16 09:21:09  Lighthouse Error: No First Contentful Paint [NO_FCP]\n'
        + '```');
    });

    it('returns a message for empty audits', () => {
      const formatted = formatAudits([]);

      expect(formatted).to.equal('No audit history available');
    });

    it('handles character limit', () => {
      const formatted = formatAudits(generateMockAudits(60));

      expect(formatted.length).to.be.at.most(CHARACTER_LIMIT);
      expect(formatted).to.include('...');
    });

    it('handles null or undefined cell values', () => {
      const row = [null, 'Data'];
      const formattedRow = formatRows(row);

      expect(formattedRow).to.include('Data');
    });
  });
});
