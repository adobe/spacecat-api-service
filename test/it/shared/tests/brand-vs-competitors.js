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
  ORG_1_ID,
  SITE_1_ID,
  SITE_3_ID,
  BRAND_1_ID,
  NON_EXISTENT_SITE_ID,
  BP_EXEC_DATE_1,
  BP_EXEC_DATE_2,
} from '../seed-ids.js';

/**
 * Shared Brand vs Competitors endpoint tests.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function brandVsCompetitorsTests(getHttpClient, resetData) {
  describe('Brand vs Competitors', () => {
    const basePath = `/org/${ORG_1_ID}/brands/all/brand-presence/brand-vs-competitors`;

    describe('GET /org/:spaceCatId/brands/all/brand-presence/brand-vs-competitors', () => {
      before(() => resetData());

      it('admin: returns 400 when siteId is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(basePath);
        expect(res.status).to.equal(400);
      });

      it('admin: returns 400 when siteId is not a valid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`${basePath}?siteId=not-a-uuid`);
        expect(res.status).to.equal(400);
      });

      it('admin: returns 403 when site does not belong to org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`${basePath}?siteId=${NON_EXISTENT_SITE_ID}`);
        expect(res.status).to.equal(403);
      });

      it('admin: returns competitor data for a valid site', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`${basePath}?siteId=${SITE_1_ID}`);
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('competitorData').that.is.an('array');
        expect(res.body.competitorData.length).to.be.greaterThan(0);

        const row = res.body.competitorData[0];
        expect(row).to.have.property('siteId', SITE_1_ID);
        expect(row).to.have.property('competitor').that.is.a('string');
        expect(row).to.have.property('totalMentions').that.is.a('number');
        expect(row).to.have.property('totalCitations').that.is.a('number');
        expect(row).to.have.property('executionDate').that.is.a('string');
        expect(row).to.have.property('categoryName').that.is.a('string');
        expect(row).to.have.property('regionCode').that.is.a('string');
      });

      it('admin: filters by date range', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `${basePath}?siteId=${SITE_1_ID}&startDate=${BP_EXEC_DATE_1}&endDate=${BP_EXEC_DATE_1}`,
        );
        expect(res.status).to.equal(200);
        // Only week 1 data — should not include week 2
        const dates = res.body.competitorData.map((r) => r.executionDate);
        expect(dates).to.include(BP_EXEC_DATE_1);
        expect(dates).to.not.include(BP_EXEC_DATE_2);
      });

      it('admin: filters by categoryName', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `${basePath}?siteId=${SITE_1_ID}&categoryName=PPC`,
        );
        expect(res.status).to.equal(200);
        res.body.competitorData.forEach((row) => {
          expect(row.categoryName).to.equal('PPC');
        });
      });

      it('admin: returns empty when no data matches', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `${basePath}?siteId=${SITE_1_ID}&startDate=2020-01-01&endDate=2020-01-31`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.competitorData).to.deep.equal([]);
      });
    });

    describe('GET with aggregate=true', () => {
      before(() => resetData());

      it('admin: rolls up across categoryName/regionCode', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `${basePath}?siteId=${SITE_1_ID}&aggregate=true&startDate=${BP_EXEC_DATE_1}&endDate=${BP_EXEC_DATE_1}`,
        );
        expect(res.status).to.equal(200);

        // Rival Corp appears in SEO and PPC for week 1 — should be rolled up
        const rival = res.body.competitorData.find((r) => r.competitor === 'Rival Corp');
        expect(rival).to.exist;
        // SEO: 10 mentions + PPC: 3 mentions = 13
        expect(rival.totalMentions).to.equal(13);
        // SEO: 1 citation + PPC: 1 citation = 2
        expect(rival.totalCitations).to.equal(2);

        // Aggregated rows should not have categoryName/regionCode
        expect(rival).to.not.have.property('categoryName');
        expect(rival).to.not.have.property('regionCode');
      });
    });

    describe('GET /org/:spaceCatId/brands/:brandId/brand-presence/brand-vs-competitors', () => {
      before(() => resetData());

      it('admin: filters by specific brandId', async () => {
        const http = getHttpClient();
        const brandPath = `/org/${ORG_1_ID}/brands/${BRAND_1_ID}/brand-presence/brand-vs-competitors`;
        const res = await http.admin.get(`${brandPath}?siteId=${SITE_1_ID}`);
        expect(res.status).to.equal(200);
        res.body.competitorData.forEach((row) => {
          expect(row.brandId).to.equal(BRAND_1_ID);
        });
      });
    });

    describe('Access control', () => {
      before(() => resetData());

      it('user: returns error for denied site (SITE_3)', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${basePath}?siteId=${SITE_3_ID}`);
        // User persona lacks LLMO product entitlement → rejected before site check
        expect(res.status).to.be.oneOf([400, 403]);
      });
    });
  });
}
