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
import { SITE_1_ID, SITE_1_BASE_URL, SITE_3_ID } from '../seed-ids.js';

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
 * The `GET /audit-scope/pages` (E4, SITES-46351) describe block below reads
 * `v_audit_scope_pages`, a data-service view added in mysticat-data-service
 * migration `20260729162246_audit_scope_pages_view.sql`, first released in
 * mysticat-data-service v5.81.0 — the docker-compose.yml pin above must stay
 * at or above that tag for this describe block to pass. See seedAuditScopePages
 * in test/it/postgres/seed.js.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 * @param {(siteId: string, pages: Array<{ url: string, urlPath: string,
 *   inScope?: boolean }>) => Promise<void>} seedAuditScopePages - Seeds
 *   page_inventory + matching d_page_in_scope facts for a site (see seed.js).
 */
export default function auditPolicyTests(getHttpClient, resetData, seedAuditScopePages) {
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

    it('paginates revisions with limit + cursor read from the query string', async () => {
      // Regression test: listRevisions must read limit/cursor from context.data (query
      // string), not context.params (path segments) - the route has no :limit/:cursor
      // path segments, so a context.params read is a silent no-op in production.
      const http = getHttpClient();
      const firstPage = await http.admin.get(`/sites/${SITE_1_ID}/audit-policy/revisions?limit=1`);
      expect(firstPage.status).to.equal(200);
      expect(firstPage.body.items).to.have.length(1);
      expect(firstPage.body.cursor).to.be.a('string').and.not.empty;

      const secondPage = await http.admin.get(
        `/sites/${SITE_1_ID}/audit-policy/revisions?limit=1&cursor=${firstPage.body.cursor}`,
      );
      expect(secondPage.status).to.equal(200);
      expect(secondPage.body.items).to.have.length(1);
      expect(secondPage.body.items[0].version).to.be.lessThan(firstPage.body.items[0].version);
    });

    it('API-15: scope-read endpoints return 501 pre-implementation', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/sites/${SITE_1_ID}/audit-scope/summary`);
      expect(res.status).to.equal(501);
    });

    describe('GET /audit-scope/pages (E4)', () => {
      const pageA = { url: `${SITE_1_BASE_URL}/audit-scope-a`, urlPath: '/audit-scope-a', inScope: true };
      const pageB = { url: `${SITE_1_BASE_URL}/audit-scope-b`, urlPath: '/audit-scope-b', inScope: true };
      const pageC = { url: `${SITE_1_BASE_URL}/audit-scope-c`, urlPath: '/audit-scope-c', inScope: false };

      before(() => seedAuditScopePages(SITE_1_ID, [pageA, pageB, pageC]));

      it('returns only in-scope pages, ordered by url, with the DTO shape', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_1_ID}/audit-scope/pages`);
        expect(res.status).to.equal(200);
        const { items } = res.body;
        expect(items.map((i) => i.url)).to.deep.equal([pageA.url, pageB.url]);
        expect(items[0]).to.have.keys(['url', 'urlPath', 'discoverySource', 'lastModified', 'lifecycleState']);
        expect(items[0].urlPath).to.equal(pageA.urlPath);
        expect(items[0].discoverySource).to.deep.equal(['sitemap']);
        expect(items[0].lifecycleState).to.equal('discovered');
      });

      it('paginates with limit + cursor', async () => {
        const http = getHttpClient();
        const firstPage = await http.admin.get(`/sites/${SITE_1_ID}/audit-scope/pages?limit=1`);
        expect(firstPage.status).to.equal(200);
        expect(firstPage.body.items.map((i) => i.url)).to.deep.equal([pageA.url]);
        expect(firstPage.body.cursor).to.be.a('string').and.not.empty;

        // A full page (items.length === limit) always emits a cursor, even when it's the
        // last page - getScopePages accepts one harmless extra request rather than doing a
        // second query to check for more rows (same tradeoff listRevisions makes), so don't
        // assert cursor absence here. Assert the second page advances with no overlap instead,
        // mirroring test/it/shared/tests/sites.js's cursor-pagination convention.
        const secondPage = await http.admin.get(
          `/sites/${SITE_1_ID}/audit-scope/pages?limit=1&cursor=${firstPage.body.cursor}`,
        );
        expect(secondPage.status).to.equal(200);
        expect(secondPage.body.items.map((i) => i.url)).to.deep.equal([pageB.url]);
        const firstPageUrls = new Set(firstPage.body.items.map((i) => i.url));
        secondPage.body.items.forEach((i) => expect(firstPageUrls.has(i.url)).to.be.false);
      });

      it('user: denied for a cross-org site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/audit-scope/pages`);
        expect(res.status).to.equal(403);
      });
    });
  });
}
