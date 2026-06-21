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

import { expect } from 'chai';
import sinon from 'sinon';

import {
  listFacsAccessMappings,
  listFacsAccessMappingHistory,
  listFacsAccessMappingAuditEvents,
  insertFacsAccessMappingAuditEvent,
  getFacsAccessMappingById,
  createFacsAccessMappings,
  revokeFacsAccessMappingById,
  updateFacsAccessMappingCapabilities,
} from '../../src/support/state-access-mapping-utils.js';

/**
 * Builds a chained PostgREST-style stub for read/write queries. Each
 * chained call returns the same builder; the terminal `await` resolves
 * to `{ data, error }` via a stub on the builder itself (then-able).
 */
function fakeQueryBuilder(result) {
  const builder = {
    select: sinon.stub().returnsThis(),
    eq: sinon.stub().returnsThis(),
    is: sinon.stub().returnsThis(),
    in: sinon.stub().returnsThis(),
    gte: sinon.stub().returnsThis(),
    lte: sinon.stub().returnsThis(),
    order: sinon.stub().returnsThis(),
    limit: sinon.stub().returnsThis(),
    upsert: sinon.stub().returnsThis(),
    then(onFulfilled, onRejected) {
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

function fakePostgrestClient({ readResult, insertResults, rpcResult } = {}) {
  const readBuilder = fakeQueryBuilder(readResult ?? { data: [], error: null });
  // createFacsAccessMappings inserts one row per subject; each `.insert(row)`
  // returns its own builder resolving to the next queued result (in order).
  const insertQueue = [...(insertResults ?? [])];
  const insertArgs = [];
  const client = {
    fromCalls: [],
    insertArgs,
    from(table) {
      this.fromCalls.push(table);
      return {
        // Treat all of select/eq/is/in/gte/order/limit as the readBuilder.
        select: readBuilder.select,
        eq: readBuilder.eq,
        is: readBuilder.is,
        in: readBuilder.in,
        gte: readBuilder.gte,
        lte: readBuilder.lte,
        order: readBuilder.order,
        limit: readBuilder.limit,
        insert: (row) => {
          insertArgs.push(row);
          const result = insertQueue.shift() ?? { data: [], error: null };
          return fakeQueryBuilder(result);
        },
        then: readBuilder.then.bind(readBuilder),
      };
    },
    rpc: sinon.stub().resolves(rpcResult ?? { data: null, error: null }),
    readBuilder,
  };
  return client;
}

describe('state-access-mapping-utils helpers', () => {
  describe('listFacsAccessMappings', () => {
    it('throws when imsOrgId is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await listFacsAccessMappings(client, { product: 'LLMO' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('listFacsAccessMappings: imsOrgId is required');
      }
    });

    it('throws when product is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await listFacsAccessMappings(client, { imsOrgId: 'org-1' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('listFacsAccessMappings: product is required');
      }
    });

    it('filters on ims_org_id, product, and revoked_at IS NULL (active rows only)', async () => {
      const client = fakePostgrestClient({
        readResult: { data: [{ id: 'r1' }], error: null },
      });
      const rows = await listFacsAccessMappings(client, { imsOrgId: 'org-1', product: 'LLMO' });
      expect(rows).to.deep.equal([{ id: 'r1' }]);
      const eqCalls = client.readBuilder.eq.getCalls().map((c) => c.args);
      expect(eqCalls).to.deep.include(['ims_org_id', 'org-1']);
      expect(eqCalls).to.deep.include(['product', 'LLMO']);
      expect(client.readBuilder.is.calledOnceWithExactly('revoked_at', null)).to.be.true;
    });

    it('applies subject + resource filters when supplied', async () => {
      const client = fakePostgrestClient({ readResult: { data: [], error: null } });
      await listFacsAccessMappings(client, {
        imsOrgId: 'org-1',
        product: 'LLMO',
        subjectType: 'user',
        subjectId: 'ABC@AdobeID',
        resourceType: 'brand',
        resourceId: 'brand-x',
      });
      const eqCalls = client.readBuilder.eq.getCalls().map((c) => c.args);
      expect(eqCalls).to.deep.include(['subject_type', 'user']);
      expect(eqCalls).to.deep.include(['subject_id', 'ABC@AdobeID']);
      expect(eqCalls).to.deep.include(['resource_type', 'brand']);
      expect(eqCalls).to.deep.include(['resource_id', 'brand-x']);
    });

    it('orders by created_at DESC and caps the limit at 500 (default 50)', async () => {
      const client = fakePostgrestClient();
      await listFacsAccessMappings(client, { imsOrgId: 'org-1', product: 'LLMO' });
      expect(client.readBuilder.order.firstCall.args).to.deep.equal([
        'created_at', { ascending: false },
      ]);
      expect(client.readBuilder.limit.firstCall.args[0]).to.equal(50);

      const client2 = fakePostgrestClient();
      await listFacsAccessMappings(client2, { imsOrgId: 'org-1', product: 'LLMO', limit: 99999 });
      expect(client2.readBuilder.limit.firstCall.args[0]).to.equal(500);

      const client3 = fakePostgrestClient();
      await listFacsAccessMappings(client3, { imsOrgId: 'org-1', product: 'LLMO', limit: -3 });
      expect(client3.readBuilder.limit.firstCall.args[0]).to.equal(50);
    });

    it('throws with a meaningful message when PostgREST returns an error', async () => {
      const client = fakePostgrestClient({
        readResult: { data: null, error: { message: 'boom' } },
      });
      try {
        await listFacsAccessMappings(client, { imsOrgId: 'org-1', product: 'LLMO' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('listFacsAccessMappings failed: boom');
      }
    });

    it('returns [] when PostgREST resolves data: null', async () => {
      const client = fakePostgrestClient({ readResult: { data: null, error: null } });
      const out = await listFacsAccessMappings(client, { imsOrgId: 'org-1', product: 'LLMO' });
      expect(out).to.deep.equal([]);
    });
  });

  describe('listFacsAccessMappingHistory', () => {
    it('throws when imsOrgId is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await listFacsAccessMappingHistory(client, { product: 'LLMO' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('listFacsAccessMappingHistory: imsOrgId is required');
      }
    });

    it('throws when product is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await listFacsAccessMappingHistory(client, { imsOrgId: 'org-1' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('listFacsAccessMappingHistory: product is required');
      }
    });

    it('filters on ims_org_id + product and does NOT filter on revoked_at (surfaces active + tombstoned rows)', async () => {
      const client = fakePostgrestClient({
        readResult: { data: [{ id: 'r1' }, { id: 'r2', revoked_at: '2026-05-01' }], error: null },
      });
      const rows = await listFacsAccessMappingHistory(client, { imsOrgId: 'org-1', product: 'LLMO' });
      expect(rows).to.have.length(2);
      const eqCalls = client.readBuilder.eq.getCalls().map((c) => c.args);
      expect(eqCalls).to.deep.include(['ims_org_id', 'org-1']);
      expect(eqCalls).to.deep.include(['product', 'LLMO']);
      expect(client.readBuilder.is.called).to.be.false;
    });

    it('applies the optional `since` filter as a >= on created_at', async () => {
      const client = fakePostgrestClient();
      await listFacsAccessMappingHistory(client, {
        imsOrgId: 'org-1', product: 'LLMO', since: '2026-05-01T00:00:00Z',
      });
      expect(client.readBuilder.gte.calledOnceWithExactly('created_at', '2026-05-01T00:00:00Z'))
        .to.be.true;
    });

    it('throws with a meaningful message when PostgREST returns an error', async () => {
      const client = fakePostgrestClient({
        readResult: { data: null, error: { message: 'boom' } },
      });
      try {
        await listFacsAccessMappingHistory(client, { imsOrgId: 'org-1', product: 'LLMO' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('listFacsAccessMappingHistory failed: boom');
      }
    });

    it('returns [] when PostgREST resolves data: null', async () => {
      const client = fakePostgrestClient({ readResult: { data: null, error: null } });
      const out = await listFacsAccessMappingHistory(client, { imsOrgId: 'org-1', product: 'LLMO' });
      expect(out).to.deep.equal([]);
    });
  });

  describe('listFacsAccessMappingAuditEvents', () => {
    it('throws when imsOrgId is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await listFacsAccessMappingAuditEvents(client, { product: 'LLMO' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('listFacsAccessMappingAuditEvents: imsOrgId is required');
      }
    });

    it('throws when product is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await listFacsAccessMappingAuditEvents(client, { imsOrgId: 'org-1' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('listFacsAccessMappingAuditEvents: product is required');
      }
    });

    it('queries the audit-events table and returns rows', async () => {
      const rows = [{ id: 'e1', operation: 'create', outcome: 'allow' }];
      const client = fakePostgrestClient({ readResult: { data: rows, error: null } });
      const out = await listFacsAccessMappingAuditEvents(client, {
        imsOrgId: 'org-1',
        product: 'LLMO',
        operation: 'create',
        outcome: 'allow',
        resourceType: 'brand',
        resourceId: 'b1',
        actorId: 'a@AdobeID',
        since: 's',
        until: 'u',
      });
      expect(out).to.deep.equal(rows);
      expect(client.fromCalls).to.include('facs_access_mapping_audit_events');
    });

    it('returns [] when PostgREST resolves data: null', async () => {
      const client = fakePostgrestClient({ readResult: { data: null, error: null } });
      const out = await listFacsAccessMappingAuditEvents(client, { imsOrgId: 'org-1', product: 'LLMO' });
      expect(out).to.deep.equal([]);
    });

    it('throws with a meaningful message when PostgREST returns an error', async () => {
      const client = fakePostgrestClient({ readResult: { data: null, error: { message: 'boom' } } });
      try {
        await listFacsAccessMappingAuditEvents(client, { imsOrgId: 'org-1', product: 'LLMO' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('listFacsAccessMappingAuditEvents failed: boom');
      }
    });
  });

  describe('createFacsAccessMappings', () => {
    it('returns immediately when subjects is empty', async () => {
      const client = fakePostgrestClient();
      const out = await createFacsAccessMappings(client, {
        imsOrgId: 'org-1',
        product: 'LLMO',
        resourceType: 'brand',
        resourceId: 'brand-x',
        grantedCapabilities: ['llmo/can_view'],
        subjects: [],
      });
      expect(out).to.deep.equal({ created: [], skipped: [] });
      expect(client.fromCalls).to.have.length(0);
    });

    it('returns immediately when subjects is not an array', async () => {
      const client = fakePostgrestClient();
      const out = await createFacsAccessMappings(client, {
        imsOrgId: 'org-1',
        product: 'LLMO',
        resourceType: 'brand',
        resourceId: 'brand-x',
        grantedCapabilities: ['llmo/can_view'],
        subjects: undefined,
      });
      expect(out).to.deep.equal({ created: [], skipped: [] });
    });

    it('throws when imsOrgId is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await createFacsAccessMappings(client, {
          product: 'LLMO',
          resourceType: 'brand',
          resourceId: 'brand-x',
          grantedCapabilities: ['llmo/can_view'],
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('createFacsAccessMappings: imsOrgId is required');
      }
    });

    it('throws when product is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await createFacsAccessMappings(client, {
          imsOrgId: 'org-1',
          resourceType: 'brand',
          resourceId: 'brand-x',
          grantedCapabilities: ['llmo/can_view'],
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('createFacsAccessMappings: product is required');
      }
    });

    it('throws when grantedCapabilities is missing or empty', async () => {
      const client = fakePostgrestClient();
      for (const bad of [undefined, [], 'not-an-array']) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await createFacsAccessMappings(client, {
            imsOrgId: 'org-1',
            product: 'LLMO',
            resourceType: 'brand',
            resourceId: 'brand-x',
            grantedCapabilities: bad,
            subjects: [{ type: 'user', id: 'A@AdobeID' }],
          });
          throw new Error('expected to throw');
        } catch (e) {
          expect(e.message).to.equal(
            'createFacsAccessMappings: grantedCapabilities is required (non-empty array)',
          );
        }
      }
    });

    it('inserts a row carrying product + granted_capabilities (no facs_permission column)', async () => {
      const client = fakePostgrestClient({
        insertResults: [
          { data: [{ id: 'r1', subject_type: 'user', subject_id: 'A@AdobeID' }], error: null },
        ],
      });
      const out = await createFacsAccessMappings(client, {
        imsOrgId: 'org-1',
        product: 'LLMO',
        resourceType: 'brand',
        resourceId: 'brand-x',
        grantedCapabilities: ['llmo/can_view', 'llmo/can_configure'],
        subjects: [{ type: 'user', id: 'A@AdobeID' }],
        createdBy: 'admin@AdobeID',
      });
      expect(client.insertArgs).to.have.length(1);
      const row = client.insertArgs[0];
      expect(row).to.not.have.property('facs_permission');
      expect(row).to.include({
        subject_type: 'user',
        subject_id: 'A@AdobeID',
        resource_type: 'brand',
        resource_id: 'brand-x',
        ims_org_id: 'org-1',
        product: 'LLMO',
        created_by: 'admin@AdobeID',
      });
      expect(row.granted_capabilities).to.deep.equal(['llmo/can_view', 'llmo/can_configure']);
      expect(out.created).to.have.length(1);
      expect(out.skipped).to.deep.equal([]);
    });

    it('classifies a unique-violation (23505) row as `skipped: duplicate`', async () => {
      // The active-row uniqueness index is partial, so a duplicate active
      // binding surfaces as a per-row 23505 error (not a missing return row).
      const client = fakePostgrestClient({
        insertResults: [
          { data: [{ subject_type: 'user', subject_id: 'A@AdobeID' }], error: null },
          { data: null, error: { code: '23505', message: 'duplicate key value' } },
        ],
      });
      const out = await createFacsAccessMappings(client, {
        imsOrgId: 'org-1',
        product: 'LLMO',
        resourceType: 'brand',
        resourceId: 'brand-x',
        grantedCapabilities: ['llmo/can_view'],
        subjects: [
          { type: 'user', id: 'A@AdobeID' },
          { type: 'user', id: 'B@AdobeID' }, // already actively bound → 23505
        ],
      });
      expect(out.created).to.have.length(1);
      expect(out.skipped).to.deep.equal([
        { subject: { type: 'user', id: 'B@AdobeID' }, reason: 'duplicate' },
      ]);
    });

    it('throws with a meaningful message on a non-conflict PostgREST error', async () => {
      const client = fakePostgrestClient({
        insertResults: [{ data: null, error: { message: 'boom' } }],
      });
      try {
        await createFacsAccessMappings(client, {
          imsOrgId: 'org-1',
          product: 'LLMO',
          resourceType: 'brand',
          resourceId: 'brand-x',
          grantedCapabilities: ['llmo/can_view'],
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('createFacsAccessMappings failed: boom');
      }
    });

    it('treats an empty insert return (no error) as neither created nor skipped', async () => {
      const client = fakePostgrestClient({
        insertResults: [{ data: [], error: null }],
      });
      const out = await createFacsAccessMappings(client, {
        imsOrgId: 'org-1',
        product: 'LLMO',
        resourceType: 'brand',
        resourceId: 'brand-x',
        grantedCapabilities: ['llmo/can_view'],
        subjects: [{ type: 'user', id: 'A@AdobeID' }],
      });
      expect(out.created).to.deep.equal([]);
      expect(out.skipped).to.deep.equal([]);
    });

    it('treats undefined createdBy as null in the row', async () => {
      const client = fakePostgrestClient({
        insertResults: [{ data: [{ id: 'r1' }], error: null }],
      });
      await createFacsAccessMappings(client, {
        imsOrgId: 'org-1',
        product: 'LLMO',
        resourceType: 'brand',
        resourceId: 'brand-x',
        grantedCapabilities: ['llmo/can_view'],
        subjects: [{ type: 'user', id: 'A@AdobeID' }],
      });
      expect(client.insertArgs[0].created_by).to.equal(null);
    });
  });

  describe('getFacsAccessMappingById', () => {
    for (const field of ['id', 'imsOrgId', 'product']) {
      it(`throws when ${field} is missing`, async () => {
        const client = fakePostgrestClient();
        const args = { id: 'm1', imsOrgId: 'org-1', product: 'LLMO' };
        delete args[field];
        try {
          await getFacsAccessMappingById(client, args);
          throw new Error('expected to throw');
        } catch (e) {
          expect(e.message).to.equal(`getFacsAccessMappingById: ${field} is required`);
        }
      });
    }

    it('filters by id, ims_org_id, product, and active rows; returns the row', async () => {
      const client = fakePostgrestClient({ readResult: { data: [{ id: 'm1' }], error: null } });
      const row = await getFacsAccessMappingById(client, { id: 'm1', imsOrgId: 'org-1', product: 'LLMO' });
      expect(row).to.deep.equal({ id: 'm1' });
      expect(client.fromCalls).to.include('facs_access_mappings');
      const eqCalls = client.readBuilder.eq.getCalls().map((c) => c.args);
      expect(eqCalls).to.deep.include(['id', 'm1']);
      expect(eqCalls).to.deep.include(['ims_org_id', 'org-1']);
      expect(eqCalls).to.deep.include(['product', 'LLMO']);
      expect(client.readBuilder.is.calledOnceWithExactly('revoked_at', null)).to.be.true;
    });

    it('returns null when no active row matches', async () => {
      const client = fakePostgrestClient({ readResult: { data: [], error: null } });
      const row = await getFacsAccessMappingById(client, { id: 'm1', imsOrgId: 'org-1', product: 'LLMO' });
      expect(row).to.equal(null);
    });

    it('throws when PostgREST returns an error', async () => {
      const client = fakePostgrestClient({ readResult: { data: null, error: { message: 'boom' } } });
      try {
        await getFacsAccessMappingById(client, { id: 'm1', imsOrgId: 'org-1', product: 'LLMO' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('getFacsAccessMappingById failed: boom');
      }
    });
  });

  describe('insertFacsAccessMappingAuditEvent', () => {
    const validEvent = {
      imsOrgId: 'org-1@AdobeOrg',
      product: 'LLMO',
      operation: 'create',
      outcome: 'allow',
      statusCode: 201,
    };

    for (const field of ['imsOrgId', 'product', 'operation', 'outcome']) {
      it(`throws when ${field} is missing`, async () => {
        const client = fakePostgrestClient();
        const event = { ...validEvent };
        delete event[field];
        try {
          await insertFacsAccessMappingAuditEvent(client, event);
          throw new Error('expected to throw');
        } catch (e) {
          expect(e.message).to.equal(`insertFacsAccessMappingAuditEvent: ${field} is required`);
        }
      });
    }

    it('throws when statusCode is not a number', async () => {
      const client = fakePostgrestClient();
      const event = { ...validEvent };
      delete event.statusCode;
      try {
        await insertFacsAccessMappingAuditEvent(client, event);
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('insertFacsAccessMappingAuditEvent: statusCode (number) is required');
      }
    });

    it('inserts a snake_case row into the audit-events table and returns it', async () => {
      const client = fakePostgrestClient({
        insertResults: [{ data: [{ id: 'evt-1' }], error: null }],
      });
      const result = await insertFacsAccessMappingAuditEvent(client, {
        ...validEvent,
        actorId: 'user-x@AdobeID',
        requestId: 'req-1',
        mappingId: 'map-1',
        bindingSubjectType: 'user',
        bindingSubjectId: 'someone@AdobeID',
        resourceType: 'brand',
        resourceId: 'brand-x',
        grantedCapabilities: ['llmo/can_view'],
        revokeReason: null,
      });
      expect(result).to.deep.equal({ id: 'evt-1' });
      expect(client.fromCalls).to.include('facs_access_mapping_audit_events');
      const row = client.insertArgs[0];
      expect(row).to.include({
        ims_org_id: 'org-1@AdobeOrg',
        product: 'LLMO',
        operation: 'create',
        outcome: 'allow',
        actor_id: 'user-x@AdobeID',
        request_id: 'req-1',
        mapping_id: 'map-1',
        binding_subject_type: 'user',
        binding_subject_id: 'someone@AdobeID',
        resource_type: 'brand',
        resource_id: 'brand-x',
      });
      expect(row.granted_capabilities).to.deep.equal(['llmo/can_view']);
      expect(row.status_code).to.equal(201);
    });

    it("coalesces NOT NULL actor_id / request_id to 'unknown' and nulls the rest", async () => {
      const client = fakePostgrestClient({
        insertResults: [{ data: [{ id: 'evt-2' }], error: null }],
      });
      await insertFacsAccessMappingAuditEvent(client, validEvent);
      const row = client.insertArgs[0];
      // actor_id and request_id are NOT NULL columns — coalesced, never null.
      expect(row.actor_id).to.equal('unknown');
      expect(row.request_id).to.equal('unknown');
      expect(row.mapping_id).to.equal(null);
      expect(row.granted_capabilities).to.equal(null);
      expect(row.revoke_reason).to.equal(null);
    });

    it('throws when PostgREST returns an error', async () => {
      const client = fakePostgrestClient({
        insertResults: [{ data: null, error: { message: 'permission denied' } }],
      });
      try {
        await insertFacsAccessMappingAuditEvent(client, validEvent);
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('insertFacsAccessMappingAuditEvent failed: permission denied');
      }
    });

    it('returns null when the insert yields no row', async () => {
      const client = fakePostgrestClient({
        insertResults: [{ data: [], error: null }],
      });
      const result = await insertFacsAccessMappingAuditEvent(client, validEvent);
      expect(result).to.equal(null);
    });
  });

  describe('revokeFacsAccessMappingById', () => {
    it('throws when id is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await revokeFacsAccessMappingById(client, { imsOrgId: 'org-1' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('revokeFacsAccessMappingById: id is required');
      }
    });

    it('throws when imsOrgId is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await revokeFacsAccessMappingById(client, { id: 'r1' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('revokeFacsAccessMappingById: imsOrgId is required');
      }
    });

    it('invokes wrpc_revoke_facs_access_mapping with the org-scoped args', async () => {
      const tombstone = { id: 'r1', revoked_at: '2026-05-22T12:00:00Z' };
      const client = fakePostgrestClient({
        rpcResult: { data: tombstone, error: null },
      });
      const out = await revokeFacsAccessMappingById(client, {
        id: 'r1',
        imsOrgId: 'org-1',
        revokedBy: 'admin@AdobeID',
        revokeReason: 'role change',
      });
      expect(out).to.deep.equal(tombstone);
      expect(client.rpc.calledOnceWithExactly('wrpc_revoke_facs_access_mapping', {
        p_id: 'r1',
        p_ims_org_id: 'org-1',
        p_revoked_by: 'admin@AdobeID',
        p_revoke_reason: 'role change',
      })).to.be.true;
    });

    it('passes null for optional revokedBy / revokeReason when omitted', async () => {
      const client = fakePostgrestClient({
        rpcResult: { data: { id: 'r1' }, error: null },
      });
      await revokeFacsAccessMappingById(client, { id: 'r1', imsOrgId: 'org-1' });
      const [, args] = client.rpc.firstCall.args;
      expect(args.p_revoked_by).to.equal(null);
      expect(args.p_revoke_reason).to.equal(null);
    });

    it('returns null when the RPC returns null (no active row matched)', async () => {
      const client = fakePostgrestClient({ rpcResult: { data: null, error: null } });
      const out = await revokeFacsAccessMappingById(client, { id: 'r1', imsOrgId: 'org-1' });
      expect(out).to.equal(null);
    });

    it('unwraps a single-element array (client variant)', async () => {
      const client = fakePostgrestClient({
        rpcResult: { data: [{ id: 'r1' }], error: null },
      });
      const out = await revokeFacsAccessMappingById(client, { id: 'r1', imsOrgId: 'org-1' });
      expect(out).to.deep.equal({ id: 'r1' });
    });

    it('returns null when the RPC returns an empty array', async () => {
      const client = fakePostgrestClient({ rpcResult: { data: [], error: null } });
      const out = await revokeFacsAccessMappingById(client, { id: 'r1', imsOrgId: 'org-1' });
      expect(out).to.equal(null);
    });

    it('returns null when the RPC returns an empty object (NULL row variant)', async () => {
      const client = fakePostgrestClient({ rpcResult: { data: {}, error: null } });
      const out = await revokeFacsAccessMappingById(client, { id: 'r1', imsOrgId: 'org-1' });
      expect(out).to.equal(null);
    });

    it('returns null when the RPC returns an all-NULL composite row (no match)', async () => {
      // `RETURNS facs_access_mappings` yields a row of all-null columns (not
      // SQL NULL) when no active row matches the id+org. Must be treated as
      // "not found" so the controller returns 404, not 204.
      const allNullRow = {
        id: null,
        subject_type: null,
        subject_id: null,
        resource_type: null,
        resource_id: null,
        ims_org_id: null,
        product: null,
        granted_capabilities: null,
        created_at: null,
        created_by: null,
        revoked_at: null,
        revoked_by: null,
        revoke_reason: null,
      };
      const client = fakePostgrestClient({ rpcResult: { data: allNullRow, error: null } });
      const out = await revokeFacsAccessMappingById(client, { id: 'r1', imsOrgId: 'org-1' });
      expect(out).to.equal(null);
    });

    it('throws with a meaningful message when the RPC returns an error', async () => {
      const client = fakePostgrestClient({
        rpcResult: { data: null, error: { message: 'permission denied' } },
      });
      try {
        await revokeFacsAccessMappingById(client, { id: 'r1', imsOrgId: 'org-1' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('revokeFacsAccessMappingById failed: permission denied');
      }
    });
  });

  describe('updateFacsAccessMappingCapabilities', () => {
    it('throws when id is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await updateFacsAccessMappingCapabilities(client, { imsOrgId: 'org-1', product: 'LLMO' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('updateFacsAccessMappingCapabilities: id is required');
      }
    });

    it('throws when imsOrgId is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await updateFacsAccessMappingCapabilities(client, { id: 'r1', product: 'LLMO' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('updateFacsAccessMappingCapabilities: imsOrgId is required');
      }
    });

    it('throws when product is missing', async () => {
      const client = fakePostgrestClient();
      try {
        await updateFacsAccessMappingCapabilities(client, { id: 'r1', imsOrgId: 'org-1' });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('updateFacsAccessMappingCapabilities: product is required');
      }
    });

    it('invokes wrpc_set_facs_access_mapping_capabilities with org + product scope', async () => {
      const updated = { id: 'r1', granted_capabilities: ['llmo/can_view', 'llmo/can_deploy'] };
      const client = fakePostgrestClient({ rpcResult: { data: updated, error: null } });
      const out = await updateFacsAccessMappingCapabilities(client, {
        id: 'r1',
        imsOrgId: 'org-1',
        product: 'LLMO',
        grantedCapabilities: ['llmo/can_view', 'llmo/can_deploy'],
      });
      expect(out).to.deep.equal(updated);
      const [fnName, args] = client.rpc.firstCall.args;
      expect(fnName).to.equal('wrpc_set_facs_access_mapping_capabilities');
      expect(args).to.deep.equal({
        p_id: 'r1',
        p_ims_org_id: 'org-1',
        p_product: 'LLMO',
        p_granted_capabilities: ['llmo/can_view', 'llmo/can_deploy'],
      });
    });

    it('defaults grantedCapabilities to an empty array when omitted', async () => {
      const client = fakePostgrestClient({ rpcResult: { data: { id: 'r1' }, error: null } });
      await updateFacsAccessMappingCapabilities(client, { id: 'r1', imsOrgId: 'org-1', product: 'LLMO' });
      expect(client.rpc.firstCall.args[1].p_granted_capabilities).to.deep.equal([]);
    });

    it('unwraps a single-element array (client variant)', async () => {
      const client = fakePostgrestClient({ rpcResult: { data: [{ id: 'r1' }], error: null } });
      const out = await updateFacsAccessMappingCapabilities(client, {
        id: 'r1', imsOrgId: 'org-1', product: 'LLMO', grantedCapabilities: ['llmo/can_view'],
      });
      expect(out).to.deep.equal({ id: 'r1' });
    });

    it('returns null on an all-NULL composite row (no active row matched)', async () => {
      const client = fakePostgrestClient({
        rpcResult: { data: { id: null, granted_capabilities: null }, error: null },
      });
      const out = await updateFacsAccessMappingCapabilities(client, {
        id: 'r1', imsOrgId: 'org-1', product: 'LLMO', grantedCapabilities: ['llmo/can_view'],
      });
      expect(out).to.equal(null);
    });

    it('throws with a meaningful message when the RPC returns an error', async () => {
      const client = fakePostgrestClient({
        rpcResult: { data: null, error: { message: 'permission denied' } },
      });
      try {
        await updateFacsAccessMappingCapabilities(client, {
          id: 'r1', imsOrgId: 'org-1', product: 'LLMO', grantedCapabilities: ['llmo/can_view'],
        });
        throw new Error('expected to throw');
      } catch (e) {
        expect(e.message).to.equal('updateFacsAccessMappingCapabilities failed: permission denied');
      }
    });
  });
});
