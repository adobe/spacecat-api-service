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
  listCategories, createCategory, updateCategory, deleteCategory,
} from '../../src/support/categories-storage.js';

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

describe('categories-storage', () => {
  const ORG_ID = '11111111-1111-4111-8111-111111111111';

  describe('listCategories', () => {
    it('returns empty array when postgrestClient is missing', async () => {
      const result = await listCategories({ organizationId: ORG_ID, postgrestClient: null });
      expect(result).to.deep.equal([]);
    });

    it('lists categories and maps to V2 shape', async () => {
      const dbRow = {
        id: 'uuid-1',
        category_id: 'brand-awareness',
        name: 'Brand Awareness',
        status: 'active',
        origin: 'human',
        updated_at: '2026-01-01',
        updated_by: 'user@test.com',
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listCategories({ organizationId: ORG_ID, postgrestClient });
      expect(result).to.have.length(1);
      expect(result[0].id).to.equal('brand-awareness');
      expect(result[0].uuid).to.equal('uuid-1');
      expect(result[0].name).to.equal('Brand Awareness');
    });

    it('applies status filter when provided', async () => {
      const dbRow = {
        id: 'uuid-1',
        category_id: 'brand-awareness',
        name: 'Brand Awareness',
        status: 'pending',
        origin: 'human',
        updated_at: '2026-01-01',
        updated_by: 'user@test.com',
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listCategories({ organizationId: ORG_ID, postgrestClient, status: 'pending' });
      expect(result).to.have.length(1);
      expect(result[0].status).to.equal('pending');
    });

    it('returns empty array when data is null', async () => {
      const query = createChainableQuery({ data: null, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listCategories({ organizationId: ORG_ID, postgrestClient });
      expect(result).to.deep.equal([]);
    });

    it('defaults status and origin when row values are falsy', async () => {
      const dbRow = {
        id: 'uuid-1',
        category_id: 'no-defaults',
        name: 'No Defaults',
        status: null,
        origin: null,
        updated_at: '2026-01-01',
        updated_by: 'system',
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listCategories({ organizationId: ORG_ID, postgrestClient });
      expect(result[0].status).to.equal('active');
      expect(result[0].origin).to.equal('human');
    });

    it('throws on database error', async () => {
      const query = createChainableQuery({ data: null, error: { message: 'DB error' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(listCategories({ organizationId: ORG_ID, postgrestClient }))
        .to.be.rejectedWith('Failed to list categories');
    });
  });

  describe('createCategory', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(createCategory({
        organizationId: ORG_ID, category: { name: 'Test' }, postgrestClient: null,
      })).to.be.rejectedWith('PostgREST client is required');
    });

    it('throws when category name is missing', async () => {
      await expect(createCategory({
        organizationId: ORG_ID, category: {}, postgrestClient: { from: () => { } },
      })).to.be.rejectedWith('Category name is required');
    });

    it('creates a category and returns mapped result', async () => {
      const dbRow = {
        id: 'uuid-new',
        category_id: 'my-new-category',
        name: 'My New Category',
        status: 'active',
        origin: 'human',
        updated_at: '2026-03-01',
        updated_by: 'user@test.com',
      };

      const query = createChainableQuery({ data: dbRow, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'My New Category' },
        postgrestClient,
        updatedBy: 'user@test.com',
      });

      expect(result.id).to.equal('my-new-category');
      expect(result.name).to.equal('My New Category');
    });

    it('throws on database error during create', async () => {
      const query = createChainableQuery({ data: null, error: { message: 'unique violation' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(createCategory({
        organizationId: ORG_ID,
        category: { name: 'Duplicate Category' },
        postgrestClient,
      })).to.be.rejectedWith('Failed to create category: unique violation');
    });
  });

  describe('updateCategory', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(updateCategory({
        organizationId: ORG_ID, categoryId: 'test', updates: {}, postgrestClient: null,
      })).to.be.rejectedWith('PostgREST client is required');
    });

    it('updates category with origin and status fields', async () => {
      const dbRow = {
        id: 'uuid-1',
        category_id: 'test',
        name: 'Test',
        status: 'pending',
        origin: 'ai',
        updated_at: '2026-01-01',
        updated_by: 'user@test.com',
      };
      const query = createChainableQuery({ data: dbRow, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await updateCategory({
        organizationId: ORG_ID,
        categoryId: 'test',
        updates: { name: 'Test', origin: 'ai', status: 'pending' },
        postgrestClient,
        updatedBy: 'user@test.com',
      });

      expect(result).to.not.be.null;
      expect(result.id).to.equal('test');
      expect(result.origin).to.equal('ai');
      expect(result.status).to.equal('pending');
    });

    it('returns null when category is not found', async () => {
      const query = createChainableQuery({ data: null, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await updateCategory({
        organizationId: ORG_ID,
        categoryId: 'nonexistent',
        updates: { name: 'Ghost' },
        postgrestClient,
      });

      expect(result).to.be.null;
    });

    it('throws on database error during update', async () => {
      const query = createChainableQuery({ data: null, error: { message: 'update failed' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(updateCategory({
        organizationId: ORG_ID,
        categoryId: 'test',
        updates: { name: 'Will Fail' },
        postgrestClient,
      })).to.be.rejectedWith('Failed to update category: update failed');
    });
  });

  describe('deleteCategory', () => {
    it('throws when postgrestClient is missing', async () => {
      await expect(deleteCategory({
        organizationId: ORG_ID, categoryId: 'test', postgrestClient: null,
      })).to.be.rejectedWith('PostgREST client is required');
    });

    it('returns true when category is found and soft-deleted', async () => {
      const query = createChainableQuery({ data: { id: 'uuid-del' }, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await deleteCategory({
        organizationId: ORG_ID,
        categoryId: 'test',
        postgrestClient,
        updatedBy: 'admin@test.com',
      });

      expect(result).to.be.true;
    });

    it('returns false when category is not found', async () => {
      const query = createChainableQuery({ data: null, error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await deleteCategory({
        organizationId: ORG_ID,
        categoryId: 'nonexistent',
        postgrestClient,
      });

      expect(result).to.be.false;
    });

    it('throws on database error during delete', async () => {
      const query = createChainableQuery({ data: null, error: { message: 'delete failed' } });
      const postgrestClient = { from: sinon.stub().returns(query) };

      await expect(deleteCategory({
        organizationId: ORG_ID,
        categoryId: 'test',
        postgrestClient,
      })).to.be.rejectedWith('Failed to delete category: delete failed');
    });
  });
});
