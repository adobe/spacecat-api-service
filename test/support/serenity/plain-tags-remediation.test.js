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

import { createHash } from 'node:crypto';
import {
  expect,
  use,
} from 'chai';
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  readTagTreeSnapshot,
} from '../../../src/support/serenity/tag-tree.js';
import {
  buildTagImpact,
  handleDeleteTag,
  handleTagImpact,
  handleUpdateTag,
} from '../../../src/support/serenity/handlers/tags.js';
import {
  listAllProjectPrompts,
  listFacetedPrompts,
} from '../../../src/support/serenity/handlers/prompts.js';
import {
  cacheTagTreeSnapshot,
  clearTagCache,
  deleteCachedTagTreeSnapshotIfSame,
  getCachedTagTreeSnapshot,
  invalidateTagCacheForProject,
  listProjectTagTree,
} from '../../../src/support/serenity/handlers/markets.js';

use(chaiAsPromised);
use(sinonChai);

const WS = 'workspace-1';
const PROJECT = 'project-1';
const BRAND = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ROTATED_PROMISE_TOKEN = {
  promise_token: 'rotated-bulk-tags-token',
  expires_in: 14399,
  token_type: 'bearer',
};
const SEMRUSH_PROMISE_PAIR = 'SEMRUSH';

function fakeLog() {
  return {
    debug: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
  };
}

function pagedTreeStub(levels) {
  return sinon.stub().callsFake((_workspaceId, _projectId, options = {}) => {
    const entries = levels[options.parentId ?? ''] ?? [];
    const page = options.page ?? 1;
    const limit = options.limit ?? 100;
    const start = (page - 1) * limit;
    return Promise.resolve({
      page,
      total: entries.length,
      items: entries.slice(start, start + limit),
    });
  });
}

function tagNode(id, name, parentId, path, childrenCount = 0) {
  return {
    id,
    name,
    parent_id: parentId,
    children_count: childrenCount,
    prompts_count: 0,
    path,
  };
}

function requestHash(body) {
  return createHash('sha256').update(JSON.stringify({
    operation: body.operation,
    tagIds: [...new Set(body.tagIds)].sort(),
    filter: {
      search: body.filter.search ?? null,
      tagIds: [...new Set(body.filter.tagIds)].sort(),
      tagFilterMode: body.filter.tagFilterMode,
    },
  })).digest('base64url');
}

function bulkBody() {
  return {
    geoTargetId: 2840,
    languageCode: 'en',
    operation: 'assign',
    tagIds: ['family'],
    filter: {
      tagIds: ['family'],
      tagFilterMode: 'faceted-v1',
    },
  };
}

function bulkTransport() {
  const levels = {
    '': [tagNode('tag-root', 'tag', null, null, 1)],
    'tag-root': [
      tagNode('family', 'Family', 'tag-root', [{ id: 'tag-root', name: 'tag' }]),
    ],
  };
  return {
    listProjectTags: pagedTreeStub(levels),
    listPromptsByTags: sinon.stub().resolves({
      items: [{ id: 'prompt-1', tags: [{ id: 'family' }] }],
    }),
  };
}

async function loadBulkModule(createAndEnqueueJob) {
  return esmock('../../../src/support/serenity/handlers/bulk-tags-job.js', {
    '../../../src/support/serenity/async-job-runner.js': {
      createAndEnqueueJob,
    },
  });
}

function impactFixture() {
  const rootPath = [{ id: 'tag-root', name: 'tag' }];
  const familyPath = [...rootPath, { id: 'family', name: 'Family' }];
  const levels = {
    '': [tagNode('tag-root', 'tag', null, null, 1)],
    'tag-root': [tagNode('family', 'Family', 'tag-root', rootPath, 1)],
    family: [tagNode('leaf', 'Leaf', 'family', familyPath)],
  };
  const listProjectTags = pagedTreeStub(levels);
  const transport = {
    listProjectTags,
    listPromptsByTags: sinon.stub().resolves({
      items: [
        { id: 'prompt-parent', tags: [{ id: 'family' }] },
        { id: 'prompt-child', tags: [{ id: 'leaf' }] },
        { id: 'prompt-both', tags: [{ id: 'family' }, { id: 'leaf' }] },
        { id: 'prompt-other', tags: [{ id: 'other' }] },
      ],
    }),
    updateProjectTag: sinon.stub().callsFake((_ws, _project, id, body) => {
      const current = levels['tag-root'].find((item) => item.id === id);
      current.name = body.name;
      return Promise.resolve({ id, name: body.name, parent_id: body.parentId });
    }),
    deleteProjectTags: sinon.stub().resolves(),
    publishProject: sinon.stub().resolves(),
  };
  return { levels, transport };
}

describe('remaining plain-tags regression coverage', () => {
  afterEach(async () => {
    clearTagCache();
    sinon.restore();
    await esmock.purge();
  });

  describe('acceptBulkTags concurrency and snapshot reuse', () => {
    it('loads taxonomy once and enqueues without scanning the prompt corpus', async () => {
      const job = {
        getId: () => 'job-1',
        getStatus: () => 'IN_PROGRESS',
      };
      const createAndEnqueueJob = sinon.stub().resolves(job);
      const { acceptBulkTags } = await loadBulkModule(createAndEnqueueJob);
      const transport = bulkTransport();

      const result = await acceptBulkTags({
        context: { dataAccess: { AsyncJob: {} } },
        transport,
        brandId: BRAND,
        orgId: 'org-1',
        workspaceId: WS,
        projectId: PROJECT,
        body: bulkBody(),
        callerId: 'caller',
        log: fakeLog(),
        promiseToken: ROTATED_PROMISE_TOKEN,
        promisePair: SEMRUSH_PROMISE_PAIR,
      });

      expect(result).to.deep.equal({
        status: 202,
        body: {
          jobId: 'job-1',
          jobType: 'bulkTags',
          status: 'IN_PROGRESS',
          replayed: false,
        },
      });
      expect(transport.listProjectTags).to.have.callCount(2);
      expect(transport.listProjectTags.getCalls().map((call) => call.args[2].parentId))
        .to.deep.equal(['', 'tag-root']);
      expect(transport.listPromptsByTags).not.to.have.been.called;
      expect(createAndEnqueueJob).to.have.been.calledOnce;
      expect(createAndEnqueueJob.firstCall.args[1]).to.include({
        promiseToken: ROTATED_PROMISE_TOKEN,
        promisePair: SEMRUSH_PROMISE_PAIR,
      });
      expect(createAndEnqueueJob.firstCall.args[1].metadata).to.deep.include({
        normalizedFilter: {
          groups: [['family']],
          candidateIds: ['family'],
        },
      });
      expect(createAndEnqueueJob.firstCall.args[1].metadata).not.to.have.property('promptIds');
      expect(createAndEnqueueJob.firstCall.args[1].metadata).not.to.have.property('matchedCount');
    });

    it('does not synchronously preflight an over-limit worker-time prompt', async () => {
      const createAndEnqueueJob = sinon.stub().resolves({
        getId: () => 'job-2',
        getStatus: () => 'IN_PROGRESS',
      });
      const { acceptBulkTags } = await loadBulkModule(createAndEnqueueJob);
      const transport = bulkTransport();
      transport.listPromptsByTags.resolves({
        items: [{
          id: 'prompt-1',
          tags: Array.from({ length: 50 }, (_, index) => ({ id: `existing-${index}` })),
        }],
      });
      const body = bulkBody();
      body.filter.tagIds = [];

      const result = await acceptBulkTags({
        context: { dataAccess: { AsyncJob: {} } },
        transport,
        brandId: BRAND,
        orgId: 'org-1',
        workspaceId: WS,
        projectId: PROJECT,
        body,
        callerId: 'caller',
        log: fakeLog(),
        promiseToken: ROTATED_PROMISE_TOKEN,
        promisePair: SEMRUSH_PROMISE_PAIR,
      });

      expect(result.status).to.equal(202);
      expect(transport.listPromptsByTags).not.to.have.been.called;
      expect(createAndEnqueueJob).to.have.been.calledOnce;
    });

    it('loads and replays the winning job after a concurrent create conflict without dispatching twice', async () => {
      const body = bulkBody();
      const hash = requestHash(body);
      const winner = {
        getId: () => 'winner-job',
        getStatus: () => 'IN_PROGRESS',
        getMetadata: () => ({
          requestHash: hash,
          idempotencyExpiresAt: Date.now() + 60_000,
          matchedCount: 1,
        }),
      };
      const create = sinon.stub().rejects(new Error('duplicate job id'));
      const sendMessage = sinon.stub().resolves();
      const createAndEnqueueJob = sinon.stub().callsFake(async (context, params) => {
        const job = await context.dataAccess.AsyncJob.create({
          id: params.jobId,
          metadata: params.metadata,
        });
        await context.sqs.sendMessage('queue', { jobId: job.getId() });
        return job;
      });
      const { acceptBulkTags } = await loadBulkModule(createAndEnqueueJob);
      const findById = sinon.stub();
      findById.onFirstCall().resolves(null);
      findById.onSecondCall().resolves(winner);

      const result = await acceptBulkTags({
        context: {
          dataAccess: { AsyncJob: { create, findById } },
          sqs: { sendMessage },
        },
        transport: bulkTransport(),
        brandId: BRAND,
        orgId: 'org-1',
        workspaceId: WS,
        projectId: PROJECT,
        body,
        callerId: 'caller',
        idempotencyKey: 'race-key',
        log: fakeLog(),
        promiseToken: ROTATED_PROMISE_TOKEN,
        promisePair: SEMRUSH_PROMISE_PAIR,
      });

      expect(result).to.deep.equal({
        status: 200,
        body: {
          jobId: 'winner-job',
          jobType: 'bulkTags',
          status: 'IN_PROGRESS',
          replayed: true,
        },
      });
      expect(findById).to.have.been.calledTwice;
      expect(create).to.have.been.calledOnce;
      expect(sendMessage).not.to.have.been.called;
    });

    it('returns idempotencyConflict when the concurrent winner has another fingerprint', async () => {
      const create = sinon.stub().rejects(new Error('duplicate job id'));
      const sendMessage = sinon.stub().resolves();
      const createAndEnqueueJob = sinon.stub().callsFake(async (context, params) => {
        const job = await context.dataAccess.AsyncJob.create({
          id: params.jobId,
          metadata: params.metadata,
        });
        await context.sqs.sendMessage('queue', { jobId: job.getId() });
        return job;
      });
      const { acceptBulkTags } = await loadBulkModule(createAndEnqueueJob);
      const findById = sinon.stub();
      findById.onFirstCall().resolves(null);
      findById.onSecondCall().resolves({
        getMetadata: () => ({ requestHash: 'another-fingerprint' }),
      });

      await expect(acceptBulkTags({
        context: {
          dataAccess: { AsyncJob: { create, findById } },
          sqs: { sendMessage },
        },
        transport: bulkTransport(),
        brandId: BRAND,
        orgId: 'org-1',
        workspaceId: WS,
        projectId: PROJECT,
        body: bulkBody(),
        callerId: 'caller',
        idempotencyKey: 'race-key',
        log: fakeLog(),
        promiseToken: ROTATED_PROMISE_TOKEN,
        promisePair: SEMRUSH_PROMISE_PAIR,
      })).to.be.rejected.then((error) => {
        expect(error.status).to.equal(409);
        expect(error.code).to.equal('idempotencyConflict');
      });
      expect(create).to.have.been.calledOnce;
      expect(sendMessage).not.to.have.been.called;
    });
  });

  describe('readTagTreeSnapshot completeness and compatibility', () => {
    it('reuses one short-lived project snapshot', async () => {
      const listProjectTags = pagedTreeStub({
        '': [tagNode('tag-root', 'tag', null, null, 1)],
        'tag-root': [tagNode(
          'family',
          'Family',
          'tag-root',
          [{ id: 'tag-root', name: 'tag' }],
        )],
      });
      const transport = { listProjectTags };

      const first = await readTagTreeSnapshot(transport, WS, PROJECT, fakeLog());
      const second = await readTagTreeSnapshot(transport, WS, PROJECT, fakeLog());

      expect(second).to.equal(first);
      expect(listProjectTags).to.have.callCount(2);
    });

    it('invalidates a cached project snapshot through the shared tag-cache hook', async () => {
      const listProjectTags = pagedTreeStub({
        '': [tagNode('tag-root', 'tag', null, null)],
      });
      const transport = { listProjectTags };

      await readTagTreeSnapshot(transport, WS, PROJECT, fakeLog());
      invalidateTagCacheForProject(WS, PROJECT);
      await readTagTreeSnapshot(transport, WS, PROJECT, fakeLog());

      expect(listProjectTags).to.have.callCount(2);
    });

    it('force-refreshes and replaces a cached project snapshot', async () => {
      let rootName = 'tag';
      const listProjectTags = sinon.stub().callsFake(() => Promise.resolve({
        page: 1,
        total: 1,
        items: [tagNode('tag-root', rootName, null, null)],
      }));
      const transport = { listProjectTags };

      const cached = await readTagTreeSnapshot(transport, WS, PROJECT, fakeLog());
      rootName = 'category';
      const refreshed = await readTagTreeSnapshot(
        transport,
        WS,
        PROJECT,
        fakeLog(),
        { forceRefresh: true },
      );
      const reused = await readTagTreeSnapshot(transport, WS, PROJECT, fakeLog());

      expect(cached.items[0].name).to.equal('tag');
      expect(refreshed.items[0].name).to.equal('category');
      expect(reused).to.equal(refreshed);
      expect(listProjectTags).to.have.been.calledTwice;
    });

    it('evicts a rejected snapshot load so a later call re-hits transport and succeeds', async () => {
      const listProjectTags = sinon.stub();
      listProjectTags.onFirstCall().rejects(new Error('transient tree read failure'));
      listProjectTags.onSecondCall().resolves({
        page: 1,
        total: 1,
        items: [tagNode('tag-root', 'tag', null, null)],
      });
      const transport = { listProjectTags };

      await expect(readTagTreeSnapshot(transport, WS, PROJECT, fakeLog()))
        .to.be.rejectedWith('transient tree read failure');
      const result = await readTagTreeSnapshot(transport, WS, PROJECT, fakeLog());

      expect(result.byId.get('tag-root').name).to.equal('tag');
      expect(listProjectTags).to.have.been.calledTwice;
    });

    it('does not evict a newer replacement when deleting an older cached value', () => {
      const older = Promise.resolve({ generation: 'old' });
      const newer = Promise.resolve({ generation: 'new' });
      cacheTagTreeSnapshot(WS, PROJECT, older);
      cacheTagTreeSnapshot(WS, PROJECT, newer);

      deleteCachedTagTreeSnapshotIfSame(WS, PROJECT, older);

      expect(getCachedTagTreeSnapshot(WS, PROJECT)).to.equal(newer);
    });

    it('refreshes a project snapshot after the short TTL expires', async () => {
      const clock = sinon.useFakeTimers({ now: Date.now() });
      const listProjectTags = pagedTreeStub({
        '': [tagNode('tag-root', 'tag', null, null)],
      });
      const transport = { listProjectTags };

      await readTagTreeSnapshot(transport, WS, PROJECT, fakeLog());
      clock.tick(5_001);
      await readTagTreeSnapshot(transport, WS, PROJECT, fakeLog());

      expect(listProjectTags).to.have.been.calledTwice;
    });

    it('exhausts every page of a level and includes the final page in the snapshot', async () => {
      const rootPath = [{ id: 'tag-root', name: 'tag' }];
      const children = Array.from({ length: 101 }, (_, index) => (
        tagNode(`tag-${index}`, `Tag ${index}`, 'tag-root', rootPath)
      ));
      const listProjectTags = pagedTreeStub({
        '': [tagNode('tag-root', 'tag', null, null, children.length)],
        'tag-root': children,
      });

      const result = await readTagTreeSnapshot({ listProjectTags }, WS, PROJECT, fakeLog());

      expect(result.items).to.have.lengthOf(102);
      expect(result.byId.get('tag-100').fullPath).to.deep.equal([
        { id: 'tag-root', name: 'tag' },
        { id: 'tag-100', name: 'Tag 100' },
      ]);
      const childPages = listProjectTags.getCalls()
        .filter((call) => call.args[2].parentId === 'tag-root')
        .map((call) => call.args[2].page);
      expect(childPages).to.deep.equal([1, 2]);
    });

    it('uses an exact total to finish on a full page without an unnecessary read', async () => {
      const roots = Array.from({ length: 100 }, (_, index) => (
        tagNode(`root-${index}`, `root-${index}`, null, null)
      ));
      const listProjectTags = pagedTreeStub({ '': roots });

      const result = await readTagTreeSnapshot({ listProjectTags }, WS, PROJECT, fakeLog());

      expect(result.items).to.have.lengthOf(100);
      expect(listProjectTags).to.have.been.calledOnce;
    });

    it('fails closed when a page is malformed', async () => {
      const listProjectTags = sinon.stub().resolves({ page: 1, total: 1, items: null });

      await expect(readTagTreeSnapshot({ listProjectTags }, WS, PROJECT, fakeLog()))
        .to.be.rejected.then((error) => {
          expect(error.status).to.equal(503);
          expect(error.code).to.equal('tagTreeReadIncomplete');
        });
    });

    it('listProjectTagTree fails closed on a malformed item', async () => {
      const listProjectTags = sinon.stub().resolves({
        page: 1,
        total: 1,
        items: [{ id: '', name: 'missing id' }],
      });
      const log = fakeLog();

      await expect(listProjectTagTree(
        { listProjectTags },
        WS,
        PROJECT,
        '',
        log,
      )).to.be.rejected.then((error) => {
        expect(error.status).to.equal(503);
        expect(error.code).to.equal('tagTreeReadIncomplete');
      });
      expect(log.warn).to.have.been.calledWith(
        'listProjectTagTree: incomplete tag level',
        sinon.match({ reason: 'malformedItem' }),
      );
    });

    it('fails closed when a short page contradicts the advertised total', async () => {
      const listProjectTags = sinon.stub().resolves({
        page: 1,
        total: 2,
        items: [tagNode('tag-root', 'tag', null, null)],
      });

      await expect(readTagTreeSnapshot({ listProjectTags }, WS, PROJECT, fakeLog()))
        .to.be.rejected.then((error) => {
          expect(error.status).to.equal(503);
          expect(error.code).to.equal('tagTreeReadIncomplete');
        });
    });

    it('listProjectTagTree fails closed when pagination repeats a tag id', async () => {
      const firstPage = Array.from({ length: 100 }, (_, index) => (
        tagNode(`root-${index}`, `Root ${index}`, null, null)
      ));
      const listProjectTags = sinon.stub().callsFake((_ws, _project, options) => Promise.resolve({
        page: options.page,
        total: 101,
        items: firstPage,
      }));
      const log = fakeLog();

      await expect(listProjectTagTree(
        { listProjectTags },
        WS,
        PROJECT,
        '',
        log,
      ))
        .to.be.rejected.then((error) => {
          expect(error.status).to.equal(503);
          expect(error.code).to.equal('tagTreeReadIncomplete');
        });
      expect(listProjectTags).to.have.been.calledTwice;
      expect(log.warn).to.have.been.calledWith(
        'listProjectTagTree: incomplete tag level',
        sinon.match({ reason: 'repeatedTagId' }),
      );
    });

    it('fails closed with tagTreeReadIncomplete when MAX_TREE_READS is exceeded', async () => {
      const roots = Array.from({ length: 200 }, (_, index) => (
        tagNode(`root-${index}`, `Root ${index}`, null, null, 1)
      ));
      const listProjectTags = pagedTreeStub({ '': roots });

      await expect(readTagTreeSnapshot({ listProjectTags }, WS, PROJECT, fakeLog()))
        .to.be.rejected.then((error) => {
          expect(error.status).to.equal(503);
          expect(error.code).to.equal('tagTreeReadIncomplete');
        });
      expect(listProjectTags).to.have.callCount(201);
    });

    it('classifies canonical nodes and ambiguous sibling paths from one complete snapshot', async () => {
      const rootPath = [{ id: 'tag-root', name: 'tag' }];
      const listProjectTags = pagedTreeStub({
        '': [tagNode('tag-root', 'tag', null, null, 5)],
        'tag-root': [
          tagNode('campaign-upper', 'Campaign', 'tag-root', rootPath),
          tagNode('campaign-lower', 'campaign', 'tag-root', rootPath),
          tagNode('canonical', 'Other', 'tag-root', rootPath),
          tagNode('separator', 'Bad__Name', 'tag-root', rootPath),
          tagNode('family', 'Family', 'tag-root', rootPath, 1),
        ],
        family: [
          tagNode(
            'leaf',
            'Leaf',
            'family',
            [...rootPath, { id: 'family', name: 'Family' }],
            1,
          ),
        ],
        leaf: [
          tagNode(
            'too-deep',
            'Too Deep',
            'leaf',
            [
              ...rootPath,
              { id: 'family', name: 'Family' },
              { id: 'leaf', name: 'Leaf' },
            ],
          ),
        ],
      });

      const result = await readTagTreeSnapshot({ listProjectTags }, WS, PROJECT, fakeLog());

      expect(result.byId.get('canonical').compatibility)
        .to.deep.equal({ state: 'canonical', reason: null });
      expect(result.byId.get('campaign-upper').compatibility)
        .to.deep.equal({ state: 'readOnly', reason: 'ambiguousPath' });
      expect(result.byId.get('campaign-lower').compatibility)
        .to.deep.equal({ state: 'readOnly', reason: 'ambiguousPath' });
      expect(result.byId.get('separator').compatibility)
        .to.deep.equal({ state: 'readOnly', reason: 'separatorInName' });
      expect(result.byId.get('too-deep').compatibility)
        .to.deep.equal({ state: 'readOnly', reason: 'unsupportedDepth' });
    });

    it('classifies a case-variant tag root and its descendants as read-only', async () => {
      const rootPath = [{ id: 'variant-root', name: 'Tag' }];
      const listProjectTags = pagedTreeStub({
        '': [tagNode('variant-root', 'Tag', null, null, 1)],
        'variant-root': [tagNode('child', 'Child', 'variant-root', rootPath)],
      });

      const result = await readTagTreeSnapshot({ listProjectTags }, WS, PROJECT, fakeLog());

      expect(result.byId.get('variant-root').compatibility)
        .to.deep.equal({ state: 'readOnly', reason: 'caseVariantRoot' });
      expect(result.byId.get('child').compatibility)
        .to.deep.equal({ state: 'readOnly', reason: 'caseVariantRoot' });
    });
  });

  describe('tag impact and stale delete protection', () => {
    it('buildTagImpact expands descendants and counts distinct affected prompts exactly', async () => {
      const { transport } = impactFixture();

      const result = await buildTagImpact(transport, WS, PROJECT, 'family', fakeLog());

      expect(result).to.include({
        tagId: 'family',
        name: 'Family',
        descendantCount: 1,
        affectedPromptCount: 3,
        complete: true,
      });
      expect(result.deletedIds).to.deep.equal(['family', 'leaf']);
      expect(result.revision).to.match(/^"[A-Za-z0-9_-]+"$/);
    });

    it('rejects dimension roots as tag-impact targets', async () => {
      const { transport } = impactFixture();

      await expect(buildTagImpact(transport, WS, PROJECT, 'tag-root', fakeLog()))
        .to.be.rejected.then((error) => {
          expect(error.status).to.equal(400);
          expect(error.message).to.match(/dimension root/);
        });
      expect(transport.listPromptsByTags).not.to.have.been.called;
    });

    it('rejects server-owned tags as tag-impact targets', async () => {
      const rootPath = [{ id: 'type-root', name: 'type' }];
      const transport = {
        listProjectTags: pagedTreeStub({
          '': [tagNode('type-root', 'type', null, null, 1)],
          'type-root': [tagNode('type-value', 'branded', 'type-root', rootPath)],
        }),
        listPromptsByTags: sinon.stub(),
      };

      await expect(buildTagImpact(transport, WS, PROJECT, 'type-value', fakeLog()))
        .to.be.rejected.then((error) => {
          expect(error.status).to.equal(400);
          expect(error.message).to.match(/server-owned "type"/);
        });
      expect(transport.listPromptsByTags).not.to.have.been.called;
    });

    it('rejects read-only tags as tag-impact targets', async () => {
      const rootPath = [{ id: 'tag-root', name: 'tag' }];
      const transport = {
        listProjectTags: pagedTreeStub({
          '': [tagNode('tag-root', 'tag', null, null, 1)],
          'tag-root': [tagNode('bad', 'Bad__Name', 'tag-root', rootPath)],
        }),
        listPromptsByTags: sinon.stub(),
      };

      await expect(buildTagImpact(transport, WS, PROJECT, 'bad', fakeLog()))
        .to.be.rejected.then((error) => {
          expect(error.status).to.equal(409);
          expect(error.code).to.equal('incompatibleTagTaxonomy');
        });
      expect(transport.listPromptsByTags).not.to.have.been.called;
    });

    it('handleTagImpact returns exact descendant and prompt-reference counts without internal ids', async () => {
      const { transport } = impactFixture();
      const dataAccess = {
        BrandSemrushProject: {
          findBySlice: sinon.stub().resolves({ getSemrushProjectId: () => PROJECT }),
        },
      };

      const result = await handleTagImpact(
        transport,
        dataAccess,
        BRAND,
        WS,
        'family',
        { geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );

      expect(result.status).to.equal(200);
      expect(result.body).to.include({
        tagId: 'family',
        name: 'Family',
        descendantCount: 1,
        affectedPromptCount: 3,
        complete: true,
      });
      expect(result.body).not.to.have.property('deletedIds');
    });

    it('returns 412 after a direct update invalidates If-Match and performs no stale delete mutation', async () => {
      const { transport } = impactFixture();
      const dataAccess = {
        BrandSemrushProject: {
          findBySlice: sinon.stub().resolves({ getSemrushProjectId: () => PROJECT }),
        },
      };
      const query = { geoTargetId: 2840, languageCode: 'en' };
      const before = await buildTagImpact(transport, WS, PROJECT, 'family', fakeLog());

      await handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WS,
        'family',
        { ...query, name: 'Renamed Family' },
        fakeLog(),
      );
      transport.updateProjectTag.resetHistory();
      transport.deleteProjectTags.resetHistory();
      transport.publishProject.resetHistory();

      await expect(handleDeleteTag(
        transport,
        dataAccess,
        BRAND,
        WS,
        'family',
        query,
        fakeLog(),
        before.revision,
      )).to.be.rejected.then((error) => {
        expect(error.status).to.equal(412);
        expect(error.code).to.equal('impactStale');
      });
      expect(transport.updateProjectTag).not.to.have.been.called;
      expect(transport.deleteProjectTags).not.to.have.been.called;
      expect(transport.publishProject).not.to.have.been.called;
    });
  });

  describe('listAllProjectPrompts observability and ceiling', () => {
    it('logs page progress and the completed prompt corpus size', async () => {
      const fullPage = Array.from({ length: 200 }, (_, index) => ({ id: `p-${index}` }));
      const listPromptsByTags = sinon.stub();
      listPromptsByTags.onFirstCall().resolves({ items: fullPage });
      listPromptsByTags.onSecondCall().resolves({ items: [{ id: 'p-200' }] });
      const log = fakeLog();

      const result = await listAllProjectPrompts(
        { listPromptsByTags },
        WS,
        PROJECT,
        { tagIds: ['family'] },
        log,
      );

      expect(result).to.have.lengthOf(201);
      expect(log.debug).to.have.callCount(2);
      expect(log.debug.secondCall).to.have.been.calledWith(
        'listAllProjectPrompts: faceted prompt page read',
        sinon.match({
          page: 2,
          pagePromptsRead: 1,
          upstreamPromptsScanned: 201,
        }),
      );
      expect(log.info).to.have.been.calledOnceWith(
        'listAllProjectPrompts: faceted prompt corpus read',
        sinon.match({
          pagesWalked: 2,
          pageSize: 200,
          upstreamPromptsScanned: 201,
        }),
      );
    });

    it('warns and fails closed when the 20,000-prompt ceiling is reached', async () => {
      const fullPage = Array.from({ length: 200 }, (_, index) => ({ id: `p-${index}` }));
      const listPromptsByTags = sinon.stub().resolves({ items: fullPage });
      const log = fakeLog();

      await expect(listAllProjectPrompts(
        { listPromptsByTags },
        WS,
        PROJECT,
        {},
        log,
      )).to.be.rejected.then((error) => {
        expect(error.status).to.equal(503);
        expect(error.code).to.equal('promptCorpusIncomplete');
      });
      expect(listPromptsByTags).to.have.callCount(100);
      expect(log.warn).to.have.been.calledOnceWith(
        'listAllProjectPrompts: faceted prompt ceiling reached',
        sinon.match({
          pagesWalked: 100,
          pageSize: 200,
          upstreamPromptsScanned: 20_000,
        }),
      );
      expect(log.info).not.to.have.been.called;
    });
  });

  describe('listFacetedPrompts pagination', () => {
    it('applies page-2 arithmetic after filtering the complete cohort', async () => {
      const rootPath = [{ id: 'tag-root', name: 'tag' }];
      const listProjectTags = pagedTreeStub({
        '': [tagNode('tag-root', 'tag', null, null, 1)],
        'tag-root': [tagNode('family', 'Family', 'tag-root', rootPath)],
      });
      const prompts = [
        { id: 'p-1', name: 'one', tags: [{ id: 'family', name: 'Family', path: rootPath }] },
        { id: 'p-x', name: 'other', tags: [{ id: 'other', name: 'Other', path: rootPath }] },
        { id: 'p-2', name: 'two', tags: [{ id: 'family', name: 'Family', path: rootPath }] },
        { id: 'p-y', name: 'another', tags: [] },
        { id: 'p-3', name: 'three', tags: [{ id: 'family', name: 'Family', path: rootPath }] },
      ];
      const listPromptsByTags = sinon.stub().resolves({ items: prompts });

      const result = await listFacetedPrompts(
        { listProjectTags, listPromptsByTags },
        WS,
        PROJECT,
        {
          geoTargetId: 2840,
          languageCode: 'en',
          page: 2,
          limit: 2,
          tagIds: ['family'],
        },
        fakeLog(),
      );

      expect(result).to.include({ total: 3, page: 2, limit: 2 });
      expect(result.items.map((item) => item.semrushPromptId)).to.deep.equal(['p-3']);
      expect(listPromptsByTags).to.have.been.calledOnceWith(
        WS,
        PROJECT,
        sinon.match({ tag_ids: ['family'], page: 1, limit: 200 }),
      );
    });
  });
});
