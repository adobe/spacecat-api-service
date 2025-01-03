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

/* eslint-env mocha */

import { expect } from 'chai';
import nock from 'nock';
import sinon from 'sinon';

import AddRepoCommand from '../../../../src/support/slack/commands/add-repo.js';

describe('AddRepoCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let siteStub;

  beforeEach(() => {
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };

    slackContext = { say: sinon.spy() };

    siteStub = {
      getId: sinon.stub().returns('some-id'),
      getDeliveryType: sinon.stub().returns('aem_edge'),
      getBaseURL: sinon.stub(),
      getGitHubURL: sinon.stub(),
      getIsLive: sinon.stub(),
      updateGitHubURL: sinon.stub(),
      getAuditConfig: sinon.stub().returns({
        auditsDisabled: sinon.stub().returns(false),
        getAuditTypeConfig: sinon.stub().returns({
          disabled: sinon.stub().returns(false),
        }),
      }),
      setGitHubURL: sinon.stub(),
      save: sinon.stub(),
    };

    const configuration = {
      isHandlerEnabledForSite: sinon.stub().returns(true),
    };

    dataAccessStub = {
      Configuration: {
        findLatest: sinon.stub().resolves(configuration),
      },
      Site: {
        findByBaseURL: sinon.stub().resolves(siteStub),
      },
    };

    context = {
      dataAccess: dataAccessStub,
      sqs: sqsStub,
      env: { AUDIT_JOBS_QUEUE_URL: 'testQueueUrl' },
      log: console,
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('initializes correctly with base command properties', () => {
    const addRepoCommand = AddRepoCommand(context);
    expect(addRepoCommand.id).to.equal('add-github-repo');
    expect(addRepoCommand.name).to.equal('Add GitHub Repo');
    expect(addRepoCommand.description).to.equal('Adds a Github repository to previously added site.');
    expect(addRepoCommand.phrases).to.deep.equal(['add repo', 'save repo', 'add repo by site']);
  });

  describe('Handle Execution Method', () => {
    it('handles valid input and updates the site', async () => {
      nock('https://api.github.com')
        .get('/repos/valid/repo')
        .reply(200, { archived: false });

      const args = ['validSite.com', 'https://github.com/valid/repo'];
      const command = AddRepoCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles archived repository', async () => {
      nock('https://api.github.com')
        .get('/repos/valid/repo')
        .reply(200, { archived: true });

      const args = ['validSite.com', 'https://github.com/valid/repo'];
      const command = AddRepoCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: The GitHub repository \'https://github.com/valid/repo\' is archived. Please unarchive it before adding it to a site.')).to.be.true;
    });

    it('handles repo URL without scheme', async () => {
      nock('https://api.github.com')
        .get('/repos/valid/repo')
        .reply(200, { archived: false });

      const args = ['validSite.com', 'github.com/valid/repo'];
      const command = AddRepoCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith('\n'
        + '      :white_check_mark: *GitHub repo added for <undefined|undefined>*\n'
        + '      \n'
        + '\n'
        + '      :identification_card: some-id\n'
        + '      :cat-egory-white: aem_edge\n'
        + '      :github-4173: _not set_\n'
        + '      :submarine: Is not live\n'
        + '      :lighthouse: <https://psi.experiencecloud.live?url=undefined&strategy=mobile|Run PSI Check>\n'
        + '    \n'
        + '      \n'
        + '      First PSI check with new repo is triggered! :adobe-run:\n'
        + '      ')).to.be.true;
    });

    it('handles missing site URL', async () => {
      const args = [];
      const command = AddRepoCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(command.usage())).to.be.true;
    });

    it('handles missing GitHub URL', async () => {
      const args = ['validSite.com'];
      const command = AddRepoCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(command.usage())).to.be.true;
    });

    it('handles invalid GitHub repository URL', async () => {
      const args = ['validSite.com', 'invalidRepoURL.com'];
      const command = AddRepoCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: \'https://invalidrepourl.com\' is not a valid GitHub repository URL.')).to.be.true;
    });

    it('handles site not found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const args = ['validSite.com', 'https://github.com/valid/repo'];
      const command = AddRepoCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':x: No site found with base URL \'https://validsite.com\'.')).to.be.true;
    });
  });

  describe('Fetch Repo Info Method', () => {
    let command;
    let args;

    beforeEach(() => {
      command = AddRepoCommand(context);
      args = ['validSite.com', 'https://github.com/valid/repo'];
    });

    it('fetches repository information successfully', async () => {
      nock('https://api.github.com')
        .get('/repos/valid/repo')
        .reply(200, { name: 'repoName', archived: false });

      await command.handleExecution(args, slackContext);

      // Assertions to confirm repo info was fetched and handled correctly
      expect(slackContext.say.calledWithMatch(/GitHub repo added/)).to.be.true;
    });

    it('handles non-existent repository (404 error)', async () => {
      nock('https://api.github.com')
        .get('/repos/invalid/repo')
        .reply(404);

      args[1] = 'https://github.com/invalid/repo';
      await command.handleExecution(args, slackContext);

      // Assertions to confirm handling of non-existent repository
      expect(slackContext.say.calledWith(':warning: The GitHub repository \'https://github.com/invalid/repo\' could not be found (private repo?).')).to.be.true;
    });

    it('handles errors other than 404 from GitHub API', async () => {
      nock('https://api.github.com')
        .get('/repos/error/repo')
        .reply(500, { message: 'Internal Server Error' });

      args[1] = 'https://github.com/error/repo';
      await command.handleExecution(args, slackContext);

      // Assertions to confirm handling of other errors
      expect(slackContext.say.calledWithMatch(/Failed to fetch GitHub repository/)).to.be.true;
    });

    it('handles network issues or no response scenarios', async () => {
      nock('https://api.github.com')
        .get('/repos/network-issue/repo')
        .replyWithError('Network error occurred');

      args[1] = 'https://github.com/network-issue/repo';
      await command.handleExecution(args, slackContext);

      // Assertions to confirm handling of network issues
      expect(slackContext.say.calledWithMatch(/Network error occurred/)).to.be.true;
    });
  });
});
