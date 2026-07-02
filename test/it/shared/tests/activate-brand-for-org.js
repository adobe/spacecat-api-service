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
  SITE_4_ID, // existing ORG_3 site the pending brand is anchored to / promotes onto
  ACTIVATE_PENDING_BRAND_ID, // pending brand anchored to SITE_4
  ACTIVATE_CONFLICT_BRAND_ID, // pending brand that resolves to SITE_4 → 409
} from '../seed-ids.js';

/**
 * Shared integration tests for the self-serve brand-activation endpoint
 * (POST /v2/orgs/:spaceCatId/brands/:brandId/activate — LLMO-5605).
 *
 * Covers, against the real PostgREST DB:
 *  - request validation + the auth gate (org lookup → membership → explicit PAID
 *    entitlement) + the org-scoped brand lookup;
 *  - the real promotion path (pending → active with baseSiteId written), its
 *    idempotent re-activation no-op, and the brands_base_site_unique → 409 — all
 *    pure Postgres, so testable here.
 *
 * The best-effort DRS prompt-gen + schedule side-effects are covered by the unit
 * suite (test/controllers/brands.test.js); DRS is unconfigured in this harness,
 * so those external interactions don't run here (generatePrompts:false is used).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function activateBrandForOrgTests(getHttpClient, resetData) {
  describe('POST /v2/orgs/:spaceCatId/brands/:brandId/activate (brand activation)', () => {
    before(() => resetData());

    // A syntactically valid UUID that matches no seeded brand — passes the
    // upstream UUID guard but resolves to null in getBrandById.
    const MISSING_BRAND_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const activatePath = (orgId, brandId) => `/v2/orgs/${orgId}/brands/${brandId}/activate`;
    const validBody = { generatePrompts: false };

    it('returns 400 when generatePrompts is missing (validation runs before the auth gate)', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(activatePath(ORG_3_ID, MISSING_BRAND_ID), {});
      expect(res.status).to.equal(400);
    });

    it('returns 404 when the organization does not exist', async () => {
      const http = getHttpClient();
      const path = activatePath(NON_EXISTENT_ORG_ID, MISSING_BRAND_ID);
      const res = await http.admin.post(path, validBody);
      expect(res.status).to.equal(404);
    });

    it('returns 403 for a non-member (user persona on an org they do not belong to)', async () => {
      const http = getHttpClient();
      const res = await http.user.post(activatePath(ORG_3_ID, MISSING_BRAND_ID), validBody);
      expect(res.status).to.equal(403);
    });

    it('returns 403 when the organization has no LLMO entitlement', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(activatePath(ORG_2_ID, MISSING_BRAND_ID), validBody);
      expect(res.status).to.equal(403);
    });

    it("returns 403 when the organization's LLMO entitlement is FREE_TRIAL (not PAID)", async () => {
      // ORG_1 has a FREE_TRIAL LLMO entitlement. PAID is stricter than the
      // platform's any-tier "LLMO-enabled" bar, so this must be rejected.
      const http = getHttpClient();
      const res = await http.admin.post(activatePath(ORG_1_ID, MISSING_BRAND_ID), validBody);
      expect(res.status).to.equal(403);
    });

    it('passes the PAID gate and reaches the brand lookup (404 for a missing brand)', async () => {
      // ORG_3 has a PAID LLMO entitlement. With admin auth, membership + PAID both
      // pass, so a non-existent brand surfaces as a 404 from getBrandById rather than
      // a 403 — proving the gate opens for a paying org.
      const http = getHttpClient();
      const res = await http.admin.post(activatePath(ORG_3_ID, MISSING_BRAND_ID), validBody);
      expect(res.status).to.equal(404);
    });

    // --- Real promotion path (pure Postgres; DRS unconfigured, generatePrompts:false) ---
    // These run in order: the promote below activates ACTIVATE_PENDING_BRAND_ID and
    // claims its base site, which the idempotency and 409 cases then rely on.

    it('promotes a pending brand to active and anchors its base site', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(
        activatePath(ORG_3_ID, ACTIVATE_PENDING_BRAND_ID),
        { generatePrompts: false },
      );

      expect(res.status).to.equal(200);
      expect(res.body.status).to.equal('active');
      expect(res.body.baseSiteId).to.equal(SITE_4_ID);

      // The persisted brand is now active and anchored to its base site.
      const brandPath = `/v2/orgs/${ORG_3_ID}/brands/${ACTIVATE_PENDING_BRAND_ID}`;
      const getRes = await http.admin.get(brandPath);
      expect(getRes.status).to.equal(200);
      expect(getRes.body.status).to.equal('active');
      expect(getRes.body.baseSiteId).to.equal(SITE_4_ID);
    });

    it('is idempotent — re-activating the now-active brand is a 200 no-op', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(
        activatePath(ORG_3_ID, ACTIVATE_PENDING_BRAND_ID),
        { generatePrompts: false },
      );
      expect(res.status).to.equal(200);
      expect(res.body.status).to.equal('active');
    });

    it('returns 409 when a second brand activates onto an already-claimed base site', async () => {
      // ACTIVATE_CONFLICT_BRAND_ID resolves (via its stashed Semrush primaryUrl) to the
      // same site the brand above now owns → brands_base_site_unique.
      const http = getHttpClient();
      const res = await http.admin.post(
        activatePath(ORG_3_ID, ACTIVATE_CONFLICT_BRAND_ID),
        { generatePrompts: false },
      );
      expect(res.status).to.equal(409);
    });
  });
}
