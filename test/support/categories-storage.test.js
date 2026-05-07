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
  listCategories, createCategory, updateCategory, deleteCategory, escapeIlike,
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

// Sequential client: each call to `.from()` returns the next chainable
// query with its own resolved response, so a test can simulate distinct
// lookup / insert / update round-trips.
function createSequentialClient(responses) {
  let i = 0;
  const from = sinon.stub().callsFake(() => {
    const resp = responses[i] || responses[responses.length - 1];
    i += 1;
    return createChainableQuery(resp);
  });
  return { from };
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
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'admin@test.com',
        updated_at: '2026-02-01T00:00:00Z',
        updated_by: 'user@test.com',
      };

      const query = createChainableQuery({ data: [dbRow], error: null });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const result = await listCategories({ organizationId: ORG_ID, postgrestClient });
      expect(result).to.have.length(1);
      expect(result[0].id).to.equal('brand-awareness');
      expect(result[0].uuid).to.equal('uuid-1');
      expect(result[0].name).to.equal('Brand Awareness');
      expect(result[0].createdAt).to.equal('2026-01-01T00:00:00Z');
      expect(result[0].createdBy).to.equal('admin@test.com');
      expect(result[0].updatedAt).to.equal('2026-02-01T00:00:00Z');
      expect(result[0].updatedBy).to.equal('user@test.com');
    });

    it('applies status filter when provided', async () => {
      const dbRow = {
        id: 'uuid-1',
        category_id: 'brand-awareness',
        name: 'Brand Awareness',
        status: 'pending',
        origin: 'human',
        created_at: '2026-01-01',
        created_by: 'system',
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
        created_at: null,
        created_by: null,
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
      const dbError = { message: 'DB error' };
      const query = createChainableQuery({ data: null, error: dbError });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const err = await listCategories({ organizationId: ORG_ID, postgrestClient }).catch((e) => e);
      expect(err.message).to.include('Failed to list categories');
      // Error.cause preserves the original PostgREST error for diagnostics.
      expect(err.cause).to.equal(dbError);
    });
  });

  describe('escapeIlike', () => {
    // Regression guard: a future refactor that drops the `.replace` would
    // otherwise silently re-enable PostgREST ILIKE pattern injection —
    // `%` and `_` would become wildcards and match rows they shouldn't.
    it('escapes percent, underscore, and backslash literals', () => {
      expect(escapeIlike('50% Off')).to.equal('50\\% Off');
      expect(escapeIlike('foo_bar')).to.equal('foo\\_bar');
      expect(escapeIlike('with\\backslash')).to.equal('with\\\\backslash');
      // Compound: all three literals in one string.
      expect(escapeIlike('a%b_c\\d')).to.equal('a\\%b\\_c\\\\d');
    });

    it('leaves regular strings untouched', () => {
      expect(escapeIlike('Discovery & Research')).to.equal('Discovery & Research');
      expect(escapeIlike('')).to.equal('');
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

    it('rejects names that are only whitespace after canonicalization', async () => {
      const postgrestClient = { from: () => { } };
      await expect(createCategory({
        organizationId: ORG_ID, category: { name: '   ' }, postgrestClient,
      })).to.be.rejectedWith('Category name is required');
    });

    it('strips zero-width / BOM characters before validation (U+200B/C/D and U+FEFF)', async () => {
      const postgrestClient = { from: () => { } };
      // trim() does NOT remove these — without the explicit strip they
      // would slip past hasText() and produce an invisible row.
      await expect(createCategory({
        organizationId: ORG_ID, category: { name: '\u200B\u200C\u200D\uFEFF' }, postgrestClient,
      })).to.be.rejectedWith('Category name is required');
    });

    it('rejects names that canonicalize to a degenerate slug when no id is supplied', async () => {
      // Non-ASCII-only names collapse to a bare "-" via the slug derivation
      // `replace(/[^a-z0-9]+/g, '-')`. Rejecting at the API boundary keeps
      // such rows from landing with meaningless FKs. Caller can opt out
      // by supplying an explicit `id`.
      const postgrestClient = createSequentialClient([
        { data: null, error: null },
      ]);
      await expect(createCategory({
        organizationId: ORG_ID,
        category: { name: '日本語' },
        postgrestClient,
      })).to.be.rejectedWith(/empty slug/);
    });

    it('accepts non-ASCII names when the client supplies an explicit slug', async () => {
      const insertedRow = {
        id: 'uuid-jp',
        category_id: 'japanese-cat',
        name: '日本語',
        status: 'active',
        origin: 'human',
        created_at: '2026-04-20',
        created_by: 'user@test.com',
        updated_at: '2026-04-20',
        updated_by: 'user@test.com',
      };
      const postgrestClient = createSequentialClient([
        { data: null, error: null },
        { data: insertedRow, error: null },
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        category: { id: 'japanese-cat', name: '日本語' },
        postgrestClient,
        updatedBy: 'user@test.com',
      });

      expect(result.created).to.be.true;
      expect(result.outcome).to.equal('insert');
      expect(result.category.id).to.equal('japanese-cat');
    });

    it('canonicalizes the stored name (trim, whitespace-collapse, NFC) and finds case-variants as existing', async () => {
      // Existing row uses the canonical form; client POSTs a messy variant
      // with leading/trailing whitespace, internal double-spaces, and a
      // different case. Storage must match it as the same category.
      const existingRow = {
        id: 'uuid-canon',
        category_id: 'discovery-research',
        name: 'Discovery & Research',
        status: 'active',
        origin: 'human',
        created_at: '2026-02-01',
        created_by: 'first@test.com',
        updated_at: '2026-02-01',
        updated_by: 'first@test.com',
      };

      const postgrestClient = createSequentialClient([
        { data: existingRow, error: null },
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        category: { name: '  discovery  &  research  ' },
        postgrestClient,
        updatedBy: 'repost@test.com',
      });

      // Matched existing row (case-insensitive ilike lookup); no-op
      // short-circuit preserves audit trail.
      expect(result.created).to.be.false;
      expect(result.category.uuid).to.equal('uuid-canon');
    });

    it('stores the canonical form on insert (not the client-posted whitespace)', async () => {
      const capturedInsert = { row: null };
      const postgrestClient = {
        from: sinon.stub().callsFake(() => ({
          select: sinon.stub().returnsThis(),
          eq: sinon.stub().returnsThis(),
          ilike: sinon.stub().returnsThis(),
          maybeSingle: sinon.stub().resolves({ data: null, error: null }),
          insert: sinon.stub().callsFake((row) => {
            capturedInsert.row = row;
            return {
              select: () => ({
                single: () => Promise.resolve({
                  data: {
                    id: 'uuid-new',
                    category_id: row.category_id,
                    name: row.name,
                    status: row.status,
                    origin: row.origin,
                    created_at: '2026-04-20',
                    created_by: 'user@test.com',
                    updated_at: '2026-04-20',
                    updated_by: row.updated_by,
                  },
                  error: null,
                }),
              }),
            };
          }),
        })),
      };

      await createCategory({
        organizationId: ORG_ID,
        category: { name: '  Edge   Case  ' },
        postgrestClient,
      });

      expect(capturedInsert.row.name).to.equal('Edge Case');
      // Slug is derived from the canonical name too.
      expect(capturedInsert.row.category_id).to.equal('edge-case');
    });

    it('inserts a new category when no row matches by name', async () => {
      const insertedRow = {
        id: 'uuid-new',
        category_id: 'my-new-category',
        name: 'My New Category',
        status: 'active',
        origin: 'human',
        created_at: '2026-03-01T00:00:00Z',
        created_by: 'user@test.com',
        updated_at: '2026-03-01',
        updated_by: 'user@test.com',
      };

      const postgrestClient = createSequentialClient([
        // lookup — not found
        { data: null, error: null },
        // insert — success
        { data: insertedRow, error: null },
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'My New Category' },
        postgrestClient,
        updatedBy: 'user@test.com',
      });

      expect(result.created).to.be.true;
      expect(result.outcome).to.equal('insert');
      expect(result.category.id).to.equal('my-new-category');
      expect(result.category.name).to.equal('My New Category');
      expect(result.category.createdAt).to.equal('2026-03-01T00:00:00Z');
    });

    it('short-circuits (no write) when an existing row already matches — preserves audit trail', async () => {
      const existingRow = {
        id: 'uuid-existing',
        category_id: 'baseurl-discovery-research',
        name: 'Discovery & Research',
        status: 'active',
        origin: 'human',
        created_at: '2026-02-01T00:00:00Z',
        created_by: 'first@test.com',
        updated_at: '2026-02-01T00:00:00Z',
        updated_by: 'first@test.com',
      };

      const postgrestClient = createSequentialClient([
        // lookup — existing row found
        { data: existingRow, error: null },
        // NO second round-trip expected; if createCategory tries one this
        // will resolve the same stub and the test would still pass, but the
        // from-call count assertion below guards against that.
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        // client ships a drifted slug with no field diffs; should be a no-op
        category: { id: 'discovery-research', name: 'Discovery & Research' },
        postgrestClient,
        updatedBy: 'second@test.com',
      });

      expect(result.created).to.be.false;
      expect(result.outcome).to.equal('noop');
      expect(result.category.uuid).to.equal('uuid-existing');
      expect(result.category.id).to.equal('baseurl-discovery-research');
      // Audit fields preserved — no UPDATE fired.
      expect(result.category.updatedBy).to.equal('first@test.com');
      expect(postgrestClient.from).to.have.been.calledOnce;
    });

    it('updates non-key fields (origin, status) when client supplies new values', async () => {
      const existingRow = {
        id: 'uuid-upd',
        category_id: 'taxonomy',
        name: 'Taxonomy',
        status: 'pending',
        origin: 'ai',
        created_at: '2026-02-01',
        created_by: 'system',
        updated_at: '2026-02-01',
        updated_by: 'system',
      };
      const updatedRow = {
        ...existingRow,
        status: 'active',
        origin: 'human',
        updated_at: '2026-03-20',
        updated_by: 'editor@test.com',
      };

      const postgrestClient = createSequentialClient([
        { data: existingRow, error: null },
        { data: updatedRow, error: null },
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'Taxonomy', origin: 'human', status: 'active' },
        postgrestClient,
        updatedBy: 'editor@test.com',
      });

      expect(result.created).to.be.false;
      expect(result.outcome).to.equal('update');
      expect(result.category.status).to.equal('active');
      expect(result.category.origin).to.equal('human');
      expect(result.category.updatedBy).to.equal('editor@test.com');
    });

    it('captures the exact patch sent to .update() on an idempotent update', async () => {
      // Regression guard: if buildCategoryPatch ever leaks an unintended
      // field (e.g. `name`) into the update path, this capture-and-assert
      // pattern catches it. LLMO-4370 #12.
      const existingRow = {
        id: 'uuid-patch',
        category_id: 'patchable',
        name: 'Patchable',
        status: 'pending',
        origin: 'ai',
        created_at: '2026-01-01',
        created_by: 'system',
        updated_at: '2026-01-01',
        updated_by: 'system',
      };
      const capturedUpdate = { row: null };
      const postgrestClient = {
        from: sinon.stub().callsFake(() => ({
          select: sinon.stub().returnsThis(),
          eq: sinon.stub().returnsThis(),
          ilike: sinon.stub().returnsThis(),
          neq: sinon.stub().returnsThis(),
          order: sinon.stub().returnsThis(),
          maybeSingle: sinon.stub().resolves({ data: existingRow, error: null }),
          update: sinon.stub().callsFake((row) => {
            capturedUpdate.row = row;
            return {
              eq: sinon.stub().returnsThis(),
              select: () => ({
                maybeSingle: () => Promise.resolve({
                  data: {
                    ...existingRow, status: 'active', origin: 'human', updated_by: 'editor@test.com',
                  },
                  error: null,
                }),
              }),
            };
          }),
        })),
      };

      await createCategory({
        organizationId: ORG_ID,
        category: { name: 'Patchable', origin: 'human', status: 'active' },
        postgrestClient,
        updatedBy: 'editor@test.com',
      });

      // Only non-key fields flow into the update; `name` is never patched
      // (lookup canonicalized match guarantees identity).
      expect(capturedUpdate.row).to.have.property('status', 'active');
      expect(capturedUpdate.row).to.have.property('origin', 'human');
      expect(capturedUpdate.row).to.have.property('updated_by', 'editor@test.com');
      expect(capturedUpdate.row).to.not.have.property('name');
      expect(capturedUpdate.row).to.not.have.property('category_id');
    });

    it('rethrows when the lookup-by-name query fails', async () => {
      const lookupError = { message: 'connection refused' };
      const postgrestClient = createSequentialClient([
        { data: null, error: lookupError },
      ]);

      const err = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'Lookup Fail' },
        postgrestClient,
      }).catch((e) => e);
      expect(err.message).to.include('Failed to lookup category by name: connection refused');
      expect(err.cause).to.equal(lookupError);
    });

    it('rethrows when the insert hits a non-uniqueness database error', async () => {
      const fkError = { code: '23503', message: 'foreign key violation' };
      const postgrestClient = createSequentialClient([
        // lookup — not found
        { data: null, error: null },
        // insert — unrelated FK violation
        { data: null, error: fkError },
      ]);

      const err = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'Bad Insert' },
        postgrestClient,
      }).catch((e) => e);
      expect(err.message).to.include('Failed to create category: foreign key violation');
      expect(err.cause).to.equal(fkError);
    });

    it('recovers idempotently when a concurrent insert wins the 23505 race', async () => {
      const racedRow = {
        id: 'uuid-raced',
        category_id: 'concurrent',
        name: 'Concurrent',
        status: 'active',
        origin: 'human',
        created_at: '2026-04-01',
        created_by: 'racer@test.com',
        updated_at: '2026-04-01',
        updated_by: 'racer@test.com',
      };
      const updatedRow = {
        ...racedRow,
        updated_by: 'loser@test.com',
        updated_at: '2026-04-01T00:00:01Z',
      };

      const postgrestClient = createSequentialClient([
        // first lookup — nothing yet
        { data: null, error: null },
        // insert — loses race, uq_category_name_per_org fires
        {
          data: null,
          error: {
            code: '23505',
            message: 'duplicate key value violates unique constraint "uq_category_name_per_org"',
          },
        },
        // second lookup — finds the winning row
        { data: racedRow, error: null },
        // update — applies our non-key fields
        { data: updatedRow, error: null },
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'Concurrent' },
        postgrestClient,
        updatedBy: 'loser@test.com',
      });

      expect(result.created).to.be.false;
      expect(result.outcome).to.equal('race_retry_noop');
      expect(result.category.uuid).to.equal('uuid-raced');
      expect(result.category.id).to.equal('concurrent');
    });

    it('marks the race-recovery path outcome as race_retry when a patch actually applies', async () => {
      // Same 23505 race, but this time the losing writer has fresh
      // non-key fields to apply (status change), so the race-recovery
      // resolve path takes the update branch, not the no-op.
      const racedRow = {
        id: 'uuid-raced-patch',
        category_id: 'rpatch',
        name: 'RacePatch',
        status: 'pending',
        origin: 'human',
        created_at: '2026-04-01',
        created_by: 'racer@test.com',
        updated_at: '2026-04-01',
        updated_by: 'racer@test.com',
      };
      const updatedRow = {
        ...racedRow, status: 'active', updated_at: '2026-04-01T00:00:01Z', updated_by: 'loser@test.com',
      };
      const postgrestClient = createSequentialClient([
        { data: null, error: null },
        {
          data: null,
          error: {
            code: '23505',
            message: 'duplicate key value violates unique constraint "uq_category_name_per_org"',
          },
        },
        { data: racedRow, error: null },
        { data: updatedRow, error: null },
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'RacePatch', status: 'active' },
        postgrestClient,
        updatedBy: 'loser@test.com',
      });

      expect(result.outcome).to.equal('race_retry');
      expect(result.category.status).to.equal('active');
    });

    it('surfaces a typed 409 when a 23505 fires against a non-name constraint (slug collision)', async () => {
      // Scenario: client POSTs {id: 'foo', name: 'NewName'}. Lookup by
      // 'NewName' finds nothing. INSERT trips `uq_category_id_per_org`
      // because slug `foo` is already occupied by a different row with a
      // different name. Mirror the topics pattern — surface as a typed
      // 409 with constraint echo so callers don't see a generic 500 on
      // what is really a constraint conflict. LLMO-4370 #5/#6.
      const insertError = {
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_category_id_per_org"',
      };
      const postgrestClient = createSequentialClient([
        { data: null, error: null },
        { data: null, error: insertError },
      ]);

      const err = await createCategory({
        organizationId: ORG_ID,
        category: { id: 'foo', name: 'NewName' },
        postgrestClient,
      }).catch((e) => e);

      expect(err.status).to.equal(409);
      expect(err.message).to.include('uq_category_id_per_org');
      expect(err.cause).to.equal(insertError);
    });

    it('surfaces a generic-constraint 409 when a 23505 has no quoted constraint name', async () => {
      const postgrestClient = createSequentialClient([
        { data: null, error: null },
        { data: null, error: { code: '23505' } }, // no message — generic fallback
      ]);

      const err = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'NoMsg' },
        postgrestClient,
      }).catch((e) => e);

      expect(err.status).to.equal(409);
      expect(err.message).to.match(/unique constraint/i);
    });

    it('throws when the retry lookup after a 23505 race still finds nothing', async () => {
      const postgrestClient = createSequentialClient([
        { data: null, error: null },
        {
          data: null,
          error: {
            code: '23505',
            message: 'duplicate key value violates unique constraint "uq_category_name_per_org"',
          },
        },
        { data: null, error: null },
      ]);

      await expect(createCategory({
        organizationId: ORG_ID,
        category: { name: 'Lost Race' },
        postgrestClient,
      })).to.be.rejectedWith(/Failed to create category/);
    });

    it('rethrows when the update path hits a database error', async () => {
      const existingRow = {
        id: 'uuid-err',
        category_id: 'errtest',
        name: 'ErrTest',
        status: 'active',
        origin: 'human',
        created_at: '2026-01-01',
        created_by: 'system',
        updated_at: '2026-01-01',
        updated_by: 'system',
      };

      const dbError = { message: 'update blew up' };
      const postgrestClient = createSequentialClient([
        { data: existingRow, error: null },
        { data: null, error: dbError },
      ]);

      const err = await createCategory({
        organizationId: ORG_ID,
        // supply a differing status to force the update path (not no-op)
        category: { name: 'ErrTest', status: 'pending' },
        postgrestClient,
      }).catch((e) => e);

      expect(err.message).to.equal('Failed to update existing category: update blew up');
      // Error.cause preserves the original PostgREST error for diagnostics.
      expect(err.cause).to.equal(dbError);
    });

    it('throws a typed 409 when the row is hard-deleted between lookup and update', async () => {
      const existingRow = {
        id: 'uuid-vanishing',
        category_id: 'vanishing',
        name: 'Vanishing',
        status: 'active',
        origin: 'human',
        created_at: '2026-01-01',
        created_by: 'system',
        updated_at: '2026-01-01',
        updated_by: 'system',
      };

      const postgrestClient = createSequentialClient([
        // lookup finds the row
        { data: existingRow, error: null },
        // update returns zero rows — row was hard-deleted concurrently
        { data: null, error: null },
      ]);

      const err = await createCategory({
        organizationId: ORG_ID,
        // differing status forces the update path
        category: { name: 'Vanishing', status: 'pending' },
        postgrestClient,
      }).catch((e) => e);

      expect(err).to.be.instanceOf(Error);
      expect(err.status).to.equal(409);
      expect(err.message).to.match(/concurrently modified/i);
    });

    it('preserves the original 23505 error when the retry lookup itself fails', async () => {
      const insertError = {
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_category_name_per_org"',
      };
      const postgrestClient = createSequentialClient([
        // first lookup — nothing yet
        { data: null, error: null },
        // insert — 23505 race
        { data: null, error: insertError },
        // retry lookup — itself fails (transient connection issue)
        { data: null, error: { message: 'connection reset' } },
      ]);

      const err = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'FlakyRace' },
        postgrestClient,
      }).catch((e) => e);

      // Original 23505 surfaces as the primary cause, not the secondary
      // lookup failure — the 23505 is the more diagnostic signal.
      expect(err.message).to.include('uq_category_name_per_org');
      expect(err.cause).to.equal(insertError);
    });

    it('resurrects a soft-deleted row with the same name (created=true)', async () => {
      const deletedRow = {
        id: 'uuid-deleted',
        category_id: 'legacy-slug',
        name: 'Taxonomy',
        status: 'deleted',
        origin: 'human',
        created_at: '2026-01-01',
        created_by: 'curator@test.com',
        updated_at: '2026-02-01',
        updated_by: 'curator@test.com',
      };
      const resurrectedRow = {
        ...deletedRow,
        status: 'active',
        updated_at: '2026-04-20T00:00:00Z',
        updated_by: 'recreator@test.com',
      };

      const postgrestClient = createSequentialClient([
        { data: deletedRow, error: null },
        { data: resurrectedRow, error: null },
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'Taxonomy' },
        postgrestClient,
        updatedBy: 'recreator@test.com',
      });

      // Client-visible: the resource reappears -> created:true -> 201.
      expect(result.created).to.be.true;
      expect(result.outcome).to.equal('resurrect');
      expect(result.category.uuid).to.equal('uuid-deleted');
      expect(result.category.status).to.equal('active');
      expect(result.category.id).to.equal('legacy-slug');
    });

    // Resurrection × provenance matrix — LLMO-4370 #10.
    it('resurrects a soft-deleted human-origin row on ai POST WITHOUT downgrading origin', async () => {
      const deletedHuman = {
        id: 'uuid-dh',
        category_id: 'curated-legacy',
        name: 'Curated',
        status: 'deleted',
        origin: 'human',
        created_at: '2026-01-01',
        created_by: 'curator@test.com',
        updated_at: '2026-02-01',
        updated_by: 'curator@test.com',
      };
      const resurrectedRow = {
        ...deletedHuman, status: 'active', updated_by: 'drs', updated_at: '2026-04-20',
      };
      const postgrestClient = createSequentialClient([
        { data: deletedHuman, error: null },
        { data: resurrectedRow, error: null },
      ]);
      const log = { warn: sinon.stub() };

      const result = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'Curated', origin: 'ai' },
        postgrestClient,
        updatedBy: 'drs',
        log,
      });

      expect(result.created).to.be.true;
      expect(result.outcome).to.equal('resurrect');
      expect(result.category.origin).to.equal('human');
      // Downgrade attempt is surfaced to operators so misconfigured DRS
      // taxonomies are findable in Coralogix.
      expect(log.warn).to.have.been.calledOnce;
      expect(log.warn.firstCall.args[0]).to.match(/downgrade/i);
    });

    it('resurrects a soft-deleted ai-origin row on human POST AND upgrades origin', async () => {
      const deletedAi = {
        id: 'uuid-da',
        category_id: 'auto-legacy',
        name: 'Auto-Legacy',
        status: 'deleted',
        origin: 'ai',
        created_at: '2026-01-01',
        created_by: 'system',
        updated_at: '2026-01-01',
        updated_by: 'system',
      };
      const resurrectedRow = {
        ...deletedAi, status: 'active', origin: 'human', updated_by: 'curator@test.com', updated_at: '2026-04-20',
      };
      const postgrestClient = createSequentialClient([
        { data: deletedAi, error: null },
        { data: resurrectedRow, error: null },
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'Auto-Legacy', origin: 'human' },
        postgrestClient,
        updatedBy: 'curator@test.com',
      });

      expect(result.created).to.be.true;
      expect(result.outcome).to.equal('resurrect');
      expect(result.category.origin).to.equal('human');
    });

    it('resurrects a soft-deleted row on a POST without an origin field — preserves existing origin', async () => {
      const deletedHuman = {
        id: 'uuid-dnone',
        category_id: 'noorigin',
        name: 'NoOrigin',
        status: 'deleted',
        origin: 'human',
        created_at: '2026-01-01',
        created_by: 'curator@test.com',
        updated_at: '2026-02-01',
        updated_by: 'curator@test.com',
      };
      const resurrectedRow = {
        ...deletedHuman, status: 'active', updated_by: 'recreator@test.com', updated_at: '2026-04-20',
      };
      const postgrestClient = createSequentialClient([
        { data: deletedHuman, error: null },
        { data: resurrectedRow, error: null },
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        // No `origin` field — client didn't assert a provenance opinion.
        category: { name: 'NoOrigin' },
        postgrestClient,
        updatedBy: 'recreator@test.com',
      });

      expect(result.created).to.be.true;
      expect(result.outcome).to.equal('resurrect');
      // Existing origin preserved unchanged.
      expect(result.category.origin).to.equal('human');
    });

    it('does NOT downgrade origin from human to ai on an idempotent re-POST', async () => {
      const humanRow = {
        id: 'uuid-human',
        category_id: 'curated',
        name: 'Curated',
        status: 'active',
        origin: 'human',
        created_at: '2026-01-01',
        created_by: 'curator@test.com',
        updated_at: '2026-02-01',
        updated_by: 'curator@test.com',
      };

      const postgrestClient = createSequentialClient([
        { data: humanRow, error: null },
        // If storage erroneously tries to update, this stub resolves with an
        // origin='ai' row — the assertion below would then fail.
        { data: { ...humanRow, origin: 'ai', updated_by: 'drs' }, error: null },
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        // DRS asserts origin:'ai' on a category a human already curated
        category: { name: 'Curated', origin: 'ai' },
        postgrestClient,
        updatedBy: 'drs',
      });

      expect(result.created).to.be.false;
      expect(result.outcome).to.equal('noop');
      expect(result.category.origin).to.equal('human');
      expect(result.category.updatedBy).to.equal('curator@test.com');
      // No update round-trip fires for a pure provenance-downgrade attempt.
      expect(postgrestClient.from).to.have.been.calledOnce;
    });

    it('logs a WARN when a human->ai downgrade is blocked (active row, no other diffs)', async () => {
      const humanRow = {
        id: 'uuid-warn',
        category_id: 'curated-warn',
        name: 'CuratedWarn',
        status: 'active',
        origin: 'human',
        created_at: '2026-01-01',
        created_by: 'curator@test.com',
        updated_at: '2026-02-01',
        updated_by: 'curator@test.com',
      };
      const postgrestClient = createSequentialClient([
        { data: humanRow, error: null },
      ]);
      const log = { warn: sinon.stub() };

      await createCategory({
        organizationId: ORG_ID,
        category: { name: 'CuratedWarn', origin: 'ai' },
        postgrestClient,
        updatedBy: 'drs',
        log,
      });

      expect(log.warn).to.have.been.calledOnce;
      // Structured fields are passed as a second arg so operators can
      // filter by organization_id / category_id in Coralogix.
      const [, fields] = log.warn.firstCall.args;
      expect(fields).to.include({
        organization_id: ORG_ID,
        category_id: 'curated-warn',
        attempted_origin: 'ai',
        current_origin: 'human',
      });
    });

    it('does allow origin upgrade from ai to human', async () => {
      const aiRow = {
        id: 'uuid-ai',
        category_id: 'auto-discovered',
        name: 'Auto-Discovered',
        status: 'active',
        origin: 'ai',
        created_at: '2026-01-01',
        created_by: 'system',
        updated_at: '2026-01-01',
        updated_by: 'system',
      };
      const upgradedRow = {
        ...aiRow,
        origin: 'human',
        updated_by: 'curator@test.com',
        updated_at: '2026-04-20',
      };

      const postgrestClient = createSequentialClient([
        { data: aiRow, error: null },
        { data: upgradedRow, error: null },
      ]);

      const result = await createCategory({
        organizationId: ORG_ID,
        category: { name: 'Auto-Discovered', origin: 'human' },
        postgrestClient,
        updatedBy: 'curator@test.com',
      });

      expect(result.created).to.be.false;
      expect(result.outcome).to.equal('update');
      expect(result.category.origin).to.equal('human');
      expect(result.category.updatedBy).to.equal('curator@test.com');
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
        created_at: '2026-01-01',
        created_by: 'system',
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
      const dbError = { message: 'update failed' };
      const query = createChainableQuery({ data: null, error: dbError });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const err = await updateCategory({
        organizationId: ORG_ID,
        categoryId: 'test',
        updates: { name: 'Will Fail' },
        postgrestClient,
      }).catch((e) => e);
      expect(err.message).to.include('Failed to update category: update failed');
      expect(err.cause).to.equal(dbError);
    });

    it('surfaces a typed 409 when PATCH name collides with a sibling in the same org', async () => {
      // PATCH was previously unguarded: a rename to a name already taken
      // by another row in the same org tripped `uq_category_name_per_org`
      // and surfaced as a 500. Symmetric with POST now — 409 with
      // constraint echo. LLMO-4370 #9.
      const collisionError = {
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_category_name_per_org"',
      };
      const query = createChainableQuery({ data: null, error: collisionError });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const err = await updateCategory({
        organizationId: ORG_ID,
        categoryId: 'test',
        updates: { name: 'Taken Name' },
        postgrestClient,
      }).catch((e) => e);

      expect(err.status).to.equal(409);
      expect(err.message).to.include('uq_category_name_per_org');
      expect(err.cause).to.equal(collisionError);
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
      const dbError = { message: 'delete failed' };
      const query = createChainableQuery({ data: null, error: dbError });
      const postgrestClient = { from: sinon.stub().returns(query) };

      const err = await deleteCategory({
        organizationId: ORG_ID,
        categoryId: 'test',
        postgrestClient,
      }).catch((e) => e);
      expect(err.message).to.include('Failed to delete category: delete failed');
      expect(err.cause).to.equal(dbError);
    });
  });
});
