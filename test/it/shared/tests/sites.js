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
import { expectISOTimestamp } from '../helpers/assertions.js';
import {
  ORG_1_ID,
  ORG_2_ID,
  SITE_1_ID,
  SITE_1_BASE_URL,
  SITE_3_ID,
  SITE_3_BASE_URL,
  SITE_4_ID,
  SITE_4_BASE_URL,
  SITE_LEGACY_LLMO_ID,
  SITE_NEW_LLMO_ID,
  NON_EXISTENT_SITE_ID,
  PROJECT_1_ID,
} from '../seed-ids.js';

// LLMO-4176 mode-resolution test sites are seeded with intentionally
// historical / future created_at values to straddle the Brandalf GA cutoff
// (2026-04-01). They MUST be excluded from expectSiteListDto, which asserts
// createdAt is within the last hour.
const LLMO_FIXTURE_SITE_IDS = new Set([SITE_LEGACY_LLMO_ID, SITE_NEW_LLMO_ID]);

/**
 * Base64-encode a URL for the /sites/by-base-url/:baseURL path parameter.
 */
function base64url(url) {
  return Buffer.from(url).toString('base64');
}

/**
 * Asserts that an object has the SiteDto shape.
 */
function expectSiteDto(site) {
  expect(site).to.be.an('object');
  expect(site.id).to.be.a('string');
  expect(site.baseURL).to.be.a('string');
  expect(site.organizationId).to.be.a('string');
  expectISOTimestamp(site.createdAt, 'createdAt');
  expectISOTimestamp(site.updatedAt, 'updatedAt');
  expect(site).to.have.property('deliveryType');
  expect(site).to.have.property('isLive');
  expect(site).to.have.property('config');
}

/**
 * Asserts that an object has the slim SiteDto.toListJSON shape
 * returned by GET /sites (list endpoint).
 */
function expectSiteListDto(site) {
  expect(site).to.be.an('object');
  expect(site.id).to.be.a('string');
  expect(site.baseURL).to.be.a('string');
  expect(site.organizationId).to.be.a('string');
  expectISOTimestamp(site.createdAt, 'createdAt');
  expectISOTimestamp(site.updatedAt, 'updatedAt');
  expect(site).to.have.property('deliveryType');
  expect(site).to.have.property('isLive');
  expect(site).to.have.property('config');
  expect(site).to.not.have.any.keys('hlxConfig', 'authoringType', 'deliveryConfig', 'pageTypes', 'projectId', 'isPrimaryLocale', 'language', 'code', 'audits', 'updatedBy', 'isLiveToggledAt');
}

/**
 * Shared Site endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function siteTests(getHttpClient, resetData) {
  describe('Sites', () => {
    before(() => resetData());

    // ── Read-only assertions on baseline seed ──

    describe('GET /sites', () => {
      it('admin: returns all sites (excluding default org)', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites');
        expect(res.status).to.equal(200);
        // Legacy path (no limit/cursor params) excludes DEFAULT_ORGANIZATION_ID (ORG_1)
        // and ORGANIZATION_ID_FRIENDS_FAMILY sites to stay under 6MB Lambda limit.
        // Returns SITE_3 (ORG_2) + SITE_4 (ORG_3) + SITE_LEGACY_LLMO + SITE_NEW_LLMO
        // (LLMO-4176 mode-resolution test fixtures, neither under ORG_1).
        expect(res.body).to.be.an('array').with.lengthOf(4);
        // Skip the LLMO fixtures in the DTO check — they have intentional
        // historical/future createdAt values that fail the "recent" assertion.
        res.body
          .filter((s) => !LLMO_FIXTURE_SITE_IDS.has(s.id))
          .forEach((s) => expectSiteListDto(s));
        const ids = res.body.map((s) => s.id);
        expect(ids).to.include(SITE_3_ID);
        expect(ids).to.include(SITE_4_ID);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/sites');
        expect(res.status).to.equal(403);
      });

      // ── S2S readAll capability path ──
      // See docs/s2s/READALL_CAPABILITY_DESIGN.md.

      it('s2sConsumerReadAll: returns all sites (site:readAll)', async () => {
        const http = getHttpClient();
        const res = await http.s2sConsumerReadAll.get('/sites');
        expect(res.status).to.equal(200);
        // Same exclusions as the admin path apply (DEFAULT_ORGANIZATION_ID excluded).
        // Admin baseline returns 4: SITE_3, SITE_4, SITE_LEGACY_LLMO, SITE_NEW_LLMO.
        expect(res.body).to.be.an('array').with.lengthOf(4);
        const ids = res.body.map((s) => s.id);
        expect(ids).to.include(SITE_3_ID);
        expect(ids).to.include(SITE_4_ID);
      });

      it('s2sConsumerReadOnly: returns 403 (only has site:read, no site:readAll)', async () => {
        // Layer 1 (s2sAuthWrapper) denies - GET /sites now maps to site:readAll which
        // CONSUMER_1 does NOT hold.
        const http = getHttpClient();
        const res = await http.s2sConsumerReadOnly.get('/sites');
        expect(res.status).to.equal(403);
      });

      it('s2sConsumerUnknown: returns 403 (no Consumer row for the (clientId, imsOrgId) pair)', async () => {
        // Trust-boundary assertion: a token signed correctly by the auth-service for
        // a (clientId, imsOrgId) pair that has no Consumer row is rejected at Layer 1
        // by the s2sAuthWrapper - the Consumer-record lookup is the load-bearing
        // isolation invariant per the design.
        const http = getHttpClient();
        const res = await http.s2sConsumerUnknown.get('/sites');
        expect(res.status).to.equal(403);
      });

      it('admin: returns the paginated envelope and advances via cursor', async () => {
        // Pins both the controller↔DAL contract for the `returnCursor: true` shape AND
        // the cursor round-trip that pagination exists to provide. Seed has 6 sites
        // total (paginated branch bypasses the org exclusion), so limit=2 MUST yield
        // exactly 2 sites with hasMore=true on page 1.
        const http = getHttpClient();
        const page1 = await http.admin.get('/sites?limit=2');
        expect(page1.status).to.equal(200);
        expect(page1.body).to.be.an('object').that.has.all.keys('sites', 'pagination');
        expect(page1.body.sites).to.be.an('array').with.lengthOf(2);
        expect(page1.body.pagination).to.include({ limit: 2, hasMore: true });
        expect(page1.body.pagination.cursor).to.be.a('string').and.not.empty;
        page1.body.sites
          .filter((s) => !LLMO_FIXTURE_SITE_IDS.has(s.id))
          .forEach((s) => expectSiteListDto(s));

        // Page 2 must advance — no overlap with page 1, same envelope shape.
        const page2 = await http.admin.get(`/sites?limit=2&cursor=${encodeURIComponent(page1.body.pagination.cursor)}`);
        expect(page2.status).to.equal(200);
        expect(page2.body.sites).to.be.an('array').with.lengthOf(2);
        expect(page2.body.pagination.limit).to.equal(2);
        const page1Ids = new Set(page1.body.sites.map((s) => s.id));
        page2.body.sites.forEach((s) => expect(page1Ids.has(s.id)).to.be.false);
      });
    });

    describe('GET /sites/:siteId', () => {
      it('admin: returns site by ID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_1_ID}`);
        expect(res.status).to.equal(200);
        expectSiteDto(res.body);
        expect(res.body.id).to.equal(SITE_1_ID);
        expect(res.body.baseURL).to.equal(SITE_1_BASE_URL);
        expect(res.body.organizationId).to.equal(ORG_1_ID);
        expect(res.body.deliveryType).to.equal('aem_edge');
        expect(res.body.isLive).to.equal(true);

        // Enriched fields — exercises non-standard camelCase↔snake_case conversions
        expect(res.body.name).to.equal('Site One');
        expect(res.body.gitHubURL).to.equal('https://github.com/test-org/site1-repo');
        expect(res.body.hlxConfig).to.deep.include({ hlxVersion: 5 });
        expect(res.body.deliveryConfig).to.be.an('object');
        expect(res.body.authoringType).to.equal('documentauthoring');
        expect(res.body.projectId).to.equal(PROJECT_1_ID);
        expect(res.body.isPrimaryLocale).to.equal(true);
        expect(res.body.region).to.equal('US');
        expect(res.body.language).to.equal('en');
        expect(res.body.pageTypes).to.be.an('array').with.lengthOf(2);
        expect(res.body.isSandbox).to.equal(false);
      });

      it('user: returns accessible site by ID', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}`);
        expect(res.status).to.equal(200);
        expect(res.body.id).to.equal(SITE_1_ID);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}`);
        expect(res.status).to.equal(403);
      });

      it('admin: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${NON_EXISTENT_SITE_ID}`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites/not-a-uuid');
        expect(res.status).to.equal(400);
      });

      // ── Delegation persona smoke tests ──
      // hasAccess(site) is called without productCode, so delegation does NOT trigger.
      // delegatedUser has primary tenant ORG_3 only.

      it('delegatedUser: returns SITE_4 (owned by primary org ORG_3)', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.get(`/sites/${SITE_4_ID}`);
        expect(res.status).to.equal(200);
        expectSiteDto(res.body);
        expect(res.body.id).to.equal(SITE_4_ID);
        expect(res.body.baseURL).to.equal(SITE_4_BASE_URL);
      });

      it('delegatedUser: returns 403 for SITE_1 (owned by ORG_1, delegation does not apply without productCode)', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.get(`/sites/${SITE_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('delegatedUser: returns 403 for SITE_3 (owned by ORG_2, not in any tenant)', async () => {
        const http = getHttpClient();
        const res = await http.delegatedUser.get(`/sites/${SITE_3_ID}`);
        expect(res.status).to.equal(403);
      });

      // ── Read-only admin smoke tests ──
      // readOnlyAdminWrapper is fail-closed: without a LaunchDarkly SDK key in the
      // IT environment the feature-flag evaluation returns false, so ALL routes return
      // 403 regardless of HTTP method. These tests verify:
      //   1. The token is correctly parsed as a read-only admin identity.
      //   2. The readOnlyAdminWrapper is wired and rejects the request (fail-closed).
      // In an environment with the LD flag enabled, GET routes would return 200 and
      // POST/mutating routes would return 403.
      it('readOnlyAdmin: returns 403 for GET /sites/:siteId (fail-closed without LD flag)', async () => {
        const http = getHttpClient();
        const res = await http.readOnlyAdmin.get(`/sites/${SITE_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('readOnlyAdmin: returns 403 for POST /sites (fail-closed without LD flag)', async () => {
        const http = getHttpClient();
        const res = await http.readOnlyAdmin.post('/sites', { baseURL: 'https://ro-admin-test.example.com' });
        expect(res.status).to.equal(403);
      });
    });

    describe('GET /sites/by-base-url/:baseURL', () => {
      it('admin: finds site by base64-encoded URL', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/by-base-url/${base64url(SITE_1_BASE_URL)}`);
        expect(res.status).to.equal(200);
        expectSiteDto(res.body);
        expect(res.body.id).to.equal(SITE_1_ID);
        expect(res.body.baseURL).to.equal(SITE_1_BASE_URL);
      });

      it('user: finds site by base64-encoded URL', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/by-base-url/${base64url(SITE_1_BASE_URL)}`);
        expect(res.status).to.equal(200);
        expectSiteDto(res.body);
        expect(res.body.id).to.equal(SITE_1_ID);
        expect(res.body.baseURL).to.equal(SITE_1_BASE_URL);
      });

      it('user: returns 404 for non-existent URL', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/by-base-url/${base64url('https://nonexistent.example.com')}`);
        expect(res.status).to.equal(404);
      });

      it('user: returns 403 for denied site URL', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/by-base-url/${base64url(SITE_3_BASE_URL)}`);
        expect(res.status).to.equal(403);
      });
    });

    describe('GET /sites/by-delivery-type/:deliveryType', () => {
      it('admin: returns sites filtered by delivery type', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites/by-delivery-type/aem_edge');
        expect(res.status).to.equal(200);
        // SITE_1, SITE_3, SITE_4, SITE_LEGACY_LLMO, SITE_NEW_LLMO are aem_edge;
        // SITE_2 is aem_cs.
        expect(res.body).to.be.an('array').with.lengthOf(5);
        res.body.forEach((site) => {
          expect(site.deliveryType).to.equal('aem_edge');
        });
      });

      it('admin: returns empty array for unmatched delivery type', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites/by-delivery-type/other');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/sites/by-delivery-type/aem_edge');
        expect(res.status).to.equal(403);
      });

      it('admin: returns sites when delivery type is uppercase', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites/by-delivery-type/AEM_EDGE');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(5);
        res.body.forEach((site) => {
          expect(site.deliveryType).to.equal('aem_edge');
        });
      });

      it('admin: returns sites when delivery type is mixed-case', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites/by-delivery-type/Aem_Edge');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(5);
        res.body.forEach((site) => {
          expect(site.deliveryType).to.equal('aem_edge');
        });
      });
    });

    // ── Write operations ──

    describe('POST /sites', () => {
      before(() => resetData());

      it('admin: creates a new site', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/sites', {
          baseURL: 'https://new-it-site.example.com',
        });
        expect(res.status).to.equal(201);
        expectSiteDto(res.body);
        expect(res.body.baseURL).to.equal('https://new-it-site.example.com');
        expect(res.body.organizationId).to.equal(ORG_1_ID);
      });

      it('admin: returns existing site for same baseURL (idempotent)', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/sites', {
          baseURL: SITE_1_BASE_URL,
        });
        expect(res.status).to.equal(200);
        expect(res.body.id).to.equal(SITE_1_ID);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.post('/sites', {
          baseURL: 'https://user-attempt.example.com',
        });
        expect(res.status).to.equal(403);
      });
    });

    describe('PATCH /sites/:siteId', () => {
      let testSiteId;

      before(async () => {
        await resetData();
        // Create a test-scoped site under ORG_1 so user has access.
        // Avoids mutating baseline seed entities.
        const http = getHttpClient();
        const res = await http.admin.post('/sites', {
          baseURL: 'https://patch-test-scoped.example.com',
        });
        expect(res.status).to.equal(201);
        testSiteId = res.body.id;
      });

      it('user: updates accessible site name', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${testSiteId}`, {
          name: 'Updated Site Name',
        });
        expect(res.status).to.equal(200);
        expectSiteDto(res.body);
        expect(res.body.id).to.equal(testSiteId);
        expect(res.body.name).to.equal('Updated Site Name');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_3_ID}`, {
          name: 'Should Fail',
        });
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${NON_EXISTENT_SITE_ID}`, {
          name: 'Ghost Site',
        });
        expect(res.status).to.equal(404);
      });

      it('user: returns 400 when no fields are changed', async () => {
        const http = getHttpClient();
        const current = await http.user.get(`/sites/${testSiteId}`);
        expect(current.status).to.equal(200);
        const res = await http.user.patch(`/sites/${testSiteId}`, {
          name: current.body.name,
        });
        expect(res.status).to.equal(400);
      });

      it('user: returns 403 when trying to change organizationId', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_1_ID}`, {
          organizationId: ORG_2_ID,
        });
        expect(res.status).to.equal(403);
      });
    });

    describe('PATCH /sites/:siteId/config/scraper', () => {
      let scraperSiteId;

      before(async () => {
        await resetData();
        // Use a test-scoped site under ORG_1 so `user` has access via the
        // org-membership rule. Avoids mutating baseline seed entities so
        // failures here don't bleed into other tests.
        const http = getHttpClient();
        const res = await http.admin.post('/sites', {
          baseURL: 'https://scraper-config-test-scoped.example.com',
        });
        expect(res.status).to.equal(201);
        scraperSiteId = res.body.id;
      });

      // Cases that exercise the shared `siteConfig.updateScraperConfig(...)`
      // are skipped until the `@adobe/spacecat-shared-data-access` dep is
      // bumped to a version that includes the new getter/setter (introduced
      // in adobe/spacecat-shared#1618). With the currently-pinned shared
      // version the controller call resolves to `undefined`, throws a
      // TypeError, and the catch block re-throws it as 500. The other
      // cases below — 403, 404, missing-body, malformed-UUID — short-circuit
      // before reaching the shared method and pass on the current dep pin.
      describe('cases requiring @adobe/spacecat-shared-data-access >= 3.71.0', () => {
        it('user: persists scraperConfig.headers and returns the narrow shape', async () => {
          const http = getHttpClient();
          const payload = {
            scraperConfig: {
              headers: { 'Accept-Language': 'en-US,en;q=0.9' },
            },
          };
          const res = await http.user.patch(
            `/sites/${scraperSiteId}/config/scraper`,
            payload,
          );
          expect(res.status).to.equal(200);
          // Locks the contract: response carries only siteId + scraperConfig,
          // not the full site (which may include unrelated secrets).
          expect(res.body).to.have.all.keys('siteId', 'scraperConfig');
          expect(res.body.siteId).to.equal(scraperSiteId);
          expect(res.body.scraperConfig).to.deep.equal(payload.scraperConfig);

          // Verify it actually persisted (not just echoed by the response).
          const reread = await http.user.get(`/sites/${scraperSiteId}`);
          expect(reread.status).to.equal(200);
          expect(reread.body.config.scraperConfig).to.deep.equal(payload.scraperConfig);
        });

        it('user: replace semantics — partial body fully replaces stored value', async () => {
          const http = getHttpClient();
          // Seed an initial config first.
          await http.user.patch(`/sites/${scraperSiteId}/config/scraper`, {
            scraperConfig: { headers: { 'Accept-Language': 'fr-FR' } },
          });
          // PATCH with empty object should clear it.
          const res = await http.user.patch(`/sites/${scraperSiteId}/config/scraper`, {
            scraperConfig: {},
          });
          expect(res.status).to.equal(200);
          expect(res.body.scraperConfig).to.deep.equal({});
        });

        it('user: rejects reserved header names', async () => {
          const http = getHttpClient();
          const res = await http.user.patch(`/sites/${scraperSiteId}/config/scraper`, {
            scraperConfig: { headers: { Authorization: 'Bearer x' } },
          });
          expect(res.status).to.equal(400);
          expect(res.body.message).to.match(/reserved scraper header/i);
        });

        it('user: rejects CRLF in header values', async () => {
          const http = getHttpClient();
          const res = await http.user.patch(`/sites/${scraperSiteId}/config/scraper`, {
            scraperConfig: { headers: { 'X-Foo': 'a\r\nX-Bad: y' } },
          });
          expect(res.status).to.equal(400);
        });
      });

      it('user: returns 403 for a denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_3_ID}/config/scraper`, {
          scraperConfig: { headers: { 'Accept-Language': 'en-US' } },
        });
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for a non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${NON_EXISTENT_SITE_ID}/config/scraper`, {
          scraperConfig: { headers: { 'Accept-Language': 'en-US' } },
        });
        expect(res.status).to.equal(404);
      });

      it('admin: returns 400 when scraperConfig is missing from the body', async () => {
        const http = getHttpClient();
        const res = await http.admin.patch(
          `/sites/${scraperSiteId}/config/scraper`,
          {},
        );
        expect(res.status).to.equal(400);
        expect(res.body.message).to.equal('Scraper config required');
      });

      it('admin: returns 400 when site ID is malformed', async () => {
        // The framework's path-param middleware rejects malformed UUIDs in
        // `src/index.js` via `isValidUUIDV4()` before the controller runs,
        // so the message comes from the framework (not the controller's
        // own `Invalid site ID` string, which is only reachable for the
        // body-only validation cases).
        const http = getHttpClient();
        const res = await http.admin.patch('/sites/not-a-uuid/config/scraper', {
          scraperConfig: { headers: { 'Accept-Language': 'en-US' } },
        });
        expect(res.status).to.equal(400);
        expect(res.body.message).to.match(/site id is invalid/i);
      });
    });

    describe('DELETE /sites/:siteId', () => {
      it('admin: returns 403 (restricted)', async () => {
        const http = getHttpClient();
        const res = await http.admin.delete(`/sites/${SITE_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 403 (restricted)', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`/sites/${SITE_1_ID}`);
        expect(res.status).to.equal(403);
      });
    });
  });
}
