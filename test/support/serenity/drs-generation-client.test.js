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

import { readFileSync } from 'fs';
import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

import {
  invokeDrsGeneration,
  toDrsRequestPayload,
  DrsGenerationTerminalError,
  DRS_GENERATION_TARGET_ENV,
} from '../../../src/support/serenity/drs-generation-client.js';
import { isRetryableJobError } from '../../../src/support/serenity/async-job-runner.js';

// The canonical cross-repo contract fixture, mirrored from DRS #3194.
const CONTRACT = JSON.parse(readFileSync(
  new URL('../../fixtures/semrush_market_generation_contract.json', import.meta.url),
));

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
    // The invoker receives the canonical snake_case wire payload, not the semantic request.
    expect(invoke).to.have.been.calledOnceWith('drs-fn', toDrsRequestPayload(baseRequest));
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

  it('throws terminal HELD on a held verdict (never publishes an empty/held market)', async () => {
    const invoke = sinon.stub().resolves({ prompts: [], ship_summary: { verdict: 'held' } });
    const err = await invokeDrsGeneration(ctx(), baseRequest, { invoke }).catch((e) => e);
    expect(err).to.be.instanceOf(DrsGenerationTerminalError);
    expect(err.code).to.equal('PROMPT_GENERATION_HELD');
  });

  it('throws terminal GATE_ERROR on a gate_error with terminal error_category', async () => {
    const invoke = sinon.stub().resolves({
      prompts: [], ship_summary: { verdict: 'gate_error', error_category: 'terminal' },
    });
    const err = await invokeDrsGeneration(ctx(), baseRequest, { invoke }).catch((e) => e);
    expect(err).to.be.instanceOf(DrsGenerationTerminalError);
    expect(err.code).to.equal('PROMPT_GENERATION_GATE_ERROR');
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

  // eslint-disable-next-line no-underscore-dangle
  const metaOf = (e) => (e && e._aws ? e._aws.CloudWatchMetrics[0] : null);
  async function captureMetrics(run) {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      await run();
    } finally {
      console.log = orig;
    }
    const parse = (line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    };
    const envelopes = logs.map(parse).filter((e) => metaOf(e));
    return (name) => envelopes.find((e) => metaOf(e).Metrics[0].Name === name);
  }

  it('always emits DRSInvokeDurationMs {Environment}, and never a failure on a held verdict (fail-open)', async () => {
    const heldInvoke = sinon.stub().resolves({ prompts: [], ship_summary: { verdict: 'held' } });
    const byMetric = await captureMetrics(
      () => invokeDrsGeneration(ctx(), baseRequest, { invoke: heldInvoke }).catch(() => {}),
    );
    const duration = byMetric('DRSInvokeDurationMs');
    expect(metaOf(duration).Namespace).to.equal('SpacecatSerenityMarketWorker');
    expect(metaOf(duration).Dimensions[0]).to.deep.equal(['Environment']);
    // held must NOT increment the paging failure metric.
    expect(byMetric('DRSInvokeFailure')).to.equal(undefined);
  });

  it('emits DRSInvokeFailure {Environment}-only on a genuine terminal failure (gate_error)', async () => {
    const gateInvoke = sinon.stub().resolves({
      prompts: [], ship_summary: { verdict: 'gate_error', error_category: 'terminal' },
    });
    const byMetric = await captureMetrics(
      () => invokeDrsGeneration(ctx(), baseRequest, { invoke: gateInvoke }).catch(() => {}),
    );
    const failure = byMetric('DRSInvokeFailure');
    expect(metaOf(failure).Dimensions[0]).to.deep.equal(['Environment']);
    expect(failure.Reason).to.equal(undefined);
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

describe('drs-generation-client — canonical contract fixture (DRS #3194)', () => {
  // Reverse-map the fixture's canonical request back to the semantic (camelCase)
  // shape the worker assembles, so we can assert our mapping reproduces it exactly.
  function semanticFromFixture(req) {
    return {
      siteId: req.site_id,
      brand: req.brand,
      aliases: req.brand_aliases,
      baseUrl: req.base_url,
      market: req.market_country,
      languageCode: req.language_code,
      audience: req.audience,
      count: req.num_prompts,
      model: req.model,
      seeds: req.catalogue_seeds.map((s) => ({
        topic: s.topic, volume: s.volume, examplePrompts: s.example_prompts,
      })),
      catalogueStatus: req.catalogue_status,
      imsOrgId: req.metadata.imsOrgId,
    };
  }

  it('builds the EXACT canonical request wire payload', () => {
    const semantic = semanticFromFixture(CONTRACT.request);
    expect(toDrsRequestPayload(semantic)).to.deep.equal(CONTRACT.request);
  });

  it('parses the canonical wire response (category deferred to empty in v1)', async () => {
    const invoke = sinon.stub().resolves(CONTRACT.response);
    const result = await invokeDrsGeneration(
      { env: { [DRS_GENERATION_TARGET_ENV]: 'drs-fn' }, log: { info: sinon.stub() } },
      semanticFromFixture(CONTRACT.request),
      { invoke },
    );
    expect(result.prompts).to.deep.equal(CONTRACT.response.prompts);
    expect(result.prompts.every((p) => p.category === '')).to.equal(true);
    expect(result.shipSummary.verdict).to.equal('ship');
    expect(result.shipSummary.error_category).to.equal(null);
    expect(result.languageEvidence).to.have.length(CONTRACT.response.language_evidence.length);
  });
});
