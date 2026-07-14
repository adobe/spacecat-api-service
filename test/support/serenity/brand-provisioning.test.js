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

import {
  initialMarketProjectName,
  MAX_TOPICS_ON_CREATE,
} from '../../../src/support/serenity/brand-provisioning.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

const PARENT_WS = 'parent-ws-1111';
const NEW_WS = 'sub-ws-2222';

function buildContext() {
  return {
    env: { SEMRUSH_PROJECTS_BASE_URL: 'https://gw.example' },
    pathInfo: { headers: { authorization: 'Bearer test-ims-token' } },
    attributes: { authInfo: { getType: () => 'ims' } },
  };
}

async function loadModule({
  resolveWorkspaceId,
  handleCreateMarketSubworkspace,
  resolveSemrushImsToken,
  createSerenityTransport,
}) {
  const overrides = {
    '../../../src/support/serenity/workspace-resolver.js': { resolveWorkspaceId },
    '../../../src/support/serenity/rest-transport.js': {
      createSerenityTransport: createSerenityTransport || (() => ({})),
      SerenityTransportError,
    },
    '../../../src/support/serenity/handlers/markets-subworkspace.js': { handleCreateMarketSubworkspace },
  };
  // Only override when a test supplies one; otherwise the real
  // support/utils.js#resolveSemrushImsToken runs (its own decode/exchange
  // logic is covered directly in test/support/utils.test.js).
  if (resolveSemrushImsToken) {
    overrides['../../../src/support/utils.js'] = { resolveSemrushImsToken };
  }
  return esmock('../../../src/support/serenity/brand-provisioning.js', overrides);
}

const baseParams = {
  spaceCatId: 'org-1',
  brandId: 'brand-1',
  brandName: 'Acme',
  market: 'us',
  languageCode: 'en',
  brandDomain: 'acme.com',
  modelIds: ['m-1', 'm-2'],
};

describe('initialMarketProjectName', () => {
  it('formats "REGION - LANG" upper-cased', () => {
    expect(initialMarketProjectName('us', 'en')).to.equal('US - EN');
    expect(initialMarketProjectName('ch', 'de')).to.equal('CH - DE');
  });

  it('uses only the primary language subtag', () => {
    expect(initialMarketProjectName('us', 'en-US')).to.equal('US - EN');
  });
});

describe('provisionBrandSubworkspace', () => {
  let resolveWorkspaceId;
  let handleCreateMarketSubworkspace;

  beforeEach(() => {
    resolveWorkspaceId = sinon.stub().resolves(PARENT_WS);
    // Mimic the real handler: ensureSubworkspace would set the brand stub's
    // workspace id, then a project is created. Stub captures that side-effect.
    handleCreateMarketSubworkspace = sinon.stub().callsFake(async (transport, brand) => {
      brand.setSemrushSubWorkspaceId(NEW_WS);
      return { status: 201, body: { brandId: brand.getId() } };
    });
  });

  it('provisions the sub-workspace and returns its id', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    const result = await provisionBrandSubworkspace(buildContext(), baseParams);
    expect(result).to.deep.equal({
      semrushSubWorkspaceId: NEW_WS, published: false, projectId: '', geoTargetId: null, languageCode: 'en',
    });
  });

  it('exposes a brand stub whose getters/save are usable by the handler', async () => {
    // Exercises the stub's getSemrushSubWorkspaceId() (initially undefined) and the
    // no-op save() that the real handler invokes while driving provisioning.
    handleCreateMarketSubworkspace = sinon.stub().callsFake(async (transport, brand) => {
      expect(brand.getSemrushSubWorkspaceId()).to.equal(undefined);
      brand.setSemrushSubWorkspaceId(NEW_WS);
      await brand.save();
      return { status: 201, body: { brandId: brand.getId() } };
    });
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    const result = await provisionBrandSubworkspace(buildContext(), baseParams);
    expect(result.semrushSubWorkspaceId).to.equal(NEW_WS);
  });

  it('returns published:true when the initial market was published', async () => {
    // result.body.published truthy → Boolean(...) true branch (line 225).
    handleCreateMarketSubworkspace = sinon.stub().callsFake(async (transport, brand) => {
      brand.setSemrushSubWorkspaceId(NEW_WS);
      return { status: 201, body: { brandId: brand.getId(), published: true } };
    });
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    const result = await provisionBrandSubworkspace(buildContext(), baseParams);
    expect(result).to.deep.equal({
      semrushSubWorkspaceId: NEW_WS, published: true, projectId: '', geoTargetId: null, languageCode: 'en',
    });
  });

  it('returns published:false when a successful result carries no body (result.body || {})', async () => {
    // result.body is undefined on the success path → the `|| {}` fallback fires
    // before reading `.published` (line 225 right branch).
    handleCreateMarketSubworkspace = sinon.stub().callsFake(async (transport, brand) => {
      brand.setSemrushSubWorkspaceId(NEW_WS);
      return { status: 200 };
    });
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    const result = await provisionBrandSubworkspace(buildContext(), baseParams);
    expect(result).to.deep.equal({
      semrushSubWorkspaceId: NEW_WS, published: false, projectId: '', geoTargetId: null, languageCode: 'en',
    });
  });

  it('surfaces the initial market identity from the handler body, deliberately without writing the mapping row', async () => {
    // provisionBrandSubworkspace runs before the brand row is written (a
    // throwaway id), so it can't satisfy the mapping row's FK to brands —
    // the caller (brands.js) writes it once the real row is persisted.
    handleCreateMarketSubworkspace = sinon.stub().callsFake(async (transport, brand) => {
      brand.setSemrushSubWorkspaceId(NEW_WS);
      return {
        status: 201,
        body: {
          brandId: brand.getId(), projectId: 'proj-initial', geoTargetId: 2840, languageCode: 'en',
        },
      };
    });
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    const result = await provisionBrandSubworkspace(buildContext(), baseParams);
    expect(result).to.deep.equal({
      semrushSubWorkspaceId: NEW_WS,
      published: false,
      projectId: 'proj-initial',
      geoTargetId: 2840,
      languageCode: 'en',
    });
  });

  it('passes the "REGION - LANG" project name and brand identity to the handler', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    await provisionBrandSubworkspace(buildContext(), baseParams);
    const { args } = handleCreateMarketSubworkspace.firstCall;
    const [, brandStub, parentWs, body, , , , options] = args;
    expect(parentWs).to.equal(PARENT_WS);
    expect(body.name).to.equal('US - EN');
    expect(body.market).to.equal('us');
    expect(body.languageCode).to.equal('en');
    expect(body.brandDomain).to.equal('acme.com');
    expect(body.brandNames).to.deep.equal(['Acme']);
    // Brand-create attaches LLMs, generates+attaches prompts (each carrying the
    // standard closed-dimension values + its branded/non-branded `type` value),
    // then publishes best-effort. The dimension-root taxonomy is provisioned by
    // createMarket itself, so it is not passed through here.
    expect(options).to.deep.equal({
      modelIds: ['m-1', 'm-2'],
      generateTopics: true,
      topicCap: MAX_TOPICS_ON_CREATE,
      brandAliases: [],
      brandUrlSources: null,
      competitors: [],
      publishMode: 'require',
      // LLMO-6189: workspace-delete capability defaults OFF (env unset in buildContext()).
      allowDelete: false,
    });
    // The stub drives the sub-workspace title off the brand's name + id.
    expect(brandStub.getName()).to.equal('Acme');
    expect(brandStub.getId()).to.equal('brand-1');
    expect(brandStub.getSemrushSubWorkspaceId()).to.equal(undefined);
  });

  it('resolves the IMS token via resolveSemrushImsToken and forwards it to createSerenityTransport (promise-token path)', async () => {
    const context = {
      ...buildContext(),
      pathInfo: { headers: { 'x-promise-token': 'raw-promise-token' } },
      attributes: { authInfo: { getType: () => 'jwt' } },
    };
    const resolveSemrushImsTokenStub = sinon.stub().resolves('exchanged-ims-token');
    const createSerenityTransportStub = sinon.stub().returns({});
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId,
      handleCreateMarketSubworkspace,
      resolveSemrushImsToken: resolveSemrushImsTokenStub,
      createSerenityTransport: createSerenityTransportStub,
    });

    await provisionBrandSubworkspace(context, baseParams);

    expect(resolveSemrushImsTokenStub.calledOnce).to.equal(true);
    expect(resolveSemrushImsTokenStub.firstCall.args[0]).to.equal(context);
    expect(resolveSemrushImsTokenStub.firstCall.args[2]).to.equal('brand-provisioning');
    expect(createSerenityTransportStub.calledOnce).to.equal(true);
    expect(createSerenityTransportStub.firstCall.args[0]).to.deep.equal({
      env: context.env,
      imsToken: 'exchanged-ims-token',
    });
  });

  it('falls back to US/EN and publishes best-effort when generateTopics is false with no market or models', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    await provisionBrandSubworkspace(buildContext(), {
      ...baseParams,
      market: '',
      languageCode: '',
      modelIds: [],
      generateTopics: false,
    });
    const { args } = handleCreateMarketSubworkspace.firstCall;
    const [, , , body, , , , options] = args;
    // No market/language supplied → US/EN default slice.
    expect(body.market).to.equal('US');
    expect(body.languageCode).to.equal('en');
    expect(body.name).to.equal('US - EN');
    // No prompts + no models → empty units → best-effort publish (leaves a draft).
    expect(options.generateTopics).to.equal(false);
    expect(options.topicCap).to.equal(0);
    expect(options.publishMode).to.equal('best-effort');
  });

  it('forwards brandAliases to the handler for branded prompt classification', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    await provisionBrandSubworkspace(buildContext(), {
      ...baseParams, brandAliases: ['Acme Inc', 'ACME Corp'],
    });
    const [, , , , , , , options] = handleCreateMarketSubworkspace.firstCall.args;
    expect(options.brandAliases).to.deep.equal(['Acme Inc', 'ACME Corp']);
  });

  it('forwards brandUrlSources to the handler for benchmark URL attachment', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    const brandUrlSources = {
      urls: [{ value: 'https://acme.com' }], socialAccounts: [], earnedContent: [],
    };
    await provisionBrandSubworkspace(buildContext(), { ...baseParams, brandUrlSources });
    const [, , , , , , , options] = handleCreateMarketSubworkspace.firstCall.args;
    expect(options.brandUrlSources).to.deep.equal(brandUrlSources);
  });

  it('throws 400 when the organization has no parent workspace', async () => {
    resolveWorkspaceId.resolves(null);
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    try {
      await provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(400);
      expect(handleCreateMarketSubworkspace.called).to.equal(false);
    }
  });

  it('maps a handler 4xx into a thrown error of the same status', async () => {
    handleCreateMarketSubworkspace.resolves({ status: 409, body: { message: 'slice exists' } });
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    try {
      await provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(409);
      expect(e.message).to.equal('slice exists');
    }
  });

  it('maps an upstream 405 (disguised quota) to a 409 "Quota exceeded"', async () => {
    handleCreateMarketSubworkspace.rejects(new SerenityTransportError(405, 'Semrush POST .../tagged failed: 405'));
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    try {
      await provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(409);
      expect(e.message).to.equal('Quota exceeded');
    }
  });

  it('re-throws a non-405 upstream transport error unchanged', async () => {
    handleCreateMarketSubworkspace.rejects(new SerenityTransportError(500, 'boom'));
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    try {
      await provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.message).to.equal('boom');
      expect(e.status).to.equal(500);
    }
  });

  it('throws 502 when the handler succeeds but no workspace id was captured', async () => {
    handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    try {
      await provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(502);
    }
  });

  it('throws 400 on missing required params before any upstream call', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    // market/languageCode are NOT in this list: they are optional (a no-prompt
    // brand may omit them, falling back to US/EN) — see the fallback test below.
    for (const bad of [
      { ...baseParams, brandName: '' },
      { ...baseParams, brandId: '' },
      { ...baseParams, brandDomain: '' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      try {
        // eslint-disable-next-line no-await-in-loop
        await provisionBrandSubworkspace(buildContext(), bad);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e.status).to.equal(400);
      }
    }
    expect(resolveWorkspaceId.called).to.equal(false);
  });

  it('rejects a non-IMS caller with 401 before forwarding the token upstream', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    const ctx = {
      ...buildContext(),
      attributes: { authInfo: { getType: () => 'jwt' } },
    };
    try {
      await provisionBrandSubworkspace(ctx, baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(401);
    }
    // Guard fires before any upstream provisioning — the non-IMS bearer is
    // never proxied to the Semrush gateway.
    expect(handleCreateMarketSubworkspace.called).to.equal(false);
  });

  function makeReleaseTransport(overrides = {}) {
    return {
      transferWorkspaceResources: sinon.stub().resolves({}),
      listProjects: sinon.stub().resolves({ items: [] }),
      deleteProject: sinon.stub().resolves(null),
      deleteWorkspace: sinon.stub().resolves(null),
      ...overrides,
    };
  }

  it('LLMO-6189: logs the stranded allocation (never a zero-payload transfer) when provisioning throws after creation, allowDelete off (default)', async () => {
    // ensureSubworkspace creates the workspace (captured via the stub) and THEN
    // a later step returns a 4xx — provisioning throws. The orphaned workspace's
    // projects are emptied; its allocation cannot be reclaimed via transfer (a
    // to-zero transfer is a proven no-op), so — with the delete capability off,
    // the default in every deployed env — it is logged as stranded rather than
    // falsely reported as released.
    const transport = makeReleaseTransport({
      listProjects: sinon.stub().resolves({ items: [{ id: 'proj-1' }] }),
    });
    const handler = sinon.stub().callsFake(async (t, brand) => {
      brand.setSemrushSubWorkspaceId(NEW_WS);
      return { status: 502, body: { message: 'upstream blew up' } };
    });
    const mod = await esmock('../../../src/support/serenity/brand-provisioning.js', {
      '../../../src/support/serenity/workspace-resolver.js': {
        resolveWorkspaceId: sinon.stub().resolves(PARENT_WS),
      },
      '../../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: () => transport,
        SerenityTransportError,
      },
      '../../../src/support/serenity/handlers/markets-subworkspace.js': {
        handleCreateMarketSubworkspace: handler,
      },
    });
    try {
      await mod.provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(502);
    }
    expect(transport.deleteProject).to.have.been.calledOnceWithExactly(NEW_WS, 'proj-1');
    expect(transport.transferWorkspaceResources).to.not.have.been.called;
    expect(transport.deleteWorkspace).to.not.have.been.called;
  });

  it('LLMO-6189: deletes the orphaned sub-workspace outright when allowDelete is on', async () => {
    const transport = makeReleaseTransport({
      listProjects: sinon.stub().resolves({ items: [{ id: 'proj-1' }] }),
    });
    const handler = sinon.stub().callsFake(async (t, brand) => {
      brand.setSemrushSubWorkspaceId(NEW_WS);
      return { status: 502, body: { message: 'upstream blew up' } };
    });
    const mod = await esmock('../../../src/support/serenity/brand-provisioning.js', {
      '../../../src/support/serenity/workspace-resolver.js': {
        resolveWorkspaceId: sinon.stub().resolves(PARENT_WS),
      },
      '../../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: () => transport,
        SerenityTransportError,
      },
      '../../../src/support/serenity/handlers/markets-subworkspace.js': {
        handleCreateMarketSubworkspace: handler,
      },
    });
    try {
      await mod.provisionBrandSubworkspace(
        { ...buildContext(), env: { SERENITY_ALLOW_WORKSPACE_DELETE: 'true' } },
        baseParams,
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(502);
    }
    expect(transport.deleteProject).to.have.been.calledOnceWithExactly(NEW_WS, 'proj-1');
    expect(transport.deleteWorkspace).to.have.been.calledOnceWithExactly(NEW_WS);
    expect(transport.transferWorkspaceResources).to.not.have.been.called;
  });

  it('does NOT attempt a release when provisioning fails before the workspace is created', async () => {
    // ensureSubworkspace never set the workspace id (e.g. parent-workspace
    // lookup failed inside the handler) → nothing to release.
    const transport = makeReleaseTransport();
    const handler = sinon.stub().rejects(new SerenityTransportError(500, 'early boom'));
    const mod = await esmock('../../../src/support/serenity/brand-provisioning.js', {
      '../../../src/support/serenity/workspace-resolver.js': {
        resolveWorkspaceId: sinon.stub().resolves(PARENT_WS),
      },
      '../../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: () => transport,
        SerenityTransportError,
      },
      '../../../src/support/serenity/handlers/markets-subworkspace.js': {
        handleCreateMarketSubworkspace: handler,
      },
    });
    try {
      await mod.provisionBrandSubworkspace(buildContext(), baseParams);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.status).to.equal(500);
    }
    expect(transport.listProjects.called).to.equal(false);
    expect(transport.transferWorkspaceResources.called).to.equal(false);
    expect(transport.deleteWorkspace.called).to.equal(false);
  });
});

describe('releaseProvisionedWorkspace', () => {
  function buildAuthedContext(extraEnv = {}) {
    return {
      env: { SEMRUSH_PROJECTS_BASE_URL: 'https://gw.example', ...extraEnv },
      pathInfo: { headers: { authorization: 'Bearer test-ims-token' } },
      attributes: { authInfo: { getType: () => 'ims' } },
    };
  }

  function makeTransport(overrides = {}) {
    return {
      transferWorkspaceResources: sinon.stub().resolves({}),
      listProjects: sinon.stub().resolves({ items: [] }),
      deleteProject: sinon.stub().resolves(null),
      deleteWorkspace: sinon.stub().resolves(null),
      ...overrides,
    };
  }

  async function loadWithTransport(
    transport,
    {
      resolveSemrushImsToken, createSerenityTransport, resolveWorkspaceId,
    } = {},
  ) {
    const overrides = {
      '../../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: createSerenityTransport || (() => transport),
        SerenityTransportError,
      },
    };
    if (resolveSemrushImsToken) {
      overrides['../../../src/support/utils.js'] = { resolveSemrushImsToken };
    }
    if (resolveWorkspaceId) {
      overrides['../../../src/support/serenity/workspace-resolver.js'] = { resolveWorkspaceId };
    }
    return esmock('../../../src/support/serenity/brand-provisioning.js', overrides);
  }

  it('LLMO-6189: allowDelete off (default) — empties projects, logs the stranded allocation, never sends a zero-payload transfer', async () => {
    const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }) });
    const resolveWorkspaceId = sinon.stub().resolves(PARENT_WS);
    const { releaseProvisionedWorkspace } = await loadWithTransport(
      transport,
      { resolveWorkspaceId },
    );
    const log = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };
    await releaseProvisionedWorkspace(buildAuthedContext(), NEW_WS, 'org-1', log);
    expect(transport.deleteProject).to.have.been.calledOnceWithExactly(NEW_WS, 'p1');
    expect(transport.transferWorkspaceResources.called).to.equal(false);
    expect(transport.deleteWorkspace.called).to.equal(false);
    expect(log.error.called).to.equal(false);
    expect(log.info.calledOnce).to.equal(true);
    expect(log.info.firstCall.args[1]).to.include({ released: false, reason: 'requires-decommission' });
  });

  it('LLMO-6189: allowDelete on — deletes the workspace, a genuine reclaim', async () => {
    const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }) });
    const resolveWorkspaceId = sinon.stub().resolves(PARENT_WS);
    const { releaseProvisionedWorkspace } = await loadWithTransport(
      transport,
      { resolveWorkspaceId },
    );
    const log = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };
    await releaseProvisionedWorkspace(
      buildAuthedContext({ SERENITY_ALLOW_WORKSPACE_DELETE: 'true' }),
      NEW_WS,
      'org-1',
      log,
    );
    expect(transport.deleteProject).to.have.been.calledOnceWithExactly(NEW_WS, 'p1');
    expect(transport.deleteWorkspace).to.have.been.calledOnceWithExactly(NEW_WS);
    expect(transport.transferWorkspaceResources.called).to.equal(false);
    expect(log.error.called).to.equal(false);
    // releaseFullAllocation logs its own info line first; releaseProvisionedWorkspace's summary
    // (the one carrying released/reason) is the LAST info call.
    expect(log.info.lastCall.args[1]).to.include({ released: true, reason: 'deleted' });
  });

  it('resolves the org parent workspace via spaceCatId and refuses to act on it (assertNotParent)', async () => {
    const transport = makeTransport();
    const resolveWorkspaceId = sinon.stub().resolves(NEW_WS); // parent === the id we're releasing
    const { releaseProvisionedWorkspace } = await loadWithTransport(
      transport,
      { resolveWorkspaceId },
    );
    const log = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };
    // Must NOT throw — the caller is already on an error path; the guard failure is swallowed +
    // logged like any other best-effort release failure.
    await releaseProvisionedWorkspace(buildAuthedContext(), NEW_WS, 'org-1', log);
    expect(resolveWorkspaceId).to.have.been.calledOnceWith(sinon.match.any, 'org-1');
    expect(log.error.calledOnce).to.equal(true);
    expect(log.error.firstCall.args[1].error).to.match(/must not be the organization parent workspace/);
  });

  it('is a no-op when no workspace id is given', async () => {
    const transport = makeTransport();
    const { releaseProvisionedWorkspace } = await loadWithTransport(transport);
    await releaseProvisionedWorkspace(buildAuthedContext(), '', 'org-1', { error: sinon.stub() });
    expect(transport.transferWorkspaceResources.called).to.equal(false);
    expect(transport.deleteWorkspace.called).to.equal(false);
  });

  it('swallows a release failure and logs it at error with the workspace id', async () => {
    const transport = makeTransport({
      listProjects: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
    });
    const { releaseProvisionedWorkspace } = await loadWithTransport(transport);
    const log = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };
    // Must NOT throw — the caller is already on an error path.
    await releaseProvisionedWorkspace(buildAuthedContext(), NEW_WS, 'org-1', log);
    expect(log.error.calledOnce).to.equal(true);
    expect(log.error.firstCall.args[1].semrushWorkspaceId).to.equal(NEW_WS);
  });

  it('resolves the IMS token via resolveSemrushImsToken and forwards it to createSerenityTransport (promise-token path)', async () => {
    const context = {
      env: { SEMRUSH_PROJECTS_BASE_URL: 'https://gw.example' },
      pathInfo: { headers: { 'x-promise-token': 'raw-promise-token' } },
      attributes: { authInfo: { getType: () => 'jwt' } },
    };
    const transport = makeTransport();
    const resolveSemrushImsTokenStub = sinon.stub().resolves('exchanged-ims-token');
    const createSerenityTransportStub = sinon.stub().returns(transport);
    const { releaseProvisionedWorkspace } = await loadWithTransport(transport, {
      resolveSemrushImsToken: resolveSemrushImsTokenStub,
      createSerenityTransport: createSerenityTransportStub,
    });
    const log = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };

    await releaseProvisionedWorkspace(context, NEW_WS, undefined, log);

    expect(resolveSemrushImsTokenStub.calledOnce).to.equal(true);
    expect(resolveSemrushImsTokenStub.firstCall.args[0]).to.equal(context);
    expect(resolveSemrushImsTokenStub.firstCall.args[2]).to.equal('brand-provisioning');
    expect(createSerenityTransportStub.calledOnce).to.equal(true);
    expect(createSerenityTransportStub.firstCall.args[0]).to.deep.equal({
      env: context.env,
      imsToken: 'exchanged-ims-token',
    });
    expect(log.error.called).to.equal(false);
  });
});

describe('defensive branch coverage', () => {
  describe('initialMarketProjectName - falsy market and languageCode', () => {
    it('returns " - " when market is null (String(null || "") = "")', () => {
      // Line 38: String(market || '') right branch fires.
      expect(initialMarketProjectName(null, 'en')).to.equal(' - EN');
    });

    it('returns " - " when market is empty string (String("" || "") = "")', () => {
      expect(initialMarketProjectName('', 'en')).to.equal(' - EN');
    });

    it('returns "US - " when languageCode is null (String(null || "") = "")', () => {
      // Line 39: String(languageCode || '') right branch fires (split('')[0] = '').
      expect(initialMarketProjectName('us', null)).to.equal('US - ');
    });

    it('returns "US - " when languageCode is empty string', () => {
      expect(initialMarketProjectName('us', '')).to.equal('US - ');
    });
  });

  describe('releaseCapturedOnFailure catch block (lines 141-145)', () => {
    it('logs error when provisioning fails after workspace creation AND the release itself throws', async () => {
      // The catch fires when: handleCreateMarketSubworkspace captures a workspaceId (via
      // brand.setSemrushSubWorkspaceId) and then returns a 4xx result triggering
      // releaseCapturedOnFailure, AND emptying the workspace's projects (deleteAllProjects,
      // the first step of any release attempt post-LLMO-6189) throws.
      const listProjects = sinon.stub().rejects(new Error('release network error'));
      const handler = sinon.stub().callsFake(async (transport, brand) => {
        brand.setSemrushSubWorkspaceId(NEW_WS);
        return { status: 422, body: {} };
      });
      const log = { error: sinon.stub(), info: sinon.stub() };
      const mod = await esmock('../../../src/support/serenity/brand-provisioning.js', {
        '../../../src/support/serenity/workspace-resolver.js': {
          resolveWorkspaceId: sinon.stub().resolves(PARENT_WS),
        },
        '../../../src/support/serenity/rest-transport.js': {
          createSerenityTransport: () => ({
            listProjects,
            deleteProject: sinon.stub().resolves(null),
            deleteWorkspace: sinon.stub().resolves(null),
            transferWorkspaceResources: sinon.stub().resolves({}),
          }),
          SerenityTransportError,
        },
        '../../../src/support/serenity/handlers/markets-subworkspace.js': {
          handleCreateMarketSubworkspace: handler,
        },
      });
      try {
        await mod.provisionBrandSubworkspace(buildContext(), baseParams, log);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e.status).to.equal(422);
      }
      // The release was attempted but failed; log.error must have been called
      // from the catch block with the 'failed to release' message.
      expect(listProjects.calledOnce).to.equal(true);
      expect(log.error.called).to.equal(true);
      const [msg, meta] = log.error.firstCall.args;
      expect(msg).to.include('failed to release');
      expect(meta.semrushWorkspaceId).to.equal(NEW_WS);
      expect(meta.error).to.equal('release network error');
    });
  });

  describe('provisionBrandSubworkspace result.body.message fallback', () => {
    it('uses fallback message when result has no body.message', async () => {
      // Line 196: result.body?.message || 'Failed to provision Semrush sub-workspace'
      // right side fires when body.message is absent/falsy.
      const handler = sinon.stub().callsFake(async (transport, brand) => {
        brand.setSemrushSubWorkspaceId(NEW_WS);
        return { status: 422, body: {} };
      });
      const mod = await esmock('../../../src/support/serenity/brand-provisioning.js', {
        '../../../src/support/serenity/workspace-resolver.js': {
          resolveWorkspaceId: sinon.stub().resolves(PARENT_WS),
        },
        '../../../src/support/serenity/rest-transport.js': {
          createSerenityTransport: () => ({}),
          SerenityTransportError,
        },
        '../../../src/support/serenity/handlers/markets-subworkspace.js': {
          handleCreateMarketSubworkspace: handler,
        },
      });
      try {
        await mod.provisionBrandSubworkspace(buildContext(), baseParams);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e.status).to.equal(422);
        expect(e.message).to.equal('Failed to provision Semrush sub-workspace');
      }
    });

    it('uses fallback message when result has no body at all', async () => {
      // result.body is undefined -> result.body?.message = undefined -> fallback.
      const handler = sinon.stub().callsFake(async (transport, brand) => {
        brand.setSemrushSubWorkspaceId(NEW_WS);
        return { status: 500 };
      });
      const mod = await esmock('../../../src/support/serenity/brand-provisioning.js', {
        '../../../src/support/serenity/workspace-resolver.js': {
          resolveWorkspaceId: sinon.stub().resolves(PARENT_WS),
        },
        '../../../src/support/serenity/rest-transport.js': {
          createSerenityTransport: () => ({}),
          SerenityTransportError,
        },
        '../../../src/support/serenity/handlers/markets-subworkspace.js': {
          handleCreateMarketSubworkspace: handler,
        },
      });
      try {
        await mod.provisionBrandSubworkspace(buildContext(), baseParams);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e.status).to.equal(500);
        expect(e.message).to.equal('Failed to provision Semrush sub-workspace');
      }
    });
  });
});
