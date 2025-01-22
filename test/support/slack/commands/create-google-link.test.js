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

import sinon from 'sinon';
import { expect } from 'chai';
import CreateGoogleLinkCommand from '../../../../src/support/slack/commands/create-google-link.js';

describe('CreateGoogleLinkCommand', () => {
  let context;
  let site;
  let slackContext;
  let dataAccessStub;

  beforeEach(() => {
    site = {
      getId: () => '123',
      getDeliveryType: () => 'aem_edge',
      getBaseURL: () => 'space.cat',
      getGitHubURL: () => '',
      getIsLive: () => true,
      getIsLiveToggledAt: () => '2014-10-17T13:44:00.000Z',
    };

    dataAccessStub = {
      Site: {
        create: sinon.stub(),
        findByBaseURL: sinon.stub().resolves(site),
      },
    };

    context = { dataAccess: dataAccessStub, log: console };
    slackContext = { say: sinon.spy() };
  });

  describe('Initialization and BaseCommand integration', () => {
    it('handles valid input and compiles the google link command correctly', async () => {
      const command = CreateGoogleLinkCommand(context);
      expect(command.id)
        .to
        .equal('create-google-link');
      expect(command.name)
        .to
        .equal('Create Google Authentication Link');
      expect(command.description)
        .to
        .equal('Creates a Google authentication link for the specified site.'
          + '\n This link can be sent to a customer to obtain Google Search Console API access.');
      expect(command.phrases)
        .to
        .deep
        .equal(['get google auth link']);
    });
  });

  describe('handle execution', async () => {
    it('handles valid input and returns valid message', async () => {
      const args = ['space.cat'];
      const command = CreateGoogleLinkCommand(context);
      await command.handleExecution(args, slackContext);
      expect(dataAccessStub.Site.findByBaseURL.calledWith('https://space.cat')).to.be.true;
      expect(slackContext.say.calledWith('https://spacecat.experiencecloud.live/api/v1/auth/google/123')).to.be.true;
    });

    it('handles valid input and returns valid message for dev version', async () => {
      context.func = { version: 'ci123' };
      const args = ['space.cat'];
      const command = CreateGoogleLinkCommand(context);
      await command.handleExecution(args, slackContext);
      expect(dataAccessStub.Site.findByBaseURL.calledWith('https://space.cat')).to.be.true;
      expect(slackContext.say.calledWith('https://spacecat.experiencecloud.live/api/ci/auth/google/123')).to.be.true;
    });

    it('responds with usage instructions for invalid input', async () => {
      const args = [''];
      const command = CreateGoogleLinkCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith('Usage: _get google auth link {baseURL}_')).to.be.true;
    });

    it('notifies when no site is found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const args = ['nonexistent.com'];
      const command = CreateGoogleLinkCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':x: No site found with base URL \'https://nonexistent.com\'.')).to.be.true;
    });

    it('notifies when an error occurs', async () => {
      dataAccessStub.Site.findByBaseURL.rejects(new Error('Test error'));

      const args = ['nonexistent.com'];
      const command = CreateGoogleLinkCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: Test error')).to.be.true;
    });
  });
});
