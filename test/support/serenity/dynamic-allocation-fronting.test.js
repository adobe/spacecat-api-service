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

/**
 * Handler-fronting + enforcement choke-point tests for dynamic AI resource allocation.
 *
 * Proves that the three subworkspace metered-write handlers front their metered ops through the
 * JIT top-up guard when the global kill-switch is ON, and are byte-for-byte no-ops when it is OFF.
 * The `choke point` describe is the regression guard the plan calls for: a future metered handler
 * added without fronting fails these assertions.
 */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  handleCreateMarketSubworkspace,
  handleUpdateModelsSubworkspace,
} from '../../../src/support/serenity/handlers/markets-subworkspace.js';
import { handleCreatePromptsSubworkspace } from '../../../src/support/serenity/handlers/prompts-subworkspace.js';
import { clearTagCache } from '../../../src/support/serenity/handlers/markets.js';
import { clearResourceLocks } from '../../../src/support/serenity/resource-lock.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'brand-1';
const WS = 'subworkspace-ws-1';
const PARENT = 'parent-ws';
const MASTER = 'parent-ws';
const log = { info: () => {}, error: () => {}, warn: () => {} };

const dimObj = (used, drafted, total) => ({ used, drafted, total });
const resources = (projects, prompts) => ({
  product_resources: { ai: { resources: { projects, prompts } } },
});
// Ample child: covered on both dims (no top-up needed). Ample master pool.
const COVERED_CHILD = resources(dimObj(0, 0, 50), dimObj(0, 0, 5000));
const AMPLE_MASTER = resources(dimObj(0, 0, 100), dimObj(0, 0, 8000));

function proj({ id = 'p-us-en', geo = 2840, lang = 'en' } = {}) {
  return {
    id,
    publish_status: 'live',
    updated_at: '2026-06-02T00:00:00Z',
    settings: { ai: { location: { id: geo }, language: { name: lang } } },
  };
}

function makeTransport(overrides = {}) {
  const getWorkspaceResources = sinon.stub();
  getWorkspaceResources.withArgs(WS).resolves(COVERED_CHILD);
  getWorkspaceResources.withArgs(MASTER).resolves(AMPLE_MASTER);
  return {
    listProjects: sinon.stub().resolves({ items: [] }),
    getInitStatus: sinon.stub().resolves({ initialized: true }),
    createProject: sinon.stub().resolves({ id: 'p-us-en' }),
    publishProject: sinon.stub().resolves(null),
    deleteProject: sinon.stub().resolves(null),
    listLanguages: sinon.stub().resolves({ items: [{ id: 'lang-en', name: 'English' }] }),
    transferWorkspaceResources: sinon.stub().resolves(null),
    getWorkspaceStatus: sinon.stub().resolves({ status: 'created' }),
    getWorkspaceResources,
    listPromptsByTags: sinon.stub().resolves({ items: [] }),
    createTaggedPrompts: sinon.stub().resolves({ ids: ['q1'] }),
    listAiModels: sinon.stub().resolves({ items: [] }),
    listGlobalAiModels: sinon.stub().resolves({ items: [] }),
    addAiModel: sinon.stub().resolves(null),
    deleteAiModelsByIds: sinon.stub().resolves(null),
    createProjectTags: sinon.stub().resolves(null),
    listBenchmarks: sinon.stub().resolves({ aio_benchmarks: [{ id: 'bench-1', main_brand: true }] }),
    resolveUrl: sinon.stub().callsFake(
      (url) => Promise.resolve({ domain: url, primary_url: url, is_valid: true }),
    ),
    createBrandUrls: sinon.stub().resolves({ ids: [], existing_count: 0 }),
    createBenchmarks: sinon.stub().resolves({ ids: ['bm-new'], existing_count: 0 }),
    ...overrides,
  };
}

function makeBrand() {
  let ws = WS;
  return {
    getId: () => BRAND,
    getName: () => 'Acme',
    getSemrushSubWorkspaceId: () => ws,
    setSemrushSubWorkspaceId: (v) => { ws = v; },
    save: sinon.stub().resolves(),
  };
}

const createBody = {
  market: 'us', languageCode: 'en', brandDomain: 'example.com', brandNames: ['B'], brandDisplayName: 'B',
};

describe('dynamic-allocation fronting — create-market', () => {
  afterEach(() => {
    sinon.restore();
    clearTagCache();
    clearResourceLocks();
  });

  it('ON: fronts the project seam before createProject and the publish seam before publishProject', async () => {
    const t = makeTransport();
    await handleCreateMarketSubworkspace(t, makeBrand(), PARENT, createBody, log, null, null, {
      dynamicAllocation: true, masterId: MASTER, publishMode: 'require',
    });
    // Child headroom read happened (guard is live), and BEFORE the metered ops it fronts.
    expect(t.getWorkspaceResources).to.have.been.calledWith(WS);
    expect(t.getWorkspaceResources.calledBefore(t.createProject)).to.equal(true);
    expect(t.getWorkspaceResources.calledBefore(t.publishProject)).to.equal(true);
  });

  it('ON + covered child: NO transfer at all — proves the flat re-grant carve is skipped', async () => {
    const t = makeTransport();
    await handleCreateMarketSubworkspace(t, makeBrand(), PARENT, createBody, log, null, null, {
      dynamicAllocation: true, masterId: MASTER, publishMode: 'require',
    });
    // With the flag ON, ensureSubworkspace skips the flat resourceAllocation re-grant AND the
    // covered child needs no JIT top-up → zero transfers.
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('OFF: byte-for-byte — the flat re-grant transfer still runs and NO headroom read happens', async () => {
    const t = makeTransport();
    await handleCreateMarketSubworkspace(t, makeBrand(), PARENT, createBody, log, null, null, {
      dynamicAllocation: false, masterId: MASTER, publishMode: 'require',
    });
    // Flag OFF: the pre-PR flat re-grant transfer runs, and the guard is a genuine no-op.
    expect(t.transferWorkspaceResources).to.have.been.called;
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });

  it('ON + short child: tops up the project dimension before createProject', async () => {
    const getWorkspaceResources = sinon.stub();
    getWorkspaceResources.withArgs(WS).resolves(resources(dimObj(0, 0, 0), dimObj(0, 0, 5000)));
    getWorkspaceResources.withArgs(MASTER).resolves(AMPLE_MASTER);
    const t = makeTransport({ getWorkspaceResources });
    await handleCreateMarketSubworkspace(t, makeBrand(), PARENT, createBody, log, null, null, {
      dynamicAllocation: true, masterId: MASTER, publishMode: 'require',
    });
    // A projects top-up (0 → 1 block) fired, and before the project was created.
    expect(t.transferWorkspaceResources).to.have.been.called;
    expect(t.transferWorkspaceResources.calledBefore(t.createProject)).to.equal(true);
  });
});

describe('dynamic-allocation fronting — create-prompts', () => {
  afterEach(() => {
    sinon.restore();
    clearResourceLocks();
  });

  it('ON: fronts the publish seam with a child headroom read before publishProject', async () => {
    const t = makeTransport({ listProjects: sinon.stub().resolves({ items: [proj()] }) });
    await handleCreatePromptsSubworkspace(
      t,
      WS,
      {
        prompts: [{
          text: 'q', geoTargetId: 2840, languageCode: 'en', tags: [],
        }],
      },
      log,
      undefined, // classifyPromptType (tag-dimension path — not under test here)
      { dynamicAllocation: true, masterId: MASTER },
    );
    expect(t.getWorkspaceResources).to.have.been.calledWith(WS);
    expect(t.getWorkspaceResources.calledBefore(t.publishProject)).to.equal(true);
  });

  it('OFF: byte-for-byte — no headroom read', async () => {
    const t = makeTransport({ listProjects: sinon.stub().resolves({ items: [proj()] }) });
    await handleCreatePromptsSubworkspace(
      t,
      WS,
      {
        prompts: [{
          text: 'q', geoTargetId: 2840, languageCode: 'en', tags: [],
        }],
      },
      log,
      undefined, // classifyPromptType
      { dynamicAllocation: false, masterId: MASTER },
    );
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });
});

describe('dynamic-allocation fronting — update-models', () => {
  afterEach(() => {
    sinon.restore();
    clearResourceLocks();
  });

  it('ON: sizes the prompt re-meter from publishedTexts × Δmodels and fronts before the sync', async () => {
    // Current model m1 attached; request adds m2 (Δ=1). 2 published prompts → need.prompts = 2.
    const listAiModels = sinon.stub().resolves({ items: [{ id: 'a1', model: { id: 'm1', key: 'k1' } }] });
    const listPromptsByTags = sinon.stub().resolves({ items: [{ id: 'q1' }, { id: 'q2' }] });
    // Child short on prompts so the 2-unit need forces a visible top-up.
    const getWorkspaceResources = sinon.stub();
    getWorkspaceResources.withArgs(WS).resolves(resources(dimObj(0, 0, 50), dimObj(0, 0, 0)));
    getWorkspaceResources.withArgs(MASTER).resolves(AMPLE_MASTER);
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [proj()] }),
      listAiModels,
      listPromptsByTags,
      getWorkspaceResources,
    });
    await handleUpdateModelsSubworkspace(
      t,
      WS,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1', 'm2'] },
      log,
      { dynamicAllocation: true, masterId: MASTER },
    );
    expect(t.getWorkspaceResources).to.have.been.calledWith(WS);
    // Top-up ran before the model add/publish (headroom precedes the metered change).
    expect(t.getWorkspaceResources.calledBefore(t.addAiModel)).to.equal(true);
    expect(t.transferWorkspaceResources).to.have.been.called;
  });

  it('ON + swap (drop 1, add 1 → net delta 0): ZERO resource transfers (no over-grant)', async () => {
    // Current [m1]; request [m2] — a swap. finalCount 1 − currentCount 1 = net 0. Gross-add sizing
    // would top up publishedTexts × 1; net-delta sizing must transfer nothing.
    const listAiModels = sinon.stub().resolves({ items: [{ id: 'a1', model: { id: 'm1', key: 'k1' } }] });
    const listPromptsByTags = sinon.stub().resolves({ items: [{ id: 'q1' }, { id: 'q2' }] });
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [proj()] }),
      listAiModels,
      listPromptsByTags,
    });
    await handleUpdateModelsSubworkspace(
      t,
      WS,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['m2'] },
      log,
      { dynamicAllocation: true, masterId: MASTER },
    );
    // No top-up (net 0) and no release (net not < 0) → zero resource transfers.
    expect(t.transferWorkspaceResources).to.not.have.been.called;
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });

  it('ON + pure removal (net delta < 0): NO top-up, ONE release AFTER the publish', async () => {
    // Current [m1, m2]; request [m1] — net −1. No top-up; after the sync publishes, release the
    // freed units (child prompts used 100 / total 500 → release lowers total to 100).
    const listAiModels = sinon.stub().resolves({
      items: [{ id: 'a1', model: { id: 'm1', key: 'k1' } }, { id: 'a2', model: { id: 'm2', key: 'k2' } }],
    });
    const getWorkspaceResources = sinon.stub();
    getWorkspaceResources.withArgs(WS).resolves(resources(dimObj(1, 0, 5), dimObj(100, 0, 500)));
    getWorkspaceResources.withArgs(MASTER).resolves(AMPLE_MASTER);
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [proj()] }),
      listAiModels,
      getWorkspaceResources,
    });
    await handleUpdateModelsSubworkspace(
      t,
      WS,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] },
      log,
      { dynamicAllocation: true, masterId: MASTER },
    );
    // Exactly one transfer (the release), and it ran AFTER the publish (publish → read → release).
    expect(t.transferWorkspaceResources).to.have.been.calledOnce;
    expect(t.publishProject.calledBefore(t.transferWorkspaceResources)).to.equal(true);
    expect(t.getWorkspaceResources.calledAfter(t.publishProject)).to.equal(true);
  });

  it('ON but no models added (net-zero Δ): no headroom read', async () => {
    const listAiModels = sinon.stub().resolves({ items: [{ id: 'a1', model: { id: 'm1', key: 'k1' } }] });
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [proj()] }),
      listAiModels,
    });
    await handleUpdateModelsSubworkspace(
      t,
      WS,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] },
      log,
      { dynamicAllocation: true, masterId: MASTER },
    );
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });

  it('OFF: byte-for-byte — no model list read for metering, no headroom read', async () => {
    const t = makeTransport({ listProjects: sinon.stub().resolves({ items: [proj()] }) });
    await handleUpdateModelsSubworkspace(
      t,
      WS,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1', 'm2'] },
      log,
      { dynamicAllocation: false, masterId: MASTER },
    );
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });
});

describe('dynamic-allocation — enforcement choke point', () => {
  afterEach(() => {
    sinon.restore();
    clearTagCache();
    clearResourceLocks();
  });

  // Every subworkspace metered-write path MUST front through the headroom guard. If a new metered
  // handler is added without fronting, add it here and it will fail until it reads child headroom.
  const meteredPaths = [
    {
      name: 'handleCreateMarketSubworkspace',
      // Empty listing → a fresh project is created (the project + publish seams both front).
      makeT: () => makeTransport({ listProjects: sinon.stub().resolves({ items: [] }) }),
      run: (t) => handleCreateMarketSubworkspace(
        t,
        makeBrand(),
        PARENT,
        createBody,
        log,
        null,
        null,
        { dynamicAllocation: true, masterId: MASTER, publishMode: 'require' },
      ),
    },
    {
      name: 'handleCreatePromptsSubworkspace',
      makeT: () => makeTransport({ listProjects: sinon.stub().resolves({ items: [proj()] }) }),
      run: (t) => handleCreatePromptsSubworkspace(
        t,
        WS,
        {
          prompts: [{
            text: 'q', geoTargetId: 2840, languageCode: 'en', tags: [],
          }],
        },
        log,
        undefined, // classifyPromptType
        { dynamicAllocation: true, masterId: MASTER },
      ),
    },
    {
      name: 'handleUpdateModelsSubworkspace',
      makeT: () => makeTransport({
        listProjects: sinon.stub().resolves({ items: [proj()] }),
        listAiModels: sinon.stub().resolves({ items: [] }),
      }),
      run: (t) => handleUpdateModelsSubworkspace(
        t,
        WS,
        { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1', 'm2'] },
        log,
        { dynamicAllocation: true, masterId: MASTER },
      ),
    },
  ];

  meteredPaths.forEach(({ name, makeT, run }) => {
    it(`${name} is fronted — reads child headroom when dynamic allocation is ON`, async () => {
      const t = makeT();
      await run(t);
      expect(t.getWorkspaceResources, `${name} must front its metered op through the headroom guard`)
        .to.have.been.calledWith(WS);
    });
  });
});
