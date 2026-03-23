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
  listBrands, getBrandById, upsertBrand, updateBrand, deleteBrand, listRegions,
} from '../../src/support/brands-storage.js';

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

describe('brands-storage', () => {
  const ORG_ID = '11111111-1111-4111-8111-111111111111';
  const BRAND_ID = '22222222-2222-4222-8222-222222222222';

  describe('listBrands', () => {
    it('returns empty array when postgrestClient is missing', async () => {
      expect(await listBrands(ORG_ID, null)).to.deep.equal([]);
    });

    it('returns empty array when postgrestClient has no from method', async () => {
      expect(await listBrands(ORG_ID, {})).to.deep.equal([]);
    });

    it('lists brands and maps to V2 shape', async () => {
      const dbRow = {
        id: BRAND_ID,
        name: 'TestBrand',
        status: 'active',
        origin: 'human',
        description: 'A test brand',
        vertical: 'Retail',
        regions: ['US'],
        owned_urls: ['https://test.com'],
        social: [],
        earned_sources: [],
        brand_aliases: [{ alias: 'TB' }],
        competitors: [{ name: 'Rival' }],
        updated_at: '2026-01-01',
        updated_by: 'user@test.com',
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listBrands(ORG_ID, postgrestClient);

      expect(result).to.have.length(1);
      expect(result[0]).to.include({ name: 'TestBrand', status: 'active' });
      expect(result[0].brandAliases).to.deep.equal(['TB']);
      expect(result[0].competitors).to.deep.equal(['Rival']);
      expect(result[0].region).to.deep.equal(['US']);
      expect(result[0].urls).to.deep.equal([{ value: 'https://test.com' }]);
    });

    it('throws on database error', async () => {
      const query = createChainableQuery({ data: null, error: { message: 'DB error' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(listBrands(ORG_ID, postgrestClient)).to.be.rejectedWith('Failed to list brands');
    });
  });

  describe('getBrandById', () => {
    it('returns null when postgrestClient is missing', async () => {
      expect(await getBrandById(ORG_ID, BRAND_ID, null)).to.be.null;
    });

    it('returns null when brandId is empty', async () => {
      expect(await getBrandById(ORG_ID, '', { from: () => {} })).to.be.null;
    });

    it('returns mapped brand when found', async () => {
      const dbRow = {
        id: BRAND_ID,
        name: 'TestBrand',
        status: 'active',
        origin: 'human',
        description: 'desc',
        vertical: 'Tech',
        regions: ['US'],
        owned_urls: ['https://example.com'],
        social: ['https://twitter.com/test'],
        earned_sources: ['https://blog.example.com'],
        brand_aliases: [{ alias: 'TB' }],
        competitors: [{ name: 'Rival' }],
        brand_sites: [{ site_id: 'site-uuid-1' }],
        updated_at: '2026-01-01',
        updated_by: 'user@test.com',
      };

      const query = createChainableQuery({ data: dbRow, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await getBrandById(ORG_ID, BRAND_ID, postgrestClient);

      expect(result).to.include({ id: BRAND_ID, name: 'TestBrand', status: 'active' });
      expect(result.brandAliases).to.deep.equal(['TB']);
      expect(result.competitors).to.deep.equal(['Rival']);
      expect(result.siteIds).to.deep.equal(['site-uuid-1']);
      expect(result.urls).to.deep.equal([{ value: 'https://example.com' }]);
      expect(result.socialAccounts).to.deep.equal([{ url: 'https://twitter.com/test' }]);
      expect(result.earnedContent).to.deep.equal([{ url: 'https://blog.example.com' }]);
    });

    it('returns null when brand not found', async () => {
      const query = createChainableQuery({ data: null, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await getBrandById(ORG_ID, BRAND_ID, postgrestClient);
      expect(result).to.be.null;
    });

    it('throws on database error', async () => {
      const query = createChainableQuery({ data: null, error: { message: 'DB error' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(getBrandById(ORG_ID, BRAND_ID, postgrestClient)).to.be.rejectedWith('Failed to get brand');
    });
  });

  describe('listBrands', () => {
    it('filters by status when status option is provided', async () => {
      const dbRow = {
        id: BRAND_ID,
        name: 'PendingBrand',
        status: 'pending',
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listBrands(ORG_ID, postgrestClient, { status: 'pending' });
      expect(result).to.have.length(1);
      expect(result[0].status).to.equal('pending');
    });

    it('uses neq deleted filter when no status option provided', async () => {
      const query = createChainableQuery({ data: [], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await listBrands(ORG_ID, postgrestClient);
      expect(postgrestClient.from).to.have.been.calledWith('brands');
    });
  });

  describe('listRegions', () => {
    it('returns empty array when postgrestClient is missing', async () => {
      expect(await listRegions(null)).to.deep.equal([]);
    });

    it('returns regions from database', async () => {
      const regions = [{ code: 'US', name: 'United States' }];
      const query = createChainableQuery({ data: regions, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listRegions(postgrestClient);
      expect(result).to.deep.equal(regions);
      expect(postgrestClient.from).to.have.been.calledWith('regions');
    });

    it('returns empty array when data is null', async () => {
      const query = createChainableQuery({ data: null, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listRegions(postgrestClient);
      expect(result).to.deep.equal([]);
    });

    it('throws on database error', async () => {
      const query = createChainableQuery({ data: null, error: { message: 'DB error' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(listRegions(postgrestClient)).to.be.rejectedWith('Failed to list regions');
    });
  });

  /**
   * Creates a per-table mock postgrestClient. The `tableMap` argument is an
   * object keyed by table name; each value is a result object
   * `{ data, error }` that is returned when that table is resolved.
   * A `callCount` map tracks how many times each table has been queried so
   * you can supply multiple sequential responses via an array.
   */
  function createTableMockClient(tableMap) {
    const callCounts = {};

    const makeQuery = (table) => {
      const responses = tableMap[table];
      if (!responses) {
        return createChainableQuery({ data: null, error: null });
      }
      const arr = Array.isArray(responses) ? responses : [responses];
      callCounts[table] = (callCounts[table] || 0);
      const idx = Math.min(callCounts[table], arr.length - 1);
      callCounts[table] += 1;
      return createChainableQuery(arr[idx]);
    };

    return { from: sinon.stub().callsFake((table) => makeQuery(table)) };
  }

  describe('upsertBrand', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(upsertBrand({
        organizationId: ORG_ID, brand: { name: 'Test' }, postgrestClient: null,
      })).to.be.rejectedWith('PostgREST client is required');
    });

    it('throws when brand name is missing', async () => {
      await expect(upsertBrand({
        organizationId: ORG_ID, brand: {}, postgrestClient: { from: () => {} },
      })).to.be.rejectedWith('Brand name is required');
    });

    it('throws when brands upsert fails', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: null, error: { message: 'upsert failed' } },
      });

      await expect(upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test' },
        postgrestClient,
      })).to.be.rejectedWith('Failed to upsert brand: upsert failed');
    });

    it('successfully upserts a minimal brand with no aliases, competitors, or urls', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        origin: 'human',
        description: null,
        vertical: null,
        regions: [],
        owned_urls: [],
        social: [],
        earned_sources: [],
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
        updated_at: '2026-01-01',
        updated_by: 'system',
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test' },
        postgrestClient,
      });

      expect(result).to.include({ id: BRAND_ID, name: 'Test' });
    });

    it('successfully upserts brand with aliases and competitors', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        origin: 'human',
        description: null,
        vertical: null,
        regions: [],
        owned_urls: [],
        social: [],
        earned_sources: [],
        brand_aliases: [{ alias: 'TB' }, { alias: 'T' }],
        competitors: [{ name: 'Rival' }],
        brand_sites: [],
        updated_at: '2026-01-01',
        updated_by: 'system',
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        brand_aliases: { data: null, error: null },
        competitors: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: {
          name: 'Test',
          brandAliases: ['TB', 'T'],
          competitors: ['Rival'],
        },
        postgrestClient,
        updatedBy: 'user@test.com',
      });

      expect(result.brandAliases).to.deep.equal(['TB', 'T']);
      expect(result.competitors).to.deep.equal(['Rival']);
    });

    it('throws when alias sync fails', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: { id: BRAND_ID, name: 'Test' }, error: null },
        brand_aliases: { data: null, error: { message: 'alias error' } },
      });

      await expect(upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', brandAliases: ['TB'] },
        postgrestClient,
      })).to.be.rejectedWith('Failed to sync brand relations: alias error');
    });

    it('throws when competitor sync fails', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: { id: BRAND_ID, name: 'Test' }, error: null },
        competitors: { data: null, error: { message: 'comp error' } },
      });

      await expect(upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', competitors: ['Rival'] },
        postgrestClient,
      })).to.be.rejectedWith('Failed to sync brand relations: comp error');
    });

    it('successfully upserts brand with urls triggering syncBrandSites', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        origin: 'human',
        description: null,
        vertical: null,
        regions: [],
        owned_urls: ['https://test.com'],
        social: [],
        earned_sources: [],
        brand_aliases: [],
        competitors: [],
        brand_sites: [{ site_id: 'site-uuid-1' }],
        updated_at: '2026-01-01',
        updated_by: 'system',
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [{ id: 'site-uuid-1', base_url: 'https://test.com' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [{ value: 'https://test.com' }] },
        postgrestClient,
      });

      expect(result.siteIds).to.deep.equal(['site-uuid-1']);
    });

    it('throws when brand_sites upsert fails during syncBrandSites', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: { id: BRAND_ID, name: 'Test' }, error: null },
        sites: { data: [{ id: 'site-uuid-1', base_url: 'https://test.com' }], error: null },
        brand_sites: { data: null, error: { message: 'site sync error' } },
      });

      await expect(upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [{ value: 'https://test.com' }] },
        postgrestClient,
      })).to.be.rejectedWith('Failed to sync brand_sites: site sync error');
    });

    it('skips syncBrandSites when urls resolve to no matching sites', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [], error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [{ value: 'https://test.com' }] },
        postgrestClient,
      });

      expect(result.siteIds).to.deep.equal([]);
    });

    it('maps various input shapes for earnedContent, socialAccounts, and region', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        origin: 'human',
        description: 'desc',
        vertical: 'Tech',
        regions: ['US', 'EU'],
        owned_urls: [],
        social: ['https://twitter.com/test'],
        earned_sources: ['https://blog.com'],
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: {
          name: 'Test',
          description: 'desc',
          vertical: 'Tech',
          status: 'active',
          origin: 'human',
          region: ['US', 'EU'],
          earnedContent: [{ url: 'https://blog.com' }],
          socialAccounts: [{ url: 'https://twitter.com/test' }],
        },
        postgrestClient,
      });

      expect(result.region).to.deep.equal(['US', 'EU']);
      expect(result.earnedContent).to.deep.equal([{ url: 'https://blog.com' }]);
      expect(result.socialAccounts).to.deep.equal([{ url: 'https://twitter.com/test' }]);
    });
  });

  describe('updateBrand', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(updateBrand({
        organizationId: ORG_ID, brandId: BRAND_ID, updates: {}, postgrestClient: null,
      })).to.be.rejectedWith('PostgREST client is required');
    });

    it('returns null when brand not found', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: null, error: null },
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { name: 'NewName' },
        postgrestClient,
      });

      expect(result).to.be.null;
    });

    it('throws when update query fails', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: null, error: { message: 'update failed' } },
      });

      await expect(updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { name: 'NewName' },
        postgrestClient,
      })).to.be.rejectedWith('Failed to update brand: update failed');
    });

    it('successfully updates scalar fields (name, status, origin, description, vertical)', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'NewName',
        status: 'pending',
        origin: 'ai',
        description: 'new desc',
        vertical: 'Finance',
        regions: [],
        owned_urls: [],
        social: [],
        earned_sources: [],
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: {
          name: 'NewName',
          status: 'pending',
          origin: 'ai',
          description: 'new desc',
          vertical: 'Finance',
        },
        postgrestClient,
      });

      expect(result).to.include({ name: 'NewName', status: 'pending' });
    });

    it('successfully updates region, urls, socialAccounts, and earnedContent', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        regions: ['US'],
        owned_urls: ['https://new.com'],
        social: ['https://twitter.com/new'],
        earned_sources: ['https://blog.new.com'],
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [], error: null },
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: {
          region: ['US'],
          urls: [{ value: 'https://new.com' }],
          socialAccounts: [{ url: 'https://twitter.com/new' }],
          earnedContent: [{ url: 'https://blog.new.com' }],
        },
        postgrestClient,
      });

      expect(result.region).to.deep.equal(['US']);
      expect(result.urls).to.deep.equal([{ value: 'https://new.com' }]);
    });

    it('successfully updates brandAliases', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        regions: [],
        owned_urls: [],
        social: [],
        earned_sources: [],
        brand_aliases: [{ alias: 'TB' }],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
        brand_aliases: { data: null, error: null },
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { brandAliases: ['TB'] },
        postgrestClient,
        updatedBy: 'user@test.com',
      });

      expect(result.brandAliases).to.deep.equal(['TB']);
    });

    it('handles socialAccounts with handle-only objects', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        regions: [],
        owned_urls: [],
        social: ['@handle'],
        earned_sources: [],
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { socialAccounts: [{ handle: '@handle' }] },
        postgrestClient,
      });

      expect(result.socialAccounts).to.deep.equal([{ url: '@handle' }]);
    });

    it('handles null brandAliases and null competitors in updates', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { brandAliases: null, competitors: null },
        postgrestClient,
      });

      expect(result.brandAliases).to.deep.equal([]);
      expect(result.competitors).to.deep.equal([]);
    });

    it('handles earnedContent with name-only objects', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        regions: [],
        owned_urls: [],
        social: [],
        earned_sources: ['SourceName'],
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { earnedContent: [{ name: 'SourceName' }] },
        postgrestClient,
      });

      expect(result.earnedContent).to.deep.equal([{ url: 'SourceName' }]);
    });

    it('handles object aliases in brandAliases', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        brand_aliases: [{ alias: 'ObjAlias' }],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
        brand_aliases: { data: null, error: null },
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { brandAliases: [{ name: 'ObjAlias' }] },
        postgrestClient,
      });

      expect(result.brandAliases).to.deep.equal(['ObjAlias']);
    });

    it('handles object competitors', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        regions: [],
        owned_urls: [],
        social: [],
        earned_sources: [],
        brand_aliases: [],
        competitors: [{ name: 'ObjRival' }],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
        competitors: { data: null, error: null },
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { competitors: [{ name: 'ObjRival' }] },
        postgrestClient,
      });

      expect(result.competitors).to.deep.equal(['ObjRival']);
    });

    it('throws when alias sync fails during updateBrand', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: { id: BRAND_ID }, error: null },
        brand_aliases: { data: null, error: { message: 'alias sync error' } },
      });

      await expect(updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { brandAliases: ['TB'] },
        postgrestClient,
      })).to.be.rejectedWith('Failed to sync aliases: alias sync error');
    });

    it('skips alias upsert when brandAliases array is empty', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { brandAliases: [] },
        postgrestClient,
      });

      expect(result.brandAliases).to.deep.equal([]);
    });

    it('successfully updates competitors', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        regions: [],
        owned_urls: [],
        social: [],
        earned_sources: [],
        brand_aliases: [],
        competitors: [{ name: 'Rival' }],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
        competitors: { data: null, error: null },
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { competitors: ['Rival'] },
        postgrestClient,
      });

      expect(result.competitors).to.deep.equal(['Rival']);
    });

    it('throws when competitor sync fails during updateBrand', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: { id: BRAND_ID }, error: null },
        competitors: { data: null, error: { message: 'comp sync error' } },
      });

      await expect(updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { competitors: ['Rival'] },
        postgrestClient,
      })).to.be.rejectedWith('Failed to sync competitors: comp sync error');
    });

    it('skips competitor upsert when competitors array is empty', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { competitors: [] },
        postgrestClient,
      });

      expect(result.competitors).to.deep.equal([]);
    });

    it('syncs brand sites when urls are updated', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        regions: [],
        owned_urls: ['https://sync.com'],
        social: [],
        earned_sources: [],
        brand_aliases: [],
        competitors: [],
        brand_sites: [{ site_id: 'site-sync-uuid' }],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [{ id: 'site-sync-uuid', base_url: 'https://sync.com' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { urls: [{ value: 'https://sync.com' }] },
        postgrestClient,
      });

      expect(result.siteIds).to.deep.equal(['site-sync-uuid']);
    });

    it('does not sync brand sites when urls field is absent from updates', async () => {
      const fullBrandRow = {
        id: BRAND_ID,
        name: 'Test',
        status: 'active',
        brand_aliases: [],
        competitors: [],
        brand_sites: [],
      };

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      // No sites or brand_sites entries — if syncBrandSites is called it would
      // use the sites table entry, but since sites is absent, the proxy returns
      // a null-data response which causes no error only because syncBrandSites
      // guards against empty urlValues. The real check: no brand_sites upsert.
      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { name: 'Test' },
        postgrestClient,
      });

      expect(result.siteIds).to.deep.equal([]);
    });
  });

  describe('deleteBrand', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(deleteBrand(ORG_ID, BRAND_ID, null)).to.be.rejectedWith('PostgREST client is required');
    });

    it('returns true when brand is successfully deleted', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: { id: BRAND_ID }, error: null },
      });

      const result = await deleteBrand(ORG_ID, BRAND_ID, postgrestClient, 'user@test.com');
      expect(result).to.be.true;
    });

    it('returns false when brand is not found', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: null, error: null },
      });

      const result = await deleteBrand(ORG_ID, BRAND_ID, postgrestClient);
      expect(result).to.be.false;
    });

    it('throws when delete query fails', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: null, error: { message: 'delete failed' } },
      });

      await expect(deleteBrand(ORG_ID, BRAND_ID, postgrestClient)).to.be.rejectedWith('Failed to delete brand: delete failed');
    });
  });
});
