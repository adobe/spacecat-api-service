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
import { SFNClient } from '@aws-sdk/client-sfn';

use(sinonChai);

describe('agent-workflow support util', () => {
  let startAgentWorkflow;
  let sanitizeExecutionName;
  let sendStub;

  before(async () => {
    ({ startAgentWorkflow } = await import('../../src/support/agent-workflow.js'));
    ({ sanitizeExecutionName } = await import('../../src/support/utils.js'));
  });

  beforeEach(() => {
    sendStub = sinon.stub(SFNClient.prototype, 'send').resolves();
  });

  afterEach(() => {
    sinon.restore();
  });

  const getLastCommand = () => sendStub.lastCall?.args?.[0];

  it('throws when the workflow ARN is missing', async () => {
    try {
      await startAgentWorkflow({ env: {} }, {});
      expect.fail('Expected error to be thrown');
    } catch (error) {
      expect(error.message).to.equal('AGENT_WORKFLOW_STATE_MACHINE_ARN is not configured');
    }
    expect(sendStub).to.not.have.been.called;
  });

  it('invokes Step Functions with sanitized execution name', async () => {
    const context = {
      env: { AGENT_WORKFLOW_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123:stateMachine:agent' },
      log: { info: sinon.stub() },
    };
    const payload = { agentId: 'brand-profile', siteId: 'site-1', context: { baseURL: 'https://example.com' } };

    await startAgentWorkflow(context, payload, { executionName: 'brand/profile/site-1' });

    expect(sendStub).to.have.been.calledOnce;
    const command = getLastCommand();
    expect(command.input.stateMachineArn).to.equal(context.env.AGENT_WORKFLOW_STATE_MACHINE_ARN);
    expect(command.input.name).to.match(/^brandprofilesite-1/);
    expect(JSON.parse(command.input.input)).to.deep.equal(payload);
    expect(context.log.info).to.have.been.calledOnce;
  });

  it('falls back to a generated execution name when sanitized input is empty', async () => {
    const context = {
      env: { AGENT_WORKFLOW_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123:stateMachine:agent' },
      log: {},
    };
    await startAgentWorkflow(context, { agentId: 'brand-profile' }, { executionName: '!!!' });
    const command = getLastCommand();
    expect(command.input.name).to.match(/^agent-\d+/);
  });

  it('truncates execution names longer than 80 characters', async () => {
    const context = {
      env: { AGENT_WORKFLOW_STATE_MACHINE_ARN: 'arn' },
      log: {},
    };
    const longName = 'a'.repeat(200);
    await startAgentWorkflow(context, { agentId: 'brand-profile' }, { executionName: longName });
    const command = getLastCommand();
    expect(command.input.name.length).to.be.at.most(80);
  });

  it('builds default execution name and logs when no overrides are provided', async () => {
    const context = {
      env: { AGENT_WORKFLOW_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123:stateMachine:agent' },
      log: { info: sinon.stub() },
    };
    await startAgentWorkflow(context, { agentId: 'brand-profile', siteId: 'site-99' });
    const command = getLastCommand();
    expect(command.input.name).to.match(/^agent-brand-profile-site-99-/);
    expect(JSON.parse(command.input.input)).to.deep.equal({ agentId: 'brand-profile', siteId: 'site-99' });
    expect(context.log.info).to.have.been.calledWithMatch('agent-workflow: started brand-profile');
  });

  it('falls back to unknown/global and logs when identifiers are missing', async () => {
    const context = {
      env: { AGENT_WORKFLOW_STATE_MACHINE_ARN: 'arn' },
      log: { info: sinon.stub() },
    };
    await startAgentWorkflow(context, {});
    const command = getLastCommand();
    expect(command.input.name).to.match(/^agent-unknown-global-/);
    expect(context.log.info).to.have.been.calledWithMatch('agent-workflow: started unknown');
  });

  it('sanitizes execution names when no value is provided', () => {
    const result = sanitizeExecutionName();
    expect(result).to.match(/^agent-\d+/);
  });
});
