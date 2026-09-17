/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import GetPathSuggestionsStatusCommand from '../../../../src/support/slack/commands/get-path-suggestions-status.js';

use(sinonChai);

describe('GetPathSuggestionsStatusCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;

  beforeEach(() => {
    dataAccessStub = {
      Site: {
        findByBaseURL: sinon.stub(),
        findById: sinon.stub(),
      },
    };
    context = { dataAccess: dataAccessStub, log: { error: sinon.stub() } };
    slackContext = { say: sinon.spy() };
  });

  describe('Initialization', () => {
    it('initializes correctly with base command properties', () => {
      const command = GetPathSuggestionsStatusCommand(context);
      expect(command.id).to.equal('get-path-suggestions-status');
      expect(command.name).to.equal('Get Path-Level Suggestions Status');
      expect(command.phrases).to.deep.equal(['get path-suggestions']);
    });
  });

  describe('Handle Execution Method', () => {
    it('reports enabled status when pathSuggestionsEnabled is true', async () => {
      const mockConfig = {
        getHandlerConfig: sinon.stub().withArgs('prerender').returns({
          pathSuggestionsEnabled: true,
        }),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
      };
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const command = GetPathSuggestionsStatusCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(dataAccessStub.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(slackContext.say).to.have.been.calledWithMatch(/enabled/);
      expect(slackContext.say).to.have.been.calledWithMatch(/large_green_circle/);
    });

    it('reports disabled status when pathSuggestionsEnabled is false', async () => {
      const mockConfig = {
        getHandlerConfig: sinon.stub().withArgs('prerender').returns({
          pathSuggestionsEnabled: false,
        }),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
      };
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const command = GetPathSuggestionsStatusCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/disabled/);
      expect(slackContext.say).to.have.been.calledWithMatch(/red_circle/);
    });

    it('reports disabled when prerender config is missing', async () => {
      const mockConfig = {
        getHandlerConfig: sinon.stub().withArgs('prerender').returns(null),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
      };
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const command = GetPathSuggestionsStatusCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/disabled/);
    });

    it('reports disabled when pathSuggestionsEnabled is not set', async () => {
      const mockConfig = {
        getHandlerConfig: sinon.stub().withArgs('prerender').returns({}),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
      };
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const command = GetPathSuggestionsStatusCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/disabled/);
    });

    it('looks up site by ID when input is not a valid URL', async () => {
      const mockConfig = {
        getHandlerConfig: sinon.stub().returns({}),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
      };
      dataAccessStub.Site.findById.resolves(mockSite);

      const command = GetPathSuggestionsStatusCommand(context);

      await command.handleExecution(['some-site-id'], slackContext);

      expect(dataAccessStub.Site.findById).to.have.been.calledWith('some-site-id');
      expect(dataAccessStub.Site.findByBaseURL).to.not.have.been.called;
    });

    it('warns when site input is missing', async () => {
      const command = GetPathSuggestionsStatusCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':warning: Please provide a valid site base URL.');
    });

    it('reports site not found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const command = GetPathSuggestionsStatusCommand(context);

      await command.handleExecution(['unknownsite.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/No site found/);
    });

    it('handles errors during execution', async () => {
      dataAccessStub.Site.findByBaseURL.throws(new Error('Test Error'));

      const command = GetPathSuggestionsStatusCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/Oops! Something went wrong: Test Error/);
    });
  });
});
