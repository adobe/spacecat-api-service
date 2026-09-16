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

import { classifyIntents as realClassifyIntents } from '../../../src/support/intent-classifier.js';
import { resolveEnvironment as realResolveEnvironment } from '../../../src/support/metrics-emf.js';

let sandbox;
let log;
let emitMetricSpy;

function metricsMock() {
  emitMetricSpy = sandbox.spy();
  return {
    '../../../src/support/metrics-emf.js': {
      emitMetric: emitMetricSpy,
      resolveEnvironment: realResolveEnvironment,
    },
  };
}

async function loadWithClassifier({ classify, classifyIntentsStub } = {}) {
  return esmock('../../../src/support/serenity/category-classification.js', {
    '../../../src/support/intent-classifier.js': {
      createIntentClassifier: sandbox.stub().returns(classify),
      classifyIntents: classifyIntentsStub || sandbox.stub().resolves(new Map()),
    },
    ...metricsMock(),
  });
}

// Loads the module wired to the REAL batch runner so the injected
// `observedSpec.parseResult` (which counts soft-failure reasons) is actually
// exercised, mirroring intent-classification.test.js's `loadWithRealBatch`.
async function loadWithRealBatch({ classifyByText }) {
  return esmock('../../../src/support/serenity/category-classification.js', {
    '../../../src/support/intent-classifier.js': {
      createIntentClassifier: (_ctx, spec) => async (topic) => {
        const parsed = classifyByText(topic);
        return parsed === undefined || parsed === null ? null : spec.parseResult(parsed);
      },
      classifyIntents: realClassifyIntents,
    },
    ...metricsMock(),
  });
}

describe('category-classification.js — classifyTopicCategories (adobe/serenity-docs#44)', () => {
  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(), debug: sandbox.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns an empty map for an empty/falsy topics list without touching the classifier', async () => {
    const classifyIntentsStub = sandbox.stub();
    const { classifyTopicCategories } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    const result = await classifyTopicCategories([], ['Shoes'], { env: {}, log, deadline: Date.now() + 100000 });
    expect(result.size).to.equal(0);
    expect(classifyIntentsStub).to.not.have.been.called;
  });

  it('leaves every topic uncategorized (null), without an LLM call, when categoryNames is empty', async () => {
    const classifyIntentsStub = sandbox.stub();
    const { classifyTopicCategories } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    const result = await classifyTopicCategories(['topic a', 'topic b'], [], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.get('topic a')).to.equal(null);
    expect(result.get('topic b')).to.equal(null);
    expect(classifyIntentsStub).to.not.have.been.called;
  });

  it('hard skip-gate: defaults every topic to null and logs budget_skipped when no room at entry', async () => {
    const classifyIntentsStub = sandbox.stub();
    const { classifyTopicCategories } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    const result = await classifyTopicCategories(['topic a'], ['Shoes'], {
      env: {}, log, deadline: Date.now() - 100000,
    });
    expect(result.get('topic a')).to.equal(null);
    expect(classifyIntentsStub).to.not.have.been.called;
    expect(log.info).to.have.been.calledWithMatch(/budget_skipped/);
  });

  it('leaves every topic uncategorized (null) with an info log when Azure OpenAI is not configured', async () => {
    const { classifyTopicCategories } = await loadWithClassifier({ classify: null });
    const result = await classifyTopicCategories(['topic a'], ['Shoes'], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.get('topic a')).to.equal(null);
    expect(log.info).to.have.been.calledWithMatch(/Azure OpenAI is not configured/);
  });

  it('resolves a confident match to the matched candidate name', async () => {
    const classifyIntentsStub = sandbox.stub().resolves(new Map([['topic a', 'Shoes']]));
    const { classifyTopicCategories } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    const result = await classifyTopicCategories(['topic a'], ['Shoes', 'Apparel'], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.get('topic a')).to.equal('Shoes');
  });

  it('leaves an unresolved topic null (fail-open), never throwing', async () => {
    const classifyIntentsStub = sandbox.stub().resolves(new Map());
    const { classifyTopicCategories } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    const result = await classifyTopicCategories(['topic a'], ['Shoes'], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.get('topic a')).to.equal(null);
  });

  it('deduplicates repeated topic text before batching', async () => {
    const classifyIntentsStub = sandbox.stub().resolves(new Map([['topic a', 'Shoes']]));
    const { classifyTopicCategories } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    await classifyTopicCategories(['topic a', 'topic a'], ['Shoes'], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(classifyIntentsStub.firstCall.args[1]).to.deep.equal(['topic a']);
  });

  it('with the real batch runner: an explicit NO_MATCH resolves to null (not a hallucinated category)', async () => {
    const { classifyTopicCategories } = await loadWithRealBatch({
      classifyByText: () => ({ category: 'NO_MATCH', confidence: 0.99 }),
    });
    const result = await classifyTopicCategories(['topic a'], ['Shoes'], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.get('topic a')).to.equal(null);
    expect(log.info).to.have.been.calledWithMatch(/soft failures/, sinon.match({ no_match: 1 }));
  });

  it('with the real batch runner: a hallucinated category outside the candidate set is rejected, never attached', async () => {
    const { classifyTopicCategories } = await loadWithRealBatch({
      classifyByText: () => ({ category: 'Furniture', confidence: 0.99 }),
    });
    const result = await classifyTopicCategories(['topic a'], ['Shoes', 'Apparel'], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.get('topic a')).to.equal(null);
    expect(log.info).to.have.been.calledWithMatch(/soft failures/, sinon.match({ invalid_value: 1 }));
  });

  it('with the real batch runner: a below-floor confidence match is rejected', async () => {
    const { classifyTopicCategories } = await loadWithRealBatch({
      classifyByText: () => ({ category: 'Shoes', confidence: 0.1 }),
    });
    const result = await classifyTopicCategories(['topic a'], ['Shoes'], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.get('topic a')).to.equal(null);
    expect(log.info).to.have.been.calledWithMatch(/soft failures/, sinon.match({ low_confidence: 1 }));
  });

  it('with the real batch runner: a confident match at/above the floor resolves to the candidate name', async () => {
    const { classifyTopicCategories } = await loadWithRealBatch({
      classifyByText: () => ({ category: 'Shoes', confidence: 0.95 }),
    });
    const result = await classifyTopicCategories(['topic a'], ['Shoes', 'Apparel'], {
      env: {}, log, deadline: Date.now() + 100000,
    });
    expect(result.get('topic a')).to.equal('Shoes');
  });

  it('emits a best-effort CategoryOutcome metric and never throws when metric emission fails', async () => {
    const classifyIntentsStub = sandbox.stub().resolves(new Map([['topic a', 'Shoes']]));
    const { classifyTopicCategories } = await loadWithClassifier({
      classify: () => {}, classifyIntentsStub,
    });
    const result = await classifyTopicCategories(['topic a'], ['Shoes'], {
      env: {}, log, deadline: Date.now() + 100000, writePath: 'ai-gen', workspaceId: 'ws-1',
    });
    expect(result.get('topic a')).to.equal('Shoes');
    expect(emitMetricSpy).to.have.been.calledWithMatch({ name: 'CategoryOutcome', value: 1 });
  });
});
