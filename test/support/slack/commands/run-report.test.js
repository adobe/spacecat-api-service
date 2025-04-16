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

import RunReportCommand from '../../../../src/support/slack/commands/run-report.js';

use(sinonChai);

describe('RunReportCommand', () => {
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
      env: { REPORT_JOBS_QUEUE_URL: 'testQueueUrl' },
    };
    slackContext = { say: sinon.spy() };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = RunReportCommand(context);
      expect(command.id).to.equal('run-report');
      expect(command.name).to.equal('Run Report');
      expect(command.description).to.equal('Run report for a previously added site. Runs lhs-mobile by default if no audit type parameter is provided. Runs all audits if audit type is `all`');
    });
  });

  describe('Handle Execution Method', () => {
    it('triggers a report for a valid report type', async () => {
      const command = RunReportCommand(context);

      await command.handleExecution(['forms-internal'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering forms-internal report');
    });

    it('triggers a default report when no report type is provided', async () => {
      const command = RunReportCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering forms-internal report');
    });

    it('informs user when error occurs', async () => {
      const errorMessage = 'Test Error';
      const command = RunReportCommand(context);

      // Stub the log.error method
      const logErrorStub = sinon.stub(context.log, 'info').throws(new Error(errorMessage));

      await command.handleExecution(['some-report-type'], slackContext);

      expect(slackContext.say.calledWith(`:nuclear-warning: Oops! Something went wrong: ${errorMessage}`)).to.be.true;

      // Restore the stub after the test
      logErrorStub.restore();
    });
  });
});
