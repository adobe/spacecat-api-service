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
    expect(result.length).to.be.at.most(80);
  });

  it('sanitizes execution names when empty string is provided', () => {
    const result = sanitizeExecutionName('');
    expect(result).to.match(/^agent-\d+/);
    expect(result.length).to.be.at.most(80);
  });

  it('sanitizes execution names when only invalid characters are provided', () => {
    // String with only invalid characters should fallback to agent-{timestamp}
    const result = sanitizeExecutionName('!!!@@@###$$$');
    expect(result).to.match(/^agent-\d+/);
    expect(result.length).to.be.at.most(80);
  });

  it('returns execution name as-is when exactly 80 characters', () => {
    const exactName = 'a'.repeat(80);
    const result = sanitizeExecutionName(exactName);
    expect(result).to.equal(exactName);
    expect(result.length).to.equal(80);
  });

  it('returns execution name as-is when less than 80 characters', () => {
    const shortName = 'onboard-example-com-1234567890123';
    const result = sanitizeExecutionName(shortName);
    expect(result).to.equal(shortName);
    expect(result.length).to.be.lessThan(80);
  });

  it('preserves full timestamp when truncating long names with timestamps', () => {
    // Create a long name with a 13-digit timestamp at the end
    const timestamp = 1768507714773;
    const longUrl = 'https://main--aem-cloud-migration-reporter--aemdemos.aem.live';
    const longName = `onboard-${longUrl.replace(/[^a-zA-Z0-9]/g, '-')}-${timestamp}`;

    expect(longName.length).to.be.greaterThan(80); // Ensure it's too long

    const result = sanitizeExecutionName(longName);

    expect(result.length).to.equal(80);
    expect(result).to.match(/-1768507714773$/); // Full timestamp preserved
  });

  it('truncates middle portion while preserving timestamp', () => {
    const timestamp = 1234567890123;
    const longPrefix = 'onboard-https---very--long--url--with--many--segments--that--exceeds--the--limit';
    const longName = `${longPrefix}-${timestamp}`;

    const result = sanitizeExecutionName(longName);

    expect(result.length).to.equal(80);
    expect(result.endsWith(`-${timestamp}`)).to.be.true;
    expect(result.startsWith('onboard-')).to.be.true;
  });

  it('truncates from end when no timestamp pattern is found', () => {
    // Name longer than 80 chars but no timestamp pattern
    const longName = 'a'.repeat(100);

    const result = sanitizeExecutionName(longName);

    expect(result.length).to.equal(80);
    expect(result).to.equal('a'.repeat(80));
  });

  it('removes invalid characters while preserving valid ones', () => {
    const nameWithInvalid = 'onboard-test@site.com/path-1234567890123';
    const result = sanitizeExecutionName(nameWithInvalid);

    // Should remove @ . / but keep alphanumeric, hyphens, underscores
    expect(result).to.not.include('@');
    expect(result).to.not.include('.');
    expect(result).to.not.include('/');
    expect(result).to.match(/^[A-Za-z0-9-_]+$/);
  });

  it('handles names with underscores correctly', () => {
    const nameWithUnderscores = 'agent_workflow_test_name_123';
    const result = sanitizeExecutionName(nameWithUnderscores);

    // Underscores should be preserved
    expect(result).to.equal(nameWithUnderscores);
    expect(result).to.include('_');
  });

  it('handles long names with timestamps that have short prefixes', () => {
    // Edge case: very short prefix with long timestamp pattern
    const timestamp = 1768507714773;
    const shortPrefix = 'on';
    const longName = `${shortPrefix + '-'.repeat(70)}-${timestamp}`;

    const result = sanitizeExecutionName(longName);

    expect(result.length).to.equal(80);
    expect(result.endsWith(`-${timestamp}`)).to.be.true;
  });
});
