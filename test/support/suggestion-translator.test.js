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
 * Loads suggestion-translator.js with AzureChatOpenAI replaced by a fake whose
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
  const mod = await esmock('../../src/support/suggestion-translator.js', {
    '@langchain/openai': { AzureChatOpenAI: FakeAzureChatOpenAI },
  });
  return { mod, ctorSpy };
}

/** Minimal fake Suggestion entity: getData/setData/save, matching how
 * ensureAiRationaleTranslations uses it. */
function makeSuggestion(data, { saveError, id = 'sugg-1' } = {}) {
  let current = { ...data };
  return {
    getId: () => id,
    getData: () => current,
    setData: (next) => { current = next; },
    save: sinon.stub().callsFake(async () => {
      if (saveError) {
        throw saveError;
      }
      return current;
    }),
  };
}

describe('suggestion-translator', () => {
  afterEach(() => sinon.restore());

  describe('createSuggestionTranslator', () => {
    it('returns null when Azure OpenAI is not configured', async () => {
      const { mod, ctorSpy } = await loadWithModel(() => ({ content: 'x' }));
      const translate = mod.createSuggestionTranslator({ env: {}, log });
      expect(translate).to.be.null;
      expect(ctorSpy.called).to.be.false;
    });

    it('builds a translator whenever Azure OpenAI is configured', async () => {
      const { mod, ctorSpy } = await loadWithModel(() => ({ content: 'x' }));
      const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      expect(translate).to.be.a('function');
      expect(ctorSpy.called).to.be.true;
    });

    it('constructs the model with temperature 0 and a bounded maxTokens', async () => {
      const { mod, ctorSpy } = await loadWithModel(() => ({ content: 'x' }));
      mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      const opts = ctorSpy.firstCall.args[0];
      expect(opts.temperature).to.equal(0);
      expect(opts.maxTokens).to.be.a('number').and.above(0);
      expect(opts.azureOpenAIApiKey).to.equal('key');
    });

    it('returns null (no translator) when the model constructor throws', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'x' }), {
        constructorError: new Error('bad azure config'),
      });
      const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      expect(translate).to.be.null;
    });

    describe('translate(text, targetLocale)', () => {
      it('returns null for empty text without calling the model', async () => {
        const invoke = sinon.stub().resolves({ content: 'traduit' });
        const { mod } = await loadWithModel(invoke);
        const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
        expect(await translate('', 'fr_fr')).to.be.null;
        expect(await translate('   ', 'fr_fr')).to.be.null;
        expect(invoke.called).to.be.false;
      });

      it('translates text for a supported locale', async () => {
        const { mod } = await loadWithModel((messages) => {
          expect(messages[0].role).to.equal('system');
          expect(messages[0].content).to.include('Japanese');
          expect(messages[1]).to.deep.equal({ role: 'user', content: 'hello' });
          return { content: 'こんにちは' };
        });
        const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
        expect(await translate('hello', 'ja_jp')).to.equal('こんにちは');
      });

      it('rejects an unmapped locale without calling the model (must-fix: locale allowlist)', async () => {
        const invoke = sinon.stub().resolves({ content: 'should not be used' });
        const { mod } = await loadWithModel(invoke);
        const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
        // en_us passes the upstream `xx_yy` format validator but has no business being
        // "translated" into itself, and any locale outside LOCALE_LANGUAGE_NAMES must not
        // reach the prompt verbatim.
        expect(await translate('hello', 'en_us')).to.be.null;
        expect(await translate('hello', 'xx_yy')).to.be.null;
        expect(invoke.called).to.be.false;
      });

      it('returns null (never throws) when the model rejects', async () => {
        const { mod } = await loadWithModel(() => Promise.reject(new Error('LLM down')));
        const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
        expect(await translate('hello', 'ja_jp')).to.be.null;
      });

      it('returns null when the model resolves with empty content', async () => {
        const { mod } = await loadWithModel(() => ({ content: '   ' }));
        const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
        expect(await translate('hello', 'ja_jp')).to.be.null;
      });

      it('treats a hung invoke as a translation failure (null) without throwing', async () => {
        const { mod } = await loadWithModel(() => new Promise(() => {}));
        const translate = mod.createSuggestionTranslator({
          env: { ...ENABLED_ENV, SUGGESTION_TRANSLATION_TIMEOUT_MS: '20' },
          log,
        });
        expect(await translate('hello', 'ja_jp')).to.be.null;
      });

      it('handles array-shaped model content', async () => {
        const { mod } = await loadWithModel(() => ({
          content: [{ type: 'text', text: 'bon' }, { type: 'text', text: 'jour' }],
        }));
        const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
        expect(await translate('hello', 'fr_fr')).to.equal('bonjour');
      });
    });
  });

  describe('resolveBatchTimeoutMs', () => {
    it('falls back to the default for a missing/non-numeric/zero env value', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'x' }));
      expect(mod.resolveBatchTimeoutMs({})).to.equal(8000);
      expect(mod.resolveBatchTimeoutMs({ SUGGESTION_TRANSLATION_BATCH_TIMEOUT_MS: 'nope' })).to.equal(8000);
      expect(mod.resolveBatchTimeoutMs({ SUGGESTION_TRANSLATION_BATCH_TIMEOUT_MS: '0' })).to.equal(8000);
    });

    it('uses a valid positive env override', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'x' }));
      expect(mod.resolveBatchTimeoutMs({ SUGGESTION_TRANSLATION_BATCH_TIMEOUT_MS: '1234' })).to.equal(1234);
    });
  });

  describe('ensureAiRationaleTranslations', () => {
    it('no-ops when createTranslator is not a function', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'x' }));
      const suggestion = makeSuggestion({ aiRationale: 'why' });
      await mod.ensureAiRationaleTranslations(null, [suggestion], 'ja_jp');
      expect(suggestion.save.called).to.be.false;
    });

    it('no-ops when locale is empty', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'x' }));
      const suggestion = makeSuggestion({ aiRationale: 'why' });
      const createTranslator = sinon.stub().returns(async () => 'translated');
      await mod.ensureAiRationaleTranslations(createTranslator, [suggestion], '');
      expect(createTranslator.called).to.be.false;
      expect(suggestion.save.called).to.be.false;
    });

    it('does not build a translator when no suggestion needs translating (performance)', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'x' }));
      const noRationale = makeSuggestion({ url: 'https://example.com' });
      const alreadyTranslated = makeSuggestion({
        aiRationale: 'why',
        i18n: { ja_jp: { aiRationale: 'なぜ' } },
      });
      const createTranslator = sinon.stub().returns(async () => 'translated');
      await mod.ensureAiRationaleTranslations(
        createTranslator,
        [noRationale, alreadyTranslated],
        'ja_jp',
      );
      expect(createTranslator.called).to.be.false;
    });

    it('no-ops when createTranslator() itself returns null (Azure not configured)', async () => {
      const suggestion = makeSuggestion({ aiRationale: 'why' });
      const { mod } = await loadWithModel(() => ({ content: 'x' }));
      await mod.ensureAiRationaleTranslations(() => null, [suggestion], 'ja_jp');
      expect(suggestion.save.called).to.be.false;
    });

    it('translates and persists a pending suggestion', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'なぜ' }));
      const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      const suggestion = makeSuggestion({ aiRationale: 'why', suggestedUrls: ['https://x'] });

      await mod.ensureAiRationaleTranslations(() => translate, [suggestion], 'ja_jp');

      expect(suggestion.getData().i18n.ja_jp.aiRationale).to.equal('なぜ');
      // Base fields are preserved alongside the new i18n entry.
      expect(suggestion.getData().suggestedUrls).to.deep.equal(['https://x']);
      expect(suggestion.save.calledOnce).to.be.true;
    });

    it('skips a suggestion with no aiRationale', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'なぜ' }));
      const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      const suggestion = makeSuggestion({ url: 'https://example.com' });

      await mod.ensureAiRationaleTranslations(() => translate, [suggestion], 'ja_jp');

      expect(suggestion.save.called).to.be.false;
    });

    it('skips a suggestion that already has a translation for the locale', async () => {
      const invoke = sinon.stub().resolves({ content: 'should not be called' });
      const { mod } = await loadWithModel(invoke);
      const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      const suggestion = makeSuggestion({
        aiRationale: 'why',
        i18n: { ja_jp: { aiRationale: 'なぜ' } },
      });

      await mod.ensureAiRationaleTranslations(() => translate, [suggestion], 'ja_jp');

      expect(invoke.called).to.be.false;
      expect(suggestion.save.called).to.be.false;
    });

    it('leaves a suggestion untouched when translation fails', async () => {
      const { mod } = await loadWithModel(() => Promise.reject(new Error('LLM down')));
      const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      const suggestion = makeSuggestion({ aiRationale: 'why' });

      await mod.ensureAiRationaleTranslations(() => translate, [suggestion], 'ja_jp');

      expect(suggestion.getData().i18n).to.be.undefined;
      expect(suggestion.save.called).to.be.false;
    });

    it('logs (does not silently swallow) a save() failure (must-fix: silent catch)', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'なぜ' }));
      const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      const suggestion = makeSuggestion({ aiRationale: 'why' }, { saveError: new Error('db down') });
      const warn = sinon.spy();

      await mod.ensureAiRationaleTranslations(
        () => translate,
        [suggestion],
        'ja_jp',
        { log: { warn } },
      );

      // The in-memory translation still applies to this response even though persistence failed.
      expect(suggestion.getData().i18n.ja_jp.aiRationale).to.equal('なぜ');
      expect(warn.calledOnce).to.be.true;
      expect(warn.firstCall.args[0]).to.match(/Failed to persist translated aiRationale/);
      expect(warn.firstCall.args[0]).to.include('db down');
    });

    it('defaults the save-failure logger to console when none is supplied', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'なぜ' }));
      const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      const suggestion = makeSuggestion({ aiRationale: 'why' }, { saveError: new Error('db down') });
      const consoleWarn = sinon.stub(console, 'warn');

      await mod.ensureAiRationaleTranslations(() => translate, [suggestion], 'ja_jp');

      expect(consoleWarn.calledOnce).to.be.true;
    });

    it('translates multiple pending suggestions with bounded concurrency', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const { mod } = await loadWithModel(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
        inFlight -= 1;
        return { content: 'なぜ' };
      });
      const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      const suggestions = Array.from(
        { length: 10 },
        (_, i) => makeSuggestion({ aiRationale: `why ${i}` }, { id: `s${i}` }),
      );

      await mod.ensureAiRationaleTranslations(
        () => translate,
        suggestions,
        'ja_jp',
        { maxConcurrency: 3 },
      );

      expect(maxInFlight).to.be.at.most(3);
      suggestions.forEach((s) => {
        expect(s.getData().i18n.ja_jp.aiRationale).to.equal('なぜ');
      });
    });

    it('does not persist a suggestion whose translation resolves after the batch cap', async () => {
      // translate() never resolves -> only the batch timeout can settle the race, and the
      // (unreachable-in-this-test) write path must never run.
      const { mod } = await loadWithModel(() => new Promise(() => {}));
      const translate = mod.createSuggestionTranslator({
        env: { ...ENABLED_ENV, SUGGESTION_TRANSLATION_TIMEOUT_MS: '5' },
        log,
      });
      const suggestion = makeSuggestion({ aiRationale: 'why' });

      await mod.ensureAiRationaleTranslations(
        () => translate,
        [suggestion],
        'ja_jp',
        { timeoutMs: 10 },
      );

      expect(suggestion.getData().i18n).to.be.undefined;
      expect(suggestion.save.called).to.be.false;
    });

    it('does not start new translate calls after the batch cap fires', async () => {
      // Mirrors intent-classifier's equivalent cursor-drain test: with maxConcurrency 1,
      // 3 pending suggestions, and a cap shorter than a single call, only the in-flight
      // call may run.
      let callCount = 0;
      const { mod } = await loadWithModel(() => new Promise((resolve) => {
        callCount += 1;
        setTimeout(() => resolve({ content: 'なぜ' }), 30);
      }));
      const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      const suggestions = Array.from(
        { length: 3 },
        (_, i) => makeSuggestion({ aiRationale: `why ${i}` }, { id: `s${i}` }),
      );

      await mod.ensureAiRationaleTranslations(
        () => translate,
        suggestions,
        'ja_jp',
        { maxConcurrency: 1, timeoutMs: 10 },
      );

      expect(callCount).to.equal(1);
    });

    it('waits for all translations when the batch timeout is disabled (0)', async () => {
      const { mod } = await loadWithModel(() => ({ content: 'なぜ' }));
      const translate = mod.createSuggestionTranslator({ env: ENABLED_ENV, log });
      const suggestions = Array.from(
        { length: 3 },
        (_, i) => makeSuggestion({ aiRationale: `why ${i}` }, { id: `s${i}` }),
      );

      await mod.ensureAiRationaleTranslations(
        () => translate,
        suggestions,
        'ja_jp',
        { timeoutMs: 0 },
      );

      suggestions.forEach((s) => {
        expect(s.getData().i18n.ja_jp.aiRationale).to.equal('なぜ');
      });
    });
  });
});
