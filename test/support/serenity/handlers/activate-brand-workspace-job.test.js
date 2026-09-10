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
import { activateBrandWorkspaceJobHandler, ACTIVATE_BRAND_WORKSPACE_JOB_TYPE } from '../../../../src/support/serenity/handlers/activate-brand-workspace-job.js';

const BRAND_ID = 'brand-1';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

function makeJob(metadata) {
  return { getId: () => 'job-1', getMetadata: () => metadata };
}

function makeBrand(status) {
  return { getStatus: () => status };
}

describe('handlers/activate-brand-workspace-job.js (Phase 4, LLMO-7352/LLMO-7418)', () => {
  let context;
  let findByIdStub;

  beforeEach(() => {
    findByIdStub = sinon.stub();
    context = {
      log: fakeLog(),
      dataAccess: { Brand: { findById: findByIdStub } },
    };
  });

  it('exports the expected job type constant', () => {
    expect(ACTIVATE_BRAND_WORKSPACE_JOB_TYPE).to.equal('serenity-activate-brand-workspace');
  });

  it('reports 200/active without writing anything when the brand is (still) active — the common case (wasPending: true)', async () => {
    findByIdStub.resolves(makeBrand('active'));
    const job = makeJob({ brandId: BRAND_ID, wasPending: true });

    const result = await activateBrandWorkspaceJobHandler(context, job);

    expect(findByIdStub).to.have.been.calledOnceWith(BRAND_ID);
    expect(result).to.deep.equal({ status: 200, body: { brandId: BRAND_ID, status: 'active', markets: [] } });
  });

  it('reports 200/active without writing anything when the brand is (still) active (wasPending: false)', async () => {
    findByIdStub.resolves(makeBrand('active'));
    const job = makeJob({ brandId: BRAND_ID, wasPending: false });

    const result = await activateBrandWorkspaceJobHandler(context, job);

    expect(result).to.deep.equal({ status: 200, body: { brandId: BRAND_ID, status: 'active', markets: [] } });
  });

  it('never writes — this job has no save/setStatus to call, only a read', async () => {
    const brand = makeBrand('active');
    findByIdStub.resolves(brand);
    const job = makeJob({ brandId: BRAND_ID, wasPending: true });

    await activateBrandWorkspaceJobHandler(context, job);

    // The brand fake exposes only getStatus() — no setStatus/save were even offered, and the
    // handler must not assume they exist or call them. If this test needed a setStatus/save
    // stub to pass, the handler would be writing again.
    expect(brand).to.not.have.property('setStatus');
    expect(brand).to.not.have.property('save');
  });

  it('reports the brand\'s ACTUAL current status (not a manufactured failure) when a concurrent deactivate raced ahead of this chain (wasPending: true)', async () => {
    // promoteProvisioningReady already durably flipped the brand active before this chain was
    // enqueued; finding it 'pending' here means a legitimate /serenity/deactivate ran in
    // between (see the handler's own doc). Must report that truthfully, not re-write 'active'.
    findByIdStub.resolves(makeBrand('pending'));
    const job = makeJob({ brandId: BRAND_ID, wasPending: true });

    const result = await activateBrandWorkspaceJobHandler(context, job);

    expect(result).to.deep.equal({ status: 207, body: { brandId: BRAND_ID, status: 'pending', markets: [] } });
  });

  it('reports the brand\'s ACTUAL current status when a concurrent deactivate raced ahead of this chain (wasPending: false)', async () => {
    findByIdStub.resolves(makeBrand('pending'));
    const job = makeJob({ brandId: BRAND_ID, wasPending: false });

    const result = await activateBrandWorkspaceJobHandler(context, job);

    expect(result).to.deep.equal({ status: 207, body: { brandId: BRAND_ID, status: 'pending', markets: [] } });
  });

  it('logs when the brand is found not-active, for observability', async () => {
    findByIdStub.resolves(makeBrand('pending'));
    const job = makeJob({ brandId: BRAND_ID, wasPending: true });

    await activateBrandWorkspaceJobHandler(context, job);

    expect(context.log.info).to.have.been.calledOnce;
  });

  it('reports 207/deleted instead of throwing when a concurrent hard-delete raced ahead of this chain (LLMO-7418 external-review Medium finding)', async () => {
    findByIdStub.resolves(null);
    const job = makeJob({ brandId: BRAND_ID, wasPending: true });

    const result = await activateBrandWorkspaceJobHandler(context, job);

    expect(result).to.deep.equal({ status: 207, body: { brandId: BRAND_ID, status: 'deleted', markets: [] } });
    expect(context.log.info).to.have.been.calledOnce;
  });

  it('defaults wasPending to false when absent from metadata, without affecting the (read-only) outcome', async () => {
    findByIdStub.resolves(makeBrand('active'));
    const job = makeJob({ brandId: BRAND_ID });

    const result = await activateBrandWorkspaceJobHandler(context, job);

    expect(result.status).to.equal(200);
  });
});
