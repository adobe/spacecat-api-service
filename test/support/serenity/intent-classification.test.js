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

import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

import { CREATE_PUBLISH_RESERVE_MS } from '../../../src/support/serenity/intent-classification.js';
import { PER_CALL_MS } from '../../../src/support/serenity/intent-taxonomy.js';
import { classifyIntents as realClassifyIntents } from '../../../src/support/intent-classifier.js';
import { resolveEnvironment as realResolveEnvironment } from '../../../src/support/metrics-emf.js';

const log = {
  info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
};

// Shared EMF spy; a fresh reference per load so assertions target one call log.
let emitMetricSpy;

function metricsMock() {
  emitMetricSpy = sinon.spy();
  return {
    '../../../src/support/metrics-emf.js': {
      emitMetric: emitMetricSpy,
      resolveEnvironment: realResolveEnvironment,
    },
  };
}

// Collects the metrics emitted for a given name into {value, dimensions} rows.
function emittedMetric(name) {
  return emitMetricSpy.getCalls()
    .map((c) => c.args[0])
    .filter((m) => m.name === name);
}

async function loadWithClassifier({ classify, classifyIntentsStub } = {}) {
  return esmock('../../../src/support/serenity/intent-classification.js', {
    '../../../src/support/intent-classifier.js': {
      createIntentClassifier: sinon.stub().returns(classify),
      classifyIntents: classifyIntentsStub || sinon.stub().resolves(new Map()),
    },
    ...metricsMock(),
  });
}

// Loads the module wired to the REAL batch runner (`classifyIntents`) so the
// per-call timing wrapper and the injected category spec's `parseResult` (which
// counts `low_confidence` soft-failures) are actually exercised. `classifyByText`
// maps a prompt text to the parsed model body `parseResult` will inspect (or
// `null`/undefined to simulate a call that produced nothing).
async function loadWithRealBatchRaw({ makeClassify }) {
  return esmock('../../../src/support/serenity/intent-classification.js', {
    '../../../src/support/intent-classifier.js': {
      createIntentClassifier: (_ctx, spec) => makeClassify(spec),
      classifyIntents: realClassifyIntents,
    },
    ...metricsMock(),
  });
}

async function loadWithRealBatch({ classifyByText }) {
  return loadWithRealBatchRaw({
    makeClassify: (spec) => async (text) => {
      const parsed = classifyByText(text);
      return parsed === undefined || parsed === null ? null : spec.parseResult(parsed);
    },
  });
}

describe('intent-classification.js — classifyPromptIntents (serenity-docs#32)', () => {
  afterEach(() => {
    sinon.reset();
  });

  it('returns an empty map for an empty/falsy text list without touching the classifier', async () => {
    const classifyIntentsStub = sinon.stub();
    const { classifyPromptIntents } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    const result = await classifyPromptIntents([], { env: {}, log, deadline: Date.now() + 100000 });
    expect(result.size).to.equal(0);
    expect(classifyIntentsStub).to.not.have.been.called;
  });

  it('treats a null/undefined texts argument as empty', async () => {
    const classifyIntentsStub = sinon.stub();
    const { classifyPromptIntents } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    const result = await classifyPromptIntents(null, {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.size).to.equal(0);
    expect(classifyIntentsStub).to.not.have.been.called;
  });

  it('hard skip-gate: defaults everything and logs budget_skipped when no room at entry, without constructing a classifier', async () => {
    const classifyIntentsStub = sinon.stub();
    const { classifyPromptIntents, computeWriteDeadline } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    // deadline already effectively exhausted (in the past).
    const deadline = computeWriteDeadline(Date.now() - 100000);
    const result = await classifyPromptIntents(['a', 'b'], { env: {}, log, deadline });
    expect(result.get('a')).to.equal('intent:Informational');
    expect(result.get('b')).to.equal('intent:Informational');
    expect(classifyIntentsStub).to.not.have.been.called;
    expect(log.info).to.have.been.calledWithMatch(/budget_skipped/);
  });

  it('defaults everything with an info log (non-prod) when the classifier is unavailable (Azure not configured)', async () => {
    const { classifyPromptIntents } = await loadWithClassifier({ classify: null });
    const result = await classifyPromptIntents(['a'], {
      env: { AWS_ENV: 'dev' }, log, deadline: Date.now() + 100000,
    });
    expect(result.get('a')).to.equal('intent:Informational');
    expect(log.info).to.have.been.calledWithMatch(/Azure OpenAI is not configured/);
    expect(log.warn).to.not.have.been.called;
  });

  it('defaults everything with a WARN + prod_llm_unavailable log in prod when the classifier is unavailable', async () => {
    const { classifyPromptIntents } = await loadWithClassifier({ classify: null });
    const result = await classifyPromptIntents(['a'], {
      env: { AWS_ENV: 'prod' }, log, deadline: Date.now() + 100000,
    });
    expect(result.get('a')).to.equal('intent:Informational');
    expect(log.warn).to.have.been.calledWithMatch(/prod_llm_unavailable/);
  });

  it('treats a null/undefined env or log as if omitted, without throwing', async () => {
    const { classifyPromptIntents } = await loadWithClassifier({ classify: null });
    const result = await classifyPromptIntents(['a'], {
      env: null, log: null, deadline: Date.now() + 100000,
    });
    expect(result.get('a')).to.equal('intent:Informational');
  });

  it('uses the first-pass classification result and counts classified_ok, no retry when everything resolves', async () => {
    const classifyIntentsStub = sinon.stub().resolves(new Map([
      ['a', 'intent:Task'], ['b', 'intent:Commercial'],
    ]));
    const { classifyPromptIntents } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    const result = await classifyPromptIntents(['a', 'b'], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.get('a')).to.equal('intent:Task');
    expect(result.get('b')).to.equal('intent:Commercial');
    expect(classifyIntentsStub).to.have.been.calledOnce;
    expect(log.info).to.have.been.calledWithMatch(/summary/, sinon.match({ classified_ok: 2, retry_attempted: 0 }));
  });

  it('retries once for unresolved texts when the budget allows, and uses the retry result on success', async () => {
    const classifyIntentsStub = sinon.stub();
    classifyIntentsStub.onCall(0).resolves(new Map([['a', 'intent:Task']])); // 'b' left unresolved
    classifyIntentsStub.onCall(1).resolves(new Map([['b', 'intent:Navigational']]));
    const { classifyPromptIntents } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    // Ample budget so the retry gate passes.
    const result = await classifyPromptIntents(['a', 'b'], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.get('a')).to.equal('intent:Task');
    expect(result.get('b')).to.equal('intent:Navigational');
    expect(classifyIntentsStub).to.have.been.calledTwice;
    expect(log.info).to.have.been.calledWithMatch(/summary/, sinon.match({ classified_ok: 1, retry_attempted: 1, retry_succeeded: 1 }));
  });

  it('defaults to Informational when the retry also fails to resolve a text', async () => {
    const classifyIntentsStub = sinon.stub();
    classifyIntentsStub.onCall(0).resolves(new Map()); // nothing resolved
    classifyIntentsStub.onCall(1).resolves(new Map()); // retry also resolves nothing
    const { classifyPromptIntents } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    const result = await classifyPromptIntents(['a'], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.get('a')).to.equal('intent:Informational');
    expect(classifyIntentsStub).to.have.been.calledTwice;
    expect(log.info).to.have.been.calledWithMatch(/summary/, sinon.match({ defaulted: 1, retry_attempted: 1 }));
  });

  it('skips the retry (defaults immediately) when the deadline has no room left for a second call', async () => {
    const t0 = 1_000_000_000;
    const clock = sinon.useFakeTimers(t0);
    try {
      // Entry hard-skip-gate passes (remaining ≈ PER_CALL_MS + 50ms of slack), but
      // the mocked first-pass classify call "spends" 60ms of wall-clock via the
      // fake timer, so by the time the retry-gate check runs, remaining budget has
      // dropped below PER_CALL_MS — the retry is skipped, not attempted.
      const deadline = t0 + CREATE_PUBLISH_RESERVE_MS + PER_CALL_MS + 50;
      const classifyIntentsStub = sinon.stub().callsFake(async () => {
        clock.tick(60);
        return new Map(); // nothing resolved on the first pass
      });
      const { classifyPromptIntents } = await loadWithClassifier({
        classify: () => {}, classifyIntentsStub,
      });
      const result = await classifyPromptIntents(['a'], { env: {}, log, deadline });
      expect(result.get('a')).to.equal('intent:Informational');
      expect(classifyIntentsStub).to.have.been.calledOnce;
      expect(log.info).to.have.been.calledWithMatch(/summary/, sinon.match({ retry_attempted: 0, defaulted: 1 }));
    } finally {
      clock.restore();
    }
  });
});

describe('intent-classification.js — observability (serenity-docs#32)', () => {
  afterEach(() => {
    sinon.reset();
  });

  it('emits IntentOutcome counters dimensioned by WritePath + Workspace, and IntentValueDistribution by WritePath', async () => {
    const classifyIntentsStub = sinon.stub().resolves(new Map([
      ['a', 'intent:Task'], ['b', 'intent:Task'], ['c', 'intent:Commercial'],
    ]));
    const { classifyPromptIntents } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    await classifyPromptIntents(['a', 'b', 'c'], {
      env: { AWS_ENV: 'stage' },
      log,
      deadline: Date.now() + 100000,
      writePath: 'create',
      workspaceId: 'ws-42',
    });

    const outcome = emittedMetric('IntentOutcome').find((m) => m.dimensions.Outcome === 'classified_ok');
    expect(outcome).to.include({ value: 3, unit: 'Count' });
    expect(outcome.dimensions).to.include({ WritePath: 'create', Workspace: 'ws-42', Outcome: 'classified_ok' });

    const values = emittedMetric('IntentValueDistribution');
    const task = values.find((m) => m.dimensions.Value === 'Task');
    const commercial = values.find((m) => m.dimensions.Value === 'Commercial');
    expect(task).to.include({ value: 2 });
    expect(task.dimensions).to.include({ WritePath: 'create', Value: 'Task' });
    expect(task.dimensions).to.not.have.property('Workspace');
    expect(commercial).to.include({ value: 1 });
    // Environment resolves via AWS_ENV for the emit sink options (not a dimension here).
    expect(realResolveEnvironment({ AWS_ENV: 'stage' })).to.equal('stage');
  });

  it('emits a budget_skipped IntentOutcome and a defaulted value bucket on the hard skip-gate', async () => {
    const { classifyPromptIntents, computeWriteDeadline } = await loadWithClassifier({
      classify: () => {},
    });
    const deadline = computeWriteDeadline(Date.now() - 100000);
    await classifyPromptIntents(['a', 'b'], {
      env: {}, log, deadline, writePath: 'csv', workspaceId: 'ws-1',
    });
    const skipped = emittedMetric('IntentOutcome').find((m) => m.dimensions.Outcome === 'budget_skipped');
    expect(skipped).to.include({ value: 2 });
    const defaulted = emittedMetric('IntentValueDistribution').find((m) => m.dimensions.Value === 'defaulted');
    expect(defaulted).to.include({ value: 2 });
  });

  it('emits a ProdLlmUnavailable counter (and keeps the warn) when the classifier cannot be constructed in prod', async () => {
    const { classifyPromptIntents } = await loadWithClassifier({ classify: null });
    await classifyPromptIntents(['a'], {
      env: { AWS_ENV: 'prod' }, log, deadline: Date.now() + 100000, writePath: 'create',
    });
    const prodUnavailable = emittedMetric('ProdLlmUnavailable');
    expect(prodUnavailable).to.have.length(1);
    expect(prodUnavailable[0]).to.include({ value: 1 });
    expect(prodUnavailable[0].dimensions).to.include({ WritePath: 'create' });
    expect(log.warn).to.have.been.calledWithMatch(/prod_llm_unavailable/);
  });

  it('fires the prod path (warn + counter) when prod is signalled via ENV, not just AWS_ENV', async () => {
    // Regression: prod detection resolves through resolveEnvironment (AWS_ENV || ENV),
    // so ENV=prod alone must still trip the prod path — the old AWS_ENV-only check missed this.
    const { classifyPromptIntents } = await loadWithClassifier({ classify: null });
    await classifyPromptIntents(['a'], {
      env: { ENV: 'prod' }, log, deadline: Date.now() + 100000, writePath: 'create',
    });
    expect(emittedMetric('ProdLlmUnavailable')).to.have.length(1);
    expect(log.warn).to.have.been.calledWithMatch(/prod_llm_unavailable/);
  });

  it('does NOT emit ProdLlmUnavailable on the construction failure in non-prod', async () => {
    const { classifyPromptIntents } = await loadWithClassifier({ classify: null });
    await classifyPromptIntents(['a'], {
      env: { ENV: 'stage' }, log, deadline: Date.now() + 100000, writePath: 'create',
    });
    expect(emittedMetric('ProdLlmUnavailable')).to.have.length(0);
  });

  it('counts low_confidence apart from defaulted, logs truncated reasoning, and folds it into the retry/default ladder', async () => {
    // 'a' resolves; 'b' is a below-floor low-confidence soft failure on every pass.
    const parsedByText = {
      a: { intent: 'Task', confidence: 0.97, reasoning: 'clear delegation' },
      b: {
        intent: 'Commercial',
        confidence: 0.2,
        reasoning: 'x'.repeat(500),
      },
    };
    const { classifyPromptIntents } = await loadWithRealBatch({
      classifyByText: (t) => parsedByText[t],
    });
    const result = await classifyPromptIntents(['a', 'b'], {
      env: {}, log, deadline: Date.now() + 100000, writePath: 'create', workspaceId: 'ws-9',
    });
    expect(result.get('a')).to.equal('intent:Task');
    expect(result.get('b')).to.equal('intent:Informational'); // defaulted after retry

    // low_confidence counted per soft-failure call (pass + retry = 2), distinct from defaulted (1).
    expect(log.info).to.have.been.calledWithMatch(
      /summary/,
      sinon.match({ low_confidence: 2, defaulted: 1, classified_ok: 1 }),
    );
    const lc = emittedMetric('IntentOutcome').find((m) => m.dimensions.Outcome === 'low_confidence');
    expect(lc).to.include({ value: 2 });

    // Truncated reasoning is logged (sliced to 200 chars), not the full 500.
    const softLog = log.info.getCalls().find((c) => /soft failures/.test(c.args[0]));
    expect(softLog).to.not.equal(undefined);
    expect(softLog.args[1].samples[0].reasoning).to.have.length(200);
    expect(softLog.args[1].samples[0].reason).to.equal('low_confidence');
  });

  it('logs only {reason, reasoning} per soft-failure sample — never the prompt text', async () => {
    const secret = 'super-secret-prompt-text-that-must-not-be-logged';
    const { classifyPromptIntents } = await loadWithRealBatch({
      classifyByText: () => ({ intent: 'Commercial', confidence: 0.1, reasoning: 'low conf' }),
    });
    await classifyPromptIntents([secret], {
      env: {}, log, deadline: Date.now() + 100000, writePath: 'create',
    });
    const softLog = log.info.getCalls().find((c) => /soft failures/.test(c.args[0]));
    expect(softLog).to.not.equal(undefined);
    expect(softLog.args[1].samples[0]).to.have.keys(['reason', 'reasoning']);
    expect(JSON.stringify(softLog.args)).to.not.contain(secret);
  });

  it('caps the number of logged soft-failure reasoning samples at 10', async () => {
    const texts = Array.from({ length: 15 }, (_, i) => `t${i}`);
    const { classifyPromptIntents } = await loadWithRealBatch({
      classifyByText: () => ({ intent: 'bogus-value', confidence: 0.99 }),
    });
    await classifyPromptIntents(texts, {
      env: {}, log, deadline: Date.now() + 100000, writePath: 'create',
    });
    const softLog = log.info.getCalls().find((c) => /soft failures/.test(c.args[0]));
    expect(softLog.args[1].samples).to.have.length(10);
    // invalid_value is logged but is NOT counted as low_confidence.
    expect(softLog.args[1].samples[0].reason).to.equal('invalid_value');
    expect(softLog.args[1].low_confidence).to.equal(0);
  });

  it('emits per-call latency (p50/p95), a per-call timeout tally, and a prod repeated-invoke-failure signal', async () => {
    const t0 = 1_000_000_000;
    const clock = sinon.useFakeTimers(t0);
    try {
      // Every call "spends" the full per-call budget and resolves null → a
      // heuristic timeout, and no text ever resolves → repeated-invoke-failure.
      const { classifyPromptIntents } = await loadWithRealBatchRaw({
        makeClassify: () => async () => {
          clock.tick(PER_CALL_MS);
          return null;
        },
      });
      const result = await classifyPromptIntents(['a'], {
        env: { AWS_ENV: 'prod' },
        log,
        deadline: t0 + 100000,
        writePath: 'edit',
        workspaceId: 'ws-7',
      });
      expect(result.get('a')).to.equal('intent:Informational');

      const p50 = emittedMetric('PerCallLatencyP50Ms');
      const p95 = emittedMetric('PerCallLatencyP95Ms');
      expect(p50[0]).to.include({ value: PER_CALL_MS, unit: 'Milliseconds' });
      expect(p95[0]).to.include({ value: PER_CALL_MS, unit: 'Milliseconds' });

      const timeouts = emittedMetric('PerCallTimeout');
      // first pass + retry, both timed out.
      expect(timeouts[0]).to.include({ value: 2 });

      const batch = emittedMetric('ClassifyBatchDurationMs');
      expect(batch[0].unit).to.equal('Milliseconds');

      const prodUnavailable = emittedMetric('ProdLlmUnavailable');
      expect(prodUnavailable).to.have.length(1);
      expect(prodUnavailable[0].dimensions).to.include({ WritePath: 'edit' });
    } finally {
      clock.restore();
    }
  });

  it('does NOT emit the repeated-invoke-failure signal in non-prod even when nothing resolves', async () => {
    const { classifyPromptIntents } = await loadWithRealBatch({
      classifyByText: () => null,
    });
    await classifyPromptIntents(['a'], {
      env: { AWS_ENV: 'stage' }, log, deadline: Date.now() + 100000, writePath: 'create',
    });
    expect(emittedMetric('ProdLlmUnavailable')).to.have.length(0);
  });

  it('never throws into the classify path when emitMetric itself throws', async () => {
    const classifyIntentsStub = sinon.stub().resolves(new Map([['a', 'intent:Task']]));
    const mod = await esmock('../../../src/support/serenity/intent-classification.js', {
      '../../../src/support/intent-classifier.js': {
        createIntentClassifier: sinon.stub().returns(() => {}),
        classifyIntents: classifyIntentsStub,
      },
      '../../../src/support/metrics-emf.js': {
        emitMetric: () => { throw new Error('emf boom'); },
        resolveEnvironment: realResolveEnvironment,
      },
    });
    const result = await mod.classifyPromptIntents(['a'], {
      env: {}, log, deadline: Date.now() + 100000, writePath: 'create',
    });
    expect(result.get('a')).to.equal('intent:Task');
  });

  it('never throws when emitMetric throws on the latency + prod_llm_unavailable paths', async () => {
    // Real batch runner so the per-call timing wrapper runs (populating
    // callDurations → latency emits), in prod with nothing resolving so the
    // repeated-invoke-failure ProdLlmUnavailable site also fires — all while
    // emitMetric throws on every call.
    const mod = await esmock('../../../src/support/serenity/intent-classification.js', {
      '../../../src/support/intent-classifier.js': {
        createIntentClassifier: () => async () => null,
        classifyIntents: realClassifyIntents,
      },
      '../../../src/support/metrics-emf.js': {
        emitMetric: () => { throw new Error('emf boom'); },
        resolveEnvironment: realResolveEnvironment,
      },
    });
    const result = await mod.classifyPromptIntents(['a', 'b'], {
      env: { AWS_ENV: 'prod' }, log, deadline: Date.now() + 100000, writePath: 'create',
    });
    expect(result.get('a')).to.equal('intent:Informational');
    expect(result.get('b')).to.equal('intent:Informational');
  });
});
