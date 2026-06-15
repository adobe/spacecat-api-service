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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  resolveWorkspaceId,
  resolveBrandWorkspace,
  clearWorkspaceCache,
  clearBrandWorkspaceCache,
  CACHE_TTL_MS,
  NEG_TTL_MS,
  MAX_ENTRIES,
} from '../../../src/support/serenity/workspace-resolver.js';

use(chaiAsPromised);
use(sinonChai);

const SPACECAT_ORG = 'org-aaa-111';
const WORKSPACE = 'workspace-xyz';

function makeCtx(findByIdStub) {
  return {
    dataAccess: {
      Organization: {
        findById: findByIdStub,
      },
    },
  };
}

function makeOrg(workspaceId) {
  return {
    getSemrushWorkspaceId: () => workspaceId,
  };
}

describe('resolveWorkspaceId', () => {
  const sandbox = sinon.createSandbox();
  let clock;

  beforeEach(() => {
    clearWorkspaceCache();
  });

  afterEach(() => {
    if (clock) {
      clock.restore();
      clock = undefined;
    }
    sandbox.restore();
  });

  it('returns null when spaceCatId is missing or blank', async () => {
    const ctx = makeCtx(sandbox.stub());
    expect(await resolveWorkspaceId(ctx, '')).to.equal(null);
    expect(await resolveWorkspaceId(ctx, undefined)).to.equal(null);
    expect(await resolveWorkspaceId(ctx, null)).to.equal(null);
    expect(ctx.dataAccess.Organization.findById).to.not.have.been.called;
  });

  it('returns the workspace id for an onboarded org', async () => {
    const findById = sandbox.stub().resolves(makeOrg(WORKSPACE));
    const result = await resolveWorkspaceId(makeCtx(findById), SPACECAT_ORG);
    expect(result).to.equal(WORKSPACE);
    expect(findById).to.have.been.calledOnceWithExactly(SPACECAT_ORG);
  });

  it('returns null when the org has no semrush_workspace_id', async () => {
    const findById = sandbox.stub().resolves(makeOrg(null));
    const result = await resolveWorkspaceId(makeCtx(findById), SPACECAT_ORG);
    expect(result).to.equal(null);
  });

  it('returns null when the org is not found at all', async () => {
    const findById = sandbox.stub().resolves(null);
    const result = await resolveWorkspaceId(makeCtx(findById), SPACECAT_ORG);
    expect(result).to.equal(null);
  });

  it('caches the resolved workspace id within the TTL', async () => {
    const findById = sandbox.stub().resolves(makeOrg(WORKSPACE));
    const ctx = makeCtx(findById);

    await resolveWorkspaceId(ctx, SPACECAT_ORG);
    await resolveWorkspaceId(ctx, SPACECAT_ORG);
    await resolveWorkspaceId(ctx, SPACECAT_ORG);

    expect(findById).to.have.been.calledOnce;
  });

  it('caches a null workspace briefly (negative TTL) — does not re-hit immediately', async () => {
    const findById = sandbox.stub().resolves(null);
    const ctx = makeCtx(findById);

    await resolveWorkspaceId(ctx, SPACECAT_ORG);
    await resolveWorkspaceId(ctx, SPACECAT_ORG);

    expect(findById).to.have.been.calledOnce;
  });

  it('expires negative entries after NEG_TTL_MS — newly-onboarded orgs unblock fast', async () => {
    clock = sandbox.useFakeTimers({ now: 1_700_000_000_000, shouldAdvanceTime: false });
    const findById = sandbox.stub();
    findById.onFirstCall().resolves(null);
    findById.onSecondCall().resolves(makeOrg(WORKSPACE));
    const ctx = makeCtx(findById);

    expect(await resolveWorkspaceId(ctx, SPACECAT_ORG)).to.equal(null);

    clock.tick(NEG_TTL_MS + 1);
    expect(await resolveWorkspaceId(ctx, SPACECAT_ORG)).to.equal(WORKSPACE);
    expect(findById).to.have.been.calledTwice;
  });

  it('evicts the oldest entry once the cache exceeds MAX_ENTRIES', async () => {
    const findById = sandbox.stub().callsFake((id) => Promise.resolve(makeOrg(`ws-${id}`)));
    const ctx = makeCtx(findById);

    // Fill the cache slightly over the cap.
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await resolveWorkspaceId(ctx, `org-${i}`);
    }
    // The earliest entries should have been evicted; re-querying them
    // re-hits the data layer.
    findById.resetHistory();
    await resolveWorkspaceId(ctx, 'org-0');
    expect(findById).to.have.been.calledOnce;
  });

  it('expires the cache after CACHE_TTL_MS', async () => {
    clock = sandbox.useFakeTimers({ now: 1_700_000_000_000, shouldAdvanceTime: false });
    const findById = sandbox.stub().resolves(makeOrg(WORKSPACE));
    const ctx = makeCtx(findById);

    await resolveWorkspaceId(ctx, SPACECAT_ORG);
    expect(findById).to.have.been.calledOnce;

    // Just inside the TTL: still cached.
    clock.tick(CACHE_TTL_MS - 1);
    await resolveWorkspaceId(ctx, SPACECAT_ORG);
    expect(findById).to.have.been.calledOnce;

    // Just past the TTL: re-fetch.
    clock.tick(2);
    await resolveWorkspaceId(ctx, SPACECAT_ORG);
    expect(findById).to.have.been.calledTwice;
  });

  it('keeps separate cache entries per spaceCatId', async () => {
    const findById = sandbox.stub();
    findById.withArgs('org-A').resolves(makeOrg('workspace-A'));
    findById.withArgs('org-B').resolves(makeOrg('workspace-B'));
    const ctx = makeCtx(findById);

    expect(await resolveWorkspaceId(ctx, 'org-A')).to.equal('workspace-A');
    expect(await resolveWorkspaceId(ctx, 'org-B')).to.equal('workspace-B');
    expect(await resolveWorkspaceId(ctx, 'org-A')).to.equal('workspace-A');

    expect(findById).to.have.been.calledTwice;
  });

  it('throws when context is missing the Organization data-access', async () => {
    await expect(resolveWorkspaceId({}, SPACECAT_ORG))
      .to.be.rejectedWith(/Organization data-access not available/);
    await expect(resolveWorkspaceId({ dataAccess: {} }, SPACECAT_ORG))
      .to.be.rejectedWith(/Organization data-access not available/);
  });
});

const BRAND_ID = 'brand-bbb-222';
const SUB_WS = 'subworkspace-ws-777';

function makeBrand(subworkspaceId) {
  return {
    getSemrushWorkspaceId: () => subworkspaceId,
  };
}

function makeDualCtx({ brandFindById, orgFindById } = {}) {
  return {
    dataAccess: {
      Brand: { findById: brandFindById },
      Organization: { findById: orgFindById },
    },
  };
}

describe('resolveBrandWorkspace', () => {
  const sandbox = sinon.createSandbox();
  let clock;

  beforeEach(() => {
    clearWorkspaceCache();
    clearBrandWorkspaceCache();
  });

  afterEach(() => {
    if (clock) {
      clock.restore();
      clock = undefined;
    }
    sandbox.restore();
  });

  it('returns subworkspace mode with the brand subworkspace and the resolved parent', async () => {
    const brandFindById = sandbox.stub().resolves(makeBrand(SUB_WS));
    const orgFindById = sandbox.stub().resolves(makeOrg('parent-ws'));
    const ctx = makeDualCtx({ brandFindById, orgFindById });

    const res = await resolveBrandWorkspace(ctx, SPACECAT_ORG, BRAND_ID);

    // The parent is resolved alongside the sub-workspace so activate can mint a
    // fresh sub-workspace without a second org lookup.
    expect(res).to.deep.equal({
      mode: 'subworkspace', workspaceId: SUB_WS, parentWorkspaceId: 'parent-ws',
    });
  });

  it('returns flat mode with the org parent workspace when the column is absent', async () => {
    const brandFindById = sandbox.stub().resolves(makeBrand(null));
    const orgFindById = sandbox.stub().resolves(makeOrg('parent-ws'));
    const ctx = makeDualCtx({ brandFindById, orgFindById });

    const res = await resolveBrandWorkspace(ctx, SPACECAT_ORG, BRAND_ID);

    expect(res).to.deep.equal({
      mode: 'flat', workspaceId: 'parent-ws', parentWorkspaceId: 'parent-ws',
    });
  });

  it('returns flat mode with a null workspace when the org has no parent', async () => {
    const brandFindById = sandbox.stub().resolves(makeBrand(undefined));
    const orgFindById = sandbox.stub().resolves(makeOrg(null));
    const ctx = makeDualCtx({ brandFindById, orgFindById });

    const res = await resolveBrandWorkspace(ctx, SPACECAT_ORG, BRAND_ID);

    expect(res).to.deep.equal({ mode: 'flat', workspaceId: null, parentWorkspaceId: null });
  });

  it('treats a missing brand row as flat mode', async () => {
    const brandFindById = sandbox.stub().resolves(null);
    const orgFindById = sandbox.stub().resolves(makeOrg('parent-ws'));
    const ctx = makeDualCtx({ brandFindById, orgFindById });

    const res = await resolveBrandWorkspace(ctx, SPACECAT_ORG, BRAND_ID);

    expect(res).to.deep.equal({
      mode: 'flat', workspaceId: 'parent-ws', parentWorkspaceId: 'parent-ws',
    });
  });

  it('caches the subworkspace lookup over the positive TTL window', async () => {
    clock = sinon.useFakeTimers({ now: 0, toFake: ['Date'] });
    const brandFindById = sandbox.stub().resolves(makeBrand(SUB_WS));
    const ctx = makeDualCtx({ brandFindById, orgFindById: sandbox.stub() });

    await resolveBrandWorkspace(ctx, SPACECAT_ORG, BRAND_ID);
    clock.tick(CACHE_TTL_MS - 1);
    await resolveBrandWorkspace(ctx, SPACECAT_ORG, BRAND_ID);

    expect(brandFindById).to.have.been.calledOnce;
  });

  it('re-reads the brand after the positive TTL expires', async () => {
    clock = sinon.useFakeTimers({ now: 0, toFake: ['Date'] });
    const brandFindById = sandbox.stub().resolves(makeBrand(SUB_WS));
    const ctx = makeDualCtx({ brandFindById, orgFindById: sandbox.stub() });

    await resolveBrandWorkspace(ctx, SPACECAT_ORG, BRAND_ID);
    clock.tick(CACHE_TTL_MS + 1);
    await resolveBrandWorkspace(ctx, SPACECAT_ORG, BRAND_ID);

    expect(brandFindById).to.have.been.calledTwice;
  });

  it('uses the shorter negative TTL for a flat (no subworkspace) brand', async () => {
    clock = sinon.useFakeTimers({ now: 0, toFake: ['Date'] });
    const brandFindById = sandbox.stub().resolves(makeBrand(null));
    const ctx = makeDualCtx({ brandFindById, orgFindById: sandbox.stub().resolves(makeOrg('p')) });

    await resolveBrandWorkspace(ctx, SPACECAT_ORG, BRAND_ID);
    clock.tick(NEG_TTL_MS + 1);
    await resolveBrandWorkspace(ctx, SPACECAT_ORG, BRAND_ID);

    expect(brandFindById).to.have.been.calledTwice;
  });

  it('returns flat mode when brandId is blank (no Brand lookup)', async () => {
    const brandFindById = sandbox.stub();
    const ctx = makeDualCtx({ brandFindById, orgFindById: sandbox.stub().resolves(makeOrg('p')) });

    const res = await resolveBrandWorkspace(ctx, SPACECAT_ORG, '');

    expect(res).to.deep.equal({ mode: 'flat', workspaceId: 'p', parentWorkspaceId: 'p' });
    expect(brandFindById).to.not.have.been.called;
  });

  it('evicts the oldest brand entry past MAX_ENTRIES', async () => {
    const brandFindById = sandbox.stub().callsFake((id) => Promise.resolve(makeBrand(`ws-${id}`)));
    const ctx = makeDualCtx({ brandFindById, orgFindById: sandbox.stub() });

    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await resolveBrandWorkspace(ctx, SPACECAT_ORG, `brand-${i}`);
    }

    // The oldest (brand-0) was evicted, so resolving it again re-reads.
    const callsBefore = brandFindById.callCount;
    await resolveBrandWorkspace(ctx, SPACECAT_ORG, 'brand-0');
    expect(brandFindById.callCount).to.equal(callsBefore + 1);
  });

  it('throws when context is missing the Brand data-access', async () => {
    await expect(resolveBrandWorkspace({ dataAccess: {} }, SPACECAT_ORG, BRAND_ID))
      .to.be.rejectedWith(/Brand data-access not available/);
  });
});
