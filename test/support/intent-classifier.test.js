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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import yaml from 'js-yaml';

import {
  classifyIntents,
  contentToString,
} from '../../src/support/intent-classifier.js';
import { INTENT_VALUES } from '../../src/support/intent.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

const ENABLED_ENV = {
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
async function loadWithModel(invokeImpl, { constructorError } = {}) {
  const ctorSpy = sinon.spy();
  const FakeAzureChatOpenAI = class {
    constructor(opts) {
      ctorSpy(opts);
      if (constructorError) {
        throw constructorError;
      }
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

  describe('createIntentClassifier', () => {
    it('returns null when Azure OpenAI is not configured', async () => {
      const { mod, ctorSpy } = await loadWithModel(() => ({ content: '{}' }));
      const classify = mod.createIntentClassifier({ env: {}, log });
      expect(classify).to.be.null;
      expect(ctorSpy.called).to.be.false;
    });

    it('builds a classifier whenever Azure OpenAI is configured (no opt-in flag)', async () => {
      const { mod, ctorSpy } = await loadWithModel(() => ({ content: '{"intent":"informational"}' }));
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(classify).to.be.a('function');
      expect(ctorSpy.called).to.be.true;
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

    it('returns empty map without calling classify when all texts are filtered out', async () => {
      const classify = sinon.stub().resolves('informational');
      // Empty/nullish all fail hasText -> unique is empty -> early return.
      const result = await classifyIntents(classify, ['', null, undefined]);
      expect(result.size).to.equal(0);
      expect(classify.called).to.be.false;
    });

    it('returns empty map when texts is omitted', async () => {
      const classify = sinon.stub().resolves('informational');
      const result = await classifyIntents(classify, undefined);
      expect(result.size).to.equal(0);
      expect(classify.called).to.be.false;
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

    it('returns partial results without hanging when the batch times out', async () => {
      // classify never resolves -> only the batch timeout can settle the race.
      const classify = () => new Promise(() => {});
      const result = await classifyIntents(classify, ['a', 'b'], { timeoutMs: 10 });
      expect(result.size).to.equal(0);
    });

    it('keeps already-completed classifications when the batch times out', async () => {
      // 'fast' resolves immediately; 'slow' never does. The batch timeout fires
      // and we keep the completed one rather than dropping the whole batch.
      const classify = (t) => (t === 'fast' ? Promise.resolve('planning') : new Promise(() => {}));
      const result = await classifyIntents(classify, ['fast', 'slow'], { maxConcurrency: 2, timeoutMs: 40 });
      expect(result.get('fast')).to.equal('planning');
      expect(result.has('slow')).to.be.false;
    });

    it('does not start new classify calls after the batch times out', async () => {
      // Simulates the real failure mode: classify resolves slowly (after the cap)
      // so without cursor drain each worker loops and starts the next item.
      let callCount = 0;
      const classify = () => new Promise((resolve) => {
        callCount += 1;
        setTimeout(() => resolve(null), 30); // slower than the cap
      });
      // 1 worker, 3 texts, cap fires at 10ms — worker is mid-call on text[0].
      // Without cursor drain: worker finishes text[0] at ~30ms, loops, picks text[1], text[2].
      // With cursor drain: worker finishes text[0] then exits — callCount must stay 1.
      await classifyIntents(classify, ['a', 'b', 'c'], { maxConcurrency: 1, timeoutMs: 10 });
      expect(callCount).to.equal(1);
    });

    it('waits for all classifications when the batch timeout is disabled (0)', async () => {
      const classify = sinon.stub().resolves('informational');
      const result = await classifyIntents(classify, ['a', 'b'], { timeoutMs: 0 });
      expect(result.get('a')).to.equal('informational');
      expect(result.get('b')).to.equal('informational');
    });
  });

  describe('contentToString', () => {
    it('returns a string unchanged', () => {
      expect(contentToString('{"intent":"planning"}')).to.equal('{"intent":"planning"}');
    });

    it('concatenates text parts of an array content', () => {
      const parts = [
        { type: 'text', text: '{"intent":' },
        { type: 'text', text: '"comparative"}' },
      ];
      expect(contentToString(parts)).to.equal('{"intent":"comparative"}');
    });

    it('accepts string parts and a `content` field, ignores non-text parts', () => {
      const parts = [
        '{"intent":',
        { type: 'something', other: 'x' },
        { content: '"transactional"}' },
      ];
      expect(contentToString(parts)).to.equal('{"intent":"transactional"}');
    });

    it('coerces null/undefined/object to a (possibly empty) string', () => {
      expect(contentToString(null)).to.equal('');
      expect(contentToString(undefined)).to.equal('');
      expect(contentToString(42)).to.equal('42');
    });
  });

  describe('array-shaped model content', () => {
    it('classifies when content is an array of text parts', async () => {
      const { mod } = await loadWithModel(() => ({
        content: [
          { type: 'text', text: '{"intent": "comparative",' },
          { type: 'text', text: ' "confidence": 0.8}' },
        ],
      }));
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(await classify('Figma vs Sketch')).to.equal('comparative');
    });

    it('returns null when array content has no parseable JSON', async () => {
      const { mod } = await loadWithModel(() => ({
        content: [{ type: 'text', text: 'no json here' }],
      }));
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(await classify('something')).to.be.null;
    });

    it('returns null when array content concatenates to an empty string', async () => {
      const { mod } = await loadWithModel(() => ({
        content: [{ type: 'image', url: 'x' }, { foo: 'bar' }],
      }));
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(await classify('something')).to.be.null;
    });
  });

  describe('model construction failure', () => {
    it('returns null (no classifier) when the model constructor throws', async () => {
      const { mod } = await loadWithModel(() => ({ content: '{}' }), {
        constructorError: new Error('bad azure config'),
      });
      const classify = mod.createIntentClassifier({ env: ENABLED_ENV, log });
      expect(classify).to.be.null;
    });
  });

  describe('invoke timeout', () => {
    it('treats a hung invoke as a classification failure (null) without throwing', async () => {
      // invoke never resolves; the bounded timeout must reject and yield null.
      const { mod } = await loadWithModel(() => new Promise(() => {}));
      const classify = mod.createIntentClassifier({
        env: { ...ENABLED_ENV, PROMPT_INTENT_CLASSIFICATION_TIMEOUT_MS: '20' },
        log,
      });
      expect(await classify('something')).to.be.null;
    });

    it('returns the bucket when invoke resolves before the timeout', async () => {
      const { mod } = await loadWithModel(() => new Promise((resolve) => {
        setTimeout(() => resolve({ content: '{"intent":"informational"}' }), 1);
      }));
      const classify = mod.createIntentClassifier({
        env: { ...ENABLED_ENV, PROMPT_INTENT_CLASSIFICATION_TIMEOUT_MS: '500' },
        log,
      });
      expect(await classify('what is X')).to.equal('informational');
    });

    it('falls back to the default timeout for a non-numeric/zero env override', async () => {
      // A 0/garbage value must not disable the guard: a resolving call still works.
      const { mod } = await loadWithModel(() => ({ content: '{"intent":"planning"}' }));
      const classify = mod.createIntentClassifier({
        env: { ...ENABLED_ENV, PROMPT_INTENT_CLASSIFICATION_TIMEOUT_MS: 'nope' },
        log,
      });
      expect(await classify('how to X')).to.equal('planning');
    });
  });

  describe('INTENT_VALUES locked to the OpenAPI enum', () => {
    it('matches the V2Prompt intent enum in docs/openapi/schemas.yaml', () => {
      const schemasPath = path.resolve(testDir, '../../docs/openapi/schemas.yaml');
      const doc = yaml.load(fs.readFileSync(schemasPath, 'utf8'));
      const enumValues = doc?.V2Prompt?.properties?.intent?.enum;
      expect(enumValues, 'V2Prompt.properties.intent.enum must exist').to.be.an('array');
      // The schema enum includes `null` (intent is nullable); the code buckets
      // are the non-null canonical values. Compare the two as sets.
      const schemaBuckets = enumValues.filter((v) => v !== null);
      expect([...schemaBuckets].sort()).to.deep.equal([...INTENT_VALUES].sort());
      // Guard: schema must be nullable to match the null-on-unclassified contract.
      expect(enumValues).to.include(null);
    });
  });
});
