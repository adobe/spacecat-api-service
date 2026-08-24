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
  SITE_1_ID,
  SITE_2_ID,
  SITE_2_BASE_URL,
  SITE_3_ID, // belongs to ORG_2, not ORG_1 (seed-data/sites.js) — used for cross-org tests
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
          // SITES-49202: active brands now require a base site (site_id); a
          // URL-less create must be pending (matches the flat-mode idiom below).
          status: 'pending',
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
        // SITES-49202: URL-less create must be pending (active now needs site_id).
        status: 'pending',
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

      // 1. A pending brand with no baseSiteId. Created explicitly pending: in a
      //    serenity-active org every create is a Semrush create (LLMO-6405), so a
      //    bare active create would provision a sub-workspace and land active rather
      //    than falling back to the legacy no-anchor -> pending demotion.
      const createA = await http.admin.post(`/v2/orgs/${ORG_1_ID}/brands`, {
        name: 'Pending URL Holder', region: ['US'], status: 'pending',
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
        name: 'Wants Same URL', region: ['US'], status: 'pending',
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

  describe('Brands v2 rejects a cross-org baseSiteId (serenity-docs#346)', () => {
    before(() => resetData());

    it('rejects a fresh create anchored to another org\'s site', async () => {
      const http = getHttpClient();

      // SITE_3_ID belongs to ORG_2 (seed-data/sites.js) — anchoring an ORG_1
      // brand to it is exactly the org-ID mismatch signature the investigation
      // traced (a brand silently pointing at a different org's site).
      //
      // status: 'pending' defers ALL Semrush provisioning (see createBrandForOrg),
      // so this stays a plain flat-mode create regardless of ORG_1's serenity
      // rollout flag — the guard fires on the baseSiteId anchor check itself,
      // independent of that unrelated machinery.
      const res = await http.admin.post(`/v2/orgs/${ORG_1_ID}/brands`, {
        name: 'Cross-Org Anchor Attempt', region: ['US'], status: 'pending', baseSiteId: SITE_3_ID,
      });

      expect(res.status).to.equal(409);
      expect(res.body.code).to.equal('brand_site_org_mismatch');
    });

    it('rejects setting an existing pending brand\'s baseSiteId to another org\'s site', async () => {
      const http = getHttpClient();

      const create = await http.admin.post(`/v2/orgs/${ORG_1_ID}/brands`, {
        name: 'Pending Brand For Cross-Org Attempt', region: ['US'], status: 'pending',
      });
      expect(create.status).to.equal(201);
      const { id: brandId } = create.body;

      const res = await http.admin.patch(`/v2/orgs/${ORG_1_ID}/brands/${brandId}`, {
        baseSiteId: SITE_3_ID,
      });

      expect(res.status).to.equal(409);
      expect(res.body.code).to.equal('brand_site_org_mismatch');

      // The brand must be untouched — no partial write.
      const getRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/${brandId}`);
      expect(getRes.body.baseSiteId == null).to.equal(true);
    });
  });

  describe('Brands v2 delete frees the name for reuse (LLMO-6978)', () => {
    before(() => resetData());

    it('renames a deleted brand to {name}_deleted so the name can be recreated, indexing repeats', async () => {
      const http = getHttpClient();
      const NAME = 'Reusable Name Brand';

      // 1. Create a brand, then soft-delete it. Deleting must free the name by
      //    renaming the row to `${NAME}_deleted` (uq_brand_name_per_org spans
      //    deleted rows, so keeping the original name would block recreation).
      const createA = await http.admin.post(`/v2/orgs/${ORG_1_ID}/brands`, {
        name: NAME, region: ['US'], status: 'pending',
      });
      expect(createA.status).to.equal(201);
      const brandAId = createA.body.id;

      const deleteA = await http.admin.delete(`/v2/orgs/${ORG_1_ID}/brands/${brandAId}`);
      expect(deleteA.status).to.equal(204);

      // 2. Recreating a brand with the ORIGINAL name now succeeds (previously
      //    rejected by uq_brand_name_per_org) and yields a NEW brand id.
      const createB = await http.admin.post(`/v2/orgs/${ORG_1_ID}/brands`, {
        name: NAME, region: ['US'], status: 'pending',
      });
      expect(createB.status).to.equal(201);
      expect(createB.body.id).to.not.equal(brandAId);
      const brandBId = createB.body.id;

      // 3. Deleting the second same-named brand collides with the first deleted
      //    `${NAME}_deleted`, so it must take the `_deleted2` index (exercises the
      //    23505 retry path against the real per-org unique constraint).
      const deleteB = await http.admin.delete(`/v2/orgs/${ORG_1_ID}/brands/${brandBId}`);
      expect(deleteB.status).to.equal(204);

      // 4. The name is still free — a third create with the same name succeeds.
      const createC = await http.admin.post(`/v2/orgs/${ORG_1_ID}/brands`, {
        name: NAME, region: ['US'], status: 'pending',
      });
      expect(createC.status).to.equal(201);
      expect(createC.body.id).to.not.equal(brandAId);
      expect(createC.body.id).to.not.equal(brandBId);

      // 5. The two deleted rows carry the indexed `_deleted` names; the live list
      //    (which excludes deleted brands) shows exactly one brand with the name.
      const deletedList = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands?status=deleted`);
      expect(deletedList.status).to.equal(200);
      const deletedNames = deletedList.body.brands
        .filter((b) => b.name === `${NAME}_deleted` || b.name === `${NAME}_deleted2`)
        .map((b) => b.name)
        .sort();
      expect(deletedNames).to.deep.equal([`${NAME}_deleted`, `${NAME}_deleted2`]);

      const liveList = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands`);
      expect(liveList.status).to.equal(200);
      const liveWithName = liveList.body.brands.filter((b) => b.name === NAME);
      expect(liveWithName).to.have.lengthOf(1);
      expect(liveWithName[0].id).to.equal(createC.body.id);
    });
  });

  describe('Brands v2 primary-site re-point (serenity-docs#349)', () => {
    // Per-test reset: test 1 moves BRAND_1 off SITE_1, which test 2 relies on
    // still being BRAND_1's active primary.
    beforeEach(() => resetData());

    it('re-points an ACTIVE brand to a different free site (was immutable pre-#349)', async () => {
      const http = getHttpClient();

      // BRAND_1 is seeded ACTIVE, anchored to SITE_1. It carries only the legacy
      // semrush_workspace_id (NOT a sub-workspace pointer), so this is a flat-mode
      // re-point — no Semrush propagation, provable in the pure-PostgreSQL suite.
      const before = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}`);
      expect(before.status).to.equal(200);
      expect(before.body.status).to.equal('active');
      expect(before.body.baseSiteId).to.equal(SITE_1_ID);

      // SITE_2 is a free ORG_1 site (no active brand's primary). Re-point onto it.
      const repoint = await http.admin.patch(`/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}`, {
        baseSiteId: SITE_2_ID,
      });
      expect(repoint.status).to.equal(200);
      expect(repoint.body.baseSiteId).to.equal(SITE_2_ID);
      expect(repoint.body.baseUrl).to.equal(SITE_2_BASE_URL);
      expect(repoint.body.status).to.equal('active');
    });

    it('rejects re-pointing to a site already owned by another ACTIVE brand with 409 siteUrlTaken', async () => {
      const http = getHttpClient();

      // A fresh pending brand in ORG_1 that tries to claim SITE_1 — still the
      // seeded ACTIVE BRAND_1's primary — must be refused with the typed code the
      // frontend maps to a specific message.
      const create = await http.admin.post(`/v2/orgs/${ORG_1_ID}/brands`, {
        name: 'Wants An Active Brand Site', region: ['US'], status: 'pending',
      });
      expect(create.status).to.equal(201);
      const { id: brandId } = create.body;

      const res = await http.admin.patch(`/v2/orgs/${ORG_1_ID}/brands/${brandId}`, {
        baseSiteId: SITE_1_ID,
      });
      expect(res.status).to.equal(409);
      expect(res.body.code).to.equal('siteUrlTaken');

      // No partial write — the brand keeps its (absent) anchor.
      const getRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/${brandId}`);
      expect(getRes.body.baseSiteId == null).to.equal(true);
    });
  });
}
