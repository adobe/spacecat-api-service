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

import RunTrafficAnalysisBackfillCommand from '../../../../src/support/slack/commands/run-traffic-analysis-backfill.js';

use(sinonChai);

describe('RunTrafficAnalysisBackfillCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let configStub;
  let siteStub;
  let siteConfigStub;

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
      getJobs: sinon.stub().returns([
        { group: 'imports', type: 'traffic-analysis' },
      ]),
    };
    siteConfigStub = {
      isImportEnabled: sinon.stub().returns(true),
    };
    siteStub = {
      getId: sinon.stub().returns('test-site-id'),
      getBaseURL: sinon.stub().returns('https://example.com'),
      getConfig: sinon.stub().returns(siteConfigStub),
    };
    context = {
      dataAccess: dataAccessStub,
      log: { info: sinon.stub(), error: sinon.stub() },
      sqs: sqsStub,
    };
    slackContext = { say: sinon.spy() };

    dataAccessStub.Configuration.findLatest.resolves(configStub);
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = RunTrafficAnalysisBackfillCommand(context);
      expect(command.id).to.equal('run-traffic-analysis-backfill');
      expect(command.name).to.equal('Run Traffic Analysis Backfill');
      expect(command.description).to.equal('Runs the traffic analysis import prior to current calendar week for the site identified with its id; number of weeks can be specified and is 52 by default.');
    });
  });

  describe('Handle Execution Method', () => {
    it('triggers traffic analysis backfill for a valid site with custom weeks', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com', '4'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggered backfill for traffic analysis import for site `https://example.com` for the last 4 weeks');
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(4);
    });

    it('sends correct SQS message structure', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com', '1'], slackContext);

      expect(sqsStub.sendMessage.called).to.be.true;
      const [queueUrl, message] = sqsStub.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('test-import-queue-url');
      expect(message).to.have.property('type', 'traffic-analysis');
      expect(message).to.have.property('siteId', 'test-site-id');
      expect(message).to.have.property('week');
      expect(message).to.have.property('year');
      expect(message).to.have.property('slackContext');
    });

    it('responds with usage for invalid site url', async () => {
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['invalid-url', '4'], slackContext);

      expect(slackContext.say.calledWith(command.usage())).to.be.true;
    });

    it('informs user if the site was not added previously', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://unknownsite.com', '4'], slackContext);

      expect(slackContext.say.calledWith(':x: No site found with base URL \'https://unknownsite.com\'.')).to.be.true;
    });

    it('informs user when traffic analysis import job does not exist', async () => {
      configStub.getJobs.returns([]);
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com', '4'], slackContext);

      expect(slackContext.say.calledWith(':warning: Import type traffic-analysis does not exist.')).to.be.true;
    });

    it('informs user when traffic analysis import is not enabled for site', async () => {
      siteConfigStub.isImportEnabled.returns(false);
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com', '4'], slackContext);

      expect(slackContext.say.calledWith(':warning: Import type traffic-analysis is not enabled for site `https://example.com`')).to.be.true;
    });

    it('validates week parameter - rejects negative numbers', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com', '-5'], slackContext);

      expect(slackContext.say.calledWith(':warning: Invalid number of weeks specified. Please provide a positive integer.')).to.be.true;
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('validates week parameter - rejects zero', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com', '0'], slackContext);

      expect(slackContext.say.calledWith(':warning: Invalid number of weeks specified. Please provide a positive integer.')).to.be.true;
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('validates week parameter - rejects non-numeric values', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com', 'abc'], slackContext);

      expect(slackContext.say.calledWith(':warning: Invalid number of weeks specified. Please provide a positive integer.')).to.be.true;
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('validates week parameter - rejects decimal numbers', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com', '4.5'], slackContext);

      expect(slackContext.say.calledWith(':warning: Invalid number of weeks specified. Please provide a positive integer.')).to.be.true;
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('validates week parameter - accepts valid positive integers', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com', '10'], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include('Triggered backfill');
      expect(sqsStub.sendMessage.called).to.be.true;
    });

    it('logs import run information', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com', '1'], slackContext);

      expect(context.log.info.called).to.be.true;
      expect(context.log.info.firstCall.args[0]).to.include('Import run of type traffic-analysis for site https://example.com');
    });

    it('logs errors when they occur', async () => {
      const error = new Error('Test Error');
      dataAccessStub.Site.findByBaseURL.rejects(error);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com', '4'], slackContext);

      expect(context.log.error.calledWith(error)).to.be.true;
    });

    it('handles missing weeks parameter by defaulting to 52', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggered backfill for traffic analysis import for site `https://example.com` for the last 52 weeks');
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(52);
    });

    it('handles empty arguments by showing usage', async () => {
      const command = RunTrafficAnalysisBackfillCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say.calledWith(command.usage())).to.be.true;
    });
  });
});
