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

const CALLER_ORG = 'CUST-ORG-001';
const CALLER_ORG_CANONICAL = 'CUST-ORG-001@AdobeOrg';
const OTHER_ORG = 'OTHER-ORG-XYZ';
const VALID_UUID_BRAND = '11111111-2222-4333-9444-555555555555';
const VALID_UUID_MAPPING = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';

function makeContext({
  imsOrgId = CALLER_ORG,
  callerSub = 'ADMIN@AdobeID',
  body,
  pathParams,
  queryParams,
  postgrestClient = { from: () => {} },
  ImsAdminOrgsResolver = async () => [],
  organizationFound = { getId: () => 'SC-ORG-001' },
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
      },
    },
    data: body,
    pathInfo: {
      params: pathParams || {},
      queryParams: queryParams || {},
    },
    dataAccess: {
      Organization: {
        findByImsOrgId: sinon.stub().resolves(organizationFound),
      },
      services: { postgrestClient },
    },
    imsClient: {
      getImsAdminOrganizations: sinon.stub().callsFake(ImsAdminOrgsResolver),
    },
  };
}

async function loadController(supportStubs = {}, brandsStorageStubs = {}) {
  return esmock('../../src/controllers/facs-access-mappings.js', {
    '../../src/support/facs-access-mappings.js': {
      listFacsAccessMappings: sinon.stub().resolves([]),
      listFacsAccessMappingHistory: sinon.stub().resolves([]),
      createFacsAccessMappings: sinon.stub().resolves({ created: [], skipped: [] }),
      revokeFacsAccessMappingById: sinon.stub().resolves(null),
      requirePostgrestForFacsMappings: () => null,
      ...supportStubs,
    },
    '../../src/support/brands-storage.js': {
      getBrandById: sinon.stub().resolves(null),
      ...brandsStorageStubs,
    },
  });
}

describe('FacsAccessMappingsController', () => {
  describe('listMappings', () => {
    it('returns 403 when caller has no IMS org', async () => {
      const Controller = (await loadController()).default;
      const ctx = makeContext({ imsOrgId: null });
      const ctrl = Controller(ctx);
      const res = await ctrl.listMappings(ctx);
      expect(res.status).to.equal(403);
    });

    it('returns 400 when subjectType filter is invalid', async () => {
      const Controller = (await loadController()).default;
      const ctx = makeContext({ queryParams: { subjectType: 'group' } });
      const ctrl = Controller(ctx);
      const res = await ctrl.listMappings(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns active mappings on success', async () => {
      const list = sinon.stub().resolves([{ id: 'r1' }, { id: 'r2' }]);
      const Controller = (await loadController({ listFacsAccessMappings: list })).default;
      const ctx = makeContext({ queryParams: { resourceType: 'brand', resourceId: 'brand-x' } });
      const ctrl = Controller(ctx);
      const res = await ctrl.listMappings(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal({ mappings: [{ id: 'r1' }, { id: 'r2' }] });
      const filters = list.firstCall.args[1];
      expect(filters.imsOrgId).to.equal(CALLER_ORG_CANONICAL);
      expect(filters.resourceType).to.equal('brand');
      expect(filters.resourceId).to.equal('brand-x');
    });

    it('returns 500 when the helper throws', async () => {
      const list = sinon.stub().rejects(new Error('postgrest down'));
      const Controller = (await loadController({ listFacsAccessMappings: list })).default;
      const ctx = makeContext();
      const ctrl = Controller(ctx);
      const res = await ctrl.listMappings(ctx);
      expect(res.status).to.equal(500);
    });
  });

  describe('listHistory', () => {
    it('returns 400 when subjectType filter is invalid', async () => {
      const Controller = (await loadController()).default;
      const ctx = makeContext({ queryParams: { subjectType: 'group' } });
      const ctrl = Controller(ctx);
      const res = await ctrl.listHistory(ctx);
      expect(res.status).to.equal(400);
    });

    it('passes the optional `since` filter through to the helper', async () => {
      const list = sinon.stub().resolves([]);
      const Controller = (await loadController({ listFacsAccessMappingHistory: list })).default;
      const ctx = makeContext({ queryParams: { since: '2026-05-01T00:00:00Z' } });
      const ctrl = Controller(ctx);
      await ctrl.listHistory(ctx);
      const filters = list.firstCall.args[1];
      expect(filters.since).to.equal('2026-05-01T00:00:00Z');
    });

    it('returns active + tombstoned rows wrapped under `mappings`', async () => {
      const list = sinon.stub().resolves([
        { id: 'r1' },
        { id: 'r2', revoked_at: '2026-05-10' },
      ]);
      const Controller = (await loadController({ listFacsAccessMappingHistory: list })).default;
      const ctx = makeContext();
      const ctrl = Controller(ctx);
      const res = await ctrl.listHistory(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.mappings).to.have.length(2);
    });

    it('returns 500 when the helper throws', async () => {
      const list = sinon.stub().rejects(new Error('boom'));
      const Controller = (await loadController({ listFacsAccessMappingHistory: list })).default;
      const ctx = makeContext();
      const ctrl = Controller(ctx);
      const res = await ctrl.listHistory(ctx);
      expect(res.status).to.equal(500);
    });
  });

  describe('createMappings — validation', () => {
    async function postWithBody(body) {
      const Controller = (await loadController()).default;
      const ctx = makeContext({ body });
      const ctrl = Controller(ctx);
      return ctrl.createMappings(ctx);
    }

    it('rejects missing body', async () => {
      const res = await postWithBody(undefined);
      expect(res.status).to.equal(400);
    });

    it('rejects missing resourceType', async () => {
      const res = await postWithBody({
        resourceId: VALID_UUID_BRAND, subjects: [{ type: 'user', id: 'A@AdobeID' }],
      });
      expect(res.status).to.equal(400);
    });

    it('rejects unsupported resourceType (only brand for v1)', async () => {
      const res = await postWithBody({
        resourceType: 'site',
        resourceId: VALID_UUID_BRAND,
        subjects: [{ type: 'user', id: 'A@AdobeID' }],
      });
      expect(res.status).to.equal(400);
    });

    it('rejects non-UUID resourceId', async () => {
      const res = await postWithBody({
        resourceType: 'brand',
        resourceId: 'not-a-uuid',
        subjects: [{ type: 'user', id: 'A@AdobeID' }],
      });
      expect(res.status).to.equal(400);
    });

    it('rejects empty subjects array', async () => {
      const res = await postWithBody({
        resourceType: 'brand', resourceId: VALID_UUID_BRAND, subjects: [],
      });
      expect(res.status).to.equal(400);
    });

    it('rejects subjects with bad shape', async () => {
      const res = await postWithBody({
        resourceType: 'brand',
        resourceId: VALID_UUID_BRAND,
        subjects: [{ type: 'group', id: 'A' }],
      });
      expect(res.status).to.equal(400);
    });

    it('rejects oversized subjects list (>100)', async () => {
      const subjects = Array.from({ length: 101 }, (_, i) => ({ type: 'user', id: `U${i}@AdobeID` }));
      const res = await postWithBody({
        resourceType: 'brand', resourceId: VALID_UUID_BRAND, subjects,
      });
      expect(res.status).to.equal(400);
    });
  });

  describe('createMappings — resource ownership', () => {
    it('returns 403 when the brand is not owned by the caller org', async () => {
      const getBrandById = sinon.stub().resolves(null);
      const Controller = (await loadController({}, { getBrandById })).default;
      const ctx = makeContext({
        body: {
          resourceType: 'brand',
          resourceId: VALID_UUID_BRAND,
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        },
      });
      const ctrl = Controller(ctx);
      const res = await ctrl.createMappings(ctx);
      expect(res.status).to.equal(403);
    });

    it('returns 403 when the caller IMS org is not provisioned (Organization.findByImsOrgId null)', async () => {
      const Controller = (await loadController()).default;
      const ctx = makeContext({
        organizationFound: null,
        body: {
          resourceType: 'brand',
          resourceId: VALID_UUID_BRAND,
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        },
      });
      const ctrl = Controller(ctx);
      const res = await ctrl.createMappings(ctx);
      expect(res.status).to.equal(403);
    });

    it('returns 500 when the ownership lookup throws', async () => {
      const Controller = (await loadController()).default;
      const ctx = makeContext({
        body: {
          resourceType: 'brand',
          resourceId: VALID_UUID_BRAND,
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        },
      });
      ctx.dataAccess.Organization.findByImsOrgId = sinon.stub().rejects(new Error('db down'));
      const ctrl = Controller(ctx);
      const res = await ctrl.createMappings(ctx);
      expect(res.status).to.equal(500);
    });
  });

  describe('createMappings — subject membership + dispatch', () => {
    function ownedBrandStubs() {
      return {
        brandsStorageStubs: {
          getBrandById: sinon.stub().resolves({ id: VALID_UUID_BRAND }),
        },
      };
    }

    it('places subjects whose IMS org does not match the caller org in `rejected: not-in-org`', async () => {
      const { brandsStorageStubs } = ownedBrandStubs();
      const create = sinon.stub().resolves({
        created: [{ subject_type: 'user', subject_id: 'A@AdobeID' }],
        skipped: [],
      });
      const Controller = (await loadController(
        { createFacsAccessMappings: create },
        brandsStorageStubs,
      )).default;
      const ctx = makeContext({
        ImsAdminOrgsResolver: async (subjectId) => {
          if (subjectId === 'A@AdobeID') {
            return [{ orgRef: { ident: CALLER_ORG } }];
          }
          // B belongs to a different org
          return [{ orgRef: { ident: OTHER_ORG } }];
        },
        body: {
          resourceType: 'brand',
          resourceId: VALID_UUID_BRAND,
          subjects: [
            { type: 'user', id: 'A@AdobeID' },
            { type: 'user', id: 'B@AdobeID' },
          ],
        },
      });
      const ctrl = Controller(ctx);
      const res = await ctrl.createMappings(ctx);
      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body.created).to.have.length(1);
      expect(body.rejected).to.deep.equal([
        { subject: { type: 'user', id: 'B@AdobeID' }, reason: 'not-in-org' },
      ]);
      // Only the eligible subject reached the helper.
      const helperArgs = create.firstCall.args[1];
      expect(helperArgs.subjects).to.deep.equal([{ type: 'user', id: 'A@AdobeID' }]);
    });

    it('places ALL subjects in `rejected` and skips the insert when nobody is eligible', async () => {
      const { brandsStorageStubs } = ownedBrandStubs();
      const create = sinon.stub();
      const Controller = (await loadController(
        { createFacsAccessMappings: create },
        brandsStorageStubs,
      )).default;
      const ctx = makeContext({
        ImsAdminOrgsResolver: async () => [{ orgRef: { ident: OTHER_ORG } }],
        body: {
          resourceType: 'brand',
          resourceId: VALID_UUID_BRAND,
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        },
      });
      const ctrl = Controller(ctx);
      const res = await ctrl.createMappings(ctx);
      expect(res.status).to.equal(201);
      const body = await res.json();
      expect(body.created).to.deep.equal([]);
      expect(body.rejected).to.have.length(1);
      expect(create.called).to.be.false;
    });

    it('admits an org-typed subject only when it equals the caller IMS org', async () => {
      const { brandsStorageStubs } = ownedBrandStubs();
      const create = sinon.stub().resolves({
        created: [{ subject_type: 'org', subject_id: CALLER_ORG_CANONICAL }],
        skipped: [],
      });
      const Controller = (await loadController(
        { createFacsAccessMappings: create },
        brandsStorageStubs,
      )).default;
      const ctx = makeContext({
        body: {
          resourceType: 'brand',
          resourceId: VALID_UUID_BRAND,
          subjects: [
            // Org-type subject id is stored in canonical <ident>@<authSrc> form
            // (matches stored subject_id column); accepted when it equals the
            // caller's canonical org id.
            { type: 'org', id: CALLER_ORG_CANONICAL }, // accepted
            { type: 'org', id: OTHER_ORG }, // rejected
          ],
        },
      });
      const ctrl = Controller(ctx);
      const res = await ctrl.createMappings(ctx);
      const body = await res.json();
      expect(body.created).to.have.length(1);
      expect(body.rejected).to.deep.equal([
        { subject: { type: 'org', id: OTHER_ORG }, reason: 'not-in-org' },
      ]);
    });

    it('rejects a subject whose IMS membership lookup throws (fail-closed)', async () => {
      const { brandsStorageStubs } = ownedBrandStubs();
      const create = sinon.stub();
      const Controller = (await loadController(
        { createFacsAccessMappings: create },
        brandsStorageStubs,
      )).default;
      const ctx = makeContext({
        ImsAdminOrgsResolver: async () => {
          throw new Error('IMS down');
        },
        body: {
          resourceType: 'brand',
          resourceId: VALID_UUID_BRAND,
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        },
      });
      const ctrl = Controller(ctx);
      const res = await ctrl.createMappings(ctx);
      const body = await res.json();
      expect(body.rejected).to.have.length(1);
      expect(body.rejected[0].reason).to.equal('not-in-org');
      expect(create.called).to.be.false;
    });

    it('returns 500 when the create helper throws', async () => {
      const { brandsStorageStubs } = ownedBrandStubs();
      const create = sinon.stub().rejects(new Error('db down'));
      const Controller = (await loadController(
        { createFacsAccessMappings: create },
        brandsStorageStubs,
      )).default;
      // Subject must pass the IMS membership check so we actually reach the
      // create helper; otherwise the controller short-circuits with 201 and
      // an empty `created` bucket.
      const ctx = makeContext({
        ImsAdminOrgsResolver: async () => [{ orgRef: { ident: CALLER_ORG } }],
        body: {
          resourceType: 'brand',
          resourceId: VALID_UUID_BRAND,
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        },
      });
      const ctrl = Controller(ctx);
      const res = await ctrl.createMappings(ctx);
      expect(res.status).to.equal(500);
    });

    it('classifies a subject as rejected when no imsClient is on context', async () => {
      const { brandsStorageStubs } = ownedBrandStubs();
      const create = sinon.stub();
      const Controller = (await loadController(
        { createFacsAccessMappings: create },
        brandsStorageStubs,
      )).default;
      const ctx = makeContext({
        body: {
          resourceType: 'brand',
          resourceId: VALID_UUID_BRAND,
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        },
      });
      delete ctx.imsClient;
      const ctrl = Controller(ctx);
      const res = await ctrl.createMappings(ctx);
      const body = await res.json();
      expect(body.rejected[0].reason).to.equal('not-in-org');
    });
  });

  describe('revokeMappingById', () => {
    it('returns 400 when id is not a valid UUID', async () => {
      const Controller = (await loadController()).default;
      const ctx = makeContext({ pathParams: { id: 'not-a-uuid' } });
      const ctrl = Controller(ctx);
      const res = await ctrl.revokeMappingById(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns the tombstoned row when the RPC reports a revoke', async () => {
      const tombstone = { id: VALID_UUID_MAPPING, revoked_at: '2026-05-22T12:00:00Z' };
      const revoke = sinon.stub().resolves(tombstone);
      const Controller = (await loadController({
        revokeFacsAccessMappingById: revoke,
      })).default;
      const ctx = makeContext({ pathParams: { id: VALID_UUID_MAPPING } });
      const ctrl = Controller(ctx);
      const res = await ctrl.revokeMappingById(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal(tombstone);
      expect(revoke.firstCall.args[1]).to.include({
        id: VALID_UUID_MAPPING,
        imsOrgId: CALLER_ORG_CANONICAL,
        revokedBy: 'ADMIN@AdobeID',
      });
    });

    it('returns 404 when the RPC returns null (no active row matched)', async () => {
      const revoke = sinon.stub().resolves(null);
      const Controller = (await loadController({
        revokeFacsAccessMappingById: revoke,
      })).default;
      const ctx = makeContext({ pathParams: { id: VALID_UUID_MAPPING } });
      const ctrl = Controller(ctx);
      const res = await ctrl.revokeMappingById(ctx);
      expect(res.status).to.equal(404);
    });

    it('takes the reason from the request body when present', async () => {
      const revoke = sinon.stub().resolves({ id: VALID_UUID_MAPPING });
      const Controller = (await loadController({
        revokeFacsAccessMappingById: revoke,
      })).default;
      const ctx = makeContext({
        pathParams: { id: VALID_UUID_MAPPING },
        body: { reason: 'role change' },
      });
      const ctrl = Controller(ctx);
      await ctrl.revokeMappingById(ctx);
      expect(revoke.firstCall.args[1].revokeReason).to.equal('role change');
    });

    it('falls back to ?reason= query param when the body has no reason (CDN-strip-tolerant)', async () => {
      const revoke = sinon.stub().resolves({ id: VALID_UUID_MAPPING });
      const Controller = (await loadController({
        revokeFacsAccessMappingById: revoke,
      })).default;
      const ctx = makeContext({
        pathParams: { id: VALID_UUID_MAPPING },
        queryParams: { reason: 'role change (via query)' },
      });
      const ctrl = Controller(ctx);
      await ctrl.revokeMappingById(ctx);
      expect(revoke.firstCall.args[1].revokeReason).to.equal('role change (via query)');
    });

    it('passes revokeReason as null when neither body nor query supplied one', async () => {
      const revoke = sinon.stub().resolves({ id: VALID_UUID_MAPPING });
      const Controller = (await loadController({
        revokeFacsAccessMappingById: revoke,
      })).default;
      const ctx = makeContext({ pathParams: { id: VALID_UUID_MAPPING } });
      const ctrl = Controller(ctx);
      await ctrl.revokeMappingById(ctx);
      expect(revoke.firstCall.args[1].revokeReason).to.equal(null);
    });

    it('returns 500 when the RPC throws', async () => {
      const revoke = sinon.stub().rejects(new Error('boom'));
      const Controller = (await loadController({
        revokeFacsAccessMappingById: revoke,
      })).default;
      const ctx = makeContext({ pathParams: { id: VALID_UUID_MAPPING } });
      const ctrl = Controller(ctx);
      const res = await ctrl.revokeMappingById(ctx);
      expect(res.status).to.equal(500);
    });
  });

  describe('postgrest availability guard', () => {
    it('listMappings returns the guard response when postgrest is unavailable', async () => {
      const Controller = (await loadController({
        requirePostgrestForFacsMappings: () => ({ status: 503 }),
      })).default;
      const ctx = makeContext();
      const ctrl = Controller(ctx);
      const res = await ctrl.listMappings(ctx);
      expect(res.status).to.equal(503);
    });

    it('createMappings returns the guard response when postgrest is unavailable', async () => {
      const Controller = (await loadController({
        requirePostgrestForFacsMappings: () => ({ status: 503 }),
      })).default;
      const ctx = makeContext({
        body: {
          resourceType: 'brand',
          resourceId: VALID_UUID_BRAND,
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        },
      });
      const ctrl = Controller(ctx);
      const res = await ctrl.createMappings(ctx);
      expect(res.status).to.equal(503);
    });

    it('listHistory returns the guard response when postgrest is unavailable', async () => {
      const Controller = (await loadController({
        requirePostgrestForFacsMappings: () => ({ status: 503 }),
      })).default;
      const ctx = makeContext();
      const ctrl = Controller(ctx);
      const res = await ctrl.listHistory(ctx);
      expect(res.status).to.equal(503);
    });

    it('revokeMappingById returns the guard response when postgrest is unavailable', async () => {
      const Controller = (await loadController({
        requirePostgrestForFacsMappings: () => ({ status: 503 }),
      })).default;
      const ctx = makeContext({ pathParams: { id: VALID_UUID_MAPPING } });
      const ctrl = Controller(ctx);
      const res = await ctrl.revokeMappingById(ctx);
      expect(res.status).to.equal(503);
    });
  });

  describe('missing IMS org', () => {
    it('listHistory returns 403 when caller has no IMS org', async () => {
      const Controller = (await loadController()).default;
      const ctx = makeContext({ imsOrgId: null });
      const ctrl = Controller(ctx);
      const res = await ctrl.listHistory(ctx);
      expect(res.status).to.equal(403);
    });

    it('createMappings returns 403 when caller has no IMS org', async () => {
      const Controller = (await loadController()).default;
      const ctx = makeContext({
        imsOrgId: null,
        body: {
          resourceType: 'brand',
          resourceId: VALID_UUID_BRAND,
          subjects: [{ type: 'user', id: 'A@AdobeID' }],
        },
      });
      const ctrl = Controller(ctx);
      const res = await ctrl.createMappings(ctx);
      expect(res.status).to.equal(403);
    });

    it('revokeMappingById returns 403 when caller has no IMS org', async () => {
      const Controller = (await loadController()).default;
      const ctx = makeContext({ imsOrgId: null, pathParams: { id: VALID_UUID_MAPPING } });
      const ctrl = Controller(ctx);
      const res = await ctrl.revokeMappingById(ctx);
      expect(res.status).to.equal(403);
    });
  });
});
