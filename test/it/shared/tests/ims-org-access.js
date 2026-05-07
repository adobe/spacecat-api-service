/*
 * Copyright 2025 Adobe. All rights reserved.
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
import { expectISOTimestamp } from '../helpers/assertions.js';
import {
  SITE_1_ID,
  SITE_2_ID,
  SITE_3_ID,
  ORG_1_ID,
  ORG_2_ID,
  ORG_3_ID,
  IMS_ORG_ACCESS_1_ID,
  IMS_ORG_ACCESS_2_ID,
  IMS_ORG_ACCESS_3_ID,
  NON_EXISTENT_ACCESS_ID,
  NON_EXISTENT_SITE_ID,
} from '../seed-ids.js';

/**
 * Asserts that an object has the ImsOrgAccessDto shape.
 */
function expectImsOrgAccessDto(grant) {
  expect(grant).to.be.an('object');
  expect(grant.id).to.be.a('string');
  expect(grant.siteId).to.be.a('string');
  expect(grant.organizationId).to.be.a('string');
  expect(grant.targetOrganizationId).to.be.a('string');
  expect(grant.productCode).to.be.a('string');
  expect(grant.role).to.be.a('string');
  expectISOTimestamp(grant.createdAt, 'createdAt');
  expectISOTimestamp(grant.updatedAt, 'updatedAt');
}

/**
 * Shared ImsOrgAccess CRUD endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * Baseline seed (site-ims-org-accesses.js):
 *   ACCESS_1: active  — SITE_1, ORG_3→ORG_1, LLMO, no expiry
 *   ACCESS_2: expired — SITE_2, ORG_3→ORG_1, LLMO, expires_at in the past
 *   ACCESS_3: wrong product — SITE_1, ORG_3→ORG_1, ASO
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function imsOrgAccessTests(getHttpClient, resetData) {
  describe('ImsOrgAccess', () => {
    // ── List grants ──

    describe('GET /sites/:siteId/ims-org-access', () => {
      before(() => resetData());

      it('admin: returns all grants for SITE_1 (ACCESS_1 and ACCESS_3)', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_1_ID}/ims-org-access`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        res.body.forEach((g) => expectImsOrgAccessDto(g));
        const ids = res.body.map((g) => g.id).sort();
        expect(ids).to.deep.equal([IMS_ORG_ACCESS_1_ID, IMS_ORG_ACCESS_3_ID].sort());
      });

      it('admin: returns grant for SITE_2 (ACCESS_2 — expired)', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_2_ID}/ims-org-access`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);
        expectImsOrgAccessDto(res.body[0]);
        expect(res.body[0].id).to.equal(IMS_ORG_ACCESS_2_ID);
        expect(res.body[0].expiresAt).to.be.a('string');
      });

      it('admin: returns empty array for SITE_3 (no grants)', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_3_ID}/ims-org-access`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('admin: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${NON_EXISTENT_SITE_ID}/ims-org-access`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid siteId UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites/not-a-uuid/ims-org-access');
        expect(res.status).to.equal(400);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/ims-org-access`);
        expect(res.status).to.equal(403);
      });

      it('trialUser: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.trialUser.get(`/sites/${SITE_1_ID}/ims-org-access`);
        expect(res.status).to.equal(403);
      });

      it('delegatedUser: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.get(`/sites/${SITE_1_ID}/ims-org-access`);
        expect(res.status).to.equal(403);
      });
    });

    // ── Get single grant ──

    describe('GET /sites/:siteId/ims-org-access/:accessId', () => {
      before(() => resetData());

      it('admin: returns ACCESS_1 by ID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_1_ID}/ims-org-access/${IMS_ORG_ACCESS_1_ID}`);
        expect(res.status).to.equal(200);
        expectImsOrgAccessDto(res.body);
        expect(res.body.id).to.equal(IMS_ORG_ACCESS_1_ID);
        expect(res.body.siteId).to.equal(SITE_1_ID);
        expect(res.body.organizationId).to.equal(ORG_3_ID);
        expect(res.body.targetOrganizationId).to.equal(ORG_1_ID);
        expect(res.body.productCode).to.equal('LLMO');
        expect(res.body.role).to.equal('agency');
        // Seed data has granted_by='slack:U0TESTADMIN' (pre-seeded directly in DB)
        expect(res.body.grantedBy).to.equal('slack:U0TESTADMIN');
        // ACCESS_1 has no expiry — expiresAt is absent or null
        expect(res.body.expiresAt == null).to.equal(true);
      });

      it('admin: returns ACCESS_2 (expired grant) by ID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_2_ID}/ims-org-access/${IMS_ORG_ACCESS_2_ID}`);
        expect(res.status).to.equal(200);
        expectImsOrgAccessDto(res.body);
        expect(res.body.id).to.equal(IMS_ORG_ACCESS_2_ID);
        expect(res.body.expiresAt).to.be.a('string');
        expect(new Date(res.body.expiresAt).getTime()).to.be.lessThan(Date.now());
      });

      it('admin: returns 404 for non-existent accessId', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_1_ID}/ims-org-access/${NON_EXISTENT_ACCESS_ID}`);
        expect(res.status).to.equal(404);
      });

      it('admin: returns 404 when accessId belongs to a different site (siteId mismatch)', async () => {
        const http = getHttpClient();
        // ACCESS_2 belongs to SITE_2, not SITE_1
        const res = await http.admin.get(`/sites/${SITE_1_ID}/ims-org-access/${IMS_ORG_ACCESS_2_ID}`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid siteId', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/not-a-uuid/ims-org-access/${IMS_ORG_ACCESS_1_ID}`);
        expect(res.status).to.equal(400);
      });

      it('returns 400 for invalid accessId', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_1_ID}/ims-org-access/not-a-uuid`);
        expect(res.status).to.equal(400);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/ims-org-access/${IMS_ORG_ACCESS_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('delegatedUser: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.get(`/sites/${SITE_1_ID}/ims-org-access/${IMS_ORG_ACCESS_1_ID}`);
        expect(res.status).to.equal(403);
      });
    });

    // ── Create grant ──

    describe('POST /sites/:siteId/ims-org-access', () => {
      before(() => resetData());

      it('admin: creates a grant — grantedBy is derived from JWT sub (ims:<sub>)', async () => {
        // grantedBy is NOT accepted from the request body; the controller derives it
        // from the authenticated identity: ims:<profile.sub>.
        // Admin token sub = 'test-admin@adobe.com' → grantedBy = 'ims:test-admin@adobe.com'
        const http = getHttpClient();
        const futureDate = new Date(Date.now() + 86400000 * 30).toISOString();
        const res = await http.admin.post(`/sites/${SITE_3_ID}/ims-org-access`, {
          organizationId: ORG_3_ID,
          targetOrganizationId: ORG_2_ID,
          productCode: 'LLMO',
          role: 'agency',
          expiresAt: futureDate,
        });
        expect(res.status).to.equal(201);
        expectImsOrgAccessDto(res.body);
        expect(res.body.siteId).to.equal(SITE_3_ID);
        expect(res.body.organizationId).to.equal(ORG_3_ID);
        expect(res.body.targetOrganizationId).to.equal(ORG_2_ID);
        expect(res.body.productCode).to.equal('LLMO');
        expect(res.body.role).to.equal('agency');
        // Derived from JWT sub: ims:<sub>
        expect(res.body.grantedBy).to.equal('ims:test-admin@adobe.com');
        expect(res.body.expiresAt).to.be.a('string');
      });

      it('admin: creates a grant with only required fields (defaults role to agency)', async () => {
        const http = getHttpClient();
        // ORG_2_ID as organizationId + SITE_3 is a new combination not in seed
        const res = await http.admin.post(`/sites/${SITE_3_ID}/ims-org-access`, {
          organizationId: ORG_2_ID,
          targetOrganizationId: ORG_1_ID,
          productCode: 'ASO',
        });
        expect(res.status).to.equal(201);
        expectImsOrgAccessDto(res.body);
        expect(res.body.siteId).to.equal(SITE_3_ID);
        expect(res.body.organizationId).to.equal(ORG_2_ID);
        expect(res.body.targetOrganizationId).to.equal(ORG_1_ID);
        expect(res.body.productCode).to.equal('ASO');
        expect(res.body.role).to.equal('agency');
      });

      it('admin: returns 201 with existing grant on duplicate (idempotent — same site + org + productCode)', async () => {
        const http = getHttpClient();
        // ACCESS_1 already exists: SITE_1, ORG_3, ORG_1, LLMO
        // create() is idempotent: returns the existing grant rather than creating a duplicate
        const res = await http.admin.post(`/sites/${SITE_1_ID}/ims-org-access`, {
          organizationId: ORG_3_ID,
          targetOrganizationId: ORG_1_ID,
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(201);
        expect(res.body.id).to.equal(IMS_ORG_ACCESS_1_ID);
      });

      it('admin: returns 400 when organizationId is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/sites/${SITE_3_ID}/ims-org-access`, {
          targetOrganizationId: ORG_2_ID,
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(400);
      });

      it('admin: returns 400 when targetOrganizationId is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/sites/${SITE_3_ID}/ims-org-access`, {
          organizationId: ORG_3_ID,
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(400);
      });

      it('admin: returns 400 when productCode is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/sites/${SITE_3_ID}/ims-org-access`, {
          organizationId: ORG_3_ID,
          targetOrganizationId: ORG_2_ID,
        });
        expect(res.status).to.equal(400);
      });

      it('admin: returns 400 for invalid organizationId (not a UUID)', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/sites/${SITE_3_ID}/ims-org-access`, {
          organizationId: 'not-a-uuid',
          targetOrganizationId: ORG_2_ID,
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(400);
      });

      it('admin: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/sites/${NON_EXISTENT_SITE_ID}/ims-org-access`, {
          organizationId: ORG_3_ID,
          targetOrganizationId: ORG_1_ID,
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(404);
      });

      it('admin: returns 400 for invalid siteId UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/sites/not-a-uuid/ims-org-access', {
          organizationId: ORG_3_ID,
          targetOrganizationId: ORG_1_ID,
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(400);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/ims-org-access`, {
          organizationId: ORG_3_ID,
          targetOrganizationId: ORG_1_ID,
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(403);
      });

      it('delegatedUser: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.post(`/sites/${SITE_1_ID}/ims-org-access`, {
          organizationId: ORG_3_ID,
          targetOrganizationId: ORG_1_ID,
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(403);
      });
    });

    // ── Revoke grant ──

    describe('DELETE /sites/:siteId/ims-org-access/:accessId', () => {
      before(() => resetData());

      it('admin: revokes a grant (204)', async () => {
        const http = getHttpClient();
        // First confirm it exists
        const getRes = await http.admin.get(`/sites/${SITE_1_ID}/ims-org-access/${IMS_ORG_ACCESS_1_ID}`);
        expect(getRes.status).to.equal(200);

        // Revoke it
        const delRes = await http.admin.delete(`/sites/${SITE_1_ID}/ims-org-access/${IMS_ORG_ACCESS_1_ID}`);
        expect(delRes.status).to.equal(204);

        // Confirm it is gone
        const afterRes = await http.admin.get(`/sites/${SITE_1_ID}/ims-org-access/${IMS_ORG_ACCESS_1_ID}`);
        expect(afterRes.status).to.equal(404);
      });

      it('admin: revokes an expired grant (204)', async () => {
        const http = getHttpClient();
        const res = await http.admin.delete(`/sites/${SITE_2_ID}/ims-org-access/${IMS_ORG_ACCESS_2_ID}`);
        expect(res.status).to.equal(204);
      });

      it('admin: returns 404 for non-existent accessId', async () => {
        const http = getHttpClient();
        const res = await http.admin.delete(`/sites/${SITE_1_ID}/ims-org-access/${NON_EXISTENT_ACCESS_ID}`);
        expect(res.status).to.equal(404);
      });

      it('admin: returns 404 when accessId belongs to a different site', async () => {
        const http = getHttpClient();
        // ACCESS_3 belongs to SITE_1, not SITE_2
        const res = await http.admin.delete(`/sites/${SITE_2_ID}/ims-org-access/${IMS_ORG_ACCESS_3_ID}`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid siteId', async () => {
        const http = getHttpClient();
        const res = await http.admin.delete(`/sites/not-a-uuid/ims-org-access/${IMS_ORG_ACCESS_1_ID}`);
        expect(res.status).to.equal(400);
      });

      it('returns 400 for invalid accessId', async () => {
        const http = getHttpClient();
        const res = await http.admin.delete(`/sites/${SITE_1_ID}/ims-org-access/not-a-uuid`);
        expect(res.status).to.equal(400);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`/sites/${SITE_1_ID}/ims-org-access/${IMS_ORG_ACCESS_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('delegatedUser: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.delete(`/sites/${SITE_1_ID}/ims-org-access/${IMS_ORG_ACCESS_1_ID}`);
        expect(res.status).to.equal(403);
      });
    });
  });
}
