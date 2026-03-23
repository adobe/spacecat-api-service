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
        updated_at: '2026-01-01',
        updated_by: 'user@test.com',
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listTopics({ organizationId: ORG_ID, postgrestClient });
      expect(result).to.have.length(1);
      expect(result[0].id).to.equal('seo-best-practices');
      expect(result[0].uuid).to.equal('uuid-1');
      expect(result[0].name).to.equal('SEO Best Practices');
    });

    it('throws on database error', async () => {
      const query = createChainableQuery({ data: null, error: { message: 'DB error' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(listTopics({ organizationId: ORG_ID, postgrestClient }))
        .to.be.rejectedWith('Failed to list topics');
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
    });

    it('throws on database error during create', async () => {
      const query = createChainableQuery({ data: null, error: { message: 'unique violation' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(createTopic({
        organizationId: ORG_ID,
        topic: { name: 'Duplicate Topic' },
        postgrestClient,
      })).to.be.rejectedWith('Failed to create topic');
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
      const query = createChainableQuery({ data: null, error: { message: 'connection timeout' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(updateTopic({
        organizationId: ORG_ID,
        topicId: 'test',
        updates: { name: 'Will Fail' },
        postgrestClient,
      })).to.be.rejectedWith('Failed to update topic');
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
      const query = createChainableQuery({ data: null, error: { message: 'permission denied' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(deleteTopic({
        organizationId: ORG_ID,
        topicId: 'test',
        postgrestClient,
      })).to.be.rejectedWith('Failed to delete topic');
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
