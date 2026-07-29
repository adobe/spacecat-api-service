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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  NET_NEW_DEFAULT_MODEL_KEYS,
  resolveCanonicalDefaultModelIds,
  resolveDefaultModelIds,
} from '../../../src/support/serenity/default-models.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'brand-1';
const WORKSPACE = 'workspace-1';

const FULL_CATALOG = [
  { id: 'cat-search-gpt', key: 'search-gpt', name: 'ChatGPT' },
  { id: 'cat-gpt-5', key: 'gpt-5', name: 'ChatGPT (No Search)' },
  { id: 'cat-google-ai-overview', key: 'google-ai-overview', name: 'Google AI Overview' },
  { id: 'cat-google-ai-mode', key: 'google-ai-mode', name: 'Google AI Mode' },
  { id: 'cat-gemini', key: 'gemini-2.5-flash', name: 'Gemini' },
  { id: 'cat-claude', key: 'claude-sonnet-4', name: 'Claude' },
  { id: 'cat-perplexity', key: 'perplexity', name: 'Perplexity' },
  { id: 'cat-grok', key: 'grok-3', name: 'Grok' },
  { id: 'cat-deepseek', key: 'deepseek', name: 'Deepseek' },
  { id: 'cat-copilot', key: 'microsoft-copilot', name: 'Copilot' },
  { id: 'cat-open-evidence', key: 'open-evidence', name: 'OpenEvidence' },
];

function proj({
  id, geo = 2840, lang = 'en',
} = {}) {
  return {
    id,
    publish_status: 'live',
    updated_at: '2026-06-02T00:00:00Z',
    settings: { ai: { location: { id: geo }, language: { name: lang } } },
  };
}

function makeTransport(overrides = {}) {
  return {
    listProjects: sinon.stub().resolves({ items: [] }),
    listGlobalAiModels: sinon.stub().resolves({ items: FULL_CATALOG }),
    listAiModels: sinon.stub().resolves({ items: [] }),
    ...overrides,
  };
}

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(),
  };
}

describe('default-models.js', () => {
  describe('NET_NEW_DEFAULT_MODEL_KEYS', () => {
    it('is exactly the 8-LLM net-new base package (LLMO-6338)', () => {
      expect(NET_NEW_DEFAULT_MODEL_KEYS).to.deep.equal([
        'search-gpt',
        'google-ai-overview',
        'google-ai-mode',
        'gemini-2.5-flash',
        'claude-sonnet-4',
        'perplexity',
        'grok-3',
        'deepseek',
      ]);
    });

    it('never includes the opt-in-only models (Copilot, ChatGPT Paid/No-Search)', () => {
      expect(NET_NEW_DEFAULT_MODEL_KEYS).to.not.include('microsoft-copilot');
      expect(NET_NEW_DEFAULT_MODEL_KEYS).to.not.include('gpt-5');
      expect(NET_NEW_DEFAULT_MODEL_KEYS).to.not.include('chatgpt-paid');
    });
  });

  describe('resolveCanonicalDefaultModelIds', () => {
    it('resolves the 8 default catalog ids from the live global catalog', async () => {
      const transport = makeTransport();
      const ids = await resolveCanonicalDefaultModelIds(transport, fakeLog());
      expect(ids.sort()).to.deep.equal([
        'cat-claude',
        'cat-deepseek',
        'cat-gemini',
        'cat-google-ai-mode',
        'cat-google-ai-overview',
        'cat-grok',
        'cat-perplexity',
        'cat-search-gpt',
      ].sort());
    });

    it('skips a default key missing from the live catalog (partial default, best-effort)', async () => {
      const partial = FULL_CATALOG.filter((m) => m.key !== 'deepseek');
      const transport = makeTransport({
        listGlobalAiModels: sinon.stub().resolves({ items: partial }),
      });
      const ids = await resolveCanonicalDefaultModelIds(transport, fakeLog());
      expect(ids).to.have.lengthOf(7);
      expect(ids).to.not.include('cat-deepseek');
    });

    it('never throws — a catalog read failure resolves to an empty list', async () => {
      const log = fakeLog();
      const transport = makeTransport({ listGlobalAiModels: sinon.stub().rejects(new Error('upstream boom')) });
      const ids = await resolveCanonicalDefaultModelIds(transport, log);
      expect(ids).to.deep.equal([]);
      expect(log.warn).to.have.been.calledOnce;
    });
  });

  describe('resolveDefaultModelIds', () => {
    it('falls back to the canonical default when the brand has no existing markets', async () => {
      const transport = makeTransport();
      const ids = await resolveDefaultModelIds(transport, WORKSPACE, BRAND, fakeLog());
      expect(ids).to.have.lengthOf(8);
      expect(transport.listAiModels).to.not.have.been.called;
    });

    it('falls back to the canonical default when every existing market has zero models', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p1' }), proj({ id: 'p2', geo: 2276, lang: 'de' })] }),
        listAiModels: sinon.stub().resolves({ items: [] }),
      });
      const ids = await resolveDefaultModelIds(transport, WORKSPACE, BRAND, fakeLog());
      expect(ids).to.have.lengthOf(8);
      expect(transport.listAiModels).to.have.been.calledTwice;
    });

    it('mirrors the first existing market that already has models attached, skipping empty ones', async () => {
      const listAiModels = sinon.stub();
      listAiModels.withArgs(WORKSPACE, 'p1').resolves({ items: [] });
      listAiModels.withArgs(WORKSPACE, 'p2').resolves({
        items: [
          { id: 'a1', model: { id: 'cat-copilot', key: 'microsoft-copilot' } },
          { id: 'a2', model: { id: 'cat-search-gpt', key: 'search-gpt' } },
        ],
      });
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p1' }), proj({ id: 'p2', geo: 2276, lang: 'de' })] }),
        listAiModels,
      });
      const ids = await resolveDefaultModelIds(transport, WORKSPACE, BRAND, fakeLog());
      // Mirrors the 10-LLM migrated tier the existing market tracks, NOT the
      // 8-LLM net-new default — the canonical catalog is never consulted.
      expect(ids.sort()).to.deep.equal(['cat-copilot', 'cat-search-gpt'].sort());
      expect(transport.listGlobalAiModels).to.not.have.been.called;
    });

    it('skips an existing market with no resolvable semrushProjectId (defensive)', async () => {
      const noIdProject = proj({ id: undefined, geo: 2276, lang: 'de' });
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [noIdProject] }),
      });
      const ids = await resolveDefaultModelIds(transport, WORKSPACE, BRAND, fakeLog());
      expect(ids).to.have.lengthOf(8);
      expect(transport.listAiModels).to.not.have.been.called;
    });

    it('falls back to the canonical default when listing existing markets fails (non-fatal)', async () => {
      const log = fakeLog();
      const transport = makeTransport({
        listProjects: sinon.stub().rejects(new Error('listing boom')),
      });
      const ids = await resolveDefaultModelIds(transport, WORKSPACE, BRAND, log);
      expect(ids).to.have.lengthOf(8);
      expect(log.warn).to.have.been.calledOnce;
    });

    it('never throws — every upstream call failing still resolves (to an empty list)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().rejects(new Error('listing boom')),
        listGlobalAiModels: sinon.stub().rejects(new Error('catalog boom')),
      });
      await expect(resolveDefaultModelIds(transport, WORKSPACE, BRAND, fakeLog()))
        .to.eventually.deep.equal([]);
    });
  });
});
