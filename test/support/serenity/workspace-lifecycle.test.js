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
  ensureChildWorkspace,
  decommissionBrandWorkspace,
  resourceAllocation,
  RELEASE_ALLOCATION,
} from '../../../src/support/serenity/workspace-lifecycle.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';
import { clearBrandWorkspaceCache } from '../../../src/support/serenity/workspace-resolver.js';

use(chaiAsPromised);
use(sinonChai);

const PARENT_WS = 'bb0f4e1c-8bb1-402e-88f2-f68618ea7397';
const CHILD_WS = 'child-ws-1';
const NOOP_TIMING = { intervalMs: 0, sleep: () => Promise.resolve() };
const log = { info: () => {}, error: () => {}, warn: () => {} };

function makeTransport(overrides = {}) {
  return {
    createChildWorkspace: sinon.stub().resolves({ id: CHILD_WS, status: 'not ready' }),
    getWorkspaceStatus: sinon.stub().resolves({ status: 'created' }),
    listWorkspaceFamily: sinon.stub().resolves({ items: [] }),
    transferWorkspaceResources: sinon.stub().resolves(null),
    listProjects: sinon.stub().resolves({ items: [] }),
    deleteProject: sinon.stub().resolves(null),
    ...overrides,
  };
}

function makeBrand({ workspaceId = null, name = 'Adobe Express' } = {}) {
  let ws = workspaceId;
  return {
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

  describe('ensureChildWorkspace', () => {
    it('re-grants an allocation when the brand already has a (kept) workspace', async () => {
      const transport = makeTransport();
      const brand = makeBrand({ workspaceId: CHILD_WS });

      const result = await ensureChildWorkspace(transport, brand, PARENT_WS, 2, log, NOOP_TIMING);

      expect(result).to.equal(CHILD_WS);
      expect(transport.transferWorkspaceResources)
        .to.have.been.calledOnceWithExactly(CHILD_WS, resourceAllocation(2));
      expect(transport.createChildWorkspace).to.not.have.been.called;
      expect(brand.save).to.not.have.been.called;
    });

    it('creates, polls until created, then persists the column', async () => {
      const transport = makeTransport();
      transport.getWorkspaceStatus
        .onFirstCall().resolves({ status: 'not ready' })
        .onSecondCall().resolves({ status: 'created' });
      const brand = makeBrand();

      const result = await ensureChildWorkspace(transport, brand, PARENT_WS, 2, log, NOOP_TIMING);

      expect(result).to.equal(CHILD_WS);
      expect(transport.createChildWorkspace)
        .to.have.been.calledOnceWithExactly(PARENT_WS, 'Adobe Express', resourceAllocation(2));
      expect(transport.getWorkspaceStatus).to.have.been.calledTwice;
      expect(brand.setSemrushWorkspaceId).to.have.been.calledOnceWithExactly(CHILD_WS);
      expect(brand.save).to.have.been.calledOnce;
    });

    it('adopts a unique family match after a create timeout (504)', async () => {
      const transport = makeTransport({
        createChildWorkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
        listWorkspaceFamily: sinon.stub().resolves({
          items: [{ id: 'adopted-ws', title: 'Adobe Express' }],
        }),
      });
      const brand = makeBrand();

      const result = await ensureChildWorkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING);

      expect(result).to.equal('adopted-ws');
      expect(brand.setSemrushWorkspaceId).to.have.been.calledWith('adopted-ws');
    });

    it('fails with an ambiguousWorkspace alert on multiple family matches', async () => {
      const transport = makeTransport({
        createChildWorkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
        listWorkspaceFamily: sinon.stub().resolves({
          items: [
            { id: 'ws-a', title: 'Adobe Express' },
            { id: 'ws-b', title: 'Adobe Express' },
          ],
        }),
      });
      const brand = makeBrand();

      const promise = ensureChildWorkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING);
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
        createChildWorkspace: sinon.stub().rejects(new SerenityTransportError(504, 'timeout')),
        listWorkspaceFamily: sinon.stub().resolves({ items: [] }),
      });
      const brand = makeBrand();

      await expect(ensureChildWorkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
        .to.be.rejectedWith(/no family match to adopt/);
    });

    it('re-throws a non-timeout create error', async () => {
      const transport = makeTransport({
        createChildWorkspace: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });
      const brand = makeBrand();

      await expect(ensureChildWorkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
        .to.be.rejectedWith(SerenityTransportError);
    });

    it('404s when there is no parent workspace to create under', async () => {
      const transport = makeTransport();
      const brand = makeBrand();

      await expect(ensureChildWorkspace(transport, brand, '', 1, log, NOOP_TIMING))
        .to.be.rejectedWith(/has no parent workspace/);
    });

    it('502s when create returns no id', async () => {
      const transport = makeTransport({
        createChildWorkspace: sinon.stub().resolves({ id: '' }),
      });
      const brand = makeBrand();

      await expect(ensureChildWorkspace(transport, brand, PARENT_WS, 1, log, NOOP_TIMING))
        .to.be.rejectedWith(/returned no workspace id/);
    });

    it('504s when the workspace never settles to created', async () => {
      const transport = makeTransport({
        getWorkspaceStatus: sinon.stub().resolves({ status: 'not ready' }),
      });
      const brand = makeBrand();

      await expect(ensureChildWorkspace(transport, brand, PARENT_WS, 1, log, { attempts: 2, intervalMs: 0, sleep: () => Promise.resolve() })).to.be.rejectedWith(/did not settle to 'created'/);
    });
  });

  describe('decommissionBrandWorkspace', () => {
    it('deletes every listed project then releases the allocation', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }, { id: 'p2' }] }),
      });

      await decommissionBrandWorkspace(transport, CHILD_WS, log);

      expect(transport.deleteProject).to.have.been.calledWith(CHILD_WS, 'p1');
      expect(transport.deleteProject).to.have.been.calledWith(CHILD_WS, 'p2');
      expect(transport.transferWorkspaceResources)
        .to.have.been.calledOnceWithExactly(CHILD_WS, RELEASE_ALLOCATION);
    });

    it('treats an upstream 404 on delete as success (convergent)', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'gone' }] }),
        deleteProject: sinon.stub().rejects(new SerenityTransportError(404, 'not found')),
      });

      await decommissionBrandWorkspace(transport, CHILD_WS, log);

      expect(transport.transferWorkspaceResources).to.have.been.calledOnce;
    });

    it('propagates a non-404 delete failure', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: 'p1' }] }),
        deleteProject: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });

      await expect(decommissionBrandWorkspace(transport, CHILD_WS, log))
        .to.be.rejectedWith(SerenityTransportError);
      expect(transport.transferWorkspaceResources).to.not.have.been.called;
    });

    it('skips listing items without an id', async () => {
      const transport = makeTransport({
        listProjects: sinon.stub().resolves({ items: [{ id: '' }, {}, { id: 'p1' }] }),
      });

      await decommissionBrandWorkspace(transport, CHILD_WS, log);

      expect(transport.deleteProject).to.have.been.calledOnceWithExactly(CHILD_WS, 'p1');
    });

    it('is a no-op for a blank workspace id', async () => {
      const transport = makeTransport();

      await decommissionBrandWorkspace(transport, '', log);

      expect(transport.listProjects).to.not.have.been.called;
      expect(transport.transferWorkspaceResources).to.not.have.been.called;
    });
  });
});
