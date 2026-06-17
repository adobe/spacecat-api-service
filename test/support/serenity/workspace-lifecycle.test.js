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
  ensureSubworkspace,
  decommissionBrandWorkspace,
  resourceAllocation,
  RELEASE_ALLOCATION,
  CREATE_ALLOCATION,
} from '../../../src/support/serenity/workspace-lifecycle.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';
import { clearBrandWorkspaceCache } from '../../../src/support/serenity/workspace-resolver.js';

use(chaiAsPromised);
use(sinonChai);

const PARENT_WS = 'bb0f4e1c-8bb1-402e-88f2-f68618ea7397';
const SUB_WS = 'subworkspace-ws-1';
const BRAND_ID = 'e48e9db4-3101-4237-8075-a9132333e8c2';
// The sub-workspace title embeds the first 8 chars of the immutable brand id for
// per-brand uniqueness (so ambiguous-create recovery cannot adopt a same-named
// brand's workspace) while keeping the Semrush UI title short.
const EXPECTED_TITLE = `Adobe Express [${BRAND_ID.slice(0, 8)}]`;
const NOOP_TIMING = { intervalMs: 0, sleep: () => Promise.resolve() };
const log = { info: () => {}, error: () => {}, warn: () => {} };

function makeTransport(overrides = {}) {
  return {
    createSubworkspace: sinon.stub().resolves({ id: SUB_WS, status: 'not ready' }),
    getWorkspaceStatus: sinon.stub().resolves({ status: 'created' }),
    listWorkspaceFamily: sinon.stub().resolves({ items: [] }),
    transferWorkspaceResources: sinon.stub().resolves(null),
    listProjects: sinon.stub().resolves({ items: [] }),
    deleteProject: sinon.stub().resolves(null),
    ...overrides,
  };
}

function makeBrand({ workspaceId = null, name = 'Adobe Express', id = BRAND_ID } = {}) {
  let ws = workspaceId;
  return {
    getId: () => id,
    getSemrushWorkspaceId: () => ws,
    getName: () => name,
    setSemrushWorkspaceId: sinon.spy((v) => { ws = v; }),
    save: sinon.stub().resolves(),
  };
}

describe('workspace-lifecycle', () => {
  afterEach(() => {
    sinon.restore();
    clearBrandWorkspaceCache();
  });

  describe('resourceAllocation', () => {
    it('sizes projects = markets + 2 and prompts = 500 * projects', () => {
      expect(resourceAllocation(3)).to.deep.equal({ ai: { projects: 5, prompts: 2500 } });
    });
    it('floors a non-positive market count to one slot of headroom', () => {
      expect(resourceAllocation(0)).to.deep.equal({ ai: { projects: 3, prompts: 1500 } });
      expect(resourceAllocation(undefined)).to.deep.equal({ ai: { projects: 3, prompts: 1500 } });
    });
  });

  describe('ensureSubworkspace', () => {
    it('re-grants an allocation when the brand already has a (kept) workspace', async () => {
      const transport = makeTransport();
      const brand = makeBrand({ workspaceId: SUB_WS });

      const result = await ensureSubworkspace(transport, brand, PARENT_WS, 2, log, NOOP_TIMING);

      expect(result).to.equal(SUB_WS);
      expect(transport.transferWorkspaceResources)
        .to.have.been.calledOnceWithExactly(SUB_WS, resourceAllocation(2));
      expect(transport.createSubworkspace).to.not.have.been.called;
      expect(brand.save).to.not.have.been.called;
    });

    it('creates, polls until created, then persists the column', async () => {
      const transport = makeTransport();
      transport.getWorkspaceStatus
        .onFirstCall().resolves({ status: 'not ready' })
        .onSecondCall().resolves({ status: 'created' });
      const brand = makeBrand();

      const result = await ensureSubworkspace(transport, brand, PARENT_WS, 2, log, NOOP_TIMING);

      expect(result).to.equal(SUB_WS);
      // Create carves the fixed CREATE_ALLOCATION (1 project, 500 prompts) so the
      // child has metered quota; marketCount does not size the create.
      expect(transport.createSubworkspace)
        .to.have.been.calledOnceWithExactly(PARENT_WS, EXPECTED_TITLE, CREATE_ALLOCATION);
      expect(transport.getWorkspaceStatus).to.have.been.calledTwice;
      expect(brand.setSemrushWorkspaceId).to.have.been.calledOnceWithExactly(SUB_WS);
      expect(brand.save).to.have.been.calledOnce;
    });

    it('adopts a unique family match after a create timeout (504)', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
        listWorkspaceFamily: sinon.stub().resolves({
          items: [{ id: 'adopted-ws', title: EXPECTED_TITLE }],
        }),
      });
      const brand = makeBrand();

      const result = await ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING);

      expect(result).to.equal('adopted-ws');
      expect(brand.setSemrushWorkspaceId).to.have.been.calledWith('adopted-ws');
    });

    it('refuses to adopt a NON-empty family match after a create timeout', async () => {
      // A timed-out create has no projects yet; a non-empty title match is some
      // OTHER provisioned workspace, never our interrupted create. Refuse it.
      const transport = makeTransport({
        createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
        listWorkspaceFamily: sinon.stub().resolves({
          items: [{ id: 'occupied-ws', title: EXPECTED_TITLE }],
        }),
        listProjects: sinon.stub().resolves({ items: [{ id: 'existing-project' }] }),
      });
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
        .to.be.rejectedWith(/refusing to adopt/);
      expect(brand.setSemrushWorkspaceId).to.not.have.been.called;
    });

    it('throws when the sole family match has no id', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
        listWorkspaceFamily: sinon.stub().resolves({
          items: [{ title: EXPECTED_TITLE }],
        }),
      });
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
        .to.be.rejectedWith(/sole family match has no id/);
      expect(transport.listProjects).to.not.have.been.called;
    });

    it('hard-fails (never builds a non-unique title) when the brand has no id', async () => {
      // The id-suffix is the collision-free adoption key; without it the title
      // would not be unique per brand, so provisioning must refuse rather than
      // fall back to a name-only title that adoption could later mis-match.
      const transport = makeTransport();
      const brand = makeBrand({ id: null });

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
        .to.be.rejectedWith(/requires a brand id/);
      expect(transport.createSubworkspace).to.not.have.been.called;
    });

    it('fails with an ambiguousWorkspace alert on multiple family matches', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
        listWorkspaceFamily: sinon.stub().resolves({
          items: [
            { id: 'ws-a', title: EXPECTED_TITLE },
            { id: 'ws-b', title: EXPECTED_TITLE },
          ],
        }),
      });
      const brand = makeBrand();

      const promise = ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING);
      await expect(promise).to.be.rejected;
      try {
        await promise;
      } catch (e) {
        expect(e.code).to.equal('ambiguousWorkspace');
        expect(e.status).to.equal(409);
      }
      expect(brand.save).to.not.have.been.called;
    });

    it('throws when an ambiguous create has no family match to adopt', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
        listWorkspaceFamily: sinon.stub().resolves({ items: [] }),
      });
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
        .to.be.rejectedWith(/no family match to adopt/);
    });

    it('re-throws a non-timeout create error', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
        .to.be.rejectedWith(SerenityTransportError);
    });

    it('404s when there is no parent workspace to create under', async () => {
      const transport = makeTransport();
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, '', 1, log, NOOP_TIMING))
        .to.be.rejectedWith(/has no parent workspace/);
    });

    it('502s when create returns no id', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().resolves({ id: '' }),
      });
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
        .to.be.rejectedWith(/returned no workspace id/);
    });

    it('504s when the workspace never settles to created', async () => {
      const transport = makeTransport({
        getWorkspaceStatus: sinon.stub().resolves({ status: 'not ready' }),
      });
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, 1, log, { attempts: 2, intervalMs: 0, sleep: () => Promise.resolve() })).to.be.rejectedWith(/did not settle to 'created'/);
    });

    it('uses the real timer when no sleep is injected (bounded poll)', async () => {
      const transport = makeTransport({
        getWorkspaceStatus: sinon.stub().resolves({ status: 'not ready' }),
      });
      const brand = makeBrand({ workspaceId: SUB_WS });

      // attempts:1, intervalMs:0, sleep NOT injected -> exercises the default
      // setTimeout-based sleep once before the bounded poll gives up.
      const timing = { attempts: 1, intervalMs: 0 };
      await expect(ensureSubworkspace(transport, brand, PARENT_WS, 1, log, timing))
        .to.be.rejectedWith(/did not settle to 'created'/);
    });

    it('refuses to re-grant onto a workspace that IS the org parent', async () => {
      const transport = makeTransport();
      const brand = makeBrand({ workspaceId: PARENT_WS });

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
        .to.be.rejectedWith(/must not be the organization parent workspace/);
      expect(transport.transferWorkspaceResources).to.not.have.been.called;
    });

    it('refuses to persist a created workspace that IS the org parent', async () => {
      const transport = makeTransport({
        createSubworkspace: sinon.stub().resolves({ id: PARENT_WS, status: 'not ready' }),
      });
      const brand = makeBrand();

      await expect(ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
        .to.be.rejectedWith(/must not be the organization parent workspace/);
      expect(brand.save).to.not.have.been.called;
    });

    it('releases our new workspace and adopts the winner when a concurrent activation won', async () => {
      // reloadPointer reports a DIFFERENT id was persisted while we created ours.
      const transport = makeTransport();
      const brand = makeBrand();
      const reloadPointer = sinon.stub().resolves('winner-ws');

      const result = await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        1,
        log,
        NOOP_TIMING,
        reloadPointer,
      );

      expect(result).to.equal('winner-ws');
      // Our orphan's allocation is released back to the parent pool.
      expect(transport.transferWorkspaceResources)
        .to.have.been.calledOnceWithExactly(SUB_WS, RELEASE_ALLOCATION);
      // The winner's pointer is NOT clobbered.
      expect(brand.setSemrushWorkspaceId).to.not.have.been.called;
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
        1,
        log,
        NOOP_TIMING,
        reloadPointer,
      );

      expect(result).to.equal(SUB_WS);
      expect(brand.setSemrushWorkspaceId).to.have.been.calledOnceWithExactly(SUB_WS);
      expect(brand.save).to.have.been.calledOnce;
    });

    it('tolerates a failed release when adopting a concurrent winner', async () => {
      const transport = makeTransport({
        transferWorkspaceResources: sinon.stub().rejects(new Error('release boom')),
      });
      const brand = makeBrand();
      const reloadPointer = sinon.stub().resolves('winner-ws');

      const result = await ensureSubworkspace(
        transport,
        brand,
        PARENT_WS,
        1,
        log,
        NOOP_TIMING,
        reloadPointer,
      );

      expect(result).to.equal('winner-ws');
      expect(brand.setSemrushWorkspaceId).to.not.have.been.called;
    });
  });

  describe('decommissionBrandWorkspace', () => {
    it('deletes every listed project then releases the allocation', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }, { id: 'p2' }] }),
      });

      await decommissionBrandWorkspace(transport, SUB_WS, log);

      expect(transport.deleteProject).to.have.been.calledWith(SUB_WS, 'p1');
      expect(transport.deleteProject).to.have.been.calledWith(SUB_WS, 'p2');
      expect(transport.transferWorkspaceResources)
        .to.have.been.calledOnceWithExactly(SUB_WS, RELEASE_ALLOCATION);
    });

    it('treats an upstream 404 on delete as success (convergent)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'gone' }] }),
        deleteProject: sinon.stub().rejects(new SerenityTransportError(404, 'not found')),
      });

      await decommissionBrandWorkspace(transport, SUB_WS, log);

      expect(transport.transferWorkspaceResources).to.have.been.calledOnce;
    });

    it('propagates a non-404 delete failure', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
        deleteProject: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });

      await expect(decommissionBrandWorkspace(transport, SUB_WS, log))
        .to.be.rejectedWith(SerenityTransportError);
      expect(transport.transferWorkspaceResources).to.not.have.been.called;
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
      expect(transport.transferWorkspaceResources).to.not.have.been.called;
    });

    it('refuses to decommission the org parent workspace (self-defending)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
      });

      await expect(decommissionBrandWorkspace(transport, PARENT_WS, log, PARENT_WS))
        .to.be.rejectedWith(/must not be the organization parent workspace/);
      expect(transport.deleteProject).to.not.have.been.called;
      expect(transport.transferWorkspaceResources).to.not.have.been.called;
    });

    it('refuses to decommission a workspace with active linked sub-workspaces (guard enabled)', async () => {
      const transport = makeTransport({
        // family includes a no-id entry and the target itself (both ignored)
        // plus one real child that must block the decommission.
        listWorkspaceFamily: sinon.stub().resolves({
          items: [{ id: SUB_WS }, {}, { id: 'child-1' }],
        }),
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
      expect(transport.transferWorkspaceResources).to.not.have.been.called;
    });

    it('ignores the target own id in the family listing and proceeds (guard enabled)', async () => {
      const transport = makeTransport({
        listWorkspaceFamily: sinon.stub().resolves({ items: [{ id: SUB_WS }] }),
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
      expect(transport.transferWorkspaceResources).to.have.been.calledOnce;
    });

    it('SKIPS the linked-sub-workspace guard by default (flag off, family not queried)', async () => {
      // Default (no options): the unverified family-direction guard is OFF, so a
      // family listing that WOULD report a child does not block, and the family
      // endpoint is never called. Parent-equality guard remains always-on.
      const transport = makeTransport({
        listWorkspaceFamily: sinon.stub().resolves({ items: [{ id: 'child-1' }] }),
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
      });

      await decommissionBrandWorkspace(transport, SUB_WS, log, PARENT_WS);

      expect(transport.listWorkspaceFamily).to.not.have.been.called;
      expect(transport.deleteProject).to.have.been.calledOnceWithExactly(SUB_WS, 'p1');
      expect(transport.transferWorkspaceResources).to.have.been.calledOnce;
    });
  });
  describe('defensive branch coverage', () => {
    describe('ensureSubworkspace - subworkspaceTitle else branch (brand with id but no name)', () => {
      it('creates a workspace titled brand-<suffix> when the brand has no name', async () => {
        // subworkspaceTitle: hasText(name) is false -> uses the brand-<suffix> template (line 94).
        const transport = makeTransport();
        const brand = makeBrand({ name: null });

        const result = await ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING);

        expect(result).to.equal(SUB_WS);
        const [, actualTitle] = transport.createSubworkspace.firstCall.args;
        expect(actualTitle).to.equal(`brand-${BRAND_ID.slice(0, 8)}`);
      });

      it('creates a workspace titled brand-<suffix> when the brand name is empty string', async () => {
        const transport = makeTransport();
        const brand = makeBrand({ name: '' });

        const result = await ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING);

        expect(result).to.equal(SUB_WS);
        const [, actualTitle] = transport.createSubworkspace.firstCall.args;
        expect(actualTitle).to.equal(`brand-${BRAND_ID.slice(0, 8)}`);
      });
    });

    describe('adoptFromFamily - listWorkspaceFamily resolves non-array', () => {
      it('throws when listWorkspaceFamily returns {} (items not array)', async () => {
        // Line 121: Array.isArray false branch in adoptFromFamily.
        const transport = makeTransport({
          createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
          listWorkspaceFamily: sinon.stub().resolves({}),
        });
        const brand = makeBrand();

        await expect(ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
          .to.be.rejectedWith(/no family match to adopt/);
      });
    });

    describe('adoptFromFamily adopt path - listProjects resolves non-array', () => {
      it('adopts the empty match when listProjects returns {} (projectCount = 0)', async () => {
        // Line 156: Array.isArray false branch -> projectCount = 0 -> adopts.
        const transport = makeTransport({
          createSubworkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
          listWorkspaceFamily: sinon.stub().resolves({
            items: [{ id: 'adopted-ws', title: EXPECTED_TITLE }],
          }),
          listProjects: sinon.stub().resolves({}),
        });
        const brand = makeBrand();

        const result = await ensureSubworkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING);

        expect(result).to.equal('adopted-ws');
        expect(brand.setSemrushWorkspaceId).to.have.been.calledWith('adopted-ws');
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
        expect(transport.transferWorkspaceResources).to.have.been.calledOnce;
      });
    });

    describe('decommissionBrandWorkspace - listProjects resolves non-array', () => {
      it('treats {} listing as no projects and releases allocation without deleting', async () => {
        // Line 390: Array.isArray false branch -> projects = [] -> no deletes.
        const transport = makeTransport({
          listProjects: sinon.stub().resolves({}),
        });

        await decommissionBrandWorkspace(transport, SUB_WS, log);

        expect(transport.deleteProject).to.not.have.been.called;
        expect(transport.transferWorkspaceResources)
          .to.have.been.calledOnceWithExactly(SUB_WS, RELEASE_ALLOCATION);
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
          1,
          log,
          { attempts: 1, sleep: () => Promise.resolve() },
        );

        expect(result).to.equal(SUB_WS);
      });
    });
  });
});
