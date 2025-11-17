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

describe('RunBrandProfileCommand', () => {
  let RunBrandProfileCommand;
  let startAgentWorkflowStub;
  let postErrorMessageStub;
  let postSiteNotFoundMessageStub;
  let extractURLFromSlackInputStub;
  let context;
  let slackContext;

  const buildSite = (id, baseURL) => ({
    getId: () => id,
    getBaseURL: () => baseURL,
  });

  const loadModule = async () => {
    startAgentWorkflowStub = sinon.stub().resolves('exec-123');
    postErrorMessageStub = sinon.stub().resolves();
    postSiteNotFoundMessageStub = sinon.stub().resolves();
    extractURLFromSlackInputStub = sinon.stub().callsFake((value) => value);

    ({ default: RunBrandProfileCommand } = await esmock(
      '../../../../src/support/slack/commands/run-brand-profile.js',
      {
        '../../../../src/support/agent-workflow.js': {
          startAgentWorkflow: startAgentWorkflowStub,
        },
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: extractURLFromSlackInputStub,
          postErrorMessage: postErrorMessageStub,
          postSiteNotFoundMessage: postSiteNotFoundMessageStub,
        },
      },
    ));
  };

  beforeEach(async function () {
    this.timeout(5000);
    await loadModule();

    context = {
      dataAccess: {
        Site: {
          findByBaseURL: sinon.stub(),
          all: sinon.stub().resolves([]),
        },
      },
      env: { AGENT_WORKFLOW_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123:stateMachine:agent' },
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
    };

    slackContext = {
      say: sinon.stub().resolves(),
      channelId: 'C123',
      threadTs: '123.456',
    };
  });

  it('displays usage when no arguments are provided', async () => {
    const command = RunBrandProfileCommand(context);
    await command.handleExecution([], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch('Usage:');
  });

  it('displays usage when the provided URL is invalid', async () => {
    extractURLFromSlackInputStub.returns('not-a-url');
    const command = RunBrandProfileCommand(context);
    await command.handleExecution(['not-a-url'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch('Usage:');
    expect(startAgentWorkflowStub).to.not.have.been.called;
  });

  it('notifies the user when the site cannot be found', async () => {
    context.dataAccess.Site.findByBaseURL.resolves(null);
    const command = RunBrandProfileCommand(context);
    await command.handleExecution(['https://missing.com'], slackContext);
    expect(postSiteNotFoundMessageStub).to.have.been.calledWith(slackContext.say, 'https://missing.com');
  });

  it('starts the agent workflow for a specific site', async () => {
    const site = buildSite('site-1', 'https://example.com');
    context.dataAccess.Site.findByBaseURL.resolves(site);
    const command = RunBrandProfileCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);
    expect(startAgentWorkflowStub).to.have.been.calledOnce;
    const [, payload] = startAgentWorkflowStub.firstCall.args;
    expect(payload.agentId).to.equal('brand-profile');
    expect(payload.siteId).to.equal('site-1');
    expect(payload.context.baseURL).to.equal('https://example.com');
    expect(slackContext.say).to.have.been.calledWithMatch(':rocket:');
  });

  it('handles errors from startAgentWorkflow for a single site', async () => {
    const site = buildSite('site-2', 'https://boom.com');
    context.dataAccess.Site.findByBaseURL.resolves(site);
    startAgentWorkflowStub.rejects(new Error('boom'));
    const command = RunBrandProfileCommand(context);
    await command.handleExecution(['https://boom.com'], slackContext);
    expect(postErrorMessageStub).to.have.been.calledOnce;
  });

  it('queues the agent for all sites', async () => {
    const sites = [
      buildSite('site-1', 'https://one.com'),
      buildSite('site-2', 'https://two.com'),
    ];
    context.dataAccess.Site.all.resolves(sites);
    const command = RunBrandProfileCommand(context);
    await command.handleExecution(['all'], slackContext);
    expect(startAgentWorkflowStub).to.have.been.calledTwice;
    expect(slackContext.say).to.have.been.calledWithMatch(':white_check_mark:');
  });

  it('reports failures when running across all sites', async () => {
    const sites = [
      buildSite('site-1', 'https://ok.com'),
      buildSite('site-2', 'https://fail.com'),
    ];
    context.dataAccess.Site.all.resolves(sites);
    startAgentWorkflowStub.onSecondCall().rejects(new Error('nope'));
    const command = RunBrandProfileCommand(context);
    await command.handleExecution(['all'], slackContext);
    const warningCall = slackContext.say.getCalls().find((call) => call.args[0].includes(':warning:'));
    expect(warningCall).to.not.be.undefined;
    expect(warningCall.args[0]).to.include('failed to start');
    expect(warningCall.args[0]).to.include('https://fail.com');
  });

  it('warns when the workflow ARN is not configured', async () => {
    context.env = {};
    const command = RunBrandProfileCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch('Agent workflow ARN is not configured');
    expect(startAgentWorkflowStub).to.not.have.been.called;
  });

  it('logs and reports unexpected errors bubbling out of handleSingleSite', async () => {
    const boom = new Error('db exploded');
    context.dataAccess.Site.findByBaseURL.rejects(boom);
    const command = RunBrandProfileCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);
    expect(context.log.error).to.have.been.calledWith('brand-profile command encountered an error', boom);
    expect(postErrorMessageStub).to.have.been.calledWith(slackContext.say, boom);
  });

  it('omits slackContext when channelId is missing', async () => {
    const site = buildSite('site-5', 'https://nostack.com');
    context.dataAccess.Site.findByBaseURL.resolves(site);
    const noChannelContext = {
      ...slackContext,
      channelId: '',
    };
    const command = RunBrandProfileCommand(context);
    await command.handleExecution(['https://nostack.com'], noChannelContext);
    const [, payload] = startAgentWorkflowStub.firstCall.args;
    expect(payload.slackContext).to.be.undefined;
  });

  it('warns when running for all sites but none are found', async () => {
    context.dataAccess.Site.all.resolves([]);
    const command = RunBrandProfileCommand(context);
    await command.handleExecution(['all'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(':warning: No sites found to run the brand-profile agent.');
    expect(startAgentWorkflowStub).to.not.have.been.called;
  });
});
