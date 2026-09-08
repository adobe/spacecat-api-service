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

import {
  createProvisionAndPublishProject,
  CreateNoProjectIdError,
  primaryUrlPatchBody,
} from '../../../src/support/serenity/project-provisioning.js';
import { MainBrandBenchmarkInvariantError } from '../../../src/support/serenity/brand-urls.js';

const WS = 'workspace-1';
const CREATE_BODY = {
  name: 'US-en', type: 'ai', domain: 'nba.com', brand_name_display: 'Kings', brand_names: ['Kings'],
};

const FLAGGED = { aio_benchmarks: [{ id: 'bm-1', domain: 'nba.com', main_brand: true }] };
const EMPTY = { aio_benchmarks: [] };

describe('serenity project-provisioning: createProvisionAndPublishProject', () => {
  let transport;
  let log;

  beforeEach(() => {
    transport = {
      createProject: sinon.stub().resolves({ id: 'proj-1' }),
      updateProject: sinon.stub().resolves(),
      publishProject: sinon.stub().resolves(),
      deleteProject: sinon.stub().resolves(),
      listBenchmarks: sinon.stub().resolves(FLAGGED),
      createBenchmarks: sinon.stub().resolves({ ids: ['bm-1'] }),
      deleteBenchmarks: sinon.stub().resolves(),
    };
    log = { error: sinon.spy(), warn: sinon.spy(), info: sinon.spy() };
  });

  afterEach(() => sinon.restore());

  it('creates, PATCHes the tracked url, then publishes — in that order', async () => {
    const id = await createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings', log,
    });

    expect(id).to.equal('proj-1');
    expect(transport.createProject).to.have.been.calledOnceWith(WS, CREATE_BODY);
    expect(transport.updateProject).to.have.been.calledOnceWith(WS, 'proj-1');
    expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'proj-1');
    // The order is forced by the upstream: create ignores primary_url, and a PATCH
    // after the publish would leave the corrected value sitting in draft.
    expect(transport.createProject).to.have.been.calledBefore(transport.updateProject);
    expect(transport.updateProject).to.have.been.calledBefore(transport.publishProject);
  });

  it('sends primary_url FLAT with the required type, not nested under settings.ai', async () => {
    await createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings', log,
    });

    // `model.ProjectUpdateRequest` declares primary_url at the top level and has no
    // `settings` member at all; the nested spelling is accepted and IGNORED, which
    // would look like success while changing nothing.
    expect(transport.updateProject.firstCall.args[2]).to.deep.equal({
      type: 'ai',
      primary_url: 'nba.com/kings',
    });
  });

  it('skips the PATCH when there is no tracked url to set', async () => {
    // Skipped rather than sent empty: blanking the field would replace the
    // upstream's own apex default with nothing.
    await createProvisionAndPublishProject(transport, WS, CREATE_BODY, { log });

    expect(transport.updateProject).to.not.have.been.called;
    expect(transport.publishProject).to.have.been.calledOnce;
  });

  it('skips the PATCH for a blank tracked url', async () => {
    await createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: '   ', log,
    });

    expect(transport.updateProject).to.not.have.been.called;
  });

  it('throws when create returns no id, and touches nothing else', async () => {
    transport.createProject.resolves({});

    await expect(createProvisionAndPublishProject(transport, WS, CREATE_BODY, { log }))
      .to.be.rejectedWith('Upstream createProject returned no id');
    expect(transport.updateProject).to.not.have.been.called;
    expect(transport.publishProject).to.not.have.been.called;
    expect(transport.deleteProject).to.not.have.been.called;
  });

  it('throws CreateNoProjectIdError specifically, so the 502 mapping cannot be reworded away', async () => {
    // The handler translates this into a 502 `createNoProjectId` that callers use to
    // decide whether a retry is safe. Asserting the type — not the wording — is what
    // keeps a message edit from silently downgrading that 502 to an unhandled 500.
    transport.createProject.resolves({});

    const err = await createProvisionAndPublishProject(transport, WS, CREATE_BODY, { log })
      .then(() => null, (e) => e);
    expect(err).to.be.instanceOf(CreateNoProjectIdError);
  });

  it('builds the PATCH body through primaryUrlPatchBody, so `type` is always present', () => {
    // `type` is required on every project PATCH whatever field is being set, and
    // omitting it is rejected upstream.
    expect(primaryUrlPatchBody('nba.com/kings'))
      .to.deep.equal({ type: 'ai', primary_url: 'nba.com/kings' });
  });

  it('a failed PATCH still publishes — the market is kept, the divergence logged', async () => {
    // Deleting an otherwise-valid project because a refinement could not be applied
    // trades a recoverable degradation for no market at all. A market left on its
    // apex is the state every market was in before this change, and the one the
    // data-service reconcile repairs in place.
    transport.updateProject.rejects(new Error('upstream 503'));

    const projectId = await createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings', log, caller: 'handleCreateMarket',
    });

    expect(projectId).to.equal('proj-1');
    expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'proj-1');
    expect(transport.deleteProject).to.not.have.been.called;
    expect(log.warn).to.have.been.calledWithMatch(
      'handleCreateMarket: SERENITY_MARKET_PRIMARY_URL_DIVERGENCE',
    );
  });

  it('a failed publish deletes the orphan and rethrows', async () => {
    transport.publishProject.rejects(new Error('upstream 503'));

    await expect(createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings', log,
    })).to.be.rejectedWith('upstream 503');

    expect(transport.deleteProject).to.have.been.calledOnceWith(WS, 'proj-1');
  });

  it('a failed cleanup is logged but never masks the original error', async () => {
    transport.publishProject.rejects(new Error('upstream 503'));
    transport.deleteProject.rejects(new Error('cleanup glitch'));

    await expect(createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings', log, caller: 'handleCreateMarket',
    })).to.be.rejectedWith('upstream 503');

    expect(log.error).to.have.been.calledWithMatch(
      'handleCreateMarket: best-effort cleanup deleteProject failed; orphan upstream project remains',
    );
    expect(log.error).to.have.been.calledWithMatch(
      'handleCreateMarket: orphaned upstream project after provisioning failure',
    );
  });

  it('carries the caller log context into the failure logs', async () => {
    transport.publishProject.rejects(new Error('boom'));

    await expect(createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings',
      log,
      logContext: { brandId: 'brand-1', languageCode: 'en' },
    })).to.be.rejectedWith('boom');

    expect(log.error).to.have.been.calledWithMatch(
      sinon.match.string,
      sinon.match({ brandId: 'brand-1', languageCode: 'en', semrushProjectId: 'proj-1' }),
    );
  });

  it('tolerates a caller with no logger', async () => {
    transport.publishProject.rejects(new Error('boom'));

    await expect(createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
      primaryUrl: 'nba.com/kings',
    })).to.be.rejectedWith('boom');
    expect(transport.deleteProject).to.have.been.calledOnce;
  });

  it('defaults its options entirely', async () => {
    const id = await createProvisionAndPublishProject(transport, WS, CREATE_BODY);

    expect(id).to.equal('proj-1');
    expect(transport.updateProject).to.not.have.been.called;
  });

  describe('LLMO-7421: main-brand benchmark invariant', () => {
    it('creates a flagged own-brand benchmark when none exists, before publishing', async () => {
      // Call 0: ensureOwnBrandBenchmark's own read (nothing yet). Create succeeds
      // with an id, so no re-list is needed there. Call 1: pre-publish assert
      // (draft) sees the newly-created flagged benchmark.
      transport.listBenchmarks.onCall(0).resolves(EMPTY);
      transport.listBenchmarks.onCall(1).resolves(FLAGGED);

      const id = await createProvisionAndPublishProject(transport, WS, CREATE_BODY, { log });

      expect(id).to.equal('proj-1');
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(
        WS,
        'proj-1',
        [sinon.match({ brand_name: 'Kings', domain: 'nba.com', main_brand: true })],
      );
      expect(transport.createBenchmarks).to.have.been.calledBefore(transport.publishProject);
      // Exactly two reads, both draft — no post-publish read at all (publish is
      // asynchronous; see MainBrandBenchmarkInvariantError's doc for why a
      // published-view confirmation is deferred rather than attempted here).
      expect(transport.listBenchmarks).to.have.callCount(2);
      expect(transport.listBenchmarks.getCall(0)).to.have.been.calledWith(WS, 'proj-1', { draft: true });
      expect(transport.listBenchmarks.getCall(1)).to.have.been.calledWith(WS, 'proj-1', { draft: true });
    });

    it('derives name/aliases from brand_names when brand_name_display is absent (MysticatBot review)', async () => {
      // Without brand_name_display, brand.name falls back to brand_names[0] and
      // brand.aliases to brand_names.slice(1) — the alternate branch of the
      // ternaries in createProvisionAndPublishProject that the other tests
      // here never exercise, since CREATE_BODY always sets brand_name_display.
      const createBodyNoDisplay = {
        name: 'US-en', type: 'ai', domain: 'nba.com', brand_names: ['Kings', 'Sacramento Kings'],
      };
      transport.listBenchmarks.onCall(0).resolves(EMPTY);
      transport.listBenchmarks.onCall(1).resolves(FLAGGED);

      await createProvisionAndPublishProject(transport, WS, createBodyNoDisplay, { log });

      expect(transport.createProject).to.have.been.calledOnceWith(WS, createBodyNoDisplay);
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(
        WS,
        'proj-1',
        [sinon.match({
          brand_name: 'Kings',
          domain: 'nba.com',
          main_brand: true,
          brand_aliases: sinon.match.array.deepEquals(['sacramento kings', 'kings']),
        })],
      );
    });

    it('creates the own-brand benchmark on the market TRACKED url, not its bare host', async () => {
      // A merge-integration miss caught in review: the flat path's `brand` object
      // must carry `primaryUrl` like the sub-workspace path's `ownBrand` does, or
      // a subpath/subdomain market's own-brand benchmark silently scores it
      // against its bare host instead of the url it actually tracks.
      transport.listBenchmarks.onCall(0).resolves(EMPTY);
      transport.listBenchmarks.onCall(1).resolves(FLAGGED);

      await createProvisionAndPublishProject(transport, WS, CREATE_BODY, {
        primaryUrl: 'nba.com/kings', log,
      });

      expect(transport.createBenchmarks).to.have.been.calledOnceWith(
        WS,
        'proj-1',
        [sinon.match({ domain: 'nba.com', primary_url: 'nba.com/kings', main_brand: true })],
      );
    });

    it('deletes and recreates an unflagged own-domain benchmark, flagged, before publishing', async () => {
      const unflagged = { aio_benchmarks: [{ id: 'bm-old', domain: 'nba.com', main_brand: false }] };
      transport.createBenchmarks.resolves({ ids: ['bm-new'] });
      // Call 0: ensureOwnBrandBenchmark's own read finds the unflagged match (no
      // re-list needed — create succeeds with an id). Call 1: pre-publish assert
      // sees the new flagged benchmark.
      transport.listBenchmarks.onCall(0).resolves(unflagged);
      transport.listBenchmarks.onCall(1).resolves(FLAGGED);

      const id = await createProvisionAndPublishProject(transport, WS, CREATE_BODY, { log });

      expect(id).to.equal('proj-1');
      expect(transport.deleteBenchmarks).to.have.been.calledOnceWith(WS, 'proj-1', ['bm-old']);
      expect(transport.createBenchmarks).to.have.been.calledOnceWith(
        WS,
        'proj-1',
        [sinon.match({ main_brand: true })],
      );
      expect(transport.deleteBenchmarks).to.have.been.calledBefore(transport.createBenchmarks);
      expect(transport.createBenchmarks).to.have.been.calledBefore(transport.publishProject);
      expect(transport.listBenchmarks).to.have.callCount(2);
    });

    it('aborts before publishing and cleans up the orphan when the pre-publish draft check fails', async () => {
      transport.listBenchmarks.resolves(EMPTY);
      transport.createBenchmarks.resolves({}); // no id returned — create silently failed to flag

      const err = await createProvisionAndPublishProject(transport, WS, CREATE_BODY, { log })
        .then(() => null, (e) => e);

      expect(err).to.be.instanceOf(MainBrandBenchmarkInvariantError);
      expect(err.status).to.equal(502);
      expect(err.code).to.equal('mainBrandBenchmarkInvariant');
      expect(transport.publishProject).to.not.have.been.called;
      expect(transport.deleteProject).to.have.been.calledOnceWith(WS, 'proj-1');
    });

    it('does not re-check the published view after a successful publish (publish is asynchronous)', async () => {
      // Draft check passes; publish succeeds. There is deliberately no
      // published-view read afterward — see MainBrandBenchmarkInvariantError's
      // doc: publish is a 202 that transitions the project to live in the
      // background, so an immediate published-view read would race it rather
      // than confirm anything.
      transport.listBenchmarks.resolves(FLAGGED);

      const id = await createProvisionAndPublishProject(transport, WS, CREATE_BODY, { log });

      expect(id).to.equal('proj-1');
      expect(transport.publishProject).to.have.been.calledOnce;
      expect(transport.listBenchmarks).to.have.callCount(2);
      expect(transport.deleteProject).to.not.have.been.called;
    });

    it('rejects duplicate main-brand benchmarks the same way as zero', async () => {
      const duplicate = {
        aio_benchmarks: [
          { id: 'bm-1', domain: 'nba.com', main_brand: true },
          { id: 'bm-2', domain: 'nba.com', main_brand: true },
        ],
      };
      transport.listBenchmarks.resolves(duplicate);

      const err = await createProvisionAndPublishProject(transport, WS, CREATE_BODY, { log })
        .then(() => null, (e) => e);

      expect(err).to.be.instanceOf(MainBrandBenchmarkInvariantError);
      expect(err.count).to.equal(2);
      expect(transport.publishProject).to.not.have.been.called;
    });
  });
});
