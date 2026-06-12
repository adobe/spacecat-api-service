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

// Mock TierClient at the top level
const mockTierClient = {
  createForSite: sinon.stub(),
};

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

    // Reset and set default behavior for TierClient mock
    mockTierClient.createForSite.reset();
    mockTierClient.createForSite.resolves({
      checkValidEntitlement: sinon.stub().resolves({ entitlement: { id: 'ent-123' } }),
    });
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = RunAuditCommand(context);
      expect(command.id).to.equal('run-audit');
      expect(command.name).to.equal('Run Audit');
      expect(command.description).to.equal('Run audit for a previously added site. Supports both positional and keyword arguments. Runs lhs-mobile by default if no audit type is specified. Use `audit:all` to run all audits. For prerender: `mode:all` runs full audit for NEW/FIXED suggestions; `mode:ai-only` runs AI-only for NEW/FIXED; `mode:ai-only-current` runs AI-only for current-tab suggestions only (NEW, not covered/deployed). CSV uploads are batched at 320 URLs.');
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

    it('sends batch-wise Slack messages for large prerender CSV', async () => {
      const site = { getId: () => '123' };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves(createDefaultConfigurationMock('prerender', ['LLMO']));
      slackContext.files = [
        {
          name: 'urls.csv',
          url_private: 'https://example.com/urls.csv',
        },
      ];
      // Generate 500 valid URLs → should produce 2 batches (320 + 180)
      const urls = Array.from({ length: 500 }, (_, i) => `https://valid.site/page-${i + 1}`);
      nock('https://example.com')
        .get('/urls.csv')
        .reply(200, urls.join('\n'));

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'prerender'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledTwice;
      // First batch: 320 URLs
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext.urls).to.have.length(320);
      // Second batch: 180 URLs
      expect(sqsStub.sendMessage.secondCall.args[1].auditContext.urls).to.have.length(180);
      // Batch-wise Slack messages
      expect(slackContext.say.secondCall.args[0]).to.equal(':white_check_mark: prerender audit queued for 320 URLs (batch 1/2).');
      expect(slackContext.say.thirdCall.args[0]).to.equal(':white_check_mark: prerender audit queued for 180 URLs (batch 2/2).');
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

    it('blocks prerender CSV audits when the prerender handler is disabled', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => '123' });
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: sinon.stub().returns(false),
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

      expect(slackContext.say.secondCall.args[0]).to.equal(':x: Will not audit site \'https://site.com\' because audits of type \'prerender\' are disabled for this site.');
      expect(sqsStub.sendMessage.called).to.be.false;
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
        checkValidEntitlement: sinon.stub().resolves({ entitlement: null }),
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
          checkValidEntitlement: sinon.stub().resolves({ entitlement: { id: 'ent-123' } }),
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
    const makeSuggestion = (url, status, extraData = {}) => ({
      getStatus: () => status,
      getData: () => ({ url, ...extraData }),
    });

    const makeOpportunity = (type, suggestions) => ({
      getType: () => type,
      getSuggestions: sinon.stub().resolves(suggestions),
    });

    beforeEach(() => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'siteId' });
      dataAccessStub.Configuration.findLatest.resolves(
        createDefaultConfigurationMock('prerender', ['LLMO']),
      );
    });

    it('mode:all fetches NEW/FIXED suggestions and triggers prerender audit', async () => {
      dataAccessStub.Opportunity.allBySiteId.resolves([
        makeOpportunity('prerender', [
          makeSuggestion('https://site.com/page-1', 'NEW'),
          makeSuggestion('https://site.com/page-2', 'FIXED'),
          makeSuggestion('https://site.com/page-3', 'OUTDATED'),
        ]),
      ]);

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:all'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.include({ type: 'prerender' });
      const { urls, mode } = sqsStub.sendMessage.firstCall.args[1].auditContext;
      expect(urls).to.deep.equal(['https://site.com/page-1', 'https://site.com/page-2']);
      expect(mode).to.be.undefined;
    });

    it('mode:ai-only fetches suggestions and passes mode in data field', async () => {
      dataAccessStub.Opportunity.allBySiteId.resolves([
        makeOpportunity('prerender', [
          makeSuggestion('https://site.com/page-1', 'NEW'),
          makeSuggestion('https://site.com/page-2', 'FIXED'),
        ]),
      ]);

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:ai-only'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.include({ type: 'prerender' });
      const msgData = JSON.parse(sqsStub.sendMessage.firstCall.args[1].data);
      expect(msgData.mode).to.equal('ai-only');
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext.mode).to.be.undefined;
    });

    it('deduplicates URLs across multiple prerender opportunities', async () => {
      dataAccessStub.Opportunity.allBySiteId.resolves([
        makeOpportunity('prerender', [
          makeSuggestion('https://site.com/page-1', 'NEW'),
        ]),
        makeOpportunity('prerender', [
          makeSuggestion('https://site.com/page-1', 'FIXED'),
          makeSuggestion('https://site.com/page-2', 'NEW'),
        ]),
      ]);

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:all'], slackContext);

      const { urls } = sqsStub.sendMessage.firstCall.args[1].auditContext;
      expect(urls).to.have.length(2);
      expect(urls).to.include('https://site.com/page-1');
      expect(urls).to.include('https://site.com/page-2');
    });

    it('filters out wildcard and invalid URLs from suggestions', async () => {
      dataAccessStub.Opportunity.allBySiteId.resolves([
        makeOpportunity('prerender', [
          makeSuggestion('https://site.com/page-1', 'NEW'),
          makeSuggestion('https://site.com/wildcard/*', 'NEW'),
          makeSuggestion('invalid-url', 'NEW'),
          makeSuggestion(null, 'NEW'),
        ]),
      ]);

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:all'], slackContext);

      const { urls } = sqsStub.sendMessage.firstCall.args[1].auditContext;
      expect(urls).to.deep.equal(['https://site.com/page-1']);
    });

    it('reports nothing to audit when no NEW/FIXED suggestions exist', async () => {
      dataAccessStub.Opportunity.allBySiteId.resolves([
        makeOpportunity('prerender', [
          makeSuggestion('https://site.com/page-1', 'OUTDATED'),
        ]),
      ]);

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:all'], slackContext);

      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWithMatch(/nothing to audit/);
    });

    it('reports nothing to audit when no prerender opportunities exist', async () => {
      dataAccessStub.Opportunity.allBySiteId.resolves([
        makeOpportunity('broken-backlinks', [
          makeSuggestion('https://site.com/page-1', 'NEW'),
        ]),
      ]);

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:all'], slackContext);

      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWithMatch(/nothing to audit/);
    });

    it('shows site-not-found for suggestion-based mode when site does not exist', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const command = RunAuditCommand(context);
      await command.handleExecution(['unknownsite.com', 'audit:prerender', 'mode:all'], slackContext);

      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(':x: No site found with base URL \'https://unknownsite.com\'.');
    });

    it('merges mode into data field alongside other keyword args', async () => {
      dataAccessStub.Opportunity.allBySiteId.resolves([
        makeOpportunity('prerender', [
          makeSuggestion('https://site.com/page-1', 'NEW'),
        ]),
      ]);

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:ai-only', 'source:test'], slackContext);

      const msgData = JSON.parse(sqsStub.sendMessage.firstCall.args[1].data);
      expect(msgData.mode).to.equal('ai-only');
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

    it('sends batch-wise Slack messages for suggestion-based mode', async () => {
      const suggestions = Array.from({ length: 500 }, (_, i) => makeSuggestion(`https://site.com/page-${i + 1}`, i % 2 === 0 ? 'NEW' : 'FIXED'));
      dataAccessStub.Opportunity.allBySiteId.resolves([
        makeOpportunity('prerender', suggestions),
      ]);

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:all'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledTwice;
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext.urls).to.have.length(320);
      expect(sqsStub.sendMessage.secondCall.args[1].auditContext.urls).to.have.length(180);
      expect(slackContext.say).to.have.been.calledWithMatch(/320 URLs \(batch 1\/2\)/);
      expect(slackContext.say).to.have.been.calledWithMatch(/180 URLs \(batch 2\/2\)/);
    });

    it('mode:ai-only-current fetches only current-tab suggestions', async () => {
      dataAccessStub.Opportunity.allBySiteId.resolves([
        makeOpportunity('prerender', [
          makeSuggestion('https://site.com/current', 'NEW'),
          makeSuggestion('https://site.com/covered', 'NEW', { coveredByDomainWide: true }),
          makeSuggestion('https://site.com/deployed', 'NEW', { edgeDeployed: true }),
          makeSuggestion('https://site.com/pattern', 'NEW', { coveredByPattern: true }),
          makeSuggestion('https://site.com/fixed', 'FIXED'),
        ]),
      ]);

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:ai-only-current'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      const { urls } = sqsStub.sendMessage.firstCall.args[1].auditContext;
      expect(urls).to.deep.equal(['https://site.com/current']);
      const msgData = JSON.parse(sqsStub.sendMessage.firstCall.args[1].data);
      expect(msgData.mode).to.equal('ai-only');
    });

    it('mode:ai-only-current filters out wildcard and null URLs', async () => {
      dataAccessStub.Opportunity.allBySiteId.resolves([
        makeOpportunity('prerender', [
          makeSuggestion('https://site.com/valid', 'NEW'),
          makeSuggestion('https://site.com/wildcard/*', 'NEW'),
          makeSuggestion(null, 'NEW'),
        ]),
      ]);

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:ai-only-current'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      const { urls } = sqsStub.sendMessage.firstCall.args[1].auditContext;
      expect(urls).to.deep.equal(['https://site.com/valid']);
    });

    it('mode:ai-only-current reports nothing when all suggestions are filtered out', async () => {
      dataAccessStub.Opportunity.allBySiteId.resolves([
        makeOpportunity('prerender', [
          makeSuggestion('https://site.com/covered', 'NEW', { coveredByDomainWide: true }),
          makeSuggestion('https://site.com/deployed', 'NEW', { edgeDeployed: true }),
        ]),
      ]);

      const command = RunAuditCommand(context);
      await command.handleExecution(['site.com', 'audit:prerender', 'mode:ai-only-current'], slackContext);

      expect(sqsStub.sendMessage).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWithMatch(/nothing to audit/);
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
        getHandlers: () => ({ 'lhs-mobile': handler }),
      });

      // Mock TierClient to return valid entitlement
      const mockTierClientInstance = {
        checkValidEntitlement: sinon.stub().resolves({
          entitlement: { id: 'ent-123' },
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

    it('should block audit when site has no entitlement', async () => {
      const site = { getId: () => '123' };
      const handler = {
        productCodes: ['LLMO'],
      };

      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        getHandlers: () => ({ 'lhs-mobile': handler }),
      });

      // Mock TierClient to return no entitlement
      const mockTierClientInstance = {
        checkValidEntitlement: sinon.stub().resolves({
          entitlement: null,
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

    it('should allow audit when site has entitlement for any product code', async () => {
      const site = { getId: () => '123' };
      const handler = {
        productCodes: ['LLMO', 'ASO'],
      };

      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
        getHandlers: () => ({ 'lhs-mobile': handler }),
      });

      // Mock TierClient - first product code fails, second succeeds
      const mockTierClientInstance1 = {
        checkValidEntitlement: sinon.stub().resolves({ entitlement: null }),
      };
      const mockTierClientInstance2 = {
        checkValidEntitlement: sinon.stub().resolves({ entitlement: { id: 'ent-456' } }),
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
        getHandlers: () => ({ 'lhs-mobile': handler }),
      });

      // Mock TierClient - first product code throws error, second succeeds
      const mockTierClientInstance2 = {
        checkValidEntitlement: sinon.stub().resolves({ entitlement: { id: 'ent-456' } }),
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
        getHandlers: () => ({ 'lhs-mobile': handler }),
      });

      // Mock TierClient - both product codes return no entitlement
      const mockTierClientInstance1 = {
        checkValidEntitlement: sinon.stub().resolves({ entitlement: null }),
      };
      const mockTierClientInstance2 = {
        checkValidEntitlement: sinon.stub().resolves({ entitlement: false }),
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

    it('should handle checkValidEntitlement errors gracefully', async () => {
      const site = { getId: () => '123' };
      const handler = {
        productCodes: ['LLMO'],
      };

      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
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
});
