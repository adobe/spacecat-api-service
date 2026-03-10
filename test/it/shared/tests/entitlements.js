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
  ENTITLEMENT_1_ID,
  ENTITLEMENT_2_ID,
  NON_EXISTENT_ORG_ID,
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
  });
}
