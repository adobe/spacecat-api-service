/*
 * Copyright 2024 Adobe. All rights reserved.
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

import RunAgenticTrafficBackfillCommand from '../../../../src/support/slack/commands/run-agentic-traffic-backfill.js';

use(sinonChai);

describe('RunAgenticTrafficBackfillCommand', () => {
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
      getQueues: sinon.stub().returns({ imports: 'test-import-queue-url' }),
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
      const command = RunAgenticTrafficBackfillCommand(context);
      expect(command.id).to.equal('run-agentic-traffic-backfill');
      expect(command.name).to.equal('Run Agentic Traffic Backfill');
      expect(command.description).to.equal('Backfills agentic traffic for the last given number of weeks (max: 4 weeks).');
    });
  });

  describe('Handle Execution Method', () => {
    it('triggers agentic traffic backfill for a valid site with default weeks', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunAgenticTrafficBackfillCommand(context);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':gear: Starting agentic traffic backfill for site https://example.com (4 weeks)...');
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(4);
    });

    it('triggers agentic traffic backfill for a valid site with custom weeks', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunAgenticTrafficBackfillCommand(context);

      await command.handleExecution(['https://example.com', '2'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':gear: Starting agentic traffic backfill for site https://example.com (2 weeks)...');
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(2);
    });

    it('sends correct SQS message structure', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunAgenticTrafficBackfillCommand(context);

      await command.handleExecution(['https://example.com', '1'], slackContext);

      expect(sqsStub.sendMessage.called).to.be.true;
      const [queueUrl, message] = sqsStub.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('test-import-queue-url');
      expect(message).to.have.property('type', 'cdn-logs-report');
      expect(message).to.have.property('siteId', 'test-site-id');
      expect(message).to.have.property('auditContext');
      expect(message.auditContext).to.have.property('weekOffset', -1);
    });

    it('responds with usage when no arguments provided', async () => {
      const command = RunAgenticTrafficBackfillCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Missing required arguments. Please provide: `baseURL`.');
    });

    it('responds with error for invalid site url', async () => {
      const command = RunAgenticTrafficBackfillCommand(context);

      await command.handleExecution(['invalid-url'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid site base URL.')).to.be.true;
    });

    it('informs user if the site was not found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);
      const command = RunAgenticTrafficBackfillCommand(context);

      await command.handleExecution(['https://unknownsite.com'], slackContext);

      expect(slackContext.say.calledWith(':x: Site \'https://unknownsite.com\' not found.')).to.be.true;
    });

    it('rejects weeks parameter greater than 4', async () => {
      const command = RunAgenticTrafficBackfillCommand(context);

      await command.handleExecution(['https://example.com', '5'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid number of weeks (1-4).')).to.be.true;
    });

    it('rejects invalid weeks parameter', async () => {
      const command = RunAgenticTrafficBackfillCommand(context);

      await command.handleExecution(['https://example.com', 'invalid'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid number of weeks (1-4).')).to.be.true;
    });

    it('logs errors when they occur', async () => {
      const error = new Error('Test Error');
      dataAccessStub.Site.findByBaseURL.rejects(error);
      const command = RunAgenticTrafficBackfillCommand(context);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(context.log.error.calledWith('Error in agentic traffic backfill:', error)).to.be.true;
    });
  });
});
