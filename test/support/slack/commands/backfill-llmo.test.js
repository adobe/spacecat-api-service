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

import BackfillLlmoCommand from '../../../../src/support/slack/commands/backfill-llmo.js';

use(sinonChai);

describe('BackfillLlmoCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let configStub;
  let siteStub;

  beforeEach(() => {
    dataAccessStub = {
      Configuration: { findLatest: sinon.stub() },
      Site: { findByBaseURL: sinon.stub() },
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    configStub = {
      getQueues: sinon.stub().returns({ audits: 'test-audits-queue-url' }),
    };
    siteStub = {
      getId: sinon.stub().returns('test-site-id'),
      getBaseURL: sinon.stub().returns('https://example.com'),
    };
    context = {
      dataAccess: dataAccessStub,
      log: { info: sinon.stub(), error: sinon.stub() },
      sqs: sqsStub,
    };
    slackContext = { say: sinon.spy() };

    dataAccessStub.Configuration.findLatest.resolves(configStub);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = BackfillLlmoCommand(context);
      expect(command.id).to.equal('backfill-llmo');
      expect(command.name).to.equal('Backfill LLMO');
      expect(command.description).to.equal('Backfills LLMO streams for the last given number of weeks (max: 4 weeks).');
    });
  });

  describe('Handle Execution Method', () => {
    it('triggers agentic backfill for a valid site with default weeks', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['https://example.com', 'agentic'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':gear: Starting agentic backfill for site https://example.com (4 weeks)...');
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(4);
    });

    it('triggers agentic backfill for a valid site with custom weeks', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['https://example.com', 'agentic', '2'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':gear: Starting agentic backfill for site https://example.com (2 weeks)...');
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(2);
    });

    it('sends correct SQS message structure', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['https://example.com', 'agentic', '1'], slackContext);

      expect(sqsStub.sendMessage.called).to.be.true;
      const [queueUrl, message] = sqsStub.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('test-audits-queue-url');
      expect(message).to.have.property('type', 'cdn-logs-report');
      expect(message).to.have.property('siteId', 'test-site-id');
      expect(message).to.have.property('auditContext');
      expect(message.auditContext).to.have.property('weekOffset', -1);
    });

    it('responds with usage when no arguments provided', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Missing required arguments. Please provide: `baseURL` and `streamType`.');
    });

    it('responds with error for invalid site url', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['invalid-url', 'agentic'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid site base URL.')).to.be.true;
    });

    it('informs user if the site was not found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['https://unknownsite.com', 'agentic'], slackContext);

      expect(slackContext.say.calledWith(':x: Site \'https://unknownsite.com\' not found.')).to.be.true;
    });

    it('rejects weeks parameter greater than 4', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['https://example.com', 'agentic', '5'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid number of weeks (1-4).')).to.be.true;
    });

    it('rejects invalid weeks parameter', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['https://example.com', 'agentic', 'invalid'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid number of weeks (1-4).')).to.be.true;
    });

    it('rejects unsupported stream type', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['https://example.com', 'unsupported'], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Unsupported stream type: unsupported. Supported types: agentic, referral');
    });

    it('logs errors when they occur', async () => {
      const error = new Error('Test Error');
      dataAccessStub.Site.findByBaseURL.rejects(error);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['https://example.com', 'agentic'], slackContext);

      expect(context.log.error.calledWith('Error in LLMO backfill:', error)).to.be.true;
    });
  });
});
