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

import { expect } from 'chai';
import sinon from 'sinon';
import nock from 'nock';
import RunImportCommand from '../../../../src/support/slack/commands/run-import.js';
import * as utils from '../../../../src/support/utils.js';

/* eslint-env mocha */

describe('RunImportCommand - Top Forms Integration', () => {
  let context;
  let slackContext;

  beforeEach(() => {
    const siteStub = {
      getId: sinon.stub().returns('site-123'),
    };

    context = {
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
      dataAccess: {
        Site: {
          findByBaseURL: sinon.stub().resolves(siteStub),
        },
        Configuration: {
          findLatest: sinon.stub().resolves({
            getJobs: sinon.stub().returns([
              { group: 'imports', type: 'top-forms' },
            ]),
            getQueues: sinon.stub().returns({
              imports: 'test-queue-url',
            }),
          }),
        },
      },
      sqs: {
        sendMessage: sinon.stub().resolves(),
      },
      env: {
        IMPORT_JOBS_QUEUE_URL: 'test-queue-url',
      },
    };

    slackContext = {
      say: sinon.stub(),
      files: [
        {
          name: 'test.csv',
          url_private: 'https://files.slack.com/test.csv',
        },
      ],
      botToken: 'test-bot-token',
      channelId: 'test-channel',
      threadTs: 'test-thread',
    };
  });

  afterEach(() => {
    sinon.restore();
    nock.cleanAll();
  });

  describe('top-forms import type', () => {
    it('should handle CSV with 3 columns for top-forms import', async () => {
      // Mock file download with CSV content that has 3 columns
      // The parseCSV function uses Authorization header with Bearer token
      nock('https://files.slack.com')
        .get('/test.csv')
        .matchHeader('authorization', 'Bearer test-bot-token')
        .reply(200, 'https://example.com,https://example.com/form-page,hubspot\nhttps://test.com,https://test.com/contact,marketo');

      const command = RunImportCommand(context);
      const args = ['top-forms'];

      await command.handleExecution(args, slackContext);

      // Verify the expected behavior - the command should successfully process the CSV
      // and trigger import runs for the 2 sites. The fact that it doesn't throw an error
      // indicates that parseCSV was called correctly with minColumns = 3
      expect(slackContext.say.calledWith(':adobe-run: Triggering import run of type top-forms for 2 sites.')).to.be.true;
      expect(context.sqs.sendMessage.calledTwice).to.be.true;
    });

    it('should create data object with formSource for top-forms', async () => {
      const testFormSource = 'salesforce';

      // Mock SQS message sending to capture the message structure
      const sqsMessageCapture = sinon.stub();

      // Call sendRunImportMessage directly to test data structure
      await utils.sendRunImportMessage(
        { sendMessage: sqsMessageCapture },
        'test-queue',
        'top-forms',
        'site-123',
        '2024-01-01',
        '2024-01-31',
        { channelId: 'test-channel', threadTs: 'test-thread' },
        'https://example.com/form-page',
        { formSource: testFormSource },
      );

      // Verify the message structure includes the data object
      expect(sqsMessageCapture.calledOnce).to.be.true;
      const sentMessage = sqsMessageCapture.firstCall.args[1];

      expect(sentMessage).to.have.property('type', 'top-forms');
      expect(sentMessage).to.have.property('siteId', 'site-123');
      expect(sentMessage).to.have.property('pageUrl', 'https://example.com/form-page');
      expect(sentMessage).to.have.property('data');
      expect(sentMessage.data).to.deep.equal({ formSource: testFormSource });
    });

    it('should not include data object for non-top-forms imports', async () => {
      // Mock SQS message sending to capture the message structure
      const sqsMessageCapture = sinon.stub();

      // Call sendRunImportMessage for a regular import type
      await utils.sendRunImportMessage(
        { sendMessage: sqsMessageCapture },
        'test-queue',
        'organic-traffic',
        'site-123',
        '2024-01-01',
        '2024-01-31',
        { channelId: 'test-channel', threadTs: 'test-thread' },
        'https://example.com/page',
        undefined, // no data for regular imports
      );

      // Verify the message structure does not include data object
      expect(sqsMessageCapture.calledOnce).to.be.true;
      const sentMessage = sqsMessageCapture.firstCall.args[1];

      expect(sentMessage).to.have.property('type', 'organic-traffic');
      expect(sentMessage).to.have.property('siteId', 'site-123');
      expect(sentMessage).to.have.property('pageUrl', 'https://example.com/page');
      expect(sentMessage).to.not.have.property('data');
    });
  });
});
