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

import sinon from 'sinon';
import { expect } from 'chai';
import esmock from 'esmock';

const SUCCESS_MESSAGE_PREFIX = ':white_check_mark: ';
const ERROR_MESSAGE_PREFIX = ':x: ';

describe('EnsurePreflightCommand', () => {
  const sandbox = sinon.createSandbox();

  let configurationMock;
  let dataAccessMock;
  let contextMock;
  let slackContextMock;
  let EnsurePreflightCommand;
  let isPreflightSiteConfigReadyStub;
  let promptPreflightConfigStub;
  let enablePreflightAuditForSiteStub;

  const site = {
    getId: () => 'site1',
    getBaseURL: () => 'https://example.com',
    getOrganizationId: () => 'org1',
  };

  beforeEach(async () => {
    isPreflightSiteConfigReadyStub = sandbox.stub();
    promptPreflightConfigStub = sandbox.stub().resolves();
    enablePreflightAuditForSiteStub = sandbox.stub().resolves();

    configurationMock = {
      enableHandlerForSite: sandbox.stub(),
      getHandlers: sandbox.stub().returns({ preflight: { type: 'preflight' } }),
      save: sandbox.stub().resolves(),
    };

    dataAccessMock = {
      Configuration: {
        findLatest: sandbox.stub().resolves(configurationMock),
      },
      Site: {
        findByBaseURL: sandbox.stub().resolves(site),
        allByExternalOwnerIdAndExternalSiteId: sandbox.stub().resolves([]),
      },
    };

    contextMock = {
      log: { error: sandbox.stub() },
      dataAccess: dataAccessMock,
    };

    slackContextMock = {
      say: sandbox.stub().resolves(),
    };

    EnsurePreflightCommand = await esmock('../../../../src/support/slack/commands/ensure-preflight.js', {
      '../../../../src/support/slack/preflight/preflight-config.js': {
        isPreflightSiteConfigReady: isPreflightSiteConfigReadyStub,
        promptPreflightConfig: promptPreflightConfigStub,
        enablePreflightAuditForSite: enablePreflightAuditForSiteStub,
        PREFLIGHT_AUDIT_TYPE: 'preflight',
        ERROR_MESSAGE_PREFIX,
        SUCCESS_MESSAGE_PREFIX,
      },
      '../../../../src/utils/slack/base.js': {
        extractURLFromSlackInput: (value) => value,
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('shows usage when base URL is invalid', async () => {
    const command = EnsurePreflightCommand(contextMock);
    await command.handleExecution(['not-a-url'], slackContextMock);

    expect(slackContextMock.say).to.have.been.calledWith(`${ERROR_MESSAGE_PREFIX}Please provide a valid site baseURL.`);
  });

  it('shows error when site is not found', async () => {
    dataAccessMock.Site.findByBaseURL.resolves(null);
    const command = EnsurePreflightCommand(contextMock);
    await command.handleExecution(['https://missing.example.com'], slackContextMock);

    expect(slackContextMock.say).to.have.been.calledWith(`${ERROR_MESSAGE_PREFIX}Cannot update site with baseURL: "https://missing.example.com", site not found.`);
  });

  it('shows error when preflight audit is not registered', async () => {
    configurationMock.getHandlers.returns({});
    const command = EnsurePreflightCommand(contextMock);
    await command.handleExecution(['https://example.com'], slackContextMock);

    expect(slackContextMock.say).to.have.been.calledWith(`${ERROR_MESSAGE_PREFIX}The "preflight" audit is not present in the configuration.`);
  });

  it('prompts for configuration when site config is not ready', async () => {
    isPreflightSiteConfigReadyStub.resolves({
      ready: false,
      missingLabels: ['Authoring Type', 'Preview URL'],
      needsContentSourcePath: false,
    });

    const command = EnsurePreflightCommand(contextMock);
    await command.handleExecution(['https://example.com'], slackContextMock);

    expect(promptPreflightConfigStub).to.have.been.calledWith(slackContextMock, site, 'preflight');
    expect(enablePreflightAuditForSiteStub.called).to.be.false;
  });

  it('prompts with content source path guidance when only content source path is missing', async () => {
    isPreflightSiteConfigReadyStub.resolves({
      ready: false,
      missingLabels: ['Content Source Path'],
      needsContentSourcePath: true,
    });

    const command = EnsurePreflightCommand(contextMock);
    await command.handleExecution(['https://example.com'], slackContextMock);

    expect(promptPreflightConfigStub.called).to.be.false;
    expect(slackContextMock.say).to.have.been.calledOnce;
    const message = slackContextMock.say.firstCall.args[0];
    expect(message.blocks[0].text.text).to.include('Content Source Path');
    expect(message.blocks[1].elements[0].action_id).to.equal('open_preflight_config');
  });

  it('enables preflight when site config is ready', async () => {
    isPreflightSiteConfigReadyStub.resolves({
      ready: true,
      missingLabels: [],
      needsContentSourcePath: false,
    });

    const command = EnsurePreflightCommand(contextMock);
    await command.handleExecution(['https://example.com'], slackContextMock);

    expect(enablePreflightAuditForSiteStub).to.have.been.calledWith(site, dataAccessMock);
    expect(slackContextMock.say).to.have.been.calledWith(`${SUCCESS_MESSAGE_PREFIX}Preflight audit has been enabled for "https://example.com".`);
  });

  it('handles unexpected errors and reports them to Slack', async () => {
    const error = new Error('enable failed');
    isPreflightSiteConfigReadyStub.resolves({
      ready: true,
      missingLabels: [],
      needsContentSourcePath: false,
    });
    enablePreflightAuditForSiteStub.rejects(error);

    const command = EnsurePreflightCommand(contextMock);
    await command.handleExecution(['https://example.com'], slackContextMock);

    expect(contextMock.log.error).to.have.been.calledWith(error);
    expect(slackContextMock.say).to.have.been.calledWith(
      `${ERROR_MESSAGE_PREFIX}An error occurred while trying to ensure preflight for site "https://example.com": enable failed`,
    );
  });
});
