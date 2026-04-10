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

  /**
   * Builds a minimal brand DB row using the new normalized schema.
   * All child table arrays default to empty so tests only need to specify
   * what they're actually testing.
   */
  function makeBrandRow(overrides = {}) {
    return {
      id: BRAND_ID,
      name: 'TestBrand',
      status: 'active',
      origin: 'human',
      description: null,
      vertical: null,
      regions: [],
      brand_aliases: [],
      brand_social_accounts: [],
      brand_earned_sources: [],
      competitors: [],
      brand_sites: [],
      created_at: '2026-01-01T00:00:00Z',
      created_by: 'system',
      updated_at: '2026-01-01',
      updated_by: 'system',
      ...overrides,
    };
  }

  describe('listBrands', () => {
    it('returns empty array when postgrestClient is missing', async () => {
      expect(await listBrands(ORG_ID, null)).to.deep.equal([]);
    });

    it('returns empty array when postgrestClient has no from method', async () => {
      expect(await listBrands(ORG_ID, {})).to.deep.equal([]);
    });

    it('lists brands and maps to V2 shape', async () => {
      const dbRow = makeBrandRow({
        name: 'TestBrand',
        regions: ['US'],
        brand_aliases: [{ alias: 'TB', regions: ['US'] }],
        brand_social_accounts: [{ url: 'https://twitter.com/test', regions: ['US'] }],
        brand_earned_sources: [{ name: 'TechCrunch', url: 'https://techcrunch.com', regions: [] }],
        competitors: [{ name: 'Rival', url: 'https://rival.com', regions: ['US'] }],
        brand_sites: [{ site_id: 'site-uuid-1', paths: [], sites: { base_url: 'https://test.com' } }],
        updated_by: 'user@test.com',
      });

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listBrands(ORG_ID, postgrestClient);

      expect(result).to.have.length(1);
      expect(result[0]).to.include({ name: 'TestBrand', status: 'active' });
      expect(result[0].region).to.deep.equal(['US']);
      expect(result[0].brandAliases).to.deep.equal([{ name: 'TB', regions: ['US'] }]);
      expect(result[0].socialAccounts).to.deep.equal([{ url: 'https://twitter.com/test', regions: ['US'] }]);
      expect(result[0].earnedContent).to.deep.equal([{ name: 'TechCrunch', url: 'https://techcrunch.com', regions: [] }]);
      expect(result[0].competitors).to.deep.equal([{ name: 'Rival', url: 'https://rival.com', regions: ['US'] }]);
      expect(result[0].urls).to.deep.equal([{ value: 'https://test.com' }]);
      expect(result[0].createdAt).to.equal('2026-01-01T00:00:00Z');
      expect(result[0].createdBy).to.equal('system');
      expect(result[0].updatedAt).to.equal('2026-01-01');
      expect(result[0].updatedBy).to.equal('user@test.com');
    });

    it('expands brand_sites paths into flat URL list', async () => {
      const dbRow = makeBrandRow({
        brand_sites: [{
          site_id: 'site-1',
          paths: ['/products', '/help'],
          sites: { base_url: 'https://adobe.com' },
        }],
      });

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listBrands(ORG_ID, postgrestClient);
      expect(result[0].urls).to.deep.equal([
        { value: 'https://adobe.com/products' },
        { value: 'https://adobe.com/help' },
      ]);
    });

    it('handles null arrays and defaults status in brand rows', async () => {
      const dbRow = makeBrandRow({
        status: null,
        regions: null,
        brand_aliases: null,
        competitors: null,
        brand_social_accounts: null,
        brand_earned_sources: null,
        brand_sites: null,
      });

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listBrands(ORG_ID, postgrestClient);
      expect(result[0].status).to.equal('active');
      expect(result[0].region).to.deep.equal([]);
      expect(result[0].brandAliases).to.deep.equal([]);
      expect(result[0].competitors).to.deep.equal([]);
      expect(result[0].siteIds).to.deep.equal([]);
    });

    it('returns empty array when data is null', async () => {
      const query = createChainableQuery({ data: null, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listBrands(ORG_ID, postgrestClient);
      expect(result).to.deep.equal([]);
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

    it('returns mapped brand with all normalized child fields', async () => {
      const dbRow = makeBrandRow({
        regions: ['US'],
        brand_aliases: [{ alias: 'TB', regions: ['US'] }],
        brand_social_accounts: [{ url: 'https://twitter.com/test', regions: ['US'] }],
        brand_earned_sources: [{ name: 'Blog', url: 'https://blog.example.com', regions: [] }],
        competitors: [{ name: 'Rival', url: null, regions: [] }],
        brand_sites: [{ site_id: 'site-uuid-1', paths: [], sites: { base_url: 'https://example.com' } }],
        updated_by: 'user@test.com',
      });

      const query = createChainableQuery({ data: dbRow, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await getBrandById(ORG_ID, BRAND_ID, postgrestClient);

      expect(result).to.include({ id: BRAND_ID, name: 'TestBrand', status: 'active' });
      expect(result.brandAliases).to.deep.equal([{ name: 'TB', regions: ['US'] }]);
      expect(result.competitors).to.deep.equal([{ name: 'Rival', url: null, regions: [] }]);
      expect(result.siteIds).to.deep.equal(['site-uuid-1']);
      expect(result.urls).to.deep.equal([{ value: 'https://example.com' }]);
      expect(result.socialAccounts).to.deep.equal([{ url: 'https://twitter.com/test', regions: ['US'] }]);
      expect(result.earnedContent).to.deep.equal([{ name: 'Blog', url: 'https://blog.example.com', regions: [] }]);
    });

    it('defaults to empty regions when competitor regions is missing', async () => {
      const dbRow = makeBrandRow({
        competitors: [{ name: 'Rival', url: null }], // no regions key — triggers || []
      });

      const query = createChainableQuery({ data: dbRow, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await getBrandById(ORG_ID, BRAND_ID, postgrestClient);
      expect(result.competitors).to.deep.equal([{ name: 'Rival', url: null, regions: [] }]);
    });

    it('applies || fallbacks for null origin, null regions on child rows, null base_url and null paths on brand_sites', async () => {
      const dbRow = makeBrandRow({
        origin: null, // || 'human'
        brand_social_accounts: [{ url: 'https://x.com', regions: null }], // regions: || []
        brand_earned_sources: [{ name: 'Blog', url: 'https://b.com', regions: null }], // || []
        brand_aliases: [{ alias: 'TB', regions: null }], // regions: || []
        brand_sites: [
          { site_id: 'site-1', paths: null, sites: { base_url: 'https://x.com' } }, // paths: || []
          { site_id: 'site-2', paths: [], sites: null }, // no base_url → skip
        ],
      });

      const query = createChainableQuery({ data: dbRow, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await getBrandById(ORG_ID, BRAND_ID, postgrestClient);
      expect(result.origin).to.equal('human');
      expect(result.socialAccounts).to.deep.equal([{ url: 'https://x.com', regions: [] }]);
      expect(result.earnedContent).to.deep.equal([{ name: 'Blog', url: 'https://b.com', regions: [] }]);
      expect(result.brandAliases).to.deep.equal([{ name: 'TB', regions: [] }]);
      // site-2 skipped (no base_url); site-1 null paths → [] → no paths → base URL returned
      expect(result.urls).to.deep.equal([{ value: 'https://x.com' }]);
    });

    it('uses base_site join for baseSiteId and baseUrl when available', async () => {
      const dbRow = makeBrandRow({
        base_site: { id: 'joined-site-id', base_url: 'https://joined.com' },
        site_id: 'fallback-site-id',
      });

      const query = createChainableQuery({ data: dbRow, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await getBrandById(ORG_ID, BRAND_ID, postgrestClient);
      expect(result.baseSiteId).to.equal('joined-site-id');
      expect(result.baseUrl).to.equal('https://joined.com');
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

  describe('listBrands (status filtering)', () => {
    it('filters by status when status option is provided', async () => {
      const dbRow = makeBrandRow({ status: 'pending' });

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

    it('throws 409 when baseSiteId violates unique constraint on upsert', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: null, error: { code: '23505', message: 'brands_base_site_unique' } },
      });

      const err = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', baseSiteId: 'some-site-id' },
        postgrestClient,
      }).catch((e) => e);

      expect(err.message).to.equal('This site is already the primary URL for another brand');
      expect(err.status).to.equal(409);
    });

    it('sets site_id in upsert row when baseSiteId is provided', async () => {
      const fullBrandRow = makeBrandRow({ name: 'Test', site_id: 'site-uuid' });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', baseSiteId: 'site-uuid' },
        postgrestClient,
      });

      expect(result).to.include({ id: BRAND_ID, name: 'Test' });
    });

    it('successfully upserts a minimal brand with no aliases, competitors, or urls', async () => {
      const fullBrandRow = makeBrandRow({ name: 'Test' });

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
      const fullBrandRow = makeBrandRow({
        name: 'Test',
        brand_aliases: [{ alias: 'TB', regions: ['US'] }, { alias: 'T', regions: [] }],
        competitors: [{ name: 'Rival', url: null, regions: [] }],
      });

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
          brandAliases: [{ name: 'TB', regions: ['US'] }, { name: 'T' }],
          competitors: [{ name: 'Rival' }],
        },
        postgrestClient,
        updatedBy: 'user@test.com',
      });

      expect(result.brandAliases).to.deep.equal([
        { name: 'TB', regions: ['US'] },
        { name: 'T', regions: [] },
      ]);
      expect(result.competitors).to.deep.equal([{ name: 'Rival', url: null, regions: [] }]);
    });

    it('handles object-only competitors with url and regions', async () => {
      const fullBrandRow = makeBrandRow({
        competitors: [{ name: 'ObjRival', url: 'https://rival.com', regions: ['US'] }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        competitors: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: {
          name: 'Test',
          competitors: [{ name: 'ObjRival', url: 'https://rival.com', regions: ['US'] }],
        },
        postgrestClient,
      });

      expect(result.competitors).to.deep.equal([{ name: 'ObjRival', url: 'https://rival.com', regions: ['US'] }]);
    });

    it('throws when alias delete fails', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: { id: BRAND_ID, name: 'Test' }, error: null },
        brand_aliases: { data: null, error: { message: 'alias delete error' } },
      });

      await expect(upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', brandAliases: [{ name: 'TB' }] },
        postgrestClient,
      })).to.be.rejectedWith('Failed to clear brand_aliases: alias delete error');
    });

    it('throws when competitor delete fails', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: { id: BRAND_ID, name: 'Test' }, error: null },
        competitors: { data: null, error: { message: 'comp delete error' } },
      });

      await expect(upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', competitors: [{ name: 'Rival' }] },
        postgrestClient,
      })).to.be.rejectedWith('Failed to clear competitors: comp delete error');
    });

    it('successfully upserts brand with urls triggering syncBrandSites', async () => {
      const fullBrandRow = makeBrandRow({
        brand_sites: [{ site_id: 'site-uuid-1', paths: [], sites: { base_url: 'https://test.com' } }],
      });

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

    it('groups paths by base URL in syncBrandSites', async () => {
      const fullBrandRow = makeBrandRow({
        brand_sites: [{
          site_id: 'site-uuid-1',
          paths: ['/products', '/help'],
          sites: { base_url: 'https://adobe.com' },
        }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [{ id: 'site-uuid-1', base_url: 'https://adobe.com' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: {
          name: 'Test',
          urls: [
            { value: 'https://adobe.com/products' },
            { value: 'https://adobe.com/help' },
          ],
        },
        postgrestClient,
      });

      expect(result.urls).to.deep.equal([
        { value: 'https://adobe.com/products' },
        { value: 'https://adobe.com/help' },
      ]);
    });

    it('preserves base URL alongside path URLs using sentinel slash', async () => {
      const fullBrandRow = makeBrandRow({
        brand_sites: [{
          site_id: 'site-uuid-1',
          paths: ['/', '/products'],
          sites: { base_url: 'https://adobe.com' },
        }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [{ id: 'site-uuid-1', base_url: 'https://adobe.com' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: {
          name: 'Test',
          urls: [
            { value: 'https://adobe.com' },
            { value: 'https://adobe.com/products' },
          ],
        },
        postgrestClient,
      });

      expect(result.urls).to.deep.equal([
        { value: 'https://adobe.com' },
        { value: 'https://adobe.com/products' },
      ]);
    });

    it('throws when brand_sites upsert fails during syncBrandSites', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: { id: BRAND_ID, name: 'Test' }, error: null },
        sites: { data: [{ id: 'site-uuid-1', base_url: 'https://test.com' }], error: null },
        brand_sites: [
          { data: null, error: null },
          { data: null, error: { message: 'site sync error' } },
        ],
      });

      await expect(upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [{ value: 'https://test.com' }] },
        postgrestClient,
      })).to.be.rejectedWith('Failed to sync brand_sites: site sync error');
    });

    it('throws when brand_sites delete fails during syncBrandSites', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: { id: BRAND_ID, name: 'Test' }, error: null },
        brand_sites: { data: null, error: { message: 'delete error' } },
      });

      await expect(upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [{ value: 'https://test.com' }] },
        postgrestClient,
      })).to.be.rejectedWith('Failed to sync brand_sites: delete error');
    });

    it('falls back to base URL when URL string is invalid in syncBrandSites', async () => {
      const fullBrandRow = makeBrandRow({
        brand_sites: [{ site_id: 'site-1', paths: [], sites: { base_url: 'not-a-valid-url' } }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [{ id: 'site-1', base_url: 'not-a-valid-url' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [{ value: 'not-a-valid-url' }] },
        postgrestClient,
      });

      expect(result.siteIds).to.deep.equal(['site-1']);
    });

    it('normalizes www prefix in brand URLs before site lookup', async () => {
      const fullBrandRow = makeBrandRow({
        brand_sites: [{ site_id: 'site-1', paths: ['/products'], sites: { base_url: 'https://test.com' } }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [{ id: 'site-1', base_url: 'https://test.com' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [{ value: 'https://www.test.com/products' }] },
        postgrestClient,
      });

      expect(result.siteIds).to.deep.equal(['site-1']);
    });

    it('normalizes port numbers in brand URLs before site lookup', async () => {
      const fullBrandRow = makeBrandRow({
        brand_sites: [{ site_id: 'site-1', paths: ['/products'], sites: { base_url: 'https://test.com' } }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [{ id: 'site-1', base_url: 'https://test.com' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [{ value: 'https://test.com:8080/products' }] },
        postgrestClient,
      });

      expect(result.siteIds).to.deep.equal(['site-1']);
    });

    it('normalizes mixed case and trailing slash in brand URLs before site lookup', async () => {
      const fullBrandRow = makeBrandRow({
        brand_sites: [{ site_id: 'site-1', paths: ['/'], sites: { base_url: 'https://test.com' } }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [{ id: 'site-1', base_url: 'https://test.com' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [{ value: 'https://WWW.Test.Com/' }] },
        postgrestClient,
      });

      expect(result.siteIds).to.deep.equal(['site-1']);
    });

    it('merges paths when multiple brand URLs normalize to the same site', async () => {
      const fullBrandRow = makeBrandRow({
        brand_sites: [{
          site_id: 'site-1',
          paths: ['/products', '/help'],
          sites: { base_url: 'https://adobe.com' },
        }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [{ id: 'site-1', base_url: 'https://adobe.com' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: {
          name: 'Test',
          urls: [
            { value: 'https://www.adobe.com/products' },
            { value: 'https://WWW.ADOBE.COM/help' },
          ],
        },
        postgrestClient,
      });

      expect(result.urls).to.deep.equal([
        { value: 'https://adobe.com/products' },
        { value: 'https://adobe.com/help' },
      ]);
    });

    it('skips syncBrandSites when urls resolve to no matching sites', async () => {
      const fullBrandRow = makeBrandRow();

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [{ value: 'https://test.com' }] },
        postgrestClient,
      });

      expect(result.siteIds).to.deep.equal([]);
    });

    it('upserts brand with socialAccounts and earnedContent to normalized tables', async () => {
      const fullBrandRow = makeBrandRow({
        regions: ['US', 'EU'],
        brand_social_accounts: [{ url: 'https://twitter.com/test', regions: ['US'] }],
        brand_earned_sources: [{ name: 'Blog', url: 'https://blog.com', regions: [] }],
      });

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
          region: ['US', 'EU'],
          socialAccounts: [{ url: 'https://twitter.com/test', regions: ['US'] }],
          earnedContent: [{ name: 'Blog', url: 'https://blog.com' }],
        },
        postgrestClient,
      });

      expect(result.region).to.deep.equal(['US', 'EU']);
      expect(result.socialAccounts).to.deep.equal([{ url: 'https://twitter.com/test', regions: ['US'] }]);
      expect(result.earnedContent).to.deep.equal([{ name: 'Blog', url: 'https://blog.com', regions: [] }]);
    });

    it('filters out earnedContent entries missing url or name', async () => {
      const fullBrandRow = makeBrandRow({
        brand_earned_sources: [{ name: 'Valid', url: 'https://valid.com', regions: [] }],
      });

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
          earnedContent: [
            { name: 'Valid', url: 'https://valid.com' },
            { name: 'NoUrl' }, // missing url — filtered
            { url: 'https://noname.com' }, // missing name — filtered
          ],
        },
        postgrestClient,
      });

      expect(result.earnedContent).to.deep.equal([{ name: 'Valid', url: 'https://valid.com', regions: [] }]);
    });

    it('handles non-string region values in upsertBrand', async () => {
      const fullBrandRow = makeBrandRow({ regions: ['42'] });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', region: [42] },
        postgrestClient,
      });

      expect(result.region).to.deep.equal(['42']);
    });

    it('accepts string aliases (not objects) in brandAliases', async () => {
      const fullBrandRow = makeBrandRow({
        brand_aliases: [{ alias: 'StringAlias', regions: [] }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        brand_aliases: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', brandAliases: ['StringAlias'] },
        postgrestClient,
      });

      expect(result.brandAliases).to.deep.equal([{ name: 'StringAlias', regions: [] }]);
    });

    it('accepts string competitors (not objects) in competitors', async () => {
      const fullBrandRow = makeBrandRow({
        competitors: [{ name: 'StringRival', url: null, regions: [] }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        competitors: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', competitors: ['StringRival'] },
        postgrestClient,
      });

      expect(result.competitors).to.deep.equal([{ name: 'StringRival', url: null, regions: [] }]);
    });

    it('uses empty paths array when site base_url is not in pathsByBase map', async () => {
      // Sites mock returns a different base_url than what was submitted,
      // triggering the `pathsByBase.get(s.base_url) || []` fallback branch.
      const fullBrandRow = makeBrandRow({
        brand_sites: [{ site_id: 'site-1', paths: [], sites: { base_url: 'https://other.com' } }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        // sites returns a base_url not present in pathsByBase (which has 'https://a.com')
        sites: { data: [{ id: 'site-1', base_url: 'https://other.com' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [{ value: 'https://a.com/products' }] },
        postgrestClient,
      });

      expect(result.siteIds).to.deep.equal(['site-1']);
    });

    it('handles empty urls array in syncBrandSites (early return branch)', async () => {
      const fullBrandRow = makeBrandRow();

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: [] },
        postgrestClient,
      });

      expect(result.urls).to.deep.equal([]);
    });

    it('accepts plain string urls in syncBrandSites', async () => {
      const fullBrandRow = makeBrandRow({
        brand_sites: [{ site_id: 'site-1', paths: [], sites: { base_url: 'https://test.com' } }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID, name: 'Test' }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [{ id: 'site-1', base_url: 'https://test.com' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', urls: ['https://test.com'] },
        postgrestClient,
      });

      expect(result.siteIds).to.deep.equal(['site-1']);
    });

    it('throws when child table insert fails after delete succeeds', async () => {
      const postgrestClient = createTableMockClient({
        brands: { data: { id: BRAND_ID, name: 'Test' }, error: null },
        brand_aliases: [
          { data: null, error: null }, // delete succeeds
          { data: null, error: { message: 'insert failed' } }, // upsert fails
        ],
      });

      await expect(upsertBrand({
        organizationId: ORG_ID,
        brand: { name: 'Test', brandAliases: [{ name: 'TB' }] },
        postgrestClient,
      })).to.be.rejectedWith('Failed to sync brand_aliases: insert failed');
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

    it('throws 409 when baseSiteId violates unique constraint', async () => {
      const postgrestClient = createTableMockClient({
        brands: [
          // 1st call: select current site_id (null → allow setting)
          { data: { site_id: null }, error: null },
          // 2nd call: update fails with unique constraint
          { data: null, error: { code: '23505', message: 'brands_base_site_unique' } },
        ],
      });

      const err = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { baseSiteId: 'some-site-id' },
        postgrestClient,
      }).catch((e) => e);

      expect(err.message).to.equal('This site is already the primary URL for another brand');
      expect(err.status).to.equal(409);
    });

    it('sets baseSiteId when brand has no site_id yet', async () => {
      const fullBrandRow = makeBrandRow({ site_id: 'new-site-id' });

      const postgrestClient = createTableMockClient({
        brands: [
          // 1st call: select current site_id (null → allow setting)
          { data: { site_id: null }, error: null },
          // 2nd call: update succeeds
          { data: { id: BRAND_ID }, error: null },
          // 3rd call: getBrandById re-fetch
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { baseSiteId: 'new-site-id' },
        postgrestClient,
      });

      expect(result).to.not.be.null;
    });

    it('ignores baseSiteId when brand already has a site_id (immutable)', async () => {
      const fullBrandRow = makeBrandRow({ site_id: 'existing-site-id' });

      const postgrestClient = createTableMockClient({
        brands: [
          // 1st call: select current site_id (already set → ignore)
          { data: { site_id: 'existing-site-id' }, error: null },
          // 2nd call: update succeeds (without site_id in patch)
          { data: { id: BRAND_ID }, error: null },
          // 3rd call: getBrandById re-fetch
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { baseSiteId: 'different-site-id' },
        postgrestClient,
      });

      expect(result).to.not.be.null;
    });

    it('successfully updates scalar fields (name, status, origin, description, vertical)', async () => {
      const fullBrandRow = makeBrandRow({
        name: 'NewName',
        status: 'pending',
        origin: 'ai',
        description: 'new desc',
        vertical: 'Finance',
      });

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

    it('successfully updates region and urls', async () => {
      const fullBrandRow = makeBrandRow({
        regions: ['US'],
        brand_sites: [{ site_id: 'new-site-uuid', paths: [], sites: { base_url: 'https://new.com' } }],
      });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
        sites: { data: [{ id: 'new-site-uuid', base_url: 'https://new.com' }], error: null },
        brand_sites: { data: null, error: null },
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: {
          region: ['US'],
          urls: [{ value: 'https://new.com' }],
        },
        postgrestClient,
      });

      expect(result.region).to.deep.equal(['US']);
      expect(result.urls).to.deep.equal([{ value: 'https://new.com' }]);
    });

    it('successfully updates socialAccounts and earnedContent', async () => {
      const fullBrandRow = makeBrandRow({
        brand_social_accounts: [{ url: 'https://twitter.com/new', regions: [] }],
        brand_earned_sources: [{ name: 'Blog', url: 'https://blog.new.com', regions: [] }],
      });

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
          socialAccounts: [{ url: 'https://twitter.com/new' }],
          earnedContent: [{ name: 'Blog', url: 'https://blog.new.com' }],
        },
        postgrestClient,
      });

      expect(result.socialAccounts).to.deep.equal([{ url: 'https://twitter.com/new', regions: [] }]);
      expect(result.earnedContent).to.deep.equal([{ name: 'Blog', url: 'https://blog.new.com', regions: [] }]);
    });

    it('successfully updates brandAliases with regions', async () => {
      const fullBrandRow = makeBrandRow({
        brand_aliases: [{ alias: 'TB', regions: ['US'] }],
      });

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
        updates: { brandAliases: [{ name: 'TB', regions: ['US'] }] },
        postgrestClient,
        updatedBy: 'user@test.com',
      });

      expect(result.brandAliases).to.deep.equal([{ name: 'TB', regions: ['US'] }]);
    });

    it('replaces all aliases when updated (deleted aliases are removed)', async () => {
      // Only 'NewAlias' is in the update — 'OldAlias' should be gone
      const fullBrandRow = makeBrandRow({
        brand_aliases: [{ alias: 'NewAlias', regions: [] }],
      });

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
        updates: { brandAliases: [{ name: 'NewAlias' }] },
        postgrestClient,
      });

      // The result reflects only the aliases returned by getBrandById (the mock row)
      expect(result.brandAliases).to.deep.equal([{ name: 'NewAlias', regions: [] }]);
    });

    it('skips syncBrandSites when all urls filter to empty', async () => {
      const fullBrandRow = makeBrandRow();

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
        brand_sites: { data: null, error: null },
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { urls: [{ value: '' }, { value: null }] },
        postgrestClient,
      });

      expect(result.urls).to.deep.equal([]);
    });

    it('handles null region in updates', async () => {
      const fullBrandRow = makeBrandRow({ regions: [] });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { region: null },
        postgrestClient,
      });
      expect(result.region).to.deep.equal([]);
    });

    it('handles non-string region values in updates', async () => {
      const fullBrandRow = makeBrandRow({ regions: ['42'] });

      const postgrestClient = createTableMockClient({
        brands: [
          { data: { id: BRAND_ID }, error: null },
          { data: fullBrandRow, error: null },
        ],
      });

      const result = await updateBrand({
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        updates: { region: [42] },
        postgrestClient,
      });
      expect(result.region).to.deep.equal(['42']);
    });

    it('handles null values for array update fields', async () => {
      const fullBrandRow = makeBrandRow();

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
          brandAliases: null,
          competitors: null,
          socialAccounts: null,
          earnedContent: null,
        },
        postgrestClient,
      });

      expect(result.brandAliases).to.deep.equal([]);
      expect(result.competitors).to.deep.equal([]);
    });
  });

  describe('deleteBrand', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(deleteBrand(ORG_ID, BRAND_ID, null)).to.be.rejectedWith('PostgREST client is required');
    });

    it('returns true when brand is found and soft-deleted', async () => {
      const query = createChainableQuery({ data: { id: BRAND_ID }, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await deleteBrand(ORG_ID, BRAND_ID, postgrestClient, 'user@test.com');
      expect(result).to.be.true;
    });

    it('returns false when brand not found', async () => {
      const query = createChainableQuery({ data: null, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await deleteBrand(ORG_ID, BRAND_ID, postgrestClient);
      expect(result).to.be.false;
    });

    it('throws on database error', async () => {
      const query = createChainableQuery({ data: null, error: { message: 'delete failed' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(deleteBrand(ORG_ID, BRAND_ID, postgrestClient)).to.be.rejectedWith('Failed to delete brand: delete failed');
    });
  });
});
