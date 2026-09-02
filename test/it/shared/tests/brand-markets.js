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
  ORG_1_ID, ORG_2_ID, BRAND_1_ID, NON_EXISTENT_BRAND_ID,
} from '../seed-ids.js';

/**
 * Shared IT for GET /v2/orgs/:spaceCatId/brands/:brandId/markets — the S2S read
 * of a brand's Serenity markets straight from `brand_to_semrush_projects`.
 *
 * The seeded fixture (seed-data/brand-semrush-projects.js) gives BRAND_1 three
 * rows: a live whole-country market (India), a soft-deleted market, and a live
 * market whose geoTargetId is not a whole country. Only the first should ever
 * reach the response.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 * @param {() => Promise<void>} seedFixture - Seeds the brand_to_semrush_projects fixture
 *   (kept out of the baseline so other suites' BRAND_1 mapping-row counts are unaffected)
 */
export default function brandMarketsTests(getHttpClient, resetData, seedFixture) {
  describe('Brand markets (S2S) — GET /v2/orgs/:spaceCatId/brands/:brandId/markets', () => {
    beforeEach(async () => {
      await resetData();
      await seedFixture();
    });

    it('returns only the live whole-country market, excluding soft-deleted and non-country rows', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/markets`);

      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({
        markets: [{ region: 'IN', languageCode: 'en', geoTargetId: 2356 }],
      });
    });

    it('returns an empty list for a brand with no mapping rows', async () => {
      const http = getHttpClient();

      // A fresh pending brand, created with no markets.
      const create = await http.admin.post(`/v2/orgs/${ORG_1_ID}/brands`, {
        name: 'No Markets Brand', region: ['US'], status: 'pending',
      });
      expect(create.status).to.equal(201);

      const res = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/${create.body.id}/markets`);
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ markets: [] });
    });

    it('returns 404 for a brand that does not belong to the organization', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/${NON_EXISTENT_BRAND_ID}/markets`);
      expect(res.status).to.equal(404);
    });

    it('returns 400 for a non-UUID spaceCatId', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/v2/orgs/not-a-uuid/brands/${BRAND_1_ID}/markets`);
      expect(res.status).to.equal(400);
    });

    it('user: returns 403 for a brand in a denied organization', async () => {
      const http = getHttpClient();
      const res = await http.user.get(`/v2/orgs/${ORG_2_ID}/brands/${BRAND_1_ID}/markets`);
      expect(res.status).to.equal(403);
    });
  });
}
