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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import nock from 'nock';
import esmock from 'esmock';

use(sinonChai);

// Mock TierClient at the top level. The object identity has to stay stable —
// esmock injects this very reference into the module under test in the before()
// hook below — so only the fake on it is replaced, fresh in each beforeEach.
const mockTierClient = {};

// Import RunAuditCommand with mocked TierClient
let RunAuditCommand;

before(async () => {
  RunAuditCommand = await esmock('../../../../src/support/slack/commands/run-audit.js', {
    '@adobe/spacecat-shared-tier-client': { default: mockTierClient },
  });
});

describe('RunAuditCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;

  // Helper function to create default configuration mock
  const createDefaultConfigurationMock = (auditTypes = ['lhs-mobile'], productCodes = ['LLMO'], overrides = {}) => {
    const types = Array.isArray(auditTypes) ? auditTypes : [auditTypes];
    const handlers = {};
    types.forEach((type) => {
      handlers[type] = { productCodes, ...overrides };
    });
    return {
      isHandlerEnabledForSite: () => true,
      isHandlerDisabledForSite: () => false,
      getHandlers: () => handlers,
    };
  };

  beforeEach(() => {
    dataAccessStub = {
      Configuration: { findLatest: sinon.stub() },
      Site: { findByBaseURL: sinon.stub() },
      Opportunity: { allBySiteId: sinon.stub().resolves([]) },
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    context = {
      dataAccess: dataAccessStub,
      log: {
        info: sinon.spy(),
        error: sinon.spy(),
        warn: sinon.spy(),
      },
      sqs: sqsStub,
      env: { AUDIT_JOBS_QUEUE_URL: 'testQueueUrl' },
    };
    slackContext = { say: sinon.spy() };

    // Default behaviour for the TierClient mock.
    // The Slack run-audit handler checks `siteEnrollment` (matching the audit-worker's
    // downstream gate); `entitlement` is intentionally not consulted.
    mockTierClient.createForSite = sinon.stub().resolves({
      checkValidEntitlement: sinon.stub().resolves({ siteEnrollment: { id: 'enr-123' } }),
    });
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = RunAuditCommand(context);
      expect(command.id).to.equal('run-audit');
      expect(command.name).to.equal('Run Audit');
      expect(command.description).to.equal('Run audit for a previously added site. Supports both positional and keyword arguments. Runs lhs-mobile by default if no audit type is specified. Use `audit:all` to run all audits. For prerender: `mode:all` runs full audit for NEW/FIXED suggestions; `mode:ai-only` runs AI-only for NEW/FIXED; `mode:ai-only-current` runs AI-only for current-tab suggestions only (NEW, not covered/deployed); `mode:ai-only-missing` runs AI-only for NEW/FIXED suggestions missing an AI summary.');
    });
  });

  describe('Handle Execution Method', () => {
    it('triggers an audit for a valid site', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('lhs-mobile', ['LLMO']));
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering lhs-mobile audit for https://validsite.com');
      expect(sqsStub.sendMessage).called;
    });

    it('triggers an audit even when audit type is disabled for site (enablement checked upstream)', async () => {
      const site = {
        getId: () => '123',
      };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('lhs-mobile', ['LLMO']));
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering lhs-mobile audit for https://validsite.com');
      expect(sqsStub.sendMessage.called).to.be.true;
    });

    it('responds with a warning for an invalid site url', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['invalid-url'], slackContext);

      expect(slackContext.say.calledWith(command.usage())).to.be.true;
    });

    it('informs user if the site was not added previously', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);
      const command = RunAuditCommand(context);

      await command.handleExecution(['unknownsite.com'], slackContext);

      expect(slackContext.say.calledWith(':x: No site found with base URL \'https://unknownsite.com\'.')).to.be.true;
    });

    it('informs user when error occurs', async () => {
      dataAccessStub.Site.findByBaseURL.rejects(new Error('Test Error'));
      const command = RunAuditCommand(context);

      await command.handleExecution(['some-site.com'], slackContext);

      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: Test Error')).to.be.true;
    });

    it('trigger all audits for a valid site', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('lhs-mobile', ['LLMO']));

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'all'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(':adobe-run: Triggering all audit for https://validsite.com');
      expect(sqsStub.sendMessage).called;
    });

    it('triggers all audits for all sites specified in a CSV file', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('lhs-mobile', ['LLMO']));
      const fileUrl = 'https://example.com/sites.csv';
      slackContext.files = [
        {
          name: 'sites.csv',
          url_private: fileUrl,
        },
      ];
      nock(fileUrl)
        .get('')
        .reply(200, 'https://site.com,uuidv4\n'
          + 'https://valid.url,uuidv4');

      const command = RunAuditCommand(context);
      await command.handleExecution(['all'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(':adobe-run: Triggering all audit for 2 sites.');
      expect(sqsStub.sendMessage).called;
    });

    it('handles both site URL and CSV file', async () => {
      const command = RunAuditCommand(context);
      slackContext.files = [
        {
          name: 'sites.csv',
          url_private: 'https://example.com/sites.csv',
        },
      ];
      await command.handleExecution(['site.com'], slackContext);
      expect(slackContext.say.calledWith(':warning: Please provide either a baseURL or a CSV file with a list of site URLs.')).to.be.true;
    });

    it('allows prerender audits for a site with an attached CSV of page URLs', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('prerender', ['LLMO']));
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, 'https://valid.site/page-1\nhttps://valid.site/page-2\ninvalid-url');

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.equal(':adobe-run: Triggering prerender audit for site https://site.com with 2 URLs.');
      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.include({
        type: 'prerender',
        siteId: '123',
      });
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext).to.deep.equal({
        slackContext: {
          channelId: undefined,
          threadTs: undefined,
        },
        urls: [
          'https://valid.site/page-1',
          'https://valid.site/page-2',
        ],
      });
      expect(slackContext.say.secondCall.args[0]).to.equal(':white_check_mark: prerender audit queued for 2 URLs.');
    });

    it('sends a single SQS message for large prerender CSV', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('prerender', ['LLMO']));
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      // Generate 500 valid URLs — all sent in a single message (no batching)
      const urls = Array.from({ length: 500 }, (_, i) => `https://valid.site/page-${i + 1}`);
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, urls.join('\n'));

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext.urls).to.have.length(500);
      expect(slackContext.say.secondCall.args[0]).to.equal(':white_check_mark: prerender audit queued for 500 URLs.');
    });

    it('warns when a prerender CSV has no valid URLs', async () => {
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, 'invalid-url');

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(slackContext.say.calledWith(':warning: No valid URLs found in the CSV file.')).to.be.true;
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('requires exactly one CSV file for prerender CSV audits', async () => {
      slackContext.files = [
        {
          name: 'urls1.csv',
          url_private: 'https://example.com/urls1.csv',
        },
        {
          name: 'urls2.csv',
          url_private: 'https://example.com/urls2.csv',
        },
      ];

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide only one CSV file.')).to.be.true;
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('requires a CSV file type for prerender CSV audits', async () => {
      slackContext.files = [
        {
          name: 'urls.txt',
          url_private: 'https://example.com/urls.txt',
        },
      ];

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a CSV file.')).to.be.true;
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('shows site-not-found for prerender CSV audits when the site does not exist', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('prerender', ['LLMO']));
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, 'https://valid.site/page-1');

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.equal(':adobe-run: Triggering prerender audit for site https://site.com with 1 URLs.');
      expect(slackContext.say.secondCall.args[0]).to.equal(':x: No site found with base URL \'https://site.com\'.');
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('blocks prerender CSV audits when the prerender handler is explicitly disabled for the site', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => '123' });
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: sinon.stub().returns(true),
        isHandlerDisabledForSite: sinon.stub().returns(true),
        getHandlers: sinon.stub().returns({ prerender: { productCodes: ['LLMO'] } }),
      });
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, 'https://valid.site/page-1');

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(sqsStub.sendMessage.called).to.be.false;
      expect(slackContext.say.secondCall.args[0]).to.equal(':x: Audit `prerender` is explicitly disabled for site `https://site.com`. Re-enable it via the audit configuration before running on-demand.');
    });

    it('blocks prerender CSV audits when no product codes are configured', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => '123' });
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: sinon.stub().returns(true),
        getHandlers: sinon.stub().returns({ prerender: {} }),
      });
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, 'https://valid.site/page-1');

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(slackContext.say.secondCall.args[0]).to.equal(':x: Will not audit site \'https://site.com\' because no product codes are configured for audit type \'prerender\'.');
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('blocks prerender CSV audits when no entitlement is found for any product code', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => '123' });
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('prerender', ['LLMO', 'AEM']));
      mockTierClient.createForSite.resolves({
        checkValidEntitlement: sinon.stub().resolves({ siteEnrollment: null }),
      });
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, 'https://valid.site/page-1');

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(slackContext.say.secondCall.args[0]).to.equal(':x: Will not audit site \'https://site.com\' because site is not entitled for this audit.');
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('continues prerender CSV entitlement checks when one product check throws but another succeeds', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('prerender', ['LLMO', 'AEM']));
      mockTierClient.createForSite
        .onFirstCall()
        .rejects(new Error('tier down'))
        .onSecondCall()
        .resolves({
          checkValidEntitlement: sinon.stub().resolves({ siteEnrollment: { id: 'enr-123' } }),
        });
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, 'https://valid.site/page-1');

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(context.log.error).to.have.been.calledWithMatch('Failed to check entitlement for product code LLMO:');
      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      expect(slackContext.say.secondCall.args[0]).to.equal(':white_check_mark: prerender audit queued for 1 URLs.');
    });

    it('posts an error when prerender CSV audit setup throws after CSV parsing', async () => {
      dataAccessStub.Site.findByBaseURL.rejects(new Error('config exploded'));
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, 'https://valid.site/page-1');

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(slackContext.say.secondCall.args[0]).to.equal(':nuclear-warning: Oops! Something went wrong: config exploded');
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('handles multiple CSV files', async () => {
      const command = RunAuditCommand(context);
      slackContext.files = [
        {
          name: 'sites1.csv',
          url_private: 'https://example.com/sites1.csv',
        },
        {
          name: 'sites2.csv',
          url_private: 'https://example.com/sites2.csv',
        },
      ];
      await command.handleExecution(['', 'all'], slackContext);
      expect(slackContext.say.calledWith(':warning: Please provide only one CSV file.')).to.be.true;
    });

    it('handles non-CSV file', async () => {
      const command = RunAuditCommand(context);
      slackContext.files = [
        {
          name: 'sites.txt',
          url_private: 'https://example.com/sites.txt',
        },
      ];
      await command.handleExecution(['', 'all'], slackContext);
      expect(slackContext.say.calledWith(':warning: Please provide a CSV file.')).to.be.true;
    });

    it('handles CSV file with no data', async () => {
      const command = RunAuditCommand(context);
      slackContext.files = [
        {
          name: 'sites.csv',
          url_private: 'https://example.com/sites.csv',
        },
      ];
      nock('https://example.com')
        .get('/sites.csv')
        .reply(200, 'invalid-url,uuidv4\n');

      await command.handleExecution(['', 'all'], slackContext);
      expect(slackContext.say.calledWith(':warning: Invalid URL found in CSV file: invalid-url')).to.be.true;
    });

    it('triggers all audits from list for site without filtering by enablement', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('lhs-mobile', ['LLMO']));

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'all'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(':adobe-run: Triggering all audit for https://validsite.com');
      expect(sqsStub.sendMessage.called).to.be.true;
    });

    it('handles error while triggering audits', async () => {
      const errorMessage = 'Failed to trigger';
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('lhs-mobile', ['LLMO']));
      sqsStub.sendMessage.rejects(new Error(errorMessage));

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'all'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(':adobe-run: Triggering all audit for https://validsite.com');
      expect(slackContext.say.secondCall.args[0]).to.equal(`:nuclear-warning: Oops! Something went wrong: ${errorMessage}`);
    });

    it('handles error when site cannot be found', async () => {
      const errorMessage = 'Invalid site URL';
      dataAccessStub.Site.findByBaseURL.rejects(new Error(errorMessage));
      const command = RunAuditCommand(context);
      await command.handleExecution(['invalidsite.com', 'all'], slackContext);
      expect(slackContext.say.calledWith(`:nuclear-warning: Oops! Something went wrong: ${errorMessage}`)).to.be.true;
    });

    it('handles error when obtaining CSV failed', async () => {
      const command = RunAuditCommand(context);
      slackContext.files = [
        {
          name: 'sites.csv',
          url_private: 'https://example.com/sites.csv',
        },
      ];
      nock('https://example.com')
        .get('/sites.csv')
        .reply(401, 'Unauthorized');

      await command.handleExecution(['', 'all'], slackContext);
      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: CSV processing failed: Authentication failed: Invalid Slack token.')).to.be.true;
    });
  });
  describe('Keyword Arguments Support', () => {
    beforeEach(() => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'siteId' });
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock(['geo-brand-presence', 'lhs-mobile', 'cwv'], ['LLMO']));
    });

    it('handles keyword format with audit type', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com', 'audit:geo-brand-presence'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering geo-brand-presence audit for https://validsite.com');
      expect(sqsStub.sendMessage).called;
    });

    it('handles keyword format with audit type and additional parameters', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com', 'audit:geo-brand-presence', 'date-start:2025-09-07', 'source:google-ai-overviews'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering geo-brand-presence audit for https://validsite.com');
      expect(sqsStub.sendMessage).called;

      // Verify the audit data contains the additional parameters
      const sendMessageCall = sqsStub.sendMessage.firstCall;
      const auditData = sendMessageCall.args[1].data;
      const parsedData = JSON.parse(auditData);
      expect(parsedData).to.deep.include({
        'date-start': '2025-09-07',
        source: 'google-ai-overviews',
      });
    });

    it('forwards mode in audit data for non-prerender audit types (e.g. toc\'s mode:ai-only, LLMO-6167)', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com', 'audit:geo-brand-presence', 'generatePrompts:true', 'mode:ai-only'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(sqsStub.sendMessage).called;

      const sendMessageCall = sqsStub.sendMessage.firstCall;
      const parsedData = JSON.parse(sendMessageCall.args[1].data);
      expect(parsedData).to.deep.include({
        generatePrompts: 'true',
        mode: 'ai-only',
      });
    });

    it('handles keyword format with spaces after colon', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com', 'audit: geo-brand-presence', 'date-start: 2025-09-07', 'source: google-ai-overviews'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering geo-brand-presence audit for https://validsite.com');
      expect(sqsStub.sendMessage).called;

      // Verify the audit data contains the additional parameters (values should be trimmed)
      const sendMessageCall = sqsStub.sendMessage.firstCall;
      const auditData = sendMessageCall.args[1].data;
      const parsedData = JSON.parse(auditData);
      expect(parsedData).to.deep.include({
        'date-start': '2025-09-07',
        source: 'google-ai-overviews',
      });
    });

    it('handles keyword format with all audit type', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com', 'audit:all'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering all audit for https://validsite.com');
      expect(sqsStub.sendMessage).called;
    });

    it('falls back to positional format when no keywords are provided', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com', 'geo-brand-presence'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering geo-brand-presence audit for https://validsite.com');
      expect(sqsStub.sendMessage).called;
    });

    it('uses default audit type when no audit keyword is provided', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com', 'date-start:2025-09-07'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering lhs-mobile audit for https://validsite.com');
      expect(sqsStub.sendMessage).called;

      // Verify the audit data contains the parameters
      const sendMessageCall = sqsStub.sendMessage.firstCall;
      const auditData = sendMessageCall.args[1].data;
      const parsedData = JSON.parse(auditData);
      expect(parsedData).to.deep.include({
        'date-start': '2025-09-07',
      });
    });

    it('handles Slack-formatted URLs correctly with keyword arguments', async () => {
      const command = RunAuditCommand(context);

      // Simulate the exact scenario from the bug report
      await command.handleExecution(['<http://adobe.com|adobe.com>', 'audit:geo-brand-presence', 'endDate:2025-09-07', 'aiPlatform:google-ai-overviews'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering geo-brand-presence audit for https://adobe.com');
      expect(sqsStub.sendMessage).called;

      // Verify the audit data contains the additional parameters
      const sendMessageCall = sqsStub.sendMessage.firstCall;
      const auditData = sendMessageCall.args[1].data;
      const parsedData = JSON.parse(auditData);
      expect(parsedData).to.deep.include({
        endDate: '2025-09-07',
        aiPlatform: 'google-ai-overviews',
      });
    });

    it('handles Slack-formatted HTTPS URLs correctly', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['<https://example.com|example.com>', 'audit:cwv'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering cwv audit for https://example.com');
      expect(sqsStub.sendMessage).called;
    });

    it('handles keyword arguments with multiple colons in value', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com', 'audit:geo-brand-presence', 'url:https://example.com:8080/path'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering geo-brand-presence audit for https://validsite.com');
      expect(sqsStub.sendMessage).called;

      // Verify the audit data contains the URL with colons correctly parsed
      const sendMessageCall = sqsStub.sendMessage.firstCall;
      const auditData = sendMessageCall.args[1].data;
      const parsedData = JSON.parse(auditData);
      expect(parsedData).to.deep.include({
        url: 'https://example.com:8080/path',
      });
    });

    it('handles keyword arguments with empty values after colon', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com', 'audit:geo-brand-presence', 'source:', 'date-start:2025-09-07'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering geo-brand-presence audit for https://validsite.com');
      expect(sqsStub.sendMessage).called;

      // Verify the audit data contains the empty value and other values correctly
      const sendMessageCall = sqsStub.sendMessage.firstCall;
      const auditData = sendMessageCall.args[1].data;
      const parsedData = JSON.parse(auditData);
      expect(parsedData).to.deep.include({
        source: '',
        'date-start': '2025-09-07',
      });
    });

    it('handles keyword format without audit keyword but with other keywords', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com', 'date-start:2025-09-07', 'source:test-source'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering lhs-mobile audit for https://validsite.com');
      expect(sqsStub.sendMessage).called;

      // Verify the audit data contains the keywords (should use default audit type)
      const sendMessageCall = sqsStub.sendMessage.firstCall;
      const auditData = sendMessageCall.args[1].data;
      const parsedData = JSON.parse(auditData);
      expect(parsedData).to.deep.include({
        'date-start': '2025-09-07',
        source: 'test-source',
      });
    });
  });

  describe('Prerender Modes', () => {
    beforeEach(() => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'siteId' });
      dataAccessStub.Configuration.findLatest.resolves(
        createDefaultConfigurationMock('prerender', ['LLMO']),
      );
    });

    it('mode:all passes mode in data field without fetching suggestions', async () => {
      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:all'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.include({ type: 'prerender' });
      const msgData = JSON.parse(sqsStub.sendMessage.firstCall.args[1].data);
      expect(msgData.mode).to.equal('all');
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext.urls).to.be.undefined;
      expect(dataAccessStub.Opportunity.allBySiteId).to.not.have.been.called;
    });

    it('mode:ai-only passes mode in data field without sending URLs', async () => {
      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:ai-only'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      const msgData = JSON.parse(sqsStub.sendMessage.firstCall.args[1].data);
      expect(msgData.mode).to.equal('ai-only');
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext.urls).to.be.undefined;
      expect(dataAccessStub.Opportunity.allBySiteId).to.not.have.been.called;
    });

    it('mode:ai-only-current passes mode:ai-only-current in data field without sending URLs', async () => {
      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:ai-only-current'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      const msgData = JSON.parse(sqsStub.sendMessage.firstCall.args[1].data);
      expect(msgData.mode).to.equal('ai-only-current');
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext.urls).to.be.undefined;
      expect(dataAccessStub.Opportunity.allBySiteId).to.not.have.been.called;
    });

    it('mode:ai-only-missing passes mode:ai-only-missing in data field without sending URLs', async () => {
      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:ai-only-missing'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      const msgData = JSON.parse(sqsStub.sendMessage.firstCall.args[1].data);
      expect(msgData.mode).to.equal('ai-only-missing');
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext.urls).to.be.undefined;
      expect(dataAccessStub.Opportunity.allBySiteId).to.not.have.been.called;
    });

    it('shows site-not-found for suggestion-based mode when site does not exist', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const command = RunAuditCommand(context);
      await command.handleExecution(['unknownsite.com', 'audit:prerender', 'mode:all'], slackContext);

      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(':x: No site found with base URL \'https://unknownsite.com\'.');
    });

    it('merges mode into data field alongside other keyword args', async () => {
      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:ai-only', 'source:test'], slackContext);

      const msgData = JSON.parse(sqsStub.sendMessage.firstCall.args[1].data);
      expect(msgData.mode).to.equal('ai-only');
      expect(msgData.source).to.equal('test');
    });

    it('mode:ai-only-missing merges mode into data field alongside other keyword args', async () => {
      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:ai-only-missing', 'source:test'], slackContext);

      const msgData = JSON.parse(sqsStub.sendMessage.firstCall.args[1].data);
      expect(msgData.mode).to.equal('ai-only-missing');
      expect(msgData.source).to.equal('test');
    });

    it('runs normal prerender when no mode is provided', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com', 'audit:prerender'], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering prerender audit for https://validsite.com');
      expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.include({ type: 'prerender' });
    });

    it('CSV with mode:ai-only passes mode in data field', async () => {
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, 'https://valid.site/page-1\nhttps://valid.site/page-2');

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:ai-only'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.include({ type: 'prerender' });
      const msgData = JSON.parse(sqsStub.sendMessage.firstCall.args[1].data);
      expect(msgData.mode).to.equal('ai-only');
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext.mode).to.be.undefined;
    });

    it('CSV without mode does not include mode in data', async () => {
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, 'https://valid.site/page-1');

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      expect(sqsStub.sendMessage.firstCall.args[1].data).to.be.undefined;
    });
  });

  describe('Entitlement Checks', () => {
    it('should block audit when handler has no product codes configured', async () => {
      const site = { getId: () => '123' };

      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        getHandlers: () => ({ 'lhs-mobile': { productCodes: [] } }),
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(':x: Will not audit site \'https://validsite.com\' because no product codes are configured for audit type \'lhs-mobile\'.');
    });

    it('should block audit when handler has undefined product codes', async () => {
      const site = { getId: () => '123' };

      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        getHandlers: () => ({ 'lhs-mobile': {} }),
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(':x: Will not audit site \'https://validsite.com\' because no product codes are configured for audit type \'lhs-mobile\'.');
    });

    it('should allow audit when site has valid entitlement', async () => {
      const site = { getId: () => '123' };
      const handler = {
        productCodes: ['LLMO'],
      };

      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        isHandlerDisabledForSite: () => false,
        getHandlers: () => ({ 'lhs-mobile': handler }),
      });

      const mockTierClientInstance = {
        checkValidEntitlement: sinon.stub().resolves({
          siteEnrollment: { id: 'enr-123' },
        }),
      };
      mockTierClient.createForSite.resolves(mockTierClientInstance);

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(mockTierClient.createForSite).to.have.been.calledWith(context, site, 'LLMO');
      expect(mockTierClientInstance.checkValidEntitlement).to.have.been.called;
      expect(sqsStub.sendMessage).to.have.been.called;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering lhs-mobile audit');
    });

    it('should block audit when site has no site enrollment', async () => {
      const site = { getId: () => '123' };
      const handler = {
        productCodes: ['LLMO'],
      };

      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        isHandlerDisabledForSite: () => false,
        getHandlers: () => ({ 'lhs-mobile': handler }),
      });

      const mockTierClientInstance = {
        checkValidEntitlement: sinon.stub().resolves({
          siteEnrollment: null,
        }),
      };
      mockTierClient.createForSite.resolves(mockTierClientInstance);

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(mockTierClient.createForSite).to.have.been.calledWith(context, site, 'LLMO');
      expect(mockTierClientInstance.checkValidEntitlement).to.have.been.called;
      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(':x: Will not audit site \'https://validsite.com\' because site is not entitled for this audit.');
    });

    it('should block audit when org has entitlement but site has no site enrollment', async () => {
      // Regression: parity with audit-worker. Org-level `entitlement` is not enough;
      // the site must have explicit `siteEnrollment`.
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        getHandlers: () => ({ 'lhs-mobile': { productCodes: ['LLMO'] } }),
      });

      mockTierClient.createForSite.resolves({
        checkValidEntitlement: sinon.stub().resolves({
          entitlement: { id: 'ent-123' },
          siteEnrollment: null,
        }),
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(':x: Will not audit site \'https://validsite.com\' because site is not entitled for this audit.');
    });

    it('should allow audit when site has enrollment for any product code', async () => {
      const site = { getId: () => '123' };
      const handler = {
        productCodes: ['LLMO', 'ASO'],
      };

      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        isHandlerDisabledForSite: () => false,
        getHandlers: () => ({ 'lhs-mobile': handler }),
      });

      const mockTierClientInstance1 = {
        checkValidEntitlement: sinon.stub().resolves({ siteEnrollment: null }),
      };
      const mockTierClientInstance2 = {
        checkValidEntitlement: sinon.stub().resolves({ siteEnrollment: { id: 'enr-456' } }),
      };

      mockTierClient.createForSite
        .onFirstCall().resolves(mockTierClientInstance1)
        .onSecondCall().resolves(mockTierClientInstance2);

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(mockTierClient.createForSite).to.have.been.calledTwice;
      expect(mockTierClient.createForSite.firstCall).to.have.been.calledWith(context, site, 'LLMO');
      expect(mockTierClient.createForSite.secondCall).to.have.been.calledWith(context, site, 'ASO');
      expect(sqsStub.sendMessage).to.have.been.called;
    });

    it('should handle TierClient errors gracefully and continue checking other product codes', async () => {
      const site = { getId: () => '123' };
      const handler = {
        productCodes: ['LLMO', 'ASO'],
      };

      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        isHandlerDisabledForSite: () => false,
        getHandlers: () => ({ 'lhs-mobile': handler }),
      });

      const mockTierClientInstance2 = {
        checkValidEntitlement: sinon.stub().resolves({ siteEnrollment: { id: 'enr-456' } }),
      };

      mockTierClient.createForSite
        .onFirstCall().rejects(new Error('TierClient error'))
        .onSecondCall().resolves(mockTierClientInstance2);

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(mockTierClient.createForSite).to.have.been.calledTwice;
      expect(sqsStub.sendMessage).to.have.been.called;
      expect(context.log.error).to.have.been.calledWith(
        sinon.match(/Failed to check entitlement for product code LLMO/),
        sinon.match.instanceOf(Error),
      );
    });

    it('should block audit when all entitlement checks fail', async () => {
      const site = { getId: () => '123' };
      const handler = {
        productCodes: ['LLMO', 'ASO'],
      };

      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        isHandlerDisabledForSite: () => false,
        getHandlers: () => ({ 'lhs-mobile': handler }),
      });

      const mockTierClientInstance1 = {
        checkValidEntitlement: sinon.stub().resolves({ siteEnrollment: null }),
      };
      const mockTierClientInstance2 = {
        checkValidEntitlement: sinon.stub().resolves({ siteEnrollment: false }),
      };

      mockTierClient.createForSite
        .onFirstCall().resolves(mockTierClientInstance1)
        .onSecondCall().resolves(mockTierClientInstance2);

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(mockTierClient.createForSite).to.have.been.calledTwice;
      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(':x: Will not audit site \'https://validsite.com\' because site is not entitled for this audit.');
    });

    it('does not pass onDemand in the SQS auditContext for single-audit runs', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('lhs-mobile', ['LLMO']));

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.called;
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext).to.not.have.property('onDemand');
    });

    it('blocks a single audit when the handler is explicitly disabled for the site', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        isHandlerDisabledForSite: () => true,
        getHandlers: () => ({ 'lhs-mobile': { productCodes: ['LLMO'] } }),
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(':x: Audit `lhs-mobile` is explicitly disabled for site `https://validsite.com`. Re-enable it via the audit configuration before running on-demand.');
    });

    it('audit:all skips audit types explicitly disabled for the site but queues the rest', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        isHandlerDisabledForSite: (auditType) => auditType === 'cwv',
        getHandlers: () => ({}),
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'all'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.called;
      const queuedTypes = sqsStub.sendMessage.getCalls().map((call) => call.args[1].type);
      expect(queuedTypes).to.not.include('cwv');
      expect(queuedTypes.length).to.be.greaterThan(0);
    });

    it('triggers a single audit even when the site is not in the handler enabled-list (no enabled-list gate)', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => false,
        isHandlerDisabledForSite: () => false,
        getHandlers: () => ({ 'lhs-mobile': { productCodes: ['LLMO'] } }),
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.called;
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext).to.not.have.property('onDemand');
    });

    it('should handle checkValidEntitlement errors gracefully', async () => {
      const site = { getId: () => '123' };
      const handler = {
        productCodes: ['LLMO'],
      };

      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        isHandlerDisabledForSite: () => false,
        getHandlers: () => ({ 'lhs-mobile': handler }),
      });

      // Mock TierClient to throw error on checkValidEntitlement
      const mockTierClientInstance = {
        checkValidEntitlement: sinon.stub().rejects(new Error('Entitlement check failed')),
      };
      mockTierClient.createForSite.resolves(mockTierClientInstance);

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(mockTierClientInstance.checkValidEntitlement).to.have.been.called;
      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(context.log.error).to.have.been.calledWith(
        sinon.match(/Failed to check entitlement for product code LLMO/),
        sinon.match.instanceOf(Error),
      );
    });
  });

  describe('Offsite structured logging (LLMO-6973)', () => {
    const OFFSITE_AUDIT_TYPES = [
      'offsite-brand-presence',
      'cited-analysis',
      'reddit-analysis',
      'youtube-analysis',
      'wikipedia-analysis',
    ];

    // Mirrors the mapping in run-audit.js (and spacecat-audit-worker's own AUDIT enum) —
    // used here to prove the log lines carry the correct short taxonomy value per type,
    // not a hardcoded/single value.
    const OFFSITE_AUDIT_LOG_TYPE = {
      'offsite-brand-presence': 'brand-presence',
      'cited-analysis': 'cited',
      'reddit-analysis': 'reddit',
      'youtube-analysis': 'youtube',
      'wikipedia-analysis': 'wikipedia',
    };

    it('emits a structured audit_orchestration_start line for each offsite audit type', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => '123' });

      for (const auditType of OFFSITE_AUDIT_TYPES) {
        context.log.info.resetHistory();
        dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock(auditType, ['LLMO']));

        const command = RunAuditCommand(context);
        // eslint-disable-next-line no-await-in-loop
        await command.handleExecution(['validsite.com', `audit:${auditType}`], slackContext);

        expect(context.log.info).to.have.been.calledWith(
          sinon.match(`domain=offsite audit=${OFFSITE_AUDIT_LOG_TYPE[auditType]} event=audit_orchestration_start outcome=start auditType=${auditType} baseURL=validsite.com`),
        );
      }
    });

    it('puts domain and audit before event/outcome on the start line, for two distinct offsite types', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => '123' });

      for (const [auditType, expectedAudit] of [['cited-analysis', 'cited'], ['wikipedia-analysis', 'wikipedia']]) {
        context.log.info.resetHistory();
        dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock(auditType, ['LLMO']));

        const command = RunAuditCommand(context);
        // eslint-disable-next-line no-await-in-loop
        await command.handleExecution(['validsite.com', `audit:${auditType}`], slackContext);

        const call = context.log.info.getCalls().find(
          (c) => c.args[0].includes('event=audit_orchestration_start'),
        );
        expect(call, `no audit_orchestration_start line logged for ${auditType}`).to.not.be.undefined;
        expect(call.args[0]).to.match(
          new RegExp(`domain=offsite audit=${expectedAudit} event=audit_orchestration_start outcome=start`),
        );
      }
    });

    it('does not add structured fields to the start log line for a non-offsite audit type', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => '123' });
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('lhs-mobile', ['LLMO']));

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(context.log.info).to.have.been.calledWith(
        'run-audit: baseURL="validsite.com", auditType="undefined", auditData="undefined"',
      );
      expect(context.log.info).to.not.have.been.calledWithMatch(/event=audit_orchestration_start/);
    });

    it('logs a structured, alertable error when the site is not found for an offsite audit type', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const command = RunAuditCommand(context);
      await command.handleExecution(['unknownsite.com', 'audit:cited-analysis'], slackContext);

      expect(context.log.error).to.have.been.calledWith(
        'No site found with base URL domain=offsite audit=cited event=audit_orchestration_start outcome=failure reason=site_not_found',
      );
      expect(slackContext.say).to.have.been.calledWith(":x: No site found with base URL 'https://unknownsite.com'.");
    });

    it('maps the audit= field correctly for a second offsite audit type on the site-not-found line', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const command = RunAuditCommand(context);
      await command.handleExecution(['unknownsite.com', 'audit:wikipedia-analysis'], slackContext);

      expect(context.log.error).to.have.been.calledWith(
        'No site found with base URL domain=offsite audit=wikipedia event=audit_orchestration_start outcome=failure reason=site_not_found',
      );
    });

    it('does not log an error when the site is not found for a non-offsite audit type', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const command = RunAuditCommand(context);
      await command.handleExecution(['unknownsite.com'], slackContext);

      expect(context.log.error).to.not.have.been.called;
    });

    it('logs a structured error when an offsite audit type is not entitled', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('cited-analysis', ['LLMO']));
      mockTierClient.createForSite.resolves({
        checkValidEntitlement: sinon.stub().resolves({ siteEnrollment: null }),
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'audit:cited-analysis'], slackContext);

      expect(context.log.error).to.have.been.calledWith(
        'Site not entitled for this audit type domain=offsite audit=cited event=audit_orchestration_start outcome=failure siteId=123 reason=not_entitled',
      );
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('does not log a not-entitled structured error for a non-offsite audit type', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => '123' });
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('lhs-mobile', ['LLMO']));
      mockTierClient.createForSite.resolves({
        checkValidEntitlement: sinon.stub().resolves({ siteEnrollment: null }),
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(context.log.error).to.not.have.been.calledWithMatch(/reason=not_entitled/);
    });

    it('logs a structured error when the handler is disabled for an offsite audit type', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        isHandlerDisabledForSite: () => true,
        getHandlers: () => ({ 'reddit-analysis': { productCodes: ['LLMO'] } }),
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'audit:reddit-analysis'], slackContext);

      expect(context.log.error).to.have.been.calledWith(
        'Handler disabled for this site domain=offsite audit=reddit event=audit_orchestration_start outcome=failure siteId=123 reason=handler_disabled',
      );
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('does not log a handler-disabled structured error for a non-offsite audit type', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        isHandlerDisabledForSite: () => true,
        getHandlers: () => ({ 'lhs-mobile': { productCodes: ['LLMO'] } }),
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(context.log.error).to.not.have.been.calledWithMatch(/reason=handler_disabled/);
    });

    it('logs a structured success line on successful dispatch for offsite-brand-presence (matching jobs-dispatcher wording)', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('offsite-brand-presence', ['LLMO']));

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'audit:offsite-brand-presence'], slackContext);

      expect(context.log.info).to.have.been.calledWith(
        'Queued offsite-brand-presence for site domain=offsite audit=brand-presence event=audit_orchestration_spacecat_request_dispatched outcome=success peer=spacecat-audit-worker direction=outbound siteId=123',
      );
    });

    it('logs a structured success line on successful dispatch for the other offsite audit types', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);

      for (const auditType of ['cited-analysis', 'reddit-analysis', 'youtube-analysis', 'wikipedia-analysis']) {
        context.log.info.resetHistory();
        dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock(auditType, ['LLMO']));

        const command = RunAuditCommand(context);
        // eslint-disable-next-line no-await-in-loop
        await command.handleExecution(['validsite.com', `audit:${auditType}`], slackContext);

        expect(context.log.info).to.have.been.calledWith(
          `Queued offsite analysis for site domain=offsite audit=${OFFSITE_AUDIT_LOG_TYPE[auditType]} event=audit_orchestration_spacecat_request_dispatched outcome=success peer=spacecat-audit-worker direction=outbound siteId=123`,
        );
      }
    });

    it('follows the canonical domain, audit, event, outcome, peer, direction, siteId field order on the dispatched-success line', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('reddit-analysis', ['LLMO']));

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'audit:reddit-analysis'], slackContext);

      expect(context.log.info).to.have.been.calledWith(
        sinon.match(/domain=offsite audit=reddit event=audit_orchestration_spacecat_request_dispatched outcome=success peer=spacecat-audit-worker direction=outbound siteId=123/),
      );
    });

    it('logs a single structured failure line and replies, without re-throwing into the generic outer catch, when the SQS send fails for an offsite audit type', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('youtube-analysis', ['LLMO']));
      const sendError = new Error('SQS unavailable');
      sendError.name = 'SqsError';
      sqsStub.sendMessage.rejects(sendError);

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'audit:youtube-analysis'], slackContext);

      expect(context.log.error).to.have.been.calledWith(
        'Failed to queue offsite analysis for site domain=offsite audit=youtube event=audit_orchestration_spacecat_request_dispatched outcome=failure peer=spacecat-audit-worker direction=outbound siteId=123 reason=sqs_send_failed errorName=SqsError errorMessage="SQS unavailable"',
      );
      // The offsite dispatch failure is not re-thrown, so the generic outer catch's
      // unstructured "Error running audit..." line must not also fire for the same failure
      // (catch-log-throw would otherwise double-count this as two ERROR lines).
      expect(context.log.error).to.not.have.been.calledWith(
        sinon.match(/Error running audit youtube-analysis for site/),
      );
      expect(context.log.error).to.have.been.calledOnce;
      expect(slackContext.say).to.have.been.calledWith(':nuclear-warning: Oops! Something went wrong: SQS unavailable');
    });

    it('sanitizes and quotes an error field whose value contains whitespace, "=", or a double quote', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('cited-analysis', ['LLMO']));
      const sendError = new Error('bad response: status=500 body="oops"');
      sendError.name = 'SqsError';
      sqsStub.sendMessage.rejects(sendError);

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'audit:cited-analysis'], slackContext);

      expect(context.log.error).to.have.been.calledWith(
        sinon.match(/errorMessage="bad response: status=500 body='oops'"/),
      );
    });

    it('stamps origin: api-service into the dispatched auditContext for an offsite audit type', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('wikipedia-analysis', ['LLMO']));

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'audit:wikipedia-analysis'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext).to.include({ origin: 'api-service' });
    });

    it('does NOT stamp origin into the dispatched auditContext for a non-offsite audit type (message payload unchanged)', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('lhs-mobile', ['LLMO']));

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext).to.not.have.property('origin');
      // Byte-for-byte: the message payload for a non-offsite audit type is exactly what
      // it was before LLMO-6973 — no extra keys anywhere in the auditContext.
      expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.equal({
        type: 'lhs-mobile',
        siteId: '123',
        auditContext: {
          slackContext: {
            channelId: undefined,
            threadTs: undefined,
          },
        },
        data: undefined,
      });
    });
  });
});
