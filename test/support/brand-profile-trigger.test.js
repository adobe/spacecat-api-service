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

describe('brand-profile-trigger helper', () => {
  let startAgentWorkflowStub;
  let triggerBrandProfileAgent;
  let context;
  let site;

  beforeEach(async () => {
    startAgentWorkflowStub = sinon.stub().resolves('exec-123');
    ({ triggerBrandProfileAgent } = await esmock('../../src/support/brand-profile-trigger.js', {
      '../../src/support/agent-workflow.js': {
        startAgentWorkflow: startAgentWorkflowStub,
      },
    }));

    context = {
      env: {
        AGENT_WORKFLOW_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123:stateMachine:agent',
      },
      log: {
        info: sinon.stub(),
        warn: sinon.stub(),
        debug: sinon.stub(),
      },
      dataAccess: {
        Site: {
          findById: sinon.stub().resolves(site),
        },
      },
    };

    site = {
      getId: () => 'site-123',
      getBaseURL: () => 'https://example.com',
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('skips when workflow ARN is missing', async () => {
    context.env.AGENT_WORKFLOW_STATE_MACHINE_ARN = '';

    const result = await triggerBrandProfileAgent({
      context,
      site,
    });

    expect(result).to.be.null;
    expect(startAgentWorkflowStub).to.not.have.been.called;
    expect(context.log.debug).to.have.been.calledWithMatch('brand-profile workflow ARN not configured');
  });

  it('skips when site reference is invalid', async () => {
    const result = await triggerBrandProfileAgent({
      context,
      site: null,
      siteId: null,
      baseURL: null,
    });

    expect(result).to.be.null;
    expect(startAgentWorkflowStub).to.not.have.been.called;
    expect(context.log.warn).to.have.been.calledWithMatch('brand-profile trigger skipped: missing site identifier/baseURL');
  });

  it('fetches site when only siteId is provided', async () => {
    const executionName = await triggerBrandProfileAgent({
      context,
      site: null,
      siteId: 'site-123',
    });

    expect(executionName).to.equal('exec-123');
    expect(context.dataAccess.Site.findById).to.have.been.calledOnceWith('site-123');
    expect(startAgentWorkflowStub).to.have.been.calledOnce;
  });

  it('invokes startAgentWorkflow with expected payload', async () => {
    const slackContext = { channelId: 'C123', threadTs: '456.789' };

    const executionName = await triggerBrandProfileAgent({
      context,
      site,
      slackContext,
      reason: 'test-reason',
    });

    expect(executionName).to.equal('exec-123');
    expect(startAgentWorkflowStub).to.have.been.calledOnce;
    const [, payload, options] = startAgentWorkflowStub.firstCall.args;
    expect(payload).to.include({
      agentId: 'brand-profile',
      siteId: 'site-123',
    });
    expect(payload.context).to.deep.equal({ baseURL: 'https://example.com' });
    expect(payload.slackContext).to.deep.equal(slackContext);
    expect(payload.idempotencyKey).to.match(/^brand-profile-site-123-test-reason-\d+/);
    expect(options.executionName).to.match(/^brand-profile-site-123-test-reason/);
  });

  it('defaults slack context to empty object when not provided', async () => {
    await triggerBrandProfileAgent({
      context,
      site,
      reason: 'no-slack',
    });

    expect(startAgentWorkflowStub).to.have.been.calledOnce;
    const [, payload] = startAgentWorkflowStub.firstCall.args;
    expect(payload.slackContext).to.deep.equal({});
  });

  it('respects disable flag', async () => {
    context.env.ENABLE_BRAND_PROFILE_AUTORUN = 'false';

    const result = await triggerBrandProfileAgent({
      context,
      site,
    });

    expect(result).to.be.null;
    expect(startAgentWorkflowStub).to.not.have.been.called;
    expect(context.log.info).to.have.been.calledWithMatch('brand-profile autorun disabled');
  });

  it('handles missing context gracefully', async () => {
    const result = await triggerBrandProfileAgent({
      context: null,
      site,
    });

    expect(result).to.be.null;
    expect(startAgentWorkflowStub).to.not.have.been.called;
  });

  it('falls back to provided identifiers when fetched site lacks getters', async () => {
    context.dataAccess.Site.findById.resolves({
      getId: () => undefined,
      getBaseURL: () => undefined,
    });

    const executionName = await triggerBrandProfileAgent({
      context,
      site: null,
      siteId: 'site-abc',
      baseURL: 'https://fallback.example',
    });

    expect(executionName).to.equal('exec-123');
    const [, payload] = startAgentWorkflowStub.firstCall.args;
    expect(payload.siteId).to.equal('site-abc');
    expect(payload.context.baseURL).to.equal('https://fallback.example');
  });

  it('logs warning when site lookup fails but continues', async () => {
    const lookupError = new Error('failure');
    context.dataAccess.Site.findById.rejects(lookupError);

    const executionName = await triggerBrandProfileAgent({
      context,
      site: null,
      siteId: 'site-xyz',
      baseURL: 'https://brand.example',
    });

    expect(executionName).to.equal('exec-123');
    expect(context.log.warn).to.have.been.calledWith(
      'brand-profile trigger: failed to load site site-xyz',
      lookupError,
    );
  });

  it('logs warning and returns null when workflow invocation fails', async () => {
    const workflowError = new Error('invoke failed');
    startAgentWorkflowStub.rejects(workflowError);

    try {
      const result = await triggerBrandProfileAgent({
        context,
        site,
      });

      expect(result).to.be.null;
      expect(context.log.warn).to.have.been.calledWith(
        'Failed to trigger brand-profile workflow for site site-123',
        workflowError,
      );
    } finally {
      startAgentWorkflowStub.resetBehavior();
      startAgentWorkflowStub.resolves('exec-123');
    }
  });
});
