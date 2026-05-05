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
  ORG_LEGACY_LLMO_ID,
  SITE_LEGACY_LLMO_ID,
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
     * Sets a feature flag for the given org. Used to set brandalf=true (the
     * primary gate) and brandalf-migration=true (the dual-publish window
     * Adobe is in today).
     */
    async function setFlag(orgId, flagName, value) {
      const pg = getPostgrestClient();
      const { error } = await pg
        .from('feature_flags')
        .upsert({
          organization_id: orgId,
          product: 'LLMO',
          flag_name: flagName,
          flag_value: value,
          updated_by: 'it-setup',
        }, { onConflict: 'organization_id,product,flag_name' });
      if (error) {
        throw new Error(`Failed to set ${flagName} flag: ${error.message}`);
      }
    }

    const setBrandalfTrue = (orgId) => setFlag(orgId, 'brandalf', true);
    const setBrandalfMigrationTrue = (orgId) => setFlag(orgId, 'brandalf-migration', true);

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

    describe('brandalf-migration org (Adobe dual-publish window)', () => {
      // Adobe's prod state right now: brandalf=false (or unset) but
      // brandalf-migration=true. The endpoint's gate must surface the brand
      // for these orgs so the BP runner can enter the v2 path during the
      // migration window.
      before(async () => {
        await resetData();
        await setBrandalfMigrationTrue(ORG_1_ID);
        await bindBrandToSite(BRAND_1_ID, SITE_1_ID);
      });

      it('returns 200 with the brand when brandalf-migration=true', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/sites/${SITE_1_ID}/brand`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.id).to.equal(BRAND_1_ID);
      });
    });

    describe('v1 org (resolver returns v1)', () => {
      // ORG_LEGACY_LLMO_ID owns SITE_LEGACY_LLMO_ID with created_at before the
      // 2026-04-01 Brandalf GA cutoff → resolveLlmoOnboardingMode falls into
      // the "pre-cutoff sites" branch and returns v1 even without a brandalf
      // flag set. ORG_1 cannot be used here because all its sites are
      // post-cutoff, so the resolver returns v2 by default.
      const LEGACY_BRAND_ID = 'a1ffffff-ffff-4fff-bfff-ffffffffffff';

      before(async () => {
        await resetData();
        // Insert a brand for the legacy org bound to the legacy site, so the
        // test exercises "endpoint correctly 404s even when a brand WOULD have
        // matched" — proving the resolver gate works.
        const pg = getPostgrestClient();
        const { error } = await pg.from('brands').upsert({
          id: LEGACY_BRAND_ID,
          organization_id: ORG_LEGACY_LLMO_ID,
          name: 'Legacy Brand',
          status: 'active',
          origin: 'human',
          regions: ['us'],
          site_id: SITE_LEGACY_LLMO_ID,
          updated_by: 'it-setup',
        });
        if (error) {
          throw new Error(`Failed to seed legacy brand: ${error.message}`);
        }
      });

      it('returns 404 even when a brand row exists for the site (gating works)', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/v2/orgs/${ORG_LEGACY_LLMO_ID}/sites/${SITE_LEGACY_LLMO_ID}/brand`,
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
