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
  NON_EXISTENT_SITE_ID,
  TRIAL_USER_1_ID,
  ENTITLEMENT_1_ID,
} from '../seed-ids.js';

/**
 * Asserts that an object has the UserActivityDto shape.
 */
function expectActivityDto(activity) {
  expect(activity).to.be.an('object');
  expect(activity.id).to.be.a('string');
  expect(activity.siteId).to.be.a('string');
  expect(activity.trialUserId).to.be.a('string');
  expect(activity.entitlementId).to.be.a('string');
  expect(activity.type).to.be.a('string');
  expect(activity.productCode).to.be.a('string');
  expectISOTimestamp(activity.createdAt, 'createdAt');
  expectISOTimestamp(activity.updatedAt, 'updatedAt');
}

/**
 * Shared TrialUserActivity endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function userActivityTests(getHttpClient, resetData) {
  describe('Trial User Activities', () => {
    // ── List activities ──

    describe('GET /sites/:siteId/user-activities', () => {
      before(() => resetData());

      it('user: returns activities for accessible site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/user-activities`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);
        expectActivityDto(res.body[0]);
        expect(res.body[0].siteId).to.equal(SITE_1_ID);
        expect(res.body[0].trialUserId).to.equal(TRIAL_USER_1_ID);
        expect(res.body[0].entitlementId).to.equal(ENTITLEMENT_1_ID);
        expect(res.body[0].type).to.equal('SIGN_IN');
        expect(res.body[0].productCode).to.equal('LLMO');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/user-activities`);
        expect(res.status).to.equal(403);
      });

      it('user: returns empty for site with no activities', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_2_ID}/user-activities`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${NON_EXISTENT_SITE_ID}/user-activities`);
        expect(res.status).to.equal(404);
      });
    });

    // ── Create activity ──

    describe('POST /sites/:siteId/user-activities', () => {
      // POST mutates the seeded TrialUser (INVITED → REGISTERED), so reset before each group
      beforeEach(() => resetData());

      it('trialUser: creates activity', async () => {
        const http = getHttpClient();
        const res = await http.trialUser.post(`/sites/${SITE_1_ID}/user-activities`, {
          type: 'RUN_AUDIT',
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(201);
        expectActivityDto(res.body);
        expect(res.body.siteId).to.equal(SITE_1_ID);
        expect(res.body.trialUserId).to.equal(TRIAL_USER_1_ID);
        expect(res.body.entitlementId).to.equal(ENTITLEMENT_1_ID);
        expect(res.body.type).to.equal('RUN_AUDIT');
        expect(res.body.productCode).to.equal('LLMO');
      });

      it('trialUser: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.trialUser.post(`/sites/${SITE_3_ID}/user-activities`, {
          type: 'SIGN_IN',
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(403);
      });

      it('trialUser: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.trialUser.post(`/sites/${NON_EXISTENT_SITE_ID}/user-activities`, {
          type: 'SIGN_IN',
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(404);
      });

      it('trialUser: returns 400 for empty body', async () => {
        const http = getHttpClient();
        const res = await http.trialUser.post(`/sites/${SITE_1_ID}/user-activities`, {});
        expect(res.status).to.equal(400);
      });

      it('trialUser: returns 400 for invalid type', async () => {
        const http = getHttpClient();
        const res = await http.trialUser.post(`/sites/${SITE_1_ID}/user-activities`, {
          type: 'INVALID_TYPE',
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(400);
      });

      it('trialUser: returns 400 for invalid productCode', async () => {
        const http = getHttpClient();
        const res = await http.trialUser.post(`/sites/${SITE_1_ID}/user-activities`, {
          type: 'SIGN_IN',
          productCode: 'INVALID_CODE',
        });
        expect(res.status).to.equal(400);
      });

      it('user: returns 400 when no trial_email claim', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/user-activities`, {
          type: 'SIGN_IN',
          productCode: 'LLMO',
        });
        expect(res.status).to.equal(400);
      });

      it('trialUser: returns 404 for missing entitlement', async () => {
        const http = getHttpClient();
        // ACO entitlement is not seeded for ORG_1
        const res = await http.trialUser.post(`/sites/${SITE_1_ID}/user-activities`, {
          type: 'SIGN_IN',
          productCode: 'ACO',
        });
        expect(res.status).to.equal(404);
      });
    });
  });
}
