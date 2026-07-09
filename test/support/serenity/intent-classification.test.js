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

const log = {
  info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
};

async function loadWithClassifier({ classify, classifyIntentsStub } = {}) {
  return esmock('../../../src/support/serenity/intent-classification.js', {
    '../../../src/support/intent-classifier.js': {
      createIntentClassifier: sinon.stub().returns(classify),
      classifyIntents: classifyIntentsStub || sinon.stub().resolves(new Map()),
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
