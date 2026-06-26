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
  ORG_1_ID,
  ORG_2_ID,
  SITE_1_ID,
  SITE_2_ID,
  SITE_3_ID,
  ENTITLEMENT_1_ID,
  ENTITLEMENT_2_ID,
  NON_EXISTENT_ORG_ID,
  NON_EXISTENT_SITE_ID,
} from '../seed-ids.js';

const BASE = `/organizations/${ORG_1_ID}/entitlements`;
const DENIED_BASE = `/organizations/${ORG_2_ID}/entitlements`;

/**
 * Asserts that an object has the EntitlementDto shape.
 */
function expectEntitlementDto(entitlement) {
  expect(entitlement).to.be.an('object');
  expect(entitlement.id).to.be.a('string');
  expect(entitlement.organizationId).to.be.a('string');
  expect(entitlement.productCode).to.be.a('string');
  expect(entitlement.tier).to.be.a('string');
  expectISOTimestamp(entitlement.createdAt, 'createdAt');
  expectISOTimestamp(entitlement.updatedAt, 'updatedAt');
}

/**
 * Asserts that an object has the SiteEnrollmentDto shape.
 */
function expectSiteEnrollmentDto(enrollment) {
  expect(enrollment).to.be.an('object');
  expect(enrollment.id).to.be.a('string');
  expect(enrollment.siteId).to.be.a('string');
  expect(enrollment.entitlementId).to.be.a('string');
  expectISOTimestamp(enrollment.createdAt, 'createdAt');
  expectISOTimestamp(enrollment.updatedAt, 'updatedAt');
}

/**
 * Shared Entitlement endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function entitlementTests(getHttpClient, resetData) {
  describe('Entitlements', () => {
    describe('GET /organizations/:organizationId/entitlements', () => {
      before(() => resetData());

      it('user: returns entitlements for org', async () => {
        const http = getHttpClient();
        const res = await http.user.get(BASE);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        res.body.forEach((e) => expectEntitlementDto(e));

        const ids = res.body.map((e) => e.id).sort();
        expect(ids).to.deep.equal([ENTITLEMENT_1_ID, ENTITLEMENT_2_ID].sort());

        // Enriched field — exercises quotas JSON field
        const ent1 = res.body.find((e) => e.id === ENTITLEMENT_1_ID);
        expect(ent1.quotas).to.deep.equal({
          llmo_trial_prompts: 200,
          llmo_trial_prompts_consumed: 0,
        });
      });

      it('user: returns 403 for denied org', async () => {
        const http = getHttpClient();
        const res = await http.user.get(DENIED_BASE);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent org', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${NON_EXISTENT_ORG_ID}/entitlements`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/organizations/not-a-uuid/entitlements');
        expect(res.status).to.equal(400);
      });
    });

    describe('POST /sites/:siteId/entitlements', () => {
      // ORG_1 (SITE_2's owning org) already has an ASO entitlement (ENT_2,
      // tier=PAID) and an LLMO entitlement (ENT_1, tier=FREE_TRIAL). SITE_2
      // starts with no enrollments, so it's the cleanest site to exercise
      // "reuse existing org entitlement, create new enrollment". SITE_1
      // already has an LLMO enrollment via ENT_1, so a repeat call on
      // (SITE_1, LLMO) exercises the full-idempotency path.
      const POST_BASE_FOR_SITE_2 = `/sites/${SITE_2_ID}/entitlements`;
      const POST_BASE_FOR_SITE_1 = `/sites/${SITE_1_ID}/entitlements`;
      const POST_BASE_FOR_SITE_3 = `/sites/${SITE_3_ID}/entitlements`;

      before(() => resetData());

      it('admin: ensures enrollment by reusing the org\'s existing ASO entitlement', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          POST_BASE_FOR_SITE_2,
          { productCode: 'ASO' },
        );
        expect(res.status).to.equal(201);
        expectEntitlementDto(res.body.entitlement);
        expectSiteEnrollmentDto(res.body.siteEnrollment);

        // The org's pre-seeded ASO entitlement (ENT_2, tier PAID) is reused —
        // not a freshly minted one — so the response keeps the seed id and tier.
        expect(res.body.entitlement.id).to.equal(ENTITLEMENT_2_ID);
        expect(res.body.entitlement.organizationId).to.equal(ORG_1_ID);
        expect(res.body.entitlement.productCode).to.equal('ASO');
        expect(res.body.entitlement.tier).to.equal('PAID');

        expect(res.body.siteEnrollment.siteId).to.equal(SITE_2_ID);
        expect(res.body.siteEnrollment.entitlementId).to.equal(ENTITLEMENT_2_ID);
      });

      it('admin: idempotent — second call on the same (site, product) returns the same enrollment', async () => {
        const http = getHttpClient();

        const first = await http.admin.post(
          POST_BASE_FOR_SITE_1,
          { productCode: 'LLMO' },
        );
        expect(first.status).to.equal(201);
        // SITE_1 already has ENT_1 enrollment in the seed data — the existing
        // row is returned, no duplicate created.
        expect(first.body.entitlement.id).to.equal(ENTITLEMENT_1_ID);

        const second = await http.admin.post(
          POST_BASE_FOR_SITE_1,
          { productCode: 'LLMO' },
        );
        expect(second.status).to.equal(201);
        expect(second.body.entitlement.id).to.equal(ENTITLEMENT_1_ID);
        expect(second.body.siteEnrollment.id).to.equal(first.body.siteEnrollment.id);
      });

      it('admin: creates a new entitlement for a previously-unentitled product', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          POST_BASE_FOR_SITE_2,
          { productCode: 'ACO' },
        );
        expect(res.status).to.equal(201);
        // ORG_1 has no ACO entitlement seeded, so a fresh one is minted with
        // the requested tier; then the site enrollment is linked to it.
        expect(res.body.entitlement.id).to.not.equal(ENTITLEMENT_1_ID);
        expect(res.body.entitlement.id).to.not.equal(ENTITLEMENT_2_ID);
        expect(res.body.entitlement.productCode).to.equal('ACO');
        expect(res.body.entitlement.tier).to.equal('FREE_TRIAL');
        expect(res.body.entitlement.organizationId).to.equal(ORG_1_ID);

        expect(res.body.siteEnrollment.siteId).to.equal(SITE_2_ID);
        expect(res.body.siteEnrollment.entitlementId).to.equal(res.body.entitlement.id);
      });

      it('admin: honors the tier from payload', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          POST_BASE_FOR_SITE_2,
          { productCode: 'LLMO', tier: 'FREE_TRIAL' },
        );
        expect(res.status).to.equal(201);
        // ORG_1's seeded LLMO entitlement (ENT_1) is already FREE_TRIAL, so
        // it's reused as-is.
        expect(res.body.entitlement.id).to.equal(ENTITLEMENT_1_ID);
        expect(res.body.entitlement.tier).to.equal('FREE_TRIAL');
      });

      it('user: returns 403 (admin-only)', async () => {
        const http = getHttpClient();
        const res = await http.user.post(
          POST_BASE_FOR_SITE_2,
          { productCode: 'ASO' },
        );
        expect(res.status).to.equal(403);
      });

      it('user: also returns 403 against a site they don\'t belong to (admin gate fires first)', async () => {
        const http = getHttpClient();
        const res = await http.user.post(
          POST_BASE_FOR_SITE_3,
          { productCode: 'ASO' },
        );
        expect(res.status).to.equal(403);
      });

      it('admin: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          `/sites/${NON_EXISTENT_SITE_ID}/entitlements`,
          { productCode: 'ASO' },
        );
        expect(res.status).to.equal(404);
      });

      it('admin: returns 400 for invalid site UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          '/sites/not-a-uuid/entitlements',
          { productCode: 'ASO' },
        );
        expect(res.status).to.equal(400);
      });

      it('admin: returns 400 when productCode is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(POST_BASE_FOR_SITE_2, {});
        expect(res.status).to.equal(400);
      });

      it('admin: returns 400 for invalid productCode', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          POST_BASE_FOR_SITE_2,
          { productCode: 'BOGUS' },
        );
        expect(res.status).to.equal(400);
      });

      it('admin: returns 400 for invalid tier', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          POST_BASE_FOR_SITE_2,
          { productCode: 'ASO', tier: 'BOGUS_TIER' },
        );
        expect(res.status).to.equal(400);
      });
    });
  });
}
