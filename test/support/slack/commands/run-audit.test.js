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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import nock from 'nock';

import RunAuditCommand from '../../../../src/support/slack/commands/run-audit.js';

use(sinonChai);

describe('RunAuditCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;

  beforeEach(() => {
    dataAccessStub = {
      Configuration: { findLatest: sinon.stub() },
      Site: { findByBaseURL: sinon.stub() },
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    context = {
      dataAccess: dataAccessStub,
      log: console,
      sqs: sqsStub,
      env: { AUDIT_JOBS_QUEUE_URL: 'testQueueUrl' },
    };
    slackContext = { say: sinon.spy() };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = RunAuditCommand(context);
      expect(command.id).to.equal('run-audit');
      expect(command.name).to.equal('Run Audit');
      expect(command.description).to.equal('Run audit for a previously added site. Runs lhs-mobile by default if no audit type parameter is provided. Runs all audits if audit type is `all`');
    });
  });

  describe('Handle Execution Method', () => {
    it('triggers an audit for a valid site', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: () => true,
      });
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering lhs-mobile audit for https://validsite.com');
      expect(sqsStub.sendMessage.called).to.be.true;
    });

    it('does not trigger an audit when audit for type is disabled', async () => {
      const site = {
        getId: () => '123',
      };
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: sinon.stub().returns(false),
      });
      const command = RunAuditCommand(context);

      await command.handleExecution(['validsite.com'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering lhs-mobile audit for https://validsite.com');
      expect(slackContext.say.secondCall.args[0]).to.include(':x: Will not audit site \'https://validsite.com\' because audits of type \'lhs-mobile\' are disabled for this site.');
      expect(sqsStub.sendMessage.called).to.be.false;
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
      const handlerEnabledStub = sinon.stub().onCall(0).returns(true).onCall(1)
        .returns(true);
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: handlerEnabledStub,
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'all'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(':adobe-run: Triggering all audit for https://validsite.com');
      expect(sqsStub.sendMessage.called).to.be.true;
    });

    it('triggers all audits for all sites specified in a CSV file', async () => {
      const handlerEnabledStub = sinon.stub().onCall(0).returns(true).onCall(1)
        .returns(true)
        .onCall(22)
        .returns(true);
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: handlerEnabledStub,
      });
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
      expect(sqsStub.sendMessage.called).to.be.true;
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

    it('handles site with no enable audits', async () => {
      const handlerEnabledStub = sinon.stub().onCall(0).returns(false);
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: handlerEnabledStub,
      });

      const command = RunAuditCommand(context);
      await command.handleExecution(['validsite.com', 'all'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(':adobe-run: Triggering all audit for https://validsite.com');
      expect(slackContext.say.secondCall.args[0]).to.equal(':warning: No audits configured for site `https://validsite.com`');
    });

    it('handles error while triggering audits', async () => {
      const errorMessage = 'Failed to trigger';
      const handlerEnabledStub = sinon.stub().onCall(0).returns(true);
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves({
        isHandlerEnabledForSite: handlerEnabledStub,
      });
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
        . reply(401, 'Unauthorized');

      await command.handleExecution(['', 'all'], slackContext);
      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: CSV processing failed: Authentication failed: Invalid Slack token.')).to.be.true;
    });
  });
});
