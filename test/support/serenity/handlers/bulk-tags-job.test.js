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
import { createHash } from 'node:crypto';
import sinon from 'sinon';
import {
  acceptBulkTags,
  applyBulkTagOperation,
  bulkTagsHandler,
  matchesBulkTagFacets,
  pageBulkFailures,
  parseBulkTagsBody,
} from '../../../../src/support/serenity/handlers/bulk-tags-job.js';

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

function workerTransport(prompts, update = sinon.stub().resolves()) {
  const roots = [{ id: 'tag-root', name: 'tag', children_count: 1 }];
  const children = [{
    id: 'family',
    name: 'Family',
    parent_id: 'tag-root',
    children_count: 0,
    path: [{ id: 'tag-root', name: 'tag' }],
  }];
  return {
    listProjectTags: sinon.stub().callsFake((_, __, options = {}) => Promise.resolve({
      items: options.parentId === 'tag-root' ? children : roots,
    })),
    listPromptsByTags: sinon.stub().resolves({ items: prompts }),
    updatePromptTagsByIds: update,
    publishProject: sinon.stub().resolves(),
  };
}

function workerJob(promptIds) {
  return {
    getMetadata: () => ({
      workspaceId: 'ws',
      projectId: 'project',
      tagIds: ['family'],
      operation: 'assign',
      promptIds,
      matchedCount: promptIds.length,
    }),
  };
}

const snapshot = {
  byId: new Map([
    ['family', {
      id: 'family', rootName: 'tag', depth: 2, fullPath: [{ id: 'tag', name: 'tag' }, { id: 'family', name: 'Family' }],
    }],
    ['child', {
      id: 'child', rootName: 'tag', depth: 3, fullPath: [{ id: 'tag', name: 'tag' }, { id: 'family', name: 'Family' }, { id: 'child', name: 'Child' }],
    }],
    ['other', {
      id: 'other', rootName: 'tag', depth: 2, fullPath: [{ id: 'tag', name: 'tag' }, { id: 'other', name: 'Other' }],
    }],
  ]),
  items: [],
};
snapshot.items = [...snapshot.byId.values()];

describe('bulk tags job request and tree semantics', () => {
  it('validates the target slice, operation, mutation ids, and faceted filter mode', () => {
    expect(() => parseBulkTagsBody({})).to.throw(/geoTargetId and languageCode/);
    expect(() => parseBulkTagsBody({
      geoTargetId: 1,
      languageCode: 'en',
      operation: 'replace',
      tagIds: ['child'],
      filter: { tagFilterMode: 'faceted-v1' },
    })).to.throw(/operation must be assign or remove/);
    expect(() => parseBulkTagsBody({
      geoTargetId: 1,
      languageCode: 'en',
      operation: 'assign',
      tagIds: [],
      filter: { tagFilterMode: 'faceted-v1' },
    })).to.throw(/tagIds must be a non-empty array/);
    expect(parseBulkTagsBody({
      geoTargetId: 1,
      languageCode: 'en',
      operation: 'assign',
      tagIds: ['child'],
      filter: { tagFilterMode: 'faceted-v1', search: ' shoes ' },
    }).filter).to.deep.equal({ tagIds: [], tagFilterMode: 'faceted-v1', search: 'shoes' });
  });

  it('assigns a child with its parent and removes a parent subtree', () => {
    expect(applyBulkTagOperation([], 'assign', [snapshot.byId.get('child')], snapshot))
      .to.have.members(['child', 'family']);
    expect(applyBulkTagOperation(['family', 'child', 'other'], 'remove', [snapshot.byId.get('family')], snapshot))
      .to.have.members(['other']);
  });

  it('uses OR within each facet family and AND across families', () => {
    expect(matchesBulkTagFacets({ tags: [{ id: 'child' }, { id: 'other' }] }, [
      new Set(['child', 'missing']), new Set(['other']),
    ])).to.equal(true);
    expect(matchesBulkTagFacets({ tags: [{ id: 'child' }] }, [
      new Set(['child']), new Set(['other']),
    ])).to.equal(false);
  });
});

describe('bulk tags job result paging', () => {
  it('returns at most 100 failures and an opaque next cursor', () => {
    const result = pageBulkFailures({
      matchedCount: 101,
      processedCount: 101,
      updatedCount: 0,
      unchangedCount: 0,
      failureCount: 101,
      failures: Array.from({ length: 101 }, (_, index) => ({
        semrushPromptId: `prompt-${index}`,
        code: 'serenityUpstreamError',
        message: 'failed',
        retryable: true,
      })),
      publish: { state: 'SUCCEEDED', error: null },
    });

    expect(result.failuresPage.items).to.have.lengthOf(100);
    expect(result.failuresPage.nextCursor).to.be.a('string');
    expect(result).not.to.have.property('failures');
  });
});

describe('acceptBulkTags idempotency', () => {
  const body = {
    geoTargetId: 1,
    languageCode: 'en',
    operation: 'assign',
    tagIds: ['family'],
    filter: { tagFilterMode: 'faceted-v1' },
  };

  it('replays a matching unexpired key without traversing or dispatching', async () => {
    const hash = requestHash(body);
    const existing = {
      getId: () => '11111111-1111-4111-8111-111111111111',
      getStatus: () => 'IN_PROGRESS',
      getMetadata: () => ({
        requestHash: hash, idempotencyExpiresAt: Date.now() + 60_000, matchedCount: 4,
      }),
    };
    const findById = sinon.stub().resolves(existing);
    const replay = await acceptBulkTags({
      context: { dataAccess: { AsyncJob: { findById } } },
      transport: { listProjectTags: sinon.stub() },
      brandId: 'brand',
      orgId: 'org',
      workspaceId: 'ws',
      projectId: 'project',
      body,
      callerId: 'caller',
      idempotencyKey: 'same-key',
      log: {},
    });
    expect(replay).to.deep.equal({
      status: 200,
      body: {
        jobId: existing.getId(),
        jobType: 'bulkTags',
        status: 'IN_PROGRESS',
        matchedCount: 4,
        replayed: true,
      },
    });
    expect(findById).to.have.been.calledOnce;
  });

  it('rejects a reused key whose request fingerprint differs', async () => {
    const existing = {
      getMetadata: () => ({
        requestHash: 'different',
        idempotencyExpiresAt: Date.now() + 60_000,
      }),
    };
    await expect(acceptBulkTags({
      context: { dataAccess: { AsyncJob: { findById: sinon.stub().resolves(existing) } } },
      transport: {},
      brandId: 'brand',
      orgId: 'org',
      workspaceId: 'ws',
      projectId: 'project',
      body,
      callerId: 'caller',
      idempotencyKey: 'same-key',
      log: {},
    })).to.be.rejected.then((error) => expect(error.code).to.equal('idempotencyConflict'));
  });
});

describe('bulkTagsHandler worker accounting', () => {
  it('publishes once and reports successful updates', async () => {
    const transport = workerTransport([{ id: 'one', tags: [] }]);
    const result = await bulkTagsHandler({ env: {}, log: {} }, workerJob(['one']), 'token', transport);
    expect(result).to.deep.include({
      matchedCount: 1, processedCount: 1, updatedCount: 1, unchangedCount: 0, failureCount: 0,
    });
    expect(transport.updatePromptTagsByIds).to.have.been.calledOnce;
    expect(transport.publishProject).to.have.been.calledOnceWith('ws', 'project');
    expect(result.publish).to.deep.equal({ state: 'SUCCEEDED', error: null });
  });

  it('continues after an individual prompt update fails', async () => {
    const update = sinon.stub()
      .onFirstCall().rejects(Object.assign(new Error('upstream'), { status: 500 }))
      .onSecondCall()
      .resolves();
    const transport = workerTransport([{ id: 'one', tags: [] }, { id: 'two', tags: [] }], update);
    const result = await bulkTagsHandler({ env: {}, log: {} }, workerJob(['one', 'two', 'gone']), 'token', transport);
    expect(result).to.deep.include({
      processedCount: 3, updatedCount: 1, unchangedCount: 0, failureCount: 2,
    });
    expect(result.failures.map((failure) => failure.semrushPromptId)).to.deep.equal(['one', 'gone']);
    expect(transport.updatePromptTagsByIds).to.have.been.calledTwice;
  });

  it('accounts for an unchanged assignment without publishing', async () => {
    const transport = workerTransport([{ id: 'one', tags: [{ id: 'family' }] }]);
    const result = await bulkTagsHandler({ env: {}, log: {} }, workerJob(['one']), 'token', transport);
    expect(result).to.deep.include({ updatedCount: 0, unchangedCount: 1, failureCount: 0 });
    expect(transport.updatePromptTagsByIds).not.to.have.been.called;
    expect(transport.publishProject).not.to.have.been.called;
  });
});
