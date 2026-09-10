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

const BRAND_ID = 'brand-1';
const WORKSPACE_ID = 'sub-ws-1';
const PARENT_WS = 'parent-ws-1';
const ORG_ID = 'org-1';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

function makeJob(metadata) {
  return { getId: () => 'job-1', getMetadata: () => metadata };
}

describe('handlers/create-market-job.js (PR-C, LLMO-7352/LLMO-7418)', () => {
  let orchestrateCreateMarketSubworkspaceStub;
  let createTransportStub;
  let transport;
  let context;

  beforeEach(() => {
    transport = { name: 'transport' };
    createTransportStub = sinon.stub().returns(transport);
    orchestrateCreateMarketSubworkspaceStub = sinon.stub()
      .resolves({ status: 201, body: { brandId: BRAND_ID, geoTargetId: 2840, languageCode: 'en' } });
    context = {
      env: {},
      log: fakeLog(),
      dataAccess: { Brand: {}, services: { postgrestClient: {} } },
    };
  });

  async function loadHandler() {
    return esmock('../../../../src/support/serenity/handlers/create-market-job.js', {
      '../../../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: createTransportStub,
      },
      '../../../../src/support/serenity/handlers/create-market-orchestration.js': {
        orchestrateCreateMarketSubworkspace: orchestrateCreateMarketSubworkspaceStub,
      },
    });
  }

  function makeMetadata(overrides = {}) {
    return {
      brandId: BRAND_ID,
      workspaceId: WORKSPACE_ID,
      parentWorkspaceId: PARENT_WS,
      orgId: ORG_ID,
      requestBody: { market: 'us', languageCode: 'en', brandDomain: 'x.com' },
      ...overrides,
    };
  }

  it('runs the orchestration with the pre-resolved (already-ready) workspace id, skipping ensureSubworkspace', async () => {
    const { createMarketJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata());

    const result = await createMarketJobHandler(context, job, 'token');

    expect(result).to.deep.equal({ status: 201, body: { brandId: BRAND_ID, geoTargetId: 2840, languageCode: 'en' } });
    expect(orchestrateCreateMarketSubworkspaceStub).to.have.been.calledOnce;
    const params = orchestrateCreateMarketSubworkspaceStub.firstCall.args[0];
    expect(params.brandUuid).to.equal(BRAND_ID);
    expect(params.workspaceId).to.equal(WORKSPACE_ID);
    expect(params.preResolvedWorkspaceId).to.equal(WORKSPACE_ID);
    expect(params.parentWorkspaceId).to.equal(PARENT_WS);
    expect(params.orgId).to.equal(ORG_ID);
    expect(params.requestBody).to.deep.equal({ market: 'us', languageCode: 'en', brandDomain: 'x.com' });
    expect(params.transport).to.equal(transport);
  });

  it('builds the transport with the exchanged access token', async () => {
    const { createMarketJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata());

    await createMarketJobHandler(context, job, 'exchanged-token');

    expect(createTransportStub).to.have.been.calledOnceWith({ env: context.env, imsToken: 'exchanged-token' });
  });

  it('defaults suppliedSiteIdentity/suppliedSiteId/callerId when absent from metadata', async () => {
    const { createMarketJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata());

    await createMarketJobHandler(context, job, 'token');

    const params = orchestrateCreateMarketSubworkspaceStub.firstCall.args[0];
    expect(params.suppliedSiteIdentity).to.equal(null);
    expect(params.suppliedSiteId).to.equal(null);
    expect(params.callerId).to.equal('unknown');
  });

  it('forwards a supplied siteId/siteIdentity and callerId through from job metadata', async () => {
    const { createMarketJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata({
      suppliedSiteIdentity: { domain: 'acme.com', primaryUrl: 'acme.com/markets' },
      suppliedSiteId: 'site-onboarded',
      callerId: 'user-123',
    }));

    await createMarketJobHandler(context, job, 'token');

    const params = orchestrateCreateMarketSubworkspaceStub.firstCall.args[0];
    expect(params.suppliedSiteIdentity).to.deep.equal({ domain: 'acme.com', primaryUrl: 'acme.com/markets' });
    expect(params.suppliedSiteId).to.equal('site-onboarded');
    expect(params.callerId).to.equal('user-123');
  });

  it('forwards an explicit modelIds override through from job metadata (PR-C, brand-create initial market)', async () => {
    const { createMarketJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata({ modelIds: ['model-a', 'model-b'] }));

    await createMarketJobHandler(context, job, 'token');

    const params = orchestrateCreateMarketSubworkspaceStub.firstCall.args[0];
    expect(params.modelIds).to.deep.equal(['model-a', 'model-b']);
  });

  it('defaults modelIds to null when absent from job metadata', async () => {
    const { createMarketJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata());

    await createMarketJobHandler(context, job, 'token');

    const params = orchestrateCreateMarketSubworkspaceStub.firstCall.args[0];
    expect(params.modelIds).to.equal(null);
  });

  it('rethrows an error from the orchestration unchanged', async () => {
    orchestrateCreateMarketSubworkspaceStub.rejects(new Error('brand not found'));
    const { createMarketJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata());

    let caught;
    try {
      await createMarketJobHandler(context, job, 'token');
    } catch (e) {
      caught = e;
    }
    expect(caught?.message).to.equal('brand not found');
  });
});
