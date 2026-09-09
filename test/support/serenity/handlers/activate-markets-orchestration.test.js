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
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);
use(chaiAsPromised);

const BRAND_ID = 'brand-1';
const ORG_ID = 'org-1';
const PARENT_WS = 'parent-ws-1';
const WORKSPACE_ID = 'sub-ws-1';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

describe('handlers/activate-markets-orchestration.js (PR-C, LLMO-7352/LLMO-7418)', () => {
  let handleCreateMarketSubworkspaceStub;
  let ensureSubworkspaceStub;
  let ensureMarketSiteStub;
  let linkSiteToLiveRowsStub;
  let getBrandAliasesStub;
  let getBrandUrlSourcesStub;
  let getBrandCompetitorsStub;
  let updateBrandStub;
  let resolveDefaultModelIdsStub;
  let brandFindByIdStub;
  let dataAccess;
  let log;

  beforeEach(() => {
    handleCreateMarketSubworkspaceStub = sinon.stub().resolves({ status: 201, body: {} });
    ensureSubworkspaceStub = sinon.stub().resolves(WORKSPACE_ID);
    ensureMarketSiteStub = sinon.stub().resolves('site-uuid-1');
    linkSiteToLiveRowsStub = sinon.stub().resolves();
    getBrandAliasesStub = sinon.stub().resolves([]);
    getBrandUrlSourcesStub = sinon.stub()
      .resolves({ urls: [], socialAccounts: [], earnedContent: [] });
    getBrandCompetitorsStub = sinon.stub().resolves([]);
    updateBrandStub = sinon.stub().resolves({ id: BRAND_ID, status: 'active' });
    resolveDefaultModelIdsStub = sinon.stub().resolves([]);
    brandFindByIdStub = sinon.stub().resolves({ getId: () => BRAND_ID, getName: () => 'Acme' });
    dataAccess = {
      Brand: { findById: brandFindByIdStub },
      BrandSemrushProject: { name: 'BrandSemrushProject' },
      services: { postgrestClient: {} },
    };
    log = fakeLog();
  });

  async function load() {
    return esmock('../../../../src/support/serenity/handlers/activate-markets-orchestration.js', {
      '../../../../src/support/serenity/handlers/markets-subworkspace.js': {
        handleCreateMarketSubworkspace: handleCreateMarketSubworkspaceStub,
      },
      '../../../../src/support/serenity/workspace-lifecycle.js': {
        ensureSubworkspace: ensureSubworkspaceStub,
      },
      '../../../../src/support/serenity/site-linkage.js': {
        ensureMarketSite: ensureMarketSiteStub,
      },
      '../../../../src/support/serenity/mapping-rows.js': {
        linkSiteToLiveRows: linkSiteToLiveRowsStub,
      },
      '../../../../src/support/brands-storage.js': {
        getBrandAliases: getBrandAliasesStub,
        getBrandUrlSources: getBrandUrlSourcesStub,
        getBrandCompetitors: getBrandCompetitorsStub,
        updateBrand: updateBrandStub,
      },
      '../../../../src/support/serenity/default-models.js': {
        resolveDefaultModelIds: resolveDefaultModelIdsStub,
      },
    });
  }

  function baseParams(overrides = {}) {
    return {
      dataAccess,
      env: {},
      orgId: ORG_ID,
      transport: { name: 'transport' },
      brandUuid: BRAND_ID,
      parentWorkspaceId: PARENT_WS,
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en' }],
      },
      log,
      ...overrides,
    };
  }

  it('throws 500 when Brand data-access is unavailable', async () => {
    const { orchestrateActivateMarkets } = await load();
    await expect(orchestrateActivateMarkets(baseParams({ dataAccess: {} })))
      .to.be.rejectedWith('Brand data-access not available');
  });

  it('throws 404 when the brand does not exist', async () => {
    brandFindByIdStub.resolves(null);
    const { orchestrateActivateMarkets } = await load();
    await expect(orchestrateActivateMarkets(baseParams()))
      .to.be.rejectedWith(`Brand not found: ${BRAND_ID}`);
  });

  it('throws 400 when the markets array exceeds the cap (and does not provision)', async () => {
    const markets = Array.from({ length: 51 }, (_, i) => ({ market: 'us', languageCode: `l${i}` }));
    const { orchestrateActivateMarkets } = await load();

    await expect(orchestrateActivateMarkets(baseParams({
      requestBody: { brandDomain: 'x.com', brandNames: ['X'], markets },
    }))).to.be.rejectedWith('markets must not exceed 50 entries');
    expect(handleCreateMarketSubworkspaceStub).to.not.have.been.called;
  });

  it('threads the Brand collection into ensureSubworkspace so the claim filter can run', async () => {
    const { orchestrateActivateMarkets } = await load();

    await orchestrateActivateMarkets(baseParams());

    expect(ensureSubworkspaceStub).to.have.been.calledOnce;
    expect(ensureSubworkspaceStub.firstCall.args[6].brandCollection).to.equal(dataAccess.Brand);
  });

  it('ensures the subworkspace ONCE for the batch and creates each market against it', async () => {
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
      },
    }));

    expect(result.status).to.equal(200);
    // ensured exactly once for the whole batch — not per market.
    expect(ensureSubworkspaceStub).to.have.been.calledOnce;
    expect(handleCreateMarketSubworkspaceStub).to.have.been.calledTwice;
    // each market create receives the pre-resolved workspace id (6th arg) so it
    // skips its own ensure.
    expect(handleCreateMarketSubworkspaceStub.firstCall.args[5]).to.equal(WORKSPACE_ID);
    expect(handleCreateMarketSubworkspaceStub.secondCall.args[5]).to.equal(WORKSPACE_ID);
    // Status flip + primary site persist via updateBrand.
    expect(updateBrandStub).to.have.been.calledOnce;
    expect(updateBrandStub.firstCall.args[0].organizationId).to.equal(ORG_ID);
    expect(updateBrandStub.firstCall.args[0].updates).to.include({ status: 'active' });
  });

  it('skips ensureSubworkspace and uses the pre-resolved workspace id when supplied (async chain)', async () => {
    const { orchestrateActivateMarkets } = await load();

    await orchestrateActivateMarkets(baseParams({ preResolvedWorkspaceId: 'already-ready-ws' }));

    expect(ensureSubworkspaceStub).to.not.have.been.called;
    expect(handleCreateMarketSubworkspaceStub.firstCall.args[5]).to.equal('already-ready-ws');
  });

  it('mirrors the brand domain as a Site once (not per market) when any market goes live', async () => {
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
      },
    }));

    expect(result.status).to.equal(200);
    // All markets share the brand domain, so exactly one ensure for two markets.
    expect(ensureMarketSiteStub).to.have.been.calledOnce;
    const [ctxArg, opts] = ensureMarketSiteStub.firstCall.args;
    expect(ctxArg).to.deep.equal({ dataAccess });
    expect(opts).to.include({ organizationId: ORG_ID, brandId: BRAND_ID, domain: 'x.com' });
  });

  it('passes a body-supplied market\'s modelIds into the options arg (LLMs applied at activation)', async () => {
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en', modelIds: ['chatgpt', 'perplexity'] }],
      },
    }));

    expect(result.status).to.equal(200);
    // modelIds are read from the OPTIONS arg (index 7), NOT the body (index 3) —
    // handleCreateMarketSubworkspace destructures them from options.
    const options = handleCreateMarketSubworkspaceStub.firstCall.args[7];
    expect(options.modelIds).to.deep.equal(['chatgpt', 'perplexity']);
    // models present but no prompts → real units → must publish.
    expect(options.publishMode).to.equal('require');
  });

  it('does NOT mirror a Site (or flip status) when no market goes live', async () => {
    handleCreateMarketSubworkspaceStub.resolves({ status: 502, body: { error: 'serenityUpstreamError' } });
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams());

    // A market failed → allMarketsLive false → no site mirror. 207 Multi-Status.
    expect(result.status).to.equal(207);
    expect(result.body.status).to.equal('active');
    expect(ensureMarketSiteStub).to.not.have.been.called;
    expect(updateBrandStub).to.not.have.been.called;
  });

  it('reads the brand aliases once and applies them to every market', async () => {
    getBrandAliasesStub.resolves(['Acme Inc']);
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
      },
    }));

    expect(result.status).to.equal(200);
    // Read once for the whole batch, not per market.
    expect(getBrandAliasesStub).to.have.been.calledOnceWith(BRAND_ID);
    const expectedOpts = {
      modelIds: [],
      generateTopics: false,
      topicCap: 0,
      publishMode: 'require',
      brandAliases: ['Acme Inc'],
      brandUrlSources: { urls: [], socialAccounts: [], earnedContent: [] },
      competitors: [],
      env: {},
      dataAccess: { BrandSemrushProject: dataAccess.BrandSemrushProject },
      orgId: ORG_ID,
      callerId: 'unknown',
    };
    const { firstCall, secondCall } = handleCreateMarketSubworkspaceStub;
    // writeDeadline is computed ONCE at entry, so every market in the batch
    // receives the SAME dynamic epoch-ms deadline — assert that, then drop it
    // before comparing the rest of the options bag.
    const { writeDeadline: dl1, ...opts1 } = firstCall.args[7];
    const { writeDeadline: dl2, ...opts2 } = secondCall.args[7];
    expect(dl1).to.be.a('number');
    expect(dl2).to.equal(dl1);
    expect(opts1).to.deep.equal(expectedOpts);
    expect(opts2).to.deep.equal(expectedOpts);
    // Org parent (JIT units pool) threaded positionally (arg index 2), not in the options bag.
    expect(firstCall.args[2]).to.equal(PARENT_WS);
    expect(secondCall.args[2]).to.equal(PARENT_WS);
  });

  it('reads the brand URL sources once and applies them to every market', async () => {
    const sources = { urls: [{ value: 'https://x.com' }], socialAccounts: [], earnedContent: [] };
    getBrandUrlSourcesStub.resolves(sources);
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
      },
    }));

    expect(result.status).to.equal(200);
    expect(getBrandUrlSourcesStub).to.have.been.calledOnceWith(BRAND_ID);
    const { firstCall, secondCall } = handleCreateMarketSubworkspaceStub;
    expect(firstCall.args[7].brandUrlSources).to.deep.equal(sources);
    expect(secondCall.args[7].brandUrlSources).to.deep.equal(sources);
  });

  it('reads the brand competitors once and applies them to every market', async () => {
    const competitors = [{ url: 'https://rival.com' }];
    getBrandCompetitorsStub.resolves(competitors);
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
      },
    }));

    expect(result.status).to.equal(200);
    expect(getBrandCompetitorsStub).to.have.been.calledOnceWith(BRAND_ID);
    const { firstCall, secondCall } = handleCreateMarketSubworkspaceStub;
    expect(firstCall.args[7].competitors).to.deep.equal(competitors);
    expect(secondCall.args[7].competitors).to.deep.equal(competitors);
  });

  it('provisions a single US/EN fallback project for an empty markets array + a brandDomain', async () => {
    // A URL but no market: project creation is gated on the URL, so a single
    // US/EN fallback project is provisioned (matches the direct-create default).
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: { markets: [], brandDomain: 'x.com', brandNames: ['X'] },
    }));

    expect(result.status).to.equal(200);
    expect(handleCreateMarketSubworkspaceStub).to.have.been.calledOnce;
    const createBody = handleCreateMarketSubworkspaceStub.firstCall.args[3];
    expect(createBody.market).to.equal('US');
    expect(createBody.languageCode).to.equal('en');
  });

  it('treats a non-array markets value as empty, falling back to US/EN when a brandDomain is present', async () => {
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: { markets: 'not-an-array', brandDomain: 'x.com', brandNames: ['X'] },
    }));

    expect(result.status).to.equal(200);
    const createBody = handleCreateMarketSubworkspaceStub.firstCall.args[3];
    expect(createBody.market).to.equal('US');
    expect(createBody.languageCode).to.equal('en');
  });

  it('records a thrown market as failed without aborting the batch, staying active (207)', async () => {
    // Market 1 publishes (201, live upstream); market 2 throws. The batch must
    // NOT abort - both markets are reported per-market.
    handleCreateMarketSubworkspaceStub
      .onFirstCall().resolves({ status: 201, body: {} })
      .onSecondCall().rejects(Object.assign(new Error('upstream boom'), { status: 502 }));
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
      },
    }));

    expect(result.status).to.equal(207);
    expect(result.body.status).to.equal('active');
    expect(result.body.markets).to.have.length(2);
    expect(result.body.markets[0].status).to.equal(201);
    expect(result.body.markets[1].status).to.equal(502);
    expect(result.body.markets[1].body.message).to.equal('Market activation failed');
  });

  it('defaults a statusless throw to 502 in the per-market result', async () => {
    handleCreateMarketSubworkspaceStub.rejects(new Error('no status'));
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams());

    expect(result.status).to.equal(207);
    expect(result.body.markets[0].status).to.equal(502);
  });

  it('returns 200 for a mixed 201 + 409 batch and reports both markets', async () => {
    handleCreateMarketSubworkspaceStub
      .onFirstCall().resolves({ status: 201, body: {} })
      .onSecondCall().resolves({ status: 409, body: { error: 'sliceExists' } });
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
      },
    }));

    expect(result.status).to.equal(200);
    expect(result.body.markets.map((m) => m.status)).to.deep.equal([201, 409]);
    expect(updateBrandStub).to.have.been.calledOnce;
    expect(updateBrandStub.firstCall.args[0].updates.status).to.equal('active');
  });

  it('returns 207 and stays active when every market genuinely fails', async () => {
    // A real failure status (502), NOT 409 - a 409 sliceExists means the market
    // is already live and counts as success (see the all-409 re-activate test).
    handleCreateMarketSubworkspaceStub.resolves({ status: 502, body: {} });
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams());

    expect(result.status).to.equal(207);
    expect(result.body.status).to.equal('active');
  });

  it('returns 200 active for an all-409 idempotent re-activate (markets already live)', async () => {
    handleCreateMarketSubworkspaceStub.resolves({ status: 409, body: { error: 'sliceExists' } });
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
      },
    }));

    expect(result.status).to.equal(200);
    expect(result.body.status).to.equal('active');
    expect(updateBrandStub.firstCall.args[0].updates.status).to.equal('active');
  });

  it('returns 200 for a full re-activate (all markets 201, site linked)', async () => {
    ensureMarketSiteStub.resolves('site-uuid-1');
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
      },
    }));

    expect(result.status).to.equal(200);
    expect(result.body.status).to.equal('active');
    expect(ensureMarketSiteStub).to.have.been.called;
    expect(updateBrandStub).to.have.been.calledOnce;
    expect(updateBrandStub.firstCall.args[0].updates.status).to.equal('active');
  });

  it('sets brands.site_id to the primary domain\'s Site and returns baseSiteId (200)', async () => {
    ensureMarketSiteStub.resolves('primary-site-uuid');
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams());

    expect(result.status).to.equal(200);
    expect(result.body.status).to.equal('active');
    expect(result.body.baseSiteId).to.equal('primary-site-uuid');
    expect(updateBrandStub.firstCall.args[0].updates).to.include({
      status: 'active', baseSiteId: 'primary-site-uuid',
    });
  });

  it('returns a terminal 409 (stays pending) when the primary site is already another brand\'s primary', async () => {
    ensureMarketSiteStub.resolves('taken-site-uuid');
    const conflict = new Error('This site is already the primary URL for another brand');
    conflict.status = 409;
    updateBrandStub.rejects(conflict);
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams());

    expect(result.status).to.equal(409);
    expect(result.body.status).to.equal('pending');
    expect(result.body.error).to.equal('serenityActivationSiteConflict');
    expect(result.body.message).to.equal('This site is already the primary URL for another brand');
  });

  it('emits SERENITY_ACTIVATE_SAVE_DIVERGENCE and returns 207 (stays active) when the status save fails', async () => {
    updateBrandStub.rejects(new Error('db down'));
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams());

    expect(result.status).to.equal(207);
    expect(result.body.status).to.equal('active');
    expect(result.body.markets).to.have.length(1);
    expect(result.body.markets[0].status).to.equal(201);
    expect(log.error).to.have.been.calledWithMatch('SERENITY_ACTIVATE_SAVE_DIVERGENCE');
  });

  it('counts an already-existing (409) market as live in the save-divergence log when the status save fails', async () => {
    handleCreateMarketSubworkspaceStub.resolves({ status: 409, body: { error: 'sliceExists' } });
    ensureMarketSiteStub.resolves('site-uuid-1');
    updateBrandStub.rejects(new Error('db down'));
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams());

    expect(result.status).to.equal(207);
    const divergenceCall = log.error.getCalls().find(
      (c) => typeof c.args[0] === 'string' && c.args[0].includes('SERENITY_ACTIVATE_SAVE_DIVERGENCE'),
    );
    expect(divergenceCall, 'expected a SAVE_DIVERGENCE error log').to.not.equal(undefined);
    expect(divergenceCall.args[1].marketsLive).to.equal(1);
  });

  it('returns 207 (stays active) when every market is live but the brand_sites link fails', async () => {
    ensureMarketSiteStub.resolves(null);
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams());

    // Markets live but not linked → not fully succeeded → 207, stays active.
    expect(result.status).to.equal(207);
    expect(result.body.status).to.equal('active');
    expect(ensureMarketSiteStub).to.have.been.calledOnce;
    expect(updateBrandStub).to.not.have.been.called;
  });

  it('does NOT downgrade on a partial failure (207, stays active)', async () => {
    handleCreateMarketSubworkspaceStub
      .onFirstCall().resolves({ status: 409, body: { error: 'sliceExists' } })
      .onSecondCall().resolves({ status: 502, body: { error: 'serenityUpstreamError' } });
    const { orchestrateActivateMarkets } = await load();

    const result = await orchestrateActivateMarkets(baseParams({
      requestBody: {
        brandDomain: 'x.com',
        brandNames: ['X'],
        markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
      },
    }));

    expect(result.status).to.equal(207);
    expect(result.body.status).to.equal('active');
    expect(updateBrandStub).to.not.have.been.called;
  });
});
