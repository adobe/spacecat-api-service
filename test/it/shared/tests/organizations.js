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
import { expectISOTimestamp, sortById } from '../helpers/assertions.js';
import {
  ORG_1_ID,
  ORG_1_NAME,
  ORG_1_IMS_ORG_ID,
  ORG_2_ID,
  ORG_2_IMS_ORG_ID,
  ORG_3_ID,
  SITE_1_ID,
  SITE_4_ID,
  NON_EXISTENT_ORG_ID,
  NON_EXISTENT_IMS_ORG_ID,
} from '../seed-ids.js';

/**
 * Asserts that an object has the OrganizationDto shape.
 */
function expectOrgDto(org) {
  expect(org).to.be.an('object');
  expect(org.id).to.be.a('string');
  expect(org.name).to.be.a('string');
  expect(org.imsOrgId).to.be.a('string');
  expectISOTimestamp(org.createdAt, 'createdAt');
  expectISOTimestamp(org.updatedAt, 'updatedAt');
  expect(org).to.have.property('config');
}

/**
 * Shared Organization endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function organizationTests(getHttpClient, resetData) {
  describe('Organizations', () => {
    before(() => resetData());

    // ── Read-only assertions on baseline seed ──

    describe('GET /organizations', () => {
      it('admin: returns all organizations', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/organizations');
        expect(res.status).to.equal(200);
        // ORG_1 + ORG_2 + ORG_3 (delegate agency org) +
        // ORG_LEGACY_LLMO + ORG_NEW_LLMO (LLMO-4176 mode-resolution test fixtures)
        expect(res.body).to.be.an('array').with.lengthOf(5);
        const sorted = sortById(res.body);
        sorted.forEach((org) => expectOrgDto(org));
        const ids = sorted.map((org) => org.id);
        expect(ids).to.include(ORG_1_ID);
        expect(ids).to.include(ORG_2_ID);
        expect(ids).to.include(ORG_3_ID);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/organizations');
        expect(res.status).to.equal(403);
      });

      it('trialUser: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.trialUser.get('/organizations');
        expect(res.status).to.equal(403);
      });
    });

    describe('GET /organizations/:organizationId', () => {
      it('admin: returns accessible org by ID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}`);
        expect(res.status).to.equal(200);
        expectOrgDto(res.body);
        expect(res.body.id).to.equal(ORG_1_ID);
        expect(res.body.name).to.equal(ORG_1_NAME);
        expect(res.body.imsOrgId).to.equal(ORG_1_IMS_ORG_ID);

        // Enriched fields — config is exposed in OrganizationDto
        expect(res.body.config).to.be.an('object');
        expect(res.body.config.slack).to.deep.include({ channel: 'C0FAKE0ORG1' });
      });

      it('user: returns accessible org by ID', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${ORG_1_ID}`);
        expect(res.status).to.equal(200);
        expectOrgDto(res.body);
        expect(res.body.id).to.equal(ORG_1_ID);
      });

      it('user: returns 403 for denied org', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${ORG_2_ID}`);
        expect(res.status).to.equal(403);
      });

      it('admin: returns 404 for non-existent org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${NON_EXISTENT_ORG_ID}`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/organizations/not-a-uuid');
        expect(res.status).to.equal(400);
      });
    });

    describe('GET /organizations/by-ims-org-id/:imsOrgId', () => {
      it('admin: finds org by IMS org ID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/by-ims-org-id/${ORG_1_IMS_ORG_ID}`);
        expect(res.status).to.equal(200);
        expectOrgDto(res.body);
        expect(res.body.id).to.equal(ORG_1_ID);
        expect(res.body.imsOrgId).to.equal(ORG_1_IMS_ORG_ID);
      });

      it('user: finds accessible org by IMS org ID', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/by-ims-org-id/${ORG_1_IMS_ORG_ID}`);
        expect(res.status).to.equal(200);
        expect(res.body.id).to.equal(ORG_1_ID);
      });

      it('user: returns 403 for denied IMS org ID', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/by-ims-org-id/${ORG_2_IMS_ORG_ID}`);
        expect(res.status).to.equal(403);
      });

      it('admin: returns 404 for non-existent IMS org ID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/by-ims-org-id/${NON_EXISTENT_IMS_ORG_ID}`);
        expect(res.status).to.equal(404);
      });
    });

    describe('GET /organizations/:organizationId/sites', () => {
      it('user: returns sites for accessible org (empty — no site enrollments)', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${ORG_1_ID}/sites`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 403 for denied org', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${ORG_2_ID}/sites`);
        expect(res.status).to.equal(403);
      });

      it('admin: returns 404 for non-existent org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${NON_EXISTENT_ORG_ID}/sites`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/organizations/not-a-uuid/sites');
        expect(res.status).to.equal(400);
      });

      it('returns 400 without x-product header', async () => {
        const http = getHttpClient();
        const res = await http.user.get(
          `/organizations/${ORG_1_ID}/sites`,
          { 'x-product': undefined },
        );
        expect(res.status).to.equal(400);
      });

      // ── Delegation: getSitesForOrganization merges delegated sites ──

      it('delegatedUser: x-product=LLMO, ORG_3 → returns own site (SITE_4) + delegated site (SITE_1)', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.get(
          `/organizations/${ORG_3_ID}/sites`,
          { 'x-product': 'LLMO' },
        );
        expect(res.status).to.equal(200);
        // SITE_4 (ORG_3 own) + SITE_1 (delegated via active LLMO grant ACCESS_1)
        expect(res.body).to.be.an('array').with.lengthOf(2);
        const ids = res.body.map((s) => s.id);
        expect(ids).to.include(SITE_1_ID);
        expect(ids).to.include(SITE_4_ID);
      });

      it('delegatedUser: x-product=LLMO, ORG_1 → 403 (ORG_1 is not delegatedUser primary org)', async () => {
        // hasAccess(organization) is called without productCode, so delegation does NOT fire.
        // delegatedUser primary tenant is ORG_3, not ORG_1 → forbidden.
        const http = getHttpClient();
        const res = await http.delegatedUser.get(
          `/organizations/${ORG_1_ID}/sites`,
          { 'x-product': 'LLMO' },
        );
        expect(res.status).to.equal(403);
      });

      it('delegatedUser: x-product=ASO, ORG_3 → 200 with 0 sites (SITE_1 not enrolled under ORG_1 ASO)', async () => {
        // ACCESS_3 (ASO) targets ORG_1 which has an ASO entitlement (ENT_2), but SITE_1
        // is not enrolled under ENT_2. The retrieval-time enrollment check excludes it.
        const http = getHttpClient();
        const res = await http.delegatedUser.get(
          `/organizations/${ORG_3_ID}/sites`,
          { 'x-product': 'ASO' },
        );
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('delegatedUserTruncated: x-product=LLMO, ORG_3 → returns same 2 sites as Path A', async () => {
        // Path B JWT persona: same underlying grants → same result set.
        const http = getHttpClient();
        const res = await http.delegatedUserTruncated.get(
          `/organizations/${ORG_3_ID}/sites`,
          { 'x-product': 'LLMO' },
        );
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        const ids = res.body.map((s) => s.id);
        expect(ids).to.include(SITE_1_ID);
        expect(ids).to.include(SITE_4_ID);
      });

      it('user (ORG_1): x-product=LLMO, ORG_1 → 200 with SITE_1 (enrolled in FREE_TRIAL entitlement)', async () => {
        // ORG_1 has ENTITLEMENT_1 (LLMO, FREE_TRIAL) and SITE_1 is enrolled via SITE_ENROLLMENT_1.
        const http = getHttpClient();
        const res = await http.user.get(
          `/organizations/${ORG_1_ID}/sites`,
          { 'x-product': 'LLMO' },
        );
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);
        expect(res.body[0].id).to.equal(SITE_1_ID);
      });
    });

    // ── Write operations ──

    describe('POST /organizations', () => {
      before(() => resetData());

      it('admin: creates a new organization', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/organizations', {
          name: 'New IT Org',
          imsOrgId: 'NEWORGID1234567890123456@AdobeOrg',
        });
        expect(res.status).to.equal(201);
        expectOrgDto(res.body);
        expect(res.body.name).to.equal('New IT Org');
        expect(res.body.imsOrgId).to.equal('NEWORGID1234567890123456@AdobeOrg');
      });

      it('admin: returns existing org for same imsOrgId (idempotent)', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/organizations', {
          name: 'Different Name',
          imsOrgId: ORG_1_IMS_ORG_ID,
        });
        expect(res.status).to.equal(200);
        expect(res.body.id).to.equal(ORG_1_ID);
        expect(res.body.name).to.equal(ORG_1_NAME);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.post('/organizations', {
          name: 'Forbidden Org',
          imsOrgId: 'USERATTEMPT123456789012@AdobeOrg',
        });
        expect(res.status).to.equal(403);
      });
    });

    describe('PATCH /organizations/:organizationId', () => {
      before(() => resetData());

      it('user: updates accessible org name', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/organizations/${ORG_1_ID}`, {
          name: 'Updated Org Name',
        });
        expect(res.status).to.equal(200);
        expectOrgDto(res.body);
        expect(res.body.id).to.equal(ORG_1_ID);
        expect(res.body.name).to.equal('Updated Org Name');

        // Restore baseline — user JWT can only access ORG_1, so we
        // cannot use a test-scoped org for this persona's write test.
        const restore = await http.user.patch(`/organizations/${ORG_1_ID}`, {
          name: ORG_1_NAME,
        });
        expect(restore.status).to.equal(200);
      });

      it('user: returns 403 for denied org', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/organizations/${ORG_2_ID}`, {
          name: 'Should Fail',
        });
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent org', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/organizations/${NON_EXISTENT_ORG_ID}`, {
          name: 'Ghost Org',
        });
        expect(res.status).to.equal(404);
      });

      it('user: returns 400 for empty body (no updates)', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/organizations/${ORG_1_ID}`, {});
        expect(res.status).to.equal(400);
      });
    });

    describe('DELETE /organizations/:organizationId', () => {
      it('admin: returns 403 (restricted)', async () => {
        const http = getHttpClient();
        const res = await http.admin.delete(`/organizations/${ORG_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 403 (restricted)', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`/organizations/${ORG_1_ID}`);
        expect(res.status).to.equal(403);
      });
    });
  });
}
