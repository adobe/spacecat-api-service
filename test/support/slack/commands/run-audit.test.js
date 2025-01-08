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
      expect(command.description).to.equal('Run audit for a previously added site. Runs lhs-mobile by default if no audit type parameter is provided.');
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
      expect(slackContext.say.firstCall.args[0]).to.include(':white_check_mark: lhs-mobile audit check is triggered for https://validsite.com');
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
      expect(slackContext.say.firstCall.args[0]).to.include(':x: Will not audit site \'https://validsite.com\' because audits of type \'lhs-mobile\' are disabled for this site.');
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('responds with a warning for an invalid site url', async () => {
      const command = RunAuditCommand(context);

      await command.handleExecution([''], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid site url.')).to.be.true;
    });

    it('informs user if the site was not added previously', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);
      const command = RunAuditCommand(context);

      await command.handleExecution(['unknownsite.com'], slackContext);

      expect(slackContext.say.calledWith(':x: \'https://unknownsite.com\' was not added previously. You can run \'@spacecat add site https://unknownsite.com')).to.be.true;
    });

    it('informs user when error occurs', async () => {
      dataAccessStub.Site.findByBaseURL.rejects(new Error('Test Error'));
      const command = RunAuditCommand(context);

      await command.handleExecution(['some-site.com'], slackContext);

      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: Test Error')).to.be.true;
    });
  });
});
