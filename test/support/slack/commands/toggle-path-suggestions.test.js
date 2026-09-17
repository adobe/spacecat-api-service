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
import esmock from 'esmock';

use(sinonChai);

describe('TogglePathSuggestionsCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let TogglePathSuggestionsCommand;
  let toDynamoItemStub;

  beforeEach(async () => {
    toDynamoItemStub = sinon.stub().returns({ handlers: {} });

    TogglePathSuggestionsCommand = await esmock(
      '../../../../src/support/slack/commands/toggle-path-suggestions.js',
      {
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: { toDynamoItem: toDynamoItemStub },
        },
      },
    );

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
      const command = TogglePathSuggestionsCommand(context);
      expect(command.id).to.equal('toggle-path-suggestions');
      expect(command.name).to.equal('Enable/Disable Path-Level Suggestions');
      expect(command.phrases).to.deep.equal(['path-suggestions']);
    });
  });

  describe('Handle Execution Method', () => {
    it('enables path suggestions for a site by URL', async () => {
      const mockConfig = {
        getHandlers: sinon.stub().returns({}),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
        setConfig: sinon.stub(),
        save: sinon.stub(),
      };
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const command = TogglePathSuggestionsCommand(context);

      await command.handleExecution(['enable', 'example.com'], slackContext);

      expect(dataAccessStub.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(mockSite.setConfig).to.have.been.calledOnce;
      const setConfigArg = mockSite.setConfig.firstCall.args[0];
      expect(setConfigArg.handlers.prerender.pathSuggestionsEnabled).to.equal(true);
      expect(mockSite.save).to.have.been.calledOnce;
      expect(slackContext.say).to.have.been.calledWithMatch(/enabled/);
    });

    it('disables path suggestions for a site by URL', async () => {
      const mockConfig = {
        getHandlers: sinon.stub().returns({
          prerender: { pathSuggestionsEnabled: true, someOtherSetting: 'value' },
        }),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
        setConfig: sinon.stub(),
        save: sinon.stub(),
      };
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const command = TogglePathSuggestionsCommand(context);

      await command.handleExecution(['disable', 'example.com'], slackContext);

      const setConfigArg = mockSite.setConfig.firstCall.args[0];
      expect(setConfigArg.handlers.prerender.pathSuggestionsEnabled).to.equal(false);
      expect(setConfigArg.handlers.prerender.someOtherSetting).to.equal('value');
      expect(slackContext.say).to.have.been.calledWithMatch(/disabled/);
    });

    it('looks up site by ID when input is not a valid URL', async () => {
      const mockConfig = {
        getHandlers: sinon.stub().returns({}),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
        setConfig: sinon.stub(),
        save: sinon.stub(),
      };
      dataAccessStub.Site.findById.resolves(mockSite);

      const command = TogglePathSuggestionsCommand(context);

      await command.handleExecution(['enable', 'some-site-id'], slackContext);

      expect(dataAccessStub.Site.findById).to.have.been.calledWith('some-site-id');
      expect(dataAccessStub.Site.findByBaseURL).to.not.have.been.called;
    });

    it('warns when action is missing', async () => {
      const command = TogglePathSuggestionsCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':warning: Please specify `enable` or `disable`.');
    });

    it('warns when action is invalid', async () => {
      const command = TogglePathSuggestionsCommand(context);

      await command.handleExecution(['toggle', 'example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':warning: Please specify `enable` or `disable`.');
    });

    it('warns when site input is missing', async () => {
      const command = TogglePathSuggestionsCommand(context);

      await command.handleExecution(['enable'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':warning: Please provide a valid site base URL.');
    });

    it('reports site not found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const command = TogglePathSuggestionsCommand(context);

      await command.handleExecution(['enable', 'unknownsite.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/No site found/);
    });

    it('preserves existing handler configs when enabling', async () => {
      const mockConfig = {
        getHandlers: sinon.stub().returns({
          'broken-backlinks': { excludedURLs: ['/test'] },
          prerender: { someExisting: true },
        }),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
        setConfig: sinon.stub(),
        save: sinon.stub(),
      };
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const command = TogglePathSuggestionsCommand(context);

      await command.handleExecution(['enable', 'example.com'], slackContext);

      const setConfigArg = mockSite.setConfig.firstCall.args[0];
      expect(setConfigArg.handlers['broken-backlinks']).to.deep.equal({ excludedURLs: ['/test'] });
      expect(setConfigArg.handlers.prerender.someExisting).to.equal(true);
      expect(setConfigArg.handlers.prerender.pathSuggestionsEnabled).to.equal(true);
    });

    it('handles null handlers gracefully', async () => {
      const mockConfig = {
        getHandlers: sinon.stub().returns(null),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
        setConfig: sinon.stub(),
        save: sinon.stub(),
      };
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const command = TogglePathSuggestionsCommand(context);

      await command.handleExecution(['enable', 'example.com'], slackContext);

      const setConfigArg = mockSite.setConfig.firstCall.args[0];
      expect(setConfigArg.handlers.prerender.pathSuggestionsEnabled).to.equal(true);
    });

    it('handles errors during execution', async () => {
      dataAccessStub.Site.findByBaseURL.throws(new Error('Test Error'));

      const command = TogglePathSuggestionsCommand(context);

      await command.handleExecution(['enable', 'example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/Oops! Something went wrong: Test Error/);
    });
  });
});
