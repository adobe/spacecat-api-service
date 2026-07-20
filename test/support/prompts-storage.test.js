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
  checkPromptsExist,
  getPromptStats,
  normalizeIntent,
  isMissingIntentColumnError,
  findPromptsBlockingRegionRemoval,
  getIntentsByPromptIds,
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
      overlaps: () => chain,
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

  describe('normalizeIntent', () => {
    it('returns null for absent, empty, or whitespace values', () => {
      expect(normalizeIntent(undefined)).to.be.null;
      expect(normalizeIntent(null)).to.be.null;
      expect(normalizeIntent('')).to.be.null;
      expect(normalizeIntent('   ')).to.be.null;
    });

    it('passes through canonical buckets unchanged', () => {
      for (const v of [
        'informational', 'instructional', 'comparative',
        'transactional', 'planning', 'delegation',
      ]) {
        expect(normalizeIntent(v)).to.equal(v);
      }
    });

    it('lowercases and trims uppercase/padded input', () => {
      expect(normalizeIntent('INFORMATIONAL')).to.equal('informational');
      expect(normalizeIntent('  Transactional  ')).to.equal('transactional');
    });

    it('remaps legacy labels onto canonical buckets', () => {
      expect(normalizeIntent('statistical')).to.equal('informational');
      expect(normalizeIntent('navigational')).to.equal('informational');
      expect(normalizeIntent('commercial')).to.equal('transactional');
      expect(normalizeIntent('COMMERCIAL')).to.equal('transactional');
    });

    it('returns null for values that are invalid after remap', () => {
      expect(normalizeIntent('bogus')).to.be.null;
      expect(normalizeIntent('navigation')).to.be.null;
    });
  });

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

    it('returns null when categoryId is not a valid UUID (business-key lookup retired, LLMO-5515)', async () => {
      // Pre-LLMO-5515 this resolved a TEXT business key to its UUID. The
      // category_id business key is gone — the only accepted identifier is
      // the categories.id UUID. A non-UUID never hits the DB and fails closed.
      const client = { from: () => makeChain({ data: { id: 'cat-uuid' }, error: null }) };
      const result = await resolveCategoryUuid(ORG_ID, 'cat-1', client);
      expect(result).to.be.null;
    });

    it('resolves by primary key scoped to org when categoryId is a valid UUID', async () => {
      const uuid = 'a1111111-1111-4111-b111-111111111111';
      const client = { from: () => makeChain({ data: { id: uuid }, error: null }) };
      const result = await resolveCategoryUuid(ORG_ID, uuid, client);
      expect(result).to.equal(uuid);
    });

    it('returns null when UUID does not belong to the organization', async () => {
      const uuid = 'a1111111-1111-4111-b111-111111111111';
      const client = { from: () => makeChain({ data: null, error: null }) };
      const result = await resolveCategoryUuid(ORG_ID, uuid, client);
      expect(result).to.be.null;
    });
  });

  describe('resolveTopicUuid', () => {
    it('returns null when topicId is empty', async () => {
      const result = await resolveTopicUuid(ORG_ID, '', { from: () => ({}) });
      expect(result).to.be.null;
    });

    it('returns topic id when found by business key', async () => {
      const client = { from: () => makeChain({ data: { id: 'topic-uuid' }, error: null }) };
      const result = await resolveTopicUuid(ORG_ID, 'topic-1', client);
      expect(result).to.equal('topic-uuid');
    });

    it('returns null when topic is not found', async () => {
      const client = { from: () => makeChain({ data: null, error: null }) };
      const result = await resolveTopicUuid(ORG_ID, 'nonexistent', client);
      expect(result).to.be.null;
    });

    it('resolves by primary key scoped to org when topicId is a valid UUID', async () => {
      const uuid = 'b2222222-2222-4222-b222-222222222222';
      const client = { from: () => makeChain({ data: { id: uuid }, error: null }) };
      const result = await resolveTopicUuid(ORG_ID, uuid, client);
      expect(result).to.equal(uuid);
    });

    it('returns null when UUID does not belong to the organization', async () => {
      const uuid = 'b2222222-2222-4222-b222-222222222222';
      const client = { from: () => makeChain({ data: null, error: null }) };
      const result = await resolveTopicUuid(ORG_ID, uuid, client);
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
        source: 'config',
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'admin@test.com',
        updated_at: '2026-02-01T00:00:00Z',
        updated_by: 'system',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const client = {
        from: (table) => {
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
      // Regression guard for LLMO-4625: the UUID PK must be exposed alongside
      // the text business key. DRS uses `uuid` to populate the
      // `brand_presence_executions.prompt_id` UUID FK column. PR #2199 dropped
      // it; missing this assertion is what let the regression ship.
      expect(result.items[0].uuid).to.equal('prompt-pk-uuid');
      expect(result.items[0].createdAt).to.equal('2026-01-01T00:00:00Z');
      expect(result.items[0].createdBy).to.equal('admin@test.com');
      expect(result.items[0].updatedAt).to.equal('2026-02-01T00:00:00Z');
      expect(result.items[0].updatedBy).to.equal('system');
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
          if (table === 'topics') {
            return makeChain({ data: { id: 'topic-uuid' }, error: null });
          }
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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

    it('filters by region case-insensitively via array overlap (LLMO-5755)', async () => {
      // Stored region codes can be lower- or upper-case, so the filter must
      // match both variants via array overlap rather than a case-sensitive
      // contains. (LLMO-5755)
      let overlapsCall = null;
      const recordingChain = (result) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          neq: () => chain,
          order: () => chain,
          or: () => chain,
          contains: () => chain,
          overlaps: (column, value) => {
            overlapsCall = { column, value };
            return chain;
          },
          in: () => chain,
          range: () => thenable(result),
          maybeSingle: () => thenable(result),
          single: () => thenable(result),
          then: (resolve) => resolve(result),
        };
        return chain;
      };
      const client = {
        from: (table) => (table === 'brands'
          ? recordingChain({ data: { id: BRAND_UUID }, error: null })
          : recordingChain({ data: [], error: null, count: 0 })),
      };
      await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        region: 'us',
        postgrestClient: client,
      });
      expect(overlapsCall).to.not.be.null;
      expect(overlapsCall.column).to.equal('regions');
      expect(overlapsCall.value).to.have.members(['us', 'US']);
      expect(overlapsCall.value).to.have.lengthOf(2);
    });

    // Records every .eq() call so the assertion fails if the `.eq('source', source)`
    // filter is deleted — a no-op `eq: () => chain` stub would pass regardless.
    function makeEqRecordingClient(eqCalls) {
      const recordingChain = (result) => {
        const chain = {
          select: () => chain,
          eq: (column, value) => {
            eqCalls.push({ column, value });
            return chain;
          },
          neq: () => chain,
          order: () => chain,
          or: () => chain,
          contains: () => chain,
          overlaps: () => chain,
          in: () => chain,
          range: () => thenable(result),
          maybeSingle: () => thenable(result),
          single: () => thenable(result),
          then: (resolve) => resolve(result),
        };
        return chain;
      };
      return {
        from: (table) => (table === 'brands'
          ? recordingChain({ data: { id: BRAND_UUID }, error: null })
          : recordingChain({ data: [], error: null, count: 0 })),
      };
    }

    it('applies the source filter as an exact match when source is provided', async () => {
      const eqCalls = [];
      await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        source: 'gsc',
        postgrestClient: makeEqRecordingClient(eqCalls),
      });
      expect(eqCalls).to.deep.include({ column: 'source', value: 'gsc' });
    });

    it('does not apply a source filter when source is omitted', async () => {
      const eqCalls = [];
      await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        postgrestClient: makeEqRecordingClient(eqCalls),
      });
      expect(eqCalls.some((c) => c.column === 'source')).to.equal(false);
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
          if (table === 'categories') {
            return makeChain({ data: [], error: null });
          }
          if (table === 'topics') {
            return makeChain({ data: [], error: null });
          }
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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

    it('fails closed (empty page) when a categoryId filter does not resolve', async () => {
      // Regression guard for LLMO-5515: a categoryId that does not resolve to
      // a category in this org must return an EMPTY page, never the full
      // unfiltered set. The old behavior silently dropped the filter (fail
      // open), surfacing every prompt for the brand as a phantom count. We
      // use a valid-but-unknown UUID so the DB lookup actually fires and
      // returns no row.
      const unknownUuid = 'c3333333-3333-4333-b333-333333333333';
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
          if (table === 'categories') {
            return makeChain({ data: null, error: null });
          }
          return makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        categoryId: unknownUuid,
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(0);
      expect(result.total).to.equal(0);
    });

    it('fails closed (empty page) when a categoryId is not a valid UUID', async () => {
      // A non-UUID categoryId can never match (business keys are retired,
      // LLMO-5515). It must fail closed without even hitting the DB.
      const client = {
        from: (table) => {
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
          return makeChain({ data: null, error: null });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        categoryId: 'nonexistent-category',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(0);
      expect(result.total).to.equal(0);
    });

    it('fails closed (empty page) when a topicId filter does not resolve', async () => {
      // Regression guard for LLMO-5515: symmetric with the categoryId guard
      // above. A topicId that does not resolve to a topic in this org must
      // return an EMPTY page, never the full unfiltered set. We use a
      // valid-but-unknown UUID so the topics lookup actually fires and
      // returns no row.
      const unknownUuid = 'd4444444-4444-4444-b444-444444444444';
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
          if (table === 'topics') {
            return makeChain({ data: null, error: null });
          }
          return makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        topicId: unknownUuid,
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(0);
      expect(result.total).to.equal(0);
    });

    it('applies categoryId and topicId filters when provided', async () => {
      const categoryUuid = 'a1111111-1111-4111-b111-111111111111';
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
          id: categoryUuid, name: 'Photoshop', origin: 'human',
        },
        topics: {
          id: 'topic-uuid', topic_id: 'editing', name: 'Editing', category_id: categoryUuid,
        },
      };
      const client = {
        from: (table) => {
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
          if (table === 'categories') {
            return makeChain({ data: { id: categoryUuid }, error: null });
          }
          if (table === 'topics') {
            return makeChain({ data: { id: 'topic-uuid' }, error: null });
          }
          return makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        categoryId: categoryUuid,
        topicId: 'editing',
        postgrestClient: client,
      });
      expect(result.items).to.have.lengthOf(1);
      // deep.equal (not deep.include) — symmetric with getPromptById test below
      // and locks the exact embed shape so a regression dropping `uuid` (or
      // adding an unintended field) fails fast. DRS reads category.uuid /
      // topic.uuid to populate brand_presence_executions.category_id /
      // .topic_id FKs.
      expect(result.items[0].category).to.deep.equal({
        id: categoryUuid, uuid: categoryUuid, name: 'Photoshop', origin: 'human',
      });
      expect(result.items[0].topic).to.deep.equal({
        id: 'topic-uuid', uuid: 'topic-uuid', name: 'Editing',
      });
    });

    it('throws on query error', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
        id: 'prompt-pk-uuid',
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Prompt',
        regions: [],
        status: 'active',
        origin: 'human',
        source: 'sheet',
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'admin@test.com',
        updated_at: '2026-02-01T00:00:00Z',
        updated_by: 'user@test.com',
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
      // Regression guard for LLMO-4625 — see listPrompts test above for context.
      expect(result.uuid).to.equal('prompt-pk-uuid');
      expect(result.prompt).to.equal('Prompt');
      expect(result.source).to.equal('sheet');
      expect(result.createdAt).to.equal('2026-01-01T00:00:00Z');
      expect(result.createdBy).to.equal('admin@test.com');
      expect(result.updatedAt).to.equal('2026-02-01T00:00:00Z');
      expect(result.updatedBy).to.equal('user@test.com');
    });

    it('returns prompt with category and topic when present', async () => {
      const row = {
        id: 'prompt-pk-uuid-3',
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
      // `uuid` is the UUID PK consumers (DRS) use for FK linkage; `id` is
      // preserved with its historical UUID value for backward compat.
      expect(result.category).to.deep.equal({
        id: 'cat-uuid', uuid: 'cat-uuid', name: 'Photoshop', origin: 'human',
      });
      expect(result.topic).to.deep.equal({
        id: 'topic-uuid', uuid: 'topic-uuid', name: 'Editing',
      });
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
      expect(result.category).to.be.null;
      expect(result.topic).to.be.null;
      expect(result.brandId).to.be.null;
      expect(result.brandName).to.be.null;
    });

    it('returns null when prompt is not found', async () => {
      const client = { from: () => makeChain({ data: null, error: null }) };
      const result = await getPromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        postgrestClient: client,
      });
      expect(result).to.be.null;
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
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
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
        prompts: [{ prompt: 'New prompt', regions: ['us'] }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
      expect(result.updated).to.equal(0);
      expect(result.prompts).to.have.lengthOf(1);
    });

    it('treats same text+regions with a DIFFERENT source as a new row (SITES-47870)', async () => {
      const existing = [{
        id: 'u1', prompt_id: 'p-gsc', text: 'Shared prompt', regions: ['us'], status: 'active', source: 'gsc',
      }];
      const insertStub = sinon.stub().returns({
        select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }),
      });
      const updateStub = sinon.stub().returns({ eq: () => thenable({ error: null }) });
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({ eq: () => thenable({ data: existing, error: null }) }),
              }),
              insert: insertStub,
              update: updateStub,
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'Shared prompt', regions: ['us'], source: 'base_url' }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
      expect(result.updated).to.equal(0);
      expect(updateStub.called).to.equal(false);
      expect(insertStub.firstCall.args[0][0].source).to.equal('base_url');
    });

    it('matches same text+regions+source to the existing row (updates, not inserts)', async () => {
      const existing = [{
        id: 'u1', prompt_id: 'p-gsc', text: 'Shared prompt', regions: ['us'], status: 'active', source: 'gsc',
      }];
      const insertStub = sinon.stub().returns({
        select: () => thenable({ data: [], error: null }),
      });
      const updateStub = sinon.stub().returns({ eq: () => thenable({ error: null }) });
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({ eq: () => thenable({ data: existing, error: null }) }),
              }),
              insert: insertStub,
              update: updateStub,
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'Shared prompt', regions: ['us'], source: 'gsc' }],
        postgrestClient: client,
      });
      expect(result.updated).to.equal(1);
      expect(result.created).to.equal(0);
      expect(insertStub.called).to.equal(false);
    });

    it('rejects an unregistered source with a 400 (SITES-47870 chokepoint)', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
              insert: () => ({ select: () => thenable({ data: [], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const err = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'x', regions: [], source: 'totally-bogus' }],
        postgrestClient: client,
      }).catch((e) => e);
      expect(err).to.be.an('error');
      expect(err.message).to.match(/Unregistered prompt source/);
      expect(err.status).to.equal(400);
    });

    it('preserves the stored source on an id-match update (SITES-47870 immutability)', async () => {
      const existing = [{
        id: 'u1', prompt_id: 'p1', text: 'Kept', regions: ['us'], status: 'active', source: 'gsc',
      }];
      const insertStub = sinon.stub().returns({
        select: () => thenable({ data: [], error: null }),
      });
      const updateStub = sinon.stub().returns({ eq: () => thenable({ error: null }) });
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    ...thenable({ data: existing, error: null }),
                    in: () => thenable({ data: existing, error: null }),
                  }),
                }),
              }),
              insert: insertStub,
              update: updateStub,
            };
          }
          return makeChain({});
        },
      };
      // Incoming matches by prompt_id but carries a DIFFERENT source; the stored
      // 'gsc' must NOT be overwritten to 'semrush'.
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{
          id: 'p1', prompt: 'Kept', regions: ['us'], source: 'semrush',
        }],
        postgrestClient: client,
      });
      expect(result.updated).to.equal(1);
      expect(insertStub.called).to.equal(false);
      expect(updateStub.firstCall.args[0].source).to.equal('gsc');
      expect(result.prompts[0].source).to.equal('gsc');
    });

    it('keeps two new same-text/different-source prompts as separate inserts (dedup by source)', async () => {
      const insertStub = sinon.stub().returns({
        select: () => thenable({ data: [{ prompt_id: 'a' }, { prompt_id: 'b' }], error: null }),
      });
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({ eq: () => ({ eq: () => thenable({ data: [], error: null }) }) }),
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [
          { prompt: 'Shared', regions: ['us'], source: 'gsc' },
          { prompt: 'Shared', regions: ['us'], source: 'base_url' },
        ],
        postgrestClient: client,
      });
      expect(result.created).to.equal(2);
      const insertedSources = insertStub.firstCall.args[0].map((r) => r.source).sort();
      expect(insertedSources).to.deep.equal(['base_url', 'gsc']);
    });

    it('persists normalized intent on insert (lowercases, remaps; invalid -> null)', async () => {
      const insertStub = sinon.stub().returns({
        select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }),
      });
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
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [
          {
            id: 'a', prompt: 'lower', regions: [], intent: 'informational',
          },
          {
            id: 'b', prompt: 'upper', regions: [], intent: 'TRANSACTIONAL',
          },
          {
            id: 'c', prompt: 'legacy', regions: [], intent: 'commercial',
          },
          {
            id: 'd', prompt: 'invalid', regions: [], intent: 'bogus',
          },
          { id: 'e', prompt: 'absent', regions: [] },
        ],
        postgrestClient: client,
      });
      const inserted = insertStub.firstCall.args[0];
      expect(inserted.map((r) => r.intent)).to.deep.equal([
        'informational', 'transactional', 'transactional', null, null,
      ]);
    });

    it('classifies prompts with no intent and persists the result', async () => {
      const insertStub = sinon.stub().returns({
        select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }),
      });
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
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const classifyIntent = sinon.stub().resolves('comparative');
      await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ id: 'a', prompt: 'Figma vs Sketch', regions: [] }],
        postgrestClient: client,
        classifyIntent,
      });
      expect(classifyIntent.calledOnceWith('Figma vs Sketch')).to.be.true;
      expect(insertStub.firstCall.args[0][0].intent).to.equal('comparative');
    });

    it('does NOT re-classify prompts that already carry an intent', async () => {
      const insertStub = sinon.stub().returns({
        select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }),
      });
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
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const classifyIntent = sinon.stub().resolves('comparative');
      await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{
          id: 'a', prompt: 'pipeline prompt', regions: [], intent: 'transactional',
        }],
        postgrestClient: client,
        classifyIntent,
      });
      expect(classifyIntent.called).to.be.false;
      expect(insertStub.firstCall.args[0][0].intent).to.equal('transactional');
    });

    it('persists null and does not fail when classification rejects', async () => {
      const insertStub = sinon.stub().returns({
        select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }),
      });
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
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const classifyIntent = sinon.stub().rejects(new Error('LLM down'));
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ id: 'a', prompt: 'some prompt', regions: [] }],
        postgrestClient: client,
        classifyIntent,
      });
      expect(result.created).to.equal(1);
      expect(insertStub.firstCall.args[0][0].intent).to.be.null;
    });

    it('does not classify when no classifier is provided', async () => {
      const insertStub = sinon.stub().returns({
        select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }),
      });
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
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ id: 'a', prompt: 'no classifier', regions: [] }],
        postgrestClient: client,
      });
      expect(insertStub.firstCall.args[0][0].intent).to.be.null;
    });

    it('updates existing prompts by id', async () => {
      const existingData = {
        data: [{
          id: 'row-id', prompt_id: 'p1', text: 'old', regions: [], status: 'active',
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

    it('processes every update with bounded concurrency (more rows than the pool)', async () => {
      // Guards the parallel update loop: with 25 rows and a pool of 20, all rows
      // must still be updated exactly once (the loop drains via a shared cursor).
      const rows = Array.from({ length: 25 }, (_, i) => ({
        id: `row-${i}`, prompt_id: `p${i}`, text: `t${i}`, regions: [], status: 'active',
      }));
      const existingData = { data: rows, error: null };
      const updateStub = sinon.stub().returns({ eq: () => thenable({ error: null }) });
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
              update: updateStub,
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: rows.map((r) => ({ id: r.prompt_id, prompt: `updated ${r.prompt_id}`, regions: [] })),
        postgrestClient: client,
      });
      expect(result.updated).to.equal(25);
      expect(result.created).to.equal(0);
      expect(updateStub.callCount).to.equal(25);
    });

    it('reactivates a deleted prompt matched by prompt_id', async () => {
      const deletedRow = {
        id: 'row-uuid', prompt_id: 'del-1', text: 'Deleted text', regions: [], status: 'deleted', source: 'gsc',
      };
      const existingData = { data: [deletedRow], error: null };
      const updateStub = sinon.stub().returns({ eq: () => thenable({ error: null }) });
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
              update: updateStub,
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ id: 'del-1', prompt: 'Deleted text', regions: [] }],
        postgrestClient: client,
      });
      expect(result.updated).to.equal(1);
      expect(result.created).to.equal(0);
      expect(result.skipped).to.equal(0);
      expect(updateStub.callCount).to.equal(1);
      // Reactivation preserves the stored source (SITES-47870 immutability).
      expect(updateStub.firstCall.args[0].source).to.equal('gsc');
    });

    it('reactivating a deleted row by prompt_id keeps the stored source, not the incoming one', async () => {
      // Deleted row is gsc-sourced; the incoming reactivation carries a DIFFERENT
      // source. The id-match must NOT move the row to 'semrush'.
      const deletedRow = {
        id: 'row-uuid', prompt_id: 'del-1b', text: 'Reactivate me', regions: ['us'], status: 'deleted', source: 'gsc',
      };
      const existingData = { data: [deletedRow], error: null };
      const updateStub = sinon.stub().returns({ eq: () => thenable({ error: null }) });
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
              update: updateStub,
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{
          id: 'del-1b', prompt: 'Reactivate me', regions: ['us'], source: 'semrush',
        }],
        postgrestClient: client,
      });
      expect(result.updated).to.equal(1);
      expect(updateStub.firstCall.args[0].source).to.equal('gsc');
      expect(result.prompts[0].source).to.equal('gsc');
    });

    it('reactivates a deleted prompt matched by text+regions without inserting', async () => {
      const deletedRow = {
        id: 'row-uuid', prompt_id: 'del-2', text: 'Same text', regions: ['us'], status: 'deleted', source: 'gsc',
      };
      const existingData = { data: [deletedRow], error: null };
      const insertSpy = sinon.stub().returns({
        select: () => thenable({ data: [], error: null }),
      });
      const updateStub = sinon.stub().returns({ eq: () => thenable({ error: null }) });
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable(existingData),
                }),
              }),
              insert: insertSpy,
              update: updateStub,
            };
          }
          return makeChain({});
        },
      };
      // Incoming prompt has no id but matches the deleted row by text+regions.
      // source is part of the match key, so it must carry the same source to match.
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'Same text', regions: ['us'], source: 'gsc' }],
        postgrestClient: client,
      });
      expect(result.updated).to.equal(1);
      expect(result.created).to.equal(0);
      expect(result.skipped).to.equal(0);
      expect(insertSpy.callCount).to.equal(0);
      expect(updateStub.callCount).to.equal(1);
      expect(updateStub.firstCall.args[0].source).to.equal('gsc');
    });

    it('does not reactivate a pending prompt — keeps it skipped', async () => {
      const pendingRow = {
        id: 'row-uuid', prompt_id: 'pend-1', text: 'Pending text', regions: [], status: 'pending',
      };
      const existingData = { data: [pendingRow], error: null };
      const updateStub = sinon.stub().returns({ eq: () => thenable({ error: null }) });
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
              update: updateStub,
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ id: 'pend-1', prompt: 'Pending text', regions: [] }],
        postgrestClient: client,
      });
      expect(result.updated).to.equal(0);
      expect(result.created).to.equal(0);
      expect(result.skipped).to.equal(1);
      expect(updateStub.callCount).to.equal(0);
    });

    it('preserves existing DB intent when reactivating a deleted prompt with no incoming intent', async () => {
      const deletedRow = {
        id: 'row-uuid', prompt_id: 'del-3', text: 'Intent text', regions: [], status: 'deleted', intent: 'brand_awareness',
      };
      const existingData = { data: [deletedRow], error: null };
      const updateStub = sinon.stub().returns({ eq: () => thenable({ error: null }) });
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
              update: updateStub,
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ id: 'del-3', prompt: 'Intent text', regions: [] }],
        postgrestClient: client,
      });
      expect(result.updated).to.equal(1);
      const [[patch]] = updateStub.args;
      expect(patch.intent).to.equal('brand_awareness');
    });

    it('throws on insert error', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
                }),
              }),
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
          id: 'row-id', prompt_id: 'p1', text: 'old', regions: [], status: 'active',
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
      ).to.be.rejectedWith('Failed to update 1 prompt(s): Update failed');
    });

    it('uses toInsert.length when insert returns no data', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
                }),
              }),
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

    it('resolves category and topic names when upserting', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          if (table === 'categories') {
            return makeChain({ data: [{ id: 'cat-uuid', name: 'Photoshop' }], error: null });
          }
          if (table === 'topics') {
            return makeChain({ data: [{ id: 'topic-uuid', name: 'Editing' }], error: null });
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{
          prompt: 'New', regions: ['us'], category: 'Photoshop', topic: 'Editing',
        }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
    });

    it('auto-creates missing categories and topics via ensureLookupEntries', async () => {
      const upsertedRows = {};
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          // buildLookupMaps returns empty arrays → maps will be empty
          // ensureLookupEntries will upsert the missing entries by name
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  neq: () => thenable({ data: [], error: null }),
                }),
              }),
            }),
            upsert: (rows) => {
              // Categories dedup on (organization_id, name) and carry an
              // `origin` field; topics still carry the `topic_id` business
              // key (out of scope for LLMO-5515).
              if (rows[0]?.origin !== undefined) {
                upsertedRows.categories = rows;
              }
              if (rows[0]?.topic_id !== undefined) {
                upsertedRows.topics = rows;
              }
              const data = rows.map((r) => ({
                id: `uuid-${r.name}`,
                name: r.name,
              }));
              return {
                select: () => ({
                  then: (resolve) => resolve({ data, error: null }),
                  catch: () => {},
                }),
              };
            },
          };
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{
          prompt: 'New prompt', regions: ['us'], category: 'New Cat', topic: 'New Topic',
        }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
      // Categories dedup on name only — no category_id business key is set
      // anymore (LLMO-5515); the DB default fills the deprecated column.
      expect(upsertedRows.categories[0].name).to.equal('New Cat');
      expect(upsertedRows.categories[0]).to.not.have.property('category_id');
      // Topics still set the topic_id business key from the name.
      expect(upsertedRows.topics[0].name).to.equal('New Topic');
      expect(upsertedRows.topics[0].topic_id).to.equal('New Topic');
    });

    it('ensureLookupEntries uses normalized name for case-insensitive deduplication', async () => {
      const upsertedRows = {};
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'p-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return {
            // buildLookupMaps: return existing category with title-cased name (legacy)
            // The call is: from(table).select('id,name').eq('organization_id', orgId)
            select: () => ({
              eq: () => thenable({
                data: table === 'categories'
                  ? [{ id: 'existing-uuid', name: 'Brand Awareness' }]
                  : [],
                error: null,
              }),
            }),
            upsert: (rows) => {
              upsertedRows[table] = rows;
              const data = rows.map((r) => ({ id: `uuid-${r.name}`, name: r.name }));
              return {
                select: () => ({
                  then: (resolve) => resolve({ data, error: null }),
                  catch: () => {},
                }),
              };
            },
          };
        },
      };
      await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [
          // "brand awareness" (lowercase) should match existing "Brand Awareness" (title-case)
          { prompt: 'Q1', regions: ['us'], category: 'brand awareness' },
          // "New Topic" doesn't exist yet — should be created
          { prompt: 'Q2', regions: ['us'], topic: 'New Topic' },
        ],
        postgrestClient: client,
      });

      expect(upsertedRows.categories).to.be.undefined;
      // Topic "New Topic" is new — should be upserted with name as topic_id
      expect(upsertedRows.topics).to.be.an('array').with.lengthOf(1);
      expect(upsertedRows.topics[0].name).to.equal('New Topic');
      expect(upsertedRows.topics[0].topic_id).to.equal('New Topic');
    });

    it('falls back to unprefixed slug lookup when category upsert fails', async () => {
      let catCallCount = 0;
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'p-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          if (table === 'categories') {
            catCallCount += 1;
            if (catCallCount === 1) {
              // First call: buildLookupMaps — no existing categories
              return makeChain({ data: [], error: null });
            }
            if (catCallCount === 2) {
              // Second call: upsert fails (name constraint violation)
              return {
                upsert: () => ({
                  select: () => ({
                    then: (resolve) => resolve({ data: null, error: { code: '23505', message: 'unique_violation' } }),
                    catch: () => {},
                  }),
                }),
              };
            }
            // Third call: fallback lookup by unprefixed category_id succeeds
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () => thenable({ data: { id: 'existing-uuid', category_id: 'comparison-decision' }, error: null }),
                  }),
                }),
              }),
            };
          }
          return makeChain({ data: [], error: null });
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'X', regions: [], categoryId: 'baseurl-comparison-decision' }],
        postgrestClient: client,
      });
      // Should succeed — fallback resolved via unprefixed slug "comparison-decision"
      expect(result.created).to.equal(1);
    });

    it('falls back to unprefixed slug lookup when topic upsert fails', async () => {
      let topicCallCount = 0;
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'p-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          if (table === 'topics') {
            topicCallCount += 1;
            if (topicCallCount === 1) {
              return makeChain({ data: [], error: null });
            }
            if (topicCallCount === 2) {
              return {
                upsert: () => ({
                  select: () => ({
                    then: (resolve) => resolve({ data: null, error: { code: '23505', message: 'unique_violation' } }),
                    catch: () => {},
                  }),
                }),
              };
            }
            // Fallback lookup by unprefixed topic_id
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () => thenable({ data: { id: 'existing-uuid', topic_id: 'some-topic' }, error: null }),
                  }),
                }),
              }),
            };
          }
          return makeChain({ data: [], error: null });
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'X', regions: [], topicId: 'gsc-some-topic' }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
    });

    it('warns when category upsert fails', async () => {
      const warnStub = sandbox.stub(console, 'warn');
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'p-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          if (table === 'categories') {
            return {
              select: () => makeChain({ data: [], error: null }),
              upsert: () => ({
                select: () => ({
                  then: (resolve) => resolve({ data: null, error: { code: '42501', message: 'permission denied' } }),
                  catch: () => {},
                }),
              }),
            };
          }
          return makeChain({ data: [], error: null });
        },
      };
      await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'X', regions: [], category: 'Unknown Cat' }],
        postgrestClient: client,
      });
      expect(warnStub.calledOnce).to.be.true;
      expect(warnStub.firstCall.args[0]).to.include('Failed to auto-create categories');
    });

    it('warns when topic upsert fails', async () => {
      const warnStub = sandbox.stub(console, 'warn');
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [{ prompt_id: 'p-1' }], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          if (table === 'topics') {
            return {
              select: () => makeChain({ data: [], error: null }),
              upsert: () => ({
                select: () => ({
                  then: (resolve) => resolve({ data: null, error: { code: '42501', message: 'permission denied' } }),
                  catch: () => {},
                }),
              }),
            };
          }
          return makeChain({ data: [], error: null });
        },
      };
      await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'X', regions: [], topic: 'Unknown Topic' }],
        postgrestClient: client,
      });
      expect(warnStub.calledOnce).to.be.true;
      expect(warnStub.firstCall.args[0]).to.include('Failed to auto-create topics');
    });

    it('warns (does not throw) when category upsert fails with any error', async () => {
      const warnStub = sandbox.stub(console, 'warn');
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          if (table === 'categories') {
            return {
              select: () => makeChain({ data: [], error: null }),
              upsert: () => ({
                select: () => ({
                  then: (resolve) => resolve({ data: null, error: { code: '42501', message: 'permission denied' } }),
                  catch: () => {},
                }),
              }),
            };
          }
          return makeChain({ data: [], error: null });
        },
      };
      // Should not throw — new behavior warns instead of throwing
      await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'X', regions: [], category: 'bad-cat' }],
        postgrestClient: client,
      });
      expect(warnStub.called).to.be.true;
    });

    it('warns (does not throw) when topic upsert fails with any error', async () => {
      const warnStub = sandbox.stub(console, 'warn');
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
                }),
              }),
              insert: () => ({ select: () => thenable({ data: [], error: null }) }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          if (table === 'topics') {
            return {
              select: () => makeChain({ data: [], error: null }),
              upsert: () => ({
                select: () => ({
                  then: (resolve) => resolve({ data: null, error: { code: '42501', message: 'permission denied' } }),
                  catch: () => {},
                }),
              }),
            };
          }
          return makeChain({ data: [], error: null });
        },
      };
      // Should not throw — new behavior warns instead of throwing
      await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'X', regions: [], topic: 'bad-topic' }],
        postgrestClient: client,
      });
      expect(warnStub.called).to.be.true;
    });

    it('handles existing prompts with null regions', async () => {
      const existingData = {
        data: [{
          id: 'row-id', prompt_id: 'p1', text: 'existing', regions: null, status: 'active',
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

    it('falls back gracefully when upsert returns null data (no error)', async () => {
      const warnStub = sandbox.stub(console, 'warn');
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
          if (table === 'categories' || table === 'topics') {
            return {
              select: () => makeChain({ data: [], error: null }),
              // Upsert returns null data (no error) — exercises the `data || []` fallback branch
              upsert: () => ({
                select: () => ({
                  then: (resolve) => resolve({ data: null, error: null }),
                  catch: () => {},
                }),
              }),
            };
          }
          return makeChain({ data: [], error: null });
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{
          prompt: 'Test', regions: ['us'], category: 'Nonexistent Cat', topic: 'Nonexistent Topic',
        }],
        postgrestClient: client,
      });
      // Prompt is still created even though category/topic UUIDs couldn't be resolved
      expect(result.created).to.equal(1);
      expect(warnStub.called).to.be.false;
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

    it('throws a typed 409 when INSERT returns a 23505 unique-constraint error', async () => {
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
              insert: () => ({
                select: () => thenable({
                  data: null,
                  error: {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "uq_prompt_text_region_per_brand"',
                  },
                }),
              }),
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({ data: [], error: null });
        },
      };
      const err = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ id: 'p-1', prompt: 'Synthetic prompt text', regions: ['us'] }],
        postgrestClient: client,
      }).catch((e) => e);
      expect(err).to.be.instanceOf(Error);
      expect(err.status).to.equal(409);
    });

    it('deduplicates duplicate text+regions in toInsert and does not throw', async () => {
      // Mock: >1 row in INSERT → 23505 (simulates uq_prompt_text_region_per_brand);
      // exactly 1 row → success. RED before the intra-batch dedup fix; GREEN after.
      const insertStub = sinon.stub().callsFake((rows) => ({
        select: () => thenable(
          Array.isArray(rows) && rows.length > 1
            ? {
              data: null,
              error: {
                code: '23505',
                message: 'duplicate key value violates unique constraint "uq_prompt_text_region_per_brand"',
              },
            }
            : { data: rows.map((r) => ({ prompt_id: r.prompt_id })), error: null },
        ),
      }));
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
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({ data: [], error: null });
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [
          {
            id: 'p-topic-alpha', prompt: 'Synthetic test prompt text', regions: ['us'], topic: 'Alpha',
          },
          {
            id: 'p-topic-beta', prompt: 'Synthetic test prompt text', regions: ['us'], topic: 'Beta',
          },
        ],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
      expect(result.prompts).to.have.lengthOf(1);
      const insertedRows = insertStub.firstCall.args[0];
      expect(insertedRows).to.have.lengthOf(1);
      // p-topic-alpha wins: both topic_id=null, 'p-topic-alpha' < 'p-topic-beta' alphabetically
      expect(insertedRows[0].prompt_id).to.equal('p-topic-alpha');
    });

    it('dedup-drop fires once per duplicate and splice reduces toInsert to exactly one row', async () => {
      // Three prompts with the same synthetic text+regions. Only the winner
      // (lexicographically first prompt_id when all topic_ids are null) reaches
      // INSERT. The drop path (lines 740-749) fires twice and the splice mutations
      // (lines 755-757) reduce toInsert to 1, covering the uncovered block.
      const warnSpy = sandbox.spy(console, 'warn');
      const toRow = (r) => ({ prompt_id: r.prompt_id });
      const insertStub = sinon.stub().callsFake((rows) => ({
        select: () => thenable({ data: rows.map(toRow), error: null }),
      }));
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
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({ data: [], error: null });
        },
      };
      // Input order is [p-c, p-a, p-b] — winner is always p-a (lex-first prompt_id)
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [
          { id: 'p-c', prompt: 'Synthetic triple-dup text', regions: ['us'] },
          { id: 'p-a', prompt: 'Synthetic triple-dup text', regions: ['us'] },
          { id: 'p-b', prompt: 'Synthetic triple-dup text', regions: ['us'] },
        ],
        postgrestClient: client,
      });

      // one row inserted, two dropped
      expect(result.created).to.equal(1);
      expect(insertStub.firstCall.args[0]).to.have.lengthOf(1);
      expect(insertStub.firstCall.args[0][0].prompt_id).to.equal('p-a');

      // drop-log fired twice — once for each duplicate
      const dropLogs = warnSpy.args.filter(([msg]) => msg === '[upsertPrompts] dedup-drop');
      expect(dropLogs).to.have.lengthOf(2);
      dropLogs.forEach(([, payload]) => {
        expect(payload.winning_prompt_id).to.equal('p-a');
      });
    });

    it('picks winner by (topic_id, promptId) asc regardless of input order', async () => {
      // Two UUIDs with an unambiguous lexicographic ordering: T_ALPHA < T_BETA.
      // The dedup sort key is (topic_id, promptId) asc, so T_ALPHA must always win.
      const T_ALPHA = '00000000-0000-4000-b000-000000000001';
      const T_BETA = 'ffffffff-ffff-4fff-bfff-fffffffffffe';

      const warnSpy = sandbox.spy(console, 'warn');

      // topics table returns both rows pre-populated so topicMap resolves UUIDs
      // immediately and ensureLookupEntries makes no upsert calls.
      // INSERT always succeeds — dedup fires before the row reaches the DB.
      const makeClient = (insertStub) => ({
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
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          if (table === 'topics') {
            return makeChain({
              data: [{ id: T_ALPHA, name: 'Alpha' }, { id: T_BETA, name: 'Beta' }],
              error: null,
            });
          }
          return makeChain({ data: [], error: null });
        },
      });

      const makeInsertStub = () => sinon.stub().callsFake((rows) => ({
        select: () => thenable({
          data: rows.map((r) => ({ prompt_id: r.prompt_id })),
          error: null,
        }),
      }));

      const findDropLog = () => warnSpy.args
        .find(([msg]) => msg === '[upsertPrompts] dedup-drop')?.[1];

      // Pass 1: feed [alpha, beta]
      const stub1 = makeInsertStub();
      const result1 = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [
          {
            id: 'p-alpha', prompt: 'Synthetic dedup tie-break text', regions: ['us'], topic: 'Alpha',
          },
          {
            id: 'p-beta', prompt: 'Synthetic dedup tie-break text', regions: ['us'], topic: 'Beta',
          },
        ],
        postgrestClient: makeClient(stub1),
      });

      // (a) exactly one row reaches INSERT
      expect(stub1.firstCall.args[0]).to.have.lengthOf(1);
      // (b) surviving row carries T_ALPHA
      expect(stub1.firstCall.args[0][0].topic_id).to.equal(T_ALPHA);
      expect(result1.created).to.equal(1);
      // (c) log entry correctly identifies winner and dropped topic_id
      expect(findDropLog()).to.deep.include({
        winning_topic_id: T_ALPHA,
        dropped_topic_id: T_BETA,
      });

      // Pass 2: feed [beta, alpha] — (d) input-order invariance
      warnSpy.resetHistory();
      const stub2 = makeInsertStub();
      const result2 = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [
          {
            id: 'p-beta', prompt: 'Synthetic dedup tie-break text', regions: ['us'], topic: 'Beta',
          },
          {
            id: 'p-alpha', prompt: 'Synthetic dedup tie-break text', regions: ['us'], topic: 'Alpha',
          },
        ],
        postgrestClient: makeClient(stub2),
      });

      expect(stub2.firstCall.args[0]).to.have.lengthOf(1);
      expect(stub2.firstCall.args[0][0].topic_id).to.equal(T_ALPHA);
      expect(result2.created).to.equal(1);
      expect(findDropLog()).to.deep.include({
        winning_topic_id: T_ALPHA,
        dropped_topic_id: T_BETA,
      });
    });

    it('routes case-variant text to update not insert when an active row already exists', async () => {
      // Scenario: DB has "hello world" (lowercase); incoming prompt uses "Hello World" (mixed).
      // The DB constraint uses lower(text), so they collide. getKey must lowercase the text
      // component to match existingByKey correctly and route to toUpdate, not toInsert.
      // RED on current (case-sensitive) getKey: misses existingByKey → INSERT stub is called.
      // GREEN after fix: matches existingByKey → UPDATE path, INSERT stub never reached.
      const existingRow = {
        id: 'row-uuid-existing',
        prompt_id: 'p-existing',
        text: 'hello world',
        regions: ['us'],
        status: 'active',
      };
      const toInsertResult = (rows) => ({
        select: () => thenable({
          data: rows.map((r) => ({ prompt_id: r.prompt_id })),
          error: null,
        }),
      });
      const insertStub = sinon.stub().callsFake(toInsertResult);
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    ...thenable({ data: [existingRow], error: null }),
                    in: () => thenable({ data: [existingRow], error: null }),
                  }),
                }),
              }),
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({ data: [], error: null });
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{ prompt: 'Hello World', regions: ['us'] }],
        postgrestClient: client,
      });
      expect(insertStub.notCalled).to.be.true;
      expect(result.created).to.equal(0);
      expect(result.updated).to.equal(1);
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
          if (table === 'categories') {
            return makeChain({ data: { id: 'cat-uuid' }, error: null });
          }
          if (table === 'topics') {
            return makeChain({ data: { id: 'topic-uuid' }, error: null });
          }
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

    it('persists normalized intent on update (lowercases and remaps)', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Text',
        regions: [],
        status: 'active',
        origin: 'human',
        intent: 'transactional',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const updateStub = sinon.stub().returns({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: () => thenable({ data: row, error: null }) }),
            }),
          }),
        }),
      });
      const client = {
        from: () => ({
          update: updateStub,
          select: () => makeChain({ data: row, error: null }).select(),
        }),
      };
      const result = await updatePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        updates: { intent: 'COMMERCIAL' },
        postgrestClient: client,
      });
      expect(updateStub.firstCall.args[0].intent).to.equal('transactional');
      expect(result.intent).to.equal('transactional');
    });

    it('sets intent to null on update when value is empty or invalid', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'Test',
        text: 'Text',
        regions: [],
        status: 'active',
        origin: 'human',
        intent: null,
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const updateStub = sinon.stub().returns({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: () => thenable({ data: row, error: null }) }),
            }),
          }),
        }),
      });
      const client = {
        from: () => ({
          update: updateStub,
          select: () => makeChain({ data: row, error: null }).select(),
        }),
      };
      const result = await updatePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        updates: { intent: 'bogus' },
        postgrestClient: client,
      });
      expect(Object.prototype.hasOwnProperty.call(updateStub.firstCall.args[0], 'intent')).to.be.true;
      expect(updateStub.firstCall.args[0].intent).to.be.null;
      expect(result.intent).to.be.null;
    });

    it('classifies new text on update when no intent is supplied', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'T',
        text: 'Figma vs Sketch',
        regions: [],
        status: 'active',
        origin: 'human',
        intent: 'comparative',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const updateStub = sinon.stub().returns({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: () => thenable({ data: row, error: null }) }),
            }),
          }),
        }),
      });
      const client = {
        from: () => ({
          update: updateStub,
          select: () => makeChain({ data: row, error: null }).select(),
        }),
      };
      const classifyIntent = sinon.stub().resolves('comparative');
      await updatePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        updates: { prompt: 'Figma vs Sketch' },
        postgrestClient: client,
        classifyIntent,
      });
      expect(classifyIntent.calledOnceWith('Figma vs Sketch')).to.be.true;
      expect(updateStub.firstCall.args[0].intent).to.equal('comparative');
    });

    it('does NOT classify on update when an intent is explicitly supplied', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'T',
        text: 'Text',
        regions: [],
        status: 'active',
        origin: 'human',
        intent: 'transactional',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const updateStub = sinon.stub().returns({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: () => thenable({ data: row, error: null }) }),
            }),
          }),
        }),
      });
      const client = {
        from: () => ({
          update: updateStub,
          select: () => makeChain({ data: row, error: null }).select(),
        }),
      };
      const classifyIntent = sinon.stub().resolves('comparative');
      await updatePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        updates: { prompt: 'new text', intent: 'transactional' },
        postgrestClient: client,
        classifyIntent,
      });
      expect(classifyIntent.called).to.be.false;
      expect(updateStub.firstCall.args[0].intent).to.equal('transactional');
    });

    it('leaves intent unset on update when classification rejects', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'T',
        text: 'Text',
        regions: [],
        status: 'active',
        origin: 'human',
        intent: null,
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const updateStub = sinon.stub().returns({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: () => thenable({ data: row, error: null }) }),
            }),
          }),
        }),
      });
      const client = {
        from: () => ({
          update: updateStub,
          select: () => makeChain({ data: row, error: null }).select(),
        }),
      };
      const classifyIntent = sinon.stub().rejects(new Error('LLM down'));
      const result = await updatePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        updates: { prompt: 'new text' },
        postgrestClient: client,
        classifyIntent,
      });
      expect(result).to.not.be.null;
      expect(Object.prototype.hasOwnProperty.call(updateStub.firstCall.args[0], 'intent')).to.be.false;
    });

    it('does NOT classify on update when only non-text fields change', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        name: 'New name',
        text: 'Text',
        regions: [],
        status: 'active',
        origin: 'human',
        intent: null,
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      const updateStub = sinon.stub().returns({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: () => thenable({ data: row, error: null }) }),
            }),
          }),
        }),
      });
      const client = {
        from: () => ({
          update: updateStub,
          select: () => makeChain({ data: row, error: null }).select(),
        }),
      };
      const classifyIntent = sinon.stub().resolves('comparative');
      await updatePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        updates: { name: 'New name' },
        postgrestClient: client,
        classifyIntent,
      });
      // No text change and no explicit intent -> classifier must not be invoked.
      expect(classifyIntent.called).to.be.false;
      expect(Object.prototype.hasOwnProperty.call(updateStub.firstCall.args[0], 'intent')).to.be.false;
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
      created_at: '2026-01-01T00:00:00Z',
      created_by: 'system',
      updated_at: '2026-01-01T00:00:00Z',
      updated_by: 'system',
      brands: { id: BRAND_UUID, name: 'Brand' },
      categories: null,
      topics: null,
    };

    it('passes search param through to query', async () => {
      const client = {
        from: (table) => {
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
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
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
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
        prompts: [{ prompt: 'New prompt', regions: ['us'], source: 'sheet' }],
        postgrestClient: client,
      });
      expect(result.prompts[0].source).to.equal('sheet');
      expect(result.prompts[0].createdAt).to.be.undefined;
      expect(result.prompts[0].createdBy).to.be.undefined;
    });

    it('defaults source to config when not provided', async () => {
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => thenable({ data: [], error: null }),
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
          if (callCount === 1) {
            return makeChain({ data: { id: 'row-id' }, error: null });
          }
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

  describe('checkPromptsExist', () => {
    const PROMPTS = [
      { text: 'What are generative credits?', region: 'gb' },
      { text: 'should not exist', region: 'tw' },
    ];

    it('throws when postgrestClient has no rpc', async () => {
      await expect(
        checkPromptsExist({
          brandUuid: BRAND_UUID,
          prompts: PROMPTS,
          postgrestClient: null,
        }),
      ).to.be.rejectedWith('PostgREST client is required');
    });

    it('returns empty array when RPC returns null data', async () => {
      const client = { rpc: sandbox.stub().resolves({ data: null, error: null }) };
      const result = await checkPromptsExist({
        brandUuid: BRAND_UUID,
        prompts: PROMPTS,
        postgrestClient: client,
      });
      expect(result).to.deep.equal([]);
    });

    it('returns matching pairs on success', async () => {
      const expected = [{ text: 'What are generative credits?', region: 'gb' }];
      const client = { rpc: sandbox.stub().resolves({ data: expected, error: null }) };
      const result = await checkPromptsExist({
        brandUuid: BRAND_UUID,
        prompts: PROMPTS,
        postgrestClient: client,
      });
      expect(result).to.deep.equal(expected);
      const [rpcName, rpcArgs] = client.rpc.firstCall.args;
      expect(rpcName).to.equal('rpc_check_prompts_exist');
      expect(rpcArgs.p_brand_id).to.equal(BRAND_UUID);
      expect(rpcArgs.p_prompts).to.deep.equal(PROMPTS);
    });

    it('throws when RPC returns an error', async () => {
      const client = { rpc: sandbox.stub().resolves({ data: null, error: { message: 'DB error' } }) };
      await expect(
        checkPromptsExist({
          brandUuid: BRAND_UUID,
          prompts: PROMPTS,
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('checkPromptsExist RPC failed: DB error');
    });
  });

  describe('getPromptStats', () => {
    const ALL_ZERO_INTENTS = {
      informational: 0,
      instructional: 0,
      comparative: 0,
      transactional: 0,
      planning: 0,
      delegation: 0,
    };

    it('throws when postgrestClient has no rpc', async () => {
      await expect(
        getPromptStats({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          postgrestClient: null,
        }),
      ).to.be.rejectedWith('PostgREST client is required');
    });

    it('throws when RPC returns an error', async () => {
      const client = { rpc: sandbox.stub().resolves({ data: null, error: { message: 'RPC failed' } }) };
      await expect(
        getPromptStats({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('getPromptStats RPC failed: RPC failed');
    });

    it('returns all-zero shape when RPC returns null data', async () => {
      const client = { rpc: sandbox.stub().resolves({ data: null, error: null }) };
      const result = await getPromptStats({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result).to.deep.equal({ branded: 0, unbranded: 0, intents: ALL_ZERO_INTENTS });
    });

    it('returns all-zero shape when RPC returns an empty array', async () => {
      const client = { rpc: sandbox.stub().resolves({ data: [], error: null }) };
      const result = await getPromptStats({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result).to.deep.equal({ branded: 0, unbranded: 0, intents: ALL_ZERO_INTENTS });
    });

    it('transforms flat intent_* RPC fields into nested intents object', async () => {
      const row = {
        branded: 42,
        unbranded: 1208,
        intent_informational: 410,
        intent_instructional: 180,
        intent_comparative: 95,
        intent_transactional: 250,
        intent_planning: 60,
        intent_delegation: 15,
      };
      const client = { rpc: sandbox.stub().resolves({ data: row, error: null }) };
      const result = await getPromptStats({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result).to.deep.equal({
        branded: 42,
        unbranded: 1208,
        intents: {
          informational: 410,
          instructional: 180,
          comparative: 95,
          transactional: 250,
          planning: 60,
          delegation: 15,
        },
      });
      const [rpcName, rpcArgs] = client.rpc.firstCall.args;
      expect(rpcName).to.equal('rpc_brand_prompt_stats');
      expect(rpcArgs.p_organization_id).to.equal(ORG_ID);
      expect(rpcArgs.p_brand_id).to.equal(BRAND_UUID);
    });

    it('transforms flat intent_* fields from an array RPC response', async () => {
      const row = {
        branded: 5,
        unbranded: 10,
        intent_informational: 3,
        intent_instructional: 2,
        intent_comparative: 0,
        intent_transactional: 0,
        intent_planning: 0,
        intent_delegation: 0,
      };
      const client = { rpc: sandbox.stub().resolves({ data: [row], error: null }) };
      const result = await getPromptStats({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result).to.deep.equal({
        branded: 5,
        unbranded: 10,
        intents: {
          informational: 3,
          instructional: 2,
          comparative: 0,
          transactional: 0,
          planning: 0,
          delegation: 0,
        },
      });
    });

    it('defaults all intent keys to 0 when intent fields are absent', async () => {
      const client = {
        rpc: sandbox.stub().resolves({ data: { branded: 3, unbranded: 7 }, error: null }),
      };
      const result = await getPromptStats({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result).to.deep.equal({ branded: 3, unbranded: 7, intents: ALL_ZERO_INTENTS });
    });

    it('ignores unknown intent_* fields from the RPC', async () => {
      const client = {
        rpc: sandbox.stub().resolves({
          data: {
            branded: 1,
            unbranded: 1,
            intent_informational: 5,
            intent_unknown_future: 99,
          },
          error: null,
        }),
      };
      const result = await getPromptStats({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result.intents).to.not.have.property('unknown_future');
      expect(result.intents.informational).to.equal(5);
    });

    it('correctly coerces stringified bigint values returned by PostgREST', async () => {
      const client = {
        rpc: sandbox.stub().resolves({
          data: { branded: '42', unbranded: '1208', intent_informational: '410' },
          error: null,
        }),
      };
      const result = await getPromptStats({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: client,
      });
      expect(result.branded).to.equal(42);
      expect(result.unbranded).to.equal(1208);
      expect(result.intents.informational).to.equal(410);
    });
  });

  // Best-effort behavior against environments where `prompts.intent` is absent
  // (the IT PostgREST image is pinned to a data-service version predating the
  // intent migration). Writing/reading `intent` there 500s with a missing-
  // column error; the storage layer detects this per-client (WeakMap) and
  // retries without intent so prompts still persist/read.
  describe('getIntentsByPromptIds', () => {
    const MISSING_INTENT = { code: '42703', message: 'column prompts.intent does not exist' };
    // `.in()` result is awaitable and also chains `.eq()` (for the org predicate).
    const clientReturning = (result, inStub) => ({
      from: () => ({
        select: () => ({
          in: inStub || (() => ({ ...thenable(result), eq: () => thenable(result) })),
        }),
      }),
    });

    it('returns an empty Map for empty/nullish ids or no client', async () => {
      const client = clientReturning({ data: [], error: null });
      const sizeFor = async (args) => (await getIntentsByPromptIds(args)).size;
      expect(await sizeFor({ promptIds: [], postgrestClient: client })).to.equal(0);
      expect(await sizeFor({ promptIds: [null, undefined], postgrestClient: client })).to.equal(0);
      expect(await sizeFor({ promptIds: ['p1'], postgrestClient: {} })).to.equal(0);
    });

    it('maps intent by id, dedupes ids, and skips null/empty intents', async () => {
      const inStub = sinon.stub().returns(thenable({
        data: [
          { id: 'p1', intent: 'Commercial' },
          { id: 'p2', intent: null },
          { id: 'p3', intent: '' },
        ],
        error: null,
      }));
      const client = clientReturning(null, inStub);
      const map = await getIntentsByPromptIds({
        promptIds: ['p1', 'p1', 'p2', 'p3', null], postgrestClient: client,
      });
      expect(map.get('p1')).to.equal('Commercial');
      expect(map.has('p2')).to.equal(false);
      expect(map.has('p3')).to.equal(false);
      // Deduped to the 3 distinct non-null ids.
      expect(inStub.firstCall.args[1]).to.deep.equal(['p1', 'p2', 'p3']);
    });

    it('scopes the lookup by organizationId when provided', async () => {
      const eqStub = sinon.stub().returns(
        thenable({ data: [{ id: 'p1', intent: 'Commercial' }], error: null }),
      );
      const inStub = sinon.stub().returns({ eq: eqStub });
      const client = clientReturning(null, inStub);
      const map = await getIntentsByPromptIds({
        promptIds: ['p1'], organizationId: 'org-1', postgrestClient: client,
      });
      expect(map.get('p1')).to.equal('Commercial');
      expect(eqStub.calledOnceWithExactly('organization_id', 'org-1')).to.equal(true);
    });

    it('chunks large id lists into multiple bounded queries', async () => {
      const inStub = sinon.stub().returns(thenable({ data: [], error: null }));
      const client = clientReturning(null, inStub);
      const ids = Array.from({ length: 250 }, (_, i) => `p${i}`);
      await getIntentsByPromptIds({ promptIds: ids, postgrestClient: client });
      // 250 ids / 100 per batch → 3 queries, each within the chunk size.
      expect(inStub.callCount).to.equal(3);
      expect(inStub.getCalls().map((c) => c.args[1].length)).to.deep.equal([100, 100, 50]);
    });

    it('logs at debug (not warn) when the intent column is absent, and does not retry', async () => {
      const inStub = sinon.stub().returns(thenable({ data: null, error: MISSING_INTENT }));
      const client = clientReturning(null, inStub);
      const log = { debug: sinon.stub(), warn: sinon.stub() };
      const map = await getIntentsByPromptIds({ promptIds: ['p1'], postgrestClient: client, log });
      expect(map.size).to.equal(0);
      expect(inStub.callCount).to.equal(1);
      expect(log.debug.called).to.equal(true);
      expect(log.warn.called).to.equal(false);
    });

    it('logs at warn (not debug) on a non-missing-column error, returning empty', async () => {
      const inStub = sinon.stub().returns(thenable({ data: null, error: { message: 'timeout' } }));
      const client = clientReturning(null, inStub);
      const log = { debug: sinon.stub(), warn: sinon.stub() };
      const map = await getIntentsByPromptIds({ promptIds: ['p1'], postgrestClient: client, log });
      expect(map.size).to.equal(0);
      expect(log.warn.called).to.equal(true);
      expect(log.debug.called).to.equal(false);
    });
  });

  describe('intent column best-effort fallback', () => {
    const MISSING_INTENT_INSERT = {
      code: 'PGRST204',
      message: "Could not find the 'intent' column of 'prompts' in the schema cache",
    };
    const MISSING_INTENT_SELECT = {
      code: '42703',
      message: 'column prompts.intent does not exist',
    };

    it('upsertPrompts inserts without intent when the column is missing, then retries clean', async () => {
      const insertStub = sinon.stub();
      // First insert (with intent) -> missing-column error; retry -> success.
      insertStub.onFirstCall().returns({
        select: () => thenable({ data: null, error: MISSING_INTENT_INSERT }),
      });
      insertStub.onSecondCall().returns({
        select: () => thenable({ data: [{ prompt_id: 'new-1' }], error: null }),
      });
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
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{
          id: 'a', prompt: 'hello', regions: [], intent: 'informational',
        }],
        postgrestClient: client,
      });
      expect(result.created).to.equal(1);
      expect(insertStub.callCount).to.equal(2);
      // First attempt carried intent; retry stripped it.
      expect(insertStub.firstCall.args[0][0]).to.have.property('intent', 'informational');
      expect(insertStub.secondCall.args[0][0]).to.not.have.property('intent');
    });

    it('upsertPrompts skips intent up front on a second call with the same client', async () => {
      const insertStub = sinon.stub();
      insertStub.onCall(0).returns({
        select: () => thenable({ data: null, error: MISSING_INTENT_INSERT }),
      });
      insertStub.onCall(1).returns({
        select: () => thenable({ data: [{ prompt_id: 'p1' }], error: null }),
      });
      insertStub.onCall(2).returns({
        select: () => thenable({ data: [{ prompt_id: 'p2' }], error: null }),
      });
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
              insert: insertStub,
              update: () => ({ eq: () => thenable({ error: null }) }),
            };
          }
          return makeChain({});
        },
      };
      const args = {
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: client,
      };
      await upsertPrompts({ ...args, prompts: [{ id: 'p1', prompt: 'x', intent: 'planning' }] });
      await upsertPrompts({ ...args, prompts: [{ id: 'p2', prompt: 'y', intent: 'planning' }] });
      // 2 calls for the first upsert (error + retry), 1 for the second (no error).
      expect(insertStub.callCount).to.equal(3);
      expect(insertStub.getCall(2).args[0][0]).to.not.have.property('intent');
    });

    it('upsertPrompts updates without intent when the column is missing, then retries clean', async () => {
      const existingData = {
        data: [{
          id: 'row-id', prompt_id: 'p1', text: 'old', regions: [], status: 'active',
        }],
        error: null,
      };
      const updateStub = sinon.stub();
      updateStub.onFirstCall().returns({ eq: () => thenable({ error: MISSING_INTENT_INSERT }) });
      updateStub.onSecondCall().returns({ eq: () => thenable({ error: null }) });
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
              update: updateStub,
            };
          }
          return makeChain({});
        },
      };
      const result = await upsertPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        prompts: [{
          id: 'p1', prompt: 'Updated', regions: [], intent: 'transactional',
        }],
        postgrestClient: client,
      });
      expect(result.updated).to.equal(1);
      expect(updateStub.callCount).to.equal(2);
      expect(updateStub.firstCall.args[0]).to.have.property('intent', 'transactional');
      expect(updateStub.secondCall.args[0]).to.not.have.property('intent');
    });

    it('upsertPrompts update-loop strips intent up front on a second call with the same client', async () => {
      const existingData = {
        data: [{
          id: 'row-id', prompt_id: 'p1', text: 'old', regions: [], status: 'active',
        }],
        error: null,
      };
      const updateStub = sinon.stub();
      // Call 0: with-intent error, Call 1: retry success (marks unsupported),
      // Call 2: second upsert's update goes straight to the stripped patch.
      updateStub.onCall(0).returns({ eq: () => thenable({ error: MISSING_INTENT_INSERT }) });
      updateStub.onCall(1).returns({ eq: () => thenable({ error: null }) });
      updateStub.onCall(2).returns({ eq: () => thenable({ error: null }) });
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
              update: updateStub,
            };
          }
          return makeChain({});
        },
      };
      const args = {
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: client,
      };
      await upsertPrompts({
        ...args,
        prompts: [{
          id: 'p1', prompt: 'Updated', regions: [], intent: 'transactional',
        }],
      });
      await upsertPrompts({
        ...args,
        prompts: [{
          id: 'p1', prompt: 'Updated again', regions: [], intent: 'planning',
        }],
      });
      // 2 update calls for the first upsert (error + retry), 1 for the second.
      expect(updateStub.callCount).to.equal(3);
      // Known-unsupported client: the second upsert's update patch carries no intent.
      expect(updateStub.getCall(2).args[0]).to.not.have.property('intent');
    });

    it('listPrompts retries the select without intent when the column is missing', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        text: 'Prompt',
        regions: ['us'],
        status: 'active',
        origin: 'human',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      let promptCall = 0;
      const client = {
        from: (table) => {
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
          promptCall += 1;
          // First select (with intent) errors; retry (without intent) succeeds.
          return promptCall === 1
            ? makeChain({ data: null, error: MISSING_INTENT_SELECT, count: null })
            : makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const result = await listPrompts({
        organizationId: ORG_ID,
        brandId: BRAND_UUID,
        postgrestClient: client,
      });
      expect(promptCall).to.equal(2);
      expect(result.items).to.have.lengthOf(1);
      expect(result.items[0].intent).to.be.null;
    });

    it('listPrompts skips intent up front on a second call with the same client', async () => {
      const row = {
        prompt_id: PROMPT_ID,
        text: 'Prompt',
        regions: [],
        status: 'active',
        origin: 'human',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      let promptCall = 0;
      const client = {
        from: (table) => {
          if (table === 'brands') {
            return makeChain({ data: { id: BRAND_UUID }, error: null });
          }
          promptCall += 1;
          return promptCall === 1
            ? makeChain({ data: null, error: MISSING_INTENT_SELECT, count: null })
            : makeChain({ data: [row], error: null, count: 1 });
        },
      };
      const args = { organizationId: ORG_ID, brandId: BRAND_UUID, postgrestClient: client };
      await listPrompts(args);
      await listPrompts(args);
      // Call 1: with-intent error, Call 2: retry, Call 3: second list goes
      // straight to no-intent (no error) — 3 total, not 4.
      expect(promptCall).to.equal(3);
    });

    it('getPromptById retries the select without intent when the column is missing', async () => {
      const row = {
        id: 'pk-uuid',
        prompt_id: PROMPT_ID,
        text: 'Prompt',
        regions: [],
        status: 'active',
        origin: 'human',
        brands: { id: BRAND_UUID, name: 'Brand' },
        categories: null,
        topics: null,
      };
      let call = 0;
      const client = {
        from: () => {
          call += 1;
          return call === 1
            ? makeChain({ data: null, error: MISSING_INTENT_SELECT })
            : makeChain({ data: row, error: null });
        },
      };
      const result = await getPromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        postgrestClient: client,
      });
      expect(call).to.equal(2);
      expect(result).to.not.be.null;
      expect(result.intent).to.be.null;
    });

    it('still throws on a non-intent query error (no spurious retry)', async () => {
      let call = 0;
      const client = {
        from: () => {
          call += 1;
          return makeChain({ data: null, error: { message: 'DB exploded' } });
        },
      };
      await expect(
        getPromptById({
          organizationId: ORG_ID,
          brandUuid: BRAND_UUID,
          promptId: PROMPT_ID,
          postgrestClient: client,
        }),
      ).to.be.rejectedWith('Failed to get prompt');
      // No retry for a non-intent error.
      expect(call).to.equal(1);
    });

    describe('isMissingIntentColumnError', () => {
      it('returns false for a null/undefined/falsy error', () => {
        // Covers the defensive early-return guard; in production every call site
        // is `error && isMissingIntentColumnError(error)`, so exercise it directly.
        expect(isMissingIntentColumnError(null)).to.be.false;
        expect(isMissingIntentColumnError(undefined)).to.be.false;
        expect(isMissingIntentColumnError(0)).to.be.false;
      });

      it('matches the insert/upsert missing-column error (PGRST204, schema cache)', () => {
        expect(isMissingIntentColumnError(MISSING_INTENT_INSERT)).to.be.true;
      });

      it('matches the select missing-column error (42703, column does not exist)', () => {
        expect(isMissingIntentColumnError(MISSING_INTENT_SELECT)).to.be.true;
      });

      it('does not match a generic error mentioning neither intent nor column', () => {
        expect(isMissingIntentColumnError({ message: 'DB exploded' })).to.be.false;
      });

      it('does not match an intent-mentioning error without a missing-column code', () => {
        // "intent" present but no 42703/PGRST204 code — must NOT be swallowed.
        expect(isMissingIntentColumnError({ message: 'invalid intent value supplied' })).to.be.false;
      });

      it('does not match a missing-column code for a different column', () => {
        // Correct code, but the column is not `intent` — must NOT latch the fallback.
        expect(isMissingIntentColumnError({ code: '42703', message: 'column prompts.status does not exist' })).to.be.false;
      });

      it('does not match a check-constraint violation that mentions intent and column', () => {
        // Regression (PR #2562 review): a future constraint error like
        // "column intent violates check constraint" carries a non-missing-column
        // code (e.g. 23514). Gating on the code prevents a false positive that
        // would latch the fallback off and silently drop intent.
        expect(isMissingIntentColumnError({
          code: '23514',
          message: 'new row violates check constraint; column intent ...',
        })).to.be.false;
      });
    });

    it('updatePromptById updates without intent when the column is missing, then retries clean', async () => {
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
      const updateStub = sinon.stub();
      const updateChain = (result) => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({ select: () => ({ maybeSingle: () => thenable(result) }) }),
          }),
        }),
      });
      // First update (with intent) -> missing-column error; retry -> success.
      updateStub.onFirstCall().returns(updateChain({ data: null, error: MISSING_INTENT_INSERT }));
      updateStub.onSecondCall().returns(updateChain({ data: row, error: null }));
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return { update: updateStub, select: () => makeChain({ data: row, error: null }) };
          }
          return makeChain({ data: row, error: null });
        },
      };
      const result = await updatePromptById({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        updates: { prompt: 'Updated', intent: 'transactional' },
        postgrestClient: client,
      });
      expect(result).to.not.be.null;
      expect(updateStub.callCount).to.equal(2);
      // First attempt carried intent; retry stripped it.
      expect(updateStub.firstCall.args[0]).to.have.property('intent', 'transactional');
      expect(updateStub.secondCall.args[0]).to.not.have.property('intent');
    });

    it('updatePromptById skips intent up front on a second call with the same client', async () => {
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
      const updateStub = sinon.stub();
      const updateChain = (result) => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({ select: () => ({ maybeSingle: () => thenable(result) }) }),
          }),
        }),
      });
      // Call 0: with-intent error, Call 1: retry success, Call 2: second update
      // for the same client never carries intent (known-unsupported pre-strip).
      updateStub.onCall(0).returns(updateChain({ data: null, error: MISSING_INTENT_INSERT }));
      updateStub.onCall(1).returns(updateChain({ data: row, error: null }));
      updateStub.onCall(2).returns(updateChain({ data: row, error: null }));
      const client = {
        from: (table) => {
          if (table === 'prompts') {
            return { update: updateStub, select: () => makeChain({ data: row, error: null }) };
          }
          return makeChain({ data: row, error: null });
        },
      };
      const args = {
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        promptId: PROMPT_ID,
        postgrestClient: client,
      };
      await updatePromptById({ ...args, updates: { prompt: 'a', intent: 'planning' } });
      await updatePromptById({ ...args, updates: { prompt: 'b', intent: 'planning' } });
      // 2 update calls for the first (error + retry), 1 for the second (no error).
      expect(updateStub.callCount).to.equal(3);
      // Known-unsupported client: intent never set on the patch up front, so the
      // second update's patch carries no `intent` key.
      expect(updateStub.getCall(2).args[0]).to.not.have.property('intent');
    });
  });

  describe('findPromptsBlockingRegionRemoval (LLMO-5645)', () => {
    // Read-only mock: the consistency check fetches non-deleted prompts and
    // counts, per removed region, how many still reference it.
    function makeReadClient(promptRows, opts = {}) {
      return {
        from: () => ({
          select() { return this; },
          eq() { return this; },
          neq() { return this; },
          limit() {
            return Promise.resolve(
              opts.error ? { data: null, error: opts.error } : { data: promptRows, error: null },
            );
          },
        }),
      };
    }

    it('returns empty when no region is removed (new set is a superset)', async () => {
      const result = await findPromptsBlockingRegionRemoval({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        oldRegions: ['US'],
        newRegions: ['US', 'DE'],
        postgrestClient: makeReadClient([{ id: 'p1', regions: ['US'] }]),
      });
      expect(result).to.deep.equal({});
    });

    it('returns empty when a removed region has no prompts using it', async () => {
      const result = await findPromptsBlockingRegionRemoval({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        oldRegions: ['US', 'DE'],
        newRegions: ['US'],
        postgrestClient: makeReadClient([
          { id: 'p1', regions: ['US'] },
          { id: 'p2', regions: ['US'] },
        ]),
      });
      expect(result).to.deep.equal({});
    });

    it('counts prompts still using a removed region (incl. multi-market prompts)', async () => {
      const result = await findPromptsBlockingRegionRemoval({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        oldRegions: ['US', 'DE'],
        newRegions: ['US'],
        postgrestClient: makeReadClient([
          { id: 'p1', regions: ['US', 'DE'] }, // multi-market → still references DE
          { id: 'p2', regions: ['DE'] }, // DE-only
          { id: 'p3', regions: ['de'] }, // case-insensitive
          { id: 'p4', regions: ['US'] }, // unaffected
          { id: 'p5', regions: null }, // non-array → normalized to [], ignored
        ]),
      });
      expect(result).to.deep.equal({ de: 3 });
    });

    it('counts each removed region independently when several are stripped at once', async () => {
      const result = await findPromptsBlockingRegionRemoval({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        oldRegions: ['US', 'DE', 'FR'],
        newRegions: ['US'],
        postgrestClient: makeReadClient([
          { id: 'p1', regions: ['DE'] },
          { id: 'p2', regions: ['FR'] },
          { id: 'p3', regions: ['DE', 'FR'] }, // counts toward both
        ]),
      });
      expect(result).to.deep.equal({ de: 2, fr: 2 });
    });

    it('treats WW like any other region (strict — blocks WW removal)', async () => {
      const result = await findPromptsBlockingRegionRemoval({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        oldRegions: ['WW'],
        newRegions: ['US'],
        postgrestClient: makeReadClient([
          { id: 'p1', regions: ['WW'] },
          { id: 'p2', regions: ['ww'] },
        ]),
      });
      expect(result).to.deep.equal({ ww: 2 });
    });

    it('throws when the PostgREST client is missing', async () => {
      await expect(findPromptsBlockingRegionRemoval({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        oldRegions: ['WW'],
        newRegions: ['US'],
        postgrestClient: {},
      })).to.be.rejectedWith('PostgREST client is required');
    });

    it('throws when the prompt read fails', async () => {
      await expect(findPromptsBlockingRegionRemoval({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        oldRegions: ['US', 'DE'],
        newRegions: ['US'],
        postgrestClient: makeReadClient(null, { error: { message: 'read boom' } }),
      })).to.be.rejectedWith('Failed to read prompts for region consistency check: read boom');
    });

    it('warns when the brand exceeds the read cap', async () => {
      const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `p${i}`, regions: ['US'] }));
      const warn = sinon.spy();
      const result = await findPromptsBlockingRegionRemoval({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        oldRegions: ['US', 'DE'],
        newRegions: ['US'],
        postgrestClient: makeReadClient(rows),
        log: { warn },
      });
      expect(result).to.deep.equal({});
      expect(warn.calledOnce).to.equal(true);
    });
  });
});
