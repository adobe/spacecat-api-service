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
  handleDeleteMarketSubworkspace,
} from '../../../src/support/serenity/handlers/markets-subworkspace.js';
import { handleCreatePromptsSubworkspace } from '../../../src/support/serenity/handlers/prompts-subworkspace.js';
import { clearTagCache } from '../../../src/support/serenity/handlers/markets.js';
import { clearResourceLocks } from '../../../src/support/serenity/resource-lock.js';
import { PROJECT_BLOCK, PROMPT_BLOCK } from '../../../src/support/serenity/resource-manager.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';
import { ERROR_CODES } from '../../../src/support/serenity/errors.js';
import { makeProvisioningTransportStubs } from './fixtures/tag-tree.js';

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
  // create-market provisions the dimension-root tag tree (provisionDimensionTree) before its
  // metered ops; this test suite cares about JIT fronting, not tag-tree logic, so start from an
  // empty project and let provisioning actually run against a stub that folds writes back in.
  const { listProjectTags, createProjectTags } = makeProvisioningTransportStubs();
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
    createPromptsByIds: sinon.stub().resolves({ items: [{ id: 'prompt-1' }] }),
    listAiModels: sinon.stub().resolves({ items: [] }),
    listGlobalAiModels: sinon.stub().resolves({ items: [] }),
    addAiModel: sinon.stub().resolves(null),
    deleteAiModelsByIds: sinon.stub().resolves(null),
    listProjectTags,
    createProjectTags,
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
      dynamicAllocation: true, parentWorkspaceId: MASTER, publishMode: 'require',
    });
    // Child headroom read happened (guard is live), and BEFORE the metered ops it fronts.
    expect(t.getWorkspaceResources).to.have.been.calledWith(WS);
    expect(t.getWorkspaceResources.calledBefore(t.createProject)).to.equal(true);
    expect(t.getWorkspaceResources.calledBefore(t.publishProject)).to.equal(true);
  });

  it('ON + covered child: NO transfer at all — proves the flat re-grant carve is skipped', async () => {
    const t = makeTransport();
    await handleCreateMarketSubworkspace(t, makeBrand(), PARENT, createBody, log, null, null, {
      dynamicAllocation: true, parentWorkspaceId: MASTER, publishMode: 'require',
    });
    // With the flag ON, ensureSubworkspace skips the flat resourceAllocation re-grant AND the
    // covered child needs no JIT top-up → zero transfers.
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('OFF: byte-for-byte — the flat re-grant transfer still runs and NO headroom read happens', async () => {
    const t = makeTransport();
    await handleCreateMarketSubworkspace(t, makeBrand(), PARENT, createBody, log, null, null, {
      dynamicAllocation: false, parentWorkspaceId: MASTER, publishMode: 'require',
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
      dynamicAllocation: true, parentWorkspaceId: MASTER, publishMode: 'require',
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
          text: 'q', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
        }],
      },
      log,
      undefined, // classifyPromptType (tag-dimension path — not under test here)
      { dynamicAllocation: true, parentWorkspaceId: MASTER },
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
          text: 'q', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
        }],
      },
      log,
      undefined, // classifyPromptType
      { dynamicAllocation: false, parentWorkspaceId: MASTER },
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
      { dynamicAllocation: true, parentWorkspaceId: MASTER },
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
      { dynamicAllocation: true, parentWorkspaceId: MASTER },
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
      { dynamicAllocation: true, parentWorkspaceId: MASTER },
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
      { dynamicAllocation: true, parentWorkspaceId: MASTER },
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
      { dynamicAllocation: false, parentWorkspaceId: MASTER },
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
        { dynamicAllocation: true, parentWorkspaceId: MASTER, publishMode: 'require' },
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
            text: 'q', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
          }],
        },
        log,
        undefined, // classifyPromptType
        { dynamicAllocation: true, parentWorkspaceId: MASTER },
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
        { dynamicAllocation: true, parentWorkspaceId: MASTER },
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

// LLMO-6190 item 3 — release-on-delete. Child at (used=1, total=5) projects / (used=50,
// total=1000) prompts so a release actually has surplus to hand back (target = max(floor,
// roundUpToBlock(used)), BELOW the current total on both dims — a real, observable release).
describe('dynamic-allocation fronting — delete-market release', () => {
  const RELEASABLE_CHILD = resources(dimObj(1, 0, 5), dimObj(50, 0, 1000));

  function makeDeleteTransport(overrides = {}) {
    const getWorkspaceResources = sinon.stub().resolves(RELEASABLE_CHILD);
    return {
      listProjects: sinon.stub().resolves({ items: [proj()] }),
      deleteProject: sinon.stub().resolves(null),
      transferWorkspaceResources: sinon.stub().resolves(null),
      getWorkspaceStatus: sinon.stub().resolves({ status: 'created' }),
      getWorkspaceResources,
      ...overrides,
    };
  }

  afterEach(() => {
    sinon.restore();
    clearResourceLocks();
  });

  it('OFF: releaseAiSurplus is never invoked — zero release-path transport calls', async () => {
    const t = makeDeleteTransport();
    const res = await handleDeleteMarketSubworkspace(t, WS, 2840, 'en', log, {
      dynamicAllocation: false,
    });
    // deletedSiteId is null here: these tests omit `dataAccess`, so the handler
    // never reads a mapping row (LLMO-6405 R12 delete-cleanup contract).
    expect(res).to.deep.equal({ status: 204, deletedSiteId: null });
    expect(t.getWorkspaceResources).to.not.have.been.called;
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('ON + valid ids: releases with failFast (one transfer, no settle poll) at the pinned floor', async () => {
    const t = makeDeleteTransport();
    const res = await handleDeleteMarketSubworkspace(t, WS, 2840, 'en', log, {
      dynamicAllocation: true,
    });
    // deletedSiteId is null here: these tests omit `dataAccess`, so the handler
    // never reads a mapping row (LLMO-6405 R12 delete-cleanup contract).
    expect(res).to.deep.equal({ status: 204, deletedSiteId: null });
    expect(t.getWorkspaceResources).to.have.been.calledWith(WS);
    // failFast: ONE transfer, no settle-poll status check.
    expect(t.transferWorkspaceResources).to.have.been.calledOnce;
    expect(t.getWorkspaceStatus).to.not.have.been.called;
    // The pinned floor (PROJECT_BLOCK / PROMPT_BLOCK) is what releaseAiSurplus lowers the surplus
    // to — assert the LITERAL transfer payload, not just "it was called".
    expect(t.transferWorkspaceResources).to.have.been.calledWith(WS, {
      ai: { projects: PROJECT_BLOCK, prompts: PROMPT_BLOCK },
    });
  });

  it('ON + upstream deleteProject 404s (already gone): release still fires (project is confirmed gone either way)', async () => {
    const t = makeDeleteTransport({
      deleteProject: sinon.stub().rejects(new SerenityTransportError(404, 'gone', null)),
    });
    const res = await handleDeleteMarketSubworkspace(t, WS, 2840, 'en', log, {
      dynamicAllocation: true,
    });
    // deletedSiteId is null here: these tests omit `dataAccess`, so the handler
    // never reads a mapping row (LLMO-6405 R12 delete-cleanup contract).
    expect(res).to.deep.equal({ status: 204, deletedSiteId: null });
    expect(t.transferWorkspaceResources).to.have.been.calledOnce;
  });

  it('ON + project never resolved (no market for this slice): NO release — nothing was deleted', async () => {
    const t = makeDeleteTransport({ listProjects: sinon.stub().resolves({ items: [] }) });
    const res = await handleDeleteMarketSubworkspace(t, WS, 2840, 'en', log, {
      dynamicAllocation: true,
    });
    // deletedSiteId is null here: these tests omit `dataAccess`, so the handler
    // never reads a mapping row (LLMO-6405 R12 delete-cleanup contract).
    expect(res).to.deep.equal({ status: 204, deletedSiteId: null });
    expect(t.getWorkspaceResources).to.not.have.been.called;
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('ON + release hits an EXPECTED (best-effort) failure: DELETE still resolves 204 (releaseAiSurplus swallows it internally)', async () => {
    const t = makeDeleteTransport({
      transferWorkspaceResources: sinon.stub().rejects(new SerenityTransportError(503, 'busy', null)),
    });
    const res = await handleDeleteMarketSubworkspace(t, WS, 2840, 'en', log, {
      dynamicAllocation: true,
    });
    // deletedSiteId is null here: these tests omit `dataAccess`, so the handler
    // never reads a mapping row (LLMO-6405 R12 delete-cleanup contract).
    expect(res).to.deep.equal({ status: 204, deletedSiteId: null });
  });

  it('ON + release hits a genuinely UNEXPECTED error: propagates, matching the model-update seam\'s identical (uncaught) release call — deliberately not special-cased here', async () => {
    // releaseAiSurplus itself re-throws non-transport/non-ErrorWithStatusCode failures (so real
    // bugs surface in monitoring rather than a silent warn) — see resource-manager.js. The
    // model-removal seam (handleUpdateModelsSubworkspace) awaits releaseAiSurplus with no
    // try/catch either, so this handler intentionally matches that same shape rather than adding
    // asymmetric protection here.
    const boom = new TypeError('unexpected bug');
    const t = makeDeleteTransport({
      transferWorkspaceResources: sinon.stub().rejects(boom),
    });
    await expect(
      handleDeleteMarketSubworkspace(t, WS, 2840, 'en', log, { dynamicAllocation: true }),
    ).to.be.rejectedWith(TypeError, 'unexpected bug');
  });
});

// LLMO-6190 item 4 — retryOnQuota wiring at the three metered-publish call sites. Each fixture
// makes publishProject 405 ONCE (a disguised metered-quota rejection) then succeed, proving the
// bounded recovery cycle (re-read + top-up + retry) runs end-to-end through the real handler, not
// just the guard in isolation (covered separately in dynamic-allocation-active.test.js).
describe('dynamic-allocation fronting — retryOnQuota wiring', () => {
  afterEach(() => {
    sinon.restore();
    clearTagCache();
    clearResourceLocks();
  });

  // isMeteredQuota keys on body SHAPE (live-verified, LLMO-6190): a bare string/HTML body is the
  // disguised quota rejection; a JSON object is a genuine app-level error. Mirror the real pinned
  // fixture here, not a JSON guess.
  const quota405 = () => new SerenityTransportError(405, 'publish failed: 405', '<html>405 Not Allowed</html>');

  function publishFailsOnceThenSucceeds() {
    const publishProject = sinon.stub();
    publishProject.onFirstCall().rejects(quota405());
    publishProject.onSecondCall().resolves(null);
    return publishProject;
  }

  it('create-market (require mode): one 405 then a bounded top-up+retry succeeds', async () => {
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [] }),
      publishProject: publishFailsOnceThenSucceeds(),
    });
    const res = await handleCreateMarketSubworkspace(
      t,
      makeBrand(),
      PARENT,
      createBody,
      log,
      null,
      null,
      { dynamicAllocation: true, parentWorkspaceId: MASTER, publishMode: 'require' },
    );
    expect(res.status).to.equal(201);
    expect(res.body.published).to.equal(true);
    expect(t.publishProject).to.have.been.calledTwice;
  });

  it('create-prompts: one 405 on a project publish then a bounded top-up+retry succeeds (per-project, not thrown)', async () => {
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [proj()] }),
      publishProject: publishFailsOnceThenSucceeds(),
    });
    const result = await handleCreatePromptsSubworkspace(
      t,
      WS,
      {
        prompts: [{
          text: 'q', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
        }],
      },
      log,
      undefined,
      { dynamicAllocation: true, parentWorkspaceId: MASTER },
    );
    // The retry succeeded, so the create is NOT recorded as a publish failure.
    expect(result.failed).to.deep.equal([]);
    expect(t.publishProject).to.have.been.calledTwice;
  });

  it('update-models: a net-add sync publish 405s once then a bounded top-up+retry succeeds', async () => {
    const listAiModels = sinon.stub().resolves({ items: [{ id: 'a1', model: { id: 'm1', key: 'k1' } }] });
    const listPromptsByTags = sinon.stub().resolves({ items: [{ id: 'q1' }, { id: 'q2' }] });
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [proj()] }),
      listAiModels,
      listPromptsByTags,
      publishProject: publishFailsOnceThenSucceeds(),
    });
    await handleUpdateModelsSubworkspace(
      t,
      WS,
      { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1', 'm2'] },
      log,
      { dynamicAllocation: true, parentWorkspaceId: MASTER },
    );
    expect(t.publishProject).to.have.been.calledTwice;
  });

  // serenity-docs#72 §2/§4.1 — case 1 (brand carve exhausted, allocator OFF, production today):
  // the raw 405 is classified into the stable `quotaExceeded` 409 token rather than propagating
  // unclassified (which mapError's generic branch would otherwise flatten into a 502).
  it('create-market (require mode), flag OFF: a 405 is NOT retried, and is classified as quotaExceeded', async () => {
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [] }),
      publishProject: sinon.stub().rejects(quota405()),
    });
    const opts = { dynamicAllocation: false, parentWorkspaceId: MASTER, publishMode: 'require' };
    const p = handleCreateMarketSubworkspace(
      t,
      makeBrand(),
      PARENT,
      createBody,
      log,
      null,
      null,
      opts,
    );
    const err = await p.then(() => null, (e) => e);
    expect(err).to.not.equal(null);
    expect(err).to.not.be.instanceOf(SerenityTransportError);
    expect(err.status).to.equal(409);
    expect(err.code).to.equal(ERROR_CODES.QUOTA_EXCEEDED);
    expect(t.publishProject).to.have.been.calledOnce;
  });

  // LLMO-6190 follow-up (live-verified ~9s Semrush gateway write-enforcement lag): the three
  // metered WRITE call sites below (createProject, createPromptsByIds, createOnePrompt) are now
  // also fronted by `headroom.retryOnQuota`, not just publish. These tests prove the wrapping is
  // wired at each site — the poll-retry's own timing/backoff/deadline mechanics are unit-tested
  // with injectable fake timers in dynamic-allocation-active.test.js; every case here resolves on
  // the FIRST poll attempt (no real sleep triggered) so the suite stays fast.

  it('create-market: createProject 405s once then a bounded top-up+retry succeeds', async () => {
    const createProject = sinon.stub();
    createProject.onFirstCall().rejects(quota405());
    createProject.onSecondCall().resolves({ id: 'p-us-en' });
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [] }),
      createProject,
    });
    const res = await handleCreateMarketSubworkspace(
      t,
      makeBrand(),
      PARENT,
      createBody,
      log,
      null,
      null,
      { dynamicAllocation: true, parentWorkspaceId: MASTER, publishMode: 'require' },
    );
    expect(res.status).to.equal(201);
    expect(t.createProject).to.have.been.calledTwice;
  });

  it('create-market with generateTopics: createPromptsByIds 405s once then a bounded top-up+retry succeeds', async () => {
    const createPromptsByIds = sinon.stub();
    createPromptsByIds.onFirstCall().rejects(quota405());
    createPromptsByIds.onSecondCall().resolves({ items: [{ id: 'prompt-1' }] });
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [] }),
      createPromptsByIds,
      getBrandTopics: sinon.stub().resolves({
        items: [{ topic: 't1', volume: 10, prompts: ['what is Acme?'] }],
      }),
    });
    const res = await handleCreateMarketSubworkspace(
      t,
      makeBrand(),
      PARENT,
      createBody,
      log,
      null,
      null,
      {
        dynamicAllocation: true,
        parentWorkspaceId: MASTER,
        publishMode: 'require',
        generateTopics: true,
      },
    );
    expect(res.status).to.equal(201);
    expect(t.createPromptsByIds).to.have.been.calledTwice;
  });

  it('create-prompts, concurrent batch: each item independently recovers from its own 405 — per-item-keyed stub, not a flat call-index', async () => {
    // Per-item Map keyed on the prompt text (round-2 QA review): a flat `.onCall()`/shared counter
    // is nondeterministic under real concurrency (item B's first call can land as the 2nd call
    // overall and skip its own retry path). Keying on identity guarantees EVERY item's first
    // attempt 405s once and its second succeeds, regardless of interleaving.
    const attemptsByText = new Map();
    const createPromptsByIds = sinon.stub().callsFake(async (wsId, projectId, texts) => {
      const key = texts[0];
      const attempt = (attemptsByText.get(key) ?? 0) + 1;
      attemptsByText.set(key, attempt);
      if (attempt === 1) {
        throw quota405();
      }
      return { items: [{ id: `prompt-${key}` }] };
    });
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [proj()] }),
      createPromptsByIds,
    });
    const result = await handleCreatePromptsSubworkspace(
      t,
      WS,
      {
        prompts: [
          {
            text: 'q1', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
          },
          {
            text: 'q2', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
          },
          {
            text: 'q3', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
          },
        ],
      },
      log,
      undefined,
      { dynamicAllocation: true, parentWorkspaceId: MASTER },
    );
    expect(result.failed).to.deep.equal([]);
    expect(result.created).to.have.lengthOf(3);
    expect([...attemptsByText.values()]).to.deep.equal([2, 2, 2]);
  });

  it('create-prompts, mixed outcome in a concurrent batch: one item recovers, a sibling gets a genuinely non-retryable error, neither leaks into the other', async () => {
    const nonRetryable = new SerenityTransportError(500, 'boom', { message: 'internal error' });
    // Deterministic per-key state — 'recovers' 405s once then succeeds, 'fails-hard' always throws
    // a non-quota error that must never be retried.
    let recoversAttempt = 0;
    const stub = sinon.stub().callsFake(async (wsId, projectId, texts) => {
      const [text] = texts;
      if (text === 'recovers') {
        recoversAttempt += 1;
        if (recoversAttempt === 1) {
          throw quota405();
        }
        return { items: [{ id: 'prompt-recovers' }] };
      }
      throw nonRetryable;
    });
    const t = makeTransport({
      listProjects: sinon.stub().resolves({ items: [proj()] }),
      createPromptsByIds: stub,
    });
    const result = await handleCreatePromptsSubworkspace(
      t,
      WS,
      {
        prompts: [
          {
            text: 'recovers', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
          },
          {
            text: 'fails-hard', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
          },
        ],
      },
      log,
      undefined,
      { dynamicAllocation: true, parentWorkspaceId: MASTER },
    );
    expect(result.created).to.have.lengthOf(1);
    expect(result.created[0].text).to.equal('recovers');
    expect(result.failed).to.have.lengthOf(1);
    expect(result.failed[0].text).to.equal('fails-hard');
    expect(result.failed[0].status).to.equal(500);
  });
});
