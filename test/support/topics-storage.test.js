/* eslint-disable header/header */
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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import {
  listTopics, createTopic, updateTopic, deleteTopic,
} from '../../src/support/topics-storage.js';

use(sinonChai);
use(chaiAsPromised);

function createChainableQuery(resolveWith = { data: [], error: null }) {
  const handler = {
    get(target, prop) {
      if (prop === 'then') {
        return (resolve) => resolve(resolveWith);
      }
      return sinon.stub().returns(new Proxy({}, handler));
    },
  };
  return new Proxy({}, handler);
}

describe('topics-storage', () => {
  const ORG_ID = '11111111-1111-4111-8111-111111111111';

  describe('listTopics', () => {
    it('returns empty array when postgrestClient is missing', async () => {
      expect(await listTopics({ organizationId: ORG_ID, postgrestClient: null })).to.deep.equal([]);
    });

    it('lists topics and maps to V2 shape', async () => {
      const dbRow = {
        id: 'uuid-1',
        topic_id: 'seo-best-practices',
        name: 'SEO Best Practices',
        description: 'All about SEO',
        status: 'active',
        brand_id: null,
        topic_categories: [{ category_id: 'cat-uuid-a' }, { category_id: 'cat-uuid-b' }],
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'admin@test.com',
        updated_at: '2026-02-01T00:00:00Z',
        updated_by: 'user@test.com',
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listTopics({ organizationId: ORG_ID, postgrestClient });
      expect(result).to.have.length(1);
      expect(result[0].id).to.equal('seo-best-practices');
      expect(result[0].uuid).to.equal('uuid-1');
      expect(result[0].name).to.equal('SEO Best Practices');
      expect(result[0].categoryUuids).to.deep.equal(['cat-uuid-a', 'cat-uuid-b']);
      expect(result[0].createdAt).to.equal('2026-01-01T00:00:00Z');
      expect(result[0].createdBy).to.equal('admin@test.com');
      expect(result[0].updatedAt).to.equal('2026-02-01T00:00:00Z');
      expect(result[0].updatedBy).to.equal('user@test.com');
    });

    it('returns empty categoryUuids when topic has no topic_categories', async () => {
      const dbRow = {
        id: 'uuid-2',
        topic_id: 'uncategorized',
        name: 'Uncategorized Topic',
        description: null,
        status: 'active',
        brand_id: null,
        topic_categories: [],
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'system',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listTopics({ organizationId: ORG_ID, postgrestClient });
      expect(result[0].categoryUuids).to.deep.equal([]);
    });

    it('returns empty categoryUuids when topic_categories is absent from row', async () => {
      const dbRow = {
        id: 'uuid-3',
        topic_id: 'legacy-topic',
        name: 'Legacy Topic',
        description: null,
        status: 'active',
        brand_id: null,
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'system',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listTopics({ organizationId: ORG_ID, postgrestClient });
      expect(result[0].categoryUuids).to.deep.equal([]);
    });

    it('drops soft-deleted categories from categoryUuids', async () => {
      const dbRow = {
        id: 'uuid-4',
        topic_id: 'mixed-status-topic',
        name: 'Mixed',
        description: null,
        status: 'active',
        brand_id: null,
        topic_categories: [
          { category_id: 'cat-active', categories: { status: 'active' } },
          { category_id: 'cat-deleted', categories: { status: 'deleted' } },
          { category_id: 'cat-pending', categories: { status: 'pending' } },
        ],
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'system',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listTopics({ organizationId: ORG_ID, postgrestClient });
      expect(result[0].categoryUuids).to.deep.equal(['cat-active', 'cat-pending']);
    });

    it('returns empty array and defaults status when data is null', async () => {
      const query = createChainableQuery({ data: null, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listTopics({ organizationId: ORG_ID, postgrestClient });
      expect(result).to.deep.equal([]);
    });

    it('defaults status to active when row status is falsy', async () => {
      const dbRow = {
        id: 'uuid-1',
        topic_id: 'no-status',
        name: 'No Status',
        description: null,
        status: null,
        brand_id: null,
        created_at: null,
        created_by: null,
        updated_at: '2026-01-01',
        updated_by: 'system',
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listTopics({ organizationId: ORG_ID, postgrestClient });
      expect(result[0].status).to.equal('active');
    });

    it('throws on database error', async () => {
      const dbError = { message: 'DB error' };
      const query = createChainableQuery({ data: null, error: dbError });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const err = await listTopics({ organizationId: ORG_ID, postgrestClient }).catch((e) => e);
      expect(err.message).to.include('Failed to list topics');
      expect(err.cause).to.equal(dbError);
    });
  });

  describe('createTopic', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(createTopic({
        organizationId: ORG_ID, topic: { name: 'Test' }, postgrestClient: null,
      })).to.be.rejectedWith('PostgREST client is required');
    });

    it('throws when topic name is missing', async () => {
      await expect(createTopic({
        organizationId: ORG_ID, topic: {}, postgrestClient: { from: () => { } },
      })).to.be.rejectedWith('Topic name is required');
    });

    it('creates a topic and returns mapped result', async () => {
      const dbRow = {
        id: 'uuid-new',
        topic_id: 'my-new-topic',
        name: 'My New Topic',
        description: 'A description',
        status: 'active',
        brand_id: 'brand-uuid',
        created_at: '2026-03-01T00:00:00Z',
        created_by: 'user@test.com',
        updated_at: '2026-03-01',
        updated_by: 'user@test.com',
      };

      const query = createChainableQuery({ data: dbRow, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await createTopic({
        organizationId: ORG_ID,
        topic: { name: 'My New Topic', description: 'A description', brandId: 'brand-uuid' },
        postgrestClient,
        updatedBy: 'user@test.com',
      });

      expect(result.id).to.equal('my-new-topic');
      expect(result.uuid).to.equal('uuid-new');
      expect(result.name).to.equal('My New Topic');
      expect(result.description).to.equal('A description');
      expect(result.brandId).to.equal('brand-uuid');
      expect(result.status).to.equal('active');
      expect(result.createdAt).to.equal('2026-03-01T00:00:00Z');
      expect(result.createdBy).to.equal('user@test.com');
    });

    it('upserts topic_categories when categoryId is provided and returns populated categoryUuids', async () => {
      // After the topic upsert + junction upsert, createTopic re-fetches the
      // topic with the topic_categories embed so the response shape matches
      // listTopics. We simulate that by populating topic_categories on the
      // shared mock row — both the upsert .single() and the refetch
      // .maybeSingle() resolve from the same proxy.
      const dbRow = {
        id: 'uuid-tc',
        topic_id: 'cat-linked-topic',
        name: 'Category Linked',
        description: null,
        status: 'active',
        brand_id: null,
        topic_categories: [
          { category_id: 'cat-uuid-123', categories: { status: 'active' } },
        ],
        created_at: '2026-04-01T00:00:00Z',
        created_by: 'system',
        updated_at: '2026-04-01',
        updated_by: 'system',
      };

      const topicsQuery = createChainableQuery({ data: dbRow, error: null });
      const tcQuery = createChainableQuery({ data: null, error: null });
      const fromStub = sinon.stub();
      fromStub.withArgs('topics').returns(topicsQuery);
      fromStub.withArgs('topic_categories').returns(tcQuery);
      const postgrestClient = { from: fromStub };

      const result = await createTopic({
        organizationId: ORG_ID,
        topic: { name: 'Category Linked', categoryId: 'cat-uuid-123' },
        postgrestClient,
      });

      expect(fromStub).to.have.been.calledWith('topic_categories');
      // Response is symmetric with GET /topics — POST callers see the
      // category they just linked.
      expect(result.categoryUuids).to.deep.equal(['cat-uuid-123']);
    });

    it('warns via log when topic_categories upsert fails', async () => {
      const dbRow = {
        id: 'uuid-warn',
        topic_id: 'warn-topic',
        name: 'Warn Topic',
        description: null,
        status: 'active',
        brand_id: null,
        created_at: '2026-04-01T00:00:00Z',
        created_by: 'system',
        updated_at: '2026-04-01',
        updated_by: 'system',
      };

      const topicsQuery = createChainableQuery({ data: dbRow, error: null });
      const tcQuery = createChainableQuery({ data: null, error: { message: 'FK violation' } });
      const fromStub = sinon.stub();
      fromStub.withArgs('topics').returns(topicsQuery);
      fromStub.withArgs('topic_categories').returns(tcQuery);
      const postgrestClient = { from: fromStub };
      const log = { warn: sinon.stub() };

      const result = await createTopic({
        organizationId: ORG_ID,
        topic: { name: 'Warn Topic', categoryId: 'bad-category-uuid' },
        postgrestClient,
        log,
      });

      // Topic creation still succeeds
      expect(result.id).to.equal('warn-topic');
      // Warning was emitted
      expect(log.warn).to.have.been.calledOnce;
      expect(log.warn.firstCall.args[0]).to.include('FK violation');
    });

    it('skips topic_categories when categoryId is not provided', async () => {
      const dbRow = {
        id: 'uuid-no-cat',
        topic_id: 'no-cat-topic',
        name: 'No Category',
        description: null,
        status: 'active',
        brand_id: null,
        created_at: '2026-04-01T00:00:00Z',
        created_by: 'system',
        updated_at: '2026-04-01',
        updated_by: 'system',
      };

      const query = createChainableQuery({ data: dbRow, error: null });
      const fromStub = sinon.stub().returns(query);
      const postgrestClient = { from: fromStub };

      await createTopic({
        organizationId: ORG_ID,
        topic: { name: 'No Category' },
        postgrestClient,
      });

      expect(fromStub).to.not.have.been.calledWith('topic_categories');
    });

    it('falls back to upsert payload (categoryUuids:[]) and warns when refetch errors', async () => {
      // The first from('topics') is the upsert+select+single (success).
      // The second from('topics') is the refetch with the embed — simulate
      // a transient PostgREST error so we exercise the WARN-and-fallback
      // branch rather than the happy-path return.
      const upsertedRow = {
        id: 'uuid-refetch-err',
        topic_id: 'refetch-err-topic',
        name: 'Refetch Err',
        description: null,
        status: 'active',
        brand_id: null,
        created_at: '2026-04-01T00:00:00Z',
        created_by: 'system',
        updated_at: '2026-04-01',
        updated_by: 'system',
      };
      const upsertQuery = createChainableQuery({ data: upsertedRow, error: null });
      const refetchQuery = createChainableQuery({
        data: null,
        error: { message: 'transient PostgREST error' },
      });
      const tcQuery = createChainableQuery({ data: null, error: null });

      let topicsCall = 0;
      const fromStub = sinon.stub().callsFake((table) => {
        if (table === 'topics') {
          topicsCall += 1;
          return topicsCall === 1 ? upsertQuery : refetchQuery;
        }
        if (table === 'topic_categories') {
          return tcQuery;
        }
        return null;
      });
      const postgrestClient = { from: fromStub };
      const log = { warn: sinon.stub() };

      const result = await createTopic({
        organizationId: ORG_ID,
        topic: { name: 'Refetch Err', categoryId: 'cat-id' },
        postgrestClient,
        log,
      });

      // Topic still resolves to the upsert payload — refetch failure is
      // intentionally non-fatal so the create still succeeds.
      expect(result.id).to.equal('refetch-err-topic');
      expect(result.categoryUuids).to.deep.equal([]);
      // Refetch error logged at warn so operators can correlate triage.
      expect(log.warn).to.have.been.calledWith(
        sinon.match(/Failed to refetch topic .* with category embed/),
      );
    });

    it('falls back to upsert payload when refetch returns no row', async () => {
      // Race window: the topic was upserted but the refetch sees data: null
      // (e.g. the row was hard-deleted between writes, or RLS hides it).
      // Fall through to the upsert payload — same defensive guard as the
      // refetch-error path, exercised separately so both branches of the
      // post-refetch if/else if are covered.
      const upsertedRow = {
        id: 'uuid-refetch-empty',
        topic_id: 'refetch-empty-topic',
        name: 'Refetch Empty',
        description: null,
        status: 'active',
        brand_id: null,
        created_at: '2026-04-01T00:00:00Z',
        created_by: 'system',
        updated_at: '2026-04-01',
        updated_by: 'system',
      };
      const upsertQuery = createChainableQuery({ data: upsertedRow, error: null });
      const refetchQuery = createChainableQuery({ data: null, error: null });

      let topicsCall = 0;
      const fromStub = sinon.stub().callsFake((table) => {
        if (table === 'topics') {
          topicsCall += 1;
          return topicsCall === 1 ? upsertQuery : refetchQuery;
        }
        return null;
      });
      const postgrestClient = { from: fromStub };

      const result = await createTopic({
        organizationId: ORG_ID,
        topic: { name: 'Refetch Empty' },
        postgrestClient,
      });

      expect(result.id).to.equal('refetch-empty-topic');
      expect(result.categoryUuids).to.deep.equal([]);
    });

    it('throws on database error during create', async () => {
      const dbError = { message: 'unique violation' };
      const query = createChainableQuery({ data: null, error: dbError });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const err = await createTopic({
        organizationId: ORG_ID,
        topic: { name: 'Duplicate Topic' },
        postgrestClient,
      }).catch((e) => e);
      expect(err.message).to.include('Failed to create topic');
      expect(err.cause).to.equal(dbError);
    });

    it('throws a 409-typed error echoing the constraint name on a 23505 unique violation', async () => {
      const raw = {
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_topic_per_org"',
        details: '',
        hint: '',
      };
      const postgrestClient = {
        from: sinon.stub().returns(createChainableQuery({ data: null, error: raw })),
      };

      const err = await createTopic({
        organizationId: ORG_ID,
        topic: { name: 'DupTopic' },
        postgrestClient,
        updatedBy: 'test',
      }).catch((e) => e);

      expect(err).to.be.instanceOf(Error);
      expect(err.status).to.equal(409);
      expect(err.message).to.include('uq_topic_per_org');
      // Original PostgREST error preserved as `cause` so operators reading
      // the WARN-level conflict log can still reach the raw DB payload
      // during triage. LLMO-4370 #14.
      expect(err.cause).to.equal(raw);
    });

    it('still surfaces 409 with a generic message when the 23505 error lacks a constraint clause', async () => {
      const postgrestClient = {
        from: sinon.stub().returns(createChainableQuery({
          data: null,
          error: { code: '23505', message: '' },
        })),
      };

      const err = await createTopic({
        organizationId: ORG_ID,
        topic: { name: 'Whatever' },
        postgrestClient,
      }).catch((e) => e);

      expect(err.status).to.equal(409);
      expect(err.message).to.match(/unique constraint/i);
    });
  });

  describe('updateTopic', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(updateTopic({
        organizationId: ORG_ID, topicId: 'test', updates: {}, postgrestClient: null,
      })).to.be.rejectedWith('PostgREST client is required');
    });

    it('updates a topic and returns the mapped result', async () => {
      const dbRow = {
        id: 'uuid-upd',
        topic_id: 'test',
        name: 'Updated',
        description: null,
        status: 'active',
        brand_id: null,
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'system',
        updated_at: '2026-03-15',
        updated_by: 'editor@test.com',
      };

      const query = createChainableQuery({ data: dbRow, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await updateTopic({
        organizationId: ORG_ID,
        topicId: 'test',
        updates: { name: 'Updated', status: 'active' },
        postgrestClient,
        updatedBy: 'editor@test.com',
      });

      expect(result).to.not.be.null;
      expect(result.id).to.equal('test');
      expect(result.uuid).to.equal('uuid-upd');
      expect(result.name).to.equal('Updated');
      expect(result.status).to.equal('active');
    });

    it('updates a topic with description and brandId fields', async () => {
      const dbRow = {
        id: 'uuid-upd2',
        topic_id: 'test2',
        name: 'Test',
        description: 'New desc',
        status: 'active',
        brand_id: 'brand-uuid',
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'system',
        updated_at: '2026-03-15',
        updated_by: 'editor@test.com',
      };

      const query = createChainableQuery({ data: dbRow, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await updateTopic({
        organizationId: ORG_ID,
        topicId: 'test2',
        updates: { description: 'New desc', brandId: 'brand-uuid' },
        postgrestClient,
        updatedBy: 'editor@test.com',
      });

      expect(result).to.not.be.null;
      expect(result.description).to.equal('New desc');
      expect(result.brandId).to.equal('brand-uuid');
    });

    it('returns null when topic is not found', async () => {
      const query = createChainableQuery({ data: null, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await updateTopic({
        organizationId: ORG_ID,
        topicId: 'nonexistent',
        updates: { name: 'Ghost' },
        postgrestClient,
      });

      expect(result).to.be.null;
    });

    it('throws on database error during update', async () => {
      const dbError = { message: 'connection timeout' };
      const query = createChainableQuery({ data: null, error: dbError });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const err = await updateTopic({
        organizationId: ORG_ID,
        topicId: 'test',
        updates: { name: 'Will Fail' },
        postgrestClient,
      }).catch((e) => e);
      expect(err.message).to.include('Failed to update topic');
      expect(err.cause).to.equal(dbError);
    });
  });

  describe('deleteTopic', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(deleteTopic({
        organizationId: ORG_ID, topicId: 'test', postgrestClient: null,
      })).to.be.rejectedWith('PostgREST client is required');
    });

    it('returns true when topic is found and soft-deleted', async () => {
      const query = createChainableQuery({ data: { id: 'uuid-del' }, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await deleteTopic({
        organizationId: ORG_ID,
        topicId: 'test',
        postgrestClient,
        updatedBy: 'admin@test.com',
      });

      expect(result).to.be.true;
    });

    it('returns false when topic is not found', async () => {
      const query = createChainableQuery({ data: null, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await deleteTopic({
        organizationId: ORG_ID,
        topicId: 'nonexistent',
        postgrestClient,
      });

      expect(result).to.be.false;
    });

    it('throws on database error during delete', async () => {
      const dbError = { message: 'permission denied' };
      const query = createChainableQuery({ data: null, error: dbError });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const err = await deleteTopic({
        organizationId: ORG_ID,
        topicId: 'test',
        postgrestClient,
      }).catch((e) => e);
      expect(err.message).to.include('Failed to delete topic');
      expect(err.cause).to.equal(dbError);
    });
  });

  describe('listTopics - filter variants', () => {
    const dbRow = {
      id: 'uuid-f',
      topic_id: 'filtered-topic',
      name: 'Filtered Topic',
      description: null,
      status: 'active',
      brand_id: 'brand-abc',
      updated_at: '2026-02-01',
      updated_by: 'system',
    };

    it('filters by status when provided', async () => {
      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listTopics({
        organizationId: ORG_ID,
        postgrestClient,
        status: 'active',
      });

      expect(result).to.have.length(1);
      expect(result[0].status).to.equal('active');
    });

    it('filters by brandId when provided', async () => {
      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listTopics({
        organizationId: ORG_ID,
        postgrestClient,
        brandId: 'brand-abc',
      });

      expect(result).to.have.length(1);
      expect(result[0].brandId).to.equal('brand-abc');
    });
  });
});
