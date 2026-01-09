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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('LlmoGenerateFrescopaDataCommand', () => {
  let command;
  let mockContext;
  let mockLog;
  let mockEnv;
  let slackContext;
  let mockSharePointClient;
  let createSharePointClientStub;
  let postErrorMessageStub;
  let originalFetch;
  let originalSetTimeout;
  let LlmoGenerateFrescopaDataCommand;

  beforeEach(async () => {
    // Create mock log
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
      warn: sinon.stub(),
    };

    // Create mock environment
    mockEnv = {
      SHAREPOINT_CLIENT_ID: 'test-client-id',
      SHAREPOINT_CLIENT_SECRET: 'test-client-secret',
      SHAREPOINT_AUTHORITY: 'test-authority',
      SHAREPOINT_DOMAIN_ID: 'test-domain-id',
    };

    // Create mock context
    mockContext = {
      log: mockLog,
      env: mockEnv,
    };

    // Create slack context
    slackContext = {
      say: sinon.stub().resolves(),
    };

    // Mock global fetch
    originalFetch = global.fetch;
    global.fetch = sinon.stub().resolves({ ok: true, status: 200, statusText: 'OK' });

    // Mock setTimeout to execute immediately
    originalSetTimeout = global.setTimeout;
    global.setTimeout = sinon.stub().callsFake((fn) => {
      fn();
      return 1;
    });

    // Set HLX_ADMIN_TOKEN
    process.env.HLX_ADMIN_TOKEN = 'test-token';

    // Create mock SharePoint client
    mockSharePointClient = {
      getDocument: sinon.stub(),
    };

    createSharePointClientStub = sinon.stub().resolves(mockSharePointClient);
    postErrorMessageStub = sinon.stub().resolves();

    // Use esmock to mock dependencies
    LlmoGenerateFrescopaDataCommand = await esmock(
      '../../../../src/support/slack/commands/llmo-generate-frescopa-data.js',
      {
        '../../../../src/controllers/llmo/llmo-onboarding.js': {
          createSharePointClient: createSharePointClientStub,
        },
        '../../../../src/utils/slack/base.js': {
          postErrorMessage: postErrorMessageStub,
        },
      },
    );

    command = LlmoGenerateFrescopaDataCommand.default(mockContext);
  });

  afterEach(() => {
    sinon.restore();
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    delete process.env.HLX_ADMIN_TOKEN;
  });

  describe('Command Properties', () => {
    it('should have correct id and phrases', () => {
      expect(command.id).to.equal('llmo-generate-frescopa-data');
      expect(command.phrases).to.deep.equal(['llmo-generate-frescopa-data']);
      expect(command.name).to.equal('LLMO Generate Frescopa Data');
    });

    it('should accept the llmo-generate-frescopa-data phrase', () => {
      expect(command.accepts('llmo-generate-frescopa-data')).to.be.true;
      expect(command.accepts('llmo-generate-frescopa-data w02-2026')).to.be.true;
      expect(command.accepts('other command')).to.be.false;
    });
  });

  describe('Handle Execution - Validation', () => {
    it('should show usage when no week identifier provided', async () => {
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Week identifier is required');
      expect(slackContext.say.firstCall.args[0]).to.include('w02-2026');
    });

    it('should show error for invalid week identifier format', async () => {
      await command.handleExecution(['2026-w02'], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Invalid week identifier format');
      expect(slackContext.say.firstCall.args[0]).to.include('wXX-YYYY');
    });

    it('should accept valid week identifier format', async () => {
      // Setup mocks to simulate folder doesn't exist (to exit early)
      const mockFolder = { exists: sinon.stub().resolves(false) };
      mockSharePointClient.getDocument.returns(mockFolder);

      await command.handleExecution(['w23-2025'], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include('Starting Frescopa data generation for week `w23-2025`');
    });

    it('should normalize week identifier to lowercase', async () => {
      const mockFolder = { exists: sinon.stub().resolves(false) };
      mockSharePointClient.getDocument.returns(mockFolder);

      await command.handleExecution(['W23-2025'], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include('w23-2025');
    });
  });

  describe('Handle Execution - File Operations', () => {
    it('should create all 3 files successfully', async () => {
      const mockFolder = {
        exists: sinon.stub().resolves(true),
        copy: sinon.stub().resolves(),
      };
      const mockFile = {
        exists: sinon.stub().resolves(false),
        copy: sinon.stub().resolves(),
      };
      mockSharePointClient.getDocument.callsFake((path) => {
        if (path.endsWith('/')) {
          return mockFolder;
        }
        if (path.includes('template/')) {
          return mockFile;
        }
        return { exists: sinon.stub().resolves(false), copy: sinon.stub().resolves() };
      });

      await command.handleExecution(['w23-2025'], slackContext);

      // Check for success messages
      const sayCalls = slackContext.say.getCalls().map((c) => c.args[0]);
      expect(sayCalls.some((msg) => msg.includes('Created `agentictraffic-w23-2025.xlsx`'))).to.be.true;
      expect(sayCalls.some((msg) => msg.includes('Created `brandpresence-all-w23-2025.xlsx`'))).to.be.true;
      expect(sayCalls.some((msg) => msg.includes('Created `referral-traffic-w23-2025.xlsx`'))).to.be.true;
      expect(sayCalls.some((msg) => msg.includes('Frescopa data generation complete'))).to.be.true;
    });

    it('should skip file if it already exists', async () => {
      const mockFolder = { exists: sinon.stub().resolves(true) };
      const mockExistingFile = { exists: sinon.stub().resolves(true) };
      mockSharePointClient.getDocument.callsFake((path) => {
        if (path.endsWith('/')) {
          return mockFolder;
        }
        return mockExistingFile;
      });

      await command.handleExecution(['w23-2025'], slackContext);

      const sayCalls = slackContext.say.getCalls().map((c) => c.args[0]);
      expect(sayCalls.some((msg) => msg.includes('already exists'))).to.be.true;
      expect(sayCalls.some((msg) => msg.includes('Skipping'))).to.be.true;
    });

    it('should skip file if folder does not exist', async () => {
      const mockFolder = { exists: sinon.stub().resolves(false) };
      mockSharePointClient.getDocument.returns(mockFolder);

      await command.handleExecution(['w23-2025'], slackContext);

      const sayCalls = slackContext.say.getCalls().map((c) => c.args[0]);
      expect(sayCalls.some((msg) => msg.includes('does not exist'))).to.be.true;
      expect(sayCalls.some((msg) => msg.includes('Skipping'))).to.be.true;
    });

    it('should show all failed message when no files created', async () => {
      const mockFolder = { exists: sinon.stub().resolves(false) };
      mockSharePointClient.getDocument.returns(mockFolder);

      await command.handleExecution(['w23-2025'], slackContext);

      const sayCalls = slackContext.say.getCalls().map((c) => c.args[0]);
      expect(sayCalls.some((msg) => msg.includes('All file operations failed'))).to.be.true;
    });

    it('should handle file copy error', async () => {
      const mockFolder = { exists: sinon.stub().resolves(true) };
      const mockFile = { exists: sinon.stub().resolves(false) };
      const mockTemplate = { copy: sinon.stub().rejects(new Error('Copy failed')) };

      mockSharePointClient.getDocument.callsFake((path) => {
        if (path.endsWith('/')) {
          return mockFolder;
        }
        if (path.includes('template/')) {
          return mockTemplate;
        }
        return mockFile;
      });

      await command.handleExecution(['w23-2025'], slackContext);

      const sayCalls = slackContext.say.getCalls().map((c) => c.args[0]);
      expect(sayCalls.some((msg) => msg.includes('Failed to create'))).to.be.true;
      expect(mockLog.error.called).to.be.true;
    });
  });

  describe('Handle Execution - Publishing', () => {
    it('should publish files to admin.hlx.page', async () => {
      const mockFolder = { exists: sinon.stub().resolves(true) };
      const mockFile = { exists: sinon.stub().resolves(false), copy: sinon.stub().resolves() };
      mockSharePointClient.getDocument.callsFake((path) => {
        if (path.endsWith('/')) {
          return mockFolder;
        }
        return mockFile;
      });

      await command.handleExecution(['w23-2025'], slackContext);

      // 3 files × 2 endpoints (preview + live) = 6 fetch calls
      expect(global.fetch.callCount).to.equal(6);
      expect(global.fetch.firstCall.args[0]).to.include('admin.hlx.page');
    });

    it('should handle publish failure', async () => {
      const mockFolder = { exists: sinon.stub().resolves(true) };
      const mockFile = { exists: sinon.stub().resolves(false), copy: sinon.stub().resolves() };
      mockSharePointClient.getDocument.callsFake((path) => {
        if (path.endsWith('/')) {
          return mockFolder;
        }
        return mockFile;
      });

      global.fetch.resolves({ ok: false, status: 500, statusText: 'Internal Server Error' });

      await command.handleExecution(['w23-2025'], slackContext);

      expect(mockLog.error.called).to.be.true;
      const sayCalls = slackContext.say.getCalls().map((c) => c.args[0]);
      expect(sayCalls.some((msg) => msg.includes('Failed to create'))).to.be.true;
    });

    it('should warn when HLX_ADMIN_TOKEN is not set', async () => {
      delete process.env.HLX_ADMIN_TOKEN;

      const mockFolder = { exists: sinon.stub().resolves(true) };
      const mockFile = { exists: sinon.stub().resolves(false), copy: sinon.stub().resolves() };
      mockSharePointClient.getDocument.callsFake((path) => {
        if (path.endsWith('/')) {
          return mockFolder;
        }
        return mockFile;
      });

      await command.handleExecution(['w23-2025'], slackContext);

      expect(mockLog.warn.calledWith('HLX_ADMIN_TOKEN is not set')).to.be.true;
    });
  });

  describe('Handle Execution - Error Handling', () => {
    it('should call postErrorMessage on general error', async () => {
      createSharePointClientStub.rejects(new Error('SharePoint connection failed'));

      await command.handleExecution(['w23-2025'], slackContext);

      expect(postErrorMessageStub.called).to.be.true;
      expect(mockLog.error.called).to.be.true;
    });
  });
});
