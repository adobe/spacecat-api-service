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

const log = {
  info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
};

async function loadWith({ createIntentClassifierStub, classifyIntentsStub }) {
  return esmock('../../../src/support/serenity/async-intent-classification.js', {
    '../../../src/support/intent-classifier.js': {
      createIntentClassifier: createIntentClassifierStub,
      classifyIntents: classifyIntentsStub,
    },
  });
}

describe('async-intent-classification.js — classifyPromptIntentsUnbounded (serenity-docs#33)', () => {
  beforeEach(() => {
    log.info.resetHistory();
    log.warn.resetHistory();
  });

  it('returns an empty map for no texts, without constructing a classifier', async () => {
    const createIntentClassifierStub = sinon.stub();
    const { classifyPromptIntentsUnbounded } = await loadWith({
      createIntentClassifierStub,
      classifyIntentsStub: sinon.stub(),
    });

    const result = await classifyPromptIntentsUnbounded([], { log });

    expect(result.size).to.equal(0);
    expect(createIntentClassifierStub).to.not.have.been.called;
  });

  it('leaves every text unclassified (null) when Azure is not configured', async () => {
    const { classifyPromptIntentsUnbounded } = await loadWith({
      createIntentClassifierStub: sinon.stub().returns(null),
      classifyIntentsStub: sinon.stub(),
    });

    const result = await classifyPromptIntentsUnbounded(['a', 'b'], { log });

    expect(result.get('a')).to.equal(null);
    expect(result.get('b')).to.equal(null);
  });

  it('resolves on the first round without retrying when everything classifies', async () => {
    const classifyIntentsStub = sinon.stub().resolves(new Map([['a', 'Task'], ['b', 'Commercial']]));
    const { classifyPromptIntentsUnbounded } = await loadWith({
      createIntentClassifierStub: sinon.stub().returns(() => 'Task'),
      classifyIntentsStub,
    });

    const result = await classifyPromptIntentsUnbounded(['a', 'b'], { log });

    expect(result.get('a')).to.equal('Task');
    expect(result.get('b')).to.equal('Commercial');
    expect(classifyIntentsStub).to.have.been.calledOnce;
  });

  it('retries only the still-unresolved subset on a later round, with no per-round timeout', async () => {
    const classifyIntentsStub = sinon.stub();
    classifyIntentsStub.onCall(0).resolves(new Map([['a', 'Task']])); // 'b' unresolved
    classifyIntentsStub.onCall(1).resolves(new Map([['b', 'Commercial']]));
    const { classifyPromptIntentsUnbounded } = await loadWith({
      createIntentClassifierStub: sinon.stub().returns(() => 'Task'),
      classifyIntentsStub,
    });

    const result = await classifyPromptIntentsUnbounded(['a', 'b'], { log, maxAttempts: 3 });

    expect(result.get('a')).to.equal('Task');
    expect(result.get('b')).to.equal('Commercial');
    expect(classifyIntentsStub).to.have.been.calledTwice;
    // Round 2 only re-tries the unresolved text.
    expect(classifyIntentsStub.secondCall.args[1]).to.deep.equal(['b']);
    // No per-round time budget: every call races nothing (Infinity is not finite).
    expect(classifyIntentsStub.firstCall.args[2].timeoutMs).to.equal(Infinity);
  });

  it('leaves a text explicitly null (never defaults) once maxAttempts is exhausted', async () => {
    const classifyIntentsStub = sinon.stub().resolves(new Map()); // never resolves 'a'
    const { classifyPromptIntentsUnbounded } = await loadWith({
      createIntentClassifierStub: sinon.stub().returns(() => null),
      classifyIntentsStub,
    });

    const result = await classifyPromptIntentsUnbounded(['a'], { log, maxAttempts: 2 });

    expect(result.has('a')).to.equal(true);
    expect(result.get('a')).to.equal(null);
    expect(classifyIntentsStub).to.have.been.calledTwice;
  });

  it('dedupes texts before classifying', async () => {
    const classifyIntentsStub = sinon.stub().resolves(new Map([['a', 'Task']]));
    const { classifyPromptIntentsUnbounded } = await loadWith({
      createIntentClassifierStub: sinon.stub().returns(() => 'Task'),
      classifyIntentsStub,
    });

    await classifyPromptIntentsUnbounded(['a', 'a', ''], { log });

    expect(classifyIntentsStub.firstCall.args[1]).to.deep.equal(['a']);
  });
});
