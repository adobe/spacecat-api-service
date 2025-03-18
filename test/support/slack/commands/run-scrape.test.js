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
import nock from 'nock';

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
      expect(command.description).to.include('Runs the specified scrape type for the provided base URL or a list of URLs provided in a CSV file');
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
      expect(context.log.info.firstCall.args[0]).to.include('Found top pages for site `https://example.com`');
      expect(slackContext.say.firstCall.args[0]).to.include(':adobe-run: Triggering scrape run for site `https://example.com`');
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

    it('handles both site URL and CSV file', async () => {
      const command = RunScrapeCommand(context);
      slackContext.files = [
        {
          name: 'sites.csv',
          url_private: 'https://example.com/sites.csv',
        },
      ];

      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide either a baseURL or a CSV file with a list of site URLs.')).to.be.true;
    });

    it('handles multiple CSV files', async () => {
      const command = RunScrapeCommand(context);
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
      const command = RunScrapeCommand(context);
      slackContext.files = [
        {
          name: 'sites.txt',
          url_private: 'https://example.com/sites.txt',
        },
      ];

      await command.handleExecution([], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a CSV file.')).to.be.true;
    });

    it('triggers scrapes for all sites in the CSV file', async () => {
      const fileUrl = 'https://example.com/sites.csv';
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
        getSiteTopPagesBySourceAndGeo: sinon.stub().resolves([
          { getUrl: () => 'https://site.com' },
          { getUrl: () => 'https://valid.url' },
        ]),
      });
      dataAccessStub.Configuration.findLatest.resolves({
        getEnabledAuditsForSite: () => ['lhs-mobile', 'lhs-desktop'],
      });
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

      const command = RunScrapeCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say.calledWith(':adobe-run: Triggering scrape run for 2 sites.')).to.be.true;
    });

    it('handles failing scrape for a site in the CSV file', async () => {
      const fileUrl = 'https://example.com/sites.csv';
      dataAccessStub.Site.findByBaseURL.onCall(0).resolves({
        getId: () => '123',
        getSiteTopPagesBySourceAndGeo: sinon.stub().resolves([
          { getUrl: () => 'https://site.com' },
          { getUrl: () => 'https://valid.url' },
        ]),
      });
      dataAccessStub.Site.findByBaseURL.onCall(1).rejects(new Error('Test Error'));
      dataAccessStub.Configuration.findLatest.resolves({
        getEnabledAuditsForSite: () => ['lhs-mobile', 'lhs-desktop'],
      });
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

      const command = RunScrapeCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say.calledWith(':warning: Failed scrape for `https://valid.url`: Test Error')).to.be.true;
    });
  });
});
