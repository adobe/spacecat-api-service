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
} from '../seed-ids.js';

const BASE = `/sites/${SITE_1_ID}/top-pages`;
const DENIED_BASE = `/sites/${SITE_3_ID}/top-pages`;

/**
 * Shared SiteTopPage endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * Note: SiteTopPage has no DTO — controller returns raw model objects.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function siteTopPageTests(getHttpClient, resetData) {
  describe('SiteTopPages', () => {
    describe('GET /sites/:siteId/top-pages', () => {
      before(() => resetData());

      it('user: returns all top pages for site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(BASE);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(DENIED_BASE);
        expect(res.status).to.equal(403);
      });
    });

    describe('GET /sites/:siteId/top-pages/:source', () => {
      before(() => resetData());

      it('user: returns top pages filtered by source', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/ahrefs`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);
      });

      it('user: returns empty for source with no matches', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/google`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 403 for denied site with source', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${DENIED_BASE}/ahrefs`);
        expect(res.status).to.equal(403);
      });
    });

    describe('GET /sites/:siteId/top-pages/:source/:geo', () => {
      before(() => resetData());

      it('user: returns top pages filtered by source and geo', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/rum/us`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(1);
      });

      it('user: returns empty for source+geo with no matches', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/ahrefs/us`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });
    });

    describe('GET /sites/:siteId/top-pages (error cases)', () => {
      before(() => resetData());

      it('user: returns 404 for non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${NON_EXISTENT_SITE_ID}/top-pages`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/sites/not-a-uuid/top-pages');
        expect(res.status).to.equal(400);
      });
    });
  });
}
