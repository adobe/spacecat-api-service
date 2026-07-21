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
import esmock from 'esmock';
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

  // isMeteredQuota keys on body SHAPE (live-verified, LLMO-6190): a bare string/HTML body is the
  // disguised quota rejection; a JSON object is a genuine app-level error. Mirror the real pinned
  // fixture here, not a JSON guess.
  const quota405 = () => new SerenityTransportError(405, 'Semrush POST .../publish failed: 405', '<html>405 Not Allowed</html>');
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

  // Injectable poll-retry timing (LLMO-6190 follow-up): no real sleeps in tests. `backoffMs: 0` +
  // a no-op `sleep` let the loop iterate at test speed; `totalBudgetMs` is set generously high per
  // test unless the test is specifically exercising the deadline cutoff.
  const fastRetry = (overrides = {}) => ({
    backoffMs: 0,
    sleep: async () => {},
    totalBudgetMs: 60_000,
    ...overrides,
  });

  it('ON, metered 405 then recovery + retry succeeds on the FIRST poll attempt: fn called twice, ensure called ONCE (not per attempt)', async () => {
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    const guard = createHeadroomGuard(
      t,
      {
        enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER, retryOnQuota: fastRetry(),
      },
      log,
    );
    const fn = sinon.stub();
    fn.onFirstCall().rejects(quota405());
    fn.onSecondCall().resolves('recovered');
    const r = await guard.retryOnQuota(fn);
    expect(r).to.equal('recovered');
    expect(fn).to.have.been.calledTwice;
    expect(t.getWorkspaceResources).to.have.been.calledWith(CHILD);
    // Round-2 SRE review: `ensure()` must fire exactly ONCE per recovery, not once per poll
    // attempt — repeated re-checks buy nothing once the total is already correct, and only add
    // per-child lock contention in a concurrent batch.
    expect(t.transferWorkspaceResources).to.have.callCount(0); // already sufficient — a no-op read
    expect(t.getWorkspaceResources.withArgs(CHILD)).to.have.been.calledOnce;
  });

  it('ON, metered 405 persists past the first retry: the SECOND poll attempt succeeds, fn called three times total', async () => {
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    const guard = createHeadroomGuard(
      t,
      {
        enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER, retryOnQuota: fastRetry(),
      },
      log,
    );
    const fn = sinon.stub();
    fn.onCall(0).rejects(quota405());
    fn.onCall(1).rejects(quota405());
    fn.onCall(2).resolves('recovered-on-second-poll-attempt');
    const r = await guard.retryOnQuota(fn);
    expect(r).to.equal('recovered-on-second-poll-attempt');
    expect(fn).to.have.been.calledThrice;
  });

  it('ON, metered 405 exhausts all poll attempts: the LAST error propagates untouched, fn called exactly maxAttempts+1 times', async () => {
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    const guard = createHeadroomGuard(
      t,
      {
        enabled: true,
        subWorkspaceId: CHILD,
        parentWorkspaceId: MASTER,
        retryOnQuota: fastRetry({ maxAttempts: 2 }),
      },
      log,
    );
    const lastError = quota405();
    const fn = sinon.stub();
    fn.onCall(0).rejects(quota405()); // initial call, before the loop
    fn.onCall(1).rejects(quota405()); // poll attempt 1
    fn.onCall(2).rejects(lastError); // poll attempt 2 (== maxAttempts) — exhausted
    let caught;
    try {
      await guard.retryOnQuota(fn);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.equal(lastError);
    expect(fn).to.have.callCount(3);
  });

  it('ON, a NON-metered error surfaces mid-loop: propagates immediately, no further attempts', async () => {
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    const guard = createHeadroomGuard(
      t,
      {
        enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER, retryOnQuota: fastRetry(),
      },
      log,
    );
    const notMetered = otherError();
    const fn = sinon.stub();
    fn.onCall(0).rejects(quota405());
    fn.onCall(1).rejects(notMetered);
    let caught;
    try {
      await guard.retryOnQuota(fn);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.equal(notMetered);
    expect(fn).to.have.callCount(2);
  });

  it('ON, the shared deadline (not the attempt cap) stops retrying: exhausts after the deadline passes even with attempts still available', async () => {
    // maxAttempts is generous, but `now()` is stubbed to jump straight past totalBudgetMs after the
    // first poll attempt — the deadline, not the attempt count, must be what ends the loop (round-2
    // SRE review: this is the seam that bounds a stacked-call-site request, not per-call attempts).
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    let callCount = 0;
    const now = () => {
      callCount += 1;
      // 1st call: guard construction (t0). 2nd+ calls: inside the loop's deadline check — jump
      // straight past the budget so the very first deadline check already fails.
      return callCount <= 1 ? 0 : 1_000_000;
    };
    const guard = createHeadroomGuard(
      t,
      {
        enabled: true,
        subWorkspaceId: CHILD,
        parentWorkspaceId: MASTER,
        retryOnQuota: fastRetry({ maxAttempts: 10, totalBudgetMs: 9000, now }),
      },
      log,
    );
    const lastError = quota405();
    const fn = sinon.stub();
    fn.onCall(0).rejects(quota405());
    fn.onCall(1).rejects(lastError);
    let caught;
    try {
      await guard.retryOnQuota(fn);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.equal(lastError);
    // initial call + exactly ONE poll attempt before the deadline cuts it off
    expect(fn).to.have.callCount(2);
  });

  it('ON, the deadline is SHARED across two sequential retryOnQuota calls on the SAME guard, not recomputed per call (MysticatBot review)', async () => {
    // This is the PR's key design intent: one guard is built per inbound request, and every wrap
    // site sharing that guard instance (e.g. createProject -> createPromptsByIds ->
    // publishProject in one create-market request) must share ONE budget. A regression that moved
    // `requestDeadline` inside `retryOnQuota` itself (recomputing "now + totalBudgetMs" on every
    // call) would pass every other test in this file, since they all call `retryOnQuota` only once
    // per guard.
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    // A simple mutable clock the test advances directly, standing in for wall-clock time elapsing
    // between two call sites in the same request (unrelated work — tag provisioning, etc.).
    let clock = 0;
    const now = () => clock;
    const guard = createHeadroomGuard(
      t,
      {
        enabled: true,
        subWorkspaceId: CHILD,
        parentWorkspaceId: MASTER,
        retryOnQuota: fastRetry({
          maxAttempts: 10, totalBudgetMs: 100, now,
        }),
      },
      log,
    );

    // Call site A: recovers on the first poll attempt — well within budget, consumes no clock time.
    const fnA = sinon.stub();
    fnA.onFirstCall().rejects(quota405());
    fnA.onSecondCall().resolves('a-ok');
    expect(await guard.retryOnQuota(fnA, { callSite: 'A' })).to.equal('a-ok');

    // Time passes between the two call sites (other work in the same request) — past the ORIGINAL
    // guard's budget, even though `maxAttempts: 10` would otherwise allow many more poll attempts.
    clock = 150;

    // Call site B: if the deadline were shared (correct), it's already past — B exhausts on its
    // very first poll attempt despite `maxAttempts: 10`. If a regression recomputed the deadline
    // fresh inside this call (bug), B would get a full new 100ms budget from clock=150 and NOT
    // exhaust here.
    const lastError = quota405();
    const fnB = sinon.stub();
    fnB.onFirstCall().rejects(quota405());
    fnB.onSecondCall().rejects(lastError);
    let caught;
    try {
      await guard.retryOnQuota(fnB, { callSite: 'B' });
    } catch (e) {
      caught = e;
    }
    expect(caught).to.equal(lastError);
    expect(fnB).to.have.callCount(2);
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

describe('dynamic-allocation-active — retryOnQuota emits QuotaRetryOutcome (MysticatBot review)', () => {
  afterEach(() => {
    sinon.restore();
    clearResourceLocks();
  });

  const quota405 = () => new SerenityTransportError(405, 'Semrush POST .../publish failed: 405', '<html>405 Not Allowed</html>');
  const fastRetry = (overrides = {}) => ({
    backoffMs: 0,
    sleep: async () => {},
    totalBudgetMs: 60_000,
    ...overrides,
  });

  it('recovered: emits QuotaRetryOutcome("recovered", { attempt, callSite }) with the attempt it resolved on', async () => {
    const recordQuotaRetryOutcome = sinon.stub();
    const { createHeadroomGuard: mockedCreateHeadroomGuard } = await esmock(
      '../../../src/support/serenity/dynamic-allocation-active.js',
      { '../../../src/support/serenity/allocation-metrics.js': { recordQuotaRetryOutcome } },
    );
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    const guard = mockedCreateHeadroomGuard(
      t,
      {
        enabled: true, subWorkspaceId: CHILD, parentWorkspaceId: MASTER, retryOnQuota: fastRetry(),
      },
      log,
    );
    const fn = sinon.stub();
    fn.onCall(0).rejects(quota405());
    fn.onCall(1).rejects(quota405());
    fn.onCall(2).resolves('ok');
    const r = await guard.retryOnQuota(fn, { callSite: 'publishProject' });
    expect(r).to.equal('ok');
    expect(recordQuotaRetryOutcome).to.have.been.calledOnceWith(
      'recovered',
      { attempt: 2, callSite: 'publishProject' },
    );
  });

  it('exhausted: emits QuotaRetryOutcome("exhausted", { attempt, callSite }) with the attempt it gave up on', async () => {
    const recordQuotaRetryOutcome = sinon.stub();
    const { createHeadroomGuard: mockedCreateHeadroomGuard } = await esmock(
      '../../../src/support/serenity/dynamic-allocation-active.js',
      { '../../../src/support/serenity/allocation-metrics.js': { recordQuotaRetryOutcome } },
    );
    const t = makeTransport({
      child: resources(dimObj(0, 0, 0), dimObj(0, 0, 0)),
      master: resources(dimObj(0, 0, 100), dimObj(0, 0, 800)),
    });
    const guard = mockedCreateHeadroomGuard(
      t,
      {
        enabled: true,
        subWorkspaceId: CHILD,
        parentWorkspaceId: MASTER,
        retryOnQuota: fastRetry({ maxAttempts: 2 }),
      },
      log,
    );
    const lastError = quota405();
    const fn = sinon.stub();
    fn.onCall(0).rejects(quota405());
    fn.onCall(1).rejects(quota405());
    fn.onCall(2).rejects(lastError);
    let caught;
    try {
      await guard.retryOnQuota(fn, { callSite: 'createOnePrompt' });
    } catch (e) {
      caught = e;
    }
    expect(caught).to.equal(lastError);
    expect(recordQuotaRetryOutcome).to.have.been.calledOnceWith(
      'exhausted',
      { attempt: 2, callSite: 'createOnePrompt' },
    );
  });
});
