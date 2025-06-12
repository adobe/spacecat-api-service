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

/* eslint-env mocha */
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import GetSiteAuditsCommand, {
  formatAuditStatus,
} from '../../../../src/support/slack/commands/get-site-audits.js';

use(sinonChai);

describe('GetSiteAuditsCommand', () => {
  let context;
  let site;
  let slackContext;
  let dataAccessStub;

  beforeEach(() => {
    site = {
      getId: () => '123',
      getDeliveryType: () => 'aem_edge',
      getBaseURL: () => 'example.com',
      getGitHubURL: () => '',
      getIsLive: () => true,
      getIsLiveToggledAt: () => '2011-10-05T14:48:00.000Z',
    };
    dataAccessStub = {
      Configuration: {
        findLatest: sinon.stub().resolves({
          getHandlers: () => ({
            'lhs-mobile': {},
            'lhs-desktop': {},
            'broken-backlinks': {},
          }),
          isHandlerEnabledForSite: () => true,
        }),
      },
      Site: {
        findByBaseURL: sinon.stub().resolves(site),
      },
    };
    context = { dataAccess: dataAccessStub, log: console };
    slackContext = { say: sinon.spy() };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = GetSiteAuditsCommand(context);
      expect(command.id).to.equal('get-site-audits');
      expect(command.name).to.equal('Get all audits for a site');
      expect(command.description).to.equal('Retrieves all audit types (enabled and disabled) for a site by a given base URL');
      expect(command.phrases).to.deep.equal(['get site-audits']);
    });
  });

  describe('Handle Execution Method', () => {
    it('handles valid input and retrieves audit status', async () => {
      const args = ['example.com'];
      const command = GetSiteAuditsCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.Site.findByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(slackContext.say.called).to.be.true;
    });

    it('responds with usage instructions for invalid input', async () => {
      const args = [''];
      const command = GetSiteAuditsCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(sinon.match.string)).to.be.true;
    });

    it('notifies when no site is found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const args = ['nonexistent.com'];
      const command = GetSiteAuditsCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':x: No site found with base URL \'https://nonexistent.com\'.')).to.be.true;
    });

    it('handles case when no audit types are configured', async () => {
      dataAccessStub.Configuration.findLatest.resolves({
        getHandlers: () => ({}),
        isHandlerEnabledForSite: () => true,
      });

      const args = ['example.com'];
      const command = GetSiteAuditsCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: No audit types are configured in the system.')).to.be.true;
    });

    it('notifies when an error occurs', async () => {
      dataAccessStub.Site.findByBaseURL.rejects(new Error('Test error'));

      const args = ['nonexistent.com'];
      const command = GetSiteAuditsCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: Test error')).to.be.true;
    });
  });

  describe('formatAuditStatus Function', () => {
    it('formats audit status correctly with both enabled and disabled audits', () => {
      const auditResults = [
        { auditType: 'lhs-mobile', isEnabled: true },
        { auditType: 'lhs-desktop', isEnabled: false },
        { auditType: 'cwv', isEnabled: true },
        { auditType: '404', isEnabled: false },
      ];

      const formatted = formatAuditStatus(auditResults);

      expect(formatted).to.be.a('string');
      expect(formatted).to.include('*Enabled Audits:* ✅');
      expect(formatted).to.include('• lhs-mobile');
      expect(formatted).to.include('• cwv');
      expect(formatted).to.include('*Disabled Audits:* ❌');
      expect(formatted).to.include('• lhs-desktop');
      expect(formatted).to.include('• 404');
    });

    it('formats audit status correctly with only enabled audits', () => {
      const auditResults = [
        { auditType: 'lhs-mobile', isEnabled: true },
        { auditType: 'cwv', isEnabled: true },
      ];

      const formatted = formatAuditStatus(auditResults);

      expect(formatted).to.include('*Enabled Audits:* ✅');
      expect(formatted).to.include('• lhs-mobile');
      expect(formatted).to.include('• cwv');
      expect(formatted).to.not.include('*Disabled Audits:*');
    });

    it('formats audit status correctly with only disabled audits', () => {
      const auditResults = [
        { auditType: 'lhs-desktop', isEnabled: false },
        { auditType: '404', isEnabled: false },
      ];

      const formatted = formatAuditStatus(auditResults);

      expect(formatted).to.include('*Disabled Audits:* ❌');
      expect(formatted).to.include('• lhs-desktop');
      expect(formatted).to.include('• 404');
      expect(formatted).to.not.include('*Enabled Audits:*');
    });

    it('handles empty audit results', () => {
      const auditResults = [];

      const formatted = formatAuditStatus(auditResults);

      expect(formatted).to.equal('');
    });
  });
});
