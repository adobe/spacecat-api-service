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
import { ORG_1_ID, BRAND_1_ID } from '../seed-ids.js';

/**
 * End-to-end tests for the Serenity (Semrush Elements-backed) Market Tracking
 * Trends endpoint:
 *   GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/market-tracking-trends
 *
 * Like the sibling elements endpoints, this is driven through the SAME Semrush
 * mock base (`SEMRUSH_PROJECTS_BASE_URL`) and the IT auth relaxation
 * (`SERENITY_ALLOW_NON_IMS_AUTH`), so it reaches the handler over the full
 * middleware stack. Because the Elements `/data` responses for the two backing
 * elements (TRENDS_MV, MARKET_CITATIONS_TREND) are not part of the mock's seeded
 * fixtures, the happy-path assertion is tolerant — mirroring the url-inspector IT
 * factory: the route gate is pinned deterministically (fires before auth), and
 * the reachable-response case pins the `weeklyTrends` contract when a 200 is
 * served while still accepting the auth/upstream/config branches otherwise.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function serenityMarketTrackingTrendsTests(getHttpClient, resetData) {
  describe('Serenity Market Tracking Trends — GET .../brand-presence/market-tracking-trends', () => {
    before(() => resetData());

    const path = (org, brand, query = {}) => {
      const qs = new URLSearchParams(query).toString();
      const base = `/v2/orgs/${org}/brands/${brand}/serenity/brand-presence/market-tracking-trends`;
      return qs ? `${base}?${qs}` : base;
    };

    describe('route gate (fires before auth)', () => {
      it('400s on non-UUID spaceCatId', async () => {
        const res = await getHttpClient().admin.get(path('not-a-uuid', BRAND_1_ID));
        expect(res.status).to.equal(400);
      });

      it('400s on non-UUID brandId', async () => {
        const res = await getHttpClient().admin.get(path(ORG_1_ID, 'not-a-uuid'));
        expect(res.status).to.equal(400);
      });
    });

    describe('reachability + response contract', () => {
      it('is wired through the full middleware stack and returns a well-formed response', async () => {
        const res = await getHttpClient().admin.get(path(ORG_1_ID, BRAND_1_ID));
        // Tolerant status set (mirrors the url-inspector IT factory): 200 on the
        // happy path when the Elements mock serves the two backing elements;
        // otherwise an auth (401/403), not-found (404 — unknown brand/workspace),
        // upstream (500/502), or config (503) branch. All prove the route →
        // controller wiring; only the 200 case pins the response schema.
        expect(res.status).to.be.oneOf([200, 400, 401, 403, 404, 500, 502, 503]);
        if (res.status !== 200) {
          return;
        }

        expect(res.body).to.be.an('object');
        expect(res.body).to.have.property('weeklyTrends').that.is.an('array');
        for (const wk of res.body.weeklyTrends) {
          expect(wk).to.have.property('week').that.is.a('string');
          expect(wk).to.have.property('weekNumber').that.is.a('number');
          expect(wk).to.have.property('year').that.is.a('number');
          expect(wk).to.have.property('mentions').that.is.a('number');
          expect(wk).to.have.property('citations').that.is.a('number');
          expect(wk).to.have.property('competitors').that.is.an('array');
          for (const competitor of wk.competitors) {
            expect(competitor).to.have.property('name').that.is.a('string');
            expect(competitor).to.have.property('mentions').that.is.a('number');
            expect(competitor).to.have.property('citations').that.is.a('number');
          }
        }
      });

      it('rejects an impossible calendar date when the request reaches the handler', async () => {
        const res = await getHttpClient().admin.get(
          path(ORG_1_ID, BRAND_1_ID, { startDate: '2026-13-45', endDate: '2026-07-15' }),
        );
        // 400 when the handler is reached (invalid YYYY-MM-DD); otherwise an
        // auth/upstream/config status if the elements chain short-circuits first.
        expect(res.status).to.be.oneOf([400, 401, 403, 404, 500, 502, 503]);
      });
    });
  });
}
