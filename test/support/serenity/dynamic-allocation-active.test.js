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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import {
  isDynamicAllocationEnabled,
  createHeadroomGuard,
  DYNAMIC_ALLOCATION_ENV_FLAG,
} from '../../../src/support/serenity/dynamic-allocation-active.js';
import { clearResourceLocks } from '../../../src/support/serenity/resource-lock.js';

use(sinonChai);

const CHILD = 'child-ws';
const MASTER = 'master-ws';
const log = { info: () => {}, warn: () => {}, error: () => {} };

const dimObj = (used, drafted, total) => ({ used, drafted, total });
const resources = (projects, prompts) => ({
  product_resources: { ai: { resources: { projects, prompts } } },
});

function makeTransport({ child, master } = {}) {
  const ample = resources(dimObj(0, 0, 100), dimObj(0, 0, 800));
  const getWorkspaceResources = sinon.stub();
  getWorkspaceResources.withArgs(CHILD).resolves(child ?? ample);
  getWorkspaceResources.withArgs(MASTER).resolves(master ?? ample);
  return {
    getWorkspaceResources,
    transferWorkspaceResources: sinon.stub().resolves(),
    getWorkspaceStatus: sinon.stub().resolves({ status: 'created' }),
  };
}

describe('dynamic-allocation-active — isDynamicAllocationEnabled', () => {
  it('is true ONLY for the exact string "true"', () => {
    expect(isDynamicAllocationEnabled({ [DYNAMIC_ALLOCATION_ENV_FLAG]: 'true' })).to.equal(true);
  });

  it('is false for unset, "false", "TRUE", "1", boolean true, or no env (fail-safe OFF)', () => {
    expect(isDynamicAllocationEnabled({})).to.equal(false);
    expect(isDynamicAllocationEnabled({ [DYNAMIC_ALLOCATION_ENV_FLAG]: 'false' })).to.equal(false);
    expect(isDynamicAllocationEnabled({ [DYNAMIC_ALLOCATION_ENV_FLAG]: 'TRUE' })).to.equal(false);
    expect(isDynamicAllocationEnabled({ [DYNAMIC_ALLOCATION_ENV_FLAG]: '1' })).to.equal(false);
    expect(isDynamicAllocationEnabled({ [DYNAMIC_ALLOCATION_ENV_FLAG]: true })).to.equal(false);
    expect(isDynamicAllocationEnabled(undefined)).to.equal(false);
  });
});

describe('dynamic-allocation-active — createHeadroomGuard', () => {
  afterEach(() => clearResourceLocks());

  it('OFF: a genuine no-op — enabled=false and ZERO transport calls', async () => {
    const t = makeTransport();
    const guard = createHeadroomGuard(
      t,
      { enabled: false, subWorkspaceId: CHILD, parentWorkspaceId: MASTER },
      log,
    );
    expect(guard.enabled).to.equal(false);
    const r = await guard.ensure({ prompts: 100 }, { includeDrafted: true });
    expect(r).to.deep.equal({ toppedUp: false });
    expect(t.getWorkspaceResources).to.not.have.been.called;
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('ON with ids: routes ensure() through ensureAiHeadroom (reads child, tops up short dim)', async () => {
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    const guard = createHeadroomGuard(
      t,
      { enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER },
      log,
    );
    expect(guard.enabled).to.equal(true);
    const r = await guard.ensure({ projects: 1 });
    expect(r.toppedUp).to.equal(true);
    expect(t.getWorkspaceResources).to.have.been.calledWith(CHILD);
    expect(t.transferWorkspaceResources).to.have.been.calledOnce;
  });

  it('ON but missing parentWorkspaceId: FAILS LOUD at construction (never silently no-ops)', () => {
    // A silent no-op here would mean "flag ON but not actually metering" — the exact failure mode a
    // kill-switch rollout must not have (Rainer's review). Throws BEFORE any transport call.
    const t = makeTransport();
    expect(() => createHeadroomGuard(t, { enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: '' }, log)).to.throw(/requires a non-empty parentWorkspaceId/);
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });

  it('ON but missing subWorkspaceId: FAILS LOUD at construction', () => {
    const t = makeTransport();
    expect(() => createHeadroomGuard(t, { enabled: true, subWorkspaceId: '', parentWorkspaceId: MASTER }, log)).to.throw(/requires a non-empty subWorkspaceId/);
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });

  it('OFF with missing ids: still a genuine no-op (the flag gate is checked first)', async () => {
    // Disabled must never throw regardless of id presence — OFF stays byte-for-byte a no-op even
    // when the caller hasn't resolved a parent workspace at all (today's common case pre-rollout).
    const t = makeTransport();
    const guard = createHeadroomGuard(t, { enabled: false, subWorkspaceId: '', parentWorkspaceId: '' }, log);
    expect(guard.enabled).to.equal(false);
    const r = await guard.ensure({ projects: 1 });
    expect(r).to.deep.equal({ toppedUp: false });
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });

  it('serializes concurrent ensure() calls against the same child — the 2nd reads the 1st\'s write', async () => {
    // STATEFUL stub: the child's `total` reflects the last absolute transfer. Two concurrent
    // top-ups each needing +1 project. WITH the lock, op1 tops projects 0→1 and op2 then reads
    // total=1 (used=0) → already covered → NO second transfer. WITHOUT the lock both read the stale
    // total=0 and both transfer (a lost-update clobber). Asserting exactly ONE transfer proves the
    // critical section actually serializes the read-then-absolute-set.
    const childState = { projects: dimObj(0, 0, 0), prompts: dimObj(0, 0, 0) };
    const t = makeTransport();
    t.getWorkspaceResources = sinon.stub().callsFake(async (id) => (id === CHILD
      ? resources(childState.projects, childState.prompts)
      : resources(dimObj(0, 0, 100), dimObj(0, 0, 800))));
    t.transferWorkspaceResources = sinon.stub().callsFake(async (id, payload) => {
      if (id === CHILD) {
        childState.projects = dimObj(0, 0, payload.ai.projects);
        childState.prompts = dimObj(0, 0, payload.ai.prompts);
      }
      return null;
    });
    const guard = createHeadroomGuard(
      t,
      { enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER },
      log,
    );
    await Promise.all([guard.ensure({ projects: 1 }), guard.ensure({ projects: 1 })]);
    expect(t.transferWorkspaceResources).to.have.callCount(1);
    expect(childState.projects.total).to.equal(1);
  });
});
