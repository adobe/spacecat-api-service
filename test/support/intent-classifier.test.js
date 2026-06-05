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

import {
  isIntentClassificationEnabled,
  classifyIntents,
} from '../../src/support/intent-classifier.js';

const ENABLED_ENV = {
  ENABLE_PROMPT_INTENT_CLASSIFICATION: 'true',
  AZURE_OPEN_AI_API_KEY: 'key',
  AZURE_OPEN_AI_API_INSTANCE_NAME: 'instance',
  AZURE_OPEN_AI_API_DEPLOYMENT_NAME: 'deployment',
  AZURE_OPEN_AI_API_VERSION: '2024-02-01',
};

const log = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

/**
 * Loads intent-classifier.js with AzureChatOpenAI replaced by a fake whose
 * `invoke` returns `invokeImpl(messages)`.
 */
async function loadWithModel(invokeImpl) {
  const ctorSpy = sinon.spy();
  const FakeAzureChatOpenAI = class {
    constructor(opts) {
      ctorSpy(opts);
    }

    // eslint-disable-next-line class-methods-use-this
    invoke(messages) {
      return invokeImpl(messages);
    }
  };
  const mod = await esmock('../../src/support/intent-classifier.js', {
    '@langchain/openai': { AzureChatOpenAI: FakeAzureChatOpenAI },
  });
  return { mod, ctorSpy };
}

describe('intent-classifier', () => {
  afterEach(() => sinon.restore());

  describe('isIntentClassificationEnabled', () => {
    const enabled = (v) => isIntentClassificationEnabled(
      { ENABLE_PROMPT_INTENT_CLASSIFICATION: v },
    );

    it('is disabled by default (default-safe toggle)', () => {
      expect(isIntentClassificationEnabled()).to.be.false;
      expect(isIntentClassificationEnabled({})).to.be.false;
      expect(enabled('false')).to.be.false;
      expect(enabled('no')).to.be.false;
    });

    it('is enabled when the flag is truthy', () => {
      expect(enabled('true')).to.be.true;
      expect(enabled(true)).to.be.true;
      expect(enabled('1')).to.be.true;
    });
  });

  describe('createIntentClassifier', () => {
    it('returns null when classification is disabled (toggle off)', async () => {
      const { mod, ctorSpy } = await loadWithModel(() => ({ content: '{}' }));
      const classify = mod.createIntentClassifier({
        env: { ...ENABLED_ENV, ENABLE_PROMPT_INTENT_CLASSIFICATION: 'false' },
        log,
      });
      expect(classify).to.be.null;
      expect(ctorSpy.called).to.be.false;
    });

    it('returns null when Azure OpenAI is not configured', async () => {
      const { mod } = await loadWithModel(() => ({ content: '{}' }));
      const classify = mod.createIntentClassifier({
        env: { ENABLE_PROMPT_INTENT_CLASSIFICATION: 'true' },
        log,
      });
      expect(classify).to.be.null;
    });

    it('constructs the model with temperature 0 and json_object response format', async () => {
      const { mod, ctorSpy } = await loadWithModel(() => ({ content: '{"intent":"informational"}' }));
      mod.createIntentClassifier({ env: ENABLED_ENV, log });
      const opts = ctorSpy.firstCall.args[0];
      expect(opts.temperature).to.equal(0);
      expect(opts.modelKwargs.response_format.type).to.equal('json_object');
      expect(opts.azureOpenAIApiKey).to.equal('key');
    });

    it('classifies text into a canonical bucket', async () => {
      const { mod } = await loadWithModel((messages) => {
        expect(messages[0].role).to.equal('system');
        expect(messages[1].role).to.equal('user');
        return { content: '{"intent": "comparative", "confidence": 0.9, "reasoning": "vs"}' };
      });
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(await classify('Figma vs Sketch')).to.equal('comparative');
    });

    it('applies the legacy remap and lowercasing via normalizeIntent', async () => {
      const { mod } = await loadWithModel(() => ({ content: '{"intent": "COMMERCIAL"}' }));
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(await classify('buy now')).to.equal('transactional');
    });

    it('strips code fences from the model response', async () => {
      const { mod } = await loadWithModel(() => ({ content: '```json\n{"intent": "planning"}\n```' }));
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(await classify('how to do X')).to.equal('planning');
    });

    it('returns null for an invalid bucket from the model', async () => {
      const { mod } = await loadWithModel(() => ({ content: '{"intent": "bogus"}' }));
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(await classify('something')).to.be.null;
    });

    it('returns null (never throws) when the model rejects', async () => {
      const { mod } = await loadWithModel(() => Promise.reject(new Error('LLM down')));
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(await classify('something')).to.be.null;
    });

    it('returns null on malformed JSON', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'not json at all' }));
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(await classify('something')).to.be.null;
    });

    it('returns null for empty text without calling the model', async () => {
      const invoke = sinon.stub().resolves({ content: '{"intent":"informational"}' });
      const { mod } = await loadWithModel(invoke);
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(await classify('')).to.be.null;
      expect(await classify('   ')).to.be.null;
      expect(invoke.called).to.be.false;
    });
  });

  describe('classifyIntents (batch)', () => {
    it('returns empty map when classifier is not a function', async () => {
      const result = await classifyIntents(null, ['a', 'b']);
      expect(result.size).to.equal(0);
    });

    it('deduplicates inputs so repeated text costs one call', async () => {
      const classify = sinon.stub().callsFake((t) => Promise.resolve(t === 'x' ? 'planning' : null));
      const result = await classifyIntents(classify, ['x', 'x', 'y', '']);
      expect(classify.callCount).to.equal(2);
      expect(result.get('x')).to.equal('planning');
      expect(result.get('y')).to.be.null;
    });

    it('maps a rejecting classify to null without throwing', async () => {
      const classify = sinon.stub().rejects(new Error('boom'));
      const result = await classifyIntents(classify, ['a']);
      expect(result.get('a')).to.be.null;
    });

    it('respects the concurrency cap', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const classify = async (t) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => {
          setTimeout(resolve, 1);
        });
        inFlight -= 1;
        return `i-${t}`.length > 0 ? 'informational' : null;
      };
      const texts = Array.from({ length: 25 }, (_, i) => `t${i}`);
      await classifyIntents(classify, texts, { maxConcurrency: 3 });
      expect(maxInFlight).to.be.at.most(3);
    });
  });
});
