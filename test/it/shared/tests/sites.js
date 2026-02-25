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
import { expectISOTimestamp, sortById } from '../helpers/assertions.js';
import {
  ORG_1_ID,
  ORG_2_ID,
  SITE_1_ID,
  SITE_1_BASE_URL,
  SITE_2_ID,
  SITE_3_ID,
  SITE_3_BASE_URL,
  NON_EXISTENT_SITE_ID,
  PROJECT_1_ID,
} from '../seed-ids.js';

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
      it('admin: returns all sites', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(3);
        const sorted = sortById(res.body);
        sorted.forEach((site) => expectSiteDto(site));
        expect(sorted[0].id).to.equal(SITE_1_ID);
        expect(sorted[1].id).to.equal(SITE_2_ID);
        expect(sorted[2].id).to.equal(SITE_3_ID);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/sites');
        expect(res.status).to.equal(403);
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
        // SITE_1 + SITE_3 are aem_edge; SITE_2 is aem_cs
        expect(res.body).to.be.an('array').with.lengthOf(2);
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
