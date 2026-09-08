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
import { SerenityTransportError } from '../../../../src/support/serenity/rest-transport.js';
import { rootNameOfDimension } from '../../../../src/support/serenity/prompt-tags.js';

const SERVER_OWNED_DIMENSIONS = ['intent', 'type', 'source', 'origin'];

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

function workerTransport(prompts, update = sinon.stub().resolves(), tree = {}) {
  const roots = tree.roots ?? [{ id: 'tag-root', name: 'tag', children_count: 1 }];
  const childParentId = roots[0]?.id;
  const children = tree.children ?? [{
    id: 'family',
    name: 'Family',
    parent_id: 'tag-root',
    children_count: 0,
    path: [{ id: 'tag-root', name: 'tag' }],
  }];
  return {
    listProjectTags: sinon.stub().callsFake((_, __, options = {}) => Promise.resolve({
      items: options.parentId === childParentId ? children : roots,
    })),
    listPromptsByTags: sinon.stub().resolves({ items: prompts }),
    updatePromptTagsByIds: update,
    publishProject: sinon.stub().resolves(),
  };
}

function serverOwnedTransport(dimension, prompts = []) {
  const rootId = `${dimension}-root`;
  const valueId = `${dimension}-value`;
  const rootName = rootNameOfDimension(dimension);
  return workerTransport(prompts, sinon.stub().resolves(), {
    roots: [{ id: rootId, name: rootName, children_count: 1 }],
    children: [{
      id: valueId,
      name: `canonical-${dimension}`,
      parent_id: rootId,
      children_count: 0,
      path: [{ id: rootId, name: rootName }],
    }],
  });
}

function workerJob(promptIds, overrides = {}) {
  return {
    getMetadata: () => ({
      workspaceId: 'ws',
      projectId: 'project',
      tagIds: ['family'],
      operation: 'assign',
      promptIds,
      matchedCount: promptIds.length,
      ...overrides,
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
      outcome: 'PARTIAL_FAILURE',
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
    expect(result.outcome).to.equal('PARTIAL_FAILURE');
    expect(result).not.to.have.property('failures');
  });

  it('clamps failureLimit to the public [1, 100] range', () => {
    const failures = Array.from({ length: 101 }, (_, index) => ({
      semrushPromptId: `prompt-${index}`,
    }));
    expect(pageBulkFailures({ failures }, undefined, 0).failuresPage.items)
      .to.have.lengthOf(1);
    expect(pageBulkFailures({ failures }, undefined, 500).failuresPage.items)
      .to.have.lengthOf(100);
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

describe('acceptBulkTags ownership guards', () => {
  for (const operation of ['assign', 'remove']) {
    it(`rejects ${operation} of a canonical server-owned descendant before enqueue`, async () => {
      for (const dimension of SERVER_OWNED_DIMENSIONS) {
        const transport = serverOwnedTransport(dimension);

        // eslint-disable-next-line no-await-in-loop
        await expect(acceptBulkTags({
          context: { dataAccess: { AsyncJob: {} } },
          transport,
          brandId: 'brand',
          orgId: 'org',
          workspaceId: 'ws',
          projectId: 'project',
          body: {
            geoTargetId: 1,
            languageCode: 'en',
            operation,
            tagIds: [`${dimension}-value`],
            filter: { tagFilterMode: 'faceted-v1' },
          },
          callerId: 'caller',
          log: {},
        })).to.be.rejected.then((error) => {
          expect(error.status).to.equal(400);
          expect(error.code).to.equal('invalidTagFilter');
          expect(error.message).to.include(`server-owned "${dimension}"`);
        });
        expect(transport.listPromptsByTags).not.to.have.been.called;
      }
    });
  }
});

describe('bulkTagsHandler worker accounting', () => {
  it('publishes once and reports successful updates', async () => {
    const transport = workerTransport([{ id: 'one', tags: [] }]);
    const result = await bulkTagsHandler({ env: {}, log: {} }, workerJob(['one']), 'token', transport);
    expect(result).to.deep.include({
      outcome: 'SUCCEEDED',
      matchedCount: 1,
      processedCount: 1,
      updatedCount: 1,
      unchangedCount: 0,
      failureCount: 0,
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
      outcome: 'PARTIAL_FAILURE',
      processedCount: 3,
      updatedCount: 1,
      unchangedCount: 0,
      failureCount: 2,
    });
    expect(result.failures.map((failure) => failure.semrushPromptId)).to.deep.equal(['one', 'gone']);
    expect(transport.updatePromptTagsByIds).to.have.been.calledTwice;
  });

  it('publishes an unchanged retry so a prior publish failure can be recovered', async () => {
    const transport = workerTransport([{ id: 'one', tags: [{ id: 'family' }] }]);
    const result = await bulkTagsHandler({ env: {}, log: {} }, workerJob(['one']), 'token', transport);
    expect(result).to.deep.include({
      outcome: 'SUCCEEDED', updatedCount: 0, unchangedCount: 1, failureCount: 0,
    });
    expect(transport.updatePromptTagsByIds).not.to.have.been.called;
    expect(transport.publishProject).to.have.been.calledOnceWith('ws', 'project');
  });

  it('fails the job with 409 incompatibleTagTaxonomy when a requested tag disappeared', async () => {
    const transport = workerTransport([{ id: 'one', tags: [] }]);

    await expect(bulkTagsHandler(
      { env: {}, log: {} },
      workerJob(['one'], { tagIds: ['missing'] }),
      'token',
      transport,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(409);
      expect(error.code).to.equal('incompatibleTagTaxonomy');
    });
    expect(transport.listPromptsByTags).not.to.have.been.called;
  });

  it('fails the job with 409 incompatibleTagTaxonomy when a requested tag became read-only', async () => {
    const transport = workerTransport(
      [{ id: 'one', tags: [] }],
      sinon.stub().resolves(),
      {
        children: [{
          id: 'family',
          name: 'Bad__Family',
          parent_id: 'tag-root',
          children_count: 0,
          path: [{ id: 'tag-root', name: 'tag' }],
        }],
      },
    );

    await expect(bulkTagsHandler(
      { env: {}, log: {} },
      workerJob(['one']),
      'token',
      transport,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(409);
      expect(error.code).to.equal('incompatibleTagTaxonomy');
    });
    expect(transport.listPromptsByTags).not.to.have.been.called;
  });

  for (const operation of ['assign', 'remove']) {
    it(`fails ${operation} revalidation when a target is a canonical server-owned descendant`, async () => {
      for (const dimension of SERVER_OWNED_DIMENSIONS) {
        const transport = serverOwnedTransport(dimension, [{ id: 'one', tags: [] }]);

        // eslint-disable-next-line no-await-in-loop
        await expect(bulkTagsHandler(
          { env: {}, log: {} },
          workerJob(['one'], { tagIds: [`${dimension}-value`], operation }),
          'token',
          transport,
        )).to.be.rejected.then((error) => {
          expect(error.status).to.equal(409);
          expect(error.code).to.equal('incompatibleTagTaxonomy');
        });
        expect(transport.listPromptsByTags).not.to.have.been.called;
      }
    });
  }

  it('records a per-item tagLimitExceeded failure without writing that prompt', async () => {
    const tags = Array.from({ length: 50 }, (_, index) => ({ id: `existing-${index}` }));
    const transport = workerTransport([{ id: 'one', tags }]);

    const result = await bulkTagsHandler(
      { env: {}, log: {} },
      workerJob(['one']),
      'token',
      transport,
    );

    expect(result).to.deep.include({
      outcome: 'PARTIAL_FAILURE',
      updatedCount: 0,
      unchangedCount: 0,
      failureCount: 1,
    });
    expect(result.failures).to.deep.equal([{
      semrushPromptId: 'one',
      code: 'tagLimitExceeded',
      message: 'The requested tag set exceeds the prompt tag limit',
      retryable: false,
    }]);
    expect(transport.updatePromptTagsByIds).not.to.have.been.called;
  });

  it('records promptNotFound when a frozen prompt is absent at worker time', async () => {
    const transport = workerTransport([]);

    const result = await bulkTagsHandler(
      { env: {}, log: {} },
      workerJob(['gone']),
      'token',
      transport,
    );

    expect(result.failures).to.deep.equal([{
      semrushPromptId: 'gone',
      code: 'promptNotFound',
      message: 'The prompt no longer exists',
      retryable: false,
    }]);
    expect(transport.publishProject).to.have.been.calledOnceWith('ws', 'project');
  });

  it('maps an upstream 404 during update to a non-retryable promptNotFound failure', async () => {
    const update = sinon.stub().rejects(new SerenityTransportError(404, 'gone'));
    const transport = workerTransport([{ id: 'one', tags: [] }], update);

    const result = await bulkTagsHandler(
      { env: {}, log: {} },
      workerJob(['one']),
      'token',
      transport,
    );

    expect(result.failures).to.deep.equal([{
      semrushPromptId: 'one',
      code: 'promptNotFound',
      message: 'The prompt no longer exists',
      retryable: false,
    }]);
  });

  it('marks a publish failure as a partial failure with a retryable public error', async () => {
    const transport = workerTransport([{ id: 'one', tags: [] }]);
    transport.publishProject.rejects(new Error('publish failed'));

    const result = await bulkTagsHandler(
      { env: {}, log: {} },
      workerJob(['one']),
      'token',
      transport,
    );

    expect(result.outcome).to.equal('PARTIAL_FAILURE');
    expect(result.publish).to.deep.equal({
      state: 'FAILED',
      error: {
        code: 'serenityUpstreamError',
        message: 'The project could not be published',
        retryable: true,
      },
    });
  });
});
