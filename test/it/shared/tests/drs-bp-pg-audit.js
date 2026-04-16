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

const VALID_SITE_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const VALID_PATH = `/monitoring/drs-bp-pg-audit?siteId=${VALID_SITE_ID}&dateStart=2026-04-14&dateEnd=2026-04-15`;

/**
 * Integration tests for GET /monitoring/drs-bp-pg-audit.
 *
 * These tests cover auth rejection and input validation. They do not require the
 * projection_audit table to exist — validation errors are returned before PostgREST
 * is queried.
 *
 * @param {() => object} getHttpClient - Returns the initialized HTTP client with auth personas
 */
export default function drsBpPgAuditTests(getHttpClient) {
  describe('GET /monitoring/drs-bp-pg-audit', () => {
    // ── Auth ──

    it('returns 401 when no auth header is provided', async () => {
      const http = getHttpClient();
      // Pass Authorization: null to strip the default Bearer token
      const res = await http.admin.get(VALID_PATH, { Authorization: null });
      expect(res.status).to.equal(401);
    });

    // ── Input validation — required params ──

    it('admin: returns 400 when siteId is missing', async () => {
      const http = getHttpClient();
      const res = await http.admin.get('/monitoring/drs-bp-pg-audit?dateStart=2026-04-14&dateEnd=2026-04-15');
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when siteId is not a valid UUID', async () => {
      const http = getHttpClient();
      const res = await http.admin.get('/monitoring/drs-bp-pg-audit?siteId=not-a-uuid&dateStart=2026-04-14&dateEnd=2026-04-15');
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when dateStart is missing', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/monitoring/drs-bp-pg-audit?siteId=${VALID_SITE_ID}&dateEnd=2026-04-15`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when dateStart has invalid format', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/monitoring/drs-bp-pg-audit?siteId=${VALID_SITE_ID}&dateStart=14-04-2026&dateEnd=2026-04-15`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when dateEnd is missing', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/monitoring/drs-bp-pg-audit?siteId=${VALID_SITE_ID}&dateStart=2026-04-14`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when dateEnd has invalid format', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/monitoring/drs-bp-pg-audit?siteId=${VALID_SITE_ID}&dateStart=2026-04-14&dateEnd=April-15-2026`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when dateEnd is not after dateStart', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/monitoring/drs-bp-pg-audit?siteId=${VALID_SITE_ID}&dateStart=2026-04-15&dateEnd=2026-04-14`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when dateEnd equals dateStart', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/monitoring/drs-bp-pg-audit?siteId=${VALID_SITE_ID}&dateStart=2026-04-14&dateEnd=2026-04-14`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 for semantically impossible date', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/monitoring/drs-bp-pg-audit?siteId=${VALID_SITE_ID}&dateStart=2026-13-45&dateEnd=2026-04-15`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when date range exceeds 90 days', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/monitoring/drs-bp-pg-audit?siteId=${VALID_SITE_ID}&dateStart=2026-01-01&dateEnd=2026-06-01`);
      expect(res.status).to.equal(400);
    });

    it('admin: returns 400 when handlerName has invalid characters', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/monitoring/drs-bp-pg-audit?siteId=${VALID_SITE_ID}&dateStart=2026-04-14&dateEnd=2026-04-15&handlerName=DROP%20TABLE`);
      expect(res.status).to.equal(400);
    });
  });
}
