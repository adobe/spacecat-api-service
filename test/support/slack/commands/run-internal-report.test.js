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

import runInternalReportCommand
  from '../../../../src/support/slack/commands/run-internal-report.js';

use(sinonChai);

describe('runInternalReportCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;

  beforeEach(() => {
    dataAccessStub = {
      Configuration: { findLatest: sinon.stub() },
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    context = {
      dataAccess: dataAccessStub,
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
      sqs: sqsStub,
    };
    slackContext = {
      say: sinon.stub(),
    };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('should initialize correctly with base command properties', () => {
      const command = runInternalReportCommand(context);
      expect(command.id).to.equal('run-internal-report');
      expect(command.name).to.equal('Run Internal Report');
      expect(command.description).to.equal('Run internal report for all sites. Runs usage-metrics-internal by default if no report type parameter is provided.');
    });
  });

  describe('Handle Execution Method', () => {
    it('should execute with valid report type', async () => {
      dataAccessStub.Configuration.findLatest.resolves({
        getQueues: () => ({ reports: 'reports-queue' }),
      });

      const command = runInternalReportCommand(context);
      const args = ['usage-metrics-internal'];
      await command.handleExecution(args, slackContext);
      expect(sqsStub.sendMessage).to.have.been.calledOnce;
    });

    it('should trigger a report with default if no report type is provided', async () => {
      dataAccessStub.Configuration.findLatest.resolves({
        getQueues: () => ({ reports: 'reports-queue' }),
      });

      const command = runInternalReportCommand(context);
      const args = [];
      await command.handleExecution(args, slackContext);
      expect(sqsStub.sendMessage).to.have.been.calledOnce;
    });

    it('should return warning for invalid report in slack', async () => {
      const command = runInternalReportCommand(context);
      const args = ['usage-metrics'];
      await command.handleExecution(args, slackContext);
      expect(slackContext.say).to.have.been.calledWith(':warning: reportType usage-metrics is not a valid internal report type. Valid types are: usage-metrics-internal, audit-site-overview-internal');
    });

    it('should return warning for report type "all" in slack', async () => {
      const command = runInternalReportCommand(context);
      const args = ['all'];
      await command.handleExecution(args, slackContext);
      expect(slackContext.say).to.have.been.calledWith(':warning: reportType all not available. Valid types are: usage-metrics-internal, audit-site-overview-internal');
    });

    it('should catch error if something is wrong', async () => {
      const command = runInternalReportCommand(context);
      const args = ['usage-metrics-internal'];
      await command.handleExecution(args, slackContext);
      expect(context.log.error).to.have.been.calledWith('Error running internal report: Cannot read properties of undefined (reading \'getQueues\')');
    });
  });
});
