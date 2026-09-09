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

function makeBrand({ saveError } = {}) {
  return {
    setStatus: sinon.stub(),
    save: saveError ? sinon.stub().rejects(saveError) : sinon.stub().resolves(),
  };
}

describe('handlers/activate-brand-workspace-job.js (Phase 4, LLMO-7352/LLMO-7418)', () => {
  let context;
  let brand;
  let findByIdStub;

  beforeEach(() => {
    brand = makeBrand();
    findByIdStub = sinon.stub().resolves(brand);
    context = {
      log: fakeLog(),
      dataAccess: { Brand: { findById: findByIdStub } },
    };
  });

  it('exports the expected job type constant', () => {
    expect(ACTIVATE_BRAND_WORKSPACE_JOB_TYPE).to.equal('serenity-activate-brand-workspace');
  });

  it('flips the brand to active and returns 200 on a successful save', async () => {
    const job = makeJob({ brandId: BRAND_ID, wasPending: true });

    const result = await activateBrandWorkspaceJobHandler(context, job);

    expect(findByIdStub).to.have.been.calledOnceWith(BRAND_ID);
    expect(brand.setStatus).to.have.been.calledOnceWith('active');
    expect(brand.save).to.have.been.calledOnce;
    expect(result).to.deep.equal({ status: 200, body: { brandId: BRAND_ID, status: 'active', markets: [] } });
  });

  it('returns 502 with serenityActivationIncomplete when a real pending->active transition fails to save', async () => {
    const saveError = new Error('write conflict');
    brand = makeBrand({ saveError });
    findByIdStub.resolves(brand);
    const job = makeJob({ brandId: BRAND_ID, wasPending: true });

    const result = await activateBrandWorkspaceJobHandler(context, job);

    expect(result).to.deep.equal({
      status: 502,
      body: {
        brandId: BRAND_ID,
        status: 'pending',
        error: 'serenityActivationIncomplete',
        message: 'Sub-workspace provisioned but the active status could not be persisted.',
        markets: [],
      },
    });
    expect(context.log.error).to.have.been.calledOnce;
  });

  it('returns 207 (still active) when a bare-reactivation no-op re-affirm fails to save', async () => {
    const saveError = new Error('transient write failure');
    brand = makeBrand({ saveError });
    findByIdStub.resolves(brand);
    const job = makeJob({ brandId: BRAND_ID, wasPending: false });

    const result = await activateBrandWorkspaceJobHandler(context, job);

    expect(result).to.deep.equal({ status: 207, body: { brandId: BRAND_ID, status: 'active', markets: [] } });
  });

  it('defaults wasPending to false (207, not 502) when absent from metadata', async () => {
    const saveError = new Error('transient write failure');
    brand = makeBrand({ saveError });
    findByIdStub.resolves(brand);
    const job = makeJob({ brandId: BRAND_ID });

    const result = await activateBrandWorkspaceJobHandler(context, job);

    expect(result.status).to.equal(207);
  });
});
