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

/* eslint-disable max-len -- Semrush prompts handler tests */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  encodeLogicalId,
  decodeLogicalId,
  handleListPrompts,
  handleCreatePrompts,
  handleUpdatePrompt,
  handleBulkDeletePrompts,
} from '../../../../src/support/semrush/handlers/prompts.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKSPACE = 'workspace-1';

function makeProject({
  semrushProjectId, semrushLocationId, language,
}) {
  return {
    getSemrushProjectId: () => semrushProjectId,
    getSemrushLocationId: () => semrushLocationId,
    getLanguage: () => language,
  };
}

function makeDataAccess(projects) {
  return {
    BrandSemrushProject: {
      allByBrandId: sinon.stub().resolves(projects),
      findBySlice: sinon.stub(),
    },
  };
}

function fakeLog() {
  return {
    warn: sinon.stub(),
    error: sinon.stub(),
  };
}

describe('semrush prompts handler', () => {
  const sandbox = sinon.createSandbox();

  afterEach(() => {
    sandbox.restore();
  });

  describe('logical id codec', () => {
    it('round-trips brand / location / language / text', () => {
      const id = encodeLogicalId({
        brandId: BRAND, semrushLocationId: 2840, language: 'en', text: 'Hello',
      });
      const decoded = decodeLogicalId(id);
      expect(decoded).to.deep.equal({
        brandId: BRAND, semrushLocationId: 2840, language: 'en', text: 'Hello',
      });
    });

    it('returns null on malformed input', () => {
      expect(decodeLogicalId('not-base64url')).to.equal(null);
    });

    it('coerces missing fields to safe defaults at encode time', () => {
      const id = encodeLogicalId({});
      const decoded = decodeLogicalId(id);
      expect(decoded.brandId).to.equal('');
      expect(decoded.semrushLocationId).to.equal(0);
    });
  });

  describe('handleListPrompts', () => {
    it('returns empty result when brand has no mapped projects', async () => {
      const transport = { listPromptsByTags: sinon.stub() };
      const result = await handleListPrompts(transport, makeDataAccess([]), BRAND, WORKSPACE, {});
      expect(result.items).to.deep.equal([]);
      expect(result.total).to.equal(0);
      expect(transport.listPromptsByTags).to.not.have.been.called;
    });

    it('fans out across mapped projects, merges, paginates', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p1', semrushLocationId: 2840, language: 'en' }),
        makeProject({ semrushProjectId: 'p2', semrushLocationId: 2276, language: 'de' }),
      ];
      const transport = {
        listPromptsByTags: sinon.stub(),
      };
      transport.listPromptsByTags.withArgs(WORKSPACE, 'p1').resolves({
        items: [{ id: 's1', name: 'prompt one', tags: [{ name: 'topic-a' }] }],
        total: 1,
      });
      transport.listPromptsByTags.withArgs(WORKSPACE, 'p2').resolves({
        items: [{ id: 's2', name: 'prompt two', tags: ['topic-b'] }],
        total: 1,
      });
      const result = await handleListPrompts(
        transport,
        makeDataAccess(projects),
        BRAND,
        WORKSPACE,
        { page: 1, limit: 10 },
      );
      expect(result.total).to.equal(2);
      expect(result.items.map((p) => p.text).sort()).to.deep.equal(['prompt one', 'prompt two']);
      expect(result.items[0]).to.have.property('id');
      expect(result.items.find((p) => p.semrushId === 's1').tags).to.deep.equal(['topic-a']);
    });

    it('filters projects by semrushLocationId query', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p-us', semrushLocationId: 2840, language: 'en' }),
        makeProject({ semrushProjectId: 'p-de', semrushLocationId: 2276, language: 'de' }),
      ];
      const transport = {
        listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
      };
      await handleListPrompts(
        transport,
        makeDataAccess(projects),
        BRAND,
        WORKSPACE,
        { semrushLocationId: 2840 },
      );
      const projectIds = transport.listPromptsByTags.getCalls().map((c) => c.args[1]);
      expect(projectIds).to.deep.equal(['p-us']);
    });

    it('filters projects by language query (drops non-matching slice)', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p-en', semrushLocationId: 2840, language: 'en' }),
        makeProject({ semrushProjectId: 'p-de', semrushLocationId: 2840, language: 'de' }),
      ];
      const transport = {
        listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
      };
      await handleListPrompts(
        transport,
        makeDataAccess(projects),
        BRAND,
        WORKSPACE,
        { language: 'EN' },
      );
      const projectIds = transport.listPromptsByTags.getCalls().map((c) => c.args[1]);
      expect(projectIds).to.deep.equal(['p-en']);
    });

    it('drops prompt items with empty text (buildPromptDto returns null)', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p1', semrushLocationId: 2840, language: 'en' }),
      ];
      const transport = {
        listPromptsByTags: sinon.stub().resolves({
          items: [
            { id: 's1', name: 'kept', tags: [] },
            { id: 's2', name: '' }, // empty text → dropped
            { id: 's3', name: undefined }, // missing text → dropped
          ],
          total: 3,
        }),
      };
      const result = await handleListPrompts(transport, makeDataAccess(projects), BRAND, WORKSPACE, {});
      expect(result.items).to.have.length(1);
      expect(result.items[0].text).to.equal('kept');
    });

    it('reports per-project upstream errors without failing the request', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p1', semrushLocationId: 2840, language: 'en' }),
      ];
      const transport = {
        listPromptsByTags: sinon.stub().rejects(new Error('boom')),
      };
      const result = await handleListPrompts(transport, makeDataAccess(projects), BRAND, WORKSPACE, {});
      expect(result.items).to.deep.equal([]);
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('boom');
    });

    it('clamps limit to 1000 and page to >= 1', async () => {
      const transport = {
        listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
      };
      const result = await handleListPrompts(
        transport,
        makeDataAccess([makeProject({
          semrushProjectId: 'p1', semrushLocationId: 2840, language: 'en',
        })]),
        BRAND,
        WORKSPACE,
        { page: 0, limit: 999999 },
      );
      expect(result.page).to.equal(1);
      expect(result.limit).to.equal(1000);
    });
  });

  describe('handleCreatePrompts', () => {
    it('returns empty result when body has no prompts', async () => {
      const transport = { createTaggedPrompts: sinon.stub(), publishProject: sinon.stub() };
      const result = await handleCreatePrompts(transport, makeDataAccess([]), BRAND, WORKSPACE, {}, fakeLog());
      expect(result).to.deep.equal({ created: [], skipped: [], failed: [] });
    });

    it('creates prompts and publishes affected projects once', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p-us', semrushLocationId: 2840, language: 'en' }),
      ];
      const transport = {
        createTaggedPrompts: sinon.stub().resolves({ ids: ['s-new-1'] }),
        publishProject: sinon.stub().resolves({}),
      };
      const result = await handleCreatePrompts(
        transport,
        makeDataAccess(projects),
        BRAND,
        WORKSPACE,
        {
          prompts: [
            {
              text: 'hi', semrushLocationId: 2840, language: 'en', tags: ['t1'],
            },
            { text: 'bye', semrushLocationId: 2840, language: 'en' },
          ],
        },
        fakeLog(),
      );
      expect(result.created).to.have.length(2);
      expect(result.failed).to.deep.equal([]);
      expect(result.skipped).to.deep.equal([]);
      expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'p-us');
    });

    it('skips inputs with no matching project slice', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p-us', semrushLocationId: 2840, language: 'en' }),
      ];
      const transport = {
        createTaggedPrompts: sinon.stub().resolves({ ids: ['s1'] }),
        publishProject: sinon.stub().resolves({}),
      };
      const result = await handleCreatePrompts(
        transport,
        makeDataAccess(projects),
        BRAND,
        WORKSPACE,
        { prompts: [{ text: 'x', semrushLocationId: 99999, language: 'fr' }] },
        fakeLog(),
      );
      expect(result.created).to.deep.equal([]);
      expect(result.skipped).to.have.length(1);
      expect(result.skipped[0].reason).to.match(/No BrandSemrushProject/);
    });

    it('skips malformed inputs without matching them to projects', async () => {
      const transport = {
        createTaggedPrompts: sinon.stub(),
        publishProject: sinon.stub(),
      };
      const result = await handleCreatePrompts(
        transport,
        makeDataAccess([]),
        BRAND,
        WORKSPACE,
        { prompts: [{ text: '', language: 'en', semrushLocationId: 2840 }] },
        fakeLog(),
      );
      expect(result.skipped[0].reason).to.match(/text, language, and semrushLocationId/);
      expect(transport.createTaggedPrompts).to.not.have.been.called;
    });

    it('records failed entries when upstream rejects', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p1', semrushLocationId: 2840, language: 'en' }),
      ];
      const err = Object.assign(new Error('upstream'), { status: 502 });
      const transport = {
        createTaggedPrompts: sinon.stub().rejects(err),
        publishProject: sinon.stub().resolves({}),
      };
      const result = await handleCreatePrompts(
        transport,
        makeDataAccess(projects),
        BRAND,
        WORKSPACE,
        { prompts: [{ text: 't', semrushLocationId: 2840, language: 'en' }] },
        fakeLog(),
      );
      expect(result.failed).to.have.length(1);
      expect(result.failed[0]).to.deep.include({
        text: 't', semrushProjectId: 'p1', status: 502, message: 'upstream',
      });
      expect(transport.publishProject).to.not.have.been.called;
    });

    it('reports publish errors as failed entries', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p1', semrushLocationId: 2840, language: 'en' }),
      ];
      const transport = {
        createTaggedPrompts: sinon.stub().resolves({ ids: ['s1'] }),
        publishProject: sinon.stub().rejects(new Error('publish-down')),
      };
      const result = await handleCreatePrompts(
        transport,
        makeDataAccess(projects),
        BRAND,
        WORKSPACE,
        { prompts: [{ text: 't', semrushLocationId: 2840, language: 'en' }] },
        fakeLog(),
      );
      expect(result.created).to.have.length(1);
      expect(result.failed[0].message).to.equal('publish: publish-down');
    });
  });

  describe('handleUpdatePrompt', () => {
    function aProject() {
      return makeProject({
        semrushProjectId: 'p1', semrushLocationId: 2840, language: 'en',
      });
    }

    it('400s on a logical id that does not match the brand', async () => {
      const result = await handleUpdatePrompt(
        {},
        makeDataAccess([]),
        'different-brand',
        WORKSPACE,
        encodeLogicalId({
          brandId: BRAND, semrushLocationId: 2840, language: 'en', text: 'x',
        }),
        { text: 'y' },
        fakeLog(),
      );
      expect(result.status).to.equal(400);
      expect(result.body.error).to.equal('invalidLogicalId');
    });

    it('400s when body has no text or tags', async () => {
      const id = encodeLogicalId({
        brandId: BRAND, semrushLocationId: 2840, language: 'en', text: 'x',
      });
      const result = await handleUpdatePrompt({}, makeDataAccess([]), BRAND, WORKSPACE, id, {}, fakeLog());
      expect(result.status).to.equal(400);
      expect(result.body.error).to.equal('missingFields');
    });

    it('404s when the slice has no mapped project', async () => {
      const dataAccess = makeDataAccess([]);
      dataAccess.BrandSemrushProject.findBySlice.resolves(null);
      const id = encodeLogicalId({
        brandId: BRAND, semrushLocationId: 2840, language: 'en', text: 'x',
      });
      const result = await handleUpdatePrompt({}, dataAccess, BRAND, WORKSPACE, id, { text: 'y' }, fakeLog());
      expect(result.status).to.equal(404);
      expect(result.body.error).to.equal('projectNotFound');
    });

    it('looks up the old prompt by text, deletes, creates, publishes', async () => {
      const project = aProject();
      const dataAccess = makeDataAccess([]);
      dataAccess.BrandSemrushProject.findBySlice.resolves(project);
      const transport = {
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 'old-1', name: 'old text' }], total: 1,
        }),
        deletePromptsByIds: sinon.stub().resolves({}),
        createTaggedPrompts: sinon.stub().resolves({ ids: ['new-1'] }),
        publishProject: sinon.stub().resolves({}),
      };
      const id = encodeLogicalId({
        brandId: BRAND, semrushLocationId: 2840, language: 'en', text: 'old text',
      });
      const result = await handleUpdatePrompt(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        id,
        { text: 'new text', tags: ['t1'] },
        fakeLog(),
      );
      expect(result.status).to.equal(200);
      expect(transport.deletePromptsByIds).to.have.been.calledOnceWithExactly(WORKSPACE, 'p1', ['old-1']);
      expect(transport.createTaggedPrompts).to.have.been.calledOnce;
      expect(transport.publishProject).to.have.been.calledOnceWithExactly(WORKSPACE, 'p1');
      expect(result.body.text).to.equal('new text');
      expect(result.body.semrushId).to.equal('new-1');
    });

    it('skips delete cleanly when the old prompt cannot be found upstream', async () => {
      const project = aProject();
      const dataAccess = makeDataAccess([]);
      dataAccess.BrandSemrushProject.findBySlice.resolves(project);
      const transport = {
        listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
        deletePromptsByIds: sinon.stub(),
        createTaggedPrompts: sinon.stub().resolves({ ids: ['new-1'] }),
        publishProject: sinon.stub().resolves({}),
      };
      const id = encodeLogicalId({
        brandId: BRAND, semrushLocationId: 2840, language: 'en', text: 'old',
      });
      const result = await handleUpdatePrompt(transport, dataAccess, BRAND, WORKSPACE, id, { text: 'new' }, fakeLog());
      expect(result.status).to.equal(200);
      expect(transport.deletePromptsByIds).to.not.have.been.called;
    });

    it('does not throw when the delete call rejects (warn-only)', async () => {
      const project = aProject();
      const dataAccess = makeDataAccess([]);
      dataAccess.BrandSemrushProject.findBySlice.resolves(project);
      const log = fakeLog();
      const transport = {
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 'old-1', name: 'old' }], total: 1,
        }),
        deletePromptsByIds: sinon.stub().rejects(new Error('delete-fail')),
        createTaggedPrompts: sinon.stub().resolves({ ids: ['new-1'] }),
        publishProject: sinon.stub().resolves({}),
      };
      const id = encodeLogicalId({
        brandId: BRAND, semrushLocationId: 2840, language: 'en', text: 'old',
      });
      const result = await handleUpdatePrompt(transport, dataAccess, BRAND, WORKSPACE, id, { text: 'new' }, log);
      expect(result.status).to.equal(200);
      expect(log.warn).to.have.been.called;
    });
  });

  describe('handleBulkDeletePrompts', () => {
    it('throws ErrorWithStatusCode(400) when targets list is empty', async () => {
      const transport = { deletePromptsByIds: sinon.stub(), publishProject: sinon.stub() };
      let caught;
      try {
        await handleBulkDeletePrompts(transport, makeDataAccess([]), BRAND, WORKSPACE, {}, fakeLog());
      } catch (e) {
        caught = e;
      }
      expect(caught).to.exist;
      expect(caught.status).to.equal(400);
      expect(caught.message).to.match(/non-empty semrushIds/);
    });

    it('treats upstream 404 on delete as idempotent success', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p1', semrushLocationId: 2840, language: 'en' }),
      ];
      const err = new Error('not found');
      err.status = 404;
      const transport = {
        deletePromptsByIds: sinon.stub().rejects(err),
        publishProject: sinon.stub().resolves({}),
      };
      const result = await handleBulkDeletePrompts(
        transport,
        makeDataAccess(projects),
        BRAND,
        WORKSPACE,
        { semrushIds: [{ semrushProjectId: 'p1', semrushPromptId: 'sid-gone' }] },
        fakeLog(),
      );
      // The id is already gone → caller's intent is satisfied → counts as deleted.
      expect(result.deleted).to.equal(1);
      expect(result.failed).to.deep.equal([]);
      // Publish still runs so any draft updates persist.
      expect(transport.publishProject).to.have.been.calledWith(WORKSPACE, 'p1');
    });

    it('rejects targets pointing to projects not mapped to the brand', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p1', semrushLocationId: 2840, language: 'en' }),
      ];
      const transport = {
        deletePromptsByIds: sinon.stub().resolves({}),
        publishProject: sinon.stub().resolves({}),
      };
      const result = await handleBulkDeletePrompts(
        transport,
        makeDataAccess(projects),
        BRAND,
        WORKSPACE,
        {
          semrushIds: [
            { semrushProjectId: 'p1', semrushPromptId: 's1' },
            { semrushProjectId: 'p-foreign', semrushPromptId: 's2' },
            { semrushProjectId: '', semrushPromptId: '' },
          ],
        },
        fakeLog(),
      );
      expect(result.deleted).to.equal(1);
      expect(result.failed.map((f) => f.message)).to.include.members([
        'Project not mapped to brand',
        'Missing semrushProjectId or semrushPromptId',
      ]);
    });

    it('records upstream delete failures per id and still publishes', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p1', semrushLocationId: 2840, language: 'en' }),
      ];
      const transport = {
        deletePromptsByIds: sinon.stub().rejects(
          Object.assign(new Error('upstream-fail'), { status: 503 }),
        ),
        publishProject: sinon.stub().resolves({}),
      };
      const result = await handleBulkDeletePrompts(
        transport,
        makeDataAccess(projects),
        BRAND,
        WORKSPACE,
        {
          semrushIds: [
            { semrushProjectId: 'p1', semrushPromptId: 's1' },
            { semrushProjectId: 'p1', semrushPromptId: 's2' },
          ],
        },
        fakeLog(),
      );
      expect(result.deleted).to.equal(0);
      expect(result.failed).to.have.length(2);
      expect(result.failed[0].status).to.equal(503);
    });

    it('reports publish errors as synthetic failed entries', async () => {
      const projects = [
        makeProject({ semrushProjectId: 'p1', semrushLocationId: 2840, language: 'en' }),
      ];
      const transport = {
        deletePromptsByIds: sinon.stub().resolves({}),
        publishProject: sinon.stub().rejects(new Error('boom')),
      };
      const result = await handleBulkDeletePrompts(
        transport,
        makeDataAccess(projects),
        BRAND,
        WORKSPACE,
        { semrushIds: [{ semrushProjectId: 'p1', semrushPromptId: 's1' }] },
        fakeLog(),
      );
      expect(result.deleted).to.equal(1);
      expect(result.failed[0].message).to.equal('publish: boom');
    });
  });
});
