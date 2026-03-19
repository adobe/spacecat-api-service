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
import { expectISOTimestamp, expectBatch201 } from '../helpers/assertions.js';
import {
  SITE_1_ID,
  SITE_2_ID,
  SITE_3_ID,
  AUDIT_URL_1,
  AUDIT_URL_2,
  AUDIT_URL_3,
} from '../seed-ids.js';

/**
 * Encodes a URL to base64url (RFC 4648 §5) for path parameter use.
 */
function urlToBase64(url) {
  return Buffer.from(url).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Asserts that an object has the AuditUrlDto shape.
 */
function expectAuditUrlDto(auditUrl) {
  expect(auditUrl).to.be.an('object');
  expect(auditUrl.siteId).to.be.a('string');
  expect(auditUrl.url).to.be.a('string');
  expect(auditUrl.byCustomer).to.be.a('boolean');
  // v2 (ElectroDB) may return null instead of [] for empty audits
  expect(auditUrl.audits == null || Array.isArray(auditUrl.audits)).to.be.true;
  expectISOTimestamp(auditUrl.createdAt, 'createdAt');
  expectISOTimestamp(auditUrl.updatedAt, 'updatedAt');
}

/**
 * Asserts a paginated response envelope.
 */
function expectPaginated(res, expectedItemCount) {
  expect(res.status).to.equal(200);
  expect(res.body).to.be.an('object');
  expect(res.body.items).to.be.an('array').with.lengthOf(expectedItemCount);
  expect(res.body.pagination).to.be.an('object');
  expect(res.body.pagination.limit).to.be.a('number');
  expect(res.body.pagination.hasMore).to.be.a('boolean');
}

/**
 * Shared Audit URL (url-store) endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function auditUrlTests(getHttpClient, resetData) {
  describe('Audit URLs (url-store)', () => {
    // ── List URLs ──

    describe('GET /sites/:siteId/url-store', () => {
      before(() => resetData());

      it('user: returns customer URLs by default (byCustomer=true)', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/url-store`);
        expectPaginated(res, 2); // URL_1 and URL_2 are byCustomer=true
        res.body.items.forEach((u) => {
          expectAuditUrlDto(u);
          expect(u.byCustomer).to.be.true;
        });
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/url-store`);
        expect(res.status).to.equal(403);
      });

      it('user: returns empty for site with no URLs', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_2_ID}/url-store`);
        expectPaginated(res, 0);
      });
    });

    // ── List by audit type ──

    describe('GET /sites/:siteId/url-store/by-audit/:auditType', () => {
      before(() => resetData());

      it('user: returns URLs with matching audit type', async () => {
        const http = getHttpClient();
        // URL_1 (cwv+apex) and URL_3 (cwv) both have 'cwv'
        const res = await http.user.get(`/sites/${SITE_1_ID}/url-store/by-audit/cwv`);
        expectPaginated(res, 2);
      });

      it('user: returns empty for unmatched audit type', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/url-store/by-audit/nonexistent-audit`);
        expectPaginated(res, 0);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/url-store/by-audit/cwv`);
        expect(res.status).to.equal(403);
      });
    });

    // ── Get URL by base64 ──

    describe('GET /sites/:siteId/url-store/:base64Url', () => {
      before(() => resetData());

      it('user: returns specific URL via base64', async () => {
        const http = getHttpClient();
        const encoded = urlToBase64(AUDIT_URL_1);
        const res = await http.user.get(`/sites/${SITE_1_ID}/url-store/${encoded}`);
        expect(res.status).to.equal(200);
        expectAuditUrlDto(res.body);
        expect(res.body.url).to.equal(AUDIT_URL_1);
        expect(res.body.byCustomer).to.be.true;
        expect(res.body.audits).to.include('cwv');
        expect(res.body.audits).to.include('apex');
      });

      it('user: returns 404 for non-existent URL', async () => {
        const http = getHttpClient();
        const encoded = urlToBase64('https://site1.example.com/does-not-exist');
        const res = await http.user.get(`/sites/${SITE_1_ID}/url-store/${encoded}`);
        expect(res.status).to.equal(404);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const encoded = urlToBase64(AUDIT_URL_1);
        const res = await http.user.get(`/sites/${SITE_3_ID}/url-store/${encoded}`);
        expect(res.status).to.equal(403);
      });
    });

    // ── Add URLs ──

    describe('POST /sites/:siteId/url-store', () => {
      before(() => resetData());

      it('user: creates new URL', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/url-store`, [
          { url: 'https://site1.example.com/new-page', audits: ['cwv'] },
        ]);
        expectBatch201(res, 1);
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.items).to.have.lengthOf(1);
        expectAuditUrlDto(res.body.items[0]);
        expect(res.body.items[0].url).to.equal('https://site1.example.com/new-page');
      });

      it('user: upserts existing URL', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/url-store`, [
          { url: AUDIT_URL_1, audits: ['apex'] },
        ]);
        expectBatch201(res, 1);
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.items).to.have.lengthOf(1);
        expect(res.body.items[0].audits).to.deep.equal(['apex']);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_3_ID}/url-store`, [
          { url: 'https://example.com/denied', audits: ['cwv'] },
        ]);
        expect(res.status).to.equal(403);
      });

      it('user: returns 400 for non-array body', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/url-store`, { url: 'not-array' });
        expect(res.status).to.equal(400);
      });

      it('user: handles invalid URL in batch', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/url-store`, [
          { url: 'https://site1.example.com/valid-page', audits: ['cwv'] },
          { url: 'not-a-valid-url', audits: ['cwv'] },
        ]);
        expectBatch201(res, 2);
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.metadata.failure).to.equal(1);
        expect(res.body.failures).to.have.lengthOf(1);
      });
    });

    // ── Update URLs ──

    describe('PATCH /sites/:siteId/url-store', () => {
      before(() => resetData());

      it('user: updates URL audits', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_1_ID}/url-store`, [
          { url: AUDIT_URL_1, audits: ['apex', 'cwv', 'broken-backlinks'] },
        ]);
        expect(res.status).to.equal(200);
        expect(res.body.metadata.total).to.equal(1);
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.items).to.have.lengthOf(1);
        expect(res.body.items[0].audits).to.include('broken-backlinks');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_3_ID}/url-store`, [
          { url: 'https://example.com', audits: ['cwv'] },
        ]);
        expect(res.status).to.equal(403);
      });

      it('user: returns 400 for non-array body', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_1_ID}/url-store`, { url: 'not-array' });
        expect(res.status).to.equal(400);
      });

      it('user: handles not-found URL', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/sites/${SITE_1_ID}/url-store`, [
          { url: 'https://site1.example.com/does-not-exist', audits: ['cwv'] },
        ]);
        expect(res.status).to.equal(200);
        expect(res.body.metadata.failure).to.equal(1);
        expect(res.body.failures).to.have.lengthOf(1);
      });
    });

    // ── Delete URLs ──

    describe('POST /sites/:siteId/url-store/delete', () => {
      before(() => resetData());

      it('user: deletes customer-added URL', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/url-store/delete`, {
          urls: [AUDIT_URL_2],
        });
        expect(res.status).to.equal(200);
        expect(res.body.metadata.total).to.equal(1);
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.metadata.failure).to.equal(0);
      });

      it('user: fails to delete system-added URL', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/url-store/delete`, {
          urls: [AUDIT_URL_3], // byCustomer=false
        });
        expect(res.status).to.equal(200);
        expect(res.body.metadata.total).to.equal(1);
        expect(res.body.metadata.success).to.equal(0);
        expect(res.body.metadata.failure).to.equal(1);
        expect(res.body.failures).to.have.lengthOf(1);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_3_ID}/url-store/delete`, {
          urls: ['https://example.com'],
        });
        expect(res.status).to.equal(403);
      });

      it('user: returns 400 for non-array body', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/url-store/delete`, {
          urls: 'not-an-array',
        });
        expect(res.status).to.equal(400);
      });

      it('user: returns 400 for empty array', async () => {
        const http = getHttpClient();
        const res = await http.user.post(`/sites/${SITE_1_ID}/url-store/delete`, {
          urls: [],
        });
        expect(res.status).to.equal(400);
      });
    });
  });
}
