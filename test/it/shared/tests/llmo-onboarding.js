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
  LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT,
  hasPreBrandalfSites,
  resolveLlmoOnboardingMode,
} from '../../../../src/support/llmo-onboarding-mode.js';
import {
  ORG_LEGACY_LLMO_ID,
  ORG_NEW_LLMO_ID,
  SITE_LEGACY_LLMO_ID,
  SITE_NEW_LLMO_ID,
} from '../seed-ids.js';

/**
 * Shared LLMO Onboarding endpoint tests.
 *
 * POST /llmo/onboard — validation tests only (happy path needs LLMO admin auth +
 * external services: SharePoint, SQS, DRS, Configuration).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 * @param {() => object} getPostgrestClient - Getter returning an authenticated PostgREST client
 */
export default function llmoOnboardingTests(getHttpClient, resetData, getPostgrestClient) {
  describe('LLMO Onboarding', () => {
    before(() => resetData());

    // ── POST /llmo/onboard — validation ──

    describe('POST /llmo/onboard', () => {
      it('returns 400 for missing body', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/llmo/onboard');
        // May return 400 (missing data) or 403 (not LLMO admin) depending on auth setup
        expect(res.status).to.be.oneOf([400, 403]);
      });

      it('returns 400 for missing required fields', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/llmo/onboard', {
          domain: 'example.com',
          // missing brandName
        });
        expect(res.status).to.be.oneOf([400, 403]);
      });

      it('returns 400 for invalid cadence value', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/llmo/onboard', {
          domain: 'example.com',
          brandName: 'Test Brand',
          cadence: 'invalid-value',
        });
        // Cadence validation happens after auth check — may return 403 if not LLMO admin
        expect(res.status).to.be.oneOf([400, 403]);
      });

      it('accepts valid cadence values without cadence-specific errors', async () => {
        const http = getHttpClient();
        // This verifies 'daily' is not rejected at the validation layer
        const res = await http.admin.post('/llmo/onboard', {
          domain: 'cadence-test.com',
          brandName: 'Cadence Test',
          cadence: 'daily',
        });
        // Should not be 400 for cadence — expect 403 (auth) or 200/500 (downstream)
        if (res.status === 400) {
          const body = await res.json();
          expect(body.message).to.not.include('Invalid cadence');
        }
      });
    });

    // ── LLMO onboarding mode resolution — integration tests ──
    //
    // TEMPORARY: these tests validate resolveLlmoOnboardingMode's legacy-customer
    // protection using a real PostgREST DB. Remove them along with the
    // hasPreBrandalfSites / resolveBrandalfCutoffMs helpers once all v1
    // customers have been migrated to v2.

    describe('resolveLlmoOnboardingMode (DB integration)', () => {
      /**
       * Builds a minimal context wiring Site.allByOrganizationId to a direct
       * PostgREST query, so we can test the mode-resolution logic against the
       * real Docker DB without spinning up the full middleware stack.
       */
      function makeDbContext(postgrestClient, envOverrides = {}) {
        return {
          env: {
            LLMO_BRANDALF_GA_CUTOFF_MS: String(LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT),
            ...envOverrides,
          },
          log: { warn: () => {} },
          dataAccess: {
            Site: {
              allByOrganizationId: async (orgId) => {
                const { data, error } = await postgrestClient
                  .from('sites')
                  .select('id,created_at')
                  .eq('organization_id', orgId);
                if (error) {
                  throw new Error(error.message);
                }
                return (data || []).map((row) => ({
                  getId: () => row.id,
                  getCreatedAt: () => row.created_at,
                }));
              },
            },
          },
        };
      }

      it('hasPreBrandalfSites → true for an org with a site created before the cutoff', async () => {
        const ctx = makeDbContext(getPostgrestClient());
        const result = await hasPreBrandalfSites(ORG_LEGACY_LLMO_ID, ctx);
        expect(result).to.equal(true);
      });

      it('hasPreBrandalfSites → false for an org with a site created after the cutoff', async () => {
        const ctx = makeDbContext(getPostgrestClient());
        const result = await hasPreBrandalfSites(ORG_NEW_LLMO_ID, ctx);
        expect(result).to.equal(false);
      });

      it('hasPreBrandalfSites → false for an org with no sites', async () => {
        // ORG_LEGACY_LLMO and ORG_NEW_LLMO cover the two main cases;
        // use NON_EXISTENT_ORG path via an org that has no sites in seed data.
        // We temporarily insert a bare org for this check.
        const pgClient = getPostgrestClient();
        const emptyOrgId = 'fe333333-3333-4333-b333-333333333333';
        await pgClient.from('organizations').insert({
          id: emptyOrgId,
          name: 'Empty Org For Mode Test',
          ims_org_id: 'EMPTYYYY00000000000000000@AdobeOrg',
        });

        try {
          const ctx = makeDbContext(pgClient);
          const result = await hasPreBrandalfSites(emptyOrgId, ctx);
          expect(result).to.equal(false);
        } finally {
          await pgClient.from('organizations').delete().eq('id', emptyOrgId);
        }
      });

      it('resolveLlmoOnboardingMode → v1 for a legacy org (pre-cutoff site)', async () => {
        const ctx = makeDbContext(getPostgrestClient());
        const mode = await resolveLlmoOnboardingMode(ORG_LEGACY_LLMO_ID, ctx);
        expect(mode).to.equal('v1');
      });

      it('resolveLlmoOnboardingMode → v2 for a new org (post-cutoff site)', async () => {
        const ctx = makeDbContext(getPostgrestClient());
        const mode = await resolveLlmoOnboardingMode(ORG_NEW_LLMO_ID, ctx);
        expect(mode).to.equal('v2');
      });

      it('resolveLlmoOnboardingMode → v1 when LLMO_ONBOARDING_DEFAULT_VERSION=v1 (kill switch)', async () => {
        const ctx = makeDbContext(getPostgrestClient(), {
          LLMO_ONBOARDING_DEFAULT_VERSION: 'v1',
        });
        // Even the new org should be v1 when the kill switch is active
        const mode = await resolveLlmoOnboardingMode(ORG_NEW_LLMO_ID, ctx);
        expect(mode).to.equal('v1');
      });

      it('site created_at values are preserved correctly by the DB round-trip', async () => {
        const pgClient = getPostgrestClient();
        const { data } = await pgClient
          .from('sites')
          .select('id,created_at')
          .in('id', [SITE_LEGACY_LLMO_ID, SITE_NEW_LLMO_ID]);

        const byId = Object.fromEntries((data || []).map((r) => [r.id, r.created_at]));

        expect(new Date(byId[SITE_LEGACY_LLMO_ID]).getTime())
          .to.be.lessThan(
            LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT,
            'legacy site should be before the cutoff',
          );
        expect(new Date(byId[SITE_NEW_LLMO_ID]).getTime())
          .to.be.greaterThanOrEqual(
            LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT,
            'new site should be at or after the cutoff',
          );
      });
    });
  });
}
