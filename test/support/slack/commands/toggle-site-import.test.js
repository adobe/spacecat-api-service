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

  describe('Internal errors', () => {
    it('error during execution', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const error = new Error('Test error');
      site.save.rejects(error);

      const command = ToggleSiteImportCommand(contextMock);
      const args = ['enable', 'http://site0.com', 'content'];
      await command.handleExecution(args, slackContextMock);

      expect(
        contextMock.log.error.calledWith(error),
        'Expected log.error to be called with the provided error, but it was not',
      ).to.be.true;
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable imports: Test error`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable imports: Test error"`,
      ).to.be.true;
    });
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

    it('if "baseURL" is not provided', async () => {
      const command = ToggleSiteImportCommand(contextMock);
      const args = ['enable', '', 'content'];

      await command.handleExecution(args, slackContextMock);

      expectsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL.", but it was not called with that message.`,
      ).to.be.true;
    });

    it('if "baseURL" has wrong site format', async () => {
      const command = ToggleSiteImportCommand(contextMock);
      const args = ['enable', 'wrong_site_format', 'content'];

      await command.handleExecution(args, slackContextMock);

      expectsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL."`,
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

      expect(siteConfig.enableImport.callCount).to.equal(4);
      expect(site.save.callCount).to.equal(2);
      expect(slackContextMock.say.calledWith(sinon.match('Successfully'))).to.be.true;
    });

    it('should process CSV file to disable with profile', async () => {
      const args = ['disable', 'default'];
      const command = ToggleSiteImportCommand(contextMock);

      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves({ ...site });
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves({ ...site });

      await command.handleExecution(args, slackContextMock);

      expect(siteConfig.disableImport.callCount).to.equal(4);
      expect(site.save.callCount).to.equal(2);
      expect(slackContextMock.say.calledWith(sinon.match('Successfully'))).to.be.true;
    });

    it('should handle errors during import enabling/disabling in bulk processing', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves({ ...site });

      // Create a problematic site that will throw an error
      const problemSite = { ...site };
      problemSite.save = sinon.stub().rejects(new Error('Test error during save'));
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves(problemSite);

      const command = ToggleSiteImportCommand(contextMock);
      await command.handleExecution(['enable', 'content'], slackContextMock);

      expect(slackContextMock.say.calledWith(
        sinon.match((value) => value.includes(':clipboard: *Bulk Update Results*')
          && value.includes('Successfully enabled for 1 sites')
          && value.includes('https://site1.com')
          && value.includes('Failed to process 1 sites')
          && value.includes('https://site2.com: Test error during save')),
      )).to.be.true;
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

    it('should handle sites that are not found during bulk processing', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves({ ...site });
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves(null);

      const command = ToggleSiteImportCommand(contextMock);
      await command.handleExecution(['enable', 'content'], slackContextMock);

      expect(slackContextMock.say.calledWith(
        sinon.match((value) => value.includes(':clipboard: *Bulk Update Results*')
          && value.includes('Successfully enabled for 1 sites')
          && value.includes('https://site1.com')
          && value.includes('Failed to process 1 sites')
          && value.includes('https://site2.com: Site not found')),
      )).to.be.true;
    });
  });

  describe('profile handling', () => {
    beforeEach(() => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'https://mock-url',
      }];
    });

    it('should handle invalid profile name', async () => {
      const command = ToggleSiteImportCommand(contextMock);
      await command.handleExecution(['enable', 'invalid-profile'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Invalid profile: invalid-profile'))).to.be.true;
    });

    it('should process multiple import types from a profile', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves({ ...site });
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves({ ...site });

      const command = ToggleSiteImportCommand(contextMock);
      await command.handleExecution(['enable', 'default'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Processing profile "default" with 2 import types'))).to.be.true;
      expect(siteConfig.enableImport.callCount).to.equal(4);
    });
  });
});
