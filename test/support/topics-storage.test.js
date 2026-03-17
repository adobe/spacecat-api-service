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
  });

  describe('updateTopic', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(updateTopic({
        organizationId: ORG_ID, topicId: 'test', updates: {}, postgrestClient: null,
      })).to.be.rejectedWith('PostgREST client is required');
    });
  });

  describe('deleteTopic', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(deleteTopic({
        organizationId: ORG_ID, topicId: 'test', postgrestClient: null,
      })).to.be.rejectedWith('PostgREST client is required');
    });
  });
});
