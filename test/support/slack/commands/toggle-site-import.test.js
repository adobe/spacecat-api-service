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

import sinon from 'sinon';
import { expect } from 'chai';
import esmock from 'esmock';

const SUCCESS_MESSAGE_PREFIX = ':white_check_mark: ';
const ERROR_MESSAGE_PREFIX = ':x: ';

describe('ToggleSiteImportCommand', () => {
  const sandbox = sinon.createSandbox();

  const siteConfig = {
    enableImport: sandbox.stub(),
    disableImport: sandbox.stub(),
  };

  const site = {
    getId: () => 'site0',
    getBaseURL: () => 'https://site0.com',
    getDeliveryType: () => 'aem_edge',
    getConfig: () => siteConfig,
    setConfig: sandbox.stub(),
    save: sandbox.stub(),
  };

  let dataAccessMock;
  let logMock;
  let contextMock;
  let slackContextMock;
  let ToggleSiteImportCommand;
  let fetchStub;
  let parseCSVStub;
  let configToDynamoItemStub;

  const expectsAtBadRequest = () => {
    expect(
      siteConfig.enableImport.called,
      'Expected enableImport to not be called, but it was',
    ).to.be.false;
    expect(
      siteConfig.disableImport.called,
      'Expected disableImport to not be called, but it was',
    ).to.be.false;
    expect(
      site.save.called,
      'Expected site.save to not be called, but it was',
    ).to.be.false;
  };

  beforeEach(async () => {
    siteConfig.enableImport.reset();
    siteConfig.disableImport.reset();
    site.setConfig.reset();
    site.save.reset();

    dataAccessMock = {
      Site: {
        findByBaseURL: sandbox.stub().resolves(),
      },
    };

    logMock = {
      error: sandbox.stub(),
    };

    contextMock = {
      log: logMock,
      dataAccess: dataAccessMock,
      env: {
        SLACK_BOT_TOKEN: 'mock-token',
      },
    };

    slackContextMock = {
      say: sinon.stub(),
      botToken: 'mock-token',
    };

    fetchStub = sinon.stub().resolves({
      ok: true,
      text: () => Promise.resolve('https://site1.com\nhttps://site2.com'),
    });

    parseCSVStub = sinon.stub().resolves([
      ['https://site1.com'],
      ['https://site2.com'],
    ]);

    configToDynamoItemStub = sinon.stub().returns({ importConfig: 'mockConfig' });

    ToggleSiteImportCommand = await esmock('../../../../src/support/slack/commands/toggle-site-import.js', {
      '@adobe/spacecat-shared-utils': {
        tracingFetch: fetchStub,
        isValidUrl: (url) => url.startsWith('http'),
        isNonEmptyArray: (arr) => Array.isArray(arr) && arr.length > 0,
        hasText: (text) => typeof text === 'string' && text.trim().length > 0,
      },
      '../../../../src/utils/slack/base.js': {
        parseCSV: parseCSVStub,
        extractURLFromSlackInput: (url) => (url.startsWith('http') ? url : `https://${url}`),
        loadProfileConfig: (profile) => {
          if (profile === 'default') {
            return {
              imports: {
                content: { enabled: true },
                assets: { enabled: true },
              },
            };
          }
          throw new Error(`Invalid profile: ${profile}`);
        },
      },
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: {
          toDynamoItem: configToDynamoItemStub,
        },
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('enable an import type for a site', async () => {
    dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

    const command = ToggleSiteImportCommand(contextMock);
    const args = ['enable', 'https://site0.com', 'content'];
    await command.handleExecution(args, slackContextMock);

    expect(
      dataAccessMock.Site.findByBaseURL.calledWith('https://site0.com'),
      'Expected dataAccess.Site.findByBaseURL to be called with "https://site0.com", but it was not',
    ).to.be.true;
    expect(
      site.save.called,
      'Expected site.save to be called, but it was not',
    ).to.be.true;
    expect(
      siteConfig.enableImport.calledWith('content'),
      'Expected siteConfig.enableImport to be called with "content", but it was not',
    ).to.be.true;
    expect(
      slackContextMock.say.calledWith(`${SUCCESS_MESSAGE_PREFIX}The import "content" has been *enabled* for "https://site0.com".`),
      'Expected Slack message to be sent confirming "content" was enabled for "https://site0.com", but it was not',
    ).to.be.true;
  });

  it('disable an import type for a site', async () => {
    dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

    const command = ToggleSiteImportCommand(contextMock);
    const args = ['disable', 'https://site0.com', 'content'];
    await command.handleExecution(args, slackContextMock);

    expect(
      dataAccessMock.Site.findByBaseURL.calledWith('https://site0.com'),
      'Expected dataAccess.Site.findByBaseURL to be called with "https://site0.com", but it was not',
    ).to.be.true;
    expect(
      site.save.called,
      'Expected site.save to be called, but it was not',
    ).to.be.true;
    expect(
      siteConfig.disableImport.calledWith('content'),
      'Expected siteConfig.disableImport to be called with "content", but it was not',
    ).to.be.true;
    expect(
      slackContextMock.say.calledWith(`${SUCCESS_MESSAGE_PREFIX}The import "content" has been *disabled* for "https://site0.com".`),
      'Expected Slack message to be sent confirming "content" was disabled for "https://site0.com", but it was not',
    ).to.be.true;
  });

  it('if site base URL without scheme should be added "https://"', async () => {
    dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

    const command = ToggleSiteImportCommand(contextMock);
    const args = ['disable', 'site0.com', 'content'];
    await command.handleExecution(args, slackContextMock);

    expect(
      dataAccessMock.Site.findByBaseURL.calledWith('https://site0.com'),
      'Expected dataAccess.Site.findByBaseURL to be called with "https://site0.com", but it was not',
    ).to.be.true;
  });

  describe('Bad Request Errors', () => {
    it('if "enableImport" parameter is missed', async () => {
      const command = ToggleSiteImportCommand(contextMock);
      const args = ['', 'http://site0.com', 'content'];

      await command.handleExecution(args, slackContextMock);

      expectsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable imports: The "enableImport" parameter is required and must be set to "enable" or "disable".`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable imports: The "enableImport" parameter is required and must be set to "enable" or "disable"."`,
      ).to.be.true;
    });

    it('if URL is invalid for a single site operation', async () => {
      // This test specifically tests lines 107-108 in toggle-site-import.js
      // where it validates the URL and throws an error if invalid

      // Create a stub for isValidUrl that returns false for this specific test
      const isValidUrlStub = sinon.stub().returns(false);

      // Mock the module with our customized isValidUrl function
      const CustomToggleSiteImportCommand = await esmock('../../../../src/support/slack/commands/toggle-site-import.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: fetchStub,
          isValidUrl: isValidUrlStub, // Override just this function
          isNonEmptyArray: (arr) => Array.isArray(arr) && arr.length > 0,
          hasText: (text) => typeof text === 'string' && text.trim().length > 0,
        },
        '../../../../src/utils/slack/base.js': {
          parseCSV: parseCSVStub,
          extractURLFromSlackInput: (url) => url,
          loadProfileConfig: (profile) => {
            if (profile === 'default') {
              return {
                imports: {
                  content: { enabled: true },
                  assets: { enabled: true },
                },
              };
            }
            throw new Error(`Invalid profile: ${profile}`);
          },
        },
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: {
            toDynamoItem: configToDynamoItemStub,
          },
        },
      });

      const command = CustomToggleSiteImportCommand(contextMock);

      // Test with a URL that will be identified as invalid
      const testURL = 'invalid-url';
      const args = ['enable', testURL, 'content'];

      await command.handleExecution(args, slackContextMock);

      // Verify isValidUrl was called with the URL
      expect(isValidUrlStub.calledWith(testURL)).to.be.true;

      // Verify the expected error message was displayed
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Invalid URL: ${testURL}`),
        'Expected error message for invalid URL was not shown',
      ).to.be.true;

      // Verify no site operations were attempted
      expectsAtBadRequest();
    });

    it('if "enableImport" parameter has wrong value', async () => {
      const command = ToggleSiteImportCommand(contextMock);
      const args = ['wrong_value', 'http://site0.com', 'content'];

      await command.handleExecution(args, slackContextMock);

      expectsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable imports: The "enableImport" parameter is required and must be set to "enable" or "disable".`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable imports: The "enableImport" parameter is required and must be set to "enable" or "disable"."`,
      ).to.be.true;
    });

    it('should handle missing importTypeOrProfile with CSV file', async () => {
      // Setup test environment with a CSV file
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'https://mock-url',
      }];

      // Call with only the enableImport parameter
      const command = ToggleSiteImportCommand(contextMock);
      const args = ['enable']; // Missing second parameter

      await command.handleExecution(args, slackContextMock);

      // Should call validateInput with null
      expectsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable imports: The import type parameter is required.`),
        'Expected error message indicating import type is required',
      ).to.be.true;
    });

    it('if a site is not found', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(null);

      const command = ToggleSiteImportCommand(contextMock);
      const args = ['enable', 'https://site0.com', 'content'];

      await command.handleExecution(args, slackContextMock);

      expectsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Cannot update site with baseURL: "https://site0.com", site not found.`),
        'Expected slackContextMock.say to be called with the specified error message, but it was not.',
      ).to.be.true;
    });

    it('if "importType" parameter is missing', async () => {
      const command = ToggleSiteImportCommand(contextMock);
      const args = ['enable', 'http://site0.com', ''];
      await command.handleExecution(args, slackContextMock);

      expectsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable imports: The import type parameter is required.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable imports: The import type parameter is required.", but it was not called with that message.`,
      ).to.be.true;
    });
  });

  describe('CSV bulk operations', () => {
    beforeEach(() => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'https://mock-url',
      }];
    });

    it('should process CSV file to enable with profile', async () => {
      const args = ['enable', 'default'];
      const command = ToggleSiteImportCommand(contextMock);

      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves({ ...site });
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves({ ...site });

      await command.handleExecution(args, slackContextMock);

      expect(siteConfig.enableImport.callCount).to.equal(14);
      expect(site.save.callCount).to.equal(2);
    });

    it('should process CSV file to disable with profile', async () => {
      const args = ['disable', 'default'];
      const command = ToggleSiteImportCommand(contextMock);

      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves({ ...site });
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves({ ...site });

      await command.handleExecution(args, slackContextMock);

      expect(siteConfig.disableImport.callCount).to.equal(14);
      expect(site.save.callCount).to.equal(2);
    });

    it('should handle errors during import enabling/disabling in bulk processing', async () => {
      // Setup mocks for the CSV file data
      parseCSVStub.resolves([
        ['https://site1.com'],
        ['https://site2.com'],
      ]);

      // Create site objects with appropriate stubs
      const site1 = {
        ...site,
        getBaseURL: () => 'https://site1.com',
        getConfig: () => ({ ...siteConfig }),
        save: sinon.stub().resolves(),
      };

      const site2 = {
        ...site,
        getBaseURL: () => 'https://site2.com',
        getConfig: () => ({ ...siteConfig }),
        save: sinon.stub().rejects(new Error('Database error')),
      };

      // Setup the mock implementation
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(site1);
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves(site2);

      // Override Promise.all to return mock processedResults with the expected structure
      const origPromiseAll = Promise.all;
      Promise.all = sinon.stub().resolves([
        { success: true, baseURL: 'https://site1.com' },
        { success: false, baseURL: 'https://site2.com', error: 'Database error' },
      ]);

      const command = ToggleSiteImportCommand(contextMock);
      await command.handleExecution(['enable', 'content'], slackContextMock);

      // Check that the final message contains the expected content
      const expectedMessage = sinon.match((value) => value.includes(':clipboard: *Bulk Update Results*')
        && value.includes('Import Type: `content`')
        && value.includes('Successfully enabled for')
        && value.includes('https://site1.com')
        && value.includes('Failed to process')
        && value.includes('https://site2.com: Database error'));

      expect(slackContextMock.say.calledWith(expectedMessage)).to.be.true;

      // Restore Promise.all
      Promise.all = origPromiseAll;
    });

    it('should handle CSV file with invalid URLs', async () => {
      parseCSVStub.resolves([
        ['invalid-url'],
        ['https://valid.com'],
      ]);

      const command = ToggleSiteImportCommand(contextMock);
      await command.handleExecution(['enable', 'content'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Invalid URLs found'))).to.be.true;
    });

    it('should handle empty CSV file', async () => {
      parseCSVStub.resolves([]);

      const command = ToggleSiteImportCommand(contextMock);
      await command.handleExecution(['enable', 'content'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('The parsed CSV data is empty'))).to.be.true;
    });

    it('should handle CSV download failure', async () => {
      fetchStub.resolves({
        ok: false,
      });

      const command = ToggleSiteImportCommand(contextMock);
      await command.handleExecution(['enable', 'content'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Failed to download'))).to.be.true;
    });
  });

  describe('profile handling', () => {
    beforeEach(() => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'https://mock-url',
      }];
    });

    it('should process multiple import types from a profile', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves({ ...site });
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves({ ...site });

      const command = ToggleSiteImportCommand(contextMock);
      await command.handleExecution(['enable', 'default'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Processing profile "default" with 2 import types'))).to.be.true;
      expect(siteConfig.enableImport.callCount).to.equal(14);
    });

    it('should format profile information correctly in result message', async () => {
      // Override Promise.all to return mock results
      const origPromiseAll = Promise.all;
      Promise.all = sinon.stub().resolves([
        { success: true, baseURL: 'https://site1.com' },
      ]);

      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves({ ...site });

      const command = ToggleSiteImportCommand(contextMock);
      await command.handleExecution(['enable', 'default'], slackContextMock);

      // Test lines 254-255 specifically - check for exact formatted strings
      const profileSection1 = '\nProfile: `default` with 2 import types:';
      const profileSection2 = '\n```content\nassets```';

      const callArgs = slackContextMock.say.args;
      let foundMessage = false;

      // Check if any of the say calls contain both parts of the profile message
      callArgs.forEach((args) => {
        const message = args[0];
        if (message.includes(profileSection1) && message.includes(profileSection2)) {
          foundMessage = true;
        }
      });

      expect(foundMessage, 'Expected to find message with correct profile formatting').to.be.true;

      // Restore original Promise.all
      Promise.all = origPromiseAll;
    });
  });

  describe('Error handling in handleSingleURL', () => {
    it('should handle and log errors during site config updates', async () => {
      // Set up site to be found
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      // Make site.save throw an error
      const testError = new Error('Database connection error');
      site.save.rejects(testError);

      const command = ToggleSiteImportCommand(contextMock);
      const args = ['enable', 'https://site0.com', 'content'];
      await command.handleExecution(args, slackContextMock);

      // Verify error was logged
      expect(
        logMock.error.calledWith(testError),
        'Expected error to be logged',
      ).to.be.true;

      // Verify appropriate error message was displayed
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Database connection error`),
        'Expected error message to be sent to Slack',
      ).to.be.true;
    });

    it('should handle errors in the config operations', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      // Make enableImport throw an error
      const testError = new Error('Invalid import type');
      siteConfig.enableImport.throws(testError);

      const command = ToggleSiteImportCommand(contextMock);
      const args = ['enable', 'https://site0.com', 'content'];
      await command.handleExecution(args, slackContextMock);

      // Verify error was logged
      expect(
        logMock.error.calledWith(testError),
        'Expected error to be logged',
      ).to.be.true;

      // Verify appropriate error message was displayed
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Invalid import type`),
        'Expected error message to be sent to Slack',
      ).to.be.true;

      // Verify site.save was not called due to the error
      expect(
        site.save.called,
        'Expected site.save to not be called after error',
      ).to.be.false;
    });

    it('should handle errors in site.setConfig', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      // Make setConfig throw an error
      const testError = new Error('Invalid config format');
      site.setConfig.throws(testError);

      const command = ToggleSiteImportCommand(contextMock);
      const args = ['enable', 'https://site0.com', 'content'];
      await command.handleExecution(args, slackContextMock);

      // Verify error was logged
      expect(
        logMock.error.calledWith(testError),
        'Expected error to be logged',
      ).to.be.true;

      // Verify appropriate error message was displayed
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Invalid config format`),
        'Expected error message to be sent to Slack',
      ).to.be.true;

      // Verify site.save was not called due to the error
      expect(
        site.save.called,
        'Expected site.save to not be called after error',
      ).to.be.false;
    });
  });
});
