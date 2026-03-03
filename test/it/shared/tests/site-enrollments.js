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
  SITE_ENROLLMENT_1_ID,
  ENTITLEMENT_1_ID,
  NON_EXISTENT_SITE_ID,
} from '../seed-ids.js';

const BASE = `/sites/${SITE_1_ID}/site-enrollments`;
const DENIED_BASE = `/sites/${SITE_3_ID}/site-enrollments`;

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
 * Shared SiteEnrollment endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function siteEnrollmentTests(getHttpClient, resetData) {
  describe('SiteEnrollments', () => {
    describe('GET /sites/:siteId/site-enrollments', () => {
      before(() => resetData());

      it('user: returns enrollments for site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(BASE);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);
        expectSiteEnrollmentDto(res.body[0]);
        expect(res.body[0].id).to.equal(SITE_ENROLLMENT_1_ID);
        expect(res.body[0].siteId).to.equal(SITE_1_ID);
        expect(res.body[0].entitlementId).to.equal(ENTITLEMENT_1_ID);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(DENIED_BASE);
        expect(res.status).to.equal(403);
      });

      it('user: returns empty for site with no enrollments', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_2_ID}/site-enrollments`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${NON_EXISTENT_SITE_ID}/site-enrollments`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/sites/not-a-uuid/site-enrollments');
        expect(res.status).to.equal(400);
      });
    });
  });
}
