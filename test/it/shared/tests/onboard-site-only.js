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

import {
  ORG_1_ID, // has a FREE_TRIAL LLMO entitlement
  ORG_2_ID, // has no entitlements
  ORG_3_ID, // has a PAID LLMO entitlement
  NON_EXISTENT_ORG_ID,
} from '../seed-ids.js';

/**
 * Shared integration tests for the paid-gated, site-only onboarding endpoint
 * (POST /v2/orgs/:spaceCatId/llmo/onboard-site — LLMO-5606).
 *
 * Scope is the auth gate (org lookup → membership → explicit PAID entitlement →
 * admin) and request validation — all of which resolve against the real
 * PostgREST DB *before* the endpoint touches external services (SharePoint,
 * GitHub, Ahrefs, SQS). The synchronous 201 happy path can't run here because it
 * depends on those services; the site/enrollment/no-side-effect guarantees are
 * covered by the unit suites (test/controllers/llmo).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function onboardSiteOnlyTests(getHttpClient, resetData) {
  describe('POST /v2/orgs/:spaceCatId/llmo/onboard-site (site-only onboarding)', () => {
    before(() => resetData());

    const onboardPath = (orgId) => `/v2/orgs/${orgId}/llmo/onboard-site`;
    const validBody = { domain: 'it-onboard-site.example.com', brandName: 'IT Brand' };

    it('returns 404 when the organization does not exist', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(onboardPath(NON_EXISTENT_ORG_ID), validBody);
      expect(res.status).to.equal(404);
    });

    it('returns 403 for a non-member (user persona on an org they do not belong to)', async () => {
      const http = getHttpClient();
      const res = await http.user.post(onboardPath(ORG_3_ID), validBody);
      expect(res.status).to.equal(403);
    });

    it('returns 403 when the organization has no LLMO entitlement', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(onboardPath(ORG_2_ID), validBody);
      expect(res.status).to.equal(403);
    });

    it("returns 403 when the organization's LLMO entitlement is FREE_TRIAL (not PAID)", async () => {
      // ORG_1 has a FREE_TRIAL LLMO entitlement. PAID is stricter than the
      // platform's any-tier "LLMO-enabled" bar, so this must be rejected.
      const http = getHttpClient();
      const res = await http.admin.post(onboardPath(ORG_1_ID), validBody);
      expect(res.status).to.equal(403);
    });

    it('passes the PAID + admin gate and reaches request validation (400 on bad body)', async () => {
      // ORG_3 has a PAID LLMO entitlement. With admin auth, membership + PAID +
      // admin all pass, so a missing brandName surfaces as a 400 from the body
      // validation that runs *before* any external provisioning. This proves a
      // PAID org is NOT 403'd — the gate opens for it.
      const http = getHttpClient();
      const res = await http.admin.post(onboardPath(ORG_3_ID), {
        domain: 'it-onboard-site.example.com',
      });
      expect(res.status).to.equal(400);
    });
  });
}
