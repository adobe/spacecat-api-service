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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';

use(sinonChai);

function fakeLog() {
  return { info: sinon.stub(), error: sinon.stub() };
}

// Awaits a promise expected to reject and returns the thrown error (or null).
async function caught(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

describe('withMemberAutoProvision', () => {
  let mintStub;
  let addWorkspaceMembersStub;
  let createTransportStub;
  let mod;

  beforeEach(async () => {
    mintStub = sinon.stub().resolves('svc-token');
    addWorkspaceMembersStub = sinon.stub().resolves({ consumedUnits: -1 });
    createTransportStub = sinon.stub().returns({ addWorkspaceMembers: addWorkspaceMembersStub });
    mod = await esmock('../../../src/support/serenity/member-autoprovision.js', {
      '../../../src/support/serenity/semrush-ims-token.js': { mintSemrushImsToken: mintStub },
      '../../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: createTransportStub,
      },
    });
  });

  afterEach(() => sinon.restore());

  // Fresh args (incl. a fresh log) per call, so no fake is shared across tests.
  const mkArgs = (overrides = {}) => ({
    env: { SOME: 'env' },
    log: fakeLog(),
    enabled: true,
    workspaceId: 'ws-1',
    memberEmail: 'user@adobe.com',
    ...overrides,
  });

  it('returns the read result and does not provision when the read succeeds', async () => {
    const run = sinon.stub().resolves('data');
    const out = await mod.withMemberAutoProvision({ ...mkArgs(), run });
    expect(out).to.equal('data');
    expect(run).to.have.been.calledOnce;
    expect(mintStub).to.not.have.been.called;
  });

  it('provisions the caller (viewer) and retries once on a 403, returning the retry result', async () => {
    const run = sinon.stub();
    run.onFirstCall().rejects(new SerenityTransportError(403, 'not a member'));
    run.onSecondCall().resolves('data-after-provision');

    const out = await mod.withMemberAutoProvision({ ...mkArgs(), run });

    expect(out).to.equal('data-after-provision');
    expect(run).to.have.been.calledTwice;
    expect(mintStub).to.have.been.calledOnce;
    expect(addWorkspaceMembersStub).to.have.been.calledOnceWithExactly(
      'ws-1',
      ['user@adobe.com'],
      'role/workspace/viewer',
    );
  });

  it('also triggers on a 401', async () => {
    const run = sinon.stub();
    run.onFirstCall().rejects(new SerenityTransportError(401, 'unauth'));
    run.onSecondCall().resolves('ok');
    const out = await mod.withMemberAutoProvision({ ...mkArgs(), run });
    expect(out).to.equal('ok');
    expect(addWorkspaceMembersStub).to.have.been.calledOnce;
  });

  it('does not provision (rethrows) when disabled', async () => {
    const run = sinon.stub().rejects(new SerenityTransportError(403, 'x'));
    const err = await caught(mod.withMemberAutoProvision({ ...mkArgs({ enabled: false }), run }));
    expect(err).to.be.instanceOf(SerenityTransportError);
    expect(run).to.have.been.calledOnce;
    expect(mintStub).to.not.have.been.called;
  });

  it('rethrows a non-401/403 upstream error without provisioning', async () => {
    const run = sinon.stub().rejects(new SerenityTransportError(500, 'boom'));
    const err = await caught(mod.withMemberAutoProvision({ ...mkArgs(), run }));
    expect(err?.status).to.equal(500);
    expect(mintStub).to.not.have.been.called;
    expect(run).to.have.been.calledOnce;
  });

  it('skips provisioning when memberEmail is missing', async () => {
    const run = sinon.stub().rejects(new SerenityTransportError(403, 'x'));
    const args = { ...mkArgs({ memberEmail: null }), run };
    const err = await caught(mod.withMemberAutoProvision(args));
    expect(err?.status).to.equal(403);
    expect(mintStub).to.not.have.been.called;
  });

  it('surfaces the ORIGINAL read error when provisioning fails (e.g. 422 no seats)', async () => {
    const run = sinon.stub().rejects(new SerenityTransportError(403, 'not a member'));
    addWorkspaceMembersStub.rejects(new SerenityTransportError(422, 'no user units'));
    const err = await caught(mod.withMemberAutoProvision({ ...mkArgs(), run }));
    expect(err?.status).to.equal(403); // original read error, not the 422
    expect(run).to.have.been.calledOnce; // no retry after a failed provision
  });

  it('does NOT loop: a retry that still 403s propagates after exactly one retry', async () => {
    const run = sinon.stub().rejects(new SerenityTransportError(403, 'still not a member'));
    const err = await caught(mod.withMemberAutoProvision({ ...mkArgs(), run }));
    expect(err?.status).to.equal(403);
    expect(run).to.have.been.calledTwice; // initial + one retry, then give up
    expect(mintStub).to.have.been.calledOnce;
  });

  describe('isSemrushMembershipDenied', () => {
    it('is true for 401/403 Semrush transport errors, false otherwise', () => {
      expect(mod.isSemrushMembershipDenied(new SerenityTransportError(403, 'x'))).to.equal(true);
      expect(mod.isSemrushMembershipDenied(new SerenityTransportError(401, 'x'))).to.equal(true);
      expect(mod.isSemrushMembershipDenied(new SerenityTransportError(404, 'x'))).to.equal(false);
      expect(mod.isSemrushMembershipDenied(new SerenityTransportError(422, 'x'))).to.equal(false);
      expect(mod.isSemrushMembershipDenied(new Error('plain'))).to.equal(false);
    });
  });
});
