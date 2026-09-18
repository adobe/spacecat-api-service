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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import {
  planTagFlagMigration,
  formatPlanReport,
  runMigration,
  parseOptions,
  fetchFlagRows,
  OLD_AUTHORING_FLAG_NAME,
  OLD_SEARCH_FLAG_NAME,
  NEW_FLAG_NAME,
  DEFAULT_UPDATED_BY,
} from '../../scripts/serenity-tag-flag-migration.mjs';

use(chaiAsPromised);

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '22222222-2222-4222-8222-222222222222';
const BRAND_X = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRAND_Y = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let rowSeq = 0;

/**
 * Builds a raw `feature_flags` row the way PostgREST returns it (snake_case, wildcard
 * projection, `brand_id` NULL on an organization's own row).
 */
function row({
  id, organizationId = ORG, brandId = null, flagName, value, product = 'LLMO',
}) {
  rowSeq += 1;
  return {
    id: id ?? `row-${String(rowSeq).padStart(3, '0')}`,
    organization_id: organizationId,
    product,
    flag_name: flagName,
    flag_value: value,
    brand_id: brandId,
    updated_by: 'seed',
  };
}

const authoring = (opts) => row({ ...opts, flagName: OLD_AUTHORING_FLAG_NAME });
const search = (opts) => row({ ...opts, flagName: OLD_SEARCH_FLAG_NAME });
const merged = (opts) => row({ ...opts, flagName: NEW_FLAG_NAME });

const entryFor = (plan, organizationId, brandId = null) => plan.entries
  .find((e) => e.organizationId === organizationId && e.brandId === brandId);

/**
 * Minimal in-memory PostgREST double covering exactly the query shapes the script builds:
 * `select/eq/in/gt/order/limit`, `insert().select().single()` and `delete().in().select()`.
 * Every call is appended to `ops` in order, which is how the write-before-delete ordering is
 * asserted without reaching for a real database.
 */
function createFakeDb(initialRows = [], { dropInserts = false } = {}) {
  const table = initialRows.map((r) => ({ ...r }));
  const ops = [];
  let insertSeq = 0;

  const matches = (candidate, filters) => filters.every((f) => {
    if (f.op === 'eq') {
      return candidate[f.col] === f.val;
    }
    if (f.op === 'in') {
      return f.val.includes(candidate[f.col]);
    }
    return String(candidate[f.col]) > String(f.val);
  });

  const build = (mode, payload) => {
    const filters = [];
    let orderBy = null;
    let limit = null;
    let single = false;

    const execute = () => {
      if (mode === 'insert') {
        insertSeq += 1;
        const inserted = { id: `inserted-${insertSeq}`, brand_id: null, ...payload };
        ops.push({ op: 'insert', row: inserted });
        if (!dropInserts) {
          table.push(inserted);
        }
        return { data: single ? inserted : [inserted], error: null };
      }
      if (mode === 'delete') {
        const hit = table.filter((r) => matches(r, filters));
        hit.forEach((r) => table.splice(table.indexOf(r), 1));
        ops.push({ op: 'delete', filters, ids: hit.map((r) => r.id) });
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      let data = table.filter((r) => matches(r, filters));
      if (orderBy) {
        data = [...data].sort((a, b) => String(a[orderBy]).localeCompare(String(b[orderBy])));
      }
      if (limit !== null) {
        data = data.slice(0, limit);
      }
      ops.push({ op: 'select', filters, count: data.length });
      return { data: single ? (data[0] ?? null) : data, error: null };
    };

    const api = {
      select() {
        return api;
      },
      eq(col, val) {
        filters.push({ op: 'eq', col, val });
        return api;
      },
      in(col, val) {
        filters.push({ op: 'in', col, val });
        return api;
      },
      gt(col, val) {
        filters.push({ op: 'gt', col, val });
        return api;
      },
      order(col) {
        orderBy = col;
        return api;
      },
      limit(n) {
        limit = n;
        return api;
      },
      single() {
        single = true;
        return api;
      },
      then(resolve, reject) {
        return Promise.resolve().then(execute).then(resolve, reject);
      },
    };
    return api;
  };

  return {
    ops,
    table,
    client: {
      from() {
        return {
          select(...args) { return build('select').select(...args); },
          insert(payload) { return build('insert', payload); },
          delete() { return build('delete'); },
        };
      },
    },
  };
}

const quietLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });

describe('serenity-tag-flag-migration — planning (OR over resolved values)', () => {
  it('org scope: either old flag enabled makes the merged flag enabled', () => {
    const plan = planTagFlagMigration([
      authoring({ value: true }),
      search({ value: false }),
    ]);

    const entry = entryFor(plan, ORG);
    expect(entry.value).to.equal(true);
    expect(entry.scope).to.equal('org');
    expect(entry.action).to.equal('insert');
    expect(entry.derivation[OLD_AUTHORING_FLAG_NAME]).to.deep.equal({ value: true, source: 'org' });
    expect(entry.derivation[OLD_SEARCH_FLAG_NAME]).to.deep.equal({ value: false, source: 'org' });
    expect(entry.staleRows.map((r) => r.flagName)).to.have.members([
      OLD_AUTHORING_FLAG_NAME, OLD_SEARCH_FLAG_NAME,
    ]);
    expect(plan.counts).to.include({
      scopes: 1, orgScopes: 1, brandScopes: 0, enabled: 1, disabled: 0, inserts: 1, staleRows: 2,
    });
  });

  it('org scope: search-only enrolment carries forward (one old row, merged true)', () => {
    const plan = planTagFlagMigration([search({ value: true })]);

    const entry = entryFor(plan, ORG);
    expect(entry.value).to.equal(true);
    expect(entry.derivation[OLD_AUTHORING_FLAG_NAME]).to.deep.equal({ value: false, source: 'absent' });
    expect(entry.staleRows).to.have.lengthOf(1);
  });

  it('org scope: both old flags false is written as an explicit false, not dropped', () => {
    const plan = planTagFlagMigration([
      authoring({ value: false }),
      search({ value: false }),
    ]);

    const entry = entryFor(plan, ORG);
    expect(entry.value).to.equal(false);
    expect(entry.action).to.equal('insert');
    expect(plan.counts).to.include({ enabled: 0, disabled: 1 });
  });

  it('brand scope INHERITS the half it does not override from the org row (no revocation)', () => {
    // The regression a raw row-by-row OR would cause: brand X overrides search=false only, so a
    // row-wise OR would write brand X `false` and revoke the deep authoring it resolves today
    // through the org row.
    const plan = planTagFlagMigration([
      authoring({ value: true }),
      search({ brandId: BRAND_X, value: false }),
    ]);

    const brandEntry = entryFor(plan, ORG, BRAND_X);
    expect(brandEntry.value).to.equal(true);
    expect(brandEntry.scope).to.equal('brand');
    expect(brandEntry.derivation[OLD_AUTHORING_FLAG_NAME]).to.deep.equal({ value: true, source: 'org' });
    expect(brandEntry.derivation[OLD_SEARCH_FLAG_NAME]).to.deep.equal({ value: false, source: 'brand' });
    expect(brandEntry.inheritsFromOrg).to.equal(true);
    // Only the brand's OWN row is stale for the brand scope; the org row belongs to the org scope.
    expect(brandEntry.staleRows).to.have.lengthOf(1);
    expect(brandEntry.staleRows[0].flagName).to.equal(OLD_SEARCH_FLAG_NAME);
    expect(plan.counts).to.include({ orgScopes: 1, brandScopes: 1, brandScopesInheriting: 1 });
  });

  it('brand scope: a brand held back by false overrides stays off under an enabled org', () => {
    const plan = planTagFlagMigration([
      authoring({ value: true }),
      search({ value: true }),
      authoring({ brandId: BRAND_X, value: false }),
      search({ brandId: BRAND_X, value: false }),
    ]);

    expect(entryFor(plan, ORG).value).to.equal(true);
    const brandEntry = entryFor(plan, ORG, BRAND_X);
    expect(brandEntry.value).to.equal(false);
    expect(brandEntry.inheritsFromOrg).to.equal(false);
    expect(brandEntry.staleRows).to.have.lengthOf(2);
  });

  it('brand-only enrolment under an org with no rows produces a brand scope and no org scope', () => {
    const plan = planTagFlagMigration([
      authoring({ organizationId: ORG_2, brandId: BRAND_Y, value: true }),
    ]);

    expect(plan.entries).to.have.lengthOf(1);
    expect(entryFor(plan, ORG_2)).to.equal(undefined);
    const brandEntry = entryFor(plan, ORG_2, BRAND_Y);
    expect(brandEntry.value).to.equal(true);
    expect(brandEntry.derivation[OLD_SEARCH_FLAG_NAME]).to.deep.equal({ value: false, source: 'absent' });
  });

  it('ignores other products and unrelated flags, and plans nothing for brands without rows', () => {
    const plan = planTagFlagMigration([
      row({ flagName: 'serenity', value: true }),
      row({ flagName: OLD_SEARCH_FLAG_NAME, value: true, product: 'ASO' }),
      row({ flagName: 'serenity', brandId: BRAND_X, value: true }),
    ]);

    expect(plan.entries).to.have.lengthOf(0);
    expect(plan.counts).to.include({ organizations: 0, scopes: 0, staleRows: 0 });
  });

  it('orders entries deterministically: org scope first, then brands, per organization', () => {
    const plan = planTagFlagMigration([
      search({ organizationId: ORG_2, value: true }),
      search({ brandId: BRAND_Y, value: true }),
      search({ brandId: BRAND_X, value: true }),
      search({ value: true }),
    ]);

    expect(plan.entries.map((e) => e.key)).to.deep.equal([
      `${ORG}::ORG`, `${ORG}::${BRAND_X}`, `${ORG}::${BRAND_Y}`, `${ORG_2}::ORG`,
    ]);
  });

  it('reports the derivation of every scope as operator evidence', () => {
    const plan = planTagFlagMigration([
      authoring({ value: true }),
      search({ brandId: BRAND_X, value: false }),
    ]);
    const report = formatPlanReport(plan).join('\n');

    expect(report).to.contain('scopes to migrate            : 2 (org 1, brand 1)');
    expect(report).to.contain(`${OLD_AUTHORING_FLAG_NAME}=true(org) OR ${OLD_SEARCH_FLAG_NAME}=false(brand) => ${NEW_FLAG_NAME}=true`);
    expect(report).to.contain('brand scopes inheriting a half from their org row: 1');
  });
});

describe('serenity-tag-flag-migration — conflicts', () => {
  it('flags an existing merged row whose value differs, and never plans to overwrite it', () => {
    const plan = planTagFlagMigration([
      authoring({ value: true }),
      merged({ id: 'existing-1', value: false }),
    ]);

    const entry = entryFor(plan, ORG);
    expect(entry.action).to.equal('conflict');
    expect(entry.value).to.equal(true);
    expect(entry.existingValue).to.equal(false);
    expect(entry.existingRowId).to.equal('existing-1');
    expect(plan.conflicts).to.have.lengthOf(1);
    expect(plan.counts).to.include({ conflicts: 1, inserts: 0 });
    expect(formatPlanReport(plan).join('\n')).to.contain('NOT overwritten, resolve by hand');
  });

  it('treats an existing merged row that already matches as already-migrated (idempotent)', () => {
    const plan = planTagFlagMigration([
      authoring({ value: true }),
      merged({ value: true }),
    ]);

    expect(entryFor(plan, ORG).action).to.equal('already-migrated');
    expect(plan.counts).to.include({ alreadyMigrated: 1, inserts: 0, conflicts: 0 });
  });

  it('detects a brand-scoped conflict independently of the org scope', () => {
    const plan = planTagFlagMigration([
      search({ value: true }),
      authoring({ brandId: BRAND_X, value: false }),
      merged({ brandId: BRAND_X, value: false }),
      merged({ value: true }),
    ]);

    expect(entryFor(plan, ORG).action).to.equal('already-migrated');
    // Brand X resolves search=true from the org row, so the derived value is true and the
    // existing brand override of false is a real conflict.
    expect(entryFor(plan, ORG, BRAND_X).action).to.equal('conflict');
  });

  it('evaluates a brand that carries ONLY a pre-existing merged override against the org old rows', () => {
    // Reviewer example 2: brand X has no old row at all, so it inherits the org's
    // serenity_unbounded_tag_authoring=true and derives true -- but it already carries a merged
    // override of false. Omitting the brand would hide a scope whose live value contradicts what
    // the migration is about to make the org mean.
    const plan = planTagFlagMigration([
      authoring({ id: 'o-auth', value: true }),
      merged({ id: 'b-merged', brandId: BRAND_X, value: false }),
    ]);

    const brandEntry = entryFor(plan, ORG, BRAND_X);
    expect(brandEntry).to.not.equal(undefined);
    expect(brandEntry.action).to.equal('conflict');
    expect(brandEntry.value).to.equal(true);
    expect(brandEntry.existingValue).to.equal(false);
    expect(brandEntry.existingRowId).to.equal('b-merged');
    expect(brandEntry.hasOwnOldRows).to.equal(false);
    expect(brandEntry.staleRows).to.have.lengthOf(0);
    expect(brandEntry.derivation[OLD_AUTHORING_FLAG_NAME]).to.deep.equal({ value: true, source: 'org' });
    expect(plan.counts).to.include({ scopes: 2, conflicts: 1, scopesWithoutOldRows: 1 });
    expect(formatPlanReport(plan).join('\n')).to.contain('no old row of its own');
  });

  it('reports a matching new-only brand override as already-migrated, with nothing to delete', () => {
    const plan = planTagFlagMigration([
      authoring({ id: 'o-auth', value: true }),
      merged({ id: 'b-merged', brandId: BRAND_X, value: true }),
    ]);

    const brandEntry = entryFor(plan, ORG, BRAND_X);
    expect(brandEntry.action).to.equal('already-migrated');
    expect(brandEntry.value).to.equal(true);
    expect(brandEntry.hasOwnOldRows).to.equal(false);
    expect(brandEntry.staleRows).to.have.lengthOf(0);
    expect(plan.counts).to.include({ scopes: 2, conflicts: 0, alreadyMigrated: 1 });
  });

  it('still plans nothing for a scope with no old state anywhere', () => {
    // A brand (or org) carrying only a merged row under an org with NO old rows has nothing to
    // carry forward -- it was enrolled on the new flag directly and is none of this script's
    // business.
    const plan = planTagFlagMigration([
      merged({ id: 'b-merged', brandId: BRAND_X, value: false }),
      merged({ id: 'o-merged', value: true }),
    ]);

    expect(plan.entries).to.have.lengthOf(0);
    expect(plan.counts).to.include({ scopes: 0, conflicts: 0 });
  });

  it('keeps a new-only brand override out of the plan when only ANOTHER org has old rows', () => {
    const plan = planTagFlagMigration([
      authoring({ organizationId: ORG_2, id: 'o2-auth', value: true }),
      merged({ id: 'b-merged', brandId: BRAND_X, value: false }),
    ]);

    expect(plan.entries.map((e) => e.key)).to.deep.equal([`${ORG_2}::ORG`]);
  });
});

describe('serenity-tag-flag-migration — runMigration', () => {
  it('previews by default: reads only, writes and deletes nothing', async () => {
    const db = createFakeDb([
      authoring({ value: true }),
      search({ brandId: BRAND_X, value: false }),
    ]);

    const summary = await runMigration({ postgrestClient: db.client, log: quietLog() });

    expect(summary.mode).to.equal('preview');
    expect(summary.counts).to.include({ scopes: 2, inserts: 2 });
    expect(summary.written).to.equal(0);
    expect(summary.deleted).to.equal(0);
    expect(db.ops.every((op) => op.op === 'select')).to.equal(true);
    expect(db.table).to.have.lengthOf(2);
  });

  it('applies: writes both scopes, verifies them, and KEEPS the old rows', async () => {
    const db = createFakeDb([
      authoring({ value: true }),
      search({ brandId: BRAND_X, value: false }),
    ]);

    const summary = await runMigration({
      postgrestClient: db.client,
      options: { apply: true },
      log: quietLog(),
    });

    expect(summary).to.include({
      mode: 'apply', written: 2, verified: 2, deleted: 0,
    });
    const inserted = db.ops.filter((op) => op.op === 'insert').map((op) => op.row);
    expect(inserted).to.have.lengthOf(2);
    expect(inserted[0]).to.include({
      organization_id: ORG,
      product: 'LLMO',
      flag_name: NEW_FLAG_NAME,
      flag_value: true,
      updated_by: DEFAULT_UPDATED_BY,
    });
    expect(inserted[0].brand_id).to.equal(null);
    expect(inserted[1]).to.include({ brand_id: BRAND_X, flag_value: true });
    expect(db.ops.some((op) => op.op === 'delete')).to.equal(false);
    // Old rows untouched: 2 old + 2 new.
    expect(db.table).to.have.lengthOf(4);
  });

  it('writes and verifies every scope BEFORE deleting any stale row', async () => {
    const db = createFakeDb([
      authoring({ id: 'old-a', value: true }),
      search({ id: 'old-s', value: true }),
      authoring({ id: 'old-brand-a', brandId: BRAND_X, value: false }),
    ]);

    const summary = await runMigration({
      postgrestClient: db.client,
      options: { apply: true, deleteStale: true },
      log: quietLog(),
    });

    expect(summary).to.include({ written: 2, verified: 2, deleted: 3 });
    // Every write and every read-back happens strictly before the first delete.
    const lastWriteOrVerify = db.ops.reduce(
      (last, op, index) => (op.op === 'delete' ? last : index),
      -1,
    );
    const firstDelete = db.ops.findIndex((op) => op.op === 'delete');
    expect(firstDelete).to.be.greaterThan(-1);
    expect(firstDelete).to.be.greaterThan(lastWriteOrVerify);
    expect(db.ops.slice(0, firstDelete).filter((op) => op.op === 'insert')).to.have.lengthOf(2);
    expect(db.ops.slice(firstDelete).every((op) => op.op === 'delete')).to.equal(true);
    // Deletion addresses rows by primary key only.
    const deletedIds = db.ops.filter((op) => op.op === 'delete').flatMap((op) => op.ids);
    expect(deletedIds).to.have.members(['old-a', 'old-s', 'old-brand-a']);
    expect(db.table.every((r) => r.flag_name === NEW_FLAG_NAME)).to.equal(true);
  });

  it('deletes the stale rows of an already-migrated scope without rewriting it', async () => {
    const db = createFakeDb([
      authoring({ id: 'old-a', value: true }),
      merged({ id: 'new-1', value: true }),
    ]);

    const summary = await runMigration({
      postgrestClient: db.client,
      options: { apply: true, deleteStale: true },
      log: quietLog(),
    });

    expect(summary).to.include({ written: 0, verified: 1, deleted: 1 });
    expect(db.ops.some((op) => op.op === 'insert')).to.equal(false);
    expect(db.table.map((r) => r.id)).to.deep.equal(['new-1']);
  });

  it('aborts before ANY delete when a written row does not verify', async () => {
    const db = createFakeDb([authoring({ id: 'old-a', value: true })], { dropInserts: true });

    await expect(runMigration({
      postgrestClient: db.client,
      options: { apply: true, deleteStale: true },
      log: quietLog(),
    })).to.be.rejectedWith(/Verification FAILED/);

    expect(db.ops.some((op) => op.op === 'delete')).to.equal(false);
    expect(db.table.map((r) => r.id)).to.deep.equal(['old-a']);
  });

  it('refuses to write anything while a conflict is unresolved', async () => {
    const db = createFakeDb([
      authoring({ id: 'old-a', value: true }),
      merged({ id: 'new-1', value: false }),
      search({ organizationId: ORG_2, id: 'old-s2', value: true }),
    ]);

    await expect(runMigration({
      postgrestClient: db.client,
      options: { apply: true },
      log: quietLog(),
    })).to.be.rejectedWith(/already carry a serenity_tag_multi_dimension row/);

    expect(db.ops.some((op) => op.op === 'insert' || op.op === 'delete')).to.equal(false);
  });

  it('performs ZERO writes and ZERO deletes when any scope conflicts, --delete-stale included', async () => {
    // Reviewer example 1: the org's old authoring row is true, brand X overrides only search to
    // false (so it still resolves true), and brand X already carries a merged override of false.
    // Migrating "the rest" would delete the org's old rows and change what brand X derives on the
    // next run, so the whole run must abort untouched.
    const db = createFakeDb([
      authoring({ id: 'o-auth', value: true }),
      search({ id: 'b-search', brandId: BRAND_X, value: false }),
      merged({ id: 'b-merged', brandId: BRAND_X, value: false }),
      search({ organizationId: ORG_2, id: 'o2-search', value: true }),
    ]);
    const before = db.table.map((r) => r.id);

    await expect(runMigration({
      postgrestClient: db.client,
      options: { apply: true, deleteStale: true },
      log: quietLog(),
    })).to.be.rejectedWith(/NOTHING was written or deleted/);

    expect(db.ops.some((op) => op.op === 'insert' || op.op === 'delete')).to.equal(false);
    expect(db.table.map((r) => r.id)).to.deep.equal(before);
  });

  it('offers no option to proceed past a conflict', () => {
    // The unsafe "migrate everything else" path is gone, not merely discouraged.
    expect(() => parseOptions(['--apply', '--skip-conflicts'])).to.throw(/skip-conflicts/);
  });

  it('verifies a matching new-only brand override and still deletes the org stale rows', async () => {
    const db = createFakeDb([
      authoring({ id: 'o-auth', value: true }),
      merged({ id: 'b-merged', brandId: BRAND_X, value: true }),
    ]);

    const summary = await runMigration({
      postgrestClient: db.client,
      options: { apply: true, deleteStale: true },
      log: quietLog(),
    });

    // Org scope written + verified; brand scope verified only (nothing of its own to write).
    expect(summary).to.include({ written: 1, verified: 2, deleted: 1 });
    expect(db.table.map((r) => r.id)).to.have.members(['b-merged', 'inserted-1']);
  });

  it('aborts when the conflict is a brand that has no old row of its own', async () => {
    const db = createFakeDb([
      authoring({ id: 'o-auth', value: true }),
      merged({ id: 'b-merged', brandId: BRAND_X, value: false }),
    ]);

    await expect(runMigration({
      postgrestClient: db.client,
      options: { apply: true },
      log: quietLog(),
    })).to.be.rejectedWith(/NOTHING was written or deleted/);

    expect(db.ops.some((op) => op.op === 'insert' || op.op === 'delete')).to.equal(false);
  });

  it('rejects --delete-stale without --apply', async () => {
    const db = createFakeDb([authoring({ value: true })]);

    await expect(runMigration({
      postgrestClient: db.client,
      options: { deleteStale: true },
      log: quietLog(),
    })).to.be.rejectedWith(/--delete-stale requires --apply/);

    expect(db.ops).to.have.lengthOf(0);
  });

  it('scopes every phase to --org-id when given', async () => {
    const db = createFakeDb([
      authoring({ value: true }),
      authoring({ organizationId: ORG_2, value: true }),
    ]);

    const summary = await runMigration({
      postgrestClient: db.client,
      options: { apply: true, organizationId: ORG_2 },
      log: quietLog(),
    });

    expect(summary.counts).to.include({ organizations: 1, scopes: 1 });
    expect(db.ops.filter((op) => op.op === 'insert')[0].row.organization_id).to.equal(ORG_2);
  });

  it('surfaces a read failure instead of planning against a partial read', async () => {
    const failing = {
      from: () => ({
        select: () => {
          const api = {
            eq: () => api,
            in: () => api,
            gt: () => api,
            order: () => api,
            limit: () => api,
            then: (resolve) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve),
          };
          return api;
        },
      }),
    };

    await expect(runMigration({ postgrestClient: failing, log: quietLog() }))
      .to.be.rejectedWith(/Failed to read feature_flags/);
  });
});

describe('serenity-tag-flag-migration — paging', () => {
  it('keyset-pages until an empty page, not until a short one', async () => {
    const db = createFakeDb([
      authoring({ id: 'row-a', value: true }),
      search({ id: 'row-b', value: true }),
      authoring({ id: 'row-c', organizationId: ORG_2, value: true }),
    ]);

    const rows = await fetchFlagRows({
      postgrestClient: db.client,
      flagNames: [OLD_AUTHORING_FLAG_NAME, OLD_SEARCH_FLAG_NAME, NEW_FLAG_NAME],
      pageSize: 1,
    });

    expect(rows.map((r) => r.id)).to.deep.equal(['row-a', 'row-b', 'row-c']);
    // 3 pages of one row + the terminating empty page.
    expect(db.ops.filter((op) => op.op === 'select')).to.have.lengthOf(4);
  });
});

describe('serenity-tag-flag-migration — parseOptions', () => {
  it('previews by default', () => {
    expect(parseOptions([])).to.deep.equal({
      apply: false,
      deleteStale: false,
      organizationId: null,
      updatedBy: DEFAULT_UPDATED_BY,
      pageSize: 500,
    });
  });

  it('accepts the apply/delete combination and an operator identity', () => {
    expect(parseOptions([
      '--apply', '--delete-stale', '--org-id', ORG, '--updated-by', 'ntoccane', '--page-size', '50',
    ])).to.deep.equal({
      apply: true,
      deleteStale: true,
      organizationId: ORG,
      updatedBy: 'ntoccane',
      pageSize: 50,
    });
  });

  it('rejects --skip-conflicts: no option may carry a run past a conflict', () => {
    expect(() => parseOptions(['--skip-conflicts'])).to.throw(/skip-conflicts/);
  });

  it('refuses --delete-stale without --apply', () => {
    expect(() => parseOptions(['--delete-stale'])).to.throw(/--delete-stale requires --apply/);
  });

  it('refuses a non-UUID --org-id', () => {
    expect(() => parseOptions(['--org-id', 'PAT03'])).to.throw(/must be a UUID/);
  });

  it('refuses a non-numeric or out-of-range --page-size', () => {
    expect(() => parseOptions(['--page-size', 'lots'])).to.throw(/--page-size must be an integer/);
    expect(() => parseOptions(['--page-size', '0'])).to.throw(/--page-size must be an integer/);
    expect(() => parseOptions(['--page-size', '10001'])).to.throw(/--page-size must be an integer/);
  });
});
