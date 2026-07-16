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
import { SITE_1_ID, SITE_3_ID } from '../seed-ids.js';

/**
 * Shared Audit Policy contract tests (SITES-47306).
 *
 * GATED: exercises the real `wrpc_upsert_audit_policy` RPC — including the
 * `p_expected_version` optimistic-lock parameter and its `SQLSTATE 40001`
 * conflict path — against Postgres + PostgREST via the pinned data-service
 * image. That parameter (and `audit_policy_revision.effective_at`) ship in
 * mysticat-data-service PR #755, a follow-up on top of the B2 `audit_policy`
 * table (PR #753, merged). Cannot pass until: (a) #755 merges, (b) a new
 * data-service image is cut, (c) that image is pinned in docker-compose.yml,
 * and (d) this suite is flipped from `describe.skip` to `describe` here.
 *
 * SITE_1_ID (ORG_1, accessible, LLMO-entitled) is used for the happy path;
 * SITE_3_ID (ORG_2, "denied") for the cross-org 403 check — see
 * test/it/shared/tests/audit-urls.js for the same SITE_1/SITE_3 convention.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function auditPolicyTests(getHttpClient, resetData) {
  describe.skip('Audit Policy [GATED: needs data-service image with B2 + p_expected_version, SITES-47306]', () => {
    before(() => resetData());

    it('API-2: GET returns synthetic version 0 when no row exists', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/sites/${SITE_1_ID}/audit-policy`);
      expect(res.status).to.equal(200);
      expect(res.body.version).to.equal(0);
    });

    it('API-3/API-5: first PUT with expectedVersion 0 creates version 1', async () => {
      const http = getHttpClient();
      const res = await http.admin.put(`/sites/${SITE_1_ID}/audit-policy`, {
        budget: 4000,
        strategyName: 'tiered',
        exclusionGlobs: [],
        manualUrls: [],
        scopeConfig: {},
        lifecycleOverrides: {},
        reason: 'init',
        expectedVersion: 0,
      });
      expect(res.status).to.equal(200);
      expect(res.body.version).to.equal(1);
    });

    it('API-5: stale expectedVersion yields 409 with currentVersion', async () => {
      const http = getHttpClient();
      const res = await http.admin.put(`/sites/${SITE_1_ID}/audit-policy`, {
        budget: 4000,
        strategyName: 'tiered',
        exclusionGlobs: [],
        manualUrls: [],
        scopeConfig: {},
        lifecycleOverrides: {},
        reason: 'stale',
        expectedVersion: 0,
      });
      expect(res.status).to.equal(409);
      expect(res.body.currentVersion).to.equal(1);
    });

    it('API-8: non-member gets 403', async () => {
      const http = getHttpClient();
      const res = await http.user.get(`/sites/${SITE_3_ID}/audit-policy`);
      expect(res.status).to.equal(403);
    });

    it('API-10: revisions are newest-first', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/sites/${SITE_1_ID}/audit-policy/revisions`);
      expect(res.status).to.equal(200);
      const { items } = res.body;
      if (items.length > 1) {
        expect(items[0].version).to.be.greaterThan(items[1].version);
      }
    });

    it('API-15: scope-read endpoints return 501 pre-implementation', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/sites/${SITE_1_ID}/audit-scope/summary`);
      expect(res.status).to.equal(501);
    });
  });
}
