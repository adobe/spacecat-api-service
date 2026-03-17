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
  });

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
  });

  describe('updateBrand', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(updateBrand({
        organizationId: ORG_ID, brandId: BRAND_ID, updates: {}, postgrestClient: null,
      })).to.be.rejectedWith('PostgREST client is required');
    });
  });

  describe('deleteBrand', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(deleteBrand(ORG_ID, BRAND_ID, null)).to.be.rejectedWith('PostgREST client is required');
    });
  });
});
