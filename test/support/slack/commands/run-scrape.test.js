/*
 * Copyright 2023 Adobe. All rights reserved.
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

import { expect } from 'chai';
import sinon from 'sinon';

import RunScrapeCommand from '../../../../src/support/slack/commands/run-scrape.js';

describe('RunScrapeCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let logStub;
  let sqsStub;

  beforeEach(() => {
    dataAccessStub = {
      getSiteByBaseURL: sinon.stub(),
      getTopPagesForSite: sinon.stub(),
    };
    logStub = {
      error: sinon.stub(),
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    context = {
      dataAccess: dataAccessStub,
      log: logStub,
      sqs: sqsStub,
      env: { SLACK_IDS_RUN_IMPORT: JSON.stringify(['USER123']) },
    };
    slackContext = {
      say: sinon.spy(),
      user: 'USER123',
    };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = RunScrapeCommand(context);
      expect(command.id).to.equal('run-scrape');
      expect(command.name).to.equal('Run Scrape');
      expect(command.description).to.include('Runs the specified scrape type for the site identified with its id');
    });
  });

  describe('Handle Execution Method', () => {
    it('triggers a scrape for a valid site with top pages', async () => {
      dataAccessStub.getSiteByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.getTopPagesForSite.resolves([
        { getURL: () => 'https://example.com/page1' },
        { getURL: () => 'https://example.com/page2' },
      ]);
      const command = RunScrapeCommand(context);

      await command.handleExecution(['https://example.com', '2023-01-01', '2023-12-31'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':white_check_mark: Found top pages for site `https://example.com`');
      expect(slackContext.say.secondCall.args[0]).to.include(':adobe-run: Triggered scrape run for site `https://example.com`');
    });

    it('does not trigger a scrape when user is not authorized', async () => {
      slackContext.user = 'UNAUTHORIZED_USER';
      const command = RunScrapeCommand(context);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWith(':error: Only selected SpaceCat fluid team members can run scraper.')).to.be.true;
    });

    it('responds with a warning for an invalid site url', async () => {
      const command = RunScrapeCommand(context);

      await command.handleExecution([''], slackContext);

      expect(slackContext.say.calledWith(sinon.match('Usage:'))).to.be.true;
    });

    it('informs user if no top pages are found', async () => {
      dataAccessStub.getSiteByBaseURL.resolves({
        getId: () => '123',
      });
      dataAccessStub.getTopPagesForSite.resolves([]);
      const command = RunScrapeCommand(context);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWith(':warning: No top pages found for site `https://example.com`')).to.be.true;
    });

    it('informs user if the site was not found', async () => {
      dataAccessStub.getSiteByBaseURL.resolves(null);
      const command = RunScrapeCommand(context);

      await command.handleExecution(['https://unknownsite.com'], slackContext);

      expect(slackContext.say.calledWith(sinon.match(':x: No site found with base URL \'https://unknownsite.com\'.'))).to.be.true;
    });

    it('informs user when error occurs', async () => {
      dataAccessStub.getSiteByBaseURL.rejects(new Error('Test Error'));
      const command = RunScrapeCommand(context);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(logStub.error.called).to.be.true;
      expect(slackContext.say.calledWith(sinon.match('Oops! Something went wrong'))).to.be.true;
    });
  });
});
