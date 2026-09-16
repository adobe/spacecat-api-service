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

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

describe('handlers/chained-job-guard.js (LLMO-7352/LLMO-7418)', () => {
  let getBrandProvisioningStateStub;
  let log;

  beforeEach(() => {
    getBrandProvisioningStateStub = sinon.stub();
    log = fakeLog();
  });

  afterEach(() => sinon.restore());

  async function load() {
    return esmock('../../../../src/support/serenity/handlers/chained-job-guard.js', {
      '../../../../src/support/brands-storage.js': {
        getBrandProvisioningState: getBrandProvisioningStateStub,
      },
    });
  }

  const call = async (fn) => fn({
    brandId: BRAND_ID,
    workspaceId: WORKSPACE_ID,
    postgrestClient: {},
    log,
    jobName: 'test-job',
  });

  it('allows the job when the brand is still bound to the same workspace', async () => {
    getBrandProvisioningStateStub.resolves({ semrushSubWorkspaceId: WORKSPACE_ID });
    const { assertChainedJobStillApplies } = await load();

    expect(await call(assertChainedJobStillApplies)).to.deep.equal({ ok: true });
  });

  // THE case this guard exists for: deactivate lands between the provisioning worker promoting
  // the workspace and the chained job running. It decommissions the workspace and clears the
  // pointer; creating a project anyway puts live data inside a torn-down workspace.
  it('stops the job when the pointer was CLEARED (brand deactivated mid-chain)', async () => {
    getBrandProvisioningStateStub.resolves({ semrushSubWorkspaceId: null });
    const { assertChainedJobStillApplies } = await load();

    const result = await call(assertChainedJobStillApplies);

    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal('workspace-repointed-or-cleared');
  });

  it('stops the job when the brand was REPOINTED to a different workspace', async () => {
    getBrandProvisioningStateStub.resolves({ semrushSubWorkspaceId: 'a-different-ws' });
    const { assertChainedJobStillApplies } = await load();

    expect((await call(assertChainedJobStillApplies)).ok).to.equal(false);
  });

  it('stops the job when the brand no longer exists', async () => {
    getBrandProvisioningStateStub.resolves(null);
    const { assertChainedJobStillApplies } = await load();

    const result = await call(assertChainedJobStillApplies);

    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal('brand-deleted');
  });

  it('fails OPEN on an unreadable state — a blip is not evidence the brand moved on', async () => {
    // Failing closed here would abandon legitimate market creation on a transient PostgREST
    // error. The guard only stops a job on positive evidence that the brand moved on.
    getBrandProvisioningStateStub.rejects(new Error('postgrest blip'));
    const { assertChainedJobStillApplies } = await load();

    expect(await call(assertChainedJobStillApplies)).to.deep.equal({ ok: true });
    expect(log.warn).to.have.been.calledOnce;
  });
});
