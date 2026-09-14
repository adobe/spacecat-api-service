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

describe('handlers/activate-markets-job.js (PR-C, LLMO-7352/LLMO-7418)', () => {
  let orchestrateActivateMarketsStub;
  let createTransportStub;
  let transport;
  let context;

  beforeEach(() => {
    transport = { name: 'transport' };
    createTransportStub = sinon.stub().returns(transport);
    orchestrateActivateMarketsStub = sinon.stub()
      .resolves({ status: 200, body: { brandId: BRAND_ID, status: 'active', markets: [] } });
    context = {
      env: {},
      log: fakeLog(),
      dataAccess: { Brand: {}, services: { postgrestClient: {} } },
    };
  });

  async function loadHandler() {
    return esmock('../../../../src/support/serenity/handlers/activate-markets-job.js', {
      '../../../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: createTransportStub,
      },
      '../../../../src/support/serenity/handlers/activate-markets-orchestration.js': {
        orchestrateActivateMarkets: orchestrateActivateMarketsStub,
      },
    });
  }

  function makeMetadata(overrides = {}) {
    return {
      brandId: BRAND_ID,
      workspaceId: WORKSPACE_ID,
      parentWorkspaceId: PARENT_WS,
      orgId: ORG_ID,
      requestBody: {
        markets: [{ market: 'us', languageCode: 'en' }], brandDomain: 'x.com', brandNames: ['X'],
      },
      ...overrides,
    };
  }

  it('runs the orchestration with the pre-resolved (already-ready) workspace id, skipping ensureSubworkspace', async () => {
    const { activateMarketsJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata());

    const result = await activateMarketsJobHandler(context, job, 'token');

    expect(result).to.deep.equal({ status: 200, body: { brandId: BRAND_ID, status: 'active', markets: [] } });
    expect(orchestrateActivateMarketsStub).to.have.been.calledOnce;
    const params = orchestrateActivateMarketsStub.firstCall.args[0];
    expect(params.brandUuid).to.equal(BRAND_ID);
    expect(params.preResolvedWorkspaceId).to.equal(WORKSPACE_ID);
    expect(params.parentWorkspaceId).to.equal(PARENT_WS);
    expect(params.orgId).to.equal(ORG_ID);
    expect(params.requestBody).to.deep.equal({
      markets: [{ market: 'us', languageCode: 'en' }], brandDomain: 'x.com', brandNames: ['X'],
    });
    expect(params.transport).to.equal(transport);
  });

  it('builds the transport with the exchanged access token', async () => {
    const { activateMarketsJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata());

    await activateMarketsJobHandler(context, job, 'exchanged-token');

    expect(createTransportStub).to.have.been.calledOnceWith({ env: context.env, imsToken: 'exchanged-token' });
  });

  it('defaults callerId to unknown when absent from metadata', async () => {
    const { activateMarketsJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata());

    await activateMarketsJobHandler(context, job, 'token');

    const params = orchestrateActivateMarketsStub.firstCall.args[0];
    expect(params.callerId).to.equal('unknown');
  });

  it('forwards a supplied callerId through from job metadata', async () => {
    const { activateMarketsJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata({ callerId: 'user-123' }));

    await activateMarketsJobHandler(context, job, 'token');

    const params = orchestrateActivateMarketsStub.firstCall.args[0];
    expect(params.callerId).to.equal('user-123');
  });

  it('rethrows an error from the orchestration unchanged', async () => {
    orchestrateActivateMarketsStub.rejects(new Error('brand not found'));
    const { activateMarketsJobHandler } = await loadHandler();
    const job = makeJob(makeMetadata());

    let caught;
    try {
      await activateMarketsJobHandler(context, job, 'token');
    } catch (e) {
      caught = e;
    }
    expect(caught?.message).to.equal('brand not found');
  });
});
