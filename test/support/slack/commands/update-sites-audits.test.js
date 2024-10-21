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
import UpdateSitesAuditsCommand from '../../../../src/support/slack/commands/update-sites-audits.js';
import { SiteDto } from '../../../../src/dto/site.js';

const ERROR_MESSAGE_PREFIX = ':nuclear-warning: ';

describe('UpdateSitesAuditsCommand', () => {
  const sandbox = sinon.createSandbox();

  const sites = [
    { id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge' },
    { id: 'site2', baseURL: 'https://site2.com', deliveryType: 'aem_edge' },
  ].map((site) => SiteDto.fromJson(site));

  let mockConfiguration;
  let mockDataAccess;
  let mockLog;
  let mockContext;
  let mockSlackContext;

  beforeEach(async () => {
    mockConfiguration = {
      enableHandlerForSite: sandbox.stub(),
      disableHandlerForSite: sandbox.stub(),
      getVersion: sandbox.stub(),
      getJobs: sandbox.stub(),
      getHandlers: sandbox.stub(),
      getQueues: sandbox.stub(),
    };

    mockDataAccess = {
      getConfiguration: sandbox.stub().resolves(mockConfiguration),
      getSiteByBaseURL: sandbox.stub(),
      updateConfiguration: sandbox.stub(),
    };

    mockLog = {
      error: sandbox.stub(),
    };

    mockContext = {
      log: mockLog,
      dataAccess: mockDataAccess,
    };

    mockSlackContext = {
      say: sinon.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('updates the audit configuration for multiple sites with a single audit toggle', async () => {
    mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);
    mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

    const command = UpdateSitesAuditsCommand(mockContext);
    const args = ['enable', 'http://site1.com,https://site2.com', 'cwv'];
    await command.handleExecution(args, mockSlackContext);

    expect(mockDataAccess.getSiteByBaseURL.calledTwice).to.be.true;
    expect(mockDataAccess.updateConfiguration.called).to.be.true;

    expect(mockConfiguration.enableHandlerForSite.callCount).to.equal(2);
    expect(mockConfiguration.enableHandlerForSite.calledWith('cwv', sites[0])).to.be.true;
    expect(mockConfiguration.enableHandlerForSite.calledWith('cwv', sites[1])).to.be.true;

    expect(mockSlackContext.say.calledWith('Bulk update completed with the following responses:\n'
        + 'https://site1.com: successfully updated\n'
        + 'https://site2.com: successfully updated\n')).to.be.true;
  });

  it('updates the audit configuration for multiple sites with multiple audit toggles', async () => {
    mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);
    mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

    const command = UpdateSitesAuditsCommand(mockContext);
    const args = ['disable', 'http://site1.com,https://site2.com', 'cwv,404'];
    await command.handleExecution(args, mockSlackContext);

    expect(mockDataAccess.getSiteByBaseURL.calledTwice).to.be.true;
    expect(mockDataAccess.updateConfiguration.called).to.be.true;

    expect(mockConfiguration.disableHandlerForSite.callCount).to.equal(4);
    expect(mockConfiguration.disableHandlerForSite.calledWith('cwv', sites[0])).to.be.true;
    expect(mockConfiguration.disableHandlerForSite.calledWith('cwv', sites[1])).to.be.true;

    expect(mockConfiguration.disableHandlerForSite.calledWith('404', sites[0])).to.be.true;
    expect(mockConfiguration.disableHandlerForSite.calledWith('404', sites[1])).to.be.true;

    expect(mockSlackContext.say.calledWith('Bulk update completed with the following responses:\n'
        + 'https://site1.com: successfully updated\n'
        + 'https://site2.com: successfully updated\n')).to.be.true;
  });

  describe('Internal errors', () => {
    it('error during execution', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);

      const error = new Error('Test error');
      mockDataAccess.updateConfiguration.rejects(error);

      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['enable', 'http://site1.com', 'cwv,404'];
      await command.handleExecution(args, mockSlackContext);

      expect(mockContext.log.error.calledWith(error)).to.be.true;
      expect(
        mockSlackContext.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: Test error`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: Test error"`,
      ).to.be.true;
    });
  });

  describe('Bad Request Errors', () => {
    it('returns bad request when baseURLs is not provided', async () => {
      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['enable', '', 'cwv,404'];
      await command.handleExecution(args, mockSlackContext);

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;
      expect(
        mockSlackContext.say.calledWith(`${ERROR_MESSAGE_PREFIX}Sites URLs are required.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}Sites URLs are required.", but it was not called with that message.`,
      ).to.be.true;
    });

    it('if the audit types parameter is missing', async () => {
      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['enable', 'http://site1.com,https://site2.com', ''];
      await command.handleExecution(args, mockSlackContext);

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;
      expect(
        mockSlackContext.say.calledWith(`${ERROR_MESSAGE_PREFIX}The audit types parameter must be a list of valid audits, separated by commas.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}The audit types parameter must be a list of valid audits, separated by commas.", but it was not called with that message.`,
      ).to.be.true;
    });

    it('if "enableAudits" parameter is missed', async () => {
      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['', 'http://site1.com,https://site2.com', 'cwv,404'];
      await command.handleExecution(args, mockSlackContext);

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;
      expect(
        mockSlackContext.say.calledWith(`${ERROR_MESSAGE_PREFIX}The "enableAudits" parameter is required and must be set to "enable" or "disable".`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}The 'enableAudits' parameter is required and must be set to 'enable' or 'disable'."`,
      ).to.be.true;
    });

    it('if "enableAudits" parameter has wrong format', async () => {
      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['wrong_format', 'http://site1.com,https://site2.com', 'cwv,404'];
      await command.handleExecution(args, mockSlackContext);

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;
      expect(
        mockSlackContext.say.calledWith(`${ERROR_MESSAGE_PREFIX}The "enableAudits" parameter is required and must be set to "enable" or "disable".`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}The 'enableAudits' parameter is required and must be set to 'enable' or 'disable'."`,
      ).to.be.true;
    });
  });

  describe('Error during partial update of site configuration', () => {
    it('if the site is not found.', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(null);

      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['enable', 'http://site1.com', 'cwv,404'];
      await command.handleExecution(args, mockSlackContext);

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;

      expect(mockSlackContext.say.calledWith('Bulk update completed with the following responses:\n'
          + 'Cannot update site with baseURL: http://site1.com, site not found\n')).to.be.true;
    });
  });
});
