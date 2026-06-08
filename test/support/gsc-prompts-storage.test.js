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
  upsertGscPrompts,
  listGscPrompts,
} from '../../src/support/gsc-prompts-storage.js';

use(chaiAsPromised);

describe('gsc-prompts-storage', () => {
  const sandbox = sinon.createSandbox();
  const ORG_ID = '11111111-1111-4111-b111-111111111111';
  const BRAND_UUID = 'd1111111-1111-4111-b111-111111111111';
  const ROW_ID = 'aa111111-1111-4111-b111-111111111111';

  const thenable = (v) => ({ then: (resolve) => resolve(v), catch: () => thenable(v) });

  afterEach(() => sandbox.restore());

  describe('upsertGscPrompts', () => {
    it('throws when postgrestClient is missing .from', async () => {
      await expect(upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [{
          text: 'a', region: 'us', source: 'gsc', status: 'ignored',
        }],
        postgrestClient: {},
      })).to.be.rejectedWith('PostgREST client is required');
    });

    it('returns zero counts when items is empty', async () => {
      const result = await upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [],
        postgrestClient: { from: () => ({}) },
      });
      expect(result).to.deep.equal({
        created: 0, updated: 0, skipped: 0, items: [],
      });
    });

    it('throws when text is missing', async () => {
      await expect(upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [{
          text: '', region: 'us', source: 'gsc', status: 'ignored',
        }],
        postgrestClient: { from: () => ({}) },
      })).to.be.rejectedWith(/text/);
    });

    it('throws when region is missing', async () => {
      await expect(upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [{
          text: 'a', region: '', source: 'gsc', status: 'ignored',
        }],
        postgrestClient: { from: () => ({}) },
      })).to.be.rejectedWith(/region/);
    });

    it('throws when source is missing', async () => {
      await expect(upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [{
          text: 'a', region: 'us', source: '', status: 'ignored',
        }],
        postgrestClient: { from: () => ({}) },
      })).to.be.rejectedWith(/source/);
    });

    it('throws when status is invalid', async () => {
      await expect(upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [{
          text: 'a', region: 'us', source: 'gsc', status: 'rejected',
        }],
        postgrestClient: { from: () => ({}) },
      })).to.be.rejectedWith(/status must be one of/);
    });

    it('inserts a new row when no match exists', async () => {
      const insertedRow = {
        id: ROW_ID,
        prompt_text: 'New prompt',
        region_code: 'us',
        source: 'gsc',
        status: 'ignored',
        created_at: '2026-06-08T00:00:00Z',
        created_by: 'user@test.com',
        updated_at: '2026-06-08T00:00:00Z',
        updated_by: 'user@test.com',
      };
      const client = {
        from: () => ({
          select: () => ({ eq: () => thenable({ data: [], error: null }) }),
          insert: () => ({ select: () => thenable({ data: [insertedRow], error: null }) }),
        }),
      };

      const result = await upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [{
          text: 'New prompt', region: 'US', source: 'gsc', status: 'ignored',
        }],
        postgrestClient: client,
        createdBy: 'user@test.com',
      });

      expect(result.created).to.equal(1);
      expect(result.updated).to.equal(0);
      expect(result.skipped).to.equal(0);
      expect(result.items[0].status).to.equal('ignored');
    });

    it('skips when an existing row already has the requested status', async () => {
      const existingRow = {
        id: ROW_ID,
        prompt_text: 'Existing',
        region_code: 'us',
        source: 'gsc',
        status: 'ignored',
      };
      const client = {
        from: () => ({
          select: () => ({ eq: () => thenable({ data: [existingRow], error: null }) }),
        }),
      };

      const result = await upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [{
          text: 'existing', region: 'us', source: 'gsc', status: 'ignored',
        }],
        postgrestClient: client,
      });

      expect(result.created).to.equal(0);
      expect(result.updated).to.equal(0);
      expect(result.skipped).to.equal(1);
    });

    it('updates status in place when an existing row has a different status', async () => {
      const existingRow = {
        id: ROW_ID,
        prompt_text: 'Existing',
        region_code: 'us',
        source: 'gsc',
        status: 'added',
      };
      const updatedRow = { ...existingRow, status: 'ignored', updated_by: 'user@test.com' };
      const client = {
        from: () => ({
          select: () => ({ eq: () => thenable({ data: [existingRow], error: null }) }),
          update: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: () => thenable({ data: updatedRow, error: null }) }),
            }),
          }),
        }),
      };

      const result = await upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [{
          text: 'existing', region: 'us', source: 'gsc', status: 'ignored',
        }],
        postgrestClient: client,
        createdBy: 'user@test.com',
      });

      expect(result.created).to.equal(0);
      expect(result.updated).to.equal(1);
      expect(result.skipped).to.equal(0);
      expect(result.items[0].status).to.equal('ignored');
    });

    it('throws when the existing-fetch errors', async () => {
      const client = {
        from: () => ({
          select: () => ({ eq: () => thenable({ data: null, error: { message: 'db down' } }) }),
        }),
      };
      await expect(upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [{
          text: 'a', region: 'us', source: 'gsc', status: 'ignored',
        }],
        postgrestClient: client,
      })).to.be.rejectedWith('Failed to fetch existing gsc_prompts: db down');
    });

    it('throws when the insert errors', async () => {
      const client = {
        from: () => ({
          select: () => ({ eq: () => thenable({ data: [], error: null }) }),
          insert: () => ({ select: () => thenable({ data: null, error: { message: 'constraint' } }) }),
        }),
      };
      await expect(upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [{
          text: 'a', region: 'us', source: 'gsc', status: 'ignored',
        }],
        postgrestClient: client,
      })).to.be.rejectedWith('Failed to insert gsc_prompts: constraint');
    });

    it('throws when an update errors', async () => {
      const existingRow = {
        id: ROW_ID, prompt_text: 'a', region_code: 'us', source: 'gsc', status: 'added',
      };
      const client = {
        from: () => ({
          select: () => ({ eq: () => thenable({ data: [existingRow], error: null }) }),
          update: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: () => thenable({ data: null, error: { message: 'lock' } }) }),
            }),
          }),
        }),
      };
      await expect(upsertGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        items: [{
          text: 'a', region: 'us', source: 'gsc', status: 'ignored',
        }],
        postgrestClient: client,
      })).to.be.rejectedWith(/Failed to update gsc_prompts row/);
    });
  });

  describe('listGscPrompts', () => {
    it('throws when postgrestClient is missing .from', async () => {
      await expect(listGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: {},
      })).to.be.rejectedWith('PostgREST client is required');
    });

    it('rejects out-of-bounds limit', async () => {
      await expect(listGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        limit: 10000,
        postgrestClient: { from: () => ({}) },
      })).to.be.rejectedWith(/Limit must be between/);
    });

    it('returns items mapped from rows', async () => {
      const row = {
        id: ROW_ID,
        prompt_text: 'p',
        region_code: 'us',
        source: 'gsc',
        status: 'ignored',
        created_at: '2026-06-08T00:00:00Z',
        created_by: 'system',
        updated_at: '2026-06-08T00:00:00Z',
        updated_by: 'system',
      };
      const client = {
        from: () => {
          const chain = {
            select: () => chain,
            eq: () => chain,
            order: () => chain,
            range: () => thenable({ data: [row], error: null, count: 1 }),
          };
          return chain;
        },
      };

      const result = await listGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: client,
      });

      expect(result.items).to.have.lengthOf(1);
      expect(result.items[0].status).to.equal('ignored');
      expect(result.total).to.equal(1);
    });

    it('applies status + source filters when provided', async () => {
      const eqCalls = [];
      const client = {
        from: () => {
          const chain = {
            select: () => chain,
            eq: (col, val) => {
              eqCalls.push({ col, val });
              return chain;
            },
            order: () => chain,
            range: () => thenable({ data: [], error: null, count: 0 }),
          };
          return chain;
        },
      };

      await listGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        status: 'IGNORED',
        source: 'GSC',
        postgrestClient: client,
      });

      expect(eqCalls).to.deep.include({ col: 'status', val: 'ignored' });
      expect(eqCalls).to.deep.include({ col: 'source', val: 'gsc' });
    });

    it('throws when the DB query errors', async () => {
      const client = {
        from: () => {
          const chain = {
            select: () => chain,
            eq: () => chain,
            order: () => chain,
            range: () => thenable({ data: null, error: { message: 'pg down' }, count: null }),
          };
          return chain;
        },
      };

      await expect(listGscPrompts({
        organizationId: ORG_ID,
        brandUuid: BRAND_UUID,
        postgrestClient: client,
      })).to.be.rejectedWith('Failed to list gsc_prompts: pg down');
    });
  });
});
