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
import { hasText } from '@adobe/spacecat-shared-utils';
import { ProjectEngineApiError } from '@adobe/spacecat-shared-project-engine-client';

import {
  ensureSubworkspace,
  decommissionBrandWorkspace,
  deleteAllProjects,
  emptyWorkspaceBestEffort,
  createOrAdoptSubworkspaceCandidate,
  subworkspaceTitle,
} from '../../../src/support/serenity/workspace-lifecycle.js';
import { ERROR_CODES } from '../../../src/support/serenity/errors.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';
import { clearBrandWorkspaceCache } from '../../../src/support/serenity/workspace-resolver.js';

use(chaiAsPromised);
use(sinonChai);

const PARENT_WS = 'bb0f4e1c-8bb1-402e-88f2-f68618ea7397';
const SUB_WS = 'subworkspace-ws-1';
const BRAND_ID = 'e48e9db4-3101-4237-8075-a9132333e8c2';
// The sub-workspace is titled with the brand's bare display name — the same
// convention the migration CLI uses, so a customer sees one naming scheme in the
// Semrush UI. Uniqueness for adoption comes from the claim filter, not the title.
const EXPECTED_TITLE = 'Adobe Express';
const OTHER_BRAND_ID = '3b1a7f6e-0c42-4f18-9a55-7d2e6c4b8a10';
const NOOP_TIMING = { intervalMs: 0, sleep: () => Promise.resolve() };
const log = { info: () => {}, error: () => {}, warn: () => {} };

// Data-access Brand collection stub backing the claim filter. `claims` maps a
// workspace id to the brand id currently bound to it (`brands.semrush_sub_workspace_id`);
// any id not listed is unclaimed.
function makeBrandCollection(claims = {}) {
  return {
    findBySemrushSubWorkspaceId: sinon.stub().callsFake(
      async (workspaceId) => (hasText(claims[workspaceId])
        ? { getId: () => claims[workspaceId] }
        : null),
    ),
  };
}

// A create-path ensureSubworkspace call whose family candidates are all unclaimed —
// the common case. Tests that exercise the claim filter itself pass their own
// makeBrandCollection({...}) instead.
function ensureWithUnclaimedFamily(transport, brand) {
  return ensureSubworkspace(
    transport,
    brand,
    PARENT_WS,
    log,
    NOOP_TIMING,
    null,
    { brandCollection: makeBrandCollection() },
  );
}

function makeTransport(overrides = {}) {
  return {
    createSubworkspace: sinon.stub().resolves({ id: SUB_WS, status: 'not ready' }),
    getWorkspaceStatus: sinon.stub().resolves({ status: 'created' }),
    listWorkspaceFamily: sinon.stub().resolves([]),
    listProjects: sinon.stub().resolves({ items: [] }),
    deleteProject: sinon.stub().resolves(null),
    deleteWorkspace: sinon.stub().resolves(null),
    ...overrides,
  };
}

function makeBrand({ workspaceId = null, name = 'Adobe Express', id = BRAND_ID } = {}) {
  let ws = workspaceId;
  return {
    getId: () => id,
    getSemrushSubWorkspaceId: () => ws,
    getName: () => name,
    setSemrushSubWorkspaceId: sinon.spy((v) => { ws = v; }),
    save: sinon.stub().resolves(),
  };
}

describe('workspace-lifecycle', () => {
  afterEach(() => {
    sinon.restore();
    clearBrandWorkspaceCache();
  });

  describe('ensureSubworkspace', () => {
    it('settles and returns the workspace when the brand already has a (kept) one', async () => {
      const transport = makeTransport();
      const brand = makeBrand({ workspaceId: SUB_WS });

      const result = await ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING);

      expect(result).to.equal(SUB_WS);
      // No allocation is ever transferred onto a bound sub-workspace — the readiness settle is
      // the whole of this branch's upstream work.
      expect(transport.getWorkspaceStatus).to.have.been.calledOnceWith(SUB_WS);
      expect(transport.createSubworkspace).to.not.have.been.called;
      expect(brand.save).to.not.have.been.called;
    });

    it('creates, polls until created, then persists the column', async () => {
      const transport = makeTransport();
      transport.getWorkspaceStatus
        .onFirstCall().resolves({ status: 'not ready' })
        .onSecondCall().resolves({ status: 'created' });
      const brand = makeBrand();

      const result = await ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING);

      expect(result).to.equal(SUB_WS);
      // No `resources` body: the child draws nothing from the parent pool, so a create can never
      // be refused for capacity (issue #2922).
      expect(transport.createSubworkspace)
        .to.have.been.calledOnceWithExactly(PARENT_WS, EXPECTED_TITLE);
      expect(transport.getWorkspaceStatus).to.have.been.calledTwice;
      expect(brand.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly(SUB_WS);
      expect(brand.save).to.have.been.calledOnce;
    });

    it('fails immediately when an existing workspace reports creation failed', async () => {
      const sleep = sinon.stub().resolves();
      const localLog = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };
      const transport = makeTransport({
        getWorkspaceStatus: sinon.stub().resolves({ status: 'creation failed' }),
      });
      const brand = makeBrand({ workspaceId: SUB_WS });

      const error = await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        localLog,
        { attempts: 3, intervalMs: 1, sleep },
      ).catch((e) => e);

      expect(error.status).to.equal(502);
      expect(error.code).to.equal(ERROR_CODES.SUBWORKSPACE_CREATION_FAILED);
      expect(error.message).to.match(/cannot be recovered by waiting/);
      expect(transport.getWorkspaceStatus).to.have.been.calledOnceWithExactly(SUB_WS);
      expect(sleep).to.not.have.been.called;
      expect(localLog.error).to.have.been.calledOnceWithExactly(
        'pollUntilCreated: sub-workspace settled to a terminal failure status',
        { semrushWorkspaceId: SUB_WS, status: 'creation failed' },
      );
      expect(brand.setSemrushSubWorkspaceId).to.not.have.been.called;
      expect(brand.save).to.not.have.been.called;
    });

    it('fails immediately when a fresh workspace reports invalid subscription', async () => {
      const sleep = sinon.stub().resolves();
      const localLog = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };
      const transport = makeTransport({
        getWorkspaceStatus: sinon.stub().resolves({ status: 'invalid subscription' }),
      });
      const brand = makeBrand();

      const error = await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        localLog,
        { attempts: 3, intervalMs: 1, sleep },
      ).catch((e) => e);

      expect(error.status).to.equal(502);
      expect(error.code).to.equal(ERROR_CODES.SUBWORKSPACE_CREATION_FAILED);
      expect(transport.getWorkspaceStatus).to.have.been.calledOnceWithExactly(SUB_WS);
      expect(sleep).to.not.have.been.called;
      expect(localLog.error).to.have.been.calledOnceWithExactly(
        'pollUntilCreated: sub-workspace settled to a terminal failure status',
        { semrushWorkspaceId: SUB_WS, status: 'invalid subscription' },
      );
      expect(brand.setSemrushSubWorkspaceId).to.not.have.been.called;
      expect(brand.save).to.not.have.been.called;
    });

    it('stops polling when a transient status becomes terminal', async () => {
      const sleep = sinon.stub().resolves();
      const localLog = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };
      const transport = makeTransport();
      transport.getWorkspaceStatus
        .onFirstCall().resolves({ status: 'not ready' })
        .onSecondCall().resolves({ status: 'creation failed' });
      const brand = makeBrand({ workspaceId: SUB_WS });

      const error = await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        localLog,
        { attempts: 3, intervalMs: 1, sleep },
      ).catch((e) => e);

      expect(error.status).to.equal(502);
      expect(error.code).to.equal(ERROR_CODES.SUBWORKSPACE_CREATION_FAILED);
      expect(transport.getWorkspaceStatus).to.have.been.calledTwice;
      expect(sleep).to.have.been.calledOnceWithExactly(1);
      expect(localLog.error).to.have.been.calledOnceWithExactly(
        'pollUntilCreated: sub-workspace settled to a terminal failure status',
        { semrushWorkspaceId: SUB_WS, status: 'creation failed' },
      );
    });

    it('createReadiness "skip": creates and persists WITHOUT the settle poll (LLMO-6569 bare path)', async () => {
      const transport = makeTransport();
      // A not-ready workspace would make the legacy poll spin (and time out); 'skip' must not probe
      // getWorkspaceStatus at all — it persists the pointer immediately and lets it settle async.
      transport.getWorkspaceStatus.resolves({ status: 'not ready' });
      const brand = makeBrand();

      const result = await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        log,
        NOOP_TIMING,
        null,
        { createReadiness: 'skip' },
      );

      expect(result).to.equal(SUB_WS);
      expect(transport.createSubworkspace)
        .to.have.been.calledOnceWithExactly(PARENT_WS, EXPECTED_TITLE);
      // The whole point of the fix: no settle poll on the create path.
      expect(transport.getWorkspaceStatus).to.not.have.been.called;
      // Pointer still persisted immediately, closing the orphan window.
      expect(brand.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly(SUB_WS);
      expect(brand.save).to.have.been.calledOnce;
    });

    it('detects a terminal status when a skip-mode workspace is checked later', async () => {
      const sleep = sinon.stub().resolves();
      const localLog = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };
      const transport = makeTransport({
        getWorkspaceStatus: sinon.stub().resolves({ status: 'creation failed' }),
      });
      const brand = makeBrand();

      await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        localLog,
        { attempts: 3, intervalMs: 1, sleep },
        null,
        { createReadiness: 'skip', brandCollection: makeBrandCollection() },
      );

      const error = await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        localLog,
        { attempts: 3, intervalMs: 1, sleep },
      ).catch((e) => e);

      expect(error.status).to.equal(502);
      expect(error.code).to.equal(ERROR_CODES.SUBWORKSPACE_CREATION_FAILED);
      expect(brand.getSemrushSubWorkspaceId()).to.equal(SUB_WS);
      expect(brand.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly(SUB_WS);
      expect(brand.save).to.have.been.calledOnce;
      expect(transport.getWorkspaceStatus).to.have.been.calledOnceWithExactly(SUB_WS);
      expect(sleep).to.not.have.been.called;
    });

    it('adopts a unique created family match after a create timeout (504 recovery preserved)', async () => {
      // True 504-recovery: at proactive-check time nothing is adoptable yet, the
      // create then times out (504) although it actually succeeded upstream, and
      // the now-`created` child appears in the family on the recovery read. GET
      // /v1/workspaces/{id}/family returns a BARE ARRAY (live-verified), not an
      // { items: [...] } envelope; non-matching and non-`created` entries are
      // skipped and the single title match is adopted.
      const listWorkspaceFamily = sinon.stub();
      listWorkspaceFamily.onFirstCall().resolves([]);
      listWorkspaceFamily.onSecondCall().resolves([
        { id: 'other-ws', title: 'Some Other Brand', status: 'created' },
        { id: 'adopted-ws', title: EXPECTED_TITLE, status: 'created' },
      ]);
      const transport = makeTransport({
        createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
        listWorkspaceFamily,
      });
      const brand = makeBrand();

      const result = await ensureWithUnclaimedFamily(transport, brand);

      expect(result).to.equal('adopted-ws');
      expect(transport.createSubworkspace).to.have.been.calledOnce;
      expect(brand.setSemrushSubWorkspaceId).to.have.been.calledWith('adopted-ws');
    });

    it('refuses to adopt a NON-empty created family match (shared empty-check)', async () => {
      // The empty-check is shared by the proactive and 504 paths. A `created`
      // title match that already has projects is some OTHER provisioned workspace,
      // never our interrupted/retried create — refuse rather than graft this brand
      // onto it.
      const transport = makeTransport({
        listWorkspaceFamily: sinon.stub().resolves([
          { id: 'occupied-ws', title: EXPECTED_TITLE, status: 'created' },
        ]),
        listProjects: sinon.stub().resolves({ items: [{ id: 'existing-project' }] }),
      });
      const brand = makeBrand();

      await expect(ensureWithUnclaimedFamily(transport, brand)).to.be.rejectedWith(/refusing to adopt/);
      expect(transport.createSubworkspace).to.not.have.been.called;
      expect(brand.setSemrushSubWorkspaceId).to.not.have.been.called;
    });

    it('throws when the sole created family match has no id', async () => {
      const transport = makeTransport({
        listWorkspaceFamily: sinon.stub().resolves([{ title: EXPECTED_TITLE, status: 'created' }]),
      });
      const brand = makeBrand();

      await expect(ensureWithUnclaimedFamily(transport, brand)).to.be.rejectedWith(/sole family match has no id/);
      expect(transport.createSubworkspace).to.not.have.been.called;
      expect(transport.listProjects).to.not.have.been.called;
    });

    it('hard-fails (never builds an untitled workspace) when the brand has no name', async () => {
      // The title IS the brand's display name; an untitled workspace would collide
      // with every other untitled one and is not something adoption could ever
      // disambiguate. Refuse rather than create one.
      const transport = makeTransport();
      const brand = makeBrand({ name: null });

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING))
        .to.be.rejectedWith(/requires a brand name/);
      expect(transport.createSubworkspace).to.not.have.been.called;
    });

    it('hard-fails on an empty-string brand name', async () => {
      const transport = makeTransport();
      const brand = makeBrand({ name: '' });

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING))
        .to.be.rejectedWith(/requires a brand name/);
      expect(transport.createSubworkspace).to.not.have.been.called;
    });

    describe('claim filter (same-named sibling brands)', () => {
      it('does NOT adopt a same-title workspace already bound to another brand; creates a fresh one', async () => {
        // Titles are bare brand names and names are not unique within an org (prod
        // carries same-named pairs today, some already holding a sub-workspace). The
        // sibling's workspace is empty and `created`, so title+status+empty alone
        // would adopt it — the claim lookup is what keeps this brand off it.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'sibling-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();

        const result = await ensureSubworkspace(
          transport,
          brand,
          PARENT_WS,
          log,
          NOOP_TIMING,
          null,
          { brandCollection: makeBrandCollection({ 'sibling-ws': OTHER_BRAND_ID }) },
        );

        expect(result).to.equal(SUB_WS);
        expect(transport.createSubworkspace).to.have.been.calledOnce;
        expect(brand.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly(SUB_WS);
      });

      it('adopts the one unclaimed match when a claimed same-title sibling shares the listing', async () => {
        // Dropping claimed candidates (rather than escalating to the ambiguity 409)
        // is what keeps a genuine lone match adoptable beside a sibling's workspace.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'sibling-ws', title: EXPECTED_TITLE, status: 'created' },
            { id: 'ours-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();

        const result = await ensureSubworkspace(
          transport,
          brand,
          PARENT_WS,
          log,
          NOOP_TIMING,
          null,
          { brandCollection: makeBrandCollection({ 'sibling-ws': OTHER_BRAND_ID }) },
        );

        expect(result).to.equal('ours-ws');
        expect(transport.createSubworkspace).to.not.have.been.called;
      });

      it('still adopts a candidate claimed by THIS brand (concurrent request for the same brand)', async () => {
        // A parallel request for the same brand may have persisted the pointer while
        // we were listing. That workspace IS ours — adopt it rather than creating a
        // duplicate; the caller's reloadPointer guard settles the race afterwards.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'ours-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();

        const result = await ensureSubworkspace(
          transport,
          brand,
          PARENT_WS,
          log,
          NOOP_TIMING,
          null,
          { brandCollection: makeBrandCollection({ 'ours-ws': BRAND_ID }) },
        );

        expect(result).to.equal('ours-ws');
        expect(transport.createSubworkspace).to.not.have.been.called;
      });

      it('502s on the 504-recovery path when the only same-title match belongs to another brand', async () => {
        // The create timed out AND the sole candidate is a sibling's — we cannot
        // tell whether our create landed, so fail rather than adopt the sibling's.
        const listWorkspaceFamily = sinon.stub();
        listWorkspaceFamily.onFirstCall().resolves([]);
        listWorkspaceFamily.onSecondCall().resolves([
          { id: 'sibling-ws', title: EXPECTED_TITLE, status: 'created' },
        ]);
        const transport = makeTransport({
          createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
          listWorkspaceFamily,
        });
        const brand = makeBrand();

        await expect(ensureSubworkspace(
          transport,
          brand,
          PARENT_WS,
          log,
          NOOP_TIMING,
          null,
          { brandCollection: makeBrandCollection({ 'sibling-ws': OTHER_BRAND_ID }) },
        )).to.be.rejectedWith(/no family match to adopt/);
      });

      it('logs the claimed candidates it ignored', async () => {
        const localLog = { info: sinon.spy(), error: sinon.spy(), warn: sinon.spy() };
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'sibling-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();

        await ensureSubworkspace(
          transport,
          brand,
          PARENT_WS,
          localLog,
          NOOP_TIMING,
          null,
          { brandCollection: makeBrandCollection({ 'sibling-ws': OTHER_BRAND_ID }) },
        );

        const logged = localLog.info.getCalls()
          .find((c) => /already claimed by another brand/.test(c.args[0]));
        expect(logged, 'expected a claimed-candidate log line').to.exist;
        expect(logged.args[1]).to.include({ claimedCount: 1 });
        expect(logged.args[1].claimedIds).to.deep.equal(['sibling-ws']);
      });

      it('500s rather than evaluating a same-title candidate without a Brand collection', async () => {
        // Fail-closed: with no claim lookup the bare title is the only key left,
        // which is exactly the mis-adoption the filter exists to prevent.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'some-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();

        await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING))
          .to.be.rejectedWith(/no Brand collection/);
        expect(transport.createSubworkspace).to.not.have.been.called;
      });

      it('propagates a claim-lookup failure instead of creating blindly (fail-safe)', async () => {
        // If the data layer cannot tell us who owns the candidate we cannot tell our
        // own create from a sibling's, and creating anyway would spawn the duplicate
        // stub the proactive check exists to prevent. Fail rather than guess.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'some-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();
        const brandCollection = {
          findBySemrushSubWorkspaceId: sinon.stub().rejects(new Error('postgrest unavailable')),
        };

        await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING, null, { brandCollection })).to.be.rejectedWith(/postgrest unavailable/);
        expect(transport.createSubworkspace).to.not.have.been.called;
      });

      it('reports a FRESHLY CREATED workspace through onWorkspaceCreated', async () => {
        // Failure compensation keys off this signal rather than the returned id, so it
        // must fire for a workspace this call brought into existence.
        const transport = makeTransport();
        const brand = makeBrand();
        const onWorkspaceCreated = sinon.spy();

        const result = await ensureSubworkspace(
          transport,
          brand,
          PARENT_WS,
          log,
          NOOP_TIMING,
          null,
          { brandCollection: makeBrandCollection(), onWorkspaceCreated },
        );

        expect(result).to.equal(SUB_WS);
        expect(onWorkspaceCreated).to.have.been.calledOnceWithExactly(SUB_WS);
      });

      it('does NOT report an ADOPTED workspace through onWorkspaceCreated', async () => {
        // The whole point of the signal: an adopted workspace may be a same-named sibling
        // brand's whose claim is not persisted yet. A caller that tore it down on failure
        // would delete that brand's projects and strip its allocation.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'adopted-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();
        const onWorkspaceCreated = sinon.spy();

        const result = await ensureSubworkspace(
          transport,
          brand,
          PARENT_WS,
          log,
          NOOP_TIMING,
          null,
          { brandCollection: makeBrandCollection(), onWorkspaceCreated },
        );

        expect(result).to.equal('adopted-ws');
        expect(transport.createSubworkspace).to.not.have.been.called;
        expect(onWorkspaceCreated).to.not.have.been.called;
      });

      it('a concurrency loser does NOT release a workspace it merely adopted', async () => {
        // Losing the pointer race releases OUR workspace back to the parent pool — but only
        // when we created it. Releasing an adopted one would strip a workspace owned by
        // whoever actually created it.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'adopted-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();
        const reloadPointer = sinon.stub().resolves('winner-ws');

        const result = await ensureSubworkspace(
          transport,
          brand,
          PARENT_WS,
          log,
          NOOP_TIMING,
          reloadPointer,
          { brandCollection: makeBrandCollection() },
        );

        expect(result).to.equal('winner-ws');
        // No teardown of the adopted workspace.
        expect(transport.deleteProject).to.not.have.been.called;
        expect(brand.setSemrushSubWorkspaceId).to.not.have.been.called;
      });

      it('needs no Brand collection when the family holds no same-title candidate', async () => {
        // Nothing to mis-adopt → the lookup is not required, so a clean first create
        // is unaffected.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'unrelated-ws', title: 'Some Other Brand', status: 'created' },
          ]),
        });
        const brand = makeBrand();

        const result = await ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING);

        expect(result).to.equal(SUB_WS);
        expect(transport.createSubworkspace).to.have.been.calledOnce;
      });
    });

    it('fails with an ambiguousWorkspace alert on multiple CREATED family matches', async () => {
      // Genuine ambiguity preserved: ≥2 `created` same-title children → 409, never
      // guess. (Non-`created` zombies are filtered out and never reach this count.)
      const transport = makeTransport({
        listWorkspaceFamily: sinon.stub().resolves([
          { id: 'ws-a', title: EXPECTED_TITLE, status: 'created' },
          { id: 'ws-b', title: EXPECTED_TITLE, status: 'created' },
        ]),
      });
      const brand = makeBrand();

      const promise = ensureWithUnclaimedFamily(transport, brand);
      await expect(promise).to.be.rejected;
      try {
        await promise;
      } catch (e) {
        expect(e.code).to.equal('ambiguousWorkspace');
        expect(e.status).to.equal(409);
      }
      expect(transport.createSubworkspace).to.not.have.been.called;
      expect(brand.save).to.not.have.been.called;
    });

    it('throws when an ambiguous create has no family match to adopt', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
        listWorkspaceFamily: sinon.stub().resolves([]),
      });
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING))
        .to.be.rejectedWith(/no family match to adopt/);
    });

    it('re-throws a non-timeout create error', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING))
        .to.be.rejectedWith(SerenityTransportError);
    });

    it('404s when there is no parent workspace to create under', async () => {
      const transport = makeTransport();
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, '', log, NOOP_TIMING))
        .to.be.rejectedWith(/has no parent workspace/);
    });

    describe('failed-provisioning stub hardening (issue #2718)', () => {
      it('idempotent create-or-adopt: reuses an existing created empty same-title child instead of creating a duplicate', async () => {
        // Mitigation 2: a retry must reuse the good child, not spawn another stub.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'existing-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();

        const result = await ensureWithUnclaimedFamily(transport, brand);

        expect(result).to.equal('existing-ws');
        expect(transport.createSubworkspace).to.not.have.been.called;
        expect(brand.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly('existing-ws');
        expect(brand.save).to.have.been.calledOnce;
      });

      // LLMO-7352: the READY superset must be applied CONSISTENTLY — a family candidate that
      // settled to 'active'/'ready' (not the literal 'created') is healthy and must be adopted,
      // NOT swept into the ignored-zombie branch and duplicated. Before the fix, pollUntilCreated
      // recognized these three ready strings but findAdoptableFamilyMatch still hard-coded
      // `=== 'created'`, so an 'active' twin got a brand-new duplicate sub-workspace.
      ['active', 'ready'].forEach((readyStatus) => {
        it(`adopts a same-title family child in the '${readyStatus}' ready state (no duplicate create)`, async () => {
          const transport = makeTransport({
            listWorkspaceFamily: sinon.stub().resolves([
              { id: 'existing-ws', title: EXPECTED_TITLE, status: readyStatus },
            ]),
          });
          const brand = makeBrand();

          const result = await ensureWithUnclaimedFamily(transport, brand);

          expect(result).to.equal('existing-ws');
          expect(transport.createSubworkspace).to.not.have.been.called;
          expect(brand.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly('existing-ws');
        });
      });

      it('does NOT adopt a single not-ready zombie stub; creates a fresh workspace', async () => {
        // Mitigation 1: a failed-provisioning stub (status 'not ready', 0 projects)
        // is invisible to the matcher, so it is never falsely adopted.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'zombie-ws', title: EXPECTED_TITLE, status: 'not ready' },
          ]),
        });
        const brand = makeBrand();

        const result = await ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING);

        expect(result).to.equal(SUB_WS);
        expect(transport.createSubworkspace).to.have.been.calledOnce;
        expect(brand.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly(SUB_WS);
      });

      it('adopts the one created match when a not-ready zombie shares the title', async () => {
        // Mitigation 1: exactly one `created` among same-title entries → adopt it,
        // no false 409 from the co-resident zombie.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'zombie-ws', title: EXPECTED_TITLE, status: 'not ready' },
            { id: 'good-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();

        const result = await ensureWithUnclaimedFamily(transport, brand);

        expect(result).to.equal('good-ws');
        expect(transport.createSubworkspace).to.not.have.been.called;
        expect(brand.setSemrushSubWorkspaceId).to.have.been.calledWith('good-ws');
      });

      it('accumulated not-ready zombies do NOT inflate the ambiguity 409; create proceeds', async () => {
        // Mitigation 1: ≥2 same-title zombies but zero `created` → no false 409;
        // the snowball is broken and a fresh create proceeds.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'zombie-1', title: EXPECTED_TITLE, status: 'not ready' },
            { id: 'zombie-2', title: EXPECTED_TITLE, status: 'not ready' },
          ]),
        });
        const brand = makeBrand();

        const result = await ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING);

        expect(result).to.equal(SUB_WS);
        expect(transport.createSubworkspace).to.have.been.calledOnce;
      });

      it('logs the count of ignored non-created same-title stubs and dedupes their statuses', async () => {
        // Zombies accumulating under a brand should be visible in logs without a
        // manual family query — the proactive find emits an info line. ignoredCount
        // conveys volume; ignoredStatuses is deduped so repeated stubs sharing a
        // status do not bloat the line.
        const localLog = { info: sinon.spy(), error: sinon.spy(), warn: sinon.spy() };
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'zombie-1', title: EXPECTED_TITLE, status: 'not ready' },
            { id: 'zombie-2', title: EXPECTED_TITLE, status: 'not ready' },
            { id: 'zombie-3', title: EXPECTED_TITLE, status: 'invalid subscription' },
          ]),
        });
        const brand = makeBrand();

        await ensureSubworkspace(transport, brand, PARENT_WS, localLog, NOOP_TIMING);

        const logged = localLog.info.getCalls()
          .find((c) => /ignoring non-created same-title/.test(c.args[0]));
        expect(logged, 'expected an ignored-stub log line').to.exist;
        expect(logged.args[1]).to.include({ ignoredCount: 3 });
        expect(logged.args[1].ignoredStatuses).to.have.members(['not ready', 'invalid subscription']);
        expect(logged.args[1].ignoredStatuses).to.have.lengthOf(2);
      });

      it('does NOT log ignored stubs when no same-title stub exists (clean first create)', async () => {
        // Happy path: empty family → no ignored-stub noise.
        const localLog = { info: sinon.spy(), error: sinon.spy(), warn: sinon.spy() };
        const transport = makeTransport();
        const brand = makeBrand();

        await ensureSubworkspace(transport, brand, PARENT_WS, localLog, NOOP_TIMING);

        const logged = localLog.info.getCalls()
          .find((c) => /ignoring non-created same-title/.test(c.args[0]));
        expect(logged, 'expected no ignored-stub log line').to.not.exist;
      });

      it('propagates a listWorkspaceFamily error from the proactive check (fail-safe: no blind create)', async () => {
        // If we cannot read the family we cannot know whether a created child
        // already exists, so creating blindly would risk the very duplicate-stub
        // problem this guard prevents. Fail rather than create.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().rejects(new SerenityTransportError(503, 'upstream down')),
        });
        const brand = makeBrand();

        await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING))
          .to.be.rejectedWith(SerenityTransportError);
        expect(transport.createSubworkspace).to.not.have.been.called;
      });
    });

    describe('parent workspace title collision (LLMO-7349)', () => {
      // The family endpoint returns the queried parent itself as one of its own family
      // items (live-verified against the gateway). A brand named identically to the
      // parent workspace's title must never let the parent reach the adoption
      // candidate set — only a genuine child may ever be created or adopted.
      it('proactive create-or-adopt: does not adopt a same-titled, created, empty PARENT; creates a fresh child instead', async () => {
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: PARENT_WS, title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();

        const result = await ensureWithUnclaimedFamily(transport, brand);

        expect(result).to.equal(SUB_WS);
        expect(transport.createSubworkspace).to.have.been.calledOnceWith(PARENT_WS, EXPECTED_TITLE);
        expect(transport.listProjects).to.not.have.been.calledWith(PARENT_WS);
        expect(brand.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly(SUB_WS);
      });

      it('adopts the real same-titled CHILD and ignores the same-titled parent sitting beside it', async () => {
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: PARENT_WS, title: EXPECTED_TITLE, status: 'created' },
            { id: 'real-child-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
        });
        const brand = makeBrand();

        const result = await ensureWithUnclaimedFamily(transport, brand);

        expect(result).to.equal('real-child-ws');
        expect(transport.createSubworkspace).to.not.have.been.called;
        expect(transport.listProjects).to.have.been.calledOnceWith('real-child-ws');
        expect(brand.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly('real-child-ws');
      });

      it('504-recovery: reports no adoptable family match rather than adopting the parent', async () => {
        const listWorkspaceFamily = sinon.stub();
        listWorkspaceFamily.onFirstCall().resolves([]);
        listWorkspaceFamily.onSecondCall().resolves([
          { id: PARENT_WS, title: EXPECTED_TITLE, status: 'created' },
        ]);
        const transport = makeTransport({
          createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
          listWorkspaceFamily,
        });
        const brand = makeBrand();

        await expect(ensureWithUnclaimedFamily(transport, brand))
          .to.be.rejectedWith(/no family match to adopt/);
        expect(listWorkspaceFamily).to.have.been.calledTwice;
        expect(transport.listProjects).to.not.have.been.called;
        expect(brand.setSemrushSubWorkspaceId).to.not.have.been.called;
      });
    });

    it('502s when create returns no id', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().resolves({ id: '' }),
      });
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING))
        .to.be.rejectedWith(/returned no workspace id/);
    });

    it('504s when the workspace never settles to created', async () => {
      const sleep = sinon.stub().resolves();
      const localLog = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };
      const transport = makeTransport({
        getWorkspaceStatus: sinon.stub().resolves({ status: 'not ready' }),
      });
      const brand = makeBrand();

      const error = await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        localLog,
        { attempts: 2, intervalMs: 0, sleep },
      ).catch((e) => e);

      expect(error.status).to.equal(504);
      expect(error.code).to.equal(ERROR_CODES.SUBWORKSPACE_CREATION_TIMEOUT);
      expect(transport.getWorkspaceStatus).to.have.been.calledTwice;
      expect(sleep).to.have.been.calledTwice;
      expect(localLog.error).to.have.been.calledOnceWithExactly(
        'pollUntilCreated: sub-workspace did not settle to a ready status in time',
        { semrushWorkspaceId: SUB_WS },
      );
    });

    // LLMO-7352: a workspace that settles to a terminal failure status never becomes `created`.
    // Ported from mysticat-data-service/scripts/serenity_migration/semrush_write.py's
    // wait_workspace_created, which observed this exact superset of terminal statuses in
    // practice (WORKSPACE_CREATION_FAILED_STATUSES / WORKSPACE_FAILED_STATUSES) rather than the
    // single `creation failed` string this poller used to recognize.
    ['creation_failed', 'creation failed', 'failed', 'error'].forEach((terminalStatus) => {
      it(`fails fast on the FIRST poll (not the timeout) when the fresh create settles to '${terminalStatus}'`, async () => {
        const getWorkspaceStatus = sinon.stub().resolves({ status: terminalStatus });
        const transport = makeTransport({ getWorkspaceStatus });
        const brand = makeBrand();
        const sleep = sinon.stub().resolves();

        const err = await ensureSubworkspace(
          transport,
          brand,
          PARENT_WS,
          log,
          { attempts: 30, intervalMs: 1000, sleep },
          null,
          { brandCollection: makeBrandCollection() },
        ).catch((e) => e);

        expect(err).to.be.instanceOf(Error);
        expect(err.status).to.equal(502);
        expect(err.code).to.equal(ERROR_CODES.SUBWORKSPACE_CREATION_FAILED);
        // Sanitized: never leaks the raw workspace id into the client-facing message (unlike
        // the generic 'did not settle to created in time' timeout below).
        expect(err.message).to.not.include(SUB_WS);
        // Fails on the very FIRST read — proves this is not just "a shorter timeout": with a
        // 30-attempt/1000ms budget, retrying even once would mean this test's sleep stub was
        // invoked, and it never was.
        expect(getWorkspaceStatus).to.have.been.calledOnce;
        expect(sleep).to.not.have.been.called;
      });

      it(`fails fast when the EXISTING pointer branch reads '${terminalStatus}' (the repeated-Add-Market-retry case, LLMO-7352 CUHK incident)`, async () => {
        const getWorkspaceStatus = sinon.stub().resolves({ status: terminalStatus });
        const transport = makeTransport({ getWorkspaceStatus });
        const brand = makeBrand({ workspaceId: SUB_WS });
        const sleep = sinon.stub().resolves();

        const err = await ensureSubworkspace(
          transport,
          brand,
          PARENT_WS,
          log,
          { attempts: 30, intervalMs: 1000, sleep },
        ).catch((e) => e);

        expect(err.status).to.equal(502);
        expect(err.code).to.equal(ERROR_CODES.SUBWORKSPACE_CREATION_FAILED);
        expect(getWorkspaceStatus).to.have.been.calledOnce;
        expect(sleep).to.not.have.been.called;
      });
    });

    // The gateway has been observed to settle a successful create to more than one status
    // string — ported from the same Python reference's WORKSPACE_READY_STATUSES. Before this
    // fix, only the literal 'created' was recognized, so a workspace that legitimately settled
    // to 'active' or 'ready' would be misread as still-pending and poll out to a false timeout.
    ['created', 'active', 'ready'].forEach((readyStatus) => {
      it(`treats '${readyStatus}' as settled (no false timeout on a legitimately-ready workspace)`, async () => {
        const transport = makeTransport({
          getWorkspaceStatus: sinon.stub().resolves({ status: readyStatus }),
        });
        const brand = makeBrand({ workspaceId: SUB_WS });

        await expect(
          ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING),
        ).to.be.fulfilled;
      });
    });

    // LLMO-7352: the gateway is not case/whitespace-stable, and the Python reference this is
    // ported from normalizes (`.lower()`) before comparing. A mixed-case / padded variant of a
    // status must resolve to the same classification, or the fast-fail silently regresses to the
    // full poll-then-timeout it exists to prevent.
    [
      { raw: 'Creation_Failed', kind: 'terminal' },
      { raw: 'CREATION FAILED', kind: 'terminal' },
      { raw: '  failed  ', kind: 'terminal' },
      { raw: 'Created', kind: 'ready' },
      { raw: ' ACTIVE ', kind: 'ready' },
    ].forEach(({ raw, kind }) => {
      it(`normalizes a mixed-case/padded status '${raw}' as ${kind}`, async () => {
        const getWorkspaceStatus = sinon.stub().resolves({ status: raw });
        const transport = makeTransport({ getWorkspaceStatus });
        const brand = makeBrand({ workspaceId: SUB_WS });
        const sleep = sinon.stub().resolves();

        const timing = { attempts: 30, intervalMs: 1000, sleep };
        const promise = ensureSubworkspace(transport, brand, PARENT_WS, log, timing);

        if (kind === 'ready') {
          await expect(promise).to.be.fulfilled;
          expect(sleep).to.not.have.been.called;
        } else {
          const err = await promise.catch((e) => e);
          expect(err.status).to.equal(502);
          expect(err.code).to.equal(ERROR_CODES.SUBWORKSPACE_CREATION_FAILED);
          // Still fails on the FIRST read — normalization does not cost an extra poll.
          expect(getWorkspaceStatus).to.have.been.calledOnce;
          expect(sleep).to.not.have.been.called;
        }
      });
    });

    // LLMO-7352: the failing workspace id must NOT be in the client-facing (thrown) message — it
    // flows through mapError/safeError, which does not redact ids — but MUST be captured in a log
    // line so triage can find it. Both the terminal-failure and the timeout paths.
    it('logs the workspace id (never in the thrown message) on a terminal failure', async () => {
      const spyLog = { info: sinon.spy(), error: sinon.spy(), warn: sinon.spy() };
      const transport = makeTransport({
        getWorkspaceStatus: sinon.stub().resolves({ status: 'creation failed' }),
      });
      const brand = makeBrand({ workspaceId: SUB_WS });

      const err = await ensureSubworkspace(transport, brand, PARENT_WS, spyLog, NOOP_TIMING)
        .catch((e) => e);

      expect(err.code).to.equal(ERROR_CODES.SUBWORKSPACE_CREATION_FAILED);
      expect(err.message).to.not.include(SUB_WS);
      // The id (and the raw status) are captured in a structured log line instead.
      expect(spyLog.error).to.have.been.calledWithMatch(
        sinon.match.string,
        sinon.match({ semrushWorkspaceId: SUB_WS, status: 'creation failed' }),
      );
    });

    it('logs the workspace id and keeps it out of the timeout (504) message', async () => {
      const spyLog = { info: sinon.spy(), error: sinon.spy(), warn: sinon.spy() };
      const transport = makeTransport({
        getWorkspaceStatus: sinon.stub().resolves({ status: 'not ready' }),
      });
      const brand = makeBrand({ workspaceId: SUB_WS });

      const timing = { attempts: 2, intervalMs: 0, sleep: () => Promise.resolve() };
      const err = await ensureSubworkspace(transport, brand, PARENT_WS, spyLog, timing)
        .catch((e) => e);

      expect(err.status).to.equal(504);
      // Regression guard (LLMO-7352): the pre-fix message embedded `${workspaceId}`, leaking the
      // Semrush UUID to the client through mapError. It must not anymore.
      expect(err.message).to.not.include(SUB_WS);
      expect(err.message).to.match(/did not settle to 'created'/);
      expect(spyLog.error).to.have.been.calledWithMatch(
        sinon.match.string,
        sinon.match({ semrushWorkspaceId: SUB_WS }),
      );
    });

    it('uses the real timer when no sleep is injected (bounded poll)', async () => {
      const transport = makeTransport({
        getWorkspaceStatus: sinon.stub().resolves({ status: 'not ready' }),
      });
      const brand = makeBrand({ workspaceId: SUB_WS });

      // attempts:1, intervalMs:0, sleep NOT injected -> exercises the default
      // setTimeout-based sleep once before the bounded poll gives up.
      const timing = { attempts: 1, intervalMs: 0 };
      await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, timing))
        .to.be.rejectedWith(/did not settle to 'created'/);
    });

    it('refuses to re-grant onto a workspace that IS the org parent', async () => {
      const transport = makeTransport();
      const brand = makeBrand({ workspaceId: PARENT_WS });

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING))
        .to.be.rejectedWith(/must not be the organization parent workspace/);
    });

    it('refuses to persist a created workspace that IS the org parent', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().resolves({ id: PARENT_WS, status: 'not ready' }),
      });
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING))
        .to.be.rejectedWith(/must not be the organization parent workspace/);
      expect(brand.save).to.not.have.been.called;
    });

    it('empties the orphaned workspace it created', async () => {
      // reloadPointer reports a DIFFERENT id was persisted while we created ours.
      // The orphan's projects are emptied (defensively — it is provably already empty); the
      // shell is left in place (production never deletes a sub-workspace) and no resource
      // transfer is issued, because the orphan never carried an allocation.
      const transport = makeTransport();
      const brand = makeBrand();
      const reloadPointer = sinon.stub().resolves('winner-ws');

      const result = await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        log,
        NOOP_TIMING,
        reloadPointer,
      );

      expect(result).to.equal('winner-ws');
      expect(transport.listProjects).to.have.been.calledWith(SUB_WS);
      expect(transport.deleteWorkspace).to.not.have.been.called;
      // The winner's pointer is NOT clobbered.
      expect(brand.setSemrushSubWorkspaceId).to.not.have.been.called;
      expect(brand.save).to.not.have.been.called;
    });

    it('still persists when reloadPointer reports no concurrent winner', async () => {
      const transport = makeTransport();
      const brand = makeBrand();
      const reloadPointer = sinon.stub().resolves(null);

      const result = await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        log,
        NOOP_TIMING,
        reloadPointer,
      );

      expect(result).to.equal(SUB_WS);
      expect(brand.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly(SUB_WS);
      expect(brand.save).to.have.been.calledOnce;
    });

    // CHARACTERIZATION (residual race, intentionally unfixed pending the tracked
    // conditional "set pointer where pointer is null" data-layer write): two
    // requests that BOTH re-read null in the same instant BOTH persist their own
    // freshly-created workspace id — neither sees the other's winner, so neither
    // releases. This pins the documented divergence so the future conditional-
    // write fix has a failing-then-passing target to flip.
    it('both-read-null: two concurrent activations both persist their own workspace (documents the residual race)', async () => {
      const brandA = makeBrand();
      const brandB = makeBrand();
      // Each request creates a distinct workspace and re-reads null (the loser's
      // write has not landed yet from its own vantage point).
      const transportA = makeTransport({
        createSubworkspace: sinon.stub().resolves({ id: 'ws-A', status: 'not ready' }),
      });
      const transportB = makeTransport({
        createSubworkspace: sinon.stub().resolves({ id: 'ws-B', status: 'not ready' }),
      });
      const reloadNull = sinon.stub().resolves(null);

      const [resA, resB] = await Promise.all([
        ensureSubworkspace(transportA, brandA, PARENT_WS, log, NOOP_TIMING, reloadNull),
        ensureSubworkspace(transportB, brandB, PARENT_WS, log, NOOP_TIMING, reloadNull),
      ]);

      // Both persist (divergent): neither releases its allocation, both save.
      expect(resA).to.equal('ws-A');
      expect(resB).to.equal('ws-B');
      expect(brandA.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly('ws-A');
      expect(brandB.setSemrushSubWorkspaceId).to.have.been.calledOnceWithExactly('ws-B');
    });

    it('tolerates a failed release when adopting a concurrent winner', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().rejects(new Error('release boom')),
      });
      const brand = makeBrand();
      const reloadPointer = sinon.stub().resolves('winner-ws');

      const result = await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        log,
        NOOP_TIMING,
        reloadPointer,
      );

      expect(result).to.equal('winner-ws');
      expect(brand.setSemrushSubWorkspaceId).to.not.have.been.called;
    });
  });

  describe('decommissionBrandWorkspace', () => {
    it('deletes every listed project and leaves the shell in place', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }, { id: 'p2' }] }),
      });
      const localLog = { info: sinon.spy(), error: sinon.spy(), warn: sinon.spy() };

      await decommissionBrandWorkspace(transport, SUB_WS, localLog);

      expect(transport.deleteProject).to.have.been.calledWith(SUB_WS, 'p1');
      expect(transport.deleteProject).to.have.been.calledWith(SUB_WS, 'p2');
      // The shell is never deleted (production never deletes a sub-workspace) and carries no
      // allocation to reclaim, so decommission issues no resource transfer at all.
      expect(transport.deleteWorkspace).to.not.have.been.called;
      const infoLine = localLog.info.getCalls().find((c) => /emptied projects/.test(c.args[0]));
      expect(infoLine, 'expected an emptied-projects info summary').to.exist;
      expect(infoLine.args[1]).to.include({ subworkspaceId: SUB_WS, deletedProjects: 2 });
    });

    it('treats an upstream 404 on project delete as success (convergent)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'gone' }] }),
        deleteProject: sinon.stub().rejects(new SerenityTransportError(404, 'not found')),
      });

      await decommissionBrandWorkspace(transport, SUB_WS, log);

      expect(transport.deleteProject).to.have.been.calledOnce;
    });

    it('propagates a non-404 delete failure', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
        deleteProject: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });

      await expect(decommissionBrandWorkspace(transport, SUB_WS, log))
        .to.be.rejectedWith(SerenityTransportError);
      expect(transport.deleteWorkspace).to.not.have.been.called;
    });

    it('skips listing items without an id', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: '' }, {}, { id: 'p1' }] }),
      });

      await decommissionBrandWorkspace(transport, SUB_WS, log);

      expect(transport.deleteProject).to.have.been.calledOnceWithExactly(SUB_WS, 'p1');
    });

    it('is a no-op for a blank workspace id', async () => {
      const transport = makeTransport();

      await decommissionBrandWorkspace(transport, '', log);

      expect(transport.listProjects).to.not.have.been.called;
      expect(transport.deleteWorkspace).to.not.have.been.called;
    });

    it('refuses to decommission the org parent workspace (self-defending)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
      });

      await expect(decommissionBrandWorkspace(transport, PARENT_WS, log, PARENT_WS))
        .to.be.rejectedWith(/must not be the organization parent workspace/);
      expect(transport.deleteProject).to.not.have.been.called;
      expect(transport.deleteWorkspace).to.not.have.been.called;
    });

    it('refuses to decommission a workspace with active linked sub-workspaces (guard enabled)', async () => {
      // family is a BARE ARRAY (live gateway shape): a no-id entry and the target
      // itself are ignored, the one real child blocks the decommission. The old
      // family?.items read saw zero children here and would have proceeded —
      // silently decommissioning a parent with live children.
      const transport = makeTransport({
        listWorkspaceFamily: sinon.stub().resolves([{ id: SUB_WS }, {}, { id: 'child-1' }]),
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
      });

      const promise = decommissionBrandWorkspace(
        transport,
        SUB_WS,
        log,
        PARENT_WS,
        { enforceLinkedGuard: true },
      );
      await expect(promise).to.be.rejectedWith(/active linked sub-workspace/);
      try {
        await promise;
      } catch (e) {
        expect(e.status).to.equal(409);
        expect(e.code).to.equal('linkedSubworkspaces');
      }
      expect(transport.deleteProject).to.not.have.been.called;
    });

    it('ignores the target own id in the family listing and proceeds (guard enabled)', async () => {
      const transport = makeTransport({
        listWorkspaceFamily: sinon.stub().resolves([{ id: SUB_WS }]),
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
      });

      await decommissionBrandWorkspace(
        transport,
        SUB_WS,
        log,
        PARENT_WS,
        { enforceLinkedGuard: true },
      );

      expect(transport.deleteProject).to.have.been.calledOnceWithExactly(SUB_WS, 'p1');
      expect(transport.deleteWorkspace).to.not.have.been.called;
    });

    it('SKIPS the linked-sub-workspace guard by default (flag off, family not queried)', async () => {
      // Default (no options): the unverified family-direction guard is OFF, so a
      // family listing that WOULD report a child does not block, and the family
      // endpoint is never called. Parent-equality guard remains always-on.
      const transport = makeTransport({
        listWorkspaceFamily: sinon.stub().resolves([{ id: 'child-1' }]),
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
      });

      await decommissionBrandWorkspace(transport, SUB_WS, log, PARENT_WS);

      expect(transport.listWorkspaceFamily).to.not.have.been.called;
      expect(transport.deleteProject).to.have.been.calledOnceWithExactly(SUB_WS, 'p1');
      expect(transport.deleteWorkspace).to.not.have.been.called;
    });
  });
  describe('defensive branch coverage', () => {
    describe('adoptFromFamily - listWorkspaceFamily resolves non-array', () => {
      it('throws when listWorkspaceFamily returns a non-array body ({})', async () => {
        // familyItems guard: a non-array response (null / malformed) → [] → no match.
        const transport = makeTransport({
          createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
          listWorkspaceFamily: sinon.stub().resolves({}),
        });
        const brand = makeBrand();

        await expect(ensureSubworkspace(transport, brand, PARENT_WS, log, NOOP_TIMING))
          .to.be.rejectedWith(/no family match to adopt/);
      });
    });

    describe('findAdoptableFamilyMatch adopt path - listProjects resolves non-array', () => {
      it('adopts the empty match when listProjects returns {} (projectCount = 0)', async () => {
        // Array.isArray false branch -> projectCount = 0 -> adopts.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves([
            { id: 'adopted-ws', title: EXPECTED_TITLE, status: 'created' },
          ]),
          listProjects: sinon.stub().resolves({}),
        });
        const brand = makeBrand();

        const result = await ensureWithUnclaimedFamily(transport, brand);

        expect(result).to.equal('adopted-ws');
        expect(transport.createSubworkspace).to.not.have.been.called;
        expect(brand.setSemrushSubWorkspaceId).to.have.been.calledWith('adopted-ws');
      });
    });

    describe('decommissionBrandWorkspace - listWorkspaceFamily resolves non-array (guard enabled)', () => {
      it('treats {} response as empty children list and proceeds with decommission', async () => {
        // Line 377: Array.isArray false branch -> children = [] -> guard passes.
        const transport = makeTransport({
          listWorkspaceFamily: sinon.stub().resolves({}),
          listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
        });

        await decommissionBrandWorkspace(
          transport,
          SUB_WS,
          log,
          PARENT_WS,
          { enforceLinkedGuard: true },
        );

        expect(transport.deleteProject).to.have.been.calledOnceWithExactly(SUB_WS, 'p1');
      });
    });

    describe('decommissionBrandWorkspace - listProjects resolves non-array', () => {
      it('treats {} listing as no projects and issues no deletes', async () => {
        // Line 390: Array.isArray false branch -> projects = [] -> no deletes.
        const transport = makeTransport({
          listProjects: sinon.stub().resolves({}),
        });

        await decommissionBrandWorkspace(transport, SUB_WS, log);

        expect(transport.deleteProject).to.not.have.been.called;
        expect(transport.deleteWorkspace).to.not.have.been.called;
      });
    });
    describe('poll timing defaults (intervalMs and sleep fallbacks)', () => {
      it('uses DEFAULT_POLL_INTERVAL_MS when intervalMs is absent from timing', async () => {
        // Line 215: timing.intervalMs ?? DEFAULT_POLL_INTERVAL_MS right branch.
        // Pass timing without intervalMs; getWorkspaceStatus immediately returns
        // 'created' so sleep is never called and no real delay occurs.
        const transport = makeTransport();
        const brand = makeBrand({ workspaceId: SUB_WS });

        const result = await ensureSubworkspace(
          transport,
          brand,
          PARENT_WS,
          log,
          { attempts: 1, sleep: () => Promise.resolve() },
        );

        expect(result).to.equal(SUB_WS);
      });
    });
  });

  describe('deleteAllProjects (LLMO-6189)', () => {
    it('treats a typed upstream 404 from the initial listing as zero projects', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().rejects(
          new ProjectEngineApiError(404, 'GET', { message: 'not found' }),
        ),
      });

      const count = await deleteAllProjects(transport, SUB_WS);

      expect(count).to.equal(0);
      expect(transport.deleteProject).to.not.have.been.called;
    });

    it('propagates a typed non-404 failure from the initial listing', async () => {
      const error = new ProjectEngineApiError(500, 'GET', { message: 'boom' });
      const transport = makeTransport({
        listProjects: sinon.stub().rejects(error),
      });

      await expect(deleteAllProjects(transport, SUB_WS)).to.be.rejectedWith(error);
      expect(transport.deleteProject).to.not.have.been.called;
    });

    it('propagates an untyped 404 failure from the initial listing', async () => {
      const error = Object.assign(new Error('not found'), { status: 404 });
      const transport = makeTransport({
        listProjects: sinon.stub().rejects(error),
      });

      await expect(deleteAllProjects(transport, SUB_WS)).to.be.rejectedWith(error);
      expect(transport.deleteProject).to.not.have.been.called;
    });

    it('deletes every listed project and returns the count', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }, { id: 'p2' }] }),
      });

      const count = await deleteAllProjects(transport, SUB_WS);

      expect(count).to.equal(2);
      expect(transport.deleteProject).to.have.been.calledWith(SUB_WS, 'p1');
      expect(transport.deleteProject).to.have.been.calledWith(SUB_WS, 'p2');
    });

    it('treats an upstream 404 as success (convergent) and still counts the item', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'gone' }] }),
        deleteProject: sinon.stub().rejects(new SerenityTransportError(404, 'not found')),
      });

      const count = await deleteAllProjects(transport, SUB_WS);

      expect(count).to.equal(1);
    });

    it('propagates a non-404 delete failure', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
        deleteProject: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });

      await expect(deleteAllProjects(transport, SUB_WS)).to.be.rejectedWith(SerenityTransportError);
    });

    it('skips items without an id and treats a non-array listing as empty', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: '' }, {}, { id: 'p1' }] }),
      });

      const count = await deleteAllProjects(transport, SUB_WS);

      expect(count).to.equal(3);
      expect(transport.deleteProject).to.have.been.calledOnceWithExactly(SUB_WS, 'p1');

      const transport2 = makeTransport({ listProjects: sinon.stub().resolves({}) });
      const count2 = await deleteAllProjects(transport2, SUB_WS);
      expect(count2).to.equal(0);
      expect(transport2.deleteProject).to.not.have.been.called;
    });

    it('refuses to empty the org parent workspace (self-defending)', async () => {
      // The guard lives in this primitive, so it holds for every caller — emptying the parent
      // would delete every brand's markets across the whole org. It must fire before the
      // listing, not after.
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
      });

      await expect(deleteAllProjects(transport, PARENT_WS, PARENT_WS))
        .to.be.rejectedWith(/must not be the organization parent workspace/);
      expect(transport.listProjects).to.not.have.been.called;
      expect(transport.deleteProject).to.not.have.been.called;
    });
  });

  // LLMO-7418: emptyWorkspaceBestEffort moved here from brand-provisioning.js so the async
  // provisioning worker shares the exact same cleanup primitive. Direct coverage of its own
  // "never throws, logs either way" contract — previously only exercised indirectly through
  // provisionBrandSubworkspace's real (unmocked) call chain.
  describe('emptyWorkspaceBestEffort', () => {
    it('deletes every project and logs info on success', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
      });
      const spyLog = { info: sinon.stub(), error: sinon.stub() };

      await emptyWorkspaceBestEffort(transport, SUB_WS, PARENT_WS, spyLog, 'test-phase');

      expect(transport.deleteProject).to.have.been.calledOnceWithExactly(SUB_WS, 'p1');
      expect(spyLog.info).to.have.been.calledOnceWithExactly(
        'serenity: emptied sub-workspace',
        { semrushWorkspaceId: SUB_WS, phase: 'test-phase' },
      );
      expect(spyLog.error).to.not.have.been.called;
    });

    it('never throws — swallows a cleanup failure and logs it at error with the workspace id', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().rejects(new Error('cleanup network error')),
      });
      const spyLog = { info: sinon.stub(), error: sinon.stub() };

      // Must resolve, not reject — the caller is always already on an error/cleanup path.
      await expect(emptyWorkspaceBestEffort(transport, SUB_WS, PARENT_WS, spyLog, 'test-phase'))
        .to.be.fulfilled;

      expect(spyLog.error).to.have.been.calledOnceWithExactly(
        'serenity: failed to empty sub-workspace',
        { semrushWorkspaceId: SUB_WS, phase: 'test-phase', error: 'cleanup network error' },
      );
      expect(spyLog.info).to.not.have.been.called;
    });

    it('tolerates a missing log (log?. guards)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().rejects(new Error('boom')),
      });
      await expect(emptyWorkspaceBestEffort(transport, SUB_WS, PARENT_WS, undefined, 'test-phase'))
        .to.be.fulfilled;
    });
  });

  // LLMO-7418: the create-or-adopt core extracted from ensureSubworkspace so the async
  // provisioning worker can reuse it without the settle poll or the canonical persist. These
  // tests cover the extraction itself; the underlying claim-filter/504-recovery behavior is
  // already covered exhaustively via ensureSubworkspace above — not re-duplicated here.
  describe('createOrAdoptSubworkspaceCandidate', () => {
    it('creates a fresh workspace when no adoptable family match exists', async () => {
      const transport = makeTransport();
      const claim = { brandCollection: makeBrandCollection() };

      const result = await createOrAdoptSubworkspaceCandidate(
        transport,
        PARENT_WS,
        EXPECTED_TITLE,
        log,
        claim,
      );

      expect(result).to.deep.equal({ workspaceId: SUB_WS, freshlyCreated: true });
      expect(transport.createSubworkspace)
        .to.have.been.calledOnceWithExactly(PARENT_WS, EXPECTED_TITLE);
    });

    it('adopts an existing same-title family match instead of creating a duplicate', async () => {
      const transport = makeTransport({
        listWorkspaceFamily: sinon.stub().resolves([
          { id: 'existing-ws', title: EXPECTED_TITLE, status: 'created' },
        ]),
      });
      const claim = { brandCollection: makeBrandCollection() };

      const result = await createOrAdoptSubworkspaceCandidate(
        transport,
        PARENT_WS,
        EXPECTED_TITLE,
        log,
        claim,
      );

      expect(result).to.deep.equal({ workspaceId: 'existing-ws', freshlyCreated: false });
      expect(transport.createSubworkspace).to.not.have.been.called;
    });

    it('recovers via family adoption on a 504 ambiguous-create timeout', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
        listWorkspaceFamily: sinon.stub().resolves([
          { id: 'recovered-ws', title: EXPECTED_TITLE, status: 'created' },
        ]),
      });
      const claim = { brandCollection: makeBrandCollection() };

      const result = await createOrAdoptSubworkspaceCandidate(
        transport,
        PARENT_WS,
        EXPECTED_TITLE,
        log,
        claim,
      );

      expect(result).to.deep.equal({ workspaceId: 'recovered-ws', freshlyCreated: false });
    });

    it('re-throws a non-504 create failure', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().rejects(new Error('boom')),
      });
      const claim = { brandCollection: makeBrandCollection() };

      await expect(
        createOrAdoptSubworkspaceCandidate(transport, PARENT_WS, EXPECTED_TITLE, log, claim),
      ).to.be.rejectedWith('boom');
    });

    it('throws 502 when create returns no workspace id', async () => {
      const transport = makeTransport({ createSubworkspace: sinon.stub().resolves({}) });
      const claim = { brandCollection: makeBrandCollection() };

      await expect(
        createOrAdoptSubworkspaceCandidate(transport, PARENT_WS, EXPECTED_TITLE, log, claim),
      ).to.be.rejectedWith(/returned no workspace id/);
    });

    it('refuses a workspace id that IS the org parent', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().resolves({ id: PARENT_WS }),
      });
      const claim = { brandCollection: makeBrandCollection() };

      await expect(
        createOrAdoptSubworkspaceCandidate(transport, PARENT_WS, EXPECTED_TITLE, log, claim),
      ).to.be.rejectedWith(/must not be the organization parent workspace/);
    });

    // Does NOT persist anything and does NOT poll — that is the whole point of the extraction
    // (the worker polls the returned candidate itself, across possibly-many invocations).
    it('does not call getWorkspaceStatus (no settle poll) or touch the brand (no persist)', async () => {
      const transport = makeTransport();
      const claim = { brandCollection: makeBrandCollection() };

      await createOrAdoptSubworkspaceCandidate(transport, PARENT_WS, EXPECTED_TITLE, log, claim);

      expect(transport.getWorkspaceStatus).to.not.have.been.called;
    });
  });

  describe('subworkspaceTitle', () => {
    it('returns the brand name', () => {
      expect(subworkspaceTitle(makeBrand({ name: 'Adobe Express' }))).to.equal('Adobe Express');
    });

    it('hard-fails when the brand has no name', () => {
      expect(() => subworkspaceTitle(makeBrand({ name: '' })))
        .to.throw(/requires a brand name/);
    });
  });
});
