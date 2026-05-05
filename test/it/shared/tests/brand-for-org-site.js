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
  ORG_1_ID,
  ORG_2_ID,
  SITE_1_ID,
  SITE_2_ID,
  SITE_3_ID,
  BRAND_1_ID,
  NON_EXISTENT_ORG_ID,
  NON_EXISTENT_SITE_ID,
} from '../seed-ids.js';

/**
 * Integration tests for the LLMO-4716 (org, site) → brand resolver endpoint.
 *
 * Validates:
 *  - resolver gating on `resolveLlmoOnboardingMode === v2`
 *  - primary `brands.site_id` lookup
 *  - 404 on v1 / brandalf-migration / no-active-brand
 *  - 403 on tenant isolation (site does not belong to org)
 *  - 404 on missing org / site
 *  - 403 on cross-org user access
 *
 * Each describe block calls `resetData()` to start from baseline, then uses
 * the postgrestClient directly to set up the brandalf flag and brand→site
 * mapping required by each scenario. The flag is set via direct table write
 * (rather than the API) because that's the lowest-coupling way to express
 * "this org happens to be in v2 mode" without depending on other endpoints'
 * behavior.
 *
 * @param {() => object} getHttpClient - Returns initialized HTTP client (admin/user/trialUser)
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 * @param {() => object} getPostgrestClient - Returns a PostgREST writer client
 */
export default function brandForOrgSiteTests(getHttpClient, resetData, getPostgrestClient) {
  describe('GET /v2/orgs/:spaceCatId/sites/:siteId/brand (LLMO-4716)', () => {
    /**
     * Sets brandalf=true for the given org so resolveLlmoOnboardingMode
     * returns v2 (the gate the new endpoint enforces).
     */
    async function setBrandalfTrue(orgId) {
      const pg = getPostgrestClient();
      const { error } = await pg
        .from('feature_flags')
        .upsert({
          organization_id: orgId,
          product: 'LLMO',
          flag_name: 'brandalf',
          flag_value: true,
          updated_by: 'it-setup',
        }, { onConflict: 'organization_id,product,flag_name' });
      if (error) {
        throw new Error(`Failed to set brandalf flag: ${error.message}`);
      }
    }

    /**
     * Maps BRAND_1 to a specific site by setting `brands.site_id`. This is the
     * primary lookup path the resolver uses (LLMO-4592 invariant: ACTIVE
     * brands have unique-per-org site_id).
     */
    async function bindBrandToSite(brandId, siteId) {
      const pg = getPostgrestClient();
      const { error } = await pg
        .from('brands')
        .update({ site_id: siteId })
        .eq('id', brandId);
      if (error) {
        throw new Error(`Failed to bind brand to site: ${error.message}`);
      }
    }

    describe('v2 org with brand mapped to site', () => {
      before(async () => {
        await resetData();
        await setBrandalfTrue(ORG_1_ID);
        await bindBrandToSite(BRAND_1_ID, SITE_1_ID);
      });

      it('returns 200 with the V2 brand object for admin', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/sites/${SITE_1_ID}/brand`,
        );
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        expect(res.body.id).to.equal(BRAND_1_ID);
        expect(res.body.name).to.equal('Test Brand');
        expect(res.body.status).to.equal('active');
      });

      it('returns 200 for org-member user (ORG_1)', async () => {
        const http = getHttpClient();
        const res = await http.user.get(
          `/v2/orgs/${ORG_1_ID}/sites/${SITE_1_ID}/brand`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.id).to.equal(BRAND_1_ID);
      });

      it('returns 404 for a different site in the same v2 org with no brand binding', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/sites/${SITE_2_ID}/brand`,
        );
        expect(res.status).to.equal(404);
      });
    });

    describe('v1 org (no brandalf flag)', () => {
      before(async () => {
        await resetData();
        await bindBrandToSite(BRAND_1_ID, SITE_1_ID);
        // brandalf flag NOT set for ORG_1 → resolver returns v1 → endpoint 404s
      });

      it('returns 404 even when a brand row exists for the site (gating works)', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/sites/${SITE_1_ID}/brand`,
        );
        expect(res.status).to.equal(404);
      });
    });

    describe('tenant isolation', () => {
      before(async () => {
        await resetData();
        await setBrandalfTrue(ORG_1_ID);
        await bindBrandToSite(BRAND_1_ID, SITE_1_ID);
      });

      it('returns 403 when site does not belong to the organization (matches triggerConfigSync)', async () => {
        const http = getHttpClient();
        // SITE_3 belongs to ORG_2, not ORG_1
        const res = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/sites/${SITE_3_ID}/brand`,
        );
        expect(res.status).to.equal(403);
      });

      it('returns 403 for cross-org user access (ORG_1 user → ORG_2)', async () => {
        const http = getHttpClient();
        // ORG_2 is the "denied" org for the user persona; admin would pass
        const res = await http.user.get(
          `/v2/orgs/${ORG_2_ID}/sites/${SITE_3_ID}/brand`,
        );
        expect(res.status).to.equal(403);
      });
    });

    describe('not-found cases', () => {
      before(async () => {
        await resetData();
        await setBrandalfTrue(ORG_1_ID);
      });

      it('returns 404 when the organization does not exist', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/v2/orgs/${NON_EXISTENT_ORG_ID}/sites/${SITE_1_ID}/brand`,
        );
        expect(res.status).to.equal(404);
      });

      it('returns 404 when the site does not exist', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/sites/${NON_EXISTENT_SITE_ID}/brand`,
        );
        expect(res.status).to.equal(404);
      });
    });

    describe('input validation', () => {
      it('returns 400 when spaceCatId is not a valid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/v2/orgs/not-a-uuid/sites/${SITE_1_ID}/brand`,
        );
        expect(res.status).to.equal(400);
      });

      it('returns 400 when siteId is not a valid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/sites/not-a-uuid/brand`,
        );
        expect(res.status).to.equal(400);
      });
    });
  });
}
