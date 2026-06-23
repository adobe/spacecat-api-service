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
import esmock from 'esmock';

use(chaiAsPromised);

const CALLER_ORG_BARE = 'CUST-ORG-001';
const CALLER_ORG_CANONICAL = 'CUST-ORG-001@AdobeOrg';
const CALLER_USER = 'user-abc@AdobeID';
const VALID_UUID_RES = '11111111-2222-4333-9444-555555555555';
const VALID_UUID_MAPPING = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';

function makeRow(overrides = {}) {
  return {
    id: VALID_UUID_MAPPING,
    subject_type: 'user',
    subject_id: 'someone@AdobeID',
    resource_type: 'brand',
    resource_id: VALID_UUID_RES,
    ims_org_id: CALLER_ORG_CANONICAL,
    product: 'LLMO',
    granted_capabilities: ['llmo/can_view'],
    created_by: CALLER_USER,
    created_at: '2026-01-01T00:00:00Z',
    updated_by: 'system',
    updated_at: '2026-01-01T00:00:00Z',
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
    ...overrides,
  };
}

function makeContext({
  product = 'LLMO',
  imsOrgId = CALLER_ORG_BARE,
  callerSub = CALLER_USER,
  body,
  pathParams,
  queryParams,
  postgrestClient = { from: () => {} },
  // Management endpoints are gated at the controller by `<product>/can_manage_users`
  // (the routes carry no ReBAC resource, so facsWrapper defers to the controller).
  // Default the caller to hold it for both products; gate-denial is covered by the
  // dedicated "controller-level can_manage_users gate" block, and the introspection
  // endpoints override this where empty JWT perms matter.
  facsPermissions = ['llmo/can_manage_users', 'aso/can_manage_users'],
  isAdmin = false,
  organization,
} = {}) {
  return {
    log: {
      debug: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    },
    attributes: {
      authInfo: {
        getTenantIds: () => (imsOrgId ? [imsOrgId] : []),
        getProfile: () => ({ sub: callerSub }),
        getFacsPermissions: () => facsPermissions,
        hasFacsPermission: (cap) => facsPermissions.includes(cap),
        isAdmin: () => isAdmin,
      },
    },
    data: body,
    // The controller reads path params (:id, :resourceId) from ctx.params
    // (the runtime source), not pathInfo.params.
    params: pathParams || {},
    // The controller reads query params from invocation.event.rawQueryString
    // (the Lambda runtime source), so serialize the queryParams arg into a
    // raw query string here. pathInfo.queryParams is retained for any other
    // readers but is no longer the controller's source of truth.
    invocation: {
      event: {
        rawQueryString: Object.entries(queryParams || {})
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&'),
      },
    },
    pathInfo: {
      params: pathParams || {},
      queryParams: queryParams || {},
      headers: product ? { 'x-product': product } : {},
    },
    dataAccess: {
      services: { postgrestClient },
      Organization: {
        findById: sinon.stub().resolves(organization ?? null),
      },
    },
  };
}

async function loadController(supportStubs = {}) {
  const stubs = {
    listFacsAccessMappings: sinon.stub().resolves([]),
    listFacsAccessMappingHistory: sinon.stub().resolves([]),
    createFacsAccessMappings: sinon.stub().resolves({ created: [], skipped: [] }),
    updateFacsAccessMappingCapabilities: sinon.stub().resolves(null),
    listFacsAccessMappingAuditEvents: sinon.stub().resolves([]),
    insertFacsAccessMappingAuditEvent: sinon.stub().resolves({}),
    getFacsAccessMappingById: sinon.stub().resolves(null),
    requirePostgrestForFacsMappings: () => null,
    ...supportStubs,
  };
  const mod = await esmock('../../src/controllers/state-access-mappings.js', {
    '../../src/support/state-access-mapping-utils.js': stubs,
  });
  return { Controller: mod.default, stubs };
}

describe('StateAccessMappingsController', () => {
  describe('preamble / common gates', () => {
    it('listMappings returns 503 when postgrest is unavailable', async () => {
      const { Controller } = await loadController({
        requirePostgrestForFacsMappings: () => ({ status: 503 }),
      });
      const ctx = makeContext();
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(503);
    });

    it('listMappings returns 400 when x-product is missing', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ product: null });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(400);
    });

    it('listMappings returns 400 when x-product is unknown', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ product: 'BOGUS' });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(400);
    });

    it('listMappings returns 403 when caller has no IMS org', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ imsOrgId: null });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(403);
    });
  });

  describe('GET /state/access-mappings (listMappings)', () => {
    it('returns 400 when neither subject nor resource filter is supplied', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext();
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when subjectType filter is invalid', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({
        queryParams: { subjectType: 'group', subjectId: 'x' },
      });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 200 with items and cursor:null when single page', async () => {
      const row = makeRow();
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([row]),
      });
      const ctx = makeContext({
        queryParams: { subjectType: 'user', subjectId: 'someone@AdobeID' },
      });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.items).to.have.lengthOf(1);
      expect(body.items[0].id).to.equal(row.id);
      expect(body.items[0].grantedCapabilities).to.deep.equal(['llmo/can_view']);
      expect(body.cursor).to.equal(null);
    });

    it('returns next cursor when more rows are available', async () => {
      // Fetch 22 rows with limit=20 → 20 returned + 1 over-fetch + 1 next-page row
      // to ensure hasMore=true.
      const rows = Array.from({ length: 22 }, (_, i) => makeRow({ id: `id-${i}` }));
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves(rows),
      });
      const ctx = makeContext({
        queryParams: {
          subjectType: 'user', subjectId: 'x', limit: '20',
        },
      });
      const res = await Controller(ctx).listMappings(ctx);
      const body = await res.json();
      expect(body.items).to.have.lengthOf(20);
      expect(body.cursor).to.be.a('string');
    });

    it('accepts a cursor and offsets correctly', async () => {
      const rows = Array.from({ length: 30 }, (_, i) => makeRow({ id: `id-${i}` }));
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves(rows),
      });
      const cursor = Buffer.from(JSON.stringify({ offset: 20 }), 'utf8').toString('base64url');
      const ctx = makeContext({
        queryParams: {
          subjectType: 'user', subjectId: 'x', limit: '5', cursor,
        },
      });
      const res = await Controller(ctx).listMappings(ctx);
      const body = await res.json();
      expect(body.items[0].id).to.equal('id-20');
      expect(body.items).to.have.lengthOf(5);
    });

    it('ignores a malformed cursor (treats as offset=0)', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => makeRow({ id: `id-${i}` }));
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves(rows),
      });
      const ctx = makeContext({
        queryParams: {
          subjectType: 'user', subjectId: 'x', cursor: '!!!not-base64!!!',
        },
      });
      const res = await Controller(ctx).listMappings(ctx);
      const body = await res.json();
      expect(body.items).to.have.lengthOf(3);
    });

    it('ignores a cursor with a negative offset', async () => {
      const rows = [makeRow()];
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves(rows),
      });
      const cursor = Buffer.from(JSON.stringify({ offset: -5 }), 'utf8').toString('base64url');
      const ctx = makeContext({
        queryParams: { resourceType: 'brand', resourceId: VALID_UUID_RES, cursor },
      });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(200);
    });

    it('returns 500 when the helper throws', async () => {
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().rejects(new Error('boom')),
      });
      const ctx = makeContext({
        queryParams: { resourceType: 'brand', resourceId: VALID_UUID_RES },
      });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(500);
    });
  });

  describe('GET /state/access-mappings/history (listHistory)', () => {
    it('returns 400 when neither subject nor resource filter is supplied', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext();
      const res = await Controller(ctx).listHistory(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 on invalid subjectType', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({
        queryParams: { subjectType: 'bogus', subjectId: 'x' },
      });
      const res = await Controller(ctx).listHistory(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns items including revoked rows', async () => {
      const live = makeRow();
      const dead = makeRow({ id: 'tomb', revoked_at: '2026-01-02T00:00:00Z' });
      const { Controller } = await loadController({
        listFacsAccessMappingHistory: sinon.stub().resolves([live, dead]),
      });
      const ctx = makeContext({
        queryParams: { subjectType: 'user', subjectId: 'someone@AdobeID' },
      });
      const res = await Controller(ctx).listHistory(ctx);
      const body = await res.json();
      expect(body.items).to.have.lengthOf(2);
      expect(body.items[1].revokedAt).to.equal('2026-01-02T00:00:00Z');
    });

    it('returns 500 when the helper throws', async () => {
      const { Controller } = await loadController({
        listFacsAccessMappingHistory: sinon.stub().rejects(new Error('boom')),
      });
      const ctx = makeContext({
        queryParams: { resourceType: 'brand', resourceId: VALID_UUID_RES },
      });
      const res = await Controller(ctx).listHistory(ctx);
      expect(res.status).to.equal(500);
    });

    it('paginates via cursor', async () => {
      const rows = Array.from({ length: 30 }, (_, i) => makeRow({ id: `id-${i}` }));
      const { Controller } = await loadController({
        listFacsAccessMappingHistory: sinon.stub().resolves(rows),
      });
      const ctx = makeContext({
        queryParams: { subjectType: 'user', subjectId: 'x', limit: '10' },
      });
      const res = await Controller(ctx).listHistory(ctx);
      const body = await res.json();
      expect(body.items).to.have.lengthOf(10);
      expect(body.cursor).to.be.a('string');
    });
  });

  describe('POST /state/access-mappings (createMapping)', () => {
    const validBody = {
      subjectType: 'user',
      subjectId: 'someone@AdobeID',
      resourceType: 'brand',
      resourceId: VALID_UUID_RES,
      grantedCapabilities: ['llmo/can_view'],
    };

    it('returns 400 when body is missing', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ body: null });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 for invalid subjectType', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ body: { ...validBody, subjectType: 'group' } });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when subjectId is missing', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ body: { ...validBody, subjectId: '' } });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when user subjectId is not canonical', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ body: { ...validBody, subjectId: 'noatsign' } });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 403 when org subjectId differs from caller org', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({
        body: {
          ...validBody, subjectType: 'org', subjectId: 'OTHER@AdobeOrg',
        },
      });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(403);
    });

    it('accepts org subjectId equal to caller canonical org', async () => {
      const row = makeRow({ subject_type: 'org', subject_id: CALLER_ORG_CANONICAL });
      const { Controller } = await loadController({
        createFacsAccessMappings: sinon.stub().resolves({ created: [row], skipped: [] }),
      });
      const ctx = makeContext({
        body: {
          ...validBody, subjectType: 'org', subjectId: CALLER_ORG_CANONICAL,
        },
      });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(201);
    });

    it('returns 400 for unknown resourceType under the product', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ body: { ...validBody, resourceType: 'site' } });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when resourceId is empty', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ body: { ...validBody, resourceId: '' } });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when grantedCapabilities is empty', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ body: { ...validBody, grantedCapabilities: [] } });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when a granted capability has the wrong product prefix', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({
        body: { ...validBody, grantedCapabilities: ['aso/can_view'] },
      });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when a granted capability is not in the catalog', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({
        body: { ...validBody, grantedCapabilities: ['llmo/do_anything'] },
      });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when a granted capability is an empty string', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({
        body: { ...validBody, grantedCapabilities: [''] },
      });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 201 with the created mapping DTO', async () => {
      const row = makeRow();
      const { Controller } = await loadController({
        createFacsAccessMappings: sinon.stub().resolves({ created: [row], skipped: [] }),
      });
      const ctx = makeContext({ body: validBody });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body.id).to.equal(row.id);
      expect(body.grantedCapabilities).to.deep.equal(['llmo/can_view']);
      // DTO surfaces the updated_by/updated_at columns added to the table.
      expect(body.updatedBy).to.equal('system');
      expect(body.updatedAt).to.equal('2026-01-01T00:00:00Z');
    });

    it('emits a create audit event (allow) on success', async () => {
      const row = makeRow();
      const { Controller, stubs } = await loadController({
        createFacsAccessMappings: sinon.stub().resolves({ created: [row], skipped: [] }),
      });
      const ctx = makeContext({ body: validBody });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(201);
      expect(stubs.insertFacsAccessMappingAuditEvent.calledOnce).to.be.true;
      const event = stubs.insertFacsAccessMappingAuditEvent.firstCall.args[1];
      expect(event).to.include({
        product: 'LLMO',
        operation: 'create',
        outcome: 'allow',
        mappingId: row.id,
      });
      expect(event.actorId).to.equal(CALLER_USER);
    });

    it('still returns 201 when the audit write fails (logs a warning, not failure)', async () => {
      const row = makeRow();
      const ctx = makeContext({ body: validBody });
      const { Controller } = await loadController({
        createFacsAccessMappings: sinon.stub().resolves({ created: [row], skipped: [] }),
        insertFacsAccessMappingAuditEvent: sinon.stub().rejects(new Error('audit table down')),
      });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(201);
      expect(ctx.log.warn.called).to.be.true;
    });

    it('returns 409 when an active duplicate exists', async () => {
      const existing = makeRow({ id: 'pre-existing-id' });
      const { Controller } = await loadController({
        createFacsAccessMappings: sinon.stub().resolves({
          created: [],
          skipped: [{ subject: { type: 'user', id: 'someone@AdobeID' }, reason: 'duplicate' }],
        }),
        listFacsAccessMappings: sinon.stub().resolves([existing]),
      });
      const ctx = makeContext({ body: validBody });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(409);
      const body = await res.json();
      expect(body.id).to.equal('pre-existing-id');
    });

    it('returns 409 with null id when conflict lookup misses', async () => {
      const { Controller } = await loadController({
        createFacsAccessMappings: sinon.stub().resolves({
          created: [],
          skipped: [{ subject: { type: 'user', id: 'someone@AdobeID' }, reason: 'duplicate' }],
        }),
        listFacsAccessMappings: sinon.stub().resolves([]),
      });
      const ctx = makeContext({ body: validBody });
      const res = await Controller(ctx).createMapping(ctx);
      const body = await res.json();
      expect(res.status).to.equal(409);
      expect(body.id).to.equal(null);
    });

    it('returns 500 when the helper throws', async () => {
      const { Controller } = await loadController({
        createFacsAccessMappings: sinon.stub().rejects(new Error('boom')),
      });
      const ctx = makeContext({ body: validBody });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(500);
    });
  });

  describe('PATCH /state/access-mappings/:id (patchMapping)', () => {
    it('returns 400 when id is not a UUID', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ pathParams: { id: 'not-uuid' }, body: { grantedCapabilities: ['llmo/can_view'] } });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when body is missing', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ pathParams: { id: VALID_UUID_MAPPING }, body: null });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 on invalid grantedCapabilities', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: ['llmo/nope'] },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when grantedCapabilities is not an array', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: 'llmo/can_view' },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('allows emptying the capability set (active row that grants nothing)', async () => {
      const updated = makeRow({ granted_capabilities: [] });
      const { Controller, stubs } = await loadController({
        updateFacsAccessMappingCapabilities: sinon.stub().resolves(updated),
      });
      const ctx = makeContext({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: [] },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.grantedCapabilities).to.deep.equal([]);
      expect(stubs.updateFacsAccessMappingCapabilities.firstCall.args[1].grantedCapabilities)
        .to.deep.equal([]);
    });

    it('returns 200 with the updated row (via the capability-edit RPC helper)', async () => {
      const updated = makeRow({ granted_capabilities: ['llmo/can_view', 'llmo/can_configure'] });
      const updateStub = sinon.stub().resolves(updated);
      const { Controller, stubs } = await loadController({
        updateFacsAccessMappingCapabilities: updateStub,
      });
      const ctx = makeContext({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: ['llmo/can_view', 'llmo/can_configure'] },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.grantedCapabilities).to.deep.equal(['llmo/can_view', 'llmo/can_configure']);
      // Helper invoked with org + product scope and the new capability set.
      expect(stubs.updateFacsAccessMappingCapabilities.calledOnce).to.be.true;
      const args = stubs.updateFacsAccessMappingCapabilities.firstCall.args[1];
      expect(args).to.include({ id: VALID_UUID_MAPPING, product: 'LLMO' });
      expect(args.grantedCapabilities).to.deep.equal(['llmo/can_view', 'llmo/can_configure']);
    });

    it('emits an update_capabilities audit event (allow) on success', async () => {
      const updated = makeRow({ granted_capabilities: ['llmo/can_view', 'llmo/can_configure'] });
      const { Controller, stubs } = await loadController({
        updateFacsAccessMappingCapabilities: sinon.stub().resolves(updated),
      });
      const ctx = makeContext({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: ['llmo/can_view', 'llmo/can_configure'] },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(200);
      expect(stubs.insertFacsAccessMappingAuditEvent.calledOnce).to.be.true;
      const event = stubs.insertFacsAccessMappingAuditEvent.firstCall.args[1];
      expect(event).to.include({
        operation: 'update_capabilities',
        outcome: 'allow',
        mappingId: updated.id,
      });
      expect(event.grantedCapabilities).to.deep.equal(['llmo/can_view', 'llmo/can_configure']);
    });

    it('does not emit an audit event and still 200s when audit write fails', async () => {
      const updated = makeRow();
      const ctx = makeContext({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: ['llmo/can_view'] },
      });
      const { Controller } = await loadController({
        updateFacsAccessMappingCapabilities: sinon.stub().resolves(updated),
        insertFacsAccessMappingAuditEvent: sinon.stub().rejects(new Error('boom')),
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(200);
      expect(ctx.log.warn.called).to.be.true;
    });

    it('returns 404 when no active row matched', async () => {
      const { Controller } = await loadController({
        updateFacsAccessMappingCapabilities: sinon.stub().resolves(null),
      });
      const ctx = makeContext({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: ['llmo/can_view'] },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(404);
    });

    it('returns 500 when the RPC helper throws', async () => {
      const { Controller } = await loadController({
        updateFacsAccessMappingCapabilities: sinon.stub().rejects(new Error('db down')),
      });
      const ctx = makeContext({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: ['llmo/can_view'] },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(500);
    });
  });

  describe('controller-level can_manage_users gate', () => {
    // These routes carry no ReBAC-scoped resource, so facsWrapper defers to the
    // controller when the JWT lacks the capability. The controller must enforce
    // `<product>/can_manage_users` itself (admin bypasses).
    const denyCtx = (over = {}) => makeContext({
      facsPermissions: [], isAdmin: false, ...over,
    });

    it('listMappings returns 403 without can_manage_users', async () => {
      const { Controller } = await loadController();
      const ctx = denyCtx({ queryParams: { subjectType: 'org', subjectId: CALLER_ORG_CANONICAL } });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(403);
    });

    it('listHistory returns 403 without can_manage_users', async () => {
      const { Controller } = await loadController();
      const ctx = denyCtx({ queryParams: { subjectType: 'org', subjectId: CALLER_ORG_CANONICAL } });
      const res = await Controller(ctx).listHistory(ctx);
      expect(res.status).to.equal(403);
    });

    it('createMapping returns 403 without can_manage_users', async () => {
      const { Controller } = await loadController();
      const ctx = denyCtx({
        body: {
          subjectType: 'user',
          subjectId: 'someone@AdobeID',
          resourceType: 'brand',
          resourceId: VALID_UUID_RES,
          grantedCapabilities: ['llmo/can_view'],
        },
      });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(403);
    });

    it('patchMapping returns 403 without can_manage_users', async () => {
      const { Controller } = await loadController();
      const ctx = denyCtx({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: ['llmo/can_view'] },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(403);
    });

    it('admin bypasses the gate (listMappings reaches the handler)', async () => {
      const { Controller, stubs } = await loadController();
      const ctx = makeContext({
        facsPermissions: [],
        isAdmin: true,
        queryParams: { subjectType: 'org', subjectId: CALLER_ORG_CANONICAL },
      });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(200);
      expect(stubs.listFacsAccessMappings.called).to.be.true;
    });

    it('flow 8.3: a state-layer manager passes the gate for a resource they manage', async () => {
      // The caller's own user binding carries can_manage_users on VALID_UUID_RES.
      // A resource-scoped read on that resource is allowed.
      const managerRow = makeRow({
        subject_type: 'user',
        subject_id: CALLER_USER,
        resource_id: VALID_UUID_RES,
        granted_capabilities: ['llmo/can_manage_users'],
      });
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([managerRow]),
      });
      const ctx = denyCtx({
        queryParams: { resourceType: 'brand', resourceId: VALID_UUID_RES },
      });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(200);
    });

    it('flow 8.3: a state-layer manager is denied an org-wide (subject-only) read', async () => {
      const managerRow = makeRow({
        subject_type: 'user',
        subject_id: CALLER_USER,
        resource_id: VALID_UUID_RES,
        granted_capabilities: ['llmo/can_manage_users'],
      });
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([managerRow]),
      });
      const ctx = denyCtx({
        queryParams: { subjectType: 'org', subjectId: CALLER_ORG_CANONICAL },
      });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(403);
    });

    it('flow 8.3: a state-layer manager is denied a read on a resource they do NOT manage', async () => {
      const managerRow = makeRow({
        subject_type: 'user',
        subject_id: CALLER_USER,
        resource_id: VALID_UUID_RES,
        granted_capabilities: ['llmo/can_manage_users'],
      });
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([managerRow]),
      });
      const ctx = denyCtx({
        queryParams: { resourceType: 'brand', resourceId: 'cccccccc-cccc-4ccc-9ccc-cccccccccccc' },
      });
      const res = await Controller(ctx).listMappings(ctx);
      expect(res.status).to.equal(403);
    });
  });

  describe('flow 8.3: granting can_manage_users requires FACS-layer can_manage_users', () => {
    const manageBody = {
      subjectType: 'user',
      subjectId: 'someone@AdobeID',
      resourceType: 'brand',
      resourceId: VALID_UUID_RES,
      grantedCapabilities: ['llmo/can_view', 'llmo/can_manage_users'],
    };

    it('createMapping 403s when a state-layer manager grants can_manage_users', async () => {
      // Caller passes the gate via a state-layer can_manage_users binding, but
      // may NOT mint a new manager — that requires FACS-layer authority.
      const managerRow = makeRow({
        subject_type: 'user', subject_id: CALLER_USER, granted_capabilities: ['llmo/can_manage_users'],
      });
      const { Controller, stubs } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([managerRow]),
      });
      const ctx = makeContext({ facsPermissions: [], isAdmin: false, body: manageBody });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(403);
      expect(stubs.createFacsAccessMappings.called).to.be.false;
    });

    it('createMapping allows a FACS-layer manager to grant can_manage_users', async () => {
      const created = makeRow({ granted_capabilities: ['llmo/can_view', 'llmo/can_manage_users'] });
      const { Controller } = await loadController({
        createFacsAccessMappings: sinon.stub().resolves({ created: [created], skipped: [] }),
      });
      const ctx = makeContext({ facsPermissions: ['llmo/can_manage_users'], isAdmin: false, body: manageBody });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(201);
    });

    it('patchMapping 403s when a state-layer manager adds can_manage_users', async () => {
      const managerRow = makeRow({
        subject_type: 'user', subject_id: CALLER_USER, granted_capabilities: ['llmo/can_manage_users'],
      });
      const { Controller, stubs } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([managerRow]),
      });
      const ctx = makeContext({
        facsPermissions: [],
        isAdmin: false,
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: ['llmo/can_manage_users'] },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(403);
      expect(stubs.updateFacsAccessMappingCapabilities.called).to.be.false;
    });

    it('admin may grant can_manage_users', async () => {
      const created = makeRow({ granted_capabilities: ['llmo/can_manage_users'] });
      const { Controller } = await loadController({
        createFacsAccessMappings: sinon.stub().resolves({ created: [created], skipped: [] }),
      });
      const ctx = makeContext({
        facsPermissions: [],
        isAdmin: true,
        body: { ...manageBody, grantedCapabilities: ['llmo/can_manage_users'] },
      });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(201);
    });
  });

  describe('flow 8.3: state-layer managers are scoped to resources they manage', () => {
    const MANAGED = VALID_UUID_RES;
    const UNMANAGED = 'cccccccc-cccc-4ccc-9ccc-cccccccccccc';
    // The caller manages MANAGED via a state-layer can_manage_users binding.
    const managerRow = () => makeRow({
      subject_type: 'user',
      subject_id: CALLER_USER,
      resource_id: MANAGED,
      granted_capabilities: ['llmo/can_manage_users'],
    });
    const stateMgrCtx = (over = {}) => makeContext({
      facsPermissions: [], isAdmin: false, ...over,
    });

    it('createMapping allows a binding on a managed resource', async () => {
      const created = makeRow({ resource_id: MANAGED });
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([managerRow()]),
        createFacsAccessMappings: sinon.stub().resolves({ created: [created], skipped: [] }),
      });
      const ctx = stateMgrCtx({
        body: {
          subjectType: 'user',
          subjectId: 'grantee@AdobeID',
          resourceType: 'brand',
          resourceId: MANAGED,
          grantedCapabilities: ['llmo/can_view'],
        },
      });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(201);
    });

    it('createMapping 403s on a resource the caller does NOT manage', async () => {
      const { Controller, stubs } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([managerRow()]),
      });
      const ctx = stateMgrCtx({
        body: {
          subjectType: 'user',
          subjectId: 'grantee@AdobeID',
          resourceType: 'brand',
          resourceId: UNMANAGED,
          grantedCapabilities: ['llmo/can_view'],
        },
      });
      const res = await Controller(ctx).createMapping(ctx);
      expect(res.status).to.equal(403);
      expect(stubs.createFacsAccessMappings.called).to.be.false;
    });

    it('patchMapping allows editing a binding on a managed resource', async () => {
      const updated = makeRow({ resource_id: MANAGED, granted_capabilities: ['llmo/can_view'] });
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([managerRow()]),
        getFacsAccessMappingById: sinon.stub().resolves(makeRow({ resource_id: MANAGED })),
        updateFacsAccessMappingCapabilities: sinon.stub().resolves(updated),
      });
      const ctx = stateMgrCtx({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: ['llmo/can_view'] },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(200);
    });

    it('patchMapping 403s when the target row is on an unmanaged resource', async () => {
      const { Controller, stubs } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([managerRow()]),
        getFacsAccessMappingById: sinon.stub().resolves(makeRow({ resource_id: UNMANAGED })),
      });
      const ctx = stateMgrCtx({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: ['llmo/can_view'] },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(403);
      expect(stubs.updateFacsAccessMappingCapabilities.called).to.be.false;
    });

    it('patchMapping 404s when the target row does not exist', async () => {
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([managerRow()]),
        getFacsAccessMappingById: sinon.stub().resolves(null),
      });
      const ctx = stateMgrCtx({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { grantedCapabilities: ['llmo/can_view'] },
      });
      const res = await Controller(ctx).patchMapping(ctx);
      expect(res.status).to.equal(404);
    });

    it('getAuditLogs 403s for a state-layer manager (org-wide read is FACS-only)', async () => {
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().resolves([managerRow()]),
      });
      const ctx = stateMgrCtx({ pathParams: { organizationId: '99999999-8888-4777-9666-555555555555' } });
      const res = await Controller(ctx).getAuditLogs(ctx);
      expect(res.status).to.equal(403);
    });
  });

  describe('GET /product/capabilities', () => {
    it('returns 400 when x-product is missing', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ product: null });
      const res = await Controller(ctx).getProductCapabilities(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns the sorted catalog for LLMO', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext();
      const res = await Controller(ctx).getProductCapabilities(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.product).to.equal('LLMO');
      expect(body.capabilities).to.include('llmo/can_view');
      expect(body.capabilities).to.include('llmo/can_manage_users');
      // Sorted, deduplicated.
      const sorted = [...body.capabilities].sort();
      expect(body.capabilities).to.deep.equal(sorted);
      expect(new Set(body.capabilities).size).to.equal(body.capabilities.length);
    });

    it('flow 8.3: omits can_manage_users for a non-FACS-manager caller', async () => {
      // A state-layer manager (or any non-FACS caller) may assign every
      // capability EXCEPT can_manage_users — only FACS managers mint managers.
      const { Controller } = await loadController();
      const ctx = makeContext({ facsPermissions: [], isAdmin: false });
      const res = await Controller(ctx).getProductCapabilities(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.capabilities).to.include('llmo/can_view');
      expect(body.capabilities).to.not.include('llmo/can_manage_users');
    });

    it('flow 8.3: includes can_manage_users for a FACS-manager caller', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ facsPermissions: ['llmo/can_manage_users'], isAdmin: false });
      const res = await Controller(ctx).getProductCapabilities(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.capabilities).to.include('llmo/can_manage_users');
    });

    it('returns the catalog for ASO', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ product: 'ASO' });
      const res = await Controller(ctx).getProductCapabilities(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.product).to.equal('ASO');
      // Catalog is sourced from PRODUCTS_CAPABILITIES, not derived from
      // PRODUCTS_ROUTES values. The full ASO catalog is surfaced even when
      // a capability has no route consumers today.
      expect(body.capabilities).to.include.members([
        'aso/can_view',
        'aso/can_edit',
        'aso/can_deploy',
        'aso/can_configure',
        'aso/can_manage_users',
      ]);
    });
  });

  describe('GET /user/capabilities/:resourceId', () => {
    it('returns 503 when postgrest is unavailable', async () => {
      const { Controller } = await loadController({
        requirePostgrestForFacsMappings: () => ({ status: 503 }),
      });
      const ctx = makeContext({ pathParams: { resourceId: VALID_UUID_RES } });
      const res = await Controller(ctx).getUserCapabilities(ctx);
      expect(res.status).to.equal(503);
    });

    it('returns 400 when x-product is missing', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ product: null, pathParams: { resourceId: VALID_UUID_RES } });
      const res = await Controller(ctx).getUserCapabilities(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 403 when caller has no IMS org', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ imsOrgId: null, pathParams: { resourceId: VALID_UUID_RES } });
      const res = await Controller(ctx).getUserCapabilities(ctx);
      expect(res.status).to.equal(403);
    });

    it('returns 400 when resourceId is missing', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ pathParams: {} });
      const res = await Controller(ctx).getUserCapabilities(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when the product has no FACS resources (ACO)', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ product: 'ACO', pathParams: { resourceId: VALID_UUID_RES } });
      const res = await Controller(ctx).getUserCapabilities(ctx);
      expect(res.status).to.equal(400);
    });

    it('unions JWT facs_permissions, user state, and org state with provenance', async () => {
      const userRow = makeRow({
        subject_type: 'user', subject_id: CALLER_USER, granted_capabilities: ['llmo/can_view', 'llmo/can_configure'],
      });
      const orgRow = makeRow({
        subject_type: 'org', subject_id: CALLER_ORG_CANONICAL, granted_capabilities: ['llmo/can_view', 'llmo/can_onboard'],
      });
      const stub = sinon.stub();
      stub.withArgs(sinon.match.any, sinon.match({ subjectType: 'user' })).resolves([userRow]);
      stub.withArgs(sinon.match.any, sinon.match({ subjectType: 'org' })).resolves([orgRow]);
      const { Controller } = await loadController({ listFacsAccessMappings: stub });
      const ctx = makeContext({
        pathParams: { resourceId: VALID_UUID_RES },
        facsPermissions: ['llmo/can_view', 'aso/can_view'],
      });
      const res = await Controller(ctx).getUserCapabilities(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.resourceType).to.equal('brand');
      expect(body.capabilities).to.include.members([
        'llmo/can_view', 'llmo/can_configure', 'llmo/can_onboard',
      ]);
      expect(body.provenance['llmo/can_view']).to.include.members(['jwt', 'state:user', 'state:org']);
      expect(body.provenance['llmo/can_configure']).to.deep.equal(['state:user']);
      expect(body.provenance['llmo/can_onboard']).to.deep.equal(['state:org']);
      // Cross-product JWT permissions are filtered out.
      expect(body.capabilities.some((c) => c.startsWith('aso/'))).to.be.false;
    });

    it('skips the user-state query when no caller sub is available', async () => {
      const orgRow = makeRow({
        subject_type: 'org', subject_id: CALLER_ORG_CANONICAL, granted_capabilities: ['llmo/can_view'],
      });
      const stub = sinon.stub().resolves([orgRow]);
      const { Controller } = await loadController({ listFacsAccessMappings: stub });
      const ctx = makeContext({
        callerSub: null, pathParams: { resourceId: VALID_UUID_RES }, facsPermissions: [],
      });
      const res = await Controller(ctx).getUserCapabilities(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.capabilities).to.deep.equal(['llmo/can_view']);
      expect(body.provenance['llmo/can_view']).to.deep.equal(['state:org']);
    });

    it('returns 500 when state-layer lookup throws', async () => {
      const { Controller } = await loadController({
        listFacsAccessMappings: sinon.stub().rejects(new Error('boom')),
      });
      const ctx = makeContext({ pathParams: { resourceId: VALID_UUID_RES } });
      const res = await Controller(ctx).getUserCapabilities(ctx);
      expect(res.status).to.equal(500);
    });

    it('handles a row whose granted_capabilities is null', async () => {
      const orgRow = makeRow({
        subject_type: 'org', subject_id: CALLER_ORG_CANONICAL, granted_capabilities: null,
      });
      const stub = sinon.stub().resolves([orgRow]);
      const { Controller } = await loadController({ listFacsAccessMappings: stub });
      const ctx = makeContext({
        pathParams: { resourceId: VALID_UUID_RES },
        facsPermissions: [123, null], // non-string facs perms are ignored
      });
      const res = await Controller(ctx).getUserCapabilities(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.capabilities).to.deep.equal([]);
    });
  });

  describe('GET /organizations/:organizationId/permission/audit-logs (getAuditLogs)', () => {
    const ORG_ID = '99999999-8888-4777-9666-555555555555';
    const MANAGE = ['llmo/can_manage_users'];
    const orgWithImsOrg = (imsOrg) => ({ getImsOrgId: () => imsOrg });

    it('returns 403 when caller is not admin and lacks can_manage_users', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ pathParams: { organizationId: ORG_ID }, facsPermissions: [] });
      const res = await Controller(ctx).getAuditLogs(ctx);
      expect(res.status).to.equal(403);
    });

    it('returns 400 for an invalid organizationId', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ pathParams: { organizationId: 'not-a-uuid' }, facsPermissions: MANAGE });
      const res = await Controller(ctx).getAuditLogs(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 404 when the organization is not found', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({
        pathParams: { organizationId: ORG_ID }, facsPermissions: MANAGE, organization: null,
      });
      const res = await Controller(ctx).getAuditLogs(ctx);
      expect(res.status).to.equal(404);
    });

    it("returns 403 when the org's IMS org differs from the caller's (cross-org)", async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({
        pathParams: { organizationId: ORG_ID },
        facsPermissions: MANAGE,
        organization: orgWithImsOrg('OTHER-ORG'),
      });
      const res = await Controller(ctx).getAuditLogs(ctx);
      expect(res.status).to.equal(403);
    });

    it('returns 200 with mapped audit events for the caller\'s own org', async () => {
      const rows = [{
        id: 'e1',
        created_at: '2026-06-15T00:00:00Z',
        request_id: 'r1',
        ims_org_id: CALLER_ORG_CANONICAL,
        actor_id: 'admin@AdobeID',
        operation: 'create',
        outcome: 'allow',
        status_code: 201,
        resource_type: 'brand',
        resource_id: 'b1',
        product: 'LLMO',
        granted_capabilities: ['llmo/can_view'],
      }];
      const auditStub = sinon.stub().resolves(rows);
      const { Controller, stubs } = await loadController({
        listFacsAccessMappingAuditEvents: auditStub,
      });
      const ctx = makeContext({
        pathParams: { organizationId: ORG_ID },
        facsPermissions: MANAGE,
        organization: orgWithImsOrg(CALLER_ORG_BARE),
      });
      const res = await Controller(ctx).getAuditLogs(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.items).to.have.lengthOf(1);
      expect(body.items[0]).to.include({
        id: 'e1', actorId: 'admin@AdobeID', operation: 'create', outcome: 'allow',
      });
      // Queried with the RESOLVED org's IMS id (not the path UUID) + product.
      const args = stubs.listFacsAccessMappingAuditEvents.firstCall.args[1];
      expect(args).to.include({ imsOrgId: CALLER_ORG_CANONICAL, product: 'LLMO' });
    });

    it('admin may read another org\'s audit (tenant check bypassed)', async () => {
      const { Controller } = await loadController({
        listFacsAccessMappingAuditEvents: sinon.stub().resolves([]),
      });
      const ctx = makeContext({
        pathParams: { organizationId: ORG_ID },
        isAdmin: true,
        facsPermissions: [],
        organization: orgWithImsOrg('OTHER-ORG'),
      });
      const res = await Controller(ctx).getAuditLogs(ctx);
      expect(res.status).to.equal(200);
    });

    it('returns 500 when the organization lookup throws', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ pathParams: { organizationId: ORG_ID }, facsPermissions: MANAGE });
      ctx.dataAccess.Organization.findById = sinon.stub().rejects(new Error('db down'));
      const res = await Controller(ctx).getAuditLogs(ctx);
      expect(res.status).to.equal(500);
    });

    it('returns 404 when the organization has no IMS org', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({
        pathParams: { organizationId: ORG_ID },
        facsPermissions: MANAGE,
        organization: orgWithImsOrg(null),
      });
      const res = await Controller(ctx).getAuditLogs(ctx);
      expect(res.status).to.equal(404);
    });

    it('returns 500 when the audit query throws', async () => {
      const { Controller } = await loadController({
        listFacsAccessMappingAuditEvents: sinon.stub().rejects(new Error('boom')),
      });
      const ctx = makeContext({
        pathParams: { organizationId: ORG_ID },
        facsPermissions: MANAGE,
        organization: orgWithImsOrg(CALLER_ORG_BARE),
      });
      const res = await Controller(ctx).getAuditLogs(ctx);
      expect(res.status).to.equal(500);
    });

    it('returns a cursor when more rows are available than the page size', async () => {
      const rows = [
        {
          id: 'e1', created_at: 't2', operation: 'create', outcome: 'allow',
        },
        {
          id: 'e2', created_at: 't1', operation: 'revoke', outcome: 'allow',
        },
      ];
      const { Controller } = await loadController({
        listFacsAccessMappingAuditEvents: sinon.stub().resolves(rows),
      });
      const ctx = makeContext({
        pathParams: { organizationId: ORG_ID },
        facsPermissions: MANAGE,
        organization: orgWithImsOrg(CALLER_ORG_BARE),
        queryParams: { limit: '1' },
      });
      const res = await Controller(ctx).getAuditLogs(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.items).to.have.lengthOf(1);
      expect(body.cursor).to.not.equal(null);
    });
  });
});
