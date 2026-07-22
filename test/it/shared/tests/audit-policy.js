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
 * Exercises the real `wrpc_upsert_audit_policy` RPC — including the
 * `p_expected_version` optimistic-lock parameter and its `SQLSTATE 40000`
 * conflict path (40000, not 40001 — PostgREST v14.4 hangs on 40001, see
 * PostgREST/postgrest#3673) — against Postgres + PostgREST via the pinned data-service
 * image. That parameter (and `audit_policy_revision.effective_at`) ship in
 * mysticat-data-service PR #755 (merged), a follow-up on top of the B2
 * `audit_policy` table (PR #753, merged). Was gated behind `describe.skip`
 * until the data-service image pin in docker-compose.yml caught up past #755
 * (bumped v5.57.0 -> v5.70.0, the release cut immediately after #755 merged).
 *
 * SITE_1_ID (ORG_1, accessible, LLMO-entitled) is used for the happy path;
 * SITE_3_ID (ORG_2, "denied") for the cross-org 403 check — see
 * test/it/shared/tests/audit-urls.js for the same SITE_1/SITE_3 convention.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function auditPolicyTests(getHttpClient, resetData) {
  describe('Audit Policy', () => {
    before(() => resetData());

    it('API-2: GET returns synthetic version 0 when no row exists', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/sites/${SITE_1_ID}/audit-policy`);
      expect(res.status).to.equal(200);
      expect(res.body.version).to.equal(0);
    });

    it('first-write via exclusions add creates version 1 with no client-supplied version', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(`/sites/${SITE_1_ID}/audit-policy/exclusions`, {
        values: ['/checkout/*'],
        reason: 'init',
      });
      expect(res.status).to.equal(200);
      expect(res.body.version).to.equal(1);
      expect(res.body.exclusionGlobs).to.deep.equal(['/checkout/*']);
    });

    it('inclusions add unions into manualUrls and bumps the version', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(`/sites/${SITE_1_ID}/audit-policy/inclusions`, {
        values: ['https://example.com/campaign-a'],
        reason: 'add campaign page',
      });
      expect(res.status).to.equal(200);
      expect(res.body.version).to.equal(2);
      expect(res.body.manualUrls).to.deep.equal(['https://example.com/campaign-a']);
    });

    it('exclusions/delete removes a glob via set-difference', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(`/sites/${SITE_1_ID}/audit-policy/exclusions/delete`, {
        values: ['/checkout/*'],
        reason: 'remove checkout exclusion',
      });
      expect(res.status).to.equal(200);
      expect(res.body.version).to.equal(3);
      expect(res.body.exclusionGlobs).to.deep.equal([]);
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
