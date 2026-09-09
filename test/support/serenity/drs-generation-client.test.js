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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

import {
  invokeDrsGeneration,
  DrsGenerationTerminalError,
  DRS_GENERATION_TARGET_ENV,
} from '../../../src/support/serenity/drs-generation-client.js';
import { isRetryableJobError } from '../../../src/support/serenity/async-job-runner.js';

use(chaiAsPromised);
use(sinonChai);

// A constructor that returns an object is used by `new` as-is, so these avoid
// class syntax (max-classes-per-file / class-methods-use-this) for the esmock.
function lambdaMock(sendStub) {
  function LambdaClient() {
    return { send: sendStub };
  }
  function InvokeCommand(input) {
    return { input };
  }
  return { LambdaClient, InvokeCommand };
}

const baseRequest = {
  seeds: [{ topic: 'running shoes', volume: 100, examplePrompts: ['best running shoes'] }],
  brand: 'Acme',
  baseUrl: 'https://acme.com',
  market: 'US',
  languageCode: 'en',
  count: 5,
  siteId: 'site-1',
  imsOrgId: 'org-1',
};

function ctx(env = {}) {
  return { env: { [DRS_GENERATION_TARGET_ENV]: 'drs-fn', ...env }, log: { info: sinon.stub() } };
}

describe('drs-generation-client', () => {
  it('returns the validated batch on a ship verdict', async () => {
    const invoke = sinon.stub().resolves({
      prompts: [{ prompt: 'p1', category: 'c' }, { prompt: 'p2' }],
      language_evidence: [{ ok: true }, { ok: true }],
      ship_summary: { verdict: 'ship' },
    });

    const result = await invokeDrsGeneration(ctx(), baseRequest, { invoke });

    expect(result.prompts).to.have.length(2);
    expect(result.shipSummary.verdict).to.equal('ship');
    expect(invoke).to.have.been.calledOnceWith('drs-fn', baseRequest);
  });

  it('does NOT pass a promise/IMS token to DRS (security invariant)', async () => {
    const invoke = sinon.stub().resolves({ prompts: [{ prompt: 'p' }], ship_summary: { verdict: 'ship' } });

    await invokeDrsGeneration(ctx(), baseRequest, { invoke });

    const [, payload] = invoke.firstCall.args;
    const serialized = JSON.stringify(payload).toLowerCase();
    expect(serialized).to.not.contain('promise_token');
    expect(serialized).to.not.contain('access_token');
    expect(serialized).to.not.contain('authorization');
  });

  it('throws terminal when the target is not configured', async () => {
    const invoke = sinon.stub();
    const unconfigured = ctx({ [DRS_GENERATION_TARGET_ENV]: undefined });
    await expect(invokeDrsGeneration(unconfigured, baseRequest, { invoke }))
      .to.be.rejectedWith(DrsGenerationTerminalError);
    expect(invoke).to.not.have.been.called;
  });

  it('throws terminal on a held verdict (never publishes an empty/held market)', async () => {
    const invoke = sinon.stub().resolves({ prompts: [], ship_summary: { verdict: 'held' } });
    await expect(invokeDrsGeneration(ctx(), baseRequest, { invoke }))
      .to.be.rejectedWith(DrsGenerationTerminalError);
  });

  it('throws terminal on a gate_error with terminal error_category', async () => {
    const invoke = sinon.stub().resolves({
      prompts: [], ship_summary: { verdict: 'gate_error', error_category: 'terminal' },
    });
    await expect(invokeDrsGeneration(ctx(), baseRequest, { invoke }))
      .to.be.rejectedWith(DrsGenerationTerminalError);
  });

  it('throws RETRYABLE on a gate_error with retryable error_category', async () => {
    const invoke = sinon.stub().resolves({
      prompts: [], ship_summary: { verdict: 'gate_error', error_category: 'retryable' },
    });
    const err = await invokeDrsGeneration(ctx(), baseRequest, { invoke }).catch((e) => e);
    expect(isRetryableJobError(err)).to.equal(true);
  });

  it('unwraps an API-Gateway-proxy-shaped Lambda response { statusCode, body }', async () => {
    const invoke = sinon.stub().resolves({
      statusCode: 200,
      body: JSON.stringify({ prompts: [{ prompt: 'p' }], ship_summary: { verdict: 'ship' } }),
    });

    const result = await invokeDrsGeneration(ctx(), baseRequest, { invoke });
    expect(result.prompts).to.have.length(1);
  });

  it('treats a proxy 5xx as retryable', async () => {
    const invoke = sinon.stub().resolves({ statusCode: 502, body: 'bad gateway' });
    const err = await invokeDrsGeneration(ctx(), baseRequest, { invoke }).catch((e) => e);
    expect(isRetryableJobError(err)).to.equal(true);
  });

  it('emits DRSInvokeDurationMs + DRSInvokeFailure in the infra namespace on a non-ship verdict', async () => {
    const heldInvoke = sinon.stub().resolves({ prompts: [], ship_summary: { verdict: 'held' } });
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      await invokeDrsGeneration(ctx(), baseRequest, { invoke: heldInvoke }).catch(() => {});
    } finally {
      console.log = orig;
    }
    const joined = logs.join('\n');
    expect(joined).to.contain('DRSInvokeDurationMs');
    expect(joined).to.contain('DRSInvokeFailure');
    expect(joined).to.contain('SpacecatSerenityMarketWorker');
  });
});

describe('drs-generation-client — createLambdaInvoker', () => {
  it('converts an AWS TimeoutError into a retryable job error', async () => {
    const sendStub = sinon.stub().rejects(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    const { createLambdaInvoker } = await esmock(
      '../../../src/support/serenity/drs-generation-client.js',
      { '@aws-sdk/client-lambda': lambdaMock(sendStub) },
    );
    const invoker = createLambdaInvoker({ runtime: { region: 'us-east-1' } });
    const err = await invoker('fn', { a: 1 }).catch((e) => e);
    expect(isRetryableJobError(err)).to.equal(true);
  });

  it('treats a Lambda FunctionError response as retryable', async () => {
    const sendStub = sinon.stub().resolves({ StatusCode: 200, FunctionError: 'Unhandled', Payload: Buffer.from('boom') });
    const { createLambdaInvoker } = await esmock(
      '../../../src/support/serenity/drs-generation-client.js',
      { '@aws-sdk/client-lambda': lambdaMock(sendStub) },
    );
    const invoker = createLambdaInvoker({ runtime: { region: 'us-east-1' } });
    const err = await invoker('fn', {}).catch((e) => e);
    expect(isRetryableJobError(err)).to.equal(true);
  });
});
