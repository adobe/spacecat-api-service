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
    // standard closed-dimension values, a branded/non-branded `type` value, and a
    // server-classified `intent` value), then publishes best-effort. The
    // dimension-root taxonomy is provisioned by createMarket itself, so it is not
    // passed through here. writeDeadline is a request-scoped epoch-ms deadline
    // (dynamic) — asserted as a number, then dropped before the deep-equal.
    const { writeDeadline, ...restOptions } = options;
    expect(writeDeadline).to.be.a('number');
    expect(restOptions).to.deep.equal({
      modelIds: ['m-1', 'm-2'],
      generateTopics: true,
      topicCap: MAX_TOPICS_ON_CREATE,
      brandAliases: [],
      brandUrlSources: null,
      competitors: [],
      env: { SEMRUSH_PROJECTS_BASE_URL: 'https://gw.example' },
      publishMode: 'require',
    });
    // The stub drives the sub-workspace title off the brand's name + id.
    expect(brandStub.getName()).to.equal('Acme');
    expect(brandStub.getId()).to.equal('brand-1');
    expect(brandStub.getSemrushSubWorkspaceId()).to.equal(undefined);
  });

  it('forwards a caller-supplied writeDeadline to the create handler (computed once at request entry, not defaulted here)', async () => {
    const { provisionBrandSubworkspace } = await loadModule({
      resolveWorkspaceId, handleCreateMarketSubworkspace,
    });
    // A deadline far in the future so it is unmistakably the passed-in value,
    // not a fresh computeWriteDeadline() default (which would be ~now + 12s).
    const writeDeadline = Date.now() + 999999;
    await provisionBrandSubworkspace(buildContext(), { ...baseParams, writeDeadline });
    const options = handleCreateMarketSubworkspace.firstCall.args[7];
    expect(options.writeDeadline).to.equal(writeDeadline);
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

  it('releases the created sub-workspace allocation when provisioning throws after creation', async () => {
    // ensureSubworkspace creates the workspace (captured via the stub) and THEN
    // a later step returns a 4xx — provisioning throws, and the orphaned
    // allocation must be released back to the parent pool (else it leaks: the
    // brand row is never written, so the caller's compensation can't fire).
    const transfer = sinon.stub().resolves({});
    const handler = sinon.stub().callsFake(async (transport, brand) => {
      brand.setSemrushSubWorkspaceId(NEW_WS);
      return { status: 502, body: { message: 'upstream blew up' } };
    });
    const mod = await esmock('../../../src/support/serenity/brand-provisioning.js', {
      '../../../src/support/serenity/workspace-resolver.js': {
        resolveWorkspaceId: sinon.stub().resolves(PARENT_WS),
      },
      '../../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: () => ({ transferWorkspaceResources: transfer }),
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
    expect(transfer.calledOnce).to.equal(true);
    expect(transfer.firstCall.args[0]).to.equal(NEW_WS);
    expect(transfer.firstCall.args[1]).to.deep.equal({ ai: { projects: 0, prompts: 0 } });
  });

  it('does NOT attempt a release when provisioning fails before the workspace is created', async () => {
    // ensureSubworkspace never set the workspace id (e.g. parent-workspace
    // lookup failed inside the handler) → nothing to release.
    const transfer = sinon.stub().resolves({});
    const handler = sinon.stub().rejects(new SerenityTransportError(500, 'early boom'));
    const mod = await esmock('../../../src/support/serenity/brand-provisioning.js', {
      '../../../src/support/serenity/workspace-resolver.js': {
        resolveWorkspaceId: sinon.stub().resolves(PARENT_WS),
      },
      '../../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: () => ({ transferWorkspaceResources: transfer }),
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
    expect(transfer.called).to.equal(false);
  });
});

describe('releaseProvisionedWorkspace', () => {
  function buildAuthedContext() {
    return {
      env: { SEMRUSH_PROJECTS_BASE_URL: 'https://gw.example' },
      pathInfo: { headers: { authorization: 'Bearer test-ims-token' } },
      attributes: { authInfo: { getType: () => 'ims' } },
    };
  }

  async function loadWithTransport(
    transferWorkspaceResources,
    { resolveSemrushImsToken, createSerenityTransport } = {},
  ) {
    const overrides = {
      '../../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: createSerenityTransport
          || (() => ({ transferWorkspaceResources })),
        SerenityTransportError,
      },
    };
    if (resolveSemrushImsToken) {
      overrides['../../../src/support/utils.js'] = { resolveSemrushImsToken };
    }
    return esmock('../../../src/support/serenity/brand-provisioning.js', overrides);
  }

  it('releases the orphaned workspace allocation back to the parent pool', async () => {
    const transfer = sinon.stub().resolves({});
    const { releaseProvisionedWorkspace } = await loadWithTransport(transfer);
    const log = { info: sinon.stub(), error: sinon.stub() };
    await releaseProvisionedWorkspace(buildAuthedContext(), NEW_WS, log);
    expect(transfer.calledOnce).to.equal(true);
    const [wsArg, allocArg] = transfer.firstCall.args;
    expect(wsArg).to.equal(NEW_WS);
    expect(allocArg).to.deep.equal({ ai: { projects: 0, prompts: 0 } });
    expect(log.error.called).to.equal(false);
  });

  it('is a no-op when no workspace id is given', async () => {
    const transfer = sinon.stub().resolves({});
    const { releaseProvisionedWorkspace } = await loadWithTransport(transfer);
    await releaseProvisionedWorkspace(buildAuthedContext(), '', { error: sinon.stub() });
    expect(transfer.called).to.equal(false);
  });

  it('swallows a release failure and logs it at error with the workspace id', async () => {
    const transfer = sinon.stub().rejects(new SerenityTransportError(500, 'boom'));
    const { releaseProvisionedWorkspace } = await loadWithTransport(transfer);
    const log = { info: sinon.stub(), error: sinon.stub() };
    // Must NOT throw — the caller is already on an error path.
    await releaseProvisionedWorkspace(buildAuthedContext(), NEW_WS, log);
    expect(log.error.calledOnce).to.equal(true);
    expect(log.error.firstCall.args[1].semrushWorkspaceId).to.equal(NEW_WS);
  });

  it('resolves the IMS token via resolveSemrushImsToken and forwards it to createSerenityTransport (promise-token path)', async () => {
    const context = {
      env: { SEMRUSH_PROJECTS_BASE_URL: 'https://gw.example' },
      pathInfo: { headers: { 'x-promise-token': 'raw-promise-token' } },
      attributes: { authInfo: { getType: () => 'jwt' } },
    };
    const transfer = sinon.stub().resolves({});
    const resolveSemrushImsTokenStub = sinon.stub().resolves('exchanged-ims-token');
    const createSerenityTransportStub = sinon.stub()
      .returns({ transferWorkspaceResources: transfer });
    const { releaseProvisionedWorkspace } = await loadWithTransport(transfer, {
      resolveSemrushImsToken: resolveSemrushImsTokenStub,
      createSerenityTransport: createSerenityTransportStub,
    });
    const log = { info: sinon.stub(), error: sinon.stub() };

    await releaseProvisionedWorkspace(context, NEW_WS, log);

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
      // The catch on line 140 fires when: handleCreateMarketSubworkspace captures a
      // workspaceId (via brand.setSemrushSubWorkspaceId) and then returns a 4xx result
      // triggering releaseCapturedOnFailure, AND transferWorkspaceResources throws.
      const transfer = sinon.stub().rejects(new Error('release network error'));
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
          createSerenityTransport: () => ({ transferWorkspaceResources: transfer }),
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
      expect(transfer.calledOnce).to.equal(true);
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
