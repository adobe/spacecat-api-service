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
import {
  SITE_1_ID,
  SITE_2_ID,
  SITE_3_ID,
  SITE_4_ID,
  NON_EXISTENT_SITE_ID,
} from '../seed-ids.js';

/**
 * Header sets for LLMO delegation tests.
 * The http client defaults to x-product: ASO; we must override for LLMO endpoints.
 */
const LLMO_HEADER = { 'x-product': 'LLMO' };

/**
 * Delegation auth IT tests — exercises the cross-org grant flow end-to-end via
 * GET /sites/:siteId/llmo/config, the only HTTP path that calls
 * hasAccess(site, '', 'LLMO') and therefore triggers the delegation fallthrough.
 *
 * S3 is backed by a local MinIO container (spacecat-it-test bucket).
 * A successful auth produces: 200 with a config object (NoSuchKey → default config)
 * An auth denial produces: 403 "Only users belonging to the organization can view its sites"
 * A product-code mismatch produces: 403 "[Error] Unauthorized request"
 * A missing llmo.dataFolder produces: 400 "LLM Optimizer is not enabled for this site..."
 *
 * Seed state (site-ims-org-accesses.js):
 *   ACCESS_1: active   — SITE_1, org=ORG_3→targetOrg=ORG_1, LLMO, no expiry
 *   ACCESS_2: expired  — SITE_2, org=ORG_3→targetOrg=ORG_1, LLMO, expires 2020-01-01
 *   ACCESS_3: wrong product — SITE_1, org=ORG_3→targetOrg=ORG_1, ASO
 *
 * JWT personas:
 *   delegatedUser          — primary=ORG_3, delegated=[{id:ORG_1, productCode:LLMO, complete:true}]
 *   delegatedUserTruncated — primary=ORG_3, delegated=[{id:ORG_1, productCode:LLMO,
 *                            complete:false}]
 *   delegatedUserNoSource  — primary=ORG_3, delegated=[{id:ORG_1, productCode:LLMO,
 *                            no sourceOrganizationId, complete:false}]
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function delegationTests(getHttpClient, resetData) {
  describe('Delegation auth (cross-org LLMO access)', () => {
    before(() => resetData());

    // ──────────────────────────────────────────────────────────────────
    // Baseline: direct-org users pass / are denied as expected
    // ──────────────────────────────────────────────────────────────────

    describe('Baseline: direct-org users via LLMO endpoint', () => {
      it('admin: SITE_1 x-product=LLMO → 200 config (auth passes)', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_1_ID}/llmo/config`, LLMO_HEADER);
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('config');
      });

      it('user (ORG_1): SITE_1 x-product=LLMO → 400 emailId required (auth passes, FREE_TRIAL entitlement requires trial_email in JWT)', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/llmo/config`, LLMO_HEADER);
        expect(res.status).to.equal(400);
        // Auth passes (ORG_1 owns SITE_1). The FREE_TRIAL entitlement validator runs next
        // and requires a trial_email JWT claim, which the plain user token doesn't carry.
        expect(res.body.message).to.equal('emailId is required');
      });

      it('user (ORG_1): SITE_3 x-product=LLMO → 403 users belonging (auth denied, wrong org)', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/llmo/config`, LLMO_HEADER);
        expect(res.status).to.equal(403);
        expect(res.body.message).to.include('Only users belonging to the organization');
      });

      it('user (ORG_1): SITE_1 default x-product (ASO) → 403 unauthorized request (product mismatch)', async () => {
        const http = getHttpClient();
        // Default header is x-product: ASO; hasAccess called with productCode='LLMO'
        const res = await http.user.get(`/sites/${SITE_1_ID}/llmo/config`);
        expect(res.status).to.equal(403);
        expect(res.body.message).to.include('[Error] Unauthorized request');
      });
    });

    // ──────────────────────────────────────────────────────────────────
    // Path A: delegated_tenants_complete=true (delegatedUser)
    // ──────────────────────────────────────────────────────────────────

    describe('Path A (delegated_tenants_complete=true)', () => {
      it('delegatedUser: SITE_1 active grant → 200 config (delegation grants access)', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.get(`/sites/${SITE_1_ID}/llmo/config`, LLMO_HEADER);
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('config');
      });

      it('delegatedUser: SITE_2 expired grant → 403 users belonging (expired grant denied)', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.get(`/sites/${SITE_2_ID}/llmo/config`, LLMO_HEADER);
        expect(res.status).to.equal(403);
        expect(res.body.message).to.include('Only users belonging to the organization');
      });

      it('delegatedUser: SITE_3 (ORG_2, no delegation) → 403 users belonging (fast deny — ORG_2 not in JWT delegated_tenants)', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.get(`/sites/${SITE_3_ID}/llmo/config`, LLMO_HEADER);
        expect(res.status).to.equal(403);
        expect(res.body.message).to.include('Only users belonging to the organization');
      });

      it('delegatedUser: SITE_1 with wrong x-product (ASO) → 403 unauthorized request (product mismatch)', async () => {
        const http = getHttpClient();
        // Default header x-product: ASO → hasAccess receives productCode='LLMO',
        // xProductHeader='ASO' → mismatch
        const res = await http.delegatedUser.get(`/sites/${SITE_1_ID}/llmo/config`);
        expect(res.status).to.equal(403);
        expect(res.body.message).to.include('[Error] Unauthorized request');
      });

      it('delegatedUser: non-existent site → 404', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.get(
          `/sites/${NON_EXISTENT_SITE_ID}/llmo/config`,
          LLMO_HEADER,
        );
        expect(res.status).to.equal(404);
      });

      it('delegatedUser: SITE_4 (own org ORG_3, no llmo config) → 400 LLM Optimizer not enabled', async () => {
        const http = getHttpClient();
        // delegatedUser has ORG_3 as primary tenant, SITE_4 belongs to ORG_3.
        // But SITE_4 has no llmo.dataFolder — thrown before hasAccess is even called.
        const res = await http.delegatedUser.get(`/sites/${SITE_4_ID}/llmo/config`, LLMO_HEADER);
        expect(res.status).to.equal(400);
        expect(res.body.message).to.include('LLM Optimizer is not enabled for this site');
      });
    });

    // ──────────────────────────────────────────────────────────────────
    // Path B: delegated_tenants_complete=false (delegatedUserTruncated)
    // Skips JWT gate; goes DB-direct using getDelegatedTenants()[0].sourceOrganizationId
    // ──────────────────────────────────────────────────────────────────

    describe('Path B (delegated_tenants_complete=false)', () => {
      it('delegatedUserTruncated: SITE_1 active grant → 200 config (Path B grants access)', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUserTruncated.get(
          `/sites/${SITE_1_ID}/llmo/config`,
          LLMO_HEADER,
        );
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('config');
      });

      it('delegatedUserTruncated: SITE_2 expired grant → 403 users belonging (expired grant denied via DB)', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUserTruncated.get(
          `/sites/${SITE_2_ID}/llmo/config`,
          LLMO_HEADER,
        );
        expect(res.status).to.equal(403);
        expect(res.body.message).to.include('Only users belonging to the organization');
      });

      it('delegatedUserTruncated: SITE_3 (no DB grant for ORG_3+LLMO) → 403 users belonging (DB lookup returns null)', async () => {
        // Path B: skips JWT gate. DB lookup for SITE_3+ORG_3+LLMO returns null → access denied.
        const http = getHttpClient();
        const res = await http.delegatedUserTruncated.get(
          `/sites/${SITE_3_ID}/llmo/config`,
          LLMO_HEADER,
        );
        expect(res.status).to.equal(403);
        expect(res.body.message).to.include('Only users belonging to the organization');
      });

      it('delegatedUserTruncated: wrong x-product (ASO) → 403 unauthorized request', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUserTruncated.get(`/sites/${SITE_1_ID}/llmo/config`);
        expect(res.status).to.equal(403);
        expect(res.body.message).to.include('[Error] Unauthorized request');
      });

      it('delegatedUserTruncated: non-existent site → 404', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUserTruncated.get(
          `/sites/${NON_EXISTENT_SITE_ID}/llmo/config`,
          LLMO_HEADER,
        );
        expect(res.status).to.equal(404);
      });

      it('delegatedUserTruncated: SITE_4 (own org, no llmo config) → 400 LLM Optimizer not enabled', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUserTruncated.get(
          `/sites/${SITE_4_ID}/llmo/config`,
          LLMO_HEADER,
        );
        expect(res.status).to.equal(400);
        expect(res.body.message).to.include('LLM Optimizer is not enabled for this site');
      });
    });

    // ──────────────────────────────────────────────────────────────────
    // Path B edge case: missing sourceOrganizationId (delegatedUserNoSource)
    // ──────────────────────────────────────────────────────────────────

    describe('Path B edge case: missing sourceOrganizationId', () => {
      it('delegatedUserNoSource: SITE_1 → 403 users belonging (warn + return false; no sourceOrganizationId)', async () => {
        // delegated_tenants[0] has no sourceOrganizationId →
        // AccessControlUtil logs warn and returns false without DB call.
        const http = getHttpClient();
        const res = await http.delegatedUserNoSource.get(
          `/sites/${SITE_1_ID}/llmo/config`,
          LLMO_HEADER,
        );
        expect(res.status).to.equal(403);
        expect(res.body.message).to.include('Only users belonging to the organization');
      });

      it('delegatedUserNoSource: SITE_2 → 403 users belonging (no sourceOrganizationId)', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUserNoSource.get(
          `/sites/${SITE_2_ID}/llmo/config`,
          LLMO_HEADER,
        );
        expect(res.status).to.equal(403);
        expect(res.body.message).to.include('Only users belonging to the organization');
      });

      it('delegatedUserNoSource: SITE_3 → 403 users belonging (no sourceOrganizationId)', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUserNoSource.get(
          `/sites/${SITE_3_ID}/llmo/config`,
          LLMO_HEADER,
        );
        expect(res.status).to.equal(403);
        expect(res.body.message).to.include('Only users belonging to the organization');
      });
    });
  });
}
