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
import { ErrorWithStatusCode } from '../../../../src/support/utils.js';

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
    // serenity-docs#32: intent injection always resolves/creates an
    // `intent:*` tag id on the id-based path, even when a test isn't
    // exercising intent classification specifically.
    listProjectTags: sinon.stub().resolves({ items: [] }),
    createProjectTags: sinon.stub().resolves([{ id: 'intent-tag-id', name: 'intent:Informational' }]),
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

    it('creates a prompt by id-based tagIds via aio/prompts, not the name-based endpoint (twin of the flat-mode fix)', async () => {
      const transport = makeTransport({
        createPromptsByIds: sinon.stub().resolves({
          page: 1, total: 1, items: [{ id: 'new-prompt-by-id', name: 'p' }], existing_count: 0,
        }),
      });
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tagIds: ['tag-cat-1', 'tag-child-1'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log);
      expect(result.created).to.have.length(1);
      expect(result.created[0]).to.include({ semrushPromptId: 'new-prompt-by-id' });
      expect(result.created[0].tagIds).to.deep.equal(['tag-cat-1', 'tag-child-1', 'intent-tag-id']);
      expect(transport.createPromptsByIds).to.have.been.calledOnceWithExactly(WS, 'p-us-en', ['p'], ['tag-cat-1', 'tag-child-1', 'intent-tag-id']);
      expect(transport.createTaggedPrompts).to.not.have.been.called;
    });

    it('injects the computed type tag from the classifier (serenity-docs#31, twin of the flat-mode layer)', async () => {
      const transport = makeTransport();
      const classify = (text) => (/\bacme\b/i.test(text) ? 'type:branded' : 'type:non-branded');
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'is Acme good?', tags: ['topic:X', 'type:non-branded'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log, classify);
      expect(result.created[0].tags).to.deep.equal(['topic:X', 'type:branded', 'intent:Informational']);
      expect(transport.createTaggedPrompts).to.have.been.calledOnceWithExactly(
        WS,
        'p-us-en',
        { 'is Acme good?': ['topic:X', 'type:branded', 'intent:Informational'] },
      );
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

    it('records an upstream createTaggedPrompts failure per input and redacts the gateway URL', async () => {
      // The transport error message embeds the internal gateway URL + UUIDs;
      // the per-item failed.message must be redacted, never echoed to the client.
      const leak = 'Semrush POST https://gw.internal/workspaces/ws/projects/p/prompts failed: 500';
      const transport = makeTransport({
        createTaggedPrompts: sinon.stub().rejects(new SerenityTransportError(500, leak)),
      });
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tags: ['x'], geoTargetId: 2840, languageCode: 'en',
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
        createTaggedPrompts: sinon.stub().rejects(new Error('no status')),
      });
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tags: ['x'], geoTargetId: 2840, languageCode: 'en',
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
          text: 'p', tags: ['x'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log);
      expect(result.created).to.have.length(1);
      expect(result.failed).to.have.length(1);
      expect(result.failed[0].message).to.match(/^publish:/);
    });

    // serenity-docs#32: CSV chunking creates drafts-only per chunk
    // (deferPublish: true), publishing once on the final, non-deferred chunk.
    it('skips publishProject and reports published:false when body.deferPublish is true', async () => {
      const transport = makeTransport();
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tags: ['x'], geoTargetId: 2840, languageCode: 'en',
        }],
        deferPublish: true,
      }, log);
      expect(result.created).to.have.length(1);
      expect(result.published).to.equal(false);
      expect(transport.publishProject).to.not.have.been.called;
    });

    it('logs a structured line (observability) when deferPublish fires', async () => {
      const transport = makeTransport();
      const spyLog = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };
      await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tags: ['x'], geoTargetId: 2840, languageCode: 'en',
        }],
        deferPublish: true,
      }, spyLog);
      expect(spyLog.info).to.have.been.calledWithMatch(
        /deferPublish set/,
        sinon.match({
          workspaceId: WS, created: 1, skipped: 0, failed: 0,
        }),
      );
    });

    it('400s when deferPublish is present but not a boolean', async () => {
      const transport = makeTransport();
      await expect(handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tags: ['x'], geoTargetId: 2840, languageCode: 'en',
        }],
        deferPublish: 'yes',
      }, log)).to.be.rejectedWith(ErrorWithStatusCode, /deferPublish must be a boolean/);
    });

    it('publishes and reports published:true when body.deferPublish is absent', async () => {
      const transport = makeTransport();
      const result = await handleCreatePromptsSubworkspace(transport, WS, {
        prompts: [{
          text: 'p', tags: ['x'], geoTargetId: 2840, languageCode: 'en',
        }],
      }, log);
      expect(result.published).to.equal(true);
      expect(transport.publishProject).to.have.been.calledOnce;
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

    it('replaces text+tagIds via the id-based endpoint (twin of the flat-mode fix)', async () => {
      const transport = makeTransport({
        createPromptsByIds: sinon.stub().resolves({
          page: 1, total: 1, items: [{ id: 'new-prompt-by-id', name: 'new' }], existing_count: 0,
        }),
      });
      const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tagIds: ['tag-cat-1'], geoTargetId: 2840, languageCode: 'en',
      }, log);
      expect(result.status).to.equal(200);
      expect(result.body.semrushPromptId).to.equal('new-prompt-by-id');
      expect(result.body.tagIds).to.deep.equal(['tag-cat-1', 'intent-tag-id']);
      expect(transport.deletePromptsByIds).to.have.been.calledWith(WS, 'p-us-en', ['old-id']);
      expect(transport.createPromptsByIds).to.have.been.calledOnceWithExactly(WS, 'p-us-en', ['new'], ['tag-cat-1', 'intent-tag-id']);
      expect(transport.createTaggedPrompts).to.not.have.been.called;
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

    it('recomputes the type tag from the NEW text on edit (serenity-docs#31, twin of the flat-mode layer)', async () => {
      // Guards the subworkspace UPDATE injection wiring: without the classifier
      // arg the defensive `typeof !== function` bypass fires silently, so a
      // regression in delete-then-create injection would go uncaught here.
      const transport = makeTransport();
      const classify = (text) => (/\bacme\b/i.test(text) ? 'type:branded' : 'type:non-branded');
      const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'now mentions Acme', tags: ['topic:X', 'type:non-branded'], geoTargetId: 2840, languageCode: 'en',
      }, log, classify);
      expect(result.status).to.equal(200);
      expect(result.body.tags).to.deep.equal(['topic:X', 'type:branded', 'intent:Informational']);
      expect(transport.createTaggedPrompts).to.have.been.calledOnceWithExactly(
        WS,
        'p-us-en',
        { 'now mentions Acme': ['topic:X', 'type:branded', 'intent:Informational'] },
      );
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

    it('logs and re-throws when createOnePrompt fails AFTER a successful delete (data-loss window)', async () => {
      const createErr = Object.assign(new Error('unknown tag id: bogus'), { status: 500 });
      const transport = makeTransport({
        createPromptsByIds: sinon.stub().rejects(createErr),
      });
      const errorLog = sinon.stub();
      await expect(handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
        text: 'new', tagIds: ['bogus'], geoTargetId: 2840, languageCode: 'en',
      }, { ...log, error: errorLog })).to.be.rejectedWith(/unknown tag id: bogus/);
      expect(transport.deletePromptsByIds).to.have.been.calledOnce;
      expect(errorLog).to.have.been.calledOnceWith(
        sinon.match(/createOnePrompt failed AFTER a successful delete/),
      );
      expect(transport.publishProject).to.not.have.been.called;
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

  // Line 149: `Array.isArray(resp?.ids)&&resp.ids.length>0?String(resp.ids[0]):''` else —
  // transport.createTaggedPrompts resolves with {} (no ids) → semrushPromptId = ''.
  it('handleCreatePromptsSubworkspace: semrushPromptId is empty string when createTaggedPrompts returns no ids', async () => {
    const transport = makeTransport({
      createTaggedPrompts: sinon.stub().resolves({}),
    });
    const result = await handleCreatePromptsSubworkspace(transport, WS, {
      prompts: [{
        text: 'p', tags: ['x'], geoTargetId: 2840, languageCode: 'en',
      }],
    }, log);
    expect(result.created).to.have.length(1);
    expect(result.created[0].semrushPromptId).to.equal('');
  });

  // Lines 246-247: in handleUpdatePromptSubworkspace, `body.tags` is not an array
  // — the else `[]` fallback fires for the nextTags assignment.
  it('handleUpdatePromptSubworkspace: non-array body.tags coerces to []', async () => {
    const transport = makeTransport({
      createTaggedPrompts: sinon.stub().resolves({ ids: ['new-id'] }),
    });
    const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
      text: 'next',
      tags: null,
      geoTargetId: 2840,
      languageCode: 'en',
    }, log);
    expect(result.status).to.equal(200);
    expect(result.body.tags).to.deep.equal(['intent:Informational']);
  });

  // Line 275: `Array.isArray(resp?.ids)&&resp.ids.length>0?String(resp.ids[0]):''` else
  // on the update path — createTaggedPrompts returns {} so newSemrushPromptId = ''.
  it('handleUpdatePromptSubworkspace: empty semrushPromptId when createTaggedPrompts returns no ids', async () => {
    const transport = makeTransport({
      createTaggedPrompts: sinon.stub().resolves({}),
    });
    const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
      text: 'next',
      tags: ['t'],
      geoTargetId: 2840,
      languageCode: 'en',
    }, log);
    expect(result.status).to.equal(200);
    expect(result.body.semrushPromptId).to.equal('');
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

  // Line 246 inner falsy branch: body.tags IS an array but contains a falsy element
  // (null or empty string). The `String(t || \'\').trim()` coerces it to \'\' which
  // filter(Boolean) then drops. This is distinct from the else branch (non-array tags).
  it('handleUpdatePromptSubworkspace: falsy tag elements in body.tags are coerced and filtered', async () => {
    const transport = makeTransport({
      createTaggedPrompts: sinon.stub().resolves({ ids: ['new-id'] }),
    });
    const result = await handleUpdatePromptSubworkspace(transport, WS, 'old-id', {
      text: 'next',
      tags: ['keep', null, ''],
      geoTargetId: 2840,
      languageCode: 'en',
    }, log);
    expect(result.status).to.equal(200);
    expect(result.body.tags).to.deep.equal(['keep', 'intent:Informational']);
  });
});
