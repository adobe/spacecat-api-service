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
              { group: 'imports', type: 'organic-traffic' },
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

  describe('top-forms import type validation', () => {
    it('should require both baseURL and CSV file for top-forms import', async () => {
      const command = RunImportCommand(context);

      // Test missing baseURL
      slackContext.files = [{
        name: 'test.csv',
        url_private: 'https://files.slack.com/test.csv',
      }];

      await command.handleExecution(['top-forms'], slackContext);
      expect(slackContext.say.calledWith(':error: Top-forms import requires a base URL. Please provide a valid base URL.')).to.be.true;
    });

    it('should require CSV file for top-forms import', async () => {
      const command = RunImportCommand(context);
      slackContext.files = []; // No files provided

      await command.handleExecution(['top-forms', 'https://example.com'], slackContext);
      expect(slackContext.say.calledWith(':error: Top-forms import requires a CSV file with pageUrl and formSource(Optional) columns.')).to.be.true;
    });

    it('should reject invalid baseURL for top-forms import', async () => {
      const command = RunImportCommand(context);

      await command.handleExecution(['top-forms', 'invalid-url'], slackContext);
      expect(slackContext.say.calledWith(':error: Top-forms import requires a base URL. Please provide a valid base URL.')).to.be.true;
    });

    it('should reject multiple CSV files for top-forms import', async () => {
      const command = RunImportCommand(context);
      slackContext.files = [
        { name: 'test1.csv', url_private: 'https://files.slack.com/test1.csv' },
        { name: 'test2.csv', url_private: 'https://files.slack.com/test2.csv' },
      ];

      await command.handleExecution(['top-forms', 'https://example.com'], slackContext);
      expect(slackContext.say.calledWith(':warning: Please provide only one CSV file.')).to.be.true;
    });

    it('should reject non-CSV files for top-forms import', async () => {
      const command = RunImportCommand(context);
      slackContext.files = [{
        name: 'test.txt',
        url_private: 'https://files.slack.com/test.txt',
      }];

      await command.handleExecution(['top-forms', 'https://example.com'], slackContext);
      expect(slackContext.say.calledWith(':warning: Please provide a CSV file.')).to.be.true;
    });

    it('should validate date intervals for top-forms import', async () => {
      const command = RunImportCommand(context);

      // Mock CSV response
      nock('https://files.slack.com')
        .get('/test.csv')
        .matchHeader('authorization', 'Bearer test-bot-token')
        .reply(200, 'https://example.com/form,.form-class');

      // Test invalid date format
      await command.handleExecution(['top-forms', 'https://example.com', 'invalid-date', '2024-01-31'], slackContext);
      expect(slackContext.say.calledWith(sinon.match(':error: Invalid date interval.'))).to.be.true;
    });
  });

  describe('top-forms CSV processing', () => {
    it('should handle empty CSV file gracefully', async () => {
      const command = RunImportCommand(context);

      // Mock empty CSV response
      nock('https://files.slack.com')
        .get('/test.csv')
        .matchHeader('authorization', 'Bearer test-bot-token')
        .reply(200, '');

      await command.handleExecution(['top-forms', 'https://example.com'], slackContext);

      // Should handle CSV processing error gracefully
      expect(context.log.error.called).to.be.true;
      expect(slackContext.say.calledWith(sinon.match('CSV processing failed'))).to.be.true;
    });

    it('should process multiple forms with different form sources', async () => {
      const command = RunImportCommand(context);

      // Mock CSV with multiple forms and different sources
      const csvContent = `https://example.com/contact,salesforce
https://example.com/signup,marketo
https://example.com/newsletter,.newsletter-form
https://example.com/demo,hubspot`;

      nock('https://files.slack.com')
        .get('/test.csv')
        .matchHeader('authorization', 'Bearer test-bot-token')
        .reply(200, csvContent);

      await command.handleExecution(['top-forms', 'https://example.com'], slackContext);

      expect(slackContext.say.calledWith(':adobe-run: Triggering import run of type top-forms for 1 site with 4 forms.')).to.be.true;
      expect(context.sqs.sendMessage.calledOnce).to.be.true;
    });

    it('should handle CSV with extra whitespace and varied formats', async () => {
      const command = RunImportCommand(context);

      // Mock CSV with whitespace and formatting variations
      const csvContent = ` https://example.com/form1 , .form-class 
https://example.com/form2,  salesforce  
 https://example.com/form3 , marketo `;

      nock('https://files.slack.com')
        .get('/test.csv')
        .matchHeader('authorization', 'Bearer test-bot-token')
        .reply(200, csvContent);

      await command.handleExecution(['top-forms', 'https://example.com'], slackContext);

      expect(slackContext.say.calledWith(':adobe-run: Triggering import run of type top-forms for 1 site with 3 forms.')).to.be.true;
    });

    it('should handle CSV with header row correctly', async () => {
      const command = RunImportCommand(context);

      // Mock CSV with header row
      const csvContent = `pageUrl,formSource
https://example.com/form1,.form-class
https://example.com/form2,salesforce`;

      nock('https://files.slack.com')
        .get('/test.csv')
        .matchHeader('authorization', 'Bearer test-bot-token')
        .reply(200, csvContent);

      await command.handleExecution(['top-forms', 'https://example.com'], slackContext);

      // Should process all rows including header as data (parseCSV doesn't skip headers)
      expect(slackContext.say.calledWith(':adobe-run: Triggering import run of type top-forms for 1 site with 3 forms.')).to.be.true;
    });
  });

  describe('top-forms date handling', () => {
    it('should handle date range correctly for top-forms import', async () => {
      const command = RunImportCommand(context);

      nock('https://files.slack.com')
        .get('/test.csv')
        .matchHeader('authorization', 'Bearer test-bot-token')
        .reply(200, 'https://example.com/form,.form-class');

      await command.handleExecution(['top-forms', 'https://example.com', '2024-01-01', '2024-01-31'], slackContext);

      // Verify SQS message was sent with correct dates
      expect(context.sqs.sendMessage.calledOnce).to.be.true;
      const sqsArgs = context.sqs.sendMessage.firstCall.args;
      const message = sqsArgs[1];
      expect(message).to.have.property('startDate', '2024-01-01');
      expect(message).to.have.property('endDate', '2024-01-31');
    });

    it('should handle top-forms import without date range', async () => {
      const command = RunImportCommand(context);

      nock('https://files.slack.com')
        .get('/test.csv')
        .matchHeader('authorization', 'Bearer test-bot-token')
        .reply(200, 'https://example.com/form,.form-class');

      await command.handleExecution(['top-forms', 'https://example.com'], slackContext);

      // Verify SQS message was sent with undefined dates
      expect(context.sqs.sendMessage.calledOnce).to.be.true;
      const sqsArgs = context.sqs.sendMessage.firstCall.args;
      const message = sqsArgs[1];
      expect(message).to.have.property('startDate', undefined);
      expect(message).to.have.property('endDate', undefined);
    });
  });

  describe('top-forms error handling', () => {
    it('should handle site not found error for top-forms', async () => {
      const command = RunImportCommand(context);

      // Mock site not found
      context.dataAccess.Site.findByBaseURL.resolves(null);

      nock('https://files.slack.com')
        .get('/test.csv')
        .matchHeader('authorization', 'Bearer test-bot-token')
        .reply(200, 'https://example.com/form,.form-class');

      await command.handleExecution(['top-forms', 'https://example.com'], slackContext);

      // Should post site not found message
      expect(slackContext.say.calledWith(':x: No site found with base URL \'https://example.com\'.')).to.be.true;
    });

    it('should handle CSV download errors gracefully', async () => {
      const command = RunImportCommand(context);

      // Mock CSV download failure
      nock('https://files.slack.com')
        .get('/test.csv')
        .matchHeader('authorization', 'Bearer test-bot-token')
        .reply(500);

      await command.handleExecution(['top-forms', 'https://example.com'], slackContext);

      // Should handle error and post error message
      expect(context.log.error.called).to.be.true;
    });

    it('should handle invalid import type for top-forms', async () => {
      const command = RunImportCommand(context);

      // Mock configuration without top-forms job type
      context.dataAccess.Configuration.findLatest.resolves({
        getJobs: sinon.stub().returns([
          { group: 'imports', type: 'organic-traffic' },
        ]),
        getQueues: sinon.stub().returns({
          imports: 'test-queue-url',
        }),
      });

      await command.handleExecution(['top-forms', 'https://example.com'], slackContext);

      expect(slackContext.say.calledWith(sinon.match(':warning: Import type top-forms does not exist.'))).to.be.true;
    });
  });

  describe('existing functionality - basic tests', () => {
    it('should handle file and baseURL for top-forms import', async () => {
      // Mock file download with CSV content that has 2 columns
      nock('https://files.slack.com')
        .get('/test.csv')
        .matchHeader('authorization', 'Bearer test-bot-token')
        .reply(200, 'https://example.com/form-page,.form\nhttps://test.com/contact,.test-class');

      const command = RunImportCommand(context);
      const args = ['top-forms', 'https://example.com'];

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':adobe-run: Triggering import run of type top-forms for 1 site with 2 forms.')).to.be.true;
      expect(context.sqs.sendMessage.calledOnce).to.be.true;
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
