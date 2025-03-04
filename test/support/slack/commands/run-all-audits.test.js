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
import nock from 'nock';
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

    it('triggers all audits for all sites specified in a CSV file', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.Configuration.findLatest.resolves({
        getEnabledAuditsForSite: () => ['lhs-mobile', 'lhs-desktop'],
      });
      const fileUrl = 'https://example.com/sites.csv';
      slackContext.files = [
        {
          name: 'sites.csv',
          url_private: fileUrl,
        },
      ];
      nock(fileUrl)
        .get('')
        .reply(200, 'https://site.com,uuidv4\n'
          + 'https://valid.url,uuidv4');

      const command = RunAllAuditsCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.equal(':white_check_mark: All audits triggered successfully.');
      expect(sqsStub.sendMessage.called).to.be.true;
    });
  });

  it('handles wrong usage', async () => {
    const command = RunAllAuditsCommand(context);
    await command.handleExecution([], slackContext);
    expect(slackContext.say.calledWith(command.usage())).to.be.true;
  });

  it('handles both site URL and CSV file', async () => {
    const command = RunAllAuditsCommand(context);
    slackContext.files = [
      {
        name: 'sites.csv',
        url_private: 'https://example.com/sites.csv',
      },
    ];
    await command.handleExecution(['site.com'], slackContext);
    expect(slackContext.say.calledWith(':warning: Please provide either a baseURL or a CSV file with a list of site URLs.')).to.be.true;
  });

  it('handles multiple CSV files', async () => {
    const command = RunAllAuditsCommand(context);
    slackContext.files = [
      {
        name: 'sites1.csv',
        url_private: 'https://example.com/sites1.csv',
      },
      {
        name: 'sites2.csv',
        url_private: 'https://example.com/sites2.csv',
      },
    ];
    await command.handleExecution([], slackContext);
    expect(slackContext.say.calledWith(':warning: Please provide only one CSV file.')).to.be.true;
  });

  it('handles non-CSV file', async () => {
    const command = RunAllAuditsCommand(context);
    slackContext.files = [
      {
        name: 'sites.txt',
        url_private: 'https://example.com/sites.txt',
      },
    ];
    await command.handleExecution([], slackContext);
    expect(slackContext.say.calledWith(':warning: Please provide a CSV file.')).to.be.true;
  });

  it('handles CSV file with no data', async () => {
    const command = RunAllAuditsCommand(context);
    slackContext.files = [
      {
        name: 'sites.csv',
        url_private: 'https://example.com/sites.csv',
      },
    ];
    nock('https://example.com')
      .get('/sites.csv')
      .reply(200, 'invalid-url,uuidv4\n');

    await command.handleExecution([], slackContext);
    expect(slackContext.say.calledWith(':warning: Invalid URL found in CSV file: invalid-url')).to.be.true;
  });

  it('handles site with no enable audits', async () => {
    dataAccessStub.Site.findByBaseURL.resolves({
      getId: () => '123',
    });
    dataAccessStub.Configuration.findLatest.resolves({
      getEnabledAuditsForSite: () => [],
    });

    const command = RunAllAuditsCommand(context);
    await command.handleExecution(['validsite.com'], slackContext);

    expect(slackContext.say.called).to.be.true;
    expect(slackContext.say.firstCall.args[0]).to.equal(':warning: No audits configured for site `https://validsite.com`');
  });

  it('handles error while triggering audits', async () => {
    const errorMessage = 'Failed to send message';
    dataAccessStub.Site.findByBaseURL.resolves({
      getId: () => '123',
    });
    dataAccessStub.Configuration.findLatest.resolves({
      getEnabledAuditsForSite: () => ['lhs-mobile', 'lhs-desktop'],
    });
    sqsStub.sendMessage.rejects(new Error(errorMessage));

    const command = RunAllAuditsCommand(context);
    await command.handleExecution(['validsite.com'], slackContext);

    expect(slackContext.say.called).to.be.true;
    expect(slackContext.say.firstCall.args[0]).to.equal(`:nuclear-warning: Oops! Something went wrong: ${errorMessage}`);
  });

  it('handles error when site cannot be found', async () => {
    const errorMessage = 'Invalid site URL';
    dataAccessStub.Site.findByBaseURL.rejects(new Error(errorMessage));
    const command = RunAllAuditsCommand(context);
    await command.handleExecution(['invalidsite.com'], slackContext);
    expect(slackContext.say.calledWith(`:nuclear-warning: Oops! Something went wrong: ${errorMessage}`)).to.be.true;
  });
});
