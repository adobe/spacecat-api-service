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
import { TAG_IDS, dimensionTreeLevels, makeListProjectTagsStub } from '../fixtures/tag-tree.js';

use(chaiAsPromised);
use(sinonChai);

// Every generated prompt carries the two standard values (origin=ai,
// intent=Informational); the third tag is the per-prompt computed `type`.
const STANDARD_IDS = [TAG_IDS.originAi, TAG_IDS.intentInformational];

const BRAND = 'brand-1';
const WS = 'subworkspace-ws-1';
const PARENT = 'parent-ws';
const log = { info: () => {}, error: () => {}, warn: () => {} };

function proj({
  id = 'p1', geo = 2840, lang = 'en', status = 'live', domain = undefined,
} = {}) {
  return {
    id,
    publish_status: status,
    updated_at: '2026-06-02T00:00:00Z',
    ...(domain === undefined ? {} : { domain }),
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
    createProjectTags: sinon.stub().resolves([]),
    listProjectTags: makeListProjectTagsStub(),
    createPromptsByIds: sinon.stub().resolves({ page: 1, total: 0, items: [] }),
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
    getSemrushSubWorkspaceId: () => ws,
    setSemrushSubWorkspaceId: (v) => { ws = v; },
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

    it('upserts the mapping row when options.dataAccess is supplied', async () => {
      const transport = makeTransport();
      const create = sinon.stub().resolves({});
      const dataAccess = { BrandSemrushProject: { create } };
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { dataAccess },
      );
      expect(res.status).to.equal(201);
      expect(create).to.have.been.calledOnce;
      const [payload] = create.firstCall.args;
      expect(payload).to.deep.equal({
        brandId: BRAND,
        semrushProjectId: 'new-proj',
        geoTargetId: 2840,
        languageCode: 'en',
        deletedAt: null,
      });
    });

    it('does not touch the mapping row when options.dataAccess is omitted', async () => {
      const transport = makeTransport();
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
      );
      expect(res.status).to.equal(201);
      // No dataAccess passed in at all — nothing to assert a call on beyond the
      // absence of a thrown error; the "no DB write" case above already covers
      // this via its exact-body deep.equal.
    });

    it('does not fail the create when the mapping-row upsert fails (best-effort)', async () => {
      const transport = makeTransport();
      const create = sinon.stub().rejects(new Error('postgrest unavailable'));
      const dataAccess = { BrandSemrushProject: { create } };
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { dataAccess },
      );
      expect(res.status).to.equal(201);
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

    it('skips the brand\'s own primary domain (apex and www) when pushing brand URLs', async () => {
      const transport = makeTransport();
      // createBody.brandDomain is 'example.com' — the project's own-brand benchmark
      // already carries it, so neither the apex nor the www form may be written as a
      // `website` brand URL (serenity-docs#25). A secondary site still goes through.
      const brandUrlSources = {
        urls: [
          'https://example.com',
          'https://www.example.com',
          'https://shop.example.com',
        ],
        socialAccounts: [],
        earnedContent: [],
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
      expect(transport.createBrandUrls).to.have.been.calledOnceWith(WS, 'new-proj', 'bench-1', [
        { url: 'https://shop.example.com', type: 'website' },
      ]);
    });

    it('skips ANOTHER market\'s primary domain when pushing brand URLs (market-mirror brand)', async () => {
      // A sibling CA project already exists on acme.ca. Creating the US market
      // (brandDomain example.com) must skip BOTH primaries: example.com because it
      // is this market's own, acme.ca because it is CA's — neither may be written
      // as a website brand URL here. Only the genuine secondary site survives.
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({
          items: [proj({
            id: 'ca-proj', geo: 2124, lang: 'en', domain: 'acme.ca',
          })],
        }),
      });
      const brandUrlSources = {
        urls: ['https://example.com', 'https://acme.ca', 'https://shop.example.com'],
        socialAccounts: [],
        earnedContent: [],
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
      expect(transport.createBrandUrls).to.have.been.calledOnceWith(WS, 'new-proj', 'bench-1', [
        { url: 'https://shop.example.com', type: 'website' },
      ]);
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

    it('attaches selected AI models and generated prompts by tag id before publish', async () => {
      const transport = makeTransport({
        getBrandTopics: sinon.stub().resolves([
          { topic: 'Running Shoes', volume: 900, prompts: ['best running shoes', 'top trail shoes'] },
          { topic: 'Sandals', volume: 100, prompts: ['best sandals'] },
        ]),
        listAiModels: sinon.stub().resolves({ items: [] }),
      });
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        { ...createBody, brandNames: ['Trail'] },
        log,
        null,
        null,
        {
          modelIds: ['m-1', 'm-2'],
          generateTopics: true,
          topicCap: 1,
          publishMode: 'require',
        },
      );
      expect(res.status).to.equal(201);
      // The taxonomy is provisioned by resolving the tree; this project already
      // carries all four roots and every closed value, so nothing is created.
      expect(transport.createProjectTags).to.not.have.been.called;
      // models attached
      expect(transport.addAiModel).to.have.been.calledWith(WS, 'new-proj', 'm-1');
      expect(transport.addAiModel).to.have.been.calledWith(WS, 'new-proj', 'm-2');

      // Only the top-1 topic by volume is attached. The generated prompts carry
      // NO category tag — the topic name is not a tag under this model — just the
      // two standard values plus the computed `type`. Brand name is 'Trail'
      // (needle 'trail'): the shared classifier matches on WORD boundaries, so
      // 'top trail shoes' is branded and 'best running shoes' is not. Prompts are
      // grouped by computed type, one upstream call per group, because
      // createPromptsByIds carries ONE shared tag_ids array per call.
      expect(transport.createPromptsByIds).to.have.been.calledTwice;
      expect(transport.createPromptsByIds).to.have.been.calledWithExactly(WS, 'new-proj', ['best running shoes'], [...STANDARD_IDS, TAG_IDS.typeNonBranded]);
      expect(transport.createPromptsByIds).to.have.been.calledWithExactly(WS, 'new-proj', ['top trail shoes'], [...STANDARD_IDS, TAG_IDS.typeBranded]);
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
          generateTopics: true, topicCap: 1, standardTags: ['origin:ai'], publishMode: 'require',
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
          brandAliases: ['Zoom'],
          publishMode: 'skip',
        },
      );
      expect(res.status).to.equal(201);
      // Two branded prompts share one call; the single non-branded one gets its own.
      expect(transport.createPromptsByIds).to.have.been.calledWithExactly(
        WS,
        'new-proj',
        ['Best ACME running shoes', 'top trail sneakers from zoom'],
        [...STANDARD_IDS, TAG_IDS.typeBranded],
      );
      expect(transport.createPromptsByIds).to.have.been.calledWithExactly(
        WS,
        'new-proj',
        ['most comfortable sandals'],
        [...STANDARD_IDS, TAG_IDS.typeNonBranded],
      );
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
      });
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { generateTopics: true, publishMode: 'skip' },
      );
      expect(res.status).to.equal(201);
      expect(transport.createPromptsByIds).to.have.been.calledOnce;
      const [, , items] = transport.createPromptsByIds.firstCall.args;
      expect(items).to.deep.equal(['best boots']);
    });

    it('skips the prompt attach (topicCount/promptCount 0) when topics yield no prompts', async () => {
      const transport = makeTransport({
        // Topics present but every prompts list is empty → nothing to attach.
        getBrandTopics: sinon.stub().resolves([
          { topic: 'Empty', volume: 10, prompts: [] },
          { topic: 'AlsoEmpty', volume: 5 },
        ]),
      });
      const res = await handleCreateMarketSubworkspace(
        transport,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { generateTopics: true, publishMode: 'skip' },
      );
      expect(res.status).to.equal(201);
      expect(res.body).to.include({ topicCount: 0, promptCount: 0 });
      expect(transport.createPromptsByIds).to.not.have.been.called;
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

    it('tombstones the mapping row by project id when options.dataAccess is supplied', async () => {
      const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [proj({ id: 'gone-me' })] }) });
      const row = { setDeletedAt: sinon.stub(), save: sinon.stub().resolves() };
      const findBySemrushProjectId = sinon.stub().resolves(row);
      const dataAccess = { BrandSemrushProject: { findBySemrushProjectId } };
      const res = await handleDeleteMarketSubworkspace(transport, WS, 2840, 'en', log, { dataAccess });
      expect(res.status).to.equal(204);
      expect(findBySemrushProjectId).to.have.been.calledOnceWith('gone-me');
      expect(row.setDeletedAt).to.have.been.calledOnce;
      expect(row.save).to.have.been.calledOnce;
    });

    it('does not tombstone when the project is not found in the listing at all (accepted, reconcile-recoverable drift)', async () => {
      const findBySemrushProjectId = sinon.stub().resolves(null);
      const dataAccess = { BrandSemrushProject: { findBySemrushProjectId } };
      const res = await handleDeleteMarketSubworkspace(makeTransport(), WS, 2840, 'en', log, { dataAccess });
      expect(res.status).to.equal(204);
      expect(findBySemrushProjectId).to.not.have.been.called;
    });

    it('does not fail the delete when the tombstone write fails (best-effort)', async () => {
      const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [proj({ id: 'gone-me' })] }) });
      const findBySemrushProjectId = sinon.stub().rejects(new Error('postgrest unavailable'));
      const dataAccess = { BrandSemrushProject: { findBySemrushProjectId } };
      const res = await handleDeleteMarketSubworkspace(transport, WS, 2840, 'en', log, { dataAccess });
      expect(res.status).to.equal(204);
    });
  });

  describe('handleListTagsSubworkspace', () => {
    it('aggregates unique tag names across the slice prompts', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listProjectTags: sinon.stub().resolves({ items: [] }),
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

    it('400s a parentId query over the length ceiling (MysticatBot review, PR 2737)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listProjectTags: sinon.stub(),
      });
      await expect(handleListTagsSubworkspace(
        transport,
        WS,
        { geoTargetId: 2840, languageCode: 'en', parentId: 'x'.repeat(201) },
        log,
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.listProjectTags).to.not.have.been.called;
    });

    it('400s a parentId query containing a control character (MysticatBot review, PR 2737)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listProjectTags: sinon.stub(),
      });
      await expect(handleListTagsSubworkspace(
        transport,
        WS,
        { geoTargetId: 2840, languageCode: 'en', parentId: `root-${String.fromCharCode(7)}` },
        log,
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.listProjectTags).to.not.have.been.called;
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

    it('keeps BOTH tags when two real ids share a name (a name is not an identity)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 'q1', tags: [{ id: 'prompt-id', name: 'human' }] }],
        }),
        listProjectTags: sinon.stub().resolves({
          items: [{ id: 'standalone-id', name: 'human' }],
        }),
      });
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      // Names are unique only per (project, parent): a sub-category `human` and
      // the `origin` value `human` are different tags. Keying by name would drop
      // one of them; keying by id keeps both.
      expect(result.items).to.deep.equal([
        { id: 'prompt-id', name: 'human' },
        { id: 'standalone-id', name: 'human' },
      ]);
    });

    it('collapses two id-less same-named placeholders to one (indistinguishable without an id)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj({ id: 'p-tag' })] }),
        // Two DISTINCT tags both arrive as bare strings (no upstream id) sharing a
        // name. With no id there is nothing to tell them apart, so they collapse to
        // one placeholder rather than emitting a duplicate `{ id: name, name }` row.
        // The by-id merge (see the sibling test) is what preserves two same-named
        // tags whenever either carries a real id — the common case.
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 'q1', tags: ['human', 'human'] }],
        }),
        listProjectTags: sinon.stub().resolves({ items: [] }),
      });
      const result = await handleListTagsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      expect(result.items).to.deep.equal([{ id: 'human', name: 'human' }]);
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
      expect(listProjectTags.secondCall.args)
        .to.deep.equal([WS, 'p-tag', { page: 2, limit: 100, draft: true }]);
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
      { generateTopics: true, publishMode: 'skip' },
    );
    expect(res.status).to.equal(201);
    // Both prompts are attached (both non-branded, so one call) — no crash from
    // the sort comparator.
    expect(transport.createPromptsByIds).to.have.been.calledOnce;
    expect(transport.createPromptsByIds.firstCall.args[2])
      .to.deep.equal(['alpha prompt', 'beta prompt']);
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
        // null element → String(null || '') = '' → trimmed → filtered out.
        brandAliases: [null, 'AdobeSub'],
        publishMode: 'skip',
      },
    );
    expect(res.status).to.equal(201);
    // 'adobe shoes' contains 'adobe' → branded (null alias was dropped, not used).
    expect(transport.createPromptsByIds).to.have.been.calledOnceWithExactly(WS, 'new-proj', ['adobe shoes'], [...STANDARD_IDS, TAG_IDS.typeBranded]);
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
        brandAliases: [{ name: 'ignored', regions: ['us'] }],
        publishMode: 'skip',
      },
    );
    expect(res.status).to.equal(201);
    // Needles = ['b','real'] (the '' element was coerced + filtered out).
    // 'real deal' contains 'real' → branded; 'plain text' → non-branded.
    expect(transport.createPromptsByIds).to.have.been.calledWithExactly(WS, 'new-proj', ['real deal'], [...STANDARD_IDS, TAG_IDS.typeBranded]);
    expect(transport.createPromptsByIds).to.have.been.calledWithExactly(WS, 'new-proj', ['plain text'], [...STANDARD_IDS, TAG_IDS.typeNonBranded]);
  });

  // The two guards below both fire when the tag tree, freshly provisioned, still
  // does not contain a name we asked for. That is not hypothetical: upstream tag
  // writes land in the project's DRAFT layer while a default read serves the LIVE
  // view, so a create can answer 201 and echo nothing while the re-read still
  // shows the level as it was. `createProjectTags` resolving `[]` over a level
  // that stays empty is exactly that sequence.
  //
  // Attaching a prompt to a guessed id is the failure these prevent:
  // `createPromptsByIds` is ATOMIC on an unresolvable id — it 500s and writes
  // nothing — so the handler must fail before it builds the call, not after.
  it('generateAndAttachPrompts: 502s when the standard prompt tag ids cannot be resolved', async () => {
    // The four roots exist; no closed value under any of them does, and the
    // create echoes nothing back. `provisionDimensionTree` fails closed, so the
    // handler never reaches a prompt write holding an unresolved id.
    const transport = makeTransport({
      listProjectTags: makeListProjectTagsStub({ '': dimensionTreeLevels()[''] }),
      createProjectTags: sinon.stub().resolves([]),
      getBrandTopics: sinon.stub().resolves([{ topic: 'T', volume: 10, prompts: ['plain text'] }]),
    });

    const err = await handleCreateMarketSubworkspace(
      transport,
      makeBrand(),
      PARENT,
      createBody,
      log,
      null,
      null,
      { generateTopics: true, publishMode: 'skip' },
    ).then(() => null, (e) => e);

    expect(err.status).to.equal(502);
    expect(err.message).to.match(/did not persist the tag\(s\)/);
    // Nothing was attached — the seam fails before any prompt write is built.
    expect(transport.createPromptsByIds).to.have.not.been.called;
  });

  it('generateAndAttachPrompts: 502s when the type vocabulary cannot be provisioned', async () => {
    // The `type` root exists but its level holds only `branded`, and the create
    // that would add `non-branded` echoes nothing. The prompt below classifies to
    // `non-branded`, so a tolerant seam would have written it untyped.
    const levels = dimensionTreeLevels();
    const typeLevel = levels[TAG_IDS.typeRoot].filter((t) => t.name === 'branded');
    const transport = makeTransport({
      listProjectTags: makeListProjectTagsStub({ ...levels, [TAG_IDS.typeRoot]: typeLevel }),
      createProjectTags: sinon.stub().resolves([]),
      getBrandTopics: sinon.stub().resolves([{ topic: 'T', volume: 10, prompts: ['plain text'] }]),
    });

    const err = await handleCreateMarketSubworkspace(
      transport,
      makeBrand(),
      PARENT,
      createBody,
      log,
      null,
      null,
      { generateTopics: true, publishMode: 'skip' },
    ).then(() => null, (e) => e);

    expect(err.status).to.equal(502);
    expect(err.message).to.match(/did not persist the tag\(s\): non-branded/);
    expect(transport.createPromptsByIds).to.have.not.been.called;
  });
});
