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
  BRAND_1_ID,
  NON_EXISTENT_BRAND_ID,
  NON_EXISTENT_ORG_ID,
} from '../seed-ids.js';
import {
  listFeatureFlagsByOrgAndProduct,
  readFeatureFlag,
  readFeatureFlagScopes,
  resolveFlagRowForBrand,
  upsertFeatureFlag,
} from '../../../../src/support/feature-flags-storage.js';

/**
 * PUT helper — the shared HTTP client does not expose a put() method,
 * so we build the request manually.
 */
async function putFlag(baseUrl, adminToken, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      'x-product': 'ASO',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsedBody = null;
  if (text) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }
  return { status: res.status, body: parsedBody };
}

/**
 * Shared Feature Flags endpoint + readFeatureFlag storage tests.
 *
 * @param {() => object} getHttpClient
 * @param {() => Promise<void>} resetData
 * @param {() => object} getPostgrestClient
 * @param {() => { baseUrl: string, adminToken: string }} getServerInfo
 */
export default function featureFlagsTests(
  getHttpClient,
  resetData,
  getPostgrestClient,
  getServerInfo,
) {
  describe('Feature Flags', () => {
    before(() => resetData());

    // ── PUT /organizations/:orgId/feature-flags/:product/:flagName ──

    describe('PUT /organizations/:orgId/feature-flags/:product/:flagName', () => {
      it('admin: creates a feature flag with value true', async () => {
        const { baseUrl, adminToken } = getServerInfo();
        const res = await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/llmo/brandalf`,
          { value: true },
        );
        expect(res.status).to.be.oneOf([200, 201]);
        expect(res.body).to.be.an('object');
        expect(res.body.flagName).to.equal('brandalf');
        expect(res.body.product).to.equal('LLMO');
        expect(res.body.flagValue).to.equal(true);
      });

      it('admin: disables a feature flag via DELETE', async () => {
        const http = getHttpClient();
        const res = await http.admin.delete(
          `/organizations/${ORG_1_ID}/feature-flags/llmo/brandalf`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.flagName).to.equal('brandalf');
        expect(res.body.flagValue).to.equal(false);

        // Verify via direct DB read
        const postgrestClient = getPostgrestClient();
        const dbValue = await readFeatureFlag({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'brandalf',
          postgrestClient,
        });
        expect(dbValue).to.equal(false);
      });

      it('returns 400 for invalid product', async () => {
        const { baseUrl, adminToken } = getServerInfo();
        const res = await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/INVALID/some_flag`,
          { value: true },
        );
        expect(res.status).to.equal(400);
      });

      it('returns 400 for invalid flag name', async () => {
        const { baseUrl, adminToken } = getServerInfo();
        const res = await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/llmo/InvalidName`,
          { value: true },
        );
        expect(res.status).to.equal(400);
      });

      // LLMO-6565. The brand-edit Semrush error allowance is gated on
      // `LLMO/serenity_ui` (see isSerenityUiActiveForOrg), so that flag name must
      // actually be storable. `feature_flags` carries
      // CHECK (flag_name ~ '^[a-z][a-z0-9_]*$') and isValidFeatureFlagName mirrors
      // it, and NOTHING on the read path validates the name — a hyphenated variant
      // resolves to `false` forever with no error surfaced anywhere, which is
      // indistinguishable from "the flag is simply off". Only a write against real
      // Postgres proves the spelling, which is why this is an IT and not a unit test.
      it('accepts serenity_ui and rejects the hyphenated serenity-ui (LLMO-6565)', async () => {
        const { baseUrl, adminToken } = getServerInfo();

        const ok = await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/llmo/serenity_ui`,
          { value: true },
        );
        expect(ok.status).to.be.oneOf([200, 201]);
        expect(ok.body.flagName).to.equal('serenity_ui');
        expect(ok.body.flagValue).to.equal(true);

        // Read it back through the same storage helper isSerenityUiActiveForOrg
        // uses, so the controller's gate is reading a row that genuinely persisted.
        const dbValue = await readFeatureFlag({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'serenity_ui',
          postgrestClient: getPostgrestClient(),
        });
        expect(dbValue).to.equal(true);

        // The hyphenated spelling is refused outright — it can never become a row.
        const hyphenated = await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/llmo/serenity-ui`,
          { value: true },
        );
        expect(hyphenated.status).to.equal(400);
      });
    });

    // ── GET /organizations/:orgId/feature-flags?product=LLMO ──

    describe('GET /organizations/:orgId/feature-flags?product=LLMO', () => {
      before(async () => {
        const { baseUrl, adminToken } = getServerInfo();
        await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/llmo/brandalf`,
          { value: true },
        );
      });

      it('admin: lists feature flags for an org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/feature-flags?product=LLMO`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array');

        const brandalf = res.body.find((f) => f.flagName === 'brandalf');
        expect(brandalf).to.exist;
        expect(brandalf.flagValue).to.equal(true);
        expect(brandalf.product).to.equal('LLMO');
      });

      it('admin: returns empty array for org with no flags', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_2_ID}/feature-flags?product=LLMO`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('returns 400 when product query param is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/feature-flags`);
        expect(res.status).to.equal(400);
      });

      it('returns 404 for non-existent org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${NON_EXISTENT_ORG_ID}/feature-flags?product=LLMO`);
        expect(res.status).to.equal(404);
      });

      it('user: returns 403 for non-admin user on denied org', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${ORG_2_ID}/feature-flags?product=LLMO`);
        expect(res.status).to.equal(403);
      });
    });

    // ── readFeatureFlag storage helper (direct DB test) ──

    describe('readFeatureFlag (storage helper against real DB)', () => {
      before(async () => {
        const { baseUrl, adminToken } = getServerInfo();
        await putFlag(
          baseUrl,
          adminToken,
          `/organizations/${ORG_1_ID}/feature-flags/llmo/brandalf`,
          { value: true },
        );
      });

      it('reads true when flag is set to true', async () => {
        const postgrestClient = getPostgrestClient();
        const result = await readFeatureFlag({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'brandalf',
          postgrestClient,
        });
        expect(result).to.equal(true);
      });

      it('reads false after flag is disabled via DELETE', async () => {
        // Disable via DELETE
        const http = getHttpClient();
        await http.admin.delete(
          `/organizations/${ORG_1_ID}/feature-flags/llmo/brandalf`,
        );

        const postgrestClient = getPostgrestClient();
        const result = await readFeatureFlag({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'brandalf',
          postgrestClient,
        });
        expect(result).to.equal(false);
      });

      it('returns null when flag does not exist for org', async () => {
        const postgrestClient = getPostgrestClient();
        const result = await readFeatureFlag({
          organizationId: ORG_2_ID,
          product: 'LLMO',
          flagName: 'brandalf',
          postgrestClient,
        });
        expect(result).to.be.null;
      });

      it('returns null when flag name does not exist', async () => {
        const postgrestClient = getPostgrestClient();
        const result = await readFeatureFlag({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'nonexistent_flag',
          postgrestClient,
        });
        expect(result).to.be.null;
      });
    });

    // Per-brand serenity resolution against real Postgres. The seed already gives
    // ORG_1 an org-level `LLMO/serenity` row set to true; these add BRAND_1
    // overrides on top of it — which is what the wave-execution CLI writes in
    // production. Only a real database proves the widened
    // `UNIQUE NULLS NOT DISTINCT (organization_id, product, flag_name, brand_id)`
    // key admits an org row and a brand row for the same flag, and that the
    // composite FK keeps an override from naming another org's brand.
    describe('brand-scoped overrides', () => {
      before(() => resetData());
      // Also per test, unlike every other describe in the IT suites, which reset
      // once. These tests each insert an override on the SAME
      // (organization, product, flag_name, brand) key, and the widened unique
      // constraint is real here — without a reset between them the second insert
      // would collide on a row the first left behind, and the collision is the
      // very thing one of them asserts. Using a different brand per test is not
      // an option: the composite foreign key requires a brand the organization
      // actually owns, and ORG_1 owns exactly one.
      afterEach(() => resetData());

      /** Inserts a raw override row, returning the PostgREST error (or null). */
      async function insertOverride(organizationId, brandId, value) {
        const { error } = await getPostgrestClient()
          .from('feature_flags')
          .insert({
            organization_id: organizationId,
            product: 'LLMO',
            flag_name: 'serenity',
            flag_value: value,
            brand_id: brandId,
            updated_by: 'it-setup',
          });
        return error ?? null;
      }

      it('stores an override alongside the org row for the same flag', async () => {
        // The three-column key this replaced could not hold both rows at once.
        expect(await insertOverride(ORG_1_ID, BRAND_1_ID, false)).to.be.null;

        const scopes = await readFeatureFlagScopes({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'serenity',
          postgrestClient: getPostgrestClient(),
        });
        expect(scopes.orgRow.flag_value).to.equal(true);
        expect(scopes.brandRows.get(BRAND_1_ID).flag_value).to.equal(false);
      });

      it('rejects a second override for the same brand and flag', async () => {
        expect(await insertOverride(ORG_1_ID, BRAND_1_ID, true)).to.be.null;
        // NULLS NOT DISTINCT widened the key but did not weaken it per brand.
        expect(await insertOverride(ORG_1_ID, BRAND_1_ID, false)).to.not.be.null;
      });

      it('refuses an override naming a brand from another organization', async () => {
        // The FK is composite — (organization_id, brand_id) → brands(organization_id, id)
        // — so a row cannot point at a brand the organization does not own.
        expect(await insertOverride(ORG_2_ID, BRAND_1_ID, true)).to.not.be.null;
      });

      it('resolves the brand override over the org row, and the org row without one', async () => {
        await insertOverride(ORG_1_ID, BRAND_1_ID, false);
        const scopes = await readFeatureFlagScopes({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'serenity',
          postgrestClient: getPostgrestClient(),
        });
        // The overridden brand is held back from an organization that is on.
        expect(resolveFlagRowForBrand(scopes, BRAND_1_ID).flag_value).to.equal(false);
        // A sibling brand with no override of its own inherits the org's value.
        // Any id absent from `brandRows` demonstrates that, and this resolution is
        // pure — the id is a Map key here, never a database lookup.
        expect(resolveFlagRowForBrand(scopes, NON_EXISTENT_BRAND_ID).flag_value).to.equal(true);
      });

      it('keeps readFeatureFlag and the GET endpoint reporting the ORG value only', async () => {
        // Part 1's invariant, now provable: an override must not change what the
        // organization-level read or the admin endpoint reports.
        await insertOverride(ORG_1_ID, BRAND_1_ID, false);
        const postgrestClient = getPostgrestClient();

        expect(await readFeatureFlag({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'serenity',
          postgrestClient,
        })).to.equal(true);

        const rows = await listFeatureFlagsByOrgAndProduct({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          postgrestClient,
        });
        expect(rows.filter((r) => r.flag_name === 'serenity')).to.have.lengthOf(1);
        expect(rows.every((r) => (r.brand_id ?? null) === null)).to.equal(true);

        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/feature-flags?product=LLMO`);
        expect(res.status).to.equal(200);
        const serenityEntries = res.body.filter((f) => f.flagName === 'serenity');
        expect(serenityEntries).to.have.lengthOf(1);
        expect(serenityEntries[0].flagValue).to.equal(true);
      });

      it('surfaces the resolved state on the brand payload (serenityActive)', async () => {
        // End-to-end through real PostgREST: the brand read issues its own
        // feature_flags query, and the wildcard projection has to bring `brand_id`
        // back for the override to be distinguishable from the org's row.
        const http = getHttpClient();

        // Seeded state: ORG_1's own row is true, BRAND_1 has no override.
        const inherited = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands`);
        expect(inherited.status).to.equal(200);
        const before = inherited.body.brands.find((b) => b.id === BRAND_1_ID);
        expect(before.serenityActive).to.equal(true);
        expect(before.serenityActivatedAt).to.be.a('string');

        // A false override holds this brand back from an organization that is on.
        await insertOverride(ORG_1_ID, BRAND_1_ID, false);
        const overridden = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands`);
        const after = overridden.body.brands.find((b) => b.id === BRAND_1_ID);
        expect(after.serenityActive).to.equal(false);
        expect(after.serenityActivatedAt).to.equal(null);
      });

      it('upsertFeatureFlag updates the org row and leaves the override intact', async () => {
        await insertOverride(ORG_1_ID, BRAND_1_ID, false);
        const postgrestClient = getPostgrestClient();

        await upsertFeatureFlag({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'serenity',
          value: false,
          updatedBy: 'it-setup',
          postgrestClient,
        });

        const scopes = await readFeatureFlagScopes({
          organizationId: ORG_1_ID,
          product: 'LLMO',
          flagName: 'serenity',
          postgrestClient,
        });
        expect(scopes.orgRow.flag_value).to.equal(false);
        expect(scopes.brandRows.get(BRAND_1_ID).flag_value).to.equal(false);
        expect(scopes.brandRows.size).to.equal(1);
      });
    });
  });
}
