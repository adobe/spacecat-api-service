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
  facsPermissions = [],
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
    },
  };
}

async function loadController(supportStubs = {}) {
  const stubs = {
    listFacsAccessMappings: sinon.stub().resolves([]),
    listFacsAccessMappingHistory: sinon.stub().resolves([]),
    createFacsAccessMappings: sinon.stub().resolves({ created: [], skipped: [] }),
    revokeFacsAccessMappingById: sinon.stub().resolves(null),
    updateFacsAccessMappingCapabilities: sinon.stub().resolves(null),
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

  describe('DELETE /state/access-mappings/:id (revokeMapping)', () => {
    it('returns 400 when id is not a UUID', async () => {
      const { Controller } = await loadController();
      const ctx = makeContext({ pathParams: { id: 'not-uuid' } });
      const res = await Controller(ctx).revokeMapping(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 503 when postgrest is unavailable', async () => {
      const { Controller } = await loadController({
        requirePostgrestForFacsMappings: () => ({ status: 503 }),
      });
      const ctx = makeContext({ pathParams: { id: VALID_UUID_MAPPING } });
      const res = await Controller(ctx).revokeMapping(ctx);
      expect(res.status).to.equal(503);
    });

    it('returns 204 when a tombstone is returned', async () => {
      const { Controller } = await loadController({
        revokeFacsAccessMappingById: sinon.stub().resolves(makeRow({ revoked_at: '2026-01-02T00:00:00Z' })),
      });
      const ctx = makeContext({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { reason: 'user-request' },
      });
      const res = await Controller(ctx).revokeMapping(ctx);
      expect(res.status).to.equal(204);
    });

    it('returns 204 with no reason in body', async () => {
      const { Controller } = await loadController({
        revokeFacsAccessMappingById: sinon.stub().resolves(makeRow()),
      });
      const ctx = makeContext({ pathParams: { id: VALID_UUID_MAPPING } });
      const res = await Controller(ctx).revokeMapping(ctx);
      expect(res.status).to.equal(204);
    });

    it('returns 404 when nothing was revoked', async () => {
      const { Controller } = await loadController({
        revokeFacsAccessMappingById: sinon.stub().resolves(null),
      });
      const ctx = makeContext({ pathParams: { id: VALID_UUID_MAPPING } });
      const res = await Controller(ctx).revokeMapping(ctx);
      expect(res.status).to.equal(404);
    });

    it('returns 500 when the helper throws', async () => {
      const { Controller } = await loadController({
        revokeFacsAccessMappingById: sinon.stub().rejects(new Error('boom')),
      });
      const ctx = makeContext({ pathParams: { id: VALID_UUID_MAPPING } });
      const res = await Controller(ctx).revokeMapping(ctx);
      expect(res.status).to.equal(500);
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
      const ctx = makeContext({ callerSub: null, pathParams: { resourceId: VALID_UUID_RES } });
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
});
