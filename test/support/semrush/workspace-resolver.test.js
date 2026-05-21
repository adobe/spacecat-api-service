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
  clearWorkspaceCache,
  CACHE_TTL_MS,
} from '../../../src/support/semrush/workspace-resolver.js';

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

  it('caches a null workspace too (does not re-hit on misses)', async () => {
    const findById = sandbox.stub().resolves(null);
    const ctx = makeCtx(findById);

    await resolveWorkspaceId(ctx, SPACECAT_ORG);
    await resolveWorkspaceId(ctx, SPACECAT_ORG);

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
