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

  it('enable an audit type for a site', async () => {
    dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

    const command = ToggleSiteAuditCommand(contextMock);
    const args = ['enable', 'https://site0.com', 'some_audit'];
    await command.handleExecution(args, slackContextMock);

    expect(
      dataAccessMock.Site.findByBaseURL.calledWith('https://site0.com'),
      'Expected dataAccess.getSiteByBaseURL to be called with "https://site0.com", but it was not',
    ).to.be.true;
    expect(
      configurationMock.save.called,
      'Expected configuration.save to be called, but it was not',
    ).to.be.true;
    expect(
      configurationMock.enableHandlerForSite.calledWith('some_audit', site),
      'Expected configuration.enableHandlerForSite to be called with "some_audit" and site, but it was not',
    ).to.be.true;
    expect(
      slackContextMock.say.calledWith(`${SUCCESS_MESSAGE_PREFIX}The audit "some_audit" has been *enabled* for "https://site0.com".`),
      'Expected Slack message to be sent confirming "some_audit" was enabled for "https://site0.com", but it was not',
    ).to.be.true;
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
    it('error during execution', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const error = new Error('Test error');
      configurationMock.save.rejects(error);

      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', 'http://site0.com', 'some_audit'];
      await command.handleExecution(args, slackContextMock);

      expect(
        contextMock.log.error.calledWith(error),
        'Expected log.error to be called with the provided error, but it was not',
      ).to.be.true;
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: Test error`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: Test error"`,
      ).to.be.true;
    });
  });

  describe('Bad Request Errors', () => {
    it('if "enableAudit" parameter is missed', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['', 'http://site0.com', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: The "enableAudit" parameter is required and must be set to "enable" or "disable".`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: The "enableAudit" parameter is required and must be set to "enable" or "disable"."`,
      ).to.be.true;
    });

    it('if "enableAudits" parameter has wrong value', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['wrong_value', 'http://site0.com', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: The "enableAudit" parameter is required and must be set to "enable" or "disable".`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: The "enableAudit" parameter is required and must be set to "enable" or "disable"."`,
      ).to.be.true;
    });

    it('if "baseURL" is not provided', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', '', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL.", but it was not called with that message.`,
      ).to.be.true;
    });

    it('if "baseURL" has wrong site format', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', 'wrong_site_format', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}Please provide either a CSV file or a single baseURL."`,
      ).to.be.true;
    });

    it('if a site is not found', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(null);

      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', 'https://site0.com', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Cannot update site with baseURL: "https://site0.com", site not found.`),
        'Expected slackContextMock.say to be called with the specified error message, but it was not.',
      ).to.be.true;
    });

    it('if "auditType" parameter is missing', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', 'http://site0.com', ''];
      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: The audit type parameter is required.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}An error occurred while trying to enable or disable audits: The audit type parameter is required.", but it was not called with that message.`,
      ).to.be.true;
    });

    it('if an audit type is not present in the configuration', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const command = ToggleSiteAuditCommand(contextMock);
      const auditType = 'not_present_in_configuration_audit';
      const args = ['enable', 'https://site0.com', auditType];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}The "${auditType}" is not present in the configuration.\nList of allowed`
          + ` audits:\n${Object.keys(handlers).join('\n')}.`),
        'Expected error message was not called',
      ).to.be.true;
    });
  });

  describe('CSV bulk operations', () => {
    it('should process CSV file to enable with profile', async () => {
      const args = ['enable', 'demo'];
      const command = ToggleSiteAuditCommand(contextMock);

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'https://mock-url',
      }];
      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(site);
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves(site);

      await command.handleExecution(args, slackContextMock);

      expect(configurationMock.enableHandlerForSite.callCount)
        .to.equal(46); // 23 audits in demo profile × 2 sites
      expect(configurationMock.save.calledOnce).to.be.true;
      expect(slackContextMock.say.calledWith(sinon.match('Successfully'))).to.be.true;
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

    it('should handle errors during audit enabling/disabling in bulk processing', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      dataAccessMock.Site.findByBaseURL.withArgs('https://site1.com').resolves(site);
      dataAccessMock.Site.findByBaseURL.withArgs('https://site2.com').resolves(site);

      configurationMock.enableHandlerForSite
        .withArgs('cwv', site)
        .onFirstCall().returns()
        .onSecondCall()
        .throws(new Error('Test error during enable'));

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(
        sinon.match((value) => value.includes(':clipboard: *Bulk Update Results*')
          && value.includes('Successfully enabled for 1 sites')
          && value.includes('https://site1.com')
          && value.includes('Failed to process 1 sites')
          && value.includes('https://site2.com: Test error during enable')),
      )).to.be.true;

      expect(configurationMock.save.calledOnce).to.be.true;
    });

    it('should handle CSV file with invalid URLs', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve('invalid-url\nhttps://valid.com'),
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Invalid URLs found'))).to.be.true;
    });

    it('should handle CSV file with only invalid URLs', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(' \n  '),
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match(':x: No valid URLs found in the CSV file.'))).to.be.true;
    });

    it('should handle empty CSV file', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(''),
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('CSV file is empty'))).to.be.true;
    });

    it('should handle CSV download failure', async () => {
      fetchStub.resolves({
        ok: false,
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Failed to download'))).to.be.true;
    });

    it('should handle CSV file with invalid URLs', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve('invalid-url1\ninvalid-url2'),
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Invalid URLs found'))).to.be.true;
    });

    it('should handle sites that are not found during bulk processing', async () => {
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
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(
        sinon.match((value) => value.includes(':clipboard: *Bulk Update Results*')
          && value.includes('Successfully enabled for 1 sites')
          && value.includes('https://site1.com')
          && value.includes('Failed to process 1 sites')
          && value.includes('https://nonexistent-site.com: Site not found')),
      )).to.be.true;

      expect(configurationMock.save.calledOnce).to.be.true;
    });

    it('should throw an error when CSV processing fails', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve('"unclosed quote\nhttp://example.com'),
      });

      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'cwv'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('CSV processing failed:'))).to.be.true;
    });
  });

  describe('profile handling', () => {
    it('should handle invalid profile name', async () => {
      slackContextMock.files = [{
        name: 'sites.csv',
        url_private: 'http://mock-url',
      }];

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'invalid-profile'], slackContextMock);

      expect(slackContextMock.say.calledWith(sinon.match('Invalid audit type or profile'))).to.be.true;
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

    it('should enable preflight audit when authoring type and delivery config are present for cs', async () => {
      preflightSiteMock.getAuthoringType.returns('cs');
      preflightSiteMock.getDeliveryConfig.returns({ programId: '12345', environmentId: '67890' });
      preflightSiteMock.getHlxConfig.returns({});

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(configurationMock.enableHandlerForSite.calledWith('preflight', preflightSiteMock));
      expect(configurationMock.save.called).to.be.true;
      expect(slackContextMock.say.calledWith(':white_check_mark: The audit "preflight" has been *enabled* for "https://example.com".'));
    });

    it('should enable preflight audit when authoring type and helix config are present for documentauthoring', async () => {
      preflightSiteMock.getAuthoringType.returns('documentauthoring');
      preflightSiteMock.getDeliveryConfig.returns({});
      preflightSiteMock.getHlxConfig.returns({ rso: { owner: 'test', site: 'testsite' } });

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(configurationMock.enableHandlerForSite.calledWith('preflight', preflightSiteMock));
      expect(configurationMock.save.called).to.be.true;
      expect(slackContextMock.say.calledWith(':white_check_mark: The audit "preflight" has been *enabled* for "https://example.com".'));
    });

    it('should prompt for configuration when authoring type is missing', async () => {
      preflightSiteMock.getAuthoringType.returns(null);
      preflightSiteMock.getDeliveryConfig.returns({});
      preflightSiteMock.getHlxConfig.returns({});

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.calledWith({
        text: ':warning: Preflight audit requires additional configuration for `https://example.com`',
        blocks: sinon.match.array,
      }));
      expect(configurationMock.enableHandlerForSite.called).to.be.false;
    });

    it('should prompt for configuration when documentauthoring type missing helix config', async () => {
      preflightSiteMock.getAuthoringType.returns('documentauthoring');
      preflightSiteMock.getDeliveryConfig.returns({});
      preflightSiteMock.getHlxConfig.returns({});

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.calledWith({
        text: ':warning: Preflight audit requires additional configuration for `https://example.com`',
        blocks: sinon.match.array,
      }));
      expect(configurationMock.enableHandlerForSite.called).to.be.false;
    });

    it('should prompt for configuration when cs type missing delivery config', async () => {
      preflightSiteMock.getAuthoringType.returns('cs');
      preflightSiteMock.getDeliveryConfig.returns({}); // Empty delivery config
      preflightSiteMock.getHlxConfig.returns({});

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.calledWith({
        text: ':warning: Preflight audit requires additional configuration for `https://example.com`',
        blocks: sinon.match.array,
      }));
      expect(configurationMock.enableHandlerForSite.called).to.be.false;
    });

    it('should prompt for configuration when cs/crosswalk type missing delivery config', async () => {
      preflightSiteMock.getAuthoringType.returns('cs/crosswalk');
      preflightSiteMock.getDeliveryConfig.returns({ programId: '12345' }); // Missing environmentId
      preflightSiteMock.getHlxConfig.returns({});

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      expect(slackContextMock.say.calledWith({
        text: ':warning: Preflight audit requires additional configuration for `https://example.com`',
        blocks: sinon.match.array,
      })).to.be.true;
      expect(configurationMock.enableHandlerForSite.called).to.be.false;
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

    it('should show correct missing items for documentauthoring with missing helix config', async () => {
      preflightSiteMock.getAuthoringType.returns('documentauthoring');
      preflightSiteMock.getDeliveryConfig.returns(null);
      preflightSiteMock.getHlxConfig.returns(null);

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      // Verify the configuration prompt was called
      expect(slackContextMock.say.called).to.be.true;

      // Find calls that contain the expected text pattern
      const sayCallsWithConfig = slackContextMock.say.getCalls().find((call) => {
        const arg = call.args[0];
        return typeof arg === 'object'
               && arg.blocks
               && arg.blocks[0]
               && arg.blocks[0].text
               && arg.blocks[0].text.text
               && arg.blocks[0].text.text.includes('Helix Preview URL');
      });

      expect(sayCallsWithConfig).to.not.be.undefined;
      expect(configurationMock.enableHandlerForSite.called).to.be.false;
    });

    it('should show correct missing items for cs with missing delivery config', async () => {
      preflightSiteMock.getAuthoringType.returns('cs');
      preflightSiteMock.getDeliveryConfig.returns({});
      preflightSiteMock.getHlxConfig.returns({});

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      // Verify the configuration prompt was called
      expect(slackContextMock.say.called).to.be.true;

      // Find calls that contain the expected text pattern
      const sayCallsWithConfig = slackContextMock.say.getCalls().find((call) => {
        const arg = call.args[0];
        return typeof arg === 'object'
               && arg.blocks
               && arg.blocks[0]
               && arg.blocks[0].text
               && arg.blocks[0].text.text
               && arg.blocks[0].text.text.includes('AEM CS Preview URL');
      });

      expect(sayCallsWithConfig).to.not.be.undefined;
      expect(configurationMock.enableHandlerForSite.called).to.be.false;
    });

    it('should show correct button value with site and audit type', async () => {
      preflightSiteMock.getAuthoringType.returns(null);
      preflightSiteMock.getId.returns('site123');
      preflightSiteMock.getDeliveryConfig.returns({});
      preflightSiteMock.getHlxConfig.returns({});

      const command = ToggleSiteAuditCommand(contextMock);
      await command.handleExecution(['enable', 'https://example.com', 'preflight'], slackContextMock);

      // Verify the configuration prompt was called
      expect(slackContextMock.say.called).to.be.true;

      // Find the call with button structure
      const sayCallWithButton = slackContextMock.say.getCalls().find((call) => {
        const arg = call.args[0];
        return typeof arg === 'object'
               && arg.blocks
               && arg.blocks[1]
               && arg.blocks[1].elements
               && arg.blocks[1].elements[0]
               && arg.blocks[1].elements[0].action_id === 'open_preflight_config';
      });

      expect(sayCallWithButton).to.not.be.undefined;

      const button = sayCallWithButton.args[0].blocks[1].elements[0];
      expect(button.action_id).to.equal('open_preflight_config');

      const buttonValue = JSON.parse(button.value);
      expect(buttonValue.siteId).to.equal('site123');
      expect(buttonValue.auditType).to.equal('preflight');
      expect(configurationMock.enableHandlerForSite.called).to.be.false;
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
      expect(slackContextMock.say.calledWith(sinon.match(/Successfully disabled 3 audits/))).to.be.true;
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

    it('should reject enable all', async () => {
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

      const command = ToggleSiteAuditCommandWithProfile(contextMock);
      const args = ['enable', 'https://site0.com', 'all'];
      await command.handleExecution(args, slackContextMock);

      expect(configurationMock.enableHandlerForSite.called).to.be.false;
      expect(configurationMock.save.called).to.be.false;
      expect(slackContextMock.say.calledWith(sinon.match(/Enable all is not supported/))).to.be.true;
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
