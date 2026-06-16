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
  handleListMarketsSubworkspace,
  handleGetMarketSubworkspace,
  handleCreateMarketSubworkspace,
  handleDeleteMarketSubworkspace,
  handleListTagsSubworkspace,
  handleListModelsSubworkspace,
  handleUpdateModelsSubworkspace,
} from '../../../../src/support/serenity/handlers/markets-subworkspace.js';
import { clearTagCache } from '../../../../src/support/serenity/handlers/markets.js';
import { SerenityTransportError } from '../../../../src/support/serenity/rest-transport.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'brand-1';
const WS = 'subworkspace-ws-1';
const PARENT = 'parent-ws';
const log = { info: () => {}, error: () => {}, warn: () => {} };

function proj({
  id = 'p1', geo = 2840, lang = 'en', status = 'live',
} = {}) {
  return {
    id,
    publish_status: status,
    updated_at: '2026-06-02T00:00:00Z',
    settings: { ai: { location: { id: geo }, language: { name: lang } } },
  };
}

function makeTransport(overrides = {}) {
  return {
    listProjects: sinon.stub().resolves({ items: [] }),
    getInitStatus: sinon.stub().resolves({ initialized: true }),
    createProject: sinon.stub().resolves({ id: 'new-proj' }),
    publishProject: sinon.stub().resolves(null),
    deleteProject: sinon.stub().resolves(null),
    listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
    transferWorkspaceResources: sinon.stub().resolves(null),
    getWorkspaceStatus: sinon.stub().resolves({ status: 'created' }),
    listPromptsByTags: sinon.stub().resolves({ items: [] }),
    listAiModels: sinon.stub().resolves({ items: [] }),
    listGlobalAiModels: sinon.stub().resolves({ items: [] }),
    addAiModel: sinon.stub().resolves(null),
    deleteAiModelsByIds: sinon.stub().resolves(null),
    createProjectTags: sinon.stub().resolves(null),
    ...overrides,
  };
}

function makeBrand({ workspaceId = WS } = {}) {
  let ws = workspaceId;
  return {
    getId: () => BRAND,
    getName: () => 'Adobe Express',
    getSemrushWorkspaceId: () => ws,
    setSemrushWorkspaceId: (v) => { ws = v; },
    save: sinon.stub().resolves(),
  };
}

const createBody = {
  market: 'us', languageCode: 'en', brandDomain: 'example.com', brandNames: ['B'], brandDisplayName: 'B',
};

describe('markets-subworkspace handlers', () => {
  afterEach(() => {
    sinon.restore();
    clearTagCache();
  });

  describe('handleListMarketsSubworkspace', () => {
    it('maps the live listing to slice DTOs', async () => {
      const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [proj()] }) });
      const result = await handleListMarketsSubworkspace(transport, BRAND, WS);
      expect(result.items).to.have.length(1);
      expect(result.items[0]).to.include({
        brandId: BRAND, geoTargetId: 2840, languageCode: 'en', status: 'live',
      });
    });

    it('returns an empty list for an empty workspace', async () => {
      const result = await handleListMarketsSubworkspace(makeTransport(), BRAND, WS);
      expect(result.items).to.deep.equal([]);
    });
  });

  describe('handleGetMarketSubworkspace', () => {
    it('returns the resolved slice + initialized', async () => {
      const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [proj()] }) });
      const result = await handleGetMarketSubworkspace(transport, BRAND, WS, 2840, 'en', log);
      expect(result).to.include({
        geoTargetId: 2840, languageCode: 'en', semrushProjectId: 'p1', initialized: true,
      });
    });

    it('tolerates an init_status read failure (initialized=null)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj()] }),
        getInitStatus: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });
      const result = await handleGetMarketSubworkspace(transport, BRAND, WS, 2840, 'en', log);
      expect(result.initialized).to.equal(null);
    });

    it('404s marketNotFound when no slice matches', async () => {
      const transport = makeTransport();
      const p = handleGetMarketSubworkspace(transport, BRAND, WS, 2840, 'en', log);
      await expect(p).to.be.rejected;
      try {
        await p;
      } catch (e) {
        expect(e.status).to.equal(404);
        expect(e.code).to.equal('marketNotFound');
      }
    });

    it('400s on an invalid slice', async () => {
      await expect(handleGetMarketSubworkspace(makeTransport(), BRAND, WS, -1, 'en', log))
        .to.be.rejectedWith(/geoTargetId/);
    });

    it('400s on an invalid languageCode (valid geo)', async () => {
      await expect(handleGetMarketSubworkspace(makeTransport(), BRAND, WS, 2840, 'zz9', log))
        .to.be.rejectedWith(/languageCode/);
    });
  });

  describe('handleCreateMarketSubworkspace', () => {
    it('ensures the workspace, creates a draft, publishes, returns 201 (no DB write)', async () => {
      const transport = makeTransport();
      const brand = makeBrand();
      const res = await handleCreateMarketSubworkspace(transport, brand, PARENT, createBody, log);
      expect(res.status).to.equal(201);
      expect(res.body).to.deep.equal({
        brandId: BRAND,
        geoTargetId: 2840,
        languageCode: 'en',
        workspaceId: WS,
        projectId: 'new-proj',
        published: true,
      });
      expect(transport.createProject).to.have.been.calledOnce;
      expect(transport.publishProject).to.have.been.calledOnce;
    });

    it('does not publish when publishMode is skip (draft-only)', async () => {
      const transport = makeTransport();
      const res = await handleCreateMarketSubworkspace(transport, makeBrand(), PARENT, createBody, log, null, null, { publishMode: 'skip' });
      expect(res.status).to.equal(201);
      expect(res.body.published).to.equal(false);
      expect(transport.createProject).to.have.been.calledOnce;
      expect(transport.publishProject).to.not.have.been.called;
    });

    it('best-effort publish swallows a quota 405 and keeps the project a draft', async () => {
      const transport = makeTransport({
        publishProject: sinon.stub().rejects(new SerenityTransportError(405, 'quota')),
      });
      const res = await handleCreateMarketSubworkspace(transport, makeBrand(), PARENT, createBody, log, null, null, { publishMode: 'best-effort' });
      expect(res.status).to.equal(201);
      expect(res.body.published).to.equal(false);
      expect(transport.publishProject).to.have.been.calledOnce;
    });

    it('best-effort publish re-throws a non-405 upstream error', async () => {
      const transport = makeTransport({
        publishProject: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });
      await expect(handleCreateMarketSubworkspace(transport, makeBrand(), PARENT, createBody, log, null, null, { publishMode: 'best-effort' })).to.be.rejectedWith(/boom/);
    });

    it('attaches selected AI models and generated topic-tagged prompts before publish', async () => {
      const transport = makeTransport({
        getBrandTopics: sinon.stub().resolves([
          { topic: 'Running Shoes', volume: 900, prompts: ['best running shoes', 'top trail shoes'] },
          { topic: 'Sandals', volume: 100, prompts: ['best sandals'] },
        ]),
        createTaggedPrompts: sinon.stub().resolves(null),
        listAiModels: sinon.stub().resolves({ items: [] }),
      });
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        {
          modelIds: ['m-1', 'm-2'],
          generateTopics: true,
          topicCap: 1,
          standardTags: ['source:ai'],
          projectTags: ['intent:informational', 'type:branded'],
          publishMode: 'require',
        },
      );
      expect(res.status).to.equal(201);
      // project-level tag taxonomy registered (independent of prompts)
      expect(transport.createProjectTags).to.have.been.calledOnceWith(WS, 'new-proj', ['intent:informational', 'type:branded']);
      // models attached
      expect(transport.addAiModel).to.have.been.calledWith(WS, 'new-proj', 'm-1');
      expect(transport.addAiModel).to.have.been.calledWith(WS, 'new-proj', 'm-2');
      // only the top-1 topic by volume was attached, tagged topic:<name> +
      // source:ai + a branded type: tag. Brand name is 'B' (needle 'b'):
      // 'best running shoes' contains 'b' => branded; 'top trail shoes' => not.
      expect(transport.createTaggedPrompts).to.have.been.calledOnce;
      const [, , promptsByText] = transport.createTaggedPrompts.firstCall.args;
      expect(promptsByText).to.deep.equal({
        'best running shoes': ['topic:Running Shoes', 'source:ai', 'type:branded'],
        'top trail shoes': ['topic:Running Shoes', 'source:ai', 'type:non-branded'],
      });
      expect(res.body).to.include({ topicCount: 1, promptCount: 2, published: true });
      // Models are STAGED (no inner publish) — only the single final publish runs,
      // so a quota 405 can never escape mid-flow from the model-set commit.
      expect(transport.publishProject).to.have.been.calledOnce;
    });

    it('tags prompts type:branded when text contains the brand name or an alias (case-insensitive), else type:non-branded', async () => {
      const transport = makeTransport({
        getBrandTopics: sinon.stub().resolves([
          {
            topic: 'Shoes',
            volume: 900,
            prompts: [
              'Best ACME running shoes', // brand name (different case) => branded
              'top trail sneakers from zoom', // alias 'Zoom' => branded
              'most comfortable sandals', // neither => non-branded
            ],
          },
        ]),
        createTaggedPrompts: sinon.stub().resolves(null),
      });
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        { ...createBody, brandNames: ['Acme'] },
        log,
        null,
        null,
        {
          generateTopics: true,
          standardTags: ['source:ai'],
          brandAliases: ['Zoom'],
          publishMode: 'skip',
        },
      );
      expect(res.status).to.equal(201);
      const [, , promptsByText] = transport.createTaggedPrompts.firstCall.args;
      expect(promptsByText).to.deep.equal({
        'Best ACME running shoes': ['topic:Shoes', 'source:ai', 'type:branded'],
        'top trail sneakers from zoom': ['topic:Shoes', 'source:ai', 'type:branded'],
        'most comfortable sandals': ['topic:Shoes', 'source:ai', 'type:non-branded'],
      });
    });

    it('409s when a LIVE project already exists for the slice', async () => {
      const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [proj({ status: 'live' })] }) });
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
      );
      expect(res.status).to.equal(409);
      expect(transport.createProject).to.not.have.been.called;
    });

    it('adopts a leftover DRAFT and resumes (publish, no new create)', async () => {
      const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [proj({ id: 'draft-1', status: 'draft' })] }) });
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
      );
      expect(res.status).to.equal(201);
      expect(transport.createProject).to.not.have.been.called;
      expect(transport.publishProject).to.have.been.calledWith(WS, 'draft-1');
    });

    it('400s on an invalid body', async () => {
      const res = await handleCreateMarketSubworkspace(makeTransport(), makeBrand(), PARENT, { market: 'us' }, log);
      expect(res.status).to.equal(400);
    });

    it('400s on an unknown market', async () => {
      const res = await handleCreateMarketSubworkspace(makeTransport(), makeBrand(), PARENT, { ...createBody, market: 'zz' }, log);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('unknownMarket');
    });

    it('400s and reports an empty name and a non-ISO-2 market together', async () => {
      const res = await handleCreateMarketSubworkspace(makeTransport(), makeBrand(), PARENT, {
        name: '', market: 'usa', languageCode: 'en', brandDomain: 'x.com', brandNames: ['B'],
      }, log);
      expect(res.status).to.equal(400);
      expect(res.body.message).to.match(/name/);
      expect(res.body.message).to.match(/ISO-2/);
    });

    it('400s unknownLanguage when the language is not in the upstream catalog', async () => {
      // Empty workspace -> create path -> resolveLanguageId('fr') misses (catalog
      // only has English) -> unknownLanguage.
      const res = await handleCreateMarketSubworkspace(makeTransport(), makeBrand(), PARENT, {
        ...createBody, languageCode: 'fr',
      }, log);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('unknownLanguage');
    });

    it('502s when createProject returns no id', async () => {
      const transport = makeTransport({ createProject: sinon.stub().resolves({ id: '' }) });
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
      );
      expect(res.status).to.equal(502);
    });

    it('uses a pre-resolved workspace id and skips the per-call ensure (activate batch path)', async () => {
      const transport = makeTransport();
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        'preset-ws',
      );
      expect(res.status).to.equal(201);
      // ensure was skipped: no settle/transfer was performed for this call.
      expect(transport.transferWorkspaceResources).to.not.have.been.called;
      // the draft is created against the pre-resolved workspace.
      expect(transport.createProject).to.have.been.calledWith('preset-ws');
    });
  });

  describe('handleDeleteMarketSubworkspace', () => {
    it('deletes the resolved project and returns 204', async () => {
      const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [proj({ id: 'gone-me' })] }) });
      const res = await handleDeleteMarketSubworkspace(transport, WS, 2840, 'en', log);
      expect(res.status).to.equal(204);
      expect(transport.deleteProject).to.have.been.calledWith(WS, 'gone-me');
    });

    it('is idempotent (204) when no slice matches', async () => {
      const res = await handleDeleteMarketSubworkspace(makeTransport(), WS, 2840, 'en', log);
      expect(res.status).to.equal(204);
    });

    it('treats an upstream 404 as success', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj()] }),
        deleteProject: sinon.stub().rejects(new SerenityTransportError(404, 'not found')),
      });
      const res = await handleDeleteMarketSubworkspace(transport, WS, 2840, 'en', log);
      expect(res.status).to.equal(204);
    });

    it('propagates a non-404 delete failure', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj()] }),
        deleteProject: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });
      await expect(handleDeleteMarketSubworkspace(transport, WS, 2840, 'en', log)).to.be.rejectedWith(SerenityTransportError);
    });
  });

  describe('handleListTagsSubworkspace', () => {
    it('aggregates unique tag names across the slice prompts', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listPromptsByTags: sinon.stub().resolves({
          items: [
            { id: 'q1', tags: [{ id: 't-1', name: 'Topic A' }] },
            { id: 'q2', tags: [{ id: 't-1', name: 'Topic A' }, { id: 't-2', name: 'Topic B' }] },
          ],
        }),
      });
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      expect(result.items).to.deep.equal([
        { id: 't-1', name: 'Topic A' },
        { id: 't-2', name: 'Topic B' },
      ]);
      expect(transport.listPromptsByTags).to.have.been.calledWith(WS, 'p-tag');
    });

    it('returns an empty set when no slice matches (no upstream prompt call)', async () => {
      const transport = makeTransport();
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      expect(result.items).to.deep.equal([]);
      expect(transport.listPromptsByTags).to.not.have.been.called;
    });

    it('400s on a missing slice key', async () => {
      await expect(handleListTagsSubworkspace(makeTransport(), WS, { languageCode: 'en' }, log))
        .to.be.rejectedWith(/geoTargetId/);
    });
  });

  describe('handleListModelsSubworkspace', () => {
    it('returns the global catalog when called without a slice', async () => {
      const transport = makeTransport({
        listGlobalAiModels: sinon.stub().resolves({
          items: [{ id: 'm1', key: 'gpt-4o', name: 'GPT-4o' }],
        }),
      });
      const result = await handleListModelsSubworkspace(transport, WS, {}, log);
      expect(result.items).to.deep.equal([{
        id: 'm1', key: 'gpt-4o', name: 'GPT-4o', icon: null,
      }]);
      expect(transport.listGlobalAiModels).to.have.been.called;
      expect(transport.listAiModels).to.not.have.been.called;
    });

    it('returns the slice models when called with geo+lang', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-mod' })] }),
        listAiModels: sinon.stub().resolves({
          items: [{ id: 'assign-1', model: { id: 'm1', key: 'gpt-4o', name: 'GPT-4o' } }],
        }),
      });
      const result = await handleListModelsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      expect(result.items).to.deep.equal([{
        id: 'm1', key: 'gpt-4o', name: 'GPT-4o', icon: null,
      }]);
      expect(transport.listAiModels).to.have.been.calledWith(WS, 'p-mod');
    });

    it('returns an empty set when the slice has no project', async () => {
      const transport = makeTransport();
      const result = await handleListModelsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      expect(result.items).to.deep.equal([]);
    });

    it('400s on partial params (geo without lang)', async () => {
      await expect(handleListModelsSubworkspace(makeTransport(), WS, { geoTargetId: 2840 }, log))
        .to.be.rejectedWith(/Provide both/);
    });
  });

  describe('handleUpdateModelsSubworkspace', () => {
    it('adds the missing model and returns the refreshed list', async () => {
      const listAiModels = sinon.stub();
      listAiModels.onFirstCall().resolves({ items: [] });
      listAiModels.onSecondCall().resolves({
        items: [{ id: 'assign-1', model: { id: 'm1', key: 'gpt-4o', name: 'GPT-4o' } }],
      });
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-mod' })] }),
        listAiModels,
      });
      const result = await handleUpdateModelsSubworkspace(
        transport,
        WS,
        { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] },
        log,
      );
      expect(transport.addAiModel).to.have.been.calledWith(WS, 'p-mod', 'm1');
      expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'p-mod');
      expect(result.items).to.deep.equal([{
        id: 'm1', key: 'gpt-4o', name: 'GPT-4o', icon: null,
      }]);
    });

    it('404s when the slice has no project', async () => {
      const transport = makeTransport();
      await expect(handleUpdateModelsSubworkspace(
        transport,
        WS,
        { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] },
        log,
      )).to.be.rejectedWith(/Market not found/);
    });

    it('400s on invalid modelIds', async () => {
      await expect(handleUpdateModelsSubworkspace(
        makeTransport(),
        WS,
        { geoTargetId: 2840, languageCode: 'en', modelIds: 'nope' },
        log,
      )).to.be.rejectedWith(/modelIds/);
    });

    it('400s on an invalid slice key', async () => {
      await expect(handleUpdateModelsSubworkspace(
        makeTransport(),
        WS,
        { geoTargetId: -1, languageCode: 'en', modelIds: ['m1'] },
        log,
      )).to.be.rejectedWith(/geoTargetId/);
    });

    it('400s when modelIds exceeds the maximum', async () => {
      const modelIds = Array.from({ length: 51 }, (unused, i) => `m${i}`);
      await expect(handleUpdateModelsSubworkspace(
        makeTransport(),
        WS,
        { geoTargetId: 2840, languageCode: 'en', modelIds },
        log,
      )).to.be.rejectedWith(/exceed/);
    });
  });
});
