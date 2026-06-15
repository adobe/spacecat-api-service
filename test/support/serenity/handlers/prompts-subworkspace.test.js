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
    listPromptsByTags: sinon.stub().resolves({ items: [] }),
    createTaggedPrompts: sinon.stub().resolves({ ids: ['new-prompt'] }),
    deletePromptsByIds: sinon.stub().resolves(null),
    publishProject: sinon.stub().resolves(null),
    ...overrides,
  };
}

describe('prompts-subworkspace handlers', () => {
  afterEach(() => sinon.restore());

  describe('handleListPromptsSubworkspace', () => {
    it('resolves the slice from the listing and maps prompts', async () => {
      const transport = makeTransport({
        listPromptsByTags: sinon.stub().resolves({
          items: [{ id: 'q1', name: 'a prompt', tags: [{ id: 't-1', name: 'Topic' }] }],
        }),
      });
      const result = await handleListPromptsSubworkspace(
        transport,
        WS,
        { geoTargetId: 2840, languageCode: 'en' },
        log,
      );
      expect(result.items).to.deep.equal([{
        semrushPromptId: 'q1',
        geoTargetId: 2840,
        languageCode: 'en',
        text: 'a prompt',
        tagMap: { Topic: 't-1' },
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
    it('creates prompts on the resolved project and publishes once', async () => {
      const transport = makeTransport();
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tags: ['x'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log);
      expect(result.created).to.have.length(1);
      expect(result.created[0]).to.include({ semrushPromptId: 'new-prompt', geoTargetId: 2840 });
      expect(transport.createTaggedPrompts).to.have.been.calledWith(WS, 'p-us-en');
      expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'p-us-en');
    });

    it('skips inputs whose slice has no project (one listing, no per-input lookup)', async () => {
      const transport = makeTransport();
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tags: [], geoTargetId: 9999, languageCode: 'en',
        }],
      }, log);
      expect(result.created).to.have.length(0);
      expect(result.skipped).to.have.length(1);
      expect(transport.listProjects).to.have.been.calledOnce;
      expect(transport.createTaggedPrompts).to.not.have.been.called;
    });

    it('400s on an empty prompts array', async () => {
      await expect(handleCreatePromptsSubworkspace(makeTransport(), WS, { prompts: [] }, log))
        .to.be.rejectedWith(/non-empty/);
    });

    it('400s when the prompts array exceeds maxItems', async () => {
      const prompts = Array.from({ length: 501 }, (unused, i) => ({
        text: `p${i}`, tags: [], geoTargetId: 2840, languageCode: 'en',
      }));
      await expect(handleCreatePromptsSubworkspace(makeTransport(), WS, { prompts }, log))
        .to.be.rejectedWith(/maxItems/);
    });

    it('skips an input that fails normalization (missing text)', async () => {
      const result = await handleCreatePromptsSubworkspace(makeTransport(), WS, {
        prompts: [{ tags: ['x'], geoTargetId: 2840, languageCode: 'en' }],
      }, log);
      expect(result.created).to.have.length(0);
      expect(result.skipped).to.have.length(1);
      expect(result.skipped[0].reason).to.match(/required/);
    });

    it('records an upstream createTaggedPrompts failure per input', async () => {
      const transport = makeTransport({
        createTaggedPrompts: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tags: ['x'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log);
      expect(result.created).to.have.length(0);
      expect(result.failed).to.have.length(1);
      expect(result.failed[0].status).to.equal(500);
    });

    it('appends a publish failure to failed', async () => {
      const transport = makeTransport({
        publishProject: sinon.stub().rejects(new SerenityTransportError(502, 'publish down')),
      });
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tags: ['x'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log);
      expect(result.created).to.have.length(1);
      expect(result.failed).to.have.length(1);
      expect(result.failed[0].message).to.match(/^publish:/);
    });
  });

  describe('handleUpdatePromptSubworkspace', () => {
    it('replaces the prompt (delete-then-create) and publishes', async () => {
      const transport = makeTransport();
      const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tags: ['t'], geoTargetId: 2840, languageCode: 'en',
      }, log);
      expect(result.status).to.equal(200);
      expect(result.body.semrushPromptId).to.equal('new-prompt');
      expect(transport.deletePromptsByIds).to.have.been.calledWith(WS, 'p-us-en', ['old-id']);
      expect(transport.createTaggedPrompts).to.have.been.calledOnce;
      expect(transport.publishProject).to.have.been.calledOnce;
    });

    it('404s marketNotFound when the slice has no project', async () => {
      const transport = makeTransport({ listProjects: sinon.stub().resolves({ items: [] }) });
      const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tags: [], geoTargetId: 2840, languageCode: 'en',
      }, log);
      expect(result.status).to.equal(404);
      expect(result.body.error).to.equal('marketNotFound');
    });

    it('404s promptNotFound when the upstream delete 404s (never creates after a failed delete)', async () => {
      const transport = makeTransport({
        deletePromptsByIds: sinon.stub().rejects(new SerenityTransportError(404, 'gone')),
      });
      const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tags: [], geoTargetId: 2840, languageCode: 'en',
      }, log);
      expect(result.status).to.equal(404);
      expect(result.body.error).to.equal('promptNotFound');
      expect(transport.createTaggedPrompts).to.not.have.been.called;
    });

    it('400s when text or tags are missing', async () => {
      const result = await handleUpdatePromptSubworkspace(
        makeTransport(),
        WS,
        'old-id',
        { geoTargetId: 2840, languageCode: 'en' },
        log,
      );
      expect(result.status).to.equal(400);
    });

    it('400s when the slice key is invalid', async () => {
      const result = await handleUpdatePromptSubworkspace(
        makeTransport(),
        WS,
        'old-id',
        {
          text: 'new', tags: [], geoTargetId: -1, languageCode: 'en',
        },
        log,
      );
      expect(result.status).to.equal(400);
      expect(result.body.error).to.equal('invalidRequest');
    });

    it('re-throws a non-404 delete failure (never creates after a failed delete)', async () => {
      const transport = makeTransport({
        deletePromptsByIds: sinon.stub().rejects(new SerenityTransportError(500, 'boom')),
      });
      await expect(handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tags: [], geoTargetId: 2840, languageCode: 'en',
      }, log)).to.be.rejected;
      expect(transport.createTaggedPrompts).to.not.have.been.called;
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
