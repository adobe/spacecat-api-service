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
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';
import { ErrorWithStatusCode } from '../../../src/support/utils.js';
import {
  roundUpToBlock, modelChangeUnits, readAiTotals,
  ensureAiHeadroom, releaseAiSurplus, DEFAULT_BLOCKS, DEFAULT_POLL,
} from '../../../src/support/serenity/resource-manager.js';

use(chaiAsPromised);
use(sinonChai);

const CHILD = 'child-ws';
const MASTER = 'master-ws';
const log = { info: () => {}, warn: () => {}, error: () => {} };
// Fast poll: created immediately, no real sleep.
const poll = { attempts: 3, intervalMs: 0, sleep: () => Promise.resolve() };

const dim = (used, drafted, total) => ({ used, drafted, total });
const resources = (projects, prompts) => ({
  product_resources: { ai: { resources: { projects, prompts } } },
});
/** Expected transfer payload. */
const ai = (projects, prompts) => ({ ai: { projects, prompts } });
const notReady = () => new SerenityTransportError(422, 'x', { message: 'workspace not ready' });
const poolFull = () => new SerenityTransportError(422, 'x', { message: 'insufficient available units in subscription' });

/** Transport stub: per-workspace resources + transfer + status(created). */
function makeTransport({ child, master, transfer } = {}) {
  const getWorkspaceResources = sinon.stub();
  getWorkspaceResources.withArgs(CHILD).resolves(child);
  getWorkspaceResources.withArgs(MASTER).resolves(master);
  return {
    getWorkspaceResources,
    transferWorkspaceResources: transfer || sinon.stub().resolves(),
    getWorkspaceStatus: sinon.stub().resolves({ status: 'created' }),
  };
}

describe('resource-manager — pure helpers', () => {
  it('roundUpToBlock: 0/negative → 0, else next whole block', () => {
    expect(roundUpToBlock(0, 100)).to.equal(0);
    expect(roundUpToBlock(-5, 100)).to.equal(0);
    expect(roundUpToBlock(1, 100)).to.equal(100);
    expect(roundUpToBlock(100, 100)).to.equal(100);
    expect(roundUpToBlock(101, 100)).to.equal(200);
    expect(roundUpToBlock(3, 1)).to.equal(3);
  });

  it('modelChangeUnits: publishedTexts × Δmodels, clamps a swap/removal (Δ ≤ 0) to 0', () => {
    expect(modelChangeUnits(10, 1)).to.equal(10); // net add of 1 model over 10 texts
    expect(modelChangeUnits(200, 2)).to.equal(400);
    expect(modelChangeUnits(10, 0)).to.equal(0); // swap (net 0) → no top-up
    expect(modelChangeUnits(10, -1)).to.equal(0); // net removal → no top-up (release handles it)
    expect(modelChangeUnits(-3, 2)).to.equal(0); // negative texts clamped
  });

  it('readAiTotals: strict nested accessor, drafted defaults to 0', () => {
    expect(readAiTotals(resources(dim(1, 0, 5), dim(2, 3, 50)))).to.deep.equal({
      projects: dim(1, 0, 5), prompts: dim(2, 3, 50),
    });
    // drafted missing → 0
    expect(readAiTotals(resources({ used: 1, total: 5 }, { used: 0, total: 10 })).projects.drafted)
      .to.equal(0);
  });

  it('readAiTotals: fails loud on missing ai block or dimension', () => {
    expect(() => readAiTotals({})).to.throw(/product_resources.ai.resources missing/);
    expect(() => readAiTotals(resources(undefined, dim(0, 0, 10)))).to.throw(/ai.resources.projects/);
    expect(() => readAiTotals(resources({ used: 'x', total: 5 }, dim(0, 0, 10)))).to.throw(/projects/);
  });
});

describe('resource-manager — ensureAiHeadroom', () => {
  it('fails LOUD on a missing/blank subWorkspaceId or parentWorkspaceId — no transport call', async () => {
    const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 800)) });
    await expect(ensureAiHeadroom(t, {
      subWorkspaceId: '', parentWorkspaceId: MASTER, need: { prompts: 100 },
    }, log)).to.be.rejectedWith(/requires a non-empty subWorkspaceId/);
    await expect(ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: '   ', need: { prompts: 100 },
    }, log)).to.be.rejectedWith(/requires a non-empty parentWorkspaceId/);
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });

  it('hot path: already covered → no transfer, no poll', async () => {
    const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 800)) });
    const r = await ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: MASTER, need: { projects: 1, prompts: 100 },
    }, log);
    expect(r.toppedUp).to.equal(false);
    expect(t.transferWorkspaceResources).to.not.have.been.called;
    expect(t.getWorkspaceResources).to.have.been.calledOnceWith(CHILD); // master never read
  });

  it('need = 0 (or absent) is a true no-op — zero transport writes', async () => {
    const t = makeTransport({ child: resources(dim(2, 0, 2), dim(800, 0, 800)) });
    const r = await ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: MASTER, need: {},
    }, log);
    expect(r.toppedUp).to.equal(false);
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('tops up only the short dimension to the next block; leaves the covered dim at its total', async () => {
    const t = makeTransport({
      // projects covered; prompts short (need 20 → 70 > 60)
      child: resources(dim(2, 0, 2), dim(50, 0, 60)),
      master: resources(dim(0, 0, 100), dim(0, 0, 800)),
    });
    const r = await ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: MASTER, need: { projects: 0, prompts: 20 }, poll,
    }, log);
    expect(r).to.deep.equal({ toppedUp: true, newTotal: { projects: 2, prompts: 100 } });
    expect(t.transferWorkspaceResources).to.have.been.calledOnceWith(CHILD, ai(2, 100));
  });

  it('tops up the projects dimension one block at a time', async () => {
    const t = makeTransport({
      child: resources(dim(2, 0, 2), dim(0, 0, 100)),
      master: resources(dim(2, 0, 13), dim(0, 0, 800)),
    });
    const r = await ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: MASTER, need: { projects: 1 }, poll,
    }, log);
    expect(r.newTotal.projects).to.equal(3); // roundUpToBlock(3, 1)
    expect(t.transferWorkspaceResources).to.have.been.calledWith(CHILD, ai(3, 100));
  });

  it('throws brandAiLimit (409) when the top-up would exceed the per-brand ceiling', async () => {
    const t = makeTransport({ child: resources(dim(2, 0, 2), dim(0, 0, 100)) });
    const p = ensureAiHeadroom(t, {
      subWorkspaceId: CHILD,
      parentWorkspaceId: MASTER,
      need: { projects: 3 },
      ceiling: { projects: 3 },
      poll,
    }, log);
    await expect(p).to.be.rejectedWith(ErrorWithStatusCode);
    const e = await p.catch((x) => x);
    expect(e.status).to.equal(409);
    expect(e.code).to.equal('brandAiLimit');
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('advisory pool-free low: does NOT throw (non-atomic read) — warns and PROCEEDS to the transfer', async () => {
    // The precheck is advisory only; a low reading races concurrent top-ups. It must not throw a
    // spurious 409 — it warns and proceeds, letting the transfer 422 be the authoritative signal.
    const warn = sinon.spy();
    const t = makeTransport({
      child: resources(dim(2, 0, 2), dim(750, 0, 750)), // prompts need 100 → 850 target, delta 100
      master: resources(dim(2, 0, 13), dim(760, 0, 800)), // prompts free = 40 < 100
    });
    const r = await ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: MASTER, need: { prompts: 100 },
    }, { ...log, warn });
    expect(r.toppedUp).to.equal(true);
    expect(t.transferWorkspaceResources).to.have.been.calledOnce; // proceeded despite the low gauge
    expect(warn).to.have.been.calledWithMatch('SERENITY_ALLOC advisory pool-free low (proceeding; transfer 422 is authoritative)');
  });

  it('maps a terminal 422 "insufficient units" on the transfer to orgPoolExhausted', async () => {
    const t = makeTransport({
      child: resources(dim(2, 0, 2), dim(0, 0, 0)),
      master: resources(dim(0, 0, 100), dim(0, 0, 800)),
      transfer: sinon.stub().rejects(poolFull()),
    });
    const e = await ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: MASTER, need: { prompts: 10 }, poll,
    }, log).catch((x) => x);
    expect(e.code).to.equal('orgPoolExhausted');
  });

  describe('serenity-docs#72 §5: hard-exhaustion Slack alerting (case 2/3)', () => {
    const ENABLED_ENV = {
      SERENITY_QUOTA_ALERTS_ENABLED: 'true',
      SERENITY_QUOTA_ALERTS_SLACK_CHANNEL_ID: 'C123',
      SLACK_BOT_TOKEN: 'xoxb-test',
    };
    let alertQuotaRejection;
    let alertPoolFreeThreshold;
    let mocked;

    beforeEach(async () => {
      // esmock does not transitively override two hops deep (resource-manager → quota-alerts →
      // slack/base) — mock at the ONE-HOP entry (quota-alerts.js's own exports) instead, same
      // workaround used for PR #2854's toQuotaExceededError coverage.
      alertQuotaRejection = sinon.stub().resolves();
      alertPoolFreeThreshold = sinon.stub().resolves();
      mocked = await esmock('../../../src/support/serenity/resource-manager.js', {
        '../../../src/support/serenity/quota-alerts.js': {
          alertQuotaRejection, alertPoolFreeThreshold,
        },
      });
    });

    it('alerts brandAiLimit when the top-up would exceed the per-brand ceiling and env is threaded', async () => {
      const t = makeTransport({ child: resources(dim(2, 0, 2), dim(0, 0, 100)) });
      const e = await mocked.ensureAiHeadroom(t, {
        subWorkspaceId: CHILD,
        parentWorkspaceId: MASTER,
        need: { projects: 3 },
        ceiling: { projects: 3 },
        poll,
        env: ENABLED_ENV,
        orgId: 'org-1',
        brandId: 'brand-1',
      }, log).catch((x) => x);
      expect(e.code).to.equal('brandAiLimit');
      expect(alertQuotaRejection).to.have.been.calledOnce;
      const [payload, env] = alertQuotaRejection.firstCall.args;
      expect(payload.caseType).to.equal('brandAiLimit');
      expect(payload.orgId).to.equal('org-1');
      expect(payload.brandId).to.equal('brand-1');
      expect(env).to.equal(ENABLED_ENV);
    });

    it('does NOT alert brandAiLimit when env is not threaded (no-op, backward compatible)', async () => {
      const t = makeTransport({ child: resources(dim(2, 0, 2), dim(0, 0, 100)) });
      const e = await mocked.ensureAiHeadroom(t, {
        subWorkspaceId: CHILD,
        parentWorkspaceId: MASTER,
        need: { projects: 3 },
        ceiling: { projects: 3 },
        poll,
      }, log).catch((x) => x);
      expect(e.code).to.equal('brandAiLimit');
      expect(alertQuotaRejection).to.not.have.been.called;
    });

    it('alerts orgPoolExhausted on a terminal 422 "insufficient units" when env is threaded', async () => {
      const t = makeTransport({
        child: resources(dim(2, 0, 2), dim(0, 0, 0)),
        master: resources(dim(0, 0, 100), dim(0, 0, 800)),
        transfer: sinon.stub().rejects(poolFull()),
      });
      const e = await mocked.ensureAiHeadroom(t, {
        subWorkspaceId: CHILD,
        parentWorkspaceId: MASTER,
        need: { prompts: 10 },
        poll,
        env: ENABLED_ENV,
        orgId: 'org-1',
        brandId: 'brand-1',
      }, log).catch((x) => x);
      expect(e.code).to.equal('orgPoolExhausted');
      // alertPoolFreeThreshold is the distinct EARLY-warning advisory alert (fires before the
      // transfer even runs); assert on the hard-exhaustion alert specifically.
      expect(alertQuotaRejection).to.have.been.calledOnce;
      const [payload] = alertQuotaRejection.firstCall.args;
      expect(payload.caseType).to.equal('orgPoolExhausted');
      expect(payload.orgId).to.equal('org-1');
      expect(payload.brandId).to.equal('brand-1');
    });
  });

  it('FAIL-FAST: a transient "workspace not ready" 422 → immediate 503 workspaceBusy, ONE transfer, NO poll', async () => {
    const transfer = sinon.stub().rejects(notReady());
    const t = makeTransport({
      child: resources(dim(2, 0, 2), dim(0, 0, 0)),
      master: resources(dim(0, 0, 100), dim(0, 0, 800)),
      transfer,
    });
    const e = await ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: MASTER, need: { prompts: 10 },
    }, log).catch((x) => x);
    expect(e.status).to.equal(503);
    expect(e.code).to.equal('workspaceBusy');
    expect(e.message).to.match(/provisioning, retry/);
    // Hard constraint (serenity-docs#22): NO retry loop, NO settle poll on the request path.
    expect(transfer).to.have.callCount(1);
    expect(t.getWorkspaceStatus).to.not.have.been.called;
  });

  it('FAIL-FAST: a successful top-up does exactly ONE transfer and never polls getWorkspaceStatus', async () => {
    const t = makeTransport({
      child: resources(dim(2, 0, 2), dim(0, 0, 0)),
      master: resources(dim(0, 0, 100), dim(0, 0, 800)),
    });
    const r = await ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: MASTER, need: { prompts: 10 },
    }, log);
    expect(r.toppedUp).to.equal(true);
    expect(t.transferWorkspaceResources).to.have.callCount(1);
    expect(t.getWorkspaceStatus).to.not.have.been.called;
  });

  it('publish-seam sizing (includeDrafted): sizes prompts from used + drafted, staleness-immune', async () => {
    // used=50 (stale-low), drafted=120 just staged. Without includeDrafted required=50 (covered by
    // total 100 → no top-up, then publish 405s). With includeDrafted required=50+120=170 → top up
    // to the next PROMPT_BLOCK (200).
    const t = makeTransport({
      child: resources(dim(1, 0, 5), dim(50, 120, 100)),
      master: resources(dim(0, 0, 100), dim(0, 0, 800)),
    });
    const r = await ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: MASTER, need: {}, includeDrafted: true,
    }, log);
    expect(r.toppedUp).to.equal(true);
    expect(t.transferWorkspaceResources).to.have.been.calledWith(CHILD, ai(5, 200));
  });

  it('publish-seam sizing (includeDrafted) is a hot-path no-op when used + drafted already fits', async () => {
    const t = makeTransport({
      child: resources(dim(1, 0, 5), dim(50, 120, 200)),
      master: resources(dim(0, 0, 100), dim(0, 0, 800)),
    });
    const r = await ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: MASTER, need: {}, includeDrafted: true,
    }, log);
    expect(r.toppedUp).to.equal(false);
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('propagates a non-quota transfer error (e.g. 500) unchanged', async () => {
    const t = makeTransport({
      child: resources(dim(2, 0, 2), dim(0, 0, 0)),
      master: resources(dim(0, 0, 100), dim(0, 0, 800)),
      transfer: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
    });
    const e = await ensureAiHeadroom(t, {
      subWorkspaceId: CHILD, parentWorkspaceId: MASTER, need: { prompts: 10 }, poll,
    }, log).catch((x) => x);
    expect(e).to.be.instanceOf(SerenityTransportError);
    expect(e.status).to.equal(500);
  });
});

describe('resource-manager — releaseAiSurplus', () => {
  it('no-op when nothing frees a whole block', async () => {
    const t = makeTransport({ child: resources(dim(2, 0, 2), dim(90, 0, 100)) });
    const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, poll }, log);
    expect(r).to.deep.equal({ released: false, reason: 'nothing-to-release' });
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('idle child + zero floor → requires-decommission, NO all-zero transfer (regression)', async () => {
    // A fully-idle child (used 0) with the default zero floor would floor BOTH dims to 0. A
    // transfer to {0,0} is a live-verified silent no-op, so releaseAiSurplus must NOT emit it and
    // must NOT falsely report released:true — it flags requires-decommission and warns instead.
    const warn = sinon.spy();
    const t = makeTransport({ child: resources(dim(0, 0, 1), dim(0, 0, 100)) });
    const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, poll }, { ...log, warn });
    expect(r).to.deep.equal({ released: false, reason: 'requires-decommission' });
    expect(t.transferWorkspaceResources).to.not.have.been.called;
    expect(warn).to.have.been.calledWithMatch('needs decommission');
  });

  it('lowers one dim to non-zero while a zero-floored dim stays at its current total', async () => {
    // prompts used 150 → roundUp = 200 < 500 (lowers to a NON-ZERO 200); projects used 0, floor 0
    // → target floors to 0 (unreclaimable via transfer) so it stays at its current total (1). The
    // emitted payload keeps BOTH dims non-zero — never a partial object, never a newly-added 0.
    const t = makeTransport({ child: resources(dim(0, 0, 1), dim(150, 0, 500)) });
    const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, failFast: true }, log);
    expect(r.released).to.equal(true);
    expect(t.transferWorkspaceResources).to.have.been.calledOnceWith(CHILD, ai(1, 200));
  });

  it('lowers totals to rounded used, never below the floor', async () => {
    const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 400)) });
    const r = await releaseAiSurplus(t, {
      subWorkspaceId: CHILD, floor: { projects: 1, prompts: 0 }, poll,
    }, log);
    // projects → max(1, roundUp(1))=1 < 5; prompts → max(0, roundUp(50)=100)=100 < 400
    expect(r.released).to.equal(true);
    expect(t.transferWorkspaceResources).to.have.been.calledOnceWith(CHILD, ai(1, 100));
  });

  it('respects a floor above rounded used', async () => {
    const t = makeTransport({ child: resources(dim(0, 0, 5), dim(0, 0, 500)) });
    const r = await releaseAiSurplus(t, {
      subWorkspaceId: CHILD, floor: { projects: 2, prompts: 200 }, poll,
    }, log);
    expect(t.transferWorkspaceResources).to.have.been.calledOnceWith(CHILD, ai(2, 200));
    expect(r.target).to.deep.equal({ projects: 2, prompts: 200 });
  });

  it('is best-effort — swallows an EXPECTED transport failure and returns released:false', async () => {
    const warn = sinon.spy();
    const t = makeTransport({ child: resources(dim(0, 0, 5), dim(0, 0, 500)) });
    t.getWorkspaceResources.withArgs(CHILD).rejects(new SerenityTransportError(503, 'transport boom'));
    const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, poll }, { ...log, warn });
    expect(r.released).to.equal(false);
    expect(r.reason).to.equal('error');
    expect(r.errorMessage).to.equal('transport boom');
    expect(r.errorCode).to.equal(undefined); // a bare transport error carries no typed ERROR_CODES
    expect(warn).to.have.been.called;
  });

  it('propagates an UNEXPECTED error (e.g. a bug) rather than hiding it', async () => {
    const t = makeTransport({ child: resources(dim(0, 0, 5), dim(0, 0, 500)) });
    t.getWorkspaceResources.withArgs(CHILD).rejects(new TypeError('undefined is not a function'));
    await expect(releaseAiSurplus(t, { subWorkspaceId: CHILD, poll }, log))
      .to.be.rejectedWith(TypeError);
  });

  it('fails LOUD on a missing/blank subWorkspaceId — propagates, never swallowed as best-effort', async () => {
    // A blank id is a caller wiring bug, not an expected/best-effort failure (transport/pool/busy)
    // — it must surface as a clear 500, not the opaque transport error a blank id would otherwise
    // produce, and NOT be reported as released:false the way a real best-effort failure would be.
    const t = makeTransport({ child: resources(dim(0, 0, 5), dim(0, 0, 500)) });
    await expect(releaseAiSurplus(t, { subWorkspaceId: '', poll }, log))
      .to.be.rejectedWith(/requires a non-empty subWorkspaceId/);
    expect(t.getWorkspaceResources).to.not.have.been.called;
  });

  it('release path (async/reconciler) retries the transient "workspace not ready" 422 then settles', async () => {
    // releaseAiSurplus keeps the settle-poll + not-ready retry loop — it is the async/reconciler
    // path, NOT the synchronous hot path (only ensureAiHeadroom fails fast).
    const transfer = sinon.stub();
    transfer.onCall(0).rejects(notReady());
    transfer.onCall(1).resolves();
    const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 400)), transfer });
    const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, poll }, log);
    expect(r.released).to.equal(true);
    expect(transfer).to.have.callCount(2);
  });

  it('release path surfaces workspaceBusy (503) as an EXPECTED best-effort failure when not-ready never clears', async () => {
    const transfer = sinon.stub().rejects(notReady());
    const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 400)), transfer });
    const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, poll }, log);
    // Best-effort: the ErrorWithStatusCode(503) is swallowed and reported as released:false, with
    // the typed code surfaced so a batch caller can tell this apart from an unexpected failure.
    expect(r.released).to.equal(false);
    expect(r.reason).to.equal('error');
    expect(r.errorCode).to.equal('workspaceBusy');
    expect(transfer).to.have.callCount(4); // 1 initial + NOT_READY_RETRIES(3)
  });

  it('release path maps a terminal pool-exhausted 422 to a swallowed best-effort failure', async () => {
    // The release transfer can 422 "insufficient units" if the parent can't (yet) reabsorb the
    // surplus; transferAndSettle maps it to orgPoolExhausted, which releaseAiSurplus swallows
    // (best-effort — a reconciler converges it later).
    const warn = sinon.spy();
    const transfer = sinon.stub().rejects(poolFull());
    const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 400)), transfer });
    const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, poll }, { ...log, warn });
    expect(r.released).to.equal(false);
    expect(r.reason).to.equal('error');
    expect(r.errorCode).to.equal('orgPoolExhausted');
    expect(warn).to.have.been.calledWithMatch('SERENITY_ALLOC org pool exhausted on transfer');
  });

  it('release path maps a poll timeout to a swallowed best-effort failure', async () => {
    const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 400)) });
    t.getWorkspaceStatus = sinon.stub().resolves({ status: 'not ready' });
    const r = await releaseAiSurplus(t, {
      subWorkspaceId: CHILD, poll: { attempts: 2, intervalMs: 0, sleep: () => Promise.resolve() },
    }, log);
    expect(r.released).to.equal(false);
    expect(r.reason).to.equal('error');
    expect(r.errorMessage).to.match(/did not settle/);
  });

  it('failFast: lowers total with ONE transfer and NO settle poll (synchronous request-path release)', async () => {
    // projects at floor (used 5 / total 5, no surplus); prompts used dropped to 50 after a removal
    // republish, total 400 → release lowers prompts to roundUp(50)=100, projects untouched.
    const t = makeTransport({ child: resources(dim(5, 0, 5), dim(50, 0, 400)) });
    const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, failFast: true }, log);
    expect(r.released).to.equal(true);
    expect(t.transferWorkspaceResources).to.have.been.calledOnceWith(CHILD, ai(5, 100));
    expect(t.getWorkspaceStatus).to.not.have.been.called; // no settle poll on the fail-fast path
  });

  it('failFast: a transient "workspace not ready" is swallowed best-effort (503 not thrown)', async () => {
    const transfer = sinon.stub().rejects(notReady());
    const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 400)), transfer });
    const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, failFast: true }, log);
    expect(r.released).to.equal(false);
    expect(r.reason).to.equal('error');
    expect(r.errorCode).to.equal('workspaceBusy');
    expect(transfer).to.have.callCount(1); // one attempt, no retry loop
  });

  describe('dryRun', () => {
    it('computes the real target and reports it WITHOUT issuing a transfer', async () => {
      const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 400)) });
      const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, dryRun: true }, log);
      expect(r).to.deep.equal({ released: false, reason: 'dry-run', target: { projects: 1, prompts: 100 } });
      expect(t.transferWorkspaceResources).to.not.have.been.called;
    });

    it('still reports nothing-to-release when there is no surplus (same math as a live call)', async () => {
      const t = makeTransport({ child: resources(dim(2, 0, 2), dim(90, 0, 100)) });
      const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, dryRun: true }, log);
      expect(r).to.deep.equal({ released: false, reason: 'nothing-to-release' });
      expect(t.transferWorkspaceResources).to.not.have.been.called;
    });

    it('still reports requires-decommission when the target would floor to 0 (same math as a live call)', async () => {
      const t = makeTransport({ child: resources(dim(0, 0, 1), dim(0, 0, 100)) });
      const r = await releaseAiSurplus(t, { subWorkspaceId: CHILD, dryRun: true }, log);
      expect(r).to.deep.equal({ released: false, reason: 'requires-decommission' });
      expect(t.transferWorkspaceResources).to.not.have.been.called;
    });

    it('the read (getWorkspaceResources) still happens under dryRun — a preview exercises real auth/scope', async () => {
      const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 400)) });
      await releaseAiSurplus(t, { subWorkspaceId: CHILD, dryRun: true }, log);
      expect(t.getWorkspaceResources).to.have.been.calledWith(CHILD);
    });
  });

  it('exports the default blocks', () => {
    expect(DEFAULT_BLOCKS).to.deep.equal({ projects: 1, prompts: 100 });
  });

  it('DEFAULT_POLL.sleep resolves against the real timer', async () => {
    await DEFAULT_POLL.sleep(0); // exercises the real-clock sleep default
    expect(DEFAULT_POLL.attempts).to.be.a('number');
  });
});
