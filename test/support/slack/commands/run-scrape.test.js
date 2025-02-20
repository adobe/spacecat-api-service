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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import RunScrapeCommand from '../../../../src/support/slack/commands/run-scrape.js';

use(sinonChai);

describe('RunScrapeCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let logStub;
  let sqsStub;

  beforeEach(() => {
    dataAccessStub = {
      Configuration: {
        findLatest: sinon.stub(),
      },
      Site: {
        findByBaseURL: sinon.stub(),
      },
    };
    const getConfigStub = {
      getSlackRoles: sinon.stub().returns({
        admin: ['USER123'],
        scrape: ['USER123'],
      }),
    };
    dataAccessStub.Configuration.findLatest.returns(getConfigStub);
    logStub = {
      info: sinon.stub(),
      error: sinon.stub(),
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    context = {
      dataAccess: dataAccessStub,
      log: logStub,
      sqs: sqsStub,
      env: { SCRAPING_JOBS_QUEUE_URL: 'https://example.com' },
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
    it('handles null result from SiteTopPage.allBySiteId', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
        getSiteTopPagesBySourceAndGeo: sinon.stub().resolves(null),
      });
      const command = RunScrapeCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);
      expect(slackContext.say.calledWith(':warning: No top pages found for site `https://example.com`')).to.be.true;
    });

    it('handles empty array result from SiteTopPage.allBySiteId', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
        getSiteTopPagesBySourceAndGeo: sinon.stub().resolves([]),
      });
      const command = RunScrapeCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);
      expect(slackContext.say.calledWith(':warning: No top pages found for site `https://example.com`')).to.be.true;
    });

    it('parses SLACK_IDS_RUN_IMPORT correctly when present', async () => {
      dataAccessStub.Configuration.findLatest.resolves({ getSlackRoles: () => ({ scrape: ['USER123', 'USER456'] }) });
      const command = RunScrapeCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);
      expect(slackContext.say.calledWith(':error: Only members of role "scrape" can run this command.')).to.be.false;
    });

    it('triggers a scrape for a valid site with top pages', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
        getSiteTopPagesBySourceAndGeo: sinon.stub().resolves([
          { getUrl: () => 'https://example.com/page1' },
          { getUrl: () => 'https://example.com/page2' },
        ]),
      });

      const command = RunScrapeCommand(context);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(':white_check_mark: Found top pages for site `https://example.com`');
      expect(slackContext.say.secondCall.args[0]).to.include(':adobe-run: Triggering scrape run for site `https://example.com`');
      expect(slackContext.say.thirdCall.args[0]).to.include('white_check_mark: Completed triggering scrape runs for site `https://example.com` — Total URLs: 2');
    });

    /* todo: uncomment after summit and back-office-UI support
      for configuration setting (roles)
    it('does not trigger a scrape when user is not authorized', async () => {
      slackContext.user = 'UNAUTHORIZED_USER';
      const command = RunScrapeCommand(context);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWith(':error: Only members of role
      "scrape" can run this command.')).to.be.true;
    });
    */

    it('responds with a warning for an invalid site url', async () => {
      const command = RunScrapeCommand(context);

      await command.handleExecution([''], slackContext);

      expect(slackContext.say.calledWith(sinon.match('Usage:'))).to.be.true;
    });

    it('informs user if no top pages are found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
        getSiteTopPagesBySourceAndGeo: sinon.stub().resolves([]),
      });

      const command = RunScrapeCommand(context);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWith(':warning: No top pages found for site `https://example.com`')).to.be.true;
    });

    it('informs user if the site was not found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);
      const command = RunScrapeCommand(context);

      await command.handleExecution(['https://unknownsite.com'], slackContext);

      expect(slackContext.say.calledWith(sinon.match(':x: No site found with base URL \'https://unknownsite.com\'.'))).to.be.true;
    });

    it('informs user when error occurs', async () => {
      dataAccessStub.Site.findByBaseURL.rejects(new Error('Test Error'));
      const command = RunScrapeCommand(context);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(logStub.error.called).to.be.true;
      expect(slackContext.say.calledWith(sinon.match('Oops! Something went wrong'))).to.be.true;
    });
  });
});
