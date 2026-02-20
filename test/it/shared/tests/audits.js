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
import {
  SITE_1_ID,
  SITE_3_ID,
  NON_EXISTENT_SITE_ID,
  AUDIT_TYPE_CWV,
  AUDIT_TYPE_APEX,
  AUDIT_1_AUDITED_AT,
  AUDIT_2_AUDITED_AT,
  AUDIT_3_AUDITED_AT,
  AUDIT_4_AUDITED_AT,
} from '../seed-ids.js';

/**
 * Asserts that an object has the AuditDto shape.
 * Note: Audit DTO has NO id, createdAt, or updatedAt fields.
 */
function expectAuditDto(audit) {
  expect(audit).to.be.an('object');
  expect(audit.siteId).to.be.a('string');
  expect(audit.auditType).to.be.a('string');
  expect(audit.auditedAt).to.be.a('string');
  expect(audit.fullAuditRef).to.be.a('string');
  expect(audit).to.have.property('isLive');
  expect(audit).to.have.property('isError');
  expect(audit).to.have.property('auditResult');
}

/**
 * Shared Audit & LatestAudit endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * All tests are read-only (PATCH config mutation deferred to Tier 2).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function auditTests(getHttpClient, resetData) {
  describe('Audits', () => {
    before(() => resetData());

    // ── Audit endpoints ──

    describe('GET /sites/:siteId/audits', () => {
      it('user: returns audits for accessible site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/audits`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(3);
        res.body.forEach((audit) => expectAuditDto(audit));

        // Verify all expected audits are present (order varies by backend)
        const timestamps = res.body.map((a) => a.auditedAt).sort();
        expect(timestamps).to.deep.equal([
          AUDIT_1_AUDITED_AT,
          AUDIT_3_AUDITED_AT,
          AUDIT_2_AUDITED_AT,
        ].sort());
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/audits`);
        expect(res.status).to.equal(403);
      });

      it('admin: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${NON_EXISTENT_SITE_ID}/audits`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites/not-a-uuid/audits');
        expect(res.status).to.equal(400);
      });
    });

    describe('GET /sites/:siteId/audits/:auditType', () => {
      it('user: returns audits filtered by type', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/audits/${AUDIT_TYPE_CWV}`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        res.body.forEach((audit) => {
          expectAuditDto(audit);
          expect(audit.auditType).to.equal(AUDIT_TYPE_CWV);
        });

        // Sorted descending by auditedAt
        expect(res.body[0].auditedAt).to.equal(AUDIT_2_AUDITED_AT);
        expect(res.body[1].auditedAt).to.equal(AUDIT_1_AUDITED_AT);
      });

      it('user: returns empty array for type with no audits', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/audits/sitemap`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/audits/${AUDIT_TYPE_CWV}`);
        expect(res.status).to.equal(403);
      });
    });

    describe('GET /sites/:siteId/audits/:auditType/:auditedAt', () => {
      it('user: returns specific audit', async () => {
        const http = getHttpClient();
        const res = await http.user.get(
          `/sites/${SITE_1_ID}/audits/${AUDIT_TYPE_CWV}/${AUDIT_2_AUDITED_AT}`,
        );
        expect(res.status).to.equal(200);
        expectAuditDto(res.body);
        expect(res.body.siteId).to.equal(SITE_1_ID);
        expect(res.body.auditType).to.equal(AUDIT_TYPE_CWV);
        expect(res.body.auditedAt).to.equal(AUDIT_2_AUDITED_AT);
        expect(res.body.isLive).to.equal(true);
        expect(res.body.isError).to.equal(false);

        // Enriched field — exercises invocationId↔invocation_id conversion
        expect(res.body.invocationId).to.equal('inv-20250120-site1-cwv');
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(
          `/sites/${SITE_3_ID}/audits/${AUDIT_TYPE_CWV}/2025-01-17T10:00:00.000Z`,
        );
        expect(res.status).to.equal(403);
      });

      it('admin: returns 404 for non-existent audit', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/sites/${SITE_1_ID}/audits/${AUDIT_TYPE_CWV}/2099-01-01T00:00:00.000Z`,
        );
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/sites/not-a-uuid/audits/${AUDIT_TYPE_CWV}/${AUDIT_2_AUDITED_AT}`,
        );
        expect(res.status).to.equal(400);
      });
    });

    // ── LatestAudit endpoints ──

    describe('GET /audits/latest/:auditType', () => {
      it('admin: returns latest audits by type', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/audits/latest/${AUDIT_TYPE_CWV}`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        res.body.forEach((audit) => {
          expectAuditDto(audit);
          expect(audit.auditType).to.equal(AUDIT_TYPE_CWV);
        });

        // Verify "latest per site" semantics — must be the newest cwv per site
        const site1Latest = res.body.find((a) => a.siteId === SITE_1_ID);
        expect(site1Latest.auditedAt).to.equal(AUDIT_2_AUDITED_AT);

        const site3Latest = res.body.find((a) => a.siteId === SITE_3_ID);
        expect(site3Latest.auditedAt).to.equal(AUDIT_4_AUDITED_AT);
      });

      it('user: returns 403', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/audits/latest/${AUDIT_TYPE_CWV}`);
        expect(res.status).to.equal(403);
      });
    });

    describe('GET /sites/:siteId/audits/latest', () => {
      it('user: returns latest audits for accessible site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/audits/latest`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        res.body.forEach((audit) => expectAuditDto(audit));

        // One latest per audit type: cwv and apex
        const types = res.body.map((a) => a.auditType).sort();
        expect(types).to.deep.equal([AUDIT_TYPE_APEX, AUDIT_TYPE_CWV]);

        // Verify the latest cwv is A2 (Jan 20), not A1 (Jan 15)
        const latestCwv = res.body.find((a) => a.auditType === AUDIT_TYPE_CWV);
        expect(latestCwv.auditedAt).to.equal(AUDIT_2_AUDITED_AT);

        // Verify the latest apex is A3 (Jan 18, only one)
        const latestApex = res.body.find((a) => a.auditType === AUDIT_TYPE_APEX);
        expect(latestApex.auditedAt).to.equal(AUDIT_3_AUDITED_AT);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/audits/latest`);
        expect(res.status).to.equal(403);
      });

      it('admin: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${NON_EXISTENT_SITE_ID}/audits/latest`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites/not-a-uuid/audits/latest');
        expect(res.status).to.equal(400);
      });
    });

    describe('GET /sites/:siteId/latest-audit/:auditType', () => {
      it('user: returns latest audit for type', async () => {
        const http = getHttpClient();
        const res = await http.user.get(
          `/sites/${SITE_1_ID}/latest-audit/${AUDIT_TYPE_CWV}`,
        );
        expect(res.status).to.equal(200);
        expectAuditDto(res.body);
        expect(res.body.siteId).to.equal(SITE_1_ID);
        expect(res.body.auditType).to.equal(AUDIT_TYPE_CWV);
        expect(res.body.auditedAt).to.equal(AUDIT_2_AUDITED_AT);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(
          `/sites/${SITE_3_ID}/latest-audit/${AUDIT_TYPE_CWV}`,
        );
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for type with no audits', async () => {
        const http = getHttpClient();
        const res = await http.user.get(
          `/sites/${SITE_1_ID}/latest-audit/sitemap`,
        );
        expect(res.status).to.equal(404);
      });
    });
  });
}
