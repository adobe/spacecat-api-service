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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import {
  resolveBrandUuid,
  resolveCategoryUuid,
  resolveTopicUuid,
  listPrompts,
  getPromptById,
  upsertPrompts,
  updatePromptById,
  deletePromptById,
  bulkDeletePrompts,
} from '../../src/support/prompts-storage.js';

use(chaiAsPromised);

describe('prompts-storage', () => {
  const sandbox = sinon.createSandbox();
  const ORG_ID = '11111111-1111-4111-b111-111111111111';
  const BRAND_UUID = 'd1111111-1111-4111-b111-111111111111';
  const PROMPT_ID = 'prompt-1';

  const thenable = (v) => ({ then: (resolve) => resolve(v), catch: () => thenable(v) });

  function makeChain(result) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      order: () => chain,
      update: () => chain,
      ilike: () => chain,
      or: () => chain,
      contains: () => chain,
      in: () => chain,
      upsert: () => chain,
      insert: () => ({ select: () => thenable(result) }),
      range: () => thenable(result),
      maybeSingle: () => thenable(result),
      single: () => thenable(result),
      then: (resolve) => resolve(result),
    };
    return chain;
  }

  afterEach(() => sandbox.restore());

  describe('resolveBrandUuid', () => {
    it('returns null when brandId is empty', async () => {
      const result = await resolveBrandUuid(ORG_ID, '', { from: () => ({}) });
      expect(result).to.be.null;
    });

    it('returns null when postgrestClient has no from', async () => {
      const result = await resolveBrandUuid(ORG_ID, 'brand-1', null);
      expect(result).to.be.null;
    });

    it('returns brand id when valid UUID exists', async () => {
      const client = { from: () => makeChain({ data: { id: BRAND_UUID }, error: null }) };
      const result = await resolveBrandUuid(ORG_ID, BRAND_UUID, client);
      expect(result).to.equal(BRAND_UUID);
    });

    it('returns null when UUID not found', async () => {
      const client = { from: () => makeChain({ data: null, error: null }) };
      const result = await resolveBrandUuid(ORG_ID, BRAND_UUID, client);
      expect(result).to.be.null;
    });

    it('uses config to resolve brand id by name', async () => {
      const client = { from: () => makeChain({ data: { id: BRAND_UUID }, error: null }) };
      const config = { customer: { brands: [{ id: 'chevrolet', name: 'Chevrolet' }] } };
      const result = await resolveBrandUuid(ORG_ID, 'chevrolet', client, config);
      expect(result).to.equal(BRAND_UUID);
    });

    it('uses brandId as name when config has no matching brand', async () => {
      const client = { from: () => makeChain({ data: { id: BRAND_UUID }, error: null }) };
      const config = { customer: { brands: [] } };
      const result = await resolveBrandUuid(ORG_ID, 'AcmeBrand', client, config);
      expect(result).to.equal(BRAND_UUID);
    });

    it('uses brandId as name when config is null', async () => {
      const client = { from: () => makeChain({ data: { id: BRAND_UUID }, error: null }) };
      const result = await resolveBrandUuid(ORG_ID, 'AcmeBrand', client, null);
      expect(result).to.equal(BRAND_UUID);
    });
  });

  describe('resolveCategoryUuid', () => {
    it('returns null when categoryId is empty', async () => {
      const result = await resolveCategoryUuid(ORG_ID, '', { from: () => ({}) });
      expect(result).to.be.null;
    });

    it('returns null when postgrestClient has no from', async () => {
      const result = await resolveCategoryUuid(ORG_ID, 'cat-1', null);
      expect(result).to.be.null;
    });

    it('returns category id when found', async () => {
      const client = { from: () => makeChain({ data: { id: 'cat-uuid' }, error: null }) };
      const result = await resolveCategoryUuid(ORG_ID, 'cat-1', client);
      expect(result).to.equal('cat-uuid');
    });
  });

  describe('resolveTopicUuid', () => {
    it('returns null when topicId is empty', async () => {
      const result = await resolveTopicUuid(ORG_ID, '', { from: () => ({}) });
      expect(result).to.be.null;
    });

    it('returns topic id when found', async () => {
      const client = { from: () => makeChain({ data: { id: 'topic-uuid' }, error: null }) };
      const result = await resolveTopicUuid(ORG_ID, 'topic-1', client);
      expect(result).to.equal('topic-uuid');
    });

    it('returns null when topic is not found', async () => {
      const client = { from: () => makeChain({ data: null, error: null }) };
      const result = await resolveTopicUuid(ORG_ID, 'nonexistent', client);
      expect(result).to.be.null;
    });
  });

  describe('listPrompts', () => {
    it('returns empty when postgrestClient has no from', async () => {
      const result = await listPrompts({ organizationId: ORG_ID, postgrestClient: null });
      expect(result).to.deep.equal([]);
    });

    it('returns empty items when brandId resolves to no brand', async () => {
      const client = { from: () => makeChain({ data: null, error: null }) };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: 'nonexistent',
        postgrestClient: client,
      });
      expect(result).to.deep.equal([]);
    });

    it('returns empty items with total when no rows match', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [], error: null, count: 0 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result.items).to.deep.equal([]);
      expect(result.total).to.equal(0);
      expect(result.limit).to.equal(100);
      expect(result.page).to.equal(1);
    });

    it('returns paginated result with items', async () => {
      const row = {
        id: 'prompt-pk-uuid',
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt',
        regions: ['us'],
        status: 'active',
        origin: 'human',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
      expect(result.items[0].id).to.equal(PROMPT_ID);
      expect(result.items[0].uuid).to.equal('prompt-pk-uuid');
      expect(result.total).to.equal(1);
      expect(result.limit).to.equal(100);
      expect(result.page).to.equal(1);
    });

    it('filters by topicId only (no categoryId)', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt',
        regions: ['us'],
        status: 'active',
        origin: 'human',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: { id: 'topic-uuid', topic_id: 'my-topic' },
      };
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          if (table === 'topics') return makeChain({ data: { id: 'topic-uuid' }, error: null });
          return makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        topicId: 'my-topic',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
    });

    it('defaults limit and page when falsy values are passed', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [], error: null, count: 0 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        limit: 0,
        page: 0,
        postgrestClient: client,
      });
      expect(result.limit).to.equal(100);
      expect(result.page).to.equal(1);
    });

    it('uses explicit limit and page values', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt',
        regions: ['us'],
        status: 'active',
        origin: 'human',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        limit: 50,
        page: 2,
        postgrestClient: client,
      });
      expect(result.limit).to.equal(50);
      expect(result.page).to.equal(2);
    });

    it('falls back to 0 when count is null and rows are empty', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [], error: null, count: null });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result.items).to.deep.equal([]);
      expect(result.total).to.equal(0);
    });

    it('resolves without categoryId and topicId filters', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt',
        regions: ['us'],
        status: 'active',
        origin: 'human',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          if (table === 'categories') return makeChain({ data: [], error: null });
          if (table === 'topics') return makeChain({ data: [], error: null });
          return makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        categoryId: undefined,
        topicId: undefined,
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
    });

    it('falls back to prompts.length when count is null', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt',
        regions: ['us'],
        status: 'active',
        origin: 'human',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [row], error: null, count: null });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
      expect(result.total).to.equal(1);
    });

    it('throws when limit exceeds maximum', async () => {
      const client = { from: () => makeChain({ data: { id: BRAND_UUID }, error: null }) };
      await expect(
        listPrompts({
          organizationId: ORG_ID,
          brandId: BRAND_UUID,
          limit: 10000,
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('Limit must be between 1 and 5000');
    });

    it('applies status filter when provided', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt',
        regions: [],
        status: 'pending',
        origin: 'human',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        status: 'pending',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
      expect(result.items[0].status).to.equal('pending');
    });

    it('skips category filter when categoryId not found', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt',
        regions: [],
        status: 'active',
        origin: 'human',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          if (table === 'categories') return makeChain({ data: null, error: null });
          return makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        categoryId: 'nonexistent-category',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
    });

    it('applies categoryId and topicId filters when provided', async () => {
      const row = {
        id: 'prompt-pk-uuid-2',
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt',
        regions: [],
        status: 'active',
        origin: 'human',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: {
          id: 'cat-uuid', category_id: 'photoshop', name: 'Photoshop', origin: 'human',
        },
        topics: {
          id: 'topic-uuid', topic_id: 'editing', name: 'Editing', category_id: 'photoshop',
        },
      };
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          if (table === 'categories') return makeChain({ data: { id: 'cat-uuid' }, error: null });
          if (table === 'topics') return makeChain({ data: { id: 'topic-uuid' }, error: null });
          return makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        categoryId: 'photoshop',
        topicId: 'editing',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
      expect(result.items[0].category).to.deep.include({
        id: 'photoshop', uuid: 'cat-uuid', name: 'Photoshop', origin: 'human',
      });
      expect(result.items[0].topic).to.deep.include({
        id: 'editing', uuid: 'topic-uuid', name: 'Editing', categoryId: 'photoshop',
      });
    });

    it('throws on query error', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: null, error: { message: 'DB error' } });
        },
      };
      await expect(
        listPrompts({ organizationId: ORG_ID, brandId: BRAND_UUID, postgrestClient: client }),
      ).to.be.rejectedWith('Failed to list prompts');
    });
  });

  describe('getPromptById', () => {
    it('returns null when postgrestClient has no from', async () => {
      const result = await getPromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        postgrestClient: null,
      });
      expect(result).to.be.null;
    });

    it('returns null when promptId is empty', async () => {
      const result = await getPromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: '',
        postgrestClient: { from: () => ({}) },
      });
      expect(result).to.be.null;
    });

    it('returns prompt when found', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt',
        regions: [],
        status: 'active',
        origin: 'human',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const client = { from: () => makeChain({ data: row, error: null }) };
      const result = await getPromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        postgrestClient: client,
      });
      expect(result).to.not.be.null;
      expect(result.id).to.equal(PROMPT_ID);
      expect(result.prompt).to.equal('Prompt');
    });

    it('returns prompt with category and topic when present', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt',
        regions: [],
        status: 'active',
        origin: 'human',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'user@test.com',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: {
          id: 'cat-uuid', category_id: 'photoshop', name: 'Photoshop', origin: 'human',
        },
        topics: {
          id: 'topic-uuid', topic_id: 'editing', name: 'Editing', category_id: 'photoshop',
        },
      };
      const client = { from: () => makeChain({ data: row, error: null }) };
      const result = await getPromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        postgrestClient: client,
      });
      expect(result).to.not.be.null;
      expect(result.category).to.deep.equal({ id: 'photoshop', name: 'Photoshop', origin: 'human' });
      expect(result.topic).to.deep.equal({ id: 'editing', name: 'Editing', categoryId: 'photoshop' });
    });

    it('maps row with minimal fields and null category/topic', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        text: 'Prompt',
        regions: undefined,
        status: undefined,
        origin: undefined,
        updated_at: null,
        updated_by: null,
        brands: null,
        categories: null,
        topics: null,
      };
      const client = { from: () => makeChain({ data: row, error: null }) };
      const result = await getPromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        postgrestClient: client,
      });
      expect(result).to.not.be.null;
      expect(result.regions).to.deep.equal([]);
      expect(result.status).to.equal('active');
      expect(result.origin).to.equal('human');
      expect(result.source).to.equal('config');
      expect(result.categoryId).to.be.null;
      expect(result.topicId).to.be.null;
      expect(result.category).to.be.null;
      expect(result.topic).to.be.null;
      expect(result.brandId).to.be.null;
      expect(result.brandName).to.be.null;
    });

    it('throws on query error', async () => {
      const client = { from: () => makeChain({ data: null, error: { message: 'DB error' } }) };
      await expect(
        getPromptById({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          promptId: PROMPT_ID,
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('Failed to get prompt');
    });
  });

  describe('upsertPrompts', () => {
    it('throws when postgrestClient has no from', async () => {
      await expect(
        upsertPrompts({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          prompts: [{ prompt: 'x' }],
          postgrestClient: null,
        }),
      ).to.be.rejectedWith('PostgREST client is required for prompts');
    });

    it('inserts new prompts', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'New prompt', regions: ['us'] }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
      expect(result.updated).to.equal(0);
      expect(result.prompts).to.have.lengthOf(1);
    });

    it('updates existing prompts by id', async () => {
      const existingData = {
        data: [{
          id: 'row-id', prompt_id: 'p1', text: 'old', regions: [],
        }],
        error: null,
      };
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    ...thenable(existingData),
                    in: () => thenable(existingData),
                  }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ id: 'p1', prompt: 'Updated', regions: [] }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(0);
      expect(result.updated).to.equal(1);
    });

    it('throws on insert error', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
              insert: () => ({ select: () => thenable({ data: null, error: { message: 'Insert failed' } }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      await expect(
        upsertPrompts({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          prompts: [{ prompt: 'New', regions: [] }],
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('Failed to insert prompts');
    });

    it('throws on update error', async () => {
      const existingData = {
        data: [{
          id: 'row-id', prompt_id: 'p1', text: 'old', regions: [],
        }],
        error: null,
      };
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    ...thenable(existingData),
                    in: () => thenable(existingData),
                  }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [], error: null }) }),
              update: () => ({ eq: () => thenable({ error: { message: 'Update failed' } }) }),
            };
          }
          return makeChain({});
        },
      };
      await expect(
        upsertPrompts({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          prompts: [{ id: 'p1', prompt: 'Updated', regions: [] }],
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('Failed to update prompt');
    });

    it('uses toInsert.length when insert returns no data', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
              insert: () => ({ select: () => thenable({ data: null, error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'New', regions: [] }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
    });

    it('resolves categoryId and topicId when upserting', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          if (table === 'categories') return makeChain({ data: [{ id: 'cat-uuid', category_id: 'photoshop' }], error: null });
          if (table === 'topics') return makeChain({ data: [{ id: 'topic-uuid', topic_id: 'editing' }], error: null });
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{
          prompt: 'New', regions: ['us'], categoryId: 'photoshop', topicId: 'editing',
        }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
      expect(result.prompts[0].categoryId).to.equal('photoshop');
      expect(result.prompts[0].topicId).to.equal('editing');
    });

    it('auto-creates missing categories and topics via ensureLookupEntries', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          // buildLookupMaps returns empty arrays → maps will be empty
          // ensureLookupEntries will upsert the missing entries
          if (table === 'categories') {
            return makeChain({
              data: [{ id: 'new-cat-uuid', category_id: 'new-cat' }],
              error: null,
            });
          }
          if (table === 'topics') {
            return makeChain({
              data: [{ id: 'new-topic-uuid', topic_id: 'new-topic' }],
              error: null,
            });
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{
          prompt: 'New prompt', regions: ['us'], categoryId: 'new-cat', topicId: 'new-topic',
        }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
      expect(result.prompts[0].categoryId).to.equal('new-cat');
      expect(result.prompts[0].topicId).to.equal('new-topic');
    });

    it('throws when auto-creating categories fails', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
              insert: () => ({ select: () => thenable({ data: [], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          if (table === 'categories') {
            return makeChain({ data: null, error: { message: 'constraint violation' } });
          }
          return makeChain({ data: [], error: null });
        },
      };
      await expect(
        upsertPrompts({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          prompts: [{ prompt: 'X', regions: [], categoryId: 'bad-cat' }],
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('Failed to auto-create categories');
    });

    it('throws when auto-creating topics fails', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
              insert: () => ({ select: () => thenable({ data: [], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          if (table === 'topics') {
            return makeChain({ data: null, error: { message: 'constraint violation' } });
          }
          return makeChain({ data: [], error: null });
        },
      };
      await expect(
        upsertPrompts({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          prompts: [{ prompt: 'X', regions: [], topicId: 'bad-topic' }],
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('Failed to auto-create topics');
    });

    it('handles existing prompts with null regions', async () => {
      const existingData = {
        data: [{
          id: 'row-id', prompt_id: 'p1', text: 'existing', regions: null,
        }],
        error: null,
      };
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    ...thenable(existingData),
                    in: () => thenable(existingData),
                  }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ id: 'p1', prompt: 'existing' }],
        postgrestClient: client,
      });
      expect(result.updated).to.equal(1);
      expect(result.prompts[0].regions).to.deep.equal([]);
    });

    it('handles null existing data from database', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    ...thenable({ data: null, error: null }),
                    in: () => thenable({ data: null, error: null }),
                  }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'Hello', regions: ['us'] }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
    });

    it('falls back to null when categoryId/topicId not found in maps', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    ...thenable({ data: [], error: null }),
                    in: () => thenable({ data: [], error: null }),
                  }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          // Return empty lookup maps so categoryMap/topicMap won't find the IDs
          return makeChain({ data: [], error: null });
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{
          prompt: 'Test', regions: ['us'], categoryId: 'nonexistent-cat', topicId: 'nonexistent-topic',
        }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
      expect(result.prompts[0].categoryId).to.equal('nonexistent-cat');
      expect(result.prompts[0].topicId).to.equal('nonexistent-topic');
    });

    it('handles prompts without regions, categoryId, topicId, name, or text', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    ...thenable({ data: [], error: null }),
                    in: () => thenable({ data: [], error: null }),
                  }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'gen-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ id: 'my-id' }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
      expect(result.prompts).to.have.lengthOf(1);
      expect(result.prompts[0].regions).to.deep.equal([]);
      expect(result.prompts[0].categoryId).to.be.undefined;
      expect(result.prompts[0].topicId).to.be.undefined;
    });
  });

  describe('updatePromptById', () => {
    it('throws when postgrestClient has no from', async () => {
      await expect(
        updatePromptById({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          promptId: PROMPT_ID,
          updates: {},
          postgrestClient: null,
        }),
      ).to.be.rejectedWith('PostgREST client is required');
    });

    it('returns null when prompt not found', async () => {
      const client = {
        from: () => makeChain({ data: null, error: null }),
      };
      const result = await updatePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: 'nonexistent',
        updates: { prompt: 'x' },
        postgrestClient: client,
      });
      expect(result).to.be.null;
    });

    it('returns updated prompt when found', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Updated',
        regions: [],
        status: 'active',
        origin: 'human',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const client = { from: () => makeChain({ data: row, error: null }) };
      const result = await updatePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        updates: { prompt: 'Updated' },
        postgrestClient: client,
      });
      expect(result).to.not.be.null;
      expect(result.id).to.equal(PROMPT_ID);
      expect(result.prompt).to.equal('Updated');
    });

    it('updates name, regions, status, origin, categoryId, topicId', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'New Name',
        text: 'Text',
        regions: ['eu'],
        status: 'pending',
        origin: 'ai',
        updated_at: '2026-01-01T00:00:00Z',
        updated_by: 'user@test.com',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: {
          id: 'cat-uuid', category_id: 'photoshop', name: 'Photoshop', origin: 'human',
        },
        topics: {
          id: 'topic-uuid', topic_id: 'editing', name: 'Editing', category_id: 'photoshop',
        },
      };
      const client = {
        from: (table) => {
          if (table === 'categories') return makeChain({ data: { id: 'cat-uuid' }, error: null });
          if (table === 'topics') return makeChain({ data: { id: 'topic-uuid' }, error: null });
          return makeChain({ data: row, error: null });
        },
      };
      const result = await updatePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        updates: {
          name: 'New Name',
          regions: ['eu'],
          status: 'pending',
          origin: 'ai',
          categoryId: 'photoshop',
          topicId: 'editing',
        },
        postgrestClient: client,
        updatedBy: 'user@test.com',
      });
      expect(result).to.not.be.null;
      expect(result.name).to.equal('New Name');
    });

    it('throws on update query error', async () => {
      const client = { from: () => makeChain({ data: null, error: { message: 'Update failed' } }) };
      await expect(
        updatePromptById({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          promptId: PROMPT_ID,
          updates: { prompt: 'x' },
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('Failed to update prompt');
    });

    it('sets categoryId and topicId to null when empty string', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Text',
        regions: [],
        status: 'active',
        origin: 'human',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const client = { from: () => makeChain({ data: row, error: null }) };
      const result = await updatePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        updates: { categoryId: '', topicId: '' },
        postgrestClient: client,
      });
      expect(result).to.not.be.null;
    });
  });

  describe('deletePromptById', () => {
    it('throws when postgrestClient has no from', async () => {
      await expect(
        deletePromptById({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          promptId: PROMPT_ID,
          postgrestClient: null,
        }),
      ).to.be.rejectedWith('PostgREST client is required');
    });

    it('returns false when prompt not found', async () => {
      const client = { from: () => makeChain({ data: null, error: null }) };
      const result = await deletePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: 'nonexistent',
        postgrestClient: client,
      });
      expect(result).to.be.false;
    });

    it('returns true when prompt deleted', async () => {
      const client = { from: () => makeChain({ data: { id: 'row-id' }, error: null }) };
      const result = await deletePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        postgrestClient: client,
      });
      expect(result).to.be.true;
    });

    it('uses updatedBy when provided', async () => {
      const client = { from: () => makeChain({ data: { id: 'row-id' }, error: null }) };
      const result = await deletePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        postgrestClient: client,
        updatedBy: 'user@test.com',
      });
      expect(result).to.be.true;
    });

    it('throws on delete query error', async () => {
      const client = { from: () => makeChain({ data: null, error: { message: 'Delete failed' } }) };
      await expect(
        deletePromptById({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          promptId: PROMPT_ID,
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('Failed to delete prompt');
    });
  });

  describe('listPrompts - search, sort, region, origin', () => {
    const sampleRow = {
      prompt_id: PROMPT_ID,
      name: 'Test',
      text: 'Prompt text',
      regions: ['us'],
      status: 'active',
      origin: 'human',
      source: 'config',
      updated_at: '2026-01-01T00:00:00Z',
      updated_by: 'system',
      brands: { id: BRAND_UUID, name: 'Brand' },
      categories: null,
      topics: null,
    };

    it('passes search param through to query', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [sampleRow], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        search: 'photo',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
      expect(result.items[0].source).to.equal('config');
    });

    it('applies origin filter', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [sampleRow], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        origin: 'human',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
    });

    it('applies region filter', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [sampleRow], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        region: 'us',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
    });

    it('applies sort and order params', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [sampleRow], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        sort: 'prompt',
        order: 'asc',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
    });

    it('uses default sort when invalid sort column', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [sampleRow], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        sort: 'invalid_column',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
    });

    it('sorts by foreign table column (topic)', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [sampleRow], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        sort: 'topic',
        order: 'desc',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
    });

    it('maps source field from row', async () => {
      const rowWithSource = { ...sampleRow, source: 'sheet' };
      const client = {
        from: (table) => {
          if (table === 'brands') return makeChain({ data: { id: BRAND_UUID }, error: null });
          return makeChain({ data: [rowWithSource], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result.items[0].source).to.equal('sheet');
    });
  });

  describe('upsertPrompts - source field', () => {
    it('includes source field in upserted prompt output', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'New prompt', regions: ['us'], source: 'sheet' }],
        postgrestClient: client,
      });
      expect(result.prompts[0].source).to.equal('sheet');
    });

    it('defaults source to config when not provided', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'New prompt', regions: ['us'] }],
        postgrestClient: client,
      });
      expect(result.prompts[0].source).to.equal('config');
    });
  });

  describe('bulkDeletePrompts', () => {
    it('throws when postgrestClient has no from', async () => {
      await expect(
        bulkDeletePrompts({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          promptIds: ['p1'],
          postgrestClient: null,
        }),
      ).to.be.rejectedWith('PostgREST client is required');
    });

    it('soft-deletes all prompts successfully', async () => {
      const client = { from: () => makeChain({ data: { id: 'row-id' }, error: null }) };
      const result = await bulkDeletePrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptIds: ['p1', 'p2', 'p3'],
        postgrestClient: client,
      });
      expect(result.metadata.total).to.equal(3);
      expect(result.metadata.success).to.equal(3);
      expect(result.metadata.failure).to.equal(0);
      expect(result.failures).to.deep.equal([]);
    });

    it('reports not found prompts as failures', async () => {
      const client = { from: () => makeChain({ data: null, error: null }) };
      const result = await bulkDeletePrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptIds: ['p1', 'p2'],
        postgrestClient: client,
      });
      expect(result.metadata.total).to.equal(2);
      expect(result.metadata.success).to.equal(0);
      expect(result.metadata.failure).to.equal(2);
      expect(result.failures).to.have.lengthOf(2);
      expect(result.failures[0].reason).to.equal('Prompt not found');
    });

    it('reports DB errors as failures', async () => {
      const client = { from: () => makeChain({ data: null, error: { message: 'DB error' } }) };
      const result = await bulkDeletePrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptIds: ['p1'],
        postgrestClient: client,
      });
      expect(result.metadata.total).to.equal(1);
      expect(result.metadata.success).to.equal(0);
      expect(result.metadata.failure).to.equal(1);
      expect(result.failures[0].reason).to.equal('DB error');
    });

    it('catches thrown exceptions as failures', async () => {
      const client = {
        from: () => {
          throw new Error('Connection lost');
        },
      };
      const result = await bulkDeletePrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptIds: ['p1'],
        postgrestClient: client,
      });
      expect(result.metadata.total).to.equal(1);
      expect(result.metadata.success).to.equal(0);
      expect(result.metadata.failure).to.equal(1);
      expect(result.failures[0].reason).to.equal('Connection lost');
    });

    it('handles mix of success and failure', async () => {
      let callCount = 0;
      const client = {
        from: () => {
          callCount += 1;
          if (callCount === 1) return makeChain({ data: { id: 'row-id' }, error: null });
          return makeChain({ data: null, error: null });
        },
      };
      const result = await bulkDeletePrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptIds: ['p1', 'p2'],
        postgrestClient: client,
      });
      expect(result.metadata.total).to.equal(2);
      expect(result.metadata.success).to.equal(1);
      expect(result.metadata.failure).to.equal(1);
    });
  });
});
