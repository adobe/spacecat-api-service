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
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';
import { ErrorWithStatusCode } from '../../../src/support/utils.js';
import {
  roundUpToBlock, promptUnits, modelChangeUnits, marketNeed, readAiTotals,
  ensureAiHeadroom, releaseAiSurplus, DEFAULT_BLOCKS,
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

  it('need calculators clamp negatives to 0', () => {
    expect(promptUnits(3, 2)).to.equal(6);
    expect(promptUnits(-3, 2)).to.equal(0);
    expect(modelChangeUnits(10, 1)).to.equal(10);
    expect(modelChangeUnits(10, -1)).to.equal(0);
    expect(marketNeed({ generatedTexts: 4, models: 2 })).to.deep.equal({ projects: 1, prompts: 8 });
    expect(marketNeed()).to.deep.equal({ projects: 1, prompts: 0 });
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
  it('hot path: already covered → no transfer, no poll', async () => {
    const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 800)) });
    const r = await ensureAiHeadroom(t, {
      childId: CHILD, masterId: MASTER, need: { projects: 1, prompts: 100 },
    }, log);
    expect(r.toppedUp).to.equal(false);
    expect(t.transferWorkspaceResources).to.not.have.been.called;
    expect(t.getWorkspaceResources).to.have.been.calledOnceWith(CHILD); // master never read
  });

  it('need = 0 (or absent) is a true no-op — zero transport writes', async () => {
    const t = makeTransport({ child: resources(dim(2, 0, 2), dim(800, 0, 800)) });
    const r = await ensureAiHeadroom(t, { childId: CHILD, masterId: MASTER, need: {} }, log);
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
      childId: CHILD, masterId: MASTER, need: { projects: 0, prompts: 20 }, poll,
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
      childId: CHILD, masterId: MASTER, need: { projects: 1 }, poll,
    }, log);
    expect(r.newTotal.projects).to.equal(3); // roundUpToBlock(3, 1)
    expect(t.transferWorkspaceResources).to.have.been.calledWith(CHILD, ai(3, 100));
  });

  it('throws brandAiLimit (409) when the top-up would exceed the per-brand ceiling', async () => {
    const t = makeTransport({ child: resources(dim(2, 0, 2), dim(0, 0, 100)) });
    const p = ensureAiHeadroom(t, {
      childId: CHILD, masterId: MASTER, need: { projects: 3 }, ceiling: { projects: 3 }, poll,
    }, log);
    await expect(p).to.be.rejectedWith(ErrorWithStatusCode);
    const e = await p.catch((x) => x);
    expect(e.status).to.equal(409);
    expect(e.code).to.equal('brandAiLimit');
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('throws orgPoolExhausted (409) when the master pool free < delta (advisory precheck)', async () => {
    const t = makeTransport({
      child: resources(dim(2, 0, 2), dim(750, 0, 750)), // prompts need 100 → 850 target, delta 100
      master: resources(dim(2, 0, 13), dim(760, 0, 800)), // prompts free = 40 < 100
    });
    const e = await ensureAiHeadroom(t, {
      childId: CHILD, masterId: MASTER, need: { prompts: 100 }, poll,
    }, log).catch((x) => x);
    expect(e.status).to.equal(409);
    expect(e.code).to.equal('orgPoolExhausted');
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('maps a terminal 422 "insufficient units" on the transfer to orgPoolExhausted', async () => {
    const t = makeTransport({
      child: resources(dim(2, 0, 2), dim(0, 0, 0)),
      master: resources(dim(0, 0, 100), dim(0, 0, 800)),
      transfer: sinon.stub().rejects(poolFull()),
    });
    const e = await ensureAiHeadroom(t, {
      childId: CHILD, masterId: MASTER, need: { prompts: 10 }, poll,
    }, log).catch((x) => x);
    expect(e.code).to.equal('orgPoolExhausted');
  });

  it('retries the transient "workspace not ready" 422 then succeeds', async () => {
    const transfer = sinon.stub();
    transfer.onCall(0).rejects(notReady());
    transfer.onCall(1).resolves();
    const t = makeTransport({
      child: resources(dim(2, 0, 2), dim(0, 0, 0)),
      master: resources(dim(0, 0, 100), dim(0, 0, 800)),
      transfer,
    });
    const r = await ensureAiHeadroom(t, {
      childId: CHILD, masterId: MASTER, need: { prompts: 10 }, poll,
    }, log);
    expect(r.toppedUp).to.equal(true);
    expect(transfer).to.have.callCount(2);
  });

  it('throws orgPoolExhausted when "workspace not ready" never clears within the retry bound', async () => {
    const t = makeTransport({
      child: resources(dim(2, 0, 2), dim(0, 0, 0)),
      master: resources(dim(0, 0, 100), dim(0, 0, 800)),
      transfer: sinon.stub().rejects(notReady()),
    });
    const e = await ensureAiHeadroom(t, {
      childId: CHILD, masterId: MASTER, need: { prompts: 10 }, poll,
    }, log).catch((x) => x);
    expect(e.code).to.equal('orgPoolExhausted');
    expect(e.message).to.match(/never cleared/);
  });

  it('propagates a non-quota transfer error (e.g. 500) unchanged', async () => {
    const t = makeTransport({
      child: resources(dim(2, 0, 2), dim(0, 0, 0)),
      master: resources(dim(0, 0, 100), dim(0, 0, 800)),
      transfer: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
    });
    const e = await ensureAiHeadroom(t, {
      childId: CHILD, masterId: MASTER, need: { prompts: 10 }, poll,
    }, log).catch((x) => x);
    expect(e).to.be.instanceOf(SerenityTransportError);
    expect(e.status).to.equal(500);
  });
});

describe('resource-manager — releaseAiSurplus', () => {
  it('no-op when nothing frees a whole block', async () => {
    const t = makeTransport({ child: resources(dim(2, 0, 2), dim(90, 0, 100)) });
    const r = await releaseAiSurplus(t, { childId: CHILD, poll }, log);
    expect(r).to.deep.equal({ released: false });
    expect(t.transferWorkspaceResources).to.not.have.been.called;
  });

  it('lowers totals to rounded used, never below the floor', async () => {
    const t = makeTransport({ child: resources(dim(1, 0, 5), dim(50, 0, 400)) });
    const r = await releaseAiSurplus(t, {
      childId: CHILD, floor: { projects: 1, prompts: 0 }, poll,
    }, log);
    // projects → max(1, roundUp(1))=1 < 5; prompts → max(0, roundUp(50)=100)=100 < 400
    expect(r.released).to.equal(true);
    expect(t.transferWorkspaceResources).to.have.been.calledOnceWith(CHILD, ai(1, 100));
  });

  it('respects a floor above rounded used', async () => {
    const t = makeTransport({ child: resources(dim(0, 0, 5), dim(0, 0, 500)) });
    const r = await releaseAiSurplus(t, {
      childId: CHILD, floor: { projects: 2, prompts: 200 }, poll,
    }, log);
    expect(t.transferWorkspaceResources).to.have.been.calledOnceWith(CHILD, ai(2, 200));
    expect(r.target).to.deep.equal({ projects: 2, prompts: 200 });
  });

  it('is best-effort — swallows a read/transfer failure and returns released:false', async () => {
    const warn = sinon.spy();
    const t = makeTransport({ child: resources(dim(0, 0, 5), dim(0, 0, 500)) });
    t.getWorkspaceResources.withArgs(CHILD).rejects(new Error('read boom'));
    const r = await releaseAiSurplus(t, { childId: CHILD, poll }, { ...log, warn });
    expect(r).to.deep.equal({ released: false });
    expect(warn).to.have.been.called;
  });

  it('exports the default blocks', () => {
    expect(DEFAULT_BLOCKS).to.deep.equal({ projects: 1, prompts: 100 });
  });
});
