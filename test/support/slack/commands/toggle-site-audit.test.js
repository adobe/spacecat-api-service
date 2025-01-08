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
import ToggleSiteAuditCommand from '../../../../src/support/slack/commands/toggle-site-audit.js';

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
    };

    slackContextMock = {
      say: sinon.stub(),
    };
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
      slackContextMock.say.calledWith(`${SUCCESS_MESSAGE_PREFIX}The audit "some_audit" has been *enabled* for the "https://site0.com".`),
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
      slackContextMock.say.calledWith(`${SUCCESS_MESSAGE_PREFIX}The audit "some_audit" has been *disabled* for the "https://site0.com".`),
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
    expect(
      configurationMock.save.called,
      'Expected dataAccess.updateConfiguration to be called, but it was not',
    ).to.be.true;
    expect(
      configurationMock.disableHandlerForSite.calledWith('some_audit', site),
      'Expected configuration.disableHandlerForSite to be called with "some_audit" and site, but it was not',
    ).to.be.true;
    expect(
      slackContextMock.say.calledWith(`${SUCCESS_MESSAGE_PREFIX}The audit "some_audit" has been *disabled* for the "https://site0.com".`),
      'Expected Slack message to be sent confirming "some_audit" was disabled for "https://site0.com", but it was not',
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
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}The "enableAudit" parameter is required and must be set to "enable" or "disable".`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}The 'enableAudits' parameter is required and must be set to 'enable' or 'disable'."`,
      ).to.be.true;
    });

    it('if "enableAudits" parameter has wrong value', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['wrong_value', 'http://site0.com', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}The "enableAudit" parameter is required and must be set to "enable" or "disable".`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}The 'enableAudits' parameter is required and must be set to 'enable' or 'disable'."`,
      ).to.be.true;
    });

    it('if "baseURL" is not provided', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', '', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}The site URL is missing or in the wrong format.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}The site URL is missing or in the wrong format.", but it was not called with that message.`,
      ).to.be.true;
    });

    it('if "baseURL" has wrong site format', async () => {
      const command = ToggleSiteAuditCommand(contextMock);
      const args = ['enable', 'wrong_site_format', 'some_audit'];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}The site URL is missing or in the wrong format.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}The site URL is missing or in the wrong format.", but it was not called with that message.`,
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
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}The audit type parameter is required.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}The audit type parameter is required.", but it was not called with that message.`,
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
});
