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
import esmock from 'esmock';

const SUCCESS_MESSAGE_PREFIX = ':white_check_mark: ';
const ERROR_MESSAGE_PREFIX = ':x: ';

describe('UpdateSitesAuditsCommand', () => {
  const sandbox = sinon.createSandbox();

  const site = {
    getId: () => 'site0',
    getBaseURL: () => 'https://site0.com',
    getDeliveryType: () => 'aem_edge',
  };
  const handlers = { some_audit: {}, cwv: {} };

  let configurationMock;
  let dataAccessMock;
  let logMock;
  let contextMock;
  let slackContextMock;
  let ToggleSiteAuditCommand;
  let fetchStub;
  const exceptsAtBadRequest = () => {
    expect(
      configurationMock.enableHandlerForSite.called,
      'Expected enableHandlerForSite to not be called, but it was',
    ).to.be.false;
    expect(
      configurationMock.disableHandlerForSite.called,
      'Expected disableHandlerForSite to not be called, but it was',
    ).to.be.false;
    expect(
      configurationMock.save.called,
      'Expected updateConfiguration to not be called, but it was',
    ).to.be.false;
  };

  beforeEach(async () => {
    configurationMock = {
      enableHandlerForSite: sandbox.stub(),
      disableHandlerForSite: sandbox.stub(),
      getVersion: sandbox.stub(),
      getJobs: sandbox.stub(),
      getHandlers: sandbox.stub().returns(handlers),
      getQueues: sandbox.stub(),
      getSlackRoles: sandbox.stub(),
      save: sandbox.stub(),
    };

    dataAccessMock = {
      Configuration: {
        findLatest: sandbox.stub().resolves(configurationMock),
      },
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
    };

    fetchStub = sinon.stub().resolves({
      ok: true,
      text: () => Promise.resolve('https://site1.com\nhttps://site2.com'),
    });
    ToggleSiteAuditCommand = await esmock('../../../../src/support/slack/commands/toggle-site-audit.js', {
      '@adobe/spacecat-shared-utils': {
        tracingFetch: fetchStub,
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('shows deprecation message for enable command', async () => {
    const command = ToggleSiteAuditCommand(contextMock);
    const args = ['enable', 'https://site0.com', 'some_audit'];
    await command.handleExecution(args, slackContextMock);

    expect(
      slackContextMock.say.called,
      'Expected Slack say to be called with deprecation message',
    ).to.be.true;
    expect(
      slackContextMock.say.firstCall.args[0],
      'Expected deprecation message to be shown',
    ).to.include('discontinued');
    expect(
      configurationMock.save.called,
      'Expected configuration.save to NOT be called (command is deprecated)',
    ).to.be.false;
    expect(
      configurationMock.enableHandlerForSite.called,
      'Expected configuration.enableHandlerForSite to NOT be called (command is deprecated)',
    ).to.be.false;
  });

  it('disable an audit type for a site', async () => {
    dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

    const command = ToggleSiteAuditCommand(contextMock);
    const args = ['disable', 'https://site0.com', 'some_audit'];
    await command.handleExecution(args, slackContextMock);

    expect(
      dataAccessMock.Site.findByBaseURL.calledWith('https://site0.com'),
      'Expected dataAccess.getSiteByBaseURL to be called with "https://site0.com", but it was not',
    ).to.be.true;
    expect(
      configurationMock.save.called,
      'Expected dataAccess.updateConfiguration to be called, but it was not',
    ).to.be.true;
    expect(
      configurationMock.disableHandlerForSite.calledWith('some_audit', site),
      'Expected configuration.disableHandlerForSite to be called with "some_audit" and site, but it was not',
    ).to.be.true;
    expect(
      slackContextMock.say.calledWith(`${SUCCESS_MESSAGE_PREFIX}The audit "some_audit" has been *disabled* for "https://site0.com".`),
      'Expected Slack message to be sent confirming "some_audit" was disabled for "https://site0.com", but it was not',
    ).to.be.true;
  });

  it('if site base URL without scheme should be added "https://"', async () => {
    dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

    const command = ToggleSiteAuditCommand(contextMock);
    const args = ['disable', 'site0.com', 'some_audit'];
    await command.handleExecution(args, slackContextMock);

    expect(
      dataAccessMock.Site.findByBaseURL.calledWith('https://site0.com'),
      'Expected dataAccess.getSiteByBaseURL to be called with "site0.com", but it was not',
    ).to.be.true;
  });

  describe('Internal errors', () => {
    it('shows deprecation message for enable command (error test)', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', 'http://site0.com', 'some_audit'];
      await command.handleExecution(args, slackContextMock);

      expect(
        slackContextMock.say.called,
        'Expected Slack say to be called',
      ).to.be.true;
      expect(
        slackContextMock.say.firstCall.args[0],
        'Expected deprecation message to be shown',
      ).to.include('discontinued');
      expect(
        contextMock.log.error.called,
        'Expected log.error to NOT be called (command is deprecated)',
      ).to.be.false;
    });

    it('error during single site disable execution', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const error = new Error('Test error during disable');
      configurationMock.save.rejects(error);

      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['disable', 'http://site0.com', 'some_audit'];
      await command.handleExecution(args, slackContextMock);

      expect(
        contextMock.log.error.calledWith(error),
        'Expected log.error to be called with the provided error',
      ).to.be.true;
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to disable audits: Test error during disable`),
        'Expected say method to be called with error message',
      ).to.be.true;
    });
  });

  describe('Bad Request Errors', () => {
    it('if "enableAudit" parameter is missed (disable)', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['', 'http://site0.com', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to disable audits: The "enableAudit" parameter is required and must be set to "enable" or "disable".`),
        'Expected say method to be called with error message',
      ).to.be.true;
    });

    it('if "enableAudits" parameter has wrong value (disable)', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['wrong_value', 'http://site0.com', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to disable audits: The "enableAudit" parameter is required and must be set to "enable" or "disable".`),
        'Expected say method to be called with error message',
      ).to.be.true;
    });

    it('if "baseURL" is not provided (shows deprecation for enable)', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', '', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('if "baseURL" has wrong site format (shows deprecation for enable)', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', 'wrong_site_format', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('if a site is not found (shows deprecation for enable)', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', 'https://site0.com', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('if "auditType" parameter is missing (shows deprecation for enable)', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', 'http://site0.com', ''];
      await command.handleExecution(args, slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('if an audit type is not present in the configuration (shows deprecation for enable)', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const auditType = 'not_present_in_configuration_audit';
      const args = ['enable', 'https://site0.com', auditType];

      await command.handleExecution(args, slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('if "baseURL" is not provided (disable)', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['disable', '', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL.`),
      ).to.be.true;
    });

    it('if "baseURL" has wrong site format (disable)', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['disable', 'wrong_site_format', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL.`),
      ).to.be.true;
    });

    it('if a site is not found (disable)', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(null);

      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['disable', 'https://site0.com', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Cannot update site with baseURL: "https://site0.com", site not found.`),
      ).to.be.true;
    });

    it('if "auditType" parameter is missing (disable)', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['disable', 'http://site0.com', ''];
      await command.handleExecution(args, slackContextMock);

      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to disable audits: The audit type parameter is required.`),
      ).to.be.true;
    });

    it('if an audit type is not present in the configuration (disable)', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const command = ToggleSiteAuditCommand(contextMock);
      const auditType = 'not_present_in_configuration_audit';
      const args = ['disable', 'https://site0.com', auditType];

      await command.handleExecution(args, slackContextMock);

      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}The "${auditType}" is not present in the configuration.\nList of allowed audits:\n${Object.keys(handlers).join('\n')}.`),
      ).to.be.true;
    });
  });

  describe('CSV bulk operations', () => {
    it('shows deprecation message for enable CSV operations', async () => {
      const args = ['enable', 'demo'];
      const command = ToggleSiteAuditCommand(contextMock);

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'https://mock-url',
      }];

      await command.handleExecution(args, slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
      expect(configurationMock.enableHandlerForSite.called).to.be.false;
    });

    it('should process CSV file to disable with profile', async () => {
      const args = ['disable', 'demo'];
      const command = ToggleSiteAuditCommand(contextMock);

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'https://mock-url',
      }];
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(site);
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves(site);

      await command.handleExecution(args, slackContextMock);

      expect(configurationMock.disableHandlerForSite.callCount)
        .to.equal(46); // 23 audits in demo profile × 2 sites
      expect(configurationMock.save.calledOnce).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('Successfully'))).to.be.true;
    });

    it('shows deprecation for enable CSV errors', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation for enable CSV with invalid URLs', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation for enable CSV with only invalid URLs', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation for enable empty CSV', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation for enable CSV download failure', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation for enable CSV with invalid URLs (duplicate test)', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation for enable bulk with missing sites', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation when enable CSV processing fails', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('should handle CSV file with invalid URLs (disable)', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve('invalid-url\nhttps://valid.com'),
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['disable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Invalid URLs found'))).to.be.true;
    });

    it('should handle CSV file with only invalid URLs (disable)', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(' \n  '),
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['disable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match(':x: No valid URLs found in the CSV file.'))).to.be.true;
    });

    it('should handle empty CSV file (disable)', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(''),
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['disable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('CSV file is empty'))).to.be.true;
    });

    it('should handle CSV download failure (disable)', async () => {
      fetchStub.resolves({
        ok: false,
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['disable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Failed to download'))).to.be.true;
    });

    it('should handle CSV processing error (disable)', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve('"unclosed quote\nhttp://example.com'),
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['disable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('CSV processing failed:'))).to.be.true;
    });

    it('should handle sites that are not found during bulk processing (disable)', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve('https://site1.com\nhttps://nonexistent-site.com'),
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(site);
      dataAccessMock.Site.findByBaseURL.withArgs('https://nonexistent-site.com').resolves(null);

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['disable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(
        sinon.match((value) => value.includes(':clipboard: *Bulk Update Results*')
          && value.includes('Successfully disabled for 1 sites')
          && value.includes('https://site1.com')
          && value.includes('Failed to process 1 sites')
          && value.includes('https://nonexistent-site.com: Site not found')),
      )).to.be.true;

      expect(configurationMock.save.calledOnce).to.be.true;
    });

    it('should handle errors during audit disabling in bulk processing', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(site);
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves(site);

      configurationMock.disableHandlerForSite
        .withArgs('cwv', site)
        .onFirstCall().returns()
        .onSecondCall()
        .throws(new Error('Test error during disable'));

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['disable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(
        sinon.match((value) => value.includes(':clipboard: *Bulk Update Results*')
          && value.includes('Successfully disabled for 1 sites')
          && value.includes('https://site1.com')
          && value.includes('Failed to process 1 sites')
          && value.includes('https://site2.com: Test error during disable')),
      )).to.be.true;

      expect(configurationMock.save.calledOnce).to.be.true;
    });

    it('should handle invalid profile name (disable)', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['disable', 'invalid-profile'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Invalid audit type or profile'))).to.be.true;
    });
  });

  describe('profile handling', () => {
    it('shows deprecation for enable with invalid profile', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'invalid-profile'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });
  });

  describe('preflight audit configuration', () => {
    let preflightSiteMock;

    beforeEach(() => {
      const auditConfig = new Map();
      auditConfig.set('preflight', { type: 'preflight' });
      configurationMock.getHandlers.returns(Object.fromEntries(auditConfig));

      preflightSiteMock = {
        getBaseURL: sandbox.stub().returns('https://example.com'),
        getId: sandbox.stub().returns('site123'),
        getAuthoringType: sandbox.stub(),
        getDeliveryConfig: sandbox.stub(),
        getHlxConfig: sandbox.stub(),
      };

      dataAccessMock.Site.findByBaseURL.resolves(preflightSiteMock);
    });

    it('shows deprecation for enable preflight with cs config', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation for enable preflight with helix config', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation when enable preflight missing authoring type', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation when enable preflight documentauthoring missing helix', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation when enable preflight cs missing delivery config', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation when enable preflight cs/crosswalk missing delivery', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('should prompt for configuration when ams type missing delivery config', async () => {
      preflightSiteMock.getAuthoringType.returns('ams');
      preflightSiteMock.getDeliveryConfig.returns({ }); // missing author url
      preflightSiteMock.getHlxConfig.returns({});

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.calledWith({
        text: ':warning: Preflight audit requires additional configuration for `https://example.com`',
        blocks: sinon.match.array,
      }));
    });

    it('shows deprecation for enable preflight documentauthoring missing helix', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation for enable preflight cs missing delivery config', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });

    it('shows deprecation for enable preflight with button', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
    });
  });

  describe('Disable All Audits', () => {
    let loadProfileConfigStub;
    let ToggleSiteAuditCommandWithProfile;

    beforeEach(async () => {
      loadProfileConfigStub = sinon.stub().returns({
        audits: {
          cwv: {},
          'meta-tags': {},
          'broken-backlinks': {},
        },
      });

      ToggleSiteAuditCommandWithProfile = await esmock('../../../../src/support/slack/commands/toggle-site-audit.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: fetchStub,
        },
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: (input) => (input.startsWith('http') ? input : `https://${input}`),
          loadProfileConfig: loadProfileConfigStub,
        },
      });
    });

    it('should disable all audits from demo profile by default', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const command = ToggleSiteAuditCommandWithProfile(contextMock);
      const args = ['disable', 'https://site0.com', 'all'];
      await command.handleExecution(args, slackContextMock);

      expect(loadProfileConfigStub.calledWith('demo')).to.be.true;
      expect(configurationMock.disableHandlerForSite.calledWith('cwv', site)).to.be.true;
      expect(configurationMock.disableHandlerForSite.calledWith('meta-tags', site)).to.be.true;
      expect(configurationMock.disableHandlerForSite.calledWith('broken-backlinks', site)).to.be.true;
      expect(configurationMock.save.called).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match(/Successfully disabled all audits/))).to.be.true;
    });

    it('should disable all audits from specified profile', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const command = ToggleSiteAuditCommandWithProfile(contextMock);
      const args = ['disable', 'https://site0.com', 'all', 'paid'];
      await command.handleExecution(args, slackContextMock);

      expect(loadProfileConfigStub.calledWith('paid')).to.be.true;
      expect(configurationMock.disableHandlerForSite.calledThrice).to.be.true;
      expect(configurationMock.save.called).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match(/from profile "paid"/))).to.be.true;
    });

    it('shows deprecation for enable all', async () => {
      const command = ToggleSiteAuditCommandWithProfile(contextMock);
      const args = ['enable', 'https://site0.com', 'all'];
      await command.handleExecution(args, slackContextMock);

      expect(slackContextMock.say.firstCall.args[0]).to.include('discontinued');
      expect(configurationMock.enableHandlerForSite.called).to.be.false;
      expect(configurationMock.save.called).to.be.false;
    });

    it('should show error if profile not found', async () => {
      loadProfileConfigStub.throws(new Error('Profile not found'));
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const command = ToggleSiteAuditCommandWithProfile(contextMock);
      const args = ['disable', 'https://site0.com', 'all', 'invalid'];
      await command.handleExecution(args, slackContextMock);

      expect(configurationMock.disableHandlerForSite.called).to.be.false;
      expect(configurationMock.save.called).to.be.false;
      expect(slackContextMock.say.calledWith(sinon.match(/Profile "invalid" not found/))).to.be.true;
    });

    it('should show error if site not found for disable all', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(null);

      const command = ToggleSiteAuditCommandWithProfile(contextMock);
      const args = ['disable', 'https://site0.com', 'all'];
      await command.handleExecution(args, slackContextMock);

      expect(configurationMock.disableHandlerForSite.called).to.be.false;
      expect(configurationMock.save.called).to.be.false;
      expect(slackContextMock.say.calledWith(sinon.match(/site not found/))).to.be.true;
    });

    it('should handle profile with no audits gracefully', async () => {
      loadProfileConfigStub.returns({ audits: {} }); // Empty audits object
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const command = ToggleSiteAuditCommandWithProfile(contextMock);
      const args = ['disable', 'https://site0.com', 'all'];
      await command.handleExecution(args, slackContextMock);

      expect(configurationMock.disableHandlerForSite.called).to.be.false;
      expect(configurationMock.save.called).to.be.false;
    });

    it('should handle profile with null audits gracefully', async () => {
      loadProfileConfigStub.returns({ audits: null }); // Null audits (tests || {} fallback)
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const command = ToggleSiteAuditCommandWithProfile(contextMock);
      const args = ['disable', 'https://site0.com', 'all'];
      await command.handleExecution(args, slackContextMock);

      expect(configurationMock.disableHandlerForSite.called).to.be.false;
      expect(configurationMock.save.called).to.be.false;
    });

    it('should handle profile with undefined audits gracefully', async () => {
      loadProfileConfigStub.returns({}); // No audits property (tests || {} fallback)
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const command = ToggleSiteAuditCommandWithProfile(contextMock);
      const args = ['disable', 'https://site0.com', 'all'];
      await command.handleExecution(args, slackContextMock);

      expect(configurationMock.disableHandlerForSite.called).to.be.false;
      expect(configurationMock.save.called).to.be.false;
    });
  });
});
