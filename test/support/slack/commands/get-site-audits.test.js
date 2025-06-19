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
import esmock from 'esmock';

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
          getEnabledAuditsForSite: () => ['lhs-mobile', 'broken-backlinks'],
          getDisabledAuditsForSite: () => ['lhs-desktop'],
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

    it('responds with warning for invalid URL format', async () => {
      // Create a stub for isValidUrl that returns false for this specific test
      const isValidUrlStub = sinon.stub().returns(false);

      // Mock the module with our customized isValidUrl function
      const CustomGetSiteAuditsCommand = await esmock('../../../../src/support/slack/commands/get-site-audits.js', {
        '@adobe/spacecat-shared-utils': {
          isValidUrl: isValidUrlStub, // Override just this function
        },
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: (url) => (url.startsWith('http') ? url : `https://${url}`),
        },
      });

      const command = CustomGetSiteAuditsCommand.default(context);

      // Test with a URL that will be identified as invalid
      const testURL = 'invalid-url';
      const args = [testURL];

      await command.handleExecution(args, slackContext);

      // Verify isValidUrl was called with the processed URL
      expect(isValidUrlStub.calledWith('https://invalid-url')).to.be.true;

      // Verify the expected warning message was displayed
      expect(slackContext.say.calledWith(':warning: Please provide a valid URL.')).to.be.true;

      // Verify that Site.findByBaseURL is not called when URL is invalid
      expect(dataAccessStub.Site.findByBaseURL.called).to.be.false;
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
        getEnabledAuditsForSite: () => [],
        getDisabledAuditsForSite: () => [],
      });

      const args = ['example.com'];
      const command = GetSiteAuditsCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: No audit types are configured in the system.')).to.be.true;
    });

    it('handles mixed audit status (some enabled, some disabled)', async () => {
      // Mock configuration with mixed audit statuses
      dataAccessStub.Configuration.findLatest.resolves({
        getEnabledAuditsForSite: () => ['lhs-mobile', 'cwv'],
        getDisabledAuditsForSite: () => ['lhs-desktop', 'broken-backlinks'],
      });

      const args = ['example.com'];
      const command = GetSiteAuditsCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.called).to.be.true;
      const messageCall = slackContext.say.getCall(0);
      const message = messageCall.args[0];

      // Verify the message contains blocks with correct content
      expect(message).to.have.property('blocks');
      expect(message.blocks).to.be.an('array');
      expect(message.blocks.length).to.be.greaterThan(0);

      // Get the text from the first block
      const firstBlock = message.blocks[0];
      expect(firstBlock).to.have.property('text');
      expect(firstBlock.text).to.have.property('text');
      const messageText = firstBlock.text.text;

      // Verify the message contains summary with correct counts
      expect(messageText).to.include('📊 *Summary:* 2 enabled, 2 disabled (4 total audit types)');
      expect(messageText).to.include('*Enabled Audits:* ✅');
      expect(messageText).to.include('• lhs-mobile');
      expect(messageText).to.include('• cwv');
      expect(messageText).to.include('*Disabled Audits:* ❌');
      expect(messageText).to.include('• lhs-desktop');
      expect(messageText).to.include('• broken-backlinks');
    });

    it('handles only enabled audits', async () => {
      dataAccessStub.Configuration.findLatest.resolves({
        getEnabledAuditsForSite: () => ['lhs-mobile', 'cwv'],
        getDisabledAuditsForSite: () => [],
      });

      const args = ['example.com'];
      const command = GetSiteAuditsCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.called).to.be.true;
      const messageCall = slackContext.say.getCall(0);
      const message = messageCall.args[0];
      const messageText = message.blocks[0].text.text;

      expect(messageText).to.include('📊 *Summary:* 2 enabled, 0 disabled (2 total audit types)');
      expect(messageText).to.include('*Enabled Audits:* ✅');
      expect(messageText).to.include('• lhs-mobile');
      expect(messageText).to.include('• cwv');
      expect(messageText).to.not.include('*Disabled Audits:*');
    });

    it('handles only disabled audits', async () => {
      dataAccessStub.Configuration.findLatest.resolves({
        getEnabledAuditsForSite: () => [],
        getDisabledAuditsForSite: () => ['lhs-desktop', 'broken-backlinks'],
      });

      const args = ['example.com'];
      const command = GetSiteAuditsCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.called).to.be.true;
      const messageCall = slackContext.say.getCall(0);
      const message = messageCall.args[0];
      const messageText = message.blocks[0].text.text;

      expect(messageText).to.include('📊 *Summary:* 0 enabled, 2 disabled (2 total audit types)');
      expect(messageText).to.not.include('*Enabled Audits:*');
      expect(messageText).to.include('*Disabled Audits:* ❌');
      expect(messageText).to.include('• lhs-desktop');
      expect(messageText).to.include('• broken-backlinks');
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
      const enabledAudits = [
        { auditType: 'lhs-mobile', isEnabled: true },
        { auditType: 'cwv', isEnabled: true },
      ];
      const disabledAudits = [
        { auditType: 'lhs-desktop', isEnabled: false },
        { auditType: '404', isEnabled: false },
      ];

      const formatted = formatAuditStatus(enabledAudits, disabledAudits);

      expect(formatted).to.be.a('string');
      expect(formatted).to.include('*Enabled Audits:* ✅');
      expect(formatted).to.include('• lhs-mobile');
      expect(formatted).to.include('• cwv');
      expect(formatted).to.include('*Disabled Audits:* ❌');
      expect(formatted).to.include('• lhs-desktop');
      expect(formatted).to.include('• 404');
    });

    it('formats audit status correctly with only enabled audits', () => {
      const enabledAudits = [
        { auditType: 'lhs-mobile', isEnabled: true },
        { auditType: 'cwv', isEnabled: true },
      ];
      const disabledAudits = [];

      const formatted = formatAuditStatus(enabledAudits, disabledAudits);

      expect(formatted).to.include('*Enabled Audits:* ✅');
      expect(formatted).to.include('• lhs-mobile');
      expect(formatted).to.include('• cwv');
      expect(formatted).to.not.include('*Disabled Audits:*');
    });

    it('formats audit status correctly with only disabled audits', () => {
      const enabledAudits = [];
      const disabledAudits = [
        { auditType: 'lhs-desktop', isEnabled: false },
        { auditType: '404', isEnabled: false },
      ];

      const formatted = formatAuditStatus(enabledAudits, disabledAudits);

      expect(formatted).to.include('*Disabled Audits:* ❌');
      expect(formatted).to.include('• lhs-desktop');
      expect(formatted).to.include('• 404');
      expect(formatted).to.not.include('*Enabled Audits:*');
    });

    it('handles empty audit arrays', () => {
      const enabledAudits = [];
      const disabledAudits = [];

      const formatted = formatAuditStatus(enabledAudits, disabledAudits);

      expect(formatted).to.equal('');
    });

    it('correctly separates enabled and disabled audits for formatting', () => {
      const enabledAudits = [
        { auditType: 'lhs-mobile', isEnabled: true },
        { auditType: 'cwv', isEnabled: true },
      ];
      const disabledAudits = [
        { auditType: 'lhs-desktop', isEnabled: false },
      ];

      const formatted = formatAuditStatus(enabledAudits, disabledAudits);

      // Verify structure: enabled section first, then disabled section
      const enabledIndex = formatted.indexOf('*Enabled Audits:*');
      const disabledIndex = formatted.indexOf('*Disabled Audits:*');

      expect(enabledIndex).to.be.greaterThan(-1);
      expect(disabledIndex).to.be.greaterThan(-1);
      expect(enabledIndex).to.be.lessThan(disabledIndex);
    });
  });
});
