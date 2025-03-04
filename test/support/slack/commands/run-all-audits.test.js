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

import RunAllAuditsCommand from '../../../../src/support/slack/commands/run-all-audits.js';

use(sinonChai);

describe('RunAllAuditsCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;

  beforeEach(() => {
    dataAccessStub = {
      Site: {
        findByBaseURL: sinon.stub(),
      },
      Configuration: {
        findLatest: sinon.stub(),
        getEnabledAuditsForSite: sinon.stub(),
      },
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

  afterEach(() => {
    sinon.restore();
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = RunAllAuditsCommand(context);
      expect(command.id).to.equal('run-all-audits');
      expect(command.name).to.equal('Run all Audits');
      expect(command.description).to.equal('Run all configured audits for a specified baseURL or a list of baseURLs from a CSV file.');
    });
  });

  describe('Handle execution method', () => {
    it('trigger all audits for a valid site', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves({
        getEnabledAuditsForSite: () => ['lhs-mobile', 'lhs-desktop'],
      });

      const command = RunAllAuditsCommand(context);
      await command.handleExecution(['validsite.com'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(':white_check_mark: All audits triggered successfully.');
      expect(sqsStub.sendMessage.called).to.be.true;
    });
  });
});
