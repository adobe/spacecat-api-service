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
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

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

  it('defaults the ceiling to DEFAULT_BRAND_AI_CEILING (generous — a realistic top-up does NOT 409)', async () => {
    // Regression guard (LLMO-6190 item 2): if the default ever shrank enough to be enforcing, this
    // would start throwing brandAiLimit for an ordinary large top-up with no explicit ceiling.
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 5_000_000), dimObj(0, 0, 5_000_000_000)),
    });
    const guard = createHeadroomGuard(
      t,
      { enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER },
      log,
    );
    const r = await guard.ensure({ prompts: 5000 });
    expect(r.toppedUp).to.equal(true);
    expect(t.transferWorkspaceResources).to.have.been.calledOnce;
  });
});

describe('dynamic-allocation-active — createHeadroomGuard.retryOnQuota', () => {
  afterEach(() => clearResourceLocks());

  const quota405 = () => new SerenityTransportError(405, 'Semrush POST .../publish failed: 405', { message: 'quota exceeded' });
  const otherError = () => new SerenityTransportError(404, 'not found', { message: 'not found' });

  it('OFF: pure passthrough — fn called once, zero transport/ensure calls, even on failure', async () => {
    const t = makeTransport();
    const guard = createHeadroomGuard(
      t,
      { enabled: false, subWorkspaceId: '', parentWorkspaceId: '' },
      log,
    );
    const fn = sinon.stub().rejects(quota405());
    await expect(guard.retryOnQuota(fn)).to.be.rejectedWith(SerenityTransportError);
    expect(fn).to.have.been.calledOnce;
    expect(t.getWorkspaceResources).to.not.have.been.called;
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('ON, fn succeeds first try: exactly one fn call, zero ensure/transport calls', async () => {
    const t = makeTransport();
    const guard = createHeadroomGuard(
      t,
      { enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER },
      log,
    );
    const fn = sinon.stub().resolves('ok');
    const r = await guard.retryOnQuota(fn);
    expect(r).to.equal('ok');
    expect(fn).to.have.been.calledOnce;
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });

  it('ON, fn throws a NON-metered error: rethrown immediately, ensure never called, fn called once', async () => {
    const t = makeTransport();
    const guard = createHeadroomGuard(
      t,
      { enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER },
      log,
    );
    const fn = sinon.stub().rejects(otherError());
    await expect(guard.retryOnQuota(fn)).to.be.rejectedWith(SerenityTransportError, /not found/);
    expect(fn).to.have.been.calledOnce;
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });

  it('ON, metered 405 then recovery + retry succeeds: fn called twice, ensure called once with includeDrafted', async () => {
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    const guard = createHeadroomGuard(
      t,
      { enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER },
      log,
    );
    const fn = sinon.stub();
    fn.onFirstCall().rejects(quota405());
    fn.onSecondCall().resolves('recovered');
    const r = await guard.retryOnQuota(fn);
    expect(r).to.equal('recovered');
    expect(fn).to.have.been.calledTwice;
    expect(t.getWorkspaceResources).to.have.been.calledWith(CHILD);
  });

  it('ON, metered 405 persists on retry: the SECOND error propagates untouched, fn called exactly twice (no third call)', async () => {
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    const guard = createHeadroomGuard(
      t,
      { enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER },
      log,
    );
    const secondError = quota405();
    const fn = sinon.stub();
    fn.onFirstCall().rejects(quota405());
    fn.onSecondCall().rejects(secondError);
    let caught;
    try {
      await guard.retryOnQuota(fn);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.equal(secondError);
    expect(fn).to.have.been.calledTwice;
  });

  it('ON, the recovery ensure() itself throws (e.g. org pool exhausted): that error propagates and fn is NOT retried', async () => {
    // child has a drafted-but-not-yet-used prompt surplus, so `ensure({}, {includeDrafted:true})`
    // actually needs a top-up (required=10 > total=0) and reaches the transfer — which we stub to
    // reject as pool-exhausted, so ensureAiHeadroom's transfer hits the terminal mapping inside
    // ensure(). fn must not be called a second time.
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 10, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    t.transferWorkspaceResources = sinon.stub().rejects(
      new SerenityTransportError(422, 'insufficient available units in subscription', { message: 'insufficient available units in subscription' }),
    );
    const guard = createHeadroomGuard(
      t,
      { enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER },
      log,
    );
    const fn = sinon.stub().rejects(quota405());
    let caught;
    try {
      await guard.retryOnQuota(fn);
    } catch (e) {
      caught = e;
    }
    expect(caught?.code).to.equal('orgPoolExhausted');
    expect(fn).to.have.been.calledOnce;
  });

  it('ON: fn itself is NOT wrapped in the per-child lock — an independent metered write is not serialized behind it', async () => {
    // Only the recovery `ensure()` call goes through withResourceLock; `fn` (the publish itself) is
    // the caller's own transport call and must not be queued behind another child's chain.
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    const guard = createHeadroomGuard(
      t,
      { enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER },
      log,
    );
    let fnStarted = false;
    const fn = sinon.stub().callsFake(async () => {
      fnStarted = true;
      return 'ok';
    });
    // A concurrent ensure() call on the SAME child occupies the lock; retryOnQuota's own fn() call
    // (no prior 405) must still run immediately rather than queueing behind it.
    const blocker = guard.ensure({ projects: 1 });
    await guard.retryOnQuota(fn);
    expect(fnStarted).to.equal(true);
    await blocker;
  });
});
