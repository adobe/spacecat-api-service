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
import esmock from 'esmock';

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
    listBenchmarks: sinon.stub().resolves({ aio_benchmarks: [{ id: 'bench-1', main_brand: true }] }),
    createBrandUrls: sinon.stub().resolves({ ids: [], existing_count: 0 }),
    createBenchmarks: sinon.stub().resolves({ ids: ['bm-new'], existing_count: 0 }),
    deleteBenchmarks: sinon.stub().resolves(null),
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

    it('defaults the project brand_names to just the primary brand name when no aliases', async () => {
      const transport = makeTransport();
      await handleCreateMarketSubworkspace(transport, makeBrand(), PARENT, createBody, log);
      const projectBody = transport.createProject.firstCall.args[1];
      expect(projectBody.brand_name_display).to.equal('B');
      expect(projectBody.brand_names).to.deep.equal(['B']);
    });

    it('adds the brand aliases to the project brand_names (case-insensitive dedupe)', async () => {
      const transport = makeTransport();
      await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { brandAliases: ['Bee', 'B', 'Acme'] },
      );
      const projectBody = transport.createProject.firstCall.args[1];
      // display stays the primary; brand_names = primary + aliases, with the
      // duplicate 'B' dropped case-insensitively.
      expect(projectBody.brand_name_display).to.equal('B');
      expect(projectBody.brand_names).to.deep.equal(['B', 'Bee', 'Acme']);
    });

    it('region-clamps { name, regions } aliases to the market on create (a DE alias is dropped for a US market)', async () => {
      const transport = makeTransport();
      await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody, // US market (geoTargetId 2840)
        log,
        null,
        null,
        {
          brandAliases: [
            { name: 'Global', regions: [] }, // region-less → applies
            { name: 'US Co', regions: ['us'] }, // applies
            { name: 'DE Marke', regions: ['de'] }, // dropped for US
          ],
        },
      );
      const projectBody = transport.createProject.firstCall.args[1];
      expect(projectBody.brand_names).to.deep.equal(['B', 'Global', 'US Co']);
    });

    it('pushes region-filtered brand URLs onto the main benchmark before publishing', async () => {
      const transport = makeTransport();
      const brandUrlSources = {
        urls: ['https://b.com', 'http://insecure.com'],
        socialAccounts: [
          { url: 'https://x.com/us', regions: ['us'] },
          { url: 'https://x.com/de', regions: ['de'] },
        ],
        earnedContent: [{ url: 'https://news/b', regions: [] }],
      };
      await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { brandUrlSources },
      );
      expect(transport.listBenchmarks).to.have.been.calledOnceWith(WS, 'new-proj');
      // http:// dropped; de-region social dropped; us social + region-less earned kept.
      expect(transport.createBrandUrls).to.have.been.calledOnceWith(WS, 'new-proj', 'bench-1', [
        { url: 'https://b.com', type: 'website' },
        { url: 'https://x.com/us', type: 'social' },
        { url: 'https://news/b', type: 'earned' },
      ]);
      expect(transport.createBrandUrls).to.have.been.calledBefore(transport.publishProject);
    });

    it('tracks region-filtered competitors as benchmarks before publishing', async () => {
      const transport = makeTransport();
      const competitors = [
        { name: 'Rival', url: 'https://rival.com', regions: ['us'] },
        { name: 'Other', url: 'https://other-region.com', regions: ['de'] }, // filtered out for us
      ];
      await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { competitors },
      );
      // Our us competitor becomes a benchmark; the de one is excluded.
      expect(transport.createBenchmarks).to.have.been.calledWith(WS, 'new-proj', [
        { brand_name: 'Rival', domain: 'rival.com' },
      ]);
      expect(transport.createBenchmarks).to.have.been.calledBefore(transport.publishProject);
    });

    it('does not create competitor benchmarks when there are no competitors', async () => {
      const transport = makeTransport();
      await handleCreateMarketSubworkspace(transport, makeBrand(), PARENT, createBody, log);
      // No brand URLs and no competitors → no benchmark creation at all.
      expect(transport.createBenchmarks).to.not.have.been.called;
    });

    it('does NOT fail the create when the competitor benchmark sync fails (best-effort)', async () => {
      const transport = makeTransport({
        createBenchmarks: sinon.stub().rejects(new SerenityTransportError(500, 'bench boom')),
      });
      const result = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { competitors: [{ name: 'Rival', url: 'https://rival.com' }] },
      );
      // Competitor sync is best-effort — the create still publishes and succeeds.
      expect(result.status).to.equal(201);
      expect(transport.publishProject).to.have.been.called;
    });

    it('does not touch the brand-URL API when there are no sources', async () => {
      const transport = makeTransport();
      await handleCreateMarketSubworkspace(transport, makeBrand(), PARENT, createBody, log);
      expect(transport.listBenchmarks).to.not.have.been.called;
      expect(transport.createBrandUrls).to.not.have.been.called;
    });

    it('does NOT fail the create when the brand-URL push fails (best-effort)', async () => {
      const transport = makeTransport({
        createBrandUrls: sinon.stub().rejects(new SerenityTransportError(400, 'bad url')),
      });
      const result = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { brandUrlSources: { urls: ['https://b.com'] } },
      );
      // URL enrichment is best-effort — a push failure is logged, not propagated;
      // the create still publishes and succeeds.
      expect(result.status).to.equal(201);
      expect(transport.publishProject).to.have.been.called;
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
          projectTags: ['intent:Informational', 'type:branded'],
          publishMode: 'require',
        },
      );
      expect(res.status).to.equal(201);
      // project-level tag taxonomy registered (independent of prompts)
      expect(transport.createProjectTags).to.have.been.calledOnceWith(WS, 'new-proj', ['intent:Informational', 'type:branded']);
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

    it('propagates a fatal model-attach failure (NOT best-effort like URL/competitor enrichment)', async () => {
      // Model attach is a core correctness step: a failure must abort the create
      // (a half-provisioned project must never be reported as success).
      const transport = makeTransport({
        listAiModels: sinon.stub().resolves({ items: [] }),
        addAiModel: sinon.stub().rejects(new SerenityTransportError(502, 'model attach boom')),
      });
      await expect(handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { modelIds: ['m-1'], publishMode: 'require' },
      )).to.be.rejectedWith(/model attach boom/);
    });

    it('propagates a fatal topic-generation failure (getBrandTopics throw aborts the create)', async () => {
      const transport = makeTransport({
        listAiModels: sinon.stub().resolves({ items: [] }),
        getBrandTopics: sinon.stub().rejects(new SerenityTransportError(502, 'topics boom')),
      });
      await expect(handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        {
          generateTopics: true, topicCap: 1, standardTags: ['source:ai'], publishMode: 'require',
        },
      )).to.be.rejectedWith(/topics boom/);
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

    it('best-effort publish marks the project published when the publish succeeds', async () => {
      const transport = makeTransport();
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { publishMode: 'best-effort' },
      );
      expect(res.status).to.equal(201);
      expect(res.body.published).to.equal(true);
      expect(transport.publishProject).to.have.been.calledOnce;
    });

    it('reads topics from the { items: [...] } envelope shape returned by getBrandTopics', async () => {
      const transport = makeTransport({
        getBrandTopics: sinon.stub().resolves({
          items: [{ topic: 'Boots', volume: 500, prompts: ['best boots'] }],
        }),
        createTaggedPrompts: sinon.stub().resolves(null),
      });
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { generateTopics: true, standardTags: ['source:ai'], publishMode: 'skip' },
      );
      expect(res.status).to.equal(201);
      expect(transport.createTaggedPrompts).to.have.been.calledOnce;
      const [, , promptsByText] = transport.createTaggedPrompts.firstCall.args;
      expect(promptsByText).to.have.property('best boots');
    });

    it('skips the prompt attach (topicCount/promptCount 0) when topics yield no prompts', async () => {
      const transport = makeTransport({
        // Topics present but every prompts list is empty → nothing to attach.
        getBrandTopics: sinon.stub().resolves([
          { topic: 'Empty', volume: 10, prompts: [] },
          { topic: 'AlsoEmpty', volume: 5 },
        ]),
        createTaggedPrompts: sinon.stub().resolves(null),
      });
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { generateTopics: true, standardTags: ['source:ai'], publishMode: 'skip' },
      );
      expect(res.status).to.equal(201);
      expect(res.body).to.include({ topicCount: 0, promptCount: 0 });
      expect(transport.createTaggedPrompts).to.not.have.been.called;
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

    it('parentId drills the standalone tree (draft view) instead of the prompt merge', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listPromptsByTags: sinon.stub(),
        listProjectTags: sinon.stub().resolves({
          page: 1,
          total: 1,
          items: [{
            id: 'child-1',
            name: 'category:Sneakers',
            parent_id: 'root-1',
            children_count: 0,
            path: [{ id: 'root-1', name: 'category:Footwear' }],
          }],
        }),
      });
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en', parentId: 'root-1' }, log);
      expect(result.items).to.deep.equal([{
        id: 'child-1',
        name: 'category:Sneakers',
        parentId: 'root-1',
        childrenCount: 0,
        path: [{ id: 'root-1', name: 'category:Footwear' }],
      }]);
      expect(transport.listPromptsByTags).to.not.have.been.called;
      expect(transport.listProjectTags).to.have.been.calledOnceWithExactly(WS, 'p-tag', {
        parentId: 'root-1', page: 1, limit: 100, draft: true,
      });
    });

    it('merges standalone tags (prompt-less categories) with prompt-derived ones, deduped by name', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 'q1', tags: [{ id: 't-1', name: 'category:Running Shoes' }] }],
        }),
        // A standalone category created via createProjectTags that no prompt carries
        // yet, plus one that IS already on a prompt (must not duplicate).
        listProjectTags: sinon.stub().resolves({
          items: [
            { id: 't-9', name: 'category:Hiking Boots' },
            { id: 't-1', name: 'category:Running Shoes' },
          ],
        }),
      });
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      expect(result.items).to.deep.equal([
        { id: 't-1', name: 'category:Running Shoes' },
        { id: 't-9', name: 'category:Hiking Boots' },
      ]);
      expect(transport.listProjectTags).to.have.been.calledWith(WS, 'p-tag');
    });

    it('keeps prompt-derived tags when the standalone tag list call fails (best-effort)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 'q1', tags: [{ id: 't-1', name: 'category:Running Shoes' }] }],
        }),
        listProjectTags: sinon.stub().rejects(new Error('boom')),
      });
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      expect(result.items).to.deep.equal([{ id: 't-1', name: 'category:Running Shoes' }]);
    });

    it('upgrades a synthetic prompt-derived id to the canonical standalone id (no shadowing)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        // Prompt-derived tag arrives as a BARE STRING → synthetic id === name.
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 'q1', tags: ['category:Running Shoes'] }],
        }),
        // Standalone listing carries the canonical upstream id for the same name;
        // it must win over the synthetic id even though prompts are merged first.
        listProjectTags: sinon.stub().resolves({
          items: [{ id: 't-1', name: 'category:Running Shoes' }],
        }),
      });
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      expect(result.items).to.deep.equal([{ id: 't-1', name: 'category:Running Shoes' }]);
    });

    it('keeps the first (prompt-derived) real id when both sources supply different real ids for a name', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 'q1', tags: [{ id: 'prompt-id', name: 'category:Running Shoes' }] }],
        }),
        listProjectTags: sinon.stub().resolves({
          items: [{ id: 'standalone-id', name: 'category:Running Shoes' }],
        }),
      });
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      // Both ids are real (≠ name), so the synthetic-id upgrade does not fire and
      // first-writer-wins holds: the prompt-derived id is kept deterministically.
      expect(result.items).to.deep.equal([{ id: 'prompt-id', name: 'category:Running Shoes' }]);
    });

    it('warns when the standalone tag page ceiling is hit (possible truncation)', async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, name: `category:C${i}` }));
      const warnLog = { info: () => {}, error: () => {}, warn: sinon.stub() };
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listPromptsByTags: sinon.stub().resolves({ items: [] }),
        // Every page is full → the walk never short-circuits and runs to the ceiling.
        listProjectTags: sinon.stub().resolves({ items: fullPage }),
      });
      await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, warnLog);
      expect(warnLog.warn).to.have.been.calledWithMatch(/page ceiling hit/);
      expect(transport.listProjectTags.callCount).to.equal(50);
    });

    it('treats a standalone tag page with no items array as empty (defensive)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 'q1', tags: [{ id: 't-1', name: 'category:Running Shoes' }] }],
        }),
        // Upstream page carries no items array — must be coerced to empty, not throw.
        listProjectTags: sinon.stub().resolves(null),
      });
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      expect(result.items).to.deep.equal([{ id: 't-1', name: 'category:Running Shoes' }]);
    });

    it('falls back to the tag name as id when a standalone tag has no id', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listPromptsByTags: sinon.stub().resolves({ items: [] }),
        listProjectTags: sinon.stub().resolves({
          items: [{ name: 'category:No Id Yet' }],
        }),
      });
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      expect(result.items).to.deep.equal([{ id: 'category:No Id Yet', name: 'category:No Id Yet' }]);
    });

    it('paginates the standalone tag listing so categories beyond the first page are not dropped', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, name: `category:C${i}` }));
      const listProjectTags = sinon.stub();
      listProjectTags.onFirstCall().resolves({ items: page1 });
      listProjectTags.onSecondCall().resolves({ items: [{ id: 't-last', name: 'category:Last' }] });
      // A short second page must end the walk; a third fetch would be an
      // over-fetch bug — make it throw so the assertions below fail loudly
      // rather than silently getting sinon's default undefined.
      listProjectTags.onThirdCall().rejects(new Error('unexpected 3rd standalone page fetch'));
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listPromptsByTags: sinon.stub().resolves({ items: [] }),
        listProjectTags,
      });
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      // A full first page (=== limit) forces a second fetch; a short page ends it.
      expect(listProjectTags.callCount).to.equal(2);
      expect(listProjectTags.secondCall.args).to.deep.equal([WS, 'p-tag', { page: 2, limit: 100 }]);
      expect(result.items).to.have.lengthOf(101);
      expect(result.items).to.deep.include({ id: 't-last', name: 'category:Last' });
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

describe('markets-subworkspace — defensive branch coverage', () => {
  afterEach(() => {
    sinon.restore();
    clearTagCache();
  });

  // Line 86: `status?.initialized ?? null` — the `?? null` branch fires when
  // transport.getInitStatus resolves with an object that has no `initialized`
  // field (e.g. `{}`). The existing test "tolerates an init_status read failure"
  // covers the catch path; this covers the success path with a missing key.
  it('handleGetMarketSubworkspace: initialized is null when getInitStatus returns {} (no initialized field)', async () => {
    const transport = makeTransport({
      listProjects: sinon.stub().resolves({ items: [proj()] }),
      getInitStatus: sinon.stub().resolves({}),
    });
    const result = await handleGetMarketSubworkspace(transport, BRAND, WS, 2840, 'en', log);
    expect(result.initialized).to.equal(null);
  });

  // Line 115: `hasText(body?.name)?String(body.name):defaultMarketName(body.brandDisplayName)` else
  // — body without a `name` field so defaultMarketName is called.
  // Note: the existing test "defaults the project brand_names to just the primary brand name when
  // no aliases" already passes a body without `name`, but does not assert the generated name
  // pattern. This test locks the else branch explicitly by asserting the random-suffix shape.
  it('buildCreateProjectBody: uses defaultMarketName when body has no name field', async () => {
    const transport = makeTransport();
    const brand = makeBrand();
    const bodyNoName = {
      market: 'us',
      languageCode: 'en',
      brandDomain: 'example.com',
      brandNames: ['B'],
      brandDisplayName: 'MyBrand',
    };
    const res = await handleCreateMarketSubworkspace(transport, brand, PARENT, bodyNoName, log);
    expect(res.status).to.equal(201);
    const projectBody = transport.createProject.firstCall.args[1];
    // defaultMarketName produces "<brandDisplayName>-<6hex>".
    expect(projectBody.name).to.match(/^MyBrand-[0-9a-f]{6}$/);
  });

  // brand_name_display honors an explicit brandDisplayName when it differs from
  // the primary brand name (brandNames[0]) — keeping the project display name
  // consistent with the own-brand benchmark built from brandDisplayName and with
  // the re-sync path that reads brand_name_display back. Falls back to
  // brandNames[0] only when brandDisplayName is absent.
  it('buildCreateProjectBody: brand_name_display uses brandDisplayName over brandNames[0]', async () => {
    const transport = makeTransport();
    const brand = makeBrand();
    const res = await handleCreateMarketSubworkspace(transport, brand, PARENT, {
      market: 'us',
      languageCode: 'en',
      brandDomain: 'example.com',
      brandNames: ['Primary'],
      brandDisplayName: 'Display Name',
    }, log);
    expect(res.status).to.equal(201);
    const projectBody = transport.createProject.firstCall.args[1];
    expect(projectBody.brand_name_display).to.equal('Display Name');
  });

  it('buildCreateProjectBody: brand_name_display falls back to brandNames[0] when brandDisplayName is absent', async () => {
    const transport = makeTransport();
    const brand = makeBrand();
    const res = await handleCreateMarketSubworkspace(transport, brand, PARENT, {
      market: 'us',
      languageCode: 'en',
      brandDomain: 'example.com',
      brandNames: ['Primary'],
    }, log);
    expect(res.status).to.equal(201);
    const projectBody = transport.createProject.firstCall.args[1];
    expect(projectBody.brand_name_display).to.equal('Primary');
  });

  // Line 121: `...(Array.isArray(brandAliases)?brandAliases:[])` else branch fires
  // when brandAliases is null (default is [] but null bypasses the default).
  // With generateTopics: false the unguarded `...brandAliases` at line 375 is
  // never reached, so the null is safely handled by line 121's guard instead.
  it('buildCreateProjectBody: falls back to [] when brandAliases is null', async () => {
    const transport = makeTransport();
    const brand = makeBrand();
    const res = await handleCreateMarketSubworkspace(
      transport,
      brand,
      PARENT,
      { ...createBody, brandNames: ['BrandX'] },
      log,
      null,
      null,
      { brandAliases: null },
    );
    expect(res.status).to.equal(201);
    const projectBody = transport.createProject.firstCall.args[1];
    // With null brandAliases the else fires and produces []; dedupeNames(['BrandX']) = ['BrandX'].
    expect(projectBody.brand_names).to.deep.equal(['BrandX']);
  });

  // Line 192: `.sort((a,b)=>(Number(b?.volume)||0)-(Number(a?.volume)||0))`
  // Both `||0` branches fire when volume is missing/non-numeric on the topics.
  // generateAndAttachPrompts is reached when generateTopics: true.
  it('generateAndAttachPrompts: handles topics with missing volume (both ||0 branches)', async () => {
    const transport = makeTransport({
      getBrandTopics: sinon.stub().resolves([
        // Neither topic has a volume field — Number(undefined)||0 fires on both
        // sides of the sort comparator.
        { topic: 'Alpha', prompts: ['alpha prompt'] },
        { topic: 'Beta', prompts: ['beta prompt'] },
      ]),
      createTaggedPrompts: sinon.stub().resolves(null),
    });
    const brand = makeBrand();
    const res = await handleCreateMarketSubworkspace(
      transport,
      brand,
      PARENT,
      createBody,
      log,
      null,
      null,
      { generateTopics: true, standardTags: [], publishMode: 'skip' },
    );
    expect(res.status).to.equal(201);
    // Both prompts are attached — no crash from the sort comparator.
    expect(transport.createTaggedPrompts).to.have.been.calledOnce;
  });

  // Line 198: `String(s || '')` — the `|| ''` branch fires for a falsy element
  // in the brandAliases array (e.g. an empty string or null element).
  // When an element is falsy, `s || ''` coerces to '' which is then trimmed and
  // filtered out by `.filter((s) => s.length > 0)`, so it produces no needle.
  it('generateAndAttachPrompts: falsy element in brandAliases is coerced and filtered out (s||"" branch)', async () => {
    const transport = makeTransport({
      getBrandTopics: sinon.stub().resolves([
        { topic: 'T', volume: 10, prompts: ['adobe shoes'] },
      ]),
      createTaggedPrompts: sinon.stub().resolves(null),
    });
    const brand = makeBrand();
    const res = await handleCreateMarketSubworkspace(
      transport,
      brand,
      PARENT,
      // brandNames contains 'adobe'; aliases contains a null/empty element.
      { ...createBody, brandNames: ['adobe'] },
      log,
      null,
      null,
      {
        generateTopics: true,
        standardTags: [],
        // null element → String(null || '') = '' → trimmed → filtered out.
        brandAliases: [null, 'AdobeSub'],
        publishMode: 'skip',
      },
    );
    expect(res.status).to.equal(201);
    const [, , promptsByText] = transport.createTaggedPrompts.firstCall.args;
    // 'adobe shoes' contains 'adobe' → branded (null alias was dropped, not used).
    expect(promptsByText['adobe shoes']).to.include('type:branded');
  });

  // Line 115 truthy branch: body.name is provided and valid — String(body.name) is used
  // directly instead of defaultMarketName. All existing tests use createBody (no name
  // field), so this side was never exercised.
  it('buildCreateProjectBody: uses body.name directly when a valid name is provided', async () => {
    const transport = makeTransport();
    const brand = makeBrand();
    const bodyWithName = {
      name: 'explicit-project-name',
      market: 'us',
      languageCode: 'en',
      brandDomain: 'example.com',
      brandNames: ['B'],
      brandDisplayName: 'B',
    };
    const res = await handleCreateMarketSubworkspace(transport, brand, PARENT, bodyWithName, log);
    expect(res.status).to.equal(201);
    const projectBody = transport.createProject.firstCall.args[1];
    expect(projectBody.name).to.equal('explicit-project-name');
  });

  // Lines 124 and 218 are defensive `: []` / `|| ''` guards inside
  // buildCreateProjectBody and generateAndAttachPrompts respectively. Through the
  // normal handler they are unreachable: `collectAliasNames` (brand-aliases.js)
  // always returns a clean string[] (Array.isArray guard + dedupeAliases drops
  // empties), so the handler never feeds a non-array — nor an array with a falsy
  // element — into those guards. We esmock collectAliasNames to inject exactly
  // those degenerate shapes so the guards are exercised.

  // Line 124: `...(Array.isArray(brandAliases) ? brandAliases : [])` else branch.
  // collectAliasNames returns a NON-array (null); with generateTopics:false the
  // unguarded `...aliasNames` spread (line 411) is never reached, so the null
  // only lands on buildCreateProjectBody's `brandAliases` param, where the
  // Array.isArray guard coerces it to [].
  it('buildCreateProjectBody: coerces a non-array aliasNames to [] (collectAliasNames returns null)', async () => {
    const handler = await esmock(
      '../../../../src/support/serenity/handlers/markets-subworkspace.js',
      {
        '../../../../src/support/serenity/brand-aliases.js': {
          collectAliasNames: () => null,
        },
      },
    );
    const transport = makeTransport();
    const res = await handler.handleCreateMarketSubworkspace(
      transport,
      makeBrand(),
      PARENT,
      { ...createBody, brandNames: ['BrandX'] },
      log,
      null,
      null,
      // generateTopics omitted (false) → line 411 `...aliasNames` not reached.
      { brandAliases: [{ name: 'ignored', regions: ['us'] }] },
    );
    expect(res.status).to.equal(201);
    const projectBody = transport.createProject.firstCall.args[1];
    // Non-array aliasNames → else branch → [] → brand_names is just the primary.
    expect(projectBody.brand_names).to.deep.equal(['BrandX']);
  });

  // Line 218: `String(s || '')` falsy branch. collectAliasNames returns an array
  // CONTAINING a falsy element (''); with generateTopics:true that element flows
  // through the `brandNames` array spread (line 411) into generateAndAttachPrompts,
  // where `.map((s) => String(s || ''))` hits the `|| ''` side for the falsy entry
  // (coerced to '' then filtered out, so it produces no needle).
  it('generateAndAttachPrompts: coerces a falsy alias element via `s || ""` (collectAliasNames returns ["", "Real"])', async () => {
    const handler = await esmock(
      '../../../../src/support/serenity/handlers/markets-subworkspace.js',
      {
        '../../../../src/support/serenity/brand-aliases.js': {
          collectAliasNames: () => ['', 'Real'],
        },
      },
    );
    const transport = makeTransport({
      getBrandTopics: sinon.stub().resolves([
        { topic: 'T', volume: 10, prompts: ['real deal', 'plain text'] },
      ]),
      createTaggedPrompts: sinon.stub().resolves(null),
    });
    const res = await handler.handleCreateMarketSubworkspace(
      transport,
      makeBrand(),
      PARENT,
      { ...createBody, brandNames: ['B'] },
      log,
      null,
      null,
      {
        generateTopics: true,
        standardTags: [],
        brandAliases: [{ name: 'ignored', regions: ['us'] }],
        publishMode: 'skip',
      },
    );
    expect(res.status).to.equal(201);
    const [, , promptsByText] = transport.createTaggedPrompts.firstCall.args;
    // Needles = ['b','real'] (the '' element was coerced + filtered out).
    // 'real deal' contains 'real' → branded; 'plain text' → non-branded.
    expect(promptsByText['real deal']).to.include('type:branded');
    expect(promptsByText['plain text']).to.include('type:non-branded');
  });
});
