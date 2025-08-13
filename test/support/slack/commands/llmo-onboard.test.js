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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import LlmoOnboardCommand from '../../../../src/support/slack/commands/llmo-onboard.js';

use(sinonChai);

describe('LlmoOnboardCommand', () => {
  let command;
  let mockContext;
  let mockSite;
  let mockConfig;
  let mockDataAccess;
  let mockLog;
  let slackContext;

  beforeEach(() => {
    // Create mock config
    mockConfig = {
      getLlmoConfig: sinon.stub().returns(null),
      toJSON: sinon.stub().returns({}),
      getSlackConfig: sinon.stub().returns(null),
      getHandlers: sinon.stub().returns({}),
      getHandlerConfig: sinon.stub().returns({}),
      getContentAiConfig: sinon.stub().returns({}),
      getImports: sinon.stub().returns([]),
      getCdnLogsConfig: sinon.stub().returns({}),
    };

    // Create mock site
    mockSite = {
      getId: sinon.stub().returns('test-site-id'),
      getConfig: sinon.stub().returns(mockConfig),
      setConfig: sinon.stub(),
      save: sinon.stub().resolves(),
    };

    // Create mock data access
    mockDataAccess = {
      Site: {
        findByBaseURL: sinon.stub().resolves(mockSite),
      },
    };

    // Create mock log
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
    };

    // Create mock context
    mockContext = {
      dataAccess: mockDataAccess,
      log: mockLog,
    };

    // Create slack context
    slackContext = {
      say: sinon.stub(),
    };

    command = LlmoOnboardCommand(mockContext);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Command Properties', () => {
    it('should have correct id and phrases', () => {
      expect(command.id).to.equal('onboard-llmo');
      expect(command.phrases).to.deep.equal(['onboard-llmo']);
      expect(command.name).to.equal('Onboard LLMO');
    });

    it('should accept the onboard-llmo phrase', () => {
      expect(command.accepts('onboard-llmo')).to.be.true;
      expect(command.accepts('onboard-llmo https://example.com')).to.be.true;
      expect(command.accepts('other command')).to.be.false;
    });
  });

  describe('Handle Execution Method', () => {
    it('should show usage when insufficient arguments provided', async () => {
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        ':warning: Missing required arguments. Please provide: `baseURL`, `dataFolder`, and `brandName`.',
      );
    });

    it('should reject invalid URLs', async () => {
      await command.handleExecution(['invalid-url', 'adobe', 'Adobe'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        ':warning: Please provide a valid site base URL.',
      );
    });

    it('should reject empty brand name', async () => {
      await command.handleExecution(['https://example.com', 'adobe', ''], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        ':warning: Brand name cannot be empty.',
      );
    });

    it('should handle site not found', async () => {
      mockDataAccess.Site.findByBaseURL.resolves(null);

      await command.handleExecution(['https://example.com', 'adobe', 'Adobe'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        ':x: Site \'https://example.com\' not found. Please add the site first using the regular onboard command.',
      );
    });

    it('should successfully onboard LLMO for a valid site', async () => {
      await command.handleExecution(['https://example.com', 'adobe', 'Adobe'], slackContext);

      expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(mockSite.setConfig).to.have.been.called;
      expect(mockSite.save).to.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(
        sinon.match.string.and(sinon.match(/LLMO onboarding completed successfully/)),
      );
    });

    it('should handle brand names with spaces', async () => {
      await command.handleExecution(['https://example.com', 'adobe', 'Adobe Experience Cloud'], slackContext);

      expect(mockSite.setConfig).to.have.been.called;
      expect(mockSite.save).to.have.been.called;
      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/Brand.*Adobe Experience Cloud/),
      );
    });

    it('should preserve existing questions when updating LLMO config', async () => {
      const existingQuestions = {
        Human: [{ key: 'test-key', question: 'Test question?' }],
      };
      mockConfig.getLlmoConfig.returns({ questions: existingQuestions });

      await command.handleExecution(['https://example.com', 'adobe', 'Adobe'], slackContext);

      const setConfigCall = mockSite.setConfig.getCall(0);
      expect(setConfigCall).to.not.be.null;
      // The config should include the existing questions
      expect(mockSite.save).to.have.been.called;
    });

    it('should handle save errors gracefully', async () => {
      const saveError = new Error('Database error');
      mockSite.save.rejects(saveError);

      await command.handleExecution(['https://example.com', 'adobe', 'Adobe'], slackContext);

      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Error saving LLMO config for site test-site-id/),
      );
      expect(slackContext.say).to.have.been.calledWith(
        ':x: Failed to save LLMO configuration: Database error',
      );
    });

    it('sends a message for all other errors', async () => {
      const error = new Error('Unexpected error');
      mockDataAccess.Site.findByBaseURL.rejects(error);

      await command.handleExecution(['https://example.com', 'adobe', 'Adobe'], slackContext);

      expect(mockLog.error).to.have.been.calledWith('Error in LLMO onboarding:', error);
      expect(slackContext.say).to.have.been.calledWith(
        ':nuclear-warning: Oops! Something went wrong: Unexpected error',
      );
    });
  });
});
