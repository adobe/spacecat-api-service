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
import { resolveMarketIdentity, logMarketCreated } from '../../../../src/support/serenity/site-linkage.js';

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

describe('handlers/create-market-orchestration.js (PR-C, LLMO-7352/LLMO-7418)', () => {
  let handleCreateMarketSubworkspaceStub;
  let ensureMarketSiteStub;
  let linkSiteToRowStub;
  let getBrandAliasesStub;
  let getBrandUrlSourcesStub;
  let getBrandCompetitorsStub;
  let resolveDefaultModelIdsStub;
  let brandFindByIdStub;
  let dataAccess;
  let log;

  beforeEach(() => {
    handleCreateMarketSubworkspaceStub = sinon.stub()
      .resolves({ status: 201, body: { brandId: BRAND_ID, geoTargetId: 2840, languageCode: 'en' } });
    ensureMarketSiteStub = sinon.stub().resolves(null);
    linkSiteToRowStub = sinon.stub().resolves();
    getBrandAliasesStub = sinon.stub().resolves([]);
    getBrandUrlSourcesStub = sinon.stub()
      .resolves({ urls: [], socialAccounts: [], earnedContent: [] });
    getBrandCompetitorsStub = sinon.stub().resolves([]);
    resolveDefaultModelIdsStub = sinon.stub().resolves([]);
    brandFindByIdStub = sinon.stub().resolves({ getId: () => BRAND_ID, getName: () => 'Acme' });
    dataAccess = {
      Brand: { findById: brandFindByIdStub },
      BrandSemrushProject: { name: 'BrandSemrushProject' },
      Site: { name: 'Site' },
      services: { postgrestClient: {} },
    };
    log = fakeLog();
  });

  async function load() {
    return esmock('../../../../src/support/serenity/handlers/create-market-orchestration.js', {
      '../../../../src/support/serenity/handlers/markets-subworkspace.js': {
        handleCreateMarketSubworkspace: handleCreateMarketSubworkspaceStub,
      },
      '../../../../src/support/serenity/site-linkage.js': {
        ensureMarketSite: ensureMarketSiteStub,
        // resolveMarketIdentity and logMarketCreated stay REAL: they're pure/log-only, and the
        // whole point of several of these tests is to verify their actual precedence/formatting
        // behavior end-to-end, not a stubbed stand-in for it.
        resolveMarketIdentity,
        logMarketCreated,
      },
      '../../../../src/support/serenity/mapping-rows.js': {
        linkSiteToRow: linkSiteToRowStub,
      },
      '../../../../src/support/brands-storage.js': {
        getBrandAliases: getBrandAliasesStub,
        getBrandUrlSources: getBrandUrlSourcesStub,
        getBrandCompetitors: getBrandCompetitorsStub,
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
      workspaceId: WORKSPACE_ID,
      requestBody: {
        market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
      },
      log,
      ...overrides,
    };
  }

  it('throws 500 when Brand data-access is unavailable', async () => {
    const { orchestrateCreateMarketSubworkspace } = await load();
    await expect(orchestrateCreateMarketSubworkspace(baseParams({ dataAccess: {} })))
      .to.be.rejectedWith('Brand data-access not available');
  });

  it('throws 404 when the brand does not exist', async () => {
    brandFindByIdStub.resolves(null);
    const { orchestrateCreateMarketSubworkspace } = await load();
    await expect(orchestrateCreateMarketSubworkspace(baseParams()))
      .to.be.rejectedWith(`Brand not found: ${BRAND_ID}`);
  });

  it('routes the parent workspace id positionally to handleCreateMarketSubworkspace', async () => {
    const { orchestrateCreateMarketSubworkspace } = await load();

    const result = await orchestrateCreateMarketSubworkspace(baseParams());

    expect(result).to.deep.equal({ status: 201, body: { brandId: BRAND_ID, geoTargetId: 2840, languageCode: 'en' } });
    expect(handleCreateMarketSubworkspaceStub).to.have.been.calledOnce;
    expect(handleCreateMarketSubworkspaceStub.firstCall.args[2]).to.equal(PARENT_WS);
  });

  it('forwards brand aliases, URL sources, competitors, and resolved model ids in the options bag', async () => {
    getBrandAliasesStub.resolves(['Acme Inc', 'ACME']);
    const sources = { urls: [{ value: 'https://x.com' }], socialAccounts: [], earnedContent: [] };
    getBrandUrlSourcesStub.resolves(sources);
    const competitors = [{ url: 'https://rival.com', regions: ['us'] }];
    getBrandCompetitorsStub.resolves(competitors);
    resolveDefaultModelIdsStub.resolves(['model-1', 'model-2']);
    const { orchestrateCreateMarketSubworkspace } = await load();

    await orchestrateCreateMarketSubworkspace(baseParams());

    const { postgrestClient } = dataAccess.services;
    expect(getBrandAliasesStub).to.have.been.calledOnceWith(BRAND_ID, postgrestClient);
    expect(getBrandUrlSourcesStub).to.have.been.calledOnceWith(BRAND_ID, postgrestClient);
    expect(getBrandCompetitorsStub).to.have.been.calledOnceWith(BRAND_ID, postgrestClient);
    const options = handleCreateMarketSubworkspaceStub.firstCall.args[7];
    expect(options.brandAliases).to.deep.equal(['Acme Inc', 'ACME']);
    expect(options.brandUrlSources).to.deep.equal(sources);
    expect(options.competitors).to.deep.equal(competitors);
    expect(options.modelIds).to.deep.equal(['model-1', 'model-2']);
    expect(options.dataAccess)
      .to.deep.equal({ BrandSemrushProject: dataAccess.BrandSemrushProject });
    expect(options.brandCollection).to.equal(dataAccess.Brand);
    expect(options.orgId).to.equal(ORG_ID);
  });

  it('an explicit modelIds override wins over resolveDefaultModelIds (PR-C, brand-create initial market)', async () => {
    resolveDefaultModelIdsStub.resolves(['generic-default-model']);
    const { orchestrateCreateMarketSubworkspace } = await load();

    await orchestrateCreateMarketSubworkspace(baseParams({
      modelIds: ['caller-chosen-model-1', 'caller-chosen-model-2'],
    }));

    const options = handleCreateMarketSubworkspaceStub.firstCall.args[7];
    expect(options.modelIds).to.deep.equal(['caller-chosen-model-1', 'caller-chosen-model-2']);
    expect(resolveDefaultModelIdsStub).to.not.have.been.called;
  });

  it('falls back to resolveDefaultModelIds when modelIds is omitted or empty', async () => {
    resolveDefaultModelIdsStub.resolves(['mirrored-existing-model']);
    const { orchestrateCreateMarketSubworkspace } = await load();

    await orchestrateCreateMarketSubworkspace(baseParams({ modelIds: [] }));

    const options = handleCreateMarketSubworkspaceStub.firstCall.args[7];
    expect(options.modelIds).to.deep.equal(['mirrored-existing-model']);
    expect(resolveDefaultModelIdsStub).to.have.been.calledOnce;
  });

  it('defaults generateTopics/topicCap off when generatePrompts is not supplied', async () => {
    const { orchestrateCreateMarketSubworkspace } = await load();

    await orchestrateCreateMarketSubworkspace(baseParams());

    const options = handleCreateMarketSubworkspaceStub.firstCall.args[7];
    expect(options.generateTopics).to.equal(false);
    expect(options.topicCap).to.equal(0);
  });

  it('opts into topic generation (topicCap 5) when generatePrompts is true', async () => {
    const { orchestrateCreateMarketSubworkspace } = await load();

    await orchestrateCreateMarketSubworkspace(baseParams({
      requestBody: { ...baseParams().requestBody, generatePrompts: true },
    }));

    const options = handleCreateMarketSubworkspaceStub.firstCall.args[7];
    expect(options.generateTopics).to.equal(true);
    expect(options.topicCap).to.equal(5);
  });

  it('derives brandDomain/primaryUrl from brandDomain alone when no siteId is supplied', async () => {
    const { orchestrateCreateMarketSubworkspace } = await load();

    await orchestrateCreateMarketSubworkspace(baseParams({
      requestBody: { market: 'us', languageCode: 'en', brandDomain: 'nba.com' },
    }));

    const effectiveBody = handleCreateMarketSubworkspaceStub.firstCall.args[3];
    expect(effectiveBody.brandDomain).to.equal('nba.com');
    expect(effectiveBody.primaryUrl).to.equal('nba.com');
  });

  it('derives brandDomain/primaryUrl as null/null when neither siteId nor brandDomain is supplied', async () => {
    const { orchestrateCreateMarketSubworkspace } = await load();

    await orchestrateCreateMarketSubworkspace(baseParams({ requestBody: {} }));

    const effectiveBody = handleCreateMarketSubworkspaceStub.firstCall.args[3];
    expect(effectiveBody).to.deep.equal({ brandDomain: null, primaryUrl: null });
  });

  it('a resolved siteId identity is authoritative over a conflicting brandDomain', async () => {
    const { orchestrateCreateMarketSubworkspace } = await load();

    await orchestrateCreateMarketSubworkspace(baseParams({
      requestBody: {
        market: 'us', languageCode: 'en', brandDomain: 'conflicting-literal.com',
      },
      suppliedSiteIdentity: { domain: 'acme.com', primaryUrl: 'acme.com/markets' },
      suppliedSiteId: 'site-onboarded',
    }));

    const effectiveBody = handleCreateMarketSubworkspaceStub.firstCall.args[3];
    expect(effectiveBody.brandDomain).to.equal('acme.com');
    expect(effectiveBody.primaryUrl).to.equal('acme.com/markets');
  });

  it('ignores a caller-supplied primaryUrl on the request body — it is never part of the contract', async () => {
    const { orchestrateCreateMarketSubworkspace } = await load();

    await orchestrateCreateMarketSubworkspace(baseParams({
      requestBody: {
        market: 'us', languageCode: 'en', brandDomain: 'acme.com', primaryUrl: 'evil.example.com/attacker-path',
      },
    }));

    const effectiveBody = handleCreateMarketSubworkspaceStub.firstCall.args[3];
    expect(effectiveBody.primaryUrl).to.equal('acme.com');
  });

  describe('post-create Site mirroring (201 only)', () => {
    it('mirrors the new market as a Site with the org/brand/domain', async () => {
      const { orchestrateCreateMarketSubworkspace } = await load();

      await orchestrateCreateMarketSubworkspace(baseParams());

      expect(ensureMarketSiteStub).to.have.been.calledOnce;
      const [ctxArg, opts] = ensureMarketSiteStub.firstCall.args;
      expect(ctxArg).to.deep.equal({ dataAccess });
      expect(opts).to.include({ organizationId: ORG_ID, brandId: BRAND_ID, domain: 'x.com' });
    });

    it('mirrors the brand host when the market carries no url of its own', async () => {
      const { orchestrateCreateMarketSubworkspace } = await load();

      await orchestrateCreateMarketSubworkspace(baseParams({
        requestBody: { market: 'us', languageCode: 'en', brandDomain: 'nba.com' },
      }));

      const opts = ensureMarketSiteStub.firstCall.args[1];
      expect(opts.domain).to.equal('nba.com');
    });

    it('passes the supplied siteId directly to ensureMarketSite (skips domain find-or-create)', async () => {
      const { orchestrateCreateMarketSubworkspace } = await load();

      await orchestrateCreateMarketSubworkspace(baseParams({
        suppliedSiteIdentity: { domain: 'acme.com', primaryUrl: 'acme.com/markets' },
        suppliedSiteId: 'site-onboarded',
      }));

      const opts = ensureMarketSiteStub.firstCall.args[1];
      expect(opts).to.include({ siteId: 'site-onboarded', domain: 'acme.com/markets' });
    });

    it('does NOT mirror a Site when the upstream create did not return 201', async () => {
      handleCreateMarketSubworkspaceStub.resolves({ status: 409, body: { error: 'sliceExists' } });
      const { orchestrateCreateMarketSubworkspace } = await load();

      await orchestrateCreateMarketSubworkspace(baseParams());

      expect(ensureMarketSiteStub).to.not.have.been.called;
    });

    it('links the mirrored site onto THIS market\'s mapping row, scoped to the new project id', async () => {
      handleCreateMarketSubworkspaceStub.resolves({
        status: 201,
        body: {
          brandId: BRAND_ID, geoTargetId: 2840, languageCode: 'en', projectId: 'P-NEW',
        },
      });
      ensureMarketSiteStub.resolves('site-uuid-1');
      const { orchestrateCreateMarketSubworkspace } = await load();

      await orchestrateCreateMarketSubworkspace(baseParams());

      expect(linkSiteToRowStub).to.have.been.calledOnceWith(dataAccess, 'P-NEW', 'site-uuid-1', log);
    });

    it('warns and links nothing when a 201 names no project', async () => {
      handleCreateMarketSubworkspaceStub.resolves({
        status: 201,
        body: { brandId: BRAND_ID, geoTargetId: 2840, languageCode: 'en' },
      });
      ensureMarketSiteStub.resolves('site-uuid-1');
      const { orchestrateCreateMarketSubworkspace } = await load();

      await orchestrateCreateMarketSubworkspace(baseParams());

      expect(linkSiteToRowStub).to.not.have.been.called;
      expect(log.warn).to.have.been.calledWithMatch(/201 without a projectId/);
    });

    it('logs market-created telemetry unconditionally on 201, even without a projectId', async () => {
      handleCreateMarketSubworkspaceStub.resolves({
        status: 201,
        body: { brandId: BRAND_ID, geoTargetId: 2840, languageCode: 'en' },
      });
      const { orchestrateCreateMarketSubworkspace } = await load();

      await orchestrateCreateMarketSubworkspace(baseParams());

      expect(log.info).to.have.been.calledWithMatch(
        /serenity create-market: market created/,
        sinon.match({ semrushProjectId: null, geoTargetId: 2840, languageCode: 'en' }),
      );
    });

    it('logs market-created telemetry with the full resolved identity on a live 201', async () => {
      handleCreateMarketSubworkspaceStub.resolves({
        status: 201,
        body: {
          brandId: BRAND_ID, geoTargetId: 2840, languageCode: 'en', projectId: 'P-NEW', workspaceId: WORKSPACE_ID, promptCount: 5,
        },
      });
      const { orchestrateCreateMarketSubworkspace } = await load();

      await orchestrateCreateMarketSubworkspace(baseParams({
        requestBody: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', generatePrompts: true,
        },
      }));

      expect(log.info).to.have.been.calledWithMatch(/serenity create-market: market created/);
      expect(log.info.firstCall.args[1]).to.include({
        brandId: BRAND_ID,
        geoTargetId: 2840,
        languageCode: 'en',
        siteId: null,
        brandDomain: 'x.com',
        primaryUrl: 'x.com',
        semrushWorkspaceId: WORKSPACE_ID,
        semrushProjectId: 'P-NEW',
        generatePrompts: true,
        promptCount: 5,
      });
    });
  });
});
