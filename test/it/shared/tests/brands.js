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
  BRAND_1_ID,
  SITE_2_ID,
  SITE_2_BASE_URL,
  MARKET_SITE_1_ID,
  MARKET_SITE_1_BASE_URL,
} from '../seed-ids.js';

export default function brandsTests(getHttpClient, resetData) {
  describe('Brands v2 claims guidance', () => {
    before(() => resetData());

    it('creates, returns, preserves, and clears brand guidance fields', async () => {
      const http = getHttpClient();

      const createRes = await http.admin.post(
        `/v2/orgs/${ORG_1_ID}/brands`,
        {
          name: 'Claims Guidance Brand',
          brandContext: '  Context for claims extraction  ',
          mentionSentimentGuidance: '  Sentiment guidance text  ',
          region: ['US'],
        },
      );
      expect(createRes.status).to.equal(201);
      expect(createRes.body.brandContext).to.equal('Context for claims extraction');
      expect(createRes.body.mentionSentimentGuidance).to.equal('Sentiment guidance text');
      const { id: brandId } = createRes.body;

      const getRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/${brandId}`);
      expect(getRes.status).to.equal(200);
      expect(getRes.body.brandContext).to.equal('Context for claims extraction');
      expect(getRes.body.mentionSentimentGuidance).to.equal('Sentiment guidance text');

      const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands`);
      expect(listRes.status).to.equal(200);
      const listed = listRes.body.brands.find((brand) => brand.id === brandId);
      expect(listed.brandContext).to.equal('Context for claims extraction');
      expect(listed.mentionSentimentGuidance).to.equal('Sentiment guidance text');

      const preserveRes = await http.admin.patch(
        `/v2/orgs/${ORG_1_ID}/brands/${brandId}`,
        { description: 'Updated without guidance fields' },
      );
      expect(preserveRes.status).to.equal(200);
      expect(preserveRes.body.brandContext).to.equal('Context for claims extraction');
      expect(preserveRes.body.mentionSentimentGuidance).to.equal('Sentiment guidance text');

      const clearRes = await http.admin.patch(
        `/v2/orgs/${ORG_1_ID}/brands/${brandId}`,
        {
          brandContext: null,
          mentionSentimentGuidance: '   ',
        },
      );
      expect(clearRes.status).to.equal(200);
      expect(clearRes.body.brandContext).to.equal(null);
      expect(clearRes.body.mentionSentimentGuidance).to.equal(null);
    });

    it('rejects invalid brand guidance payloads', async () => {
      const http = getHttpClient();

      const wrongType = await http.admin.post(
        `/v2/orgs/${ORG_1_ID}/brands`,
        { name: 'Bad Claims Guidance Brand', brandContext: { value: 'wrong' } },
      );
      expect(wrongType.status).to.equal(400);

      const tooLong = await http.admin.post(
        `/v2/orgs/${ORG_1_ID}/brands`,
        {
          name: 'Long Claims Guidance Brand',
          mentionSentimentGuidance: 'x'.repeat(4001),
        },
      );
      expect(tooLong.status).to.equal(400);
    });
  });

  describe('Brands v2 aliases (regions) + competitors (aliases) round-trip', () => {
    before(() => resetData());

    it('persists brand-alias regions and competitor aliases through create, GET, and PATCH', async () => {
      const http = getHttpClient();

      // Flat-mode brand (no semrushMarket → no sub-workspace), so PATCH exercises
      // the data layer without triggering the upstream Semrush re-sync.
      const createRes = await http.admin.post(`/v2/orgs/${ORG_1_ID}/brands`, {
        name: 'Aliases Roundtrip Brand',
        region: ['us', 'de'],
        brandAliases: [
          { name: 'Acme', regions: [] },
          { name: 'Acme DE', regions: ['de'] },
        ],
        competitors: [
          {
            name: 'Rival', url: 'https://rival.com', aliases: ['Rival Inc', 'RVL'], regions: ['us'],
          },
        ],
      });
      expect(createRes.status).to.equal(201);
      const { id: brandId } = createRes.body;
      expect(createRes.body.brandAliases).to.have.deep.members([
        { name: 'Acme', regions: [] },
        { name: 'Acme DE', regions: ['de'] },
      ]);
      expect(createRes.body.competitors).to.deep.equal([
        {
          name: 'Rival', url: 'https://rival.com', aliases: ['Rival Inc', 'RVL'], regions: ['us'],
        },
      ]);

      const getRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/${brandId}`);
      expect(getRes.status).to.equal(200);
      expect(getRes.body.competitors[0].aliases).to.deep.equal(['Rival Inc', 'RVL']);
      const acmeDe = getRes.body.brandAliases.find((a) => a.name === 'Acme DE');
      expect(acmeDe.regions).to.deep.equal(['de']);

      // PATCH (full-replace) the competitor aliases and an alias's regions.
      const patchRes = await http.admin.patch(`/v2/orgs/${ORG_1_ID}/brands/${brandId}`, {
        brandAliases: [{ name: 'Acme', regions: ['us'] }],
        competitors: [
          {
            name: 'Rival', url: 'https://rival.com', aliases: ['Rival Worldwide'], regions: ['us'],
          },
        ],
      });
      expect(patchRes.status).to.equal(200);
      expect(patchRes.body.brandAliases).to.deep.equal([{ name: 'Acme', regions: ['us'] }]);
      expect(patchRes.body.competitors).to.deep.equal([
        {
          name: 'Rival', url: 'https://rival.com', aliases: ['Rival Worldwide'], regions: ['us'],
        },
      ]);
      // Flat-mode brand → no Semrush re-sync → no rejected-alias surface.
      expect(patchRes.body).to.not.have.property('semrushRejectedAliases');
    });
  });

  describe('Brands v2 Serenity market-mirror linkage', () => {
    before(() => resetData());

    it('excludes the Serenity market-mirror site from the brand urls[] and siteIds', async () => {
      const http = getHttpClient();

      // BRAND_1 is linked to the market-mirror Site (MARKET_SITE_1) via a
      // brand_sites row tagged type='serenity'. The market's domain is NOT a
      // brand URL (the brand is a shell with no domain of its own), so the row
      // is a pure backend linkage and must not surface in the brand response.
      const getRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}`);
      expect(getRes.status).to.equal(200);

      expect(getRes.body.siteIds || []).to.not.include(MARKET_SITE_1_ID);
      const urlValues = (getRes.body.urls || []).map((u) => u.value);
      expect(urlValues).to.not.include(MARKET_SITE_1_BASE_URL);

      // The same exclusion must hold on the list endpoint.
      const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands`);
      expect(listRes.status).to.equal(200);
      const listed = listRes.body.brands.find((brand) => brand.id === BRAND_1_ID);
      expect(listed).to.be.an('object');
      expect(listed.siteIds || []).to.not.include(MARKET_SITE_1_ID);
      const listedUrlValues = (listed.urls || []).map((u) => u.value);
      expect(listedUrlValues).to.not.include(MARKET_SITE_1_BASE_URL);
    });
  });

  describe('Brands v2 pending-brand primary URL: unset + reuse (LLMO-5870)', () => {
    before(() => resetData());

    it('clears a pending brand baseSiteId so the freed site can be reused by another brand', async () => {
      const http = getHttpClient();

      // 1. A brand with no anchor (no baseSiteId / no Semrush) is created pending.
      const createA = await http.admin.post(`/v2/orgs/${ORG_1_ID}/brands`, {
        name: 'Pending URL Holder', region: ['US'],
      });
      expect(createA.status).to.equal(201);
      expect(createA.body.status).to.equal('pending');
      const brandAId = createA.body.id;
      expect(createA.body.baseSiteId == null).to.equal(true);

      // 2. Setting the primary site on a pending brand (NULL -> value) is allowed
      //    and leaves the brand pending.
      const setA = await http.admin.patch(`/v2/orgs/${ORG_1_ID}/brands/${brandAId}`, {
        baseSiteId: SITE_2_ID,
      });
      expect(setA.status).to.equal(200);
      expect(setA.body.baseSiteId).to.equal(SITE_2_ID);
      expect(setA.body.baseUrl).to.equal(SITE_2_BASE_URL);
      expect(setA.body.status).to.equal('pending');

      // 3. A second pending brand cannot claim the same site while A holds it.
      const createB = await http.admin.post(`/v2/orgs/${ORG_1_ID}/brands`, {
        name: 'Wants Same URL', region: ['US'],
      });
      expect(createB.status).to.equal(201);
      const brandBId = createB.body.id;
      const conflict = await http.admin.patch(`/v2/orgs/${ORG_1_ID}/brands/${brandBId}`, {
        baseSiteId: SITE_2_ID,
      });
      expect(conflict.status).to.equal(409);

      // 4. Clearing brand A's primary URL (pending -> baseSiteId: null) frees the site.
      const clearA = await http.admin.patch(`/v2/orgs/${ORG_1_ID}/brands/${brandAId}`, {
        baseSiteId: null,
      });
      expect(clearA.status).to.equal(200);
      expect(clearA.body.baseSiteId == null).to.equal(true);
      expect(clearA.body.baseUrl == null).to.equal(true);
      expect(clearA.body.status).to.equal('pending');

      // 5. Brand B can now reuse the freed site.
      const reuse = await http.admin.patch(`/v2/orgs/${ORG_1_ID}/brands/${brandBId}`, {
        baseSiteId: SITE_2_ID,
      });
      expect(reuse.status).to.equal(200);
      expect(reuse.body.baseSiteId).to.equal(SITE_2_ID);
    });
  });
}
