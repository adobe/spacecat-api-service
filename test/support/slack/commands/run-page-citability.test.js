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
import nock from 'nock';

import RunPageCitabilityCommand from '../../../../src/support/slack/commands/run-page-citability.js';

use(sinonChai);

describe('RunPageCitabilityCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;

  beforeEach(() => {
    dataAccessStub = {
      Configuration: {
        findLatest: sinon.stub().resolves({
          getQueues: () => ({ audits: 'testQueueUrl' }),
        }),
      },
      Site: { findByBaseURL: sinon.stub() },
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    context = {
      dataAccess: dataAccessStub,
      log: {
        info: sinon.spy(),
        error: sinon.spy(),
        warn: sinon.spy(),
      },
      sqs: sqsStub,
    };
    slackContext = {
      say: sinon.spy(),
      files: null,
      botToken: 'test-token',
      channelId: 'C123',
      threadTs: '123.456',
    };
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = RunPageCitabilityCommand(context);
      expect(command.id).to.equal('run-page-citability');
      expect(command.name).to.equal('Run Page Citability');
      expect(command.description).to.equal('Run page citability audit for a site with a list of URLs (CSV file).');
    });

    it('accepts the correct phrase', () => {
      const command = RunPageCitabilityCommand(context);
      expect(command.accepts('run page citability example.com')).to.be.true;
      expect(command.accepts('run audit example.com')).to.be.false;
    });
  });

  describe('Handle Execution Method', () => {
    it('shows usage when no valid URL is provided', async () => {
      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['invalid-url'], slackContext);

      expect(slackContext.say.calledWith(command.usage())).to.be.true;
    });

    it('shows site not found when site does not exist', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);
      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say.calledWith(':x: No site found with base URL \'https://example.com\'.')).to.be.true;
    });

    it('requires a CSV file to be attached', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-123' });
      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please attach a CSV file with URLs to audit.')).to.be.true;
    });

    it('rejects multiple CSV files', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-123' });
      slackContext.files = [
        { name: 'file1.csv', url_private: 'https://example.com/file1.csv' },
        { name: 'file2.csv', url_private: 'https://example.com/file2.csv' },
      ];
      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide only one CSV file.')).to.be.true;
    });

    it('rejects non-CSV files', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-123' });
      slackContext.files = [
        { name: 'file.txt', url_private: 'https://example.com/file.txt' },
      ];
      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a CSV file.')).to.be.true;
    });

    it('triggers page-citability audit with valid CSV file', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-123' });
      slackContext.files = [
        { name: 'urls.csv', url_private: 'https://slack.com/files/urls.csv' },
      ];

      nock('https://slack.com')
        .get('/files/urls.csv')
        .reply(200, 'https://example.com/page1\nhttps://example.com/page2\nhttps://example.com/page3');

      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':adobe-run: Triggering page-citability audit for site https://example.com with 3 URLs...');
      expect(sqsStub.sendMessage).to.have.been.calledOnce;

      const [queueUrl, message] = sqsStub.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('testQueueUrl');
      expect(message.type).to.equal('page-citability');
      expect(message.siteId).to.equal('site-123');
      expect(message.auditContext.urls).to.deep.equal([
        'https://example.com/page1',
        'https://example.com/page2',
        'https://example.com/page3',
      ]);

      expect(slackContext.say).to.have.been.calledWith(':white_check_mark: page-citability audit queued for 3 URLs.');
    });

    it('filters out invalid URLs from CSV', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-123' });
      slackContext.files = [
        { name: 'urls.csv', url_private: 'https://slack.com/files/urls.csv' },
      ];

      nock('https://slack.com')
        .get('/files/urls.csv')
        .reply(200, 'https://example.com/page1\ninvalid-url\nhttps://example.com/page2');

      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(sqsStub.sendMessage).to.have.been.calledOnce;
      const [, message] = sqsStub.sendMessage.firstCall.args;
      expect(message.auditContext.urls).to.deep.equal([
        'https://example.com/page1',
        'https://example.com/page2',
      ]);
      expect(slackContext.say).to.have.been.calledWith(':white_check_mark: page-citability audit queued for 2 URLs.');
    });

    it('shows warning when no valid URLs found in CSV', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-123' });
      slackContext.files = [
        { name: 'urls.csv', url_private: 'https://slack.com/files/urls.csv' },
      ];

      nock('https://slack.com')
        .get('/files/urls.csv')
        .reply(200, 'invalid-url-1\ninvalid-url-2');

      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say.calledWith(':warning: No valid URLs found in the CSV file.')).to.be.true;
      expect(sqsStub.sendMessage).to.not.have.been.called;
    });

    it('handles Slack-formatted URLs', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-123' });
      slackContext.files = [
        { name: 'urls.csv', url_private: 'https://slack.com/files/urls.csv' },
      ];

      nock('https://slack.com')
        .get('/files/urls.csv')
        .reply(200, 'https://example.com/page1\nhttps://example.com/page2');

      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['<https://example.com|example.com>'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':adobe-run: Triggering page-citability audit for site https://example.com with 2 URLs...');
      expect(sqsStub.sendMessage).to.have.been.calledOnce;
    });

    it('handles errors when fetching CSV fails', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-123' });
      slackContext.files = [
        { name: 'urls.csv', url_private: 'https://slack.com/files/urls.csv' },
      ];

      nock('https://slack.com')
        .get('/files/urls.csv')
        .reply(401, 'Unauthorized');

      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':nuclear-warning: Oops! Something went wrong: CSV processing failed: Authentication failed: Invalid Slack token.');
    });

    it('handles errors when site lookup fails', async () => {
      dataAccessStub.Site.findByBaseURL.rejects(new Error('Database error'));
      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':nuclear-warning: Oops! Something went wrong: Database error');
      expect(context.log.error).to.have.been.called;
    });

    it('handles errors when sending SQS message fails', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-123' });
      slackContext.files = [
        { name: 'urls.csv', url_private: 'https://slack.com/files/urls.csv' },
      ];
      sqsStub.sendMessage.rejects(new Error('SQS error'));

      nock('https://slack.com')
        .get('/files/urls.csv')
        .reply(200, 'https://example.com/page1');

      const command = RunPageCitabilityCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':nuclear-warning: Oops! Something went wrong: SQS error');
      expect(context.log.error).to.have.been.called;
    });
  });
});
