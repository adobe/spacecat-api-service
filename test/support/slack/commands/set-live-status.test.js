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

import SetLiveStatusCommand from '../../../../src/support/slack/commands/set-live-status.js';

describe('SetLiveStatusCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;

  beforeEach(() => {
    dataAccessStub = {
      getSiteByBaseURL: sinon.stub(),
      updateSite: sinon.stub(),
    };
    context = { dataAccess: dataAccessStub, log: console };
    slackContext = { say: sinon.spy() };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = SetLiveStatusCommand(context);
      expect(command.id).to.equal('set-live-status');
      expect(command.name).to.equal('Toggle Live Status');
      expect(command.description).to.equal('Toggles a site\'s "isLive" flag.');
      expect(command.phrases).to.deep.equal(['toggle live status']);
    });
  });

  describe('Handle Execution Method', () => {
    it('toggles live status for a live site', async () => {
      const mockSite = {
        toggleLive: sinon.spy(),
        isLive: sinon.stub().returns(true),
      };
      dataAccessStub.getSiteByBaseURL.resolves(mockSite);

      const command = SetLiveStatusCommand(context);

      await command.handleExecution(['validsite.com'], slackContext);

      expect(dataAccessStub.getSiteByBaseURL.calledWith('https://validsite.com')).to.be.true;
      expect(mockSite.toggleLive.calledOnce).to.be.true;
      expect(dataAccessStub.updateSite.calledWith(mockSite)).to.be.true;
      expect(slackContext.say.calledWithMatch(/Successfully updated the live status/)).to.be.true;
    });

    it('toggles live status for a non-live site', async () => {
      const mockSite = {
        toggleLive: sinon.spy(),
        isLive: sinon.stub().returns(false),
      };
      dataAccessStub.getSiteByBaseURL.resolves(mockSite);

      const command = SetLiveStatusCommand(context);

      await command.handleExecution(['validsite.com'], slackContext);

      expect(dataAccessStub.getSiteByBaseURL.calledWith('https://validsite.com')).to.be.true;
      expect(mockSite.toggleLive.calledOnce).to.be.true;
      expect(dataAccessStub.updateSite.calledWith(mockSite)).to.be.true;
      expect(slackContext.say.calledWithMatch(/Successfully updated the live status/)).to.be.true;
    });

    it('informs user if the site base URL is invalid', async () => {
      const command = SetLiveStatusCommand(context);

      await command.handleExecution([''], slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid site base URL.')).to.be.true;
    });

    it('informs user if no site found with the given base URL', async () => {
      dataAccessStub.getSiteByBaseURL.resolves(null);

      const command = SetLiveStatusCommand(context);

      await command.handleExecution(['unknownsite.com'], slackContext);

      expect(slackContext.say.calledWith(":x: No site found with base URL 'https://unknownsite.com'.")).to.be.true;
    });

    it('handles errors during execution', async () => {
      dataAccessStub.getSiteByBaseURL.throws(new Error('Test Error'));

      const command = SetLiveStatusCommand(context);

      await command.handleExecution(['validsite.com'], slackContext);

      expect(slackContext.say.calledWithMatch(':nuclear-warning: Oops! Something went wrong: Test Error')).to.be.true;
    });
  });
});
