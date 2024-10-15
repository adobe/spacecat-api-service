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

describe('UpdateSitesAuditsCommand', () => {
  const sandbox = sinon.createSandbox();

  const sites = [
    { id: 'site1', baseURL: 'https://site1.com', deliveryType: 'aem_edge' },
    { id: 'site2', baseURL: 'https://site2.com', deliveryType: 'aem_edge' },
  ].map((site) => SiteDto.fromJson(site));

  let mockConfiguration;
  let mockDataAccess;
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

    mockContext = {
      log: {
        error: sinon.stub(),
      },
      dataAccess: mockDataAccess,
    };

    mockSlackContext = {
      say: sinon.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('successful execution with multiple sites', async () => {
    mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);
    mockDataAccess.getSiteByBaseURL.withArgs('https://site2.com').resolves(sites[1]);

    const command = UpdateSitesAuditsCommand(mockContext);
    const args = ['enable', 'http://site1.com,https://site2.com', 'cwv,404'];
    await command.handleExecution(args, mockSlackContext);

    expect(mockDataAccess.getSiteByBaseURL.calledTwice).to.be.true;
    expect(mockDataAccess.updateConfiguration.called).to.be.true;

    expect(mockConfiguration.enableHandlerForSite.callCount).to.equal(4);
    expect(mockConfiguration.enableHandlerForSite.calledWith('cwv', sites[0])).to.be.true;
    expect(mockConfiguration.enableHandlerForSite.calledWith('cwv', sites[1])).to.be.true;

    expect(mockConfiguration.enableHandlerForSite.calledWith('404', sites[0])).to.be.true;
    expect(mockConfiguration.enableHandlerForSite.calledWith('404', sites[1])).to.be.true;

    expect(mockSlackContext.say.calledWith('Bulk update completed with the following responses:\n'
        + 'https://site1.com: successfully updated\n'
        + 'https://site2.com: successfully updated\n')).to.be.true;
  });

  describe('bad requests', () => {
    it('returns bad request when baseURLs is not provided', async () => {
      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['enable', '', 'cwv,404'];
      await command.handleExecution(args, mockSlackContext);

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;
      expect(mockSlackContext.say.calledWith('Base URLs are required')).to.be.true;
    });

    it('returns bad request when baseURLs has wrong format', async () => {
      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['enable', 'wrong_format', 'cwv,404'];
      await command.handleExecution(args, mockSlackContext);

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;
      expect(mockSlackContext.say.calledWith('Invalid URL format: wrong_format')).to.be.true;
    });

    it('returns bad request when auditTypes is not provided', async () => {
      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['enable', 'http://site1.com,https://site2.com', ''];
      await command.handleExecution(args, mockSlackContext);

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;
      expect(mockSlackContext.say.calledWith('Audit types are required')).to.be.true;
    });

    it('returns bad request when enableAudits is not provided', async () => {
      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['', 'http://site1.com,https://site2.com', 'cwv,404'];
      await command.handleExecution(args, mockSlackContext);

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;
      expect(mockSlackContext.say.calledWith('enable/disable value is required')).to.be.true;
    });

    it('returns bad request when enableAudits has wrong format', async () => {
      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['wrong_format', 'http://site1.com,https://site2.com', 'cwv,404'];
      await command.handleExecution(args, mockSlackContext);

      expect(mockConfiguration.enableHandlerForSite.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockDataAccess.updateConfiguration.called).to.be.false;
      expect(mockSlackContext.say.calledWith('Invalid enable/disable value: wrong_format')).to.be.true;
    });

    it('returns not found when site is not found', async () => {
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

  describe('errors', () => {
    it('error during execution', async () => {
      mockDataAccess.getSiteByBaseURL.withArgs('https://site1.com').resolves(sites[0]);

      const error = new Error('Test error');
      mockDataAccess.updateConfiguration.rejects(error);

      const command = UpdateSitesAuditsCommand(mockContext);
      const args = ['enable', 'http://site1.com', 'cwv,404'];
      await command.handleExecution(args, mockSlackContext);

      expect(mockContext.log.error.calledWith(error)).to.be.true;
      expect(
        mockSlackContext.say.calledWith(':nuclear-warning: Failed to enable audits for all provided sites: Test error'),
      ).to.be.true;
    });
  });
});
