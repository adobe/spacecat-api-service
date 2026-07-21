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
  handleListPromptsSubworkspace,
  handleCreatePromptsSubworkspace,
  handleUpdatePromptSubworkspace,
  handleBulkDeletePromptsSubworkspace,
} from '../../../../src/support/serenity/handlers/prompts-subworkspace.js';
import { SerenityTransportError } from '../../../../src/support/serenity/rest-transport.js';
import { TAG_IDS, makeListProjectTagsStub } from '../fixtures/tag-tree.js';

use(chaiAsPromised);
use(sinonChai);

const WS = 'subworkspace-ws-1';
const log = { info: () => {}, error: () => {}, warn: () => {} };

// A subworkspace project for a (geo, lang) slice, in the v1 default shape:
// nested settings.ai.location.id / settings.ai.language.name, no created_at.
function proj({ id = 'p-us-en', geo = 2840, lang = 'en' } = {}) {
  return {
    id,
    publish_status: 'live',
    updated_at: '2026-06-02T00:00:00Z',
    settings: { ai: { location: { id: geo }, language: { name: lang } } },
  };
}

function makeTransport(overrides = {}) {
  return {
    listProjects: sinon.stub().resolves({ items: [proj()] }),
    listProjectTags: makeListProjectTagsStub(),
    listPromptsByTags: sinon.stub().resolves({ items: [] }),
    createPromptsWithMetadata: sinon.stub().resolves({
      page: 1, total: 1, items: [{ id: 'new-prompt', name: 'p' }],
    }),
    deletePromptsByIds: sinon.stub().resolves(null),
    patchPrompt: sinon.stub().callsFake(
      (ws, pid, promptId, newName) => Promise.resolve(
        { id: promptId, name: newName, is_updated: true },
      ),
    ),
    updatePromptTagsByIds: sinon.stub().resolves(null),
    publishProject: sinon.stub().resolves(null),
    ...overrides,
  };
}

// A classifier over BARE `type` values, matching the flat-mode twin.
const classifyByBrandMention = (text) => (/\bacme\b/i.test(text) ? 'branded' : 'non-branded');

// Matchers for the v3 metadata write shapes (LLMO-6289), mirroring the flat-mode
// twin's test helpers. `by` is undefined when a test omits callerId.
const createItemMatch = (name, by) => sinon.match({
  name,
  metadata: sinon.match({
    created_at: sinon.match.string,
    created_by: by,
    updated_at: sinon.match.string,
    updated_by: by,
  }),
});
const patchTextMatch = (name, by) => sinon.match({
  name,
  metadata: sinon.match({ updated_at: sinon.match.string, updated_by: by }),
});

describe('prompts-subworkspace handlers', () => {
  afterEach(() => sinon.restore());

  describe('handleListPromptsSubworkspace', () => {
    it('resolves the slice from the listing and maps prompts', async () => {
      const transport = makeTransport({
        listPromptsByTags: sinon.stub().resolves({
          items: [{
            id: 'q1',
            name: 'a prompt',
            // A descendant tag embeds its own parent_id + root-first path.
            tags: [{
              id: TAG_IDS.categoryRunningShoes,
              name: 'Running Shoes',
              parent_id: TAG_IDS.categoryRoot,
              path: [{ id: TAG_IDS.categoryRoot, name: 'category' }],
            }],
          }],
        }),
      });
      const result = await handleListPromptsSubworkspace(
        transport,
        WS,
        { geoTargetId: 2840, languageCode: 'en' },
        log,
      );
      // Parentage rides on the prompt payload; no tag-tree walk is needed.
      expect(result.items).to.deep.equal([{
        semrushPromptId: 'q1',
        geoTargetId: 2840,
        languageCode: 'en',
        text: 'a prompt',
        tags: [{
          id: TAG_IDS.categoryRunningShoes,
          name: 'Running Shoes',
          parentId: TAG_IDS.categoryRoot,
          path: [{ id: TAG_IDS.categoryRoot, name: 'category' }],
        }],
        tagMap: { 'Running Shoes': TAG_IDS.categoryRunningShoes },
        createdAt: null,
        createdBy: null,
        updatedAt: null,
        updatedBy: null,
      }]);
      expect(result).to.include({ total: 1, page: 1, limit: 50 });
      expect(transport.listPromptsByTags).to.have.been.calledWith(WS, 'p-us-en');
    });

    it('404s marketNotFound when the slice has no project', async () => {
      const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [] }) });
      const p = handleListPromptsSubworkspace(transport, WS, { geoTargetId: 2840, languageCode: 'en' }, log);
      await expect(p).to.be.rejected;
      try {
        await p;
      } catch (e) {
        expect(e.status).to.equal(404);
        expect(e.code).to.equal('marketNotFound');
      }
      expect(transport.listPromptsByTags).to.not.have.been.called;
    });

    it('400s on a missing slice key', async () => {
      await expect(handleListPromptsSubworkspace(makeTransport(), WS, { languageCode: 'en' }, log))
        .to.be.rejectedWith(/geoTargetId/);
    });

    it('uses the upstream total when a full page is returned', async () => {
      const transport = makeTransport({
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 'q1', name: 'a', tags: [] }],
          total: 137,
        }),
      });
      const result = await handleListPromptsSubworkspace(
        transport,
        WS,
        { geoTargetId: 2840, languageCode: 'en', limit: 1 },
        log,
      );
      // items.length (1) is NOT < limit (1), so total comes from the upstream.
      expect(result.total).to.equal(137);
    });
  });

  describe('handleCreatePromptsSubworkspace', () => {
    it('creates prompts by id on the resolved project and publishes once', async () => {
      const transport = makeTransport();
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log);
      expect(result.created).to.have.length(1);
      expect(result.created[0]).to.include({ semrushPromptId: 'new-prompt', geoTargetId: 2840 });
      expect(transport.createPromptsWithMetadata).to.have.been.calledOnceWithExactly(WS, 'p-us-en', [createItemMatch('p', undefined)], ['tag-1']);
      expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'p-us-en');
    });

    it('dynamic-allocation ON: fronts headroom sized on the batch BEFORE the write, not just before publish (LLMO-6190, live-verified)', async () => {
      // The metered write is createPromptsWithMetadata itself (Rainer, live-verified) — a
      // disguised-quota 405 fires there, before any publish. getWorkspaceResources must be read (if
      // needed, a top-up transferred) before the first createPromptsWithMetadata call, not after.
      const transport = makeTransport({
        getWorkspaceResources: sinon.stub().resolves({
          product_resources: {
            ai: {
              resources: {
                projects: { used: 0, total: 10 }, prompts: { used: 0, total: 100 },
              },
            },
          },
        }),
      });
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log, undefined, undefined, { dynamicAllocation: true, parentWorkspaceId: 'parent-ws' });
      expect(result.created).to.have.length(1);
      expect(transport.getWorkspaceResources).to.have.been.calledOnceWith(WS);
      expect(transport.getWorkspaceResources)
        .to.have.been.calledBefore(transport.createPromptsWithMetadata);
    });

    // A tag NAME cannot address a nested tag, so a `tags` key is rejected
    // rather than silently writing a phantom root tag (twin of the flat-mode
    // contract).
    it('skips an input that supplies tag names instead of tagIds', async () => {
      const transport = makeTransport();
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tags: ['Running Shoes'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log);
      expect(result.created).to.have.length(0);
      expect(result.skipped).to.have.length(1);
      expect(transport.createPromptsWithMetadata).to.not.have.been.called;
    });

    it('injects the computed type tag id from the classifier (serenity-docs#31, twin of the flat-mode layer)', async () => {
      const transport = makeTransport();
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'is Acme good?',
          tagIds: [TAG_IDS.categoryRunningShoes, TAG_IDS.typeNonBranded],
          geoTargetId: 2840,
          languageCode: 'en',
        }],
      }, log, classifyByBrandMention);
      expect(result.created[0].tagIds).to.deep.equal([
        TAG_IDS.categoryRunningShoes, TAG_IDS.typeBranded,
      ]);
      expect(transport.createPromptsWithMetadata).to.have.been.calledOnceWithExactly(
        WS,
        'p-us-en',
        [createItemMatch('is Acme good?', undefined)],
        [TAG_IDS.categoryRunningShoes, TAG_IDS.typeBranded],
      );
    });

    it('skips inputs whose slice has no project (one listing, no per-input lookup)', async () => {
      const transport = makeTransport();
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tagIds: ['tag-1'], geoTargetId: 9999, languageCode: 'en',
        }],
      }, log);
      expect(result.created).to.have.length(0);
      expect(result.skipped).to.have.length(1);
      expect(transport.listProjects).to.have.been.calledOnce;
      expect(transport.createPromptsWithMetadata).to.not.have.been.called;
    });

    it('400s on an empty prompts array', async () => {
      await expect(handleCreatePromptsSubworkspace(makeTransport(), WS, { prompts: [] }, log))
        .to.be.rejectedWith(/non-empty/);
    });

    it('400s when the prompts array exceeds maxItems', async () => {
      const prompts = Array.from({ length: 501 }, (unused, i) => ({
        text: `p${i}`, tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
      }));
      await expect(handleCreatePromptsSubworkspace(makeTransport(), WS, { prompts }, log))
        .to.be.rejectedWith(/maxItems/);
    });

    it('skips an input that fails normalization (missing text)', async () => {
      const result = await handleCreatePromptsSubworkspace(makeTransport(), WS, {
        prompts: [{ tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en' }],
      }, log);
      expect(result.created).to.have.length(0);
      expect(result.skipped).to.have.length(1);
      expect(result.skipped[0].reason).to.match(/required/);
    });

    it('records an upstream create failure per input and redacts the gateway URL', async () => {
      // The transport error message embeds the internal gateway URL + UUIDs;
      // the per-item failed.message must be redacted, never echoed to the client.
      const leak = 'Semrush POST https://gw.internal/workspaces/ws/projects/p/prompts failed: 500';
      const transport = makeTransport({
        createPromptsWithMetadata: sinon.stub().rejects(new SerenityTransportError(500, leak)),
      });
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log);
      expect(result.created).to.have.length(0);
      expect(result.failed).to.have.length(1);
      expect(result.failed[0].status).to.equal(500);
      expect(result.failed[0].message).to.equal('Upstream request failed');
      expect(result.failed[0].message).to.not.contain('gw.internal');
    });

    it('defaults a statusless create failure to status 500', async () => {
      const transport = makeTransport({
        createPromptsWithMetadata: sinon.stub().rejects(new Error('no status')),
      });
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log);
      expect(result.failed[0].status).to.equal(500);
    });

    it('appends a publish failure to failed', async () => {
      const transport = makeTransport({
        publishProject: sinon.stub().rejects(new SerenityTransportError(502, 'publish down')),
      });
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log);
      expect(result.created).to.have.length(1);
      expect(result.failed).to.have.length(1);
      expect(result.failed[0].message).to.match(/^publish:/);
    });
  });

  describe('handleUpdatePromptSubworkspace', () => {
    it('edits the prompt in place (rename + tag write) and publishes', async () => {
      const transport = makeTransport();
      const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
      }, log);
      expect(result.status).to.equal(200);
      // The id is preserved — the edit is in place, never a re-create.
      expect(result.body.semrushPromptId).to.equal('old-id');
      expect(transport.patchPrompt).to.have.been.calledOnceWithExactly(WS, 'p-us-en', 'old-id', patchTextMatch('new', undefined));
      expect(transport.updatePromptTagsByIds).to.have.been.calledOnceWithExactly(
        WS,
        'p-us-en',
        [{ id: 'old-id', references: ['tag-1'], replace: true }],
      );
      expect(transport.deletePromptsByIds).to.not.have.been.called;
      expect(transport.createPromptsWithMetadata).to.not.have.been.called;
      expect(transport.publishProject).to.have.been.calledOnce;
    });

    it('404s marketNotFound when the slice has no project', async () => {
      const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [] }) });
      const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
      }, log);
      expect(result.status).to.equal(404);
      expect(result.body.error).to.equal('marketNotFound');
    });

    it('404s promptNotFound when the upstream rename 404s (no tag write)', async () => {
      const transport = makeTransport({
        patchPrompt: sinon.stub().rejects(new SerenityTransportError(404, 'gone')),
      });
      const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
      }, log);
      expect(result.status).to.equal(404);
      expect(result.body.error).to.equal('promptNotFound');
      expect(transport.updatePromptTagsByIds).to.not.have.been.called;
    });

    it('400s when text or tagIds are missing', async () => {
      const result = await handleUpdatePromptSubworkspace(
        makeTransport(),
        WS,
        'old-id',
        { geoTargetId: 2840, languageCode: 'en' },
        log,
      );
      expect(result.status).to.equal(400);
    });

    it('400s when both tags and tagIds are present (mutually exclusive)', async () => {
      const result = await handleUpdatePromptSubworkspace(
        makeTransport(),
        WS,
        'old-id',
        {
          text: 'new', tags: ['t'], tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
        },
        log,
      );
      expect(result.status).to.equal(400);
      expect(result.body.error).to.equal('invalidRequest');
    });

    it('edits text+tagIds in place, echoing the sanitized ids', async () => {
      const transport = makeTransport();
      const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tagIds: ['tag-cat-1', '', undefined], geoTargetId: 2840, languageCode: 'en',
      }, log);
      expect(result.status).to.equal(200);
      expect(result.body.semrushPromptId).to.equal('old-id');
      expect(result.body.tagIds).to.deep.equal(['tag-cat-1']);
      expect(transport.patchPrompt).to.have.been.calledOnceWithExactly(WS, 'p-us-en', 'old-id', patchTextMatch('new', undefined));
      expect(transport.updatePromptTagsByIds).to.have.been.calledOnceWithExactly(
        WS,
        'p-us-en',
        [{ id: 'old-id', references: ['tag-cat-1'], replace: true }],
      );
    });

    it('400s when the slice key is invalid', async () => {
      const result = await handleUpdatePromptSubworkspace(
        makeTransport(),
        WS,
        'old-id',
        {
          text: 'new', tagIds: ['tag-1'], geoTargetId: -1, languageCode: 'en',
        },
        log,
      );
      expect(result.status).to.equal(400);
      expect(result.body.error).to.equal('invalidRequest');
    });

    it('recomputes the type tag from the NEW text on edit (serenity-docs#31, twin of the flat-mode layer)', async () => {
      // Guards the subworkspace UPDATE injection wiring: without the classifier
      // arg the defensive `typeof !== function` bypass fires silently, so a
      // regression in the in-place edit's injection would go uncaught here.
      const transport = makeTransport();
      const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'now mentions Acme',
        tagIds: [TAG_IDS.categoryRunningShoes, TAG_IDS.typeNonBranded],
        geoTargetId: 2840,
        languageCode: 'en',
      }, log, classifyByBrandMention);
      expect(result.status).to.equal(200);
      expect(result.body.tagIds).to.deep.equal([
        TAG_IDS.categoryRunningShoes, TAG_IDS.typeBranded,
      ]);
      expect(transport.updatePromptTagsByIds).to.have.been.calledOnceWithExactly(
        WS,
        'p-us-en',
        [{
          id: 'old-id',
          references: [TAG_IDS.categoryRunningShoes, TAG_IDS.typeBranded],
          replace: true,
        }],
      );
    });

    it('re-throws a rename 409 (text collision) with no tag write and no publish', async () => {
      const transport = makeTransport({
        patchPrompt: sinon.stub().rejects(new SerenityTransportError(409, 'conflict')),
      });
      await expect(handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'a sibling\'s text', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
      }, log)).to.be.rejectedWith(SerenityTransportError, /conflict/);
      expect(transport.updatePromptTagsByIds).to.not.have.been.called;
      expect(transport.publishProject).to.not.have.been.called;
    });

    it('re-throws a non-404 rename failure (no tag write)', async () => {
      const transport = makeTransport({
        patchPrompt: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });
      await expect(handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
      }, log)).to.be.rejected;
      expect(transport.updatePromptTagsByIds).to.not.have.been.called;
    });

    it('re-throws a tag-write failure after a successful rename (no publish)', async () => {
      const tagErr = Object.assign(new Error('tag write boom'), { status: 500 });
      const transport = makeTransport({
        updatePromptTagsByIds: sinon.stub().rejects(tagErr),
      });
      const warnLog = { info: () => {}, error: () => {}, warn: sinon.stub() };
      await expect(handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
      }, warnLog)).to.be.rejectedWith(/tag write boom/);
      expect(transport.patchPrompt).to.have.been.calledOnce;
      expect(transport.publishProject).to.not.have.been.called;
      expect(warnLog.warn).to.have.been.calledOnceWith(
        'updatePromptTagsByIds failed after a successful text/metadata PATCH — text updated, tags stale',
        { semrushPromptId: 'old-id', projectId: 'p-us-en', error: 'tag write boom' },
      );
    });
  });

  describe('handleBulkDeletePromptsSubworkspace', () => {
    it('batches deletes per resolved project and publishes affected', async () => {
      const transport = makeTransport();
      const result = await handleBulkDeletePromptsSubworkspace(transport, WS, {
        prompts: [
          { semrushPromptId: 'q1', geoTargetId: 2840, languageCode: 'en' },
          { semrushPromptId: 'q2', geoTargetId: 2840, languageCode: 'en' },
        ],
      }, log);
      expect(result.deleted).to.equal(2);
      expect(transport.deletePromptsByIds).to.have.been.calledOnceWith(WS, 'p-us-en', ['q1', 'q2']);
      expect(transport.publishProject).to.have.been.calledOnce;
    });

    it('fails targets whose slice has no project', async () => {
      const transport = makeTransport();
      const result = await handleBulkDeletePromptsSubworkspace(transport, WS, {
        prompts: [{ semrushPromptId: 'q1', geoTargetId: 9999, languageCode: 'en' }],
      }, log);
      expect(result.deleted).to.equal(0);
      expect(result.failed).to.have.length(1);
      expect(transport.deletePromptsByIds).to.not.have.been.called;
    });

    it('treats an upstream 404 as success', async () => {
      const transport = makeTransport({
        deletePromptsByIds: sinon.stub().rejects(new SerenityTransportError(404, 'gone')),
      });
      const result = await handleBulkDeletePromptsSubworkspace(transport, WS, {
        prompts: [{ semrushPromptId: 'q1', geoTargetId: 2840, languageCode: 'en' }],
      }, log);
      expect(result.deleted).to.equal(1);
      expect(result.failed).to.have.length(0);
    });

    it('400s on an empty prompts array', async () => {
      await expect(handleBulkDeletePromptsSubworkspace(makeTransport(), WS, { prompts: [] }, log))
        .to.be.rejectedWith(/non-empty/);
    });

    it('400s when the prompts array exceeds maxItems', async () => {
      const prompts = Array.from({ length: 501 }, (unused, i) => ({
        semrushPromptId: `q${i}`, geoTargetId: 2840, languageCode: 'en',
      }));
      await expect(handleBulkDeletePromptsSubworkspace(makeTransport(), WS, { prompts }, log))
        .to.be.rejectedWith(/maxItems/);
    });

    it('fails a target missing its id or slice key', async () => {
      const result = await handleBulkDeletePromptsSubworkspace(makeTransport(), WS, {
        prompts: [{ geoTargetId: 2840, languageCode: 'en' }],
      }, log);
      expect(result.deleted).to.equal(0);
      expect(result.failed).to.have.length(1);
      expect(result.failed[0].message).to.match(/Missing/);
    });

    it('records a non-404 delete failure per target in the bucket', async () => {
      const transport = makeTransport({
        deletePromptsByIds: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });
      const result = await handleBulkDeletePromptsSubworkspace(transport, WS, {
        prompts: [{ semrushPromptId: 'q1', geoTargetId: 2840, languageCode: 'en' }],
      }, log);
      expect(result.deleted).to.equal(0);
      expect(result.failed).to.have.length(1);
      expect(result.failed[0].status).to.equal(500);
    });

    it('defaults a statusless delete failure to status 500', async () => {
      const transport = makeTransport({
        deletePromptsByIds: sinon.stub().rejects(new Error('no status')),
      });
      const result = await handleBulkDeletePromptsSubworkspace(transport, WS, {
        prompts: [{ semrushPromptId: 'q1', geoTargetId: 2840, languageCode: 'en' }],
      }, log);
      expect(result.failed[0].status).to.equal(500);
    });

    it('appends a publish failure to failed', async () => {
      const transport = makeTransport({
        publishProject: sinon.stub().rejects(new SerenityTransportError(502, 'publish down')),
      });
      const result = await handleBulkDeletePromptsSubworkspace(transport, WS, {
        prompts: [{ semrushPromptId: 'q1', geoTargetId: 2840, languageCode: 'en' }],
      }, log);
      expect(result.deleted).to.equal(1);
      expect(result.failed.some((f) => /^publish:/.test(f.message))).to.equal(true);
    });
  });
});

describe('prompts-subworkspace — defensive branch coverage', () => {
  afterEach(() => sinon.restore());

  // Lines 61/65: page and search defensive defaults in handleListPromptsSubworkspace.
  // query.page not an integer (string) → defaults to 1.
  // query.page <= 0 → also defaults to 1.
  // query without search → search stays undefined.
  it('handleListPromptsSubworkspace: non-integer page defaults to 1, absent search stays undefined', async () => {
    const transport = makeTransport({
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
    });
    // page is a string (not integer) → defaults to 1; no search field.
    const result = await handleListPromptsSubworkspace(
      transport,
      WS,
      { geoTargetId: 2840, languageCode: 'en', page: 'bad' },
      log,
    );
    expect(result.page).to.equal(1);
    const [, , body] = transport.listPromptsByTags.firstCall.args;
    expect(body.page).to.equal(1);
    expect(body.search).to.equal(undefined);
  });

  it('handleListPromptsSubworkspace: page <= 0 defaults to 1', async () => {
    const transport = makeTransport({
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
    });
    const result = await handleListPromptsSubworkspace(
      transport,
      WS,
      { geoTargetId: 2840, languageCode: 'en', page: 0 },
      log,
    );
    expect(result.page).to.equal(1);
  });

  // Line 67 truthy: query.tagIds IS an array — cover the truthy side if it
  // lacks coverage (the else side produces [] which existing tests exercise).
  it('handleListPromptsSubworkspace: tagIds array is forwarded to listPromptsByTags', async () => {
    const transport = makeTransport({
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
    });
    await handleListPromptsSubworkspace(
      transport,
      WS,
      { geoTargetId: 2840, languageCode: 'en', tagIds: ['uuid-1', 'uuid-2'] },
      log,
    );
    const [, , body] = transport.listPromptsByTags.firstCall.args;
    expect(body.tag_ids).to.deep.equal(['uuid-1', 'uuid-2']);
  });

  // Line 86: `Array.isArray(resp?.items)?resp.items:[]` — transport.listPromptsByTags
  // resolves with `{}` (no items field) → defensive fallback to [].
  it('handleListPromptsSubworkspace: survives upstream listPromptsByTags returning {} (no items)', async () => {
    const transport = makeTransport({
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({}),
    });
    const result = await handleListPromptsSubworkspace(
      transport,
      WS,
      { geoTargetId: 2840, languageCode: 'en' },
      log,
    );
    expect(result.items).to.deep.equal([]);
    expect(result.total).to.equal(0);
  });

  // Line 91: `Number.isFinite(resp?.total)?resp.total:items.length` else branch —
  // fires when items.length >= limit (full page) AND resp.total is missing/non-finite.
  it('handleListPromptsSubworkspace: falls back to items.length when total is missing and page is full', async () => {
    // Return exactly 1 item and set limit to 1 — a full page. resp has no total.
    const transport = makeTransport({
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({
        items: [{ id: 'q1', name: 'a prompt', tags: [] }],
        // total intentionally absent
      }),
    });
    const result = await handleListPromptsSubworkspace(
      transport,
      WS,
      { geoTargetId: 2840, languageCode: 'en', limit: 1 },
      log,
    );
    // items.length (1) is NOT < limit (1), so total path falls through to else.
    // Number.isFinite(undefined) is false → total = items.length = 1.
    expect(result.total).to.equal(1);
  });

  // Line 109: `Array.isArray(body?.prompts)?body.prompts:[]` else —
  // body.prompts is not an array so [] is used, then the empty-array 400 fires.
  it('handleCreatePromptsSubworkspace: 400s when body.prompts is not an array', async () => {
    await expect(
      handleCreatePromptsSubworkspace(makeTransport(), WS, { prompts: 'notanarray' }, log),
    ).to.be.rejectedWith(/non-empty/);
  });

  // `createPromptsWithMetadata` resolves without an `items` array → semrushPromptId
  // degrades to '' rather than the literal string "undefined".
  it('handleCreatePromptsSubworkspace: semrushPromptId is empty string when createPromptsWithMetadata returns no items', async () => {
    const transport = makeTransport({
      createPromptsWithMetadata: sinon.stub().resolves({}),
    });
    const result = await handleCreatePromptsSubworkspace(transport, WS, {
      prompts: [{
        text: 'p', tagIds: ['tag-1'], geoTargetId: 2840, languageCode: 'en',
      }],
    }, log);
    expect(result.created).to.have.length(1);
    expect(result.created[0].semrushPromptId).to.equal('');
  });

  // A `tags` key is rejected on presence, whatever its value — a name cannot
  // address a nested tag.
  it('handleUpdatePromptSubworkspace: 400s on a non-array tags key', async () => {
    const result = await handleUpdatePromptSubworkspace(makeTransport(), WS, 'old-id', {
      text: 'next',
      tags: null,
      tagIds: ['tag-1'],
      geoTargetId: 2840,
      languageCode: 'en',
    }, log);
    expect(result.status).to.equal(400);
    expect(result.body.error).to.equal('invalidRequest');
  });

  // Line 299: `Array.isArray(body?.prompts)?body.prompts:[]` else —
  // body.prompts is not an array so [] is used, then the empty-array 400 fires.
  it('handleBulkDeletePromptsSubworkspace: 400s when body.prompts is not an array', async () => {
    await expect(
      handleBulkDeletePromptsSubworkspace(makeTransport(), WS, { prompts: 'bad' }, log),
    ).to.be.rejectedWith(/non-empty/);
  });

  // Line 61 true branch: query.page IS a positive integer — the ternary uses it directly.
  // All existing tests omit page (defaults to 1 via the else), so this side was uncovered.
  it('handleListPromptsSubworkspace: valid integer page > 0 is forwarded to listPromptsByTags', async () => {
    const transport = makeTransport({
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
    });
    const result = await handleListPromptsSubworkspace(
      transport,
      WS,
      { geoTargetId: 2840, languageCode: 'en', page: 3 },
      log,
    );
    expect(result.page).to.equal(3);
    const [, , body] = transport.listPromptsByTags.firstCall.args;
    expect(body.page).to.equal(3);
  });

  // Line 65 true branch: query.search has text — the truthy path trims and returns the string.
  it('handleListPromptsSubworkspace: search string is trimmed and forwarded when provided', async () => {
    const transport = makeTransport({
      listProjectTags: sinon.stub().resolves({ items: [] }),
      listPromptsByTags: sinon.stub().resolves({ items: [], total: 0 }),
    });
    await handleListPromptsSubworkspace(
      transport,
      WS,
      { geoTargetId: 2840, languageCode: 'en', search: '  shoes  ' },
      log,
    );
    const [, , body] = transport.listPromptsByTags.firstCall.args;
    expect(body.search).to.equal('shoes');
  });

  // body.tagIds IS an array but carries a falsy element; the sanitizer coerces
  // it away rather than forwarding an empty id upstream (which would 500 the
  // atomic create).
  it('handleUpdatePromptSubworkspace: falsy entries in body.tagIds are dropped', async () => {
    const transport = makeTransport();
    const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
      text: 'next',
      tagIds: ['keep', null, ''],
      geoTargetId: 2840,
      languageCode: 'en',
    }, log);
    expect(result.status).to.equal(200);
    expect(result.body.tagIds).to.deep.equal(['keep']);
  });
});
