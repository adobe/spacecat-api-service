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
 * End-to-end tests for the /serenity/* surface (LLMO-5190), driven against the
 * Semrush vendor MOCKS (Counterfact images from adobe/spacecat-shared, started
 * by the IT docker-compose). Two things make these reachable where the prior
 * IT suite could only assert 400/401:
 *
 *   1. Auth: the harness mints a NON-IMS (local JWT) token, which the serenity
 *      controller's `requireImsBearer` normally rejects (it forwards only IMS
 *      tokens upstream). The IT env sets `SERENITY_ALLOW_NON_IMS_AUTH=true`,
 *      which skips the IMS-type gate — sound ONLY because the Semrush mock does
 *      not validate the forwarded bearer (the token value never matters). No
 *      deployed environment sets that flag.
 *   2. Vendor: `SEMRUSH_PROJECTS_BASE_URL` / `SEMRUSH_USERS_BASE_URL` point at
 *      the two mock containers (api-service#2656 splits the User Manager origin
 *      so no path-routing proxy is needed); `NODE_TLS_REJECT_UNAUTHORIZED=0`
 *      trusts their self-signed certs.
 *
 * This increment covers the route gate, the IMS-only relaxation, and the
 * brand-INDEPENDENT catalog reads that flow all the way to the Project Engine
 * mock. The sub-workspace lifecycle (activate/deactivate, market create/delete)
 * mutates mock state and is the next increment — `resetSemrushMocks()` in
 * setup.js is wired for it.
 */
export default function serenityTests(getHttpClient, resetData) {
  // Seed the baseline org/brand rows the catalog + brand-resolution tests read.
  // (The route-gate cases fire before any DB access, but the org-level reads
  // need ORG_1 present.) Mirrors every other postgres factory.
  before(() => resetData());

  describe('Serenity API — route gate (fires before auth)', () => {
    it('400s on non-UUID spaceCatId', async () => {
      const res = await getHttpClient().admin.get(
        `/v2/orgs/not-a-uuid/brands/${BRAND_1_ID}/serenity/markets`,
      );
      expect(res.status).to.equal(400);
      expect(res.body.message || res.body).to.match(/Organization Id.*invalid/i);
    });

    it('400s on non-UUID brandId', async () => {
      const res = await getHttpClient().admin.get(
        `/v2/orgs/${ORG_1_ID}/brands/not-a-uuid/serenity/markets`,
      );
      expect(res.status).to.equal(400);
    });

    it('400s on non-UUID brandId for activate', async () => {
      const res = await getHttpClient().admin.post(
        `/v2/orgs/${ORG_1_ID}/brands/not-a-uuid/serenity/activate`,
        { brandDomain: 'example.com', brandNames: ['Example'], markets: [{ market: 'US', languageCode: 'en' }] },
      );
      expect(res.status).to.equal(400);
    });
  });

  describe('Serenity API — org-level catalog (live via Project Engine mock)', () => {
    // GET /v2/orgs/:org/serenity/models is brand/workspace-INDEPENDENT: it
    // authorizes at the org level and reads the global `GET /v1/ai_models`
    // catalog from the Project Engine mock. A 200 here proves the full chain:
    // relaxed auth → org access → typed transport → HTTPS to the mock → parse.
    it('GET /serenity/models returns 200 with the global AI model catalog', async () => {
      const res = await getHttpClient().admin.get(`/v2/orgs/${ORG_1_ID}/serenity/models`);
      expect(res.status).to.equal(200);
      // The global catalog comes back as { items: [...] }; the mock's
      // workspace-with-data seed ships a non-empty model list.
      expect(res.body).to.be.an('object');
      expect(res.body.items).to.be.an('array').that.is.not.empty;
    });

    it('GET /serenity/languages returns 200 with the language catalog', async () => {
      const res = await getHttpClient().admin.get(`/v2/orgs/${ORG_1_ID}/serenity/languages`);
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('object');
    });
  });

  describe('Serenity API — relaxed auth reaches the handler', () => {
    // Before SERENITY_ALLOW_NON_IMS_AUTH the harness's JWT deterministically
    // 401'd at requireImsBearer. With the flag, the same call now passes auth
    // and proceeds to brand resolution: an unknown brand under an accessible org
    // resolves to 404 (NOT 401), proving the relaxed path reaches the handler.
    it('brand-level GET markets returns 404 for an unknown brand (not 401)', async () => {
      const unknownBrand = '99999999-9999-4999-b999-999999999999';
      const res = await getHttpClient().admin.get(
        `/v2/orgs/${ORG_1_ID}/brands/${unknownBrand}/serenity/markets`,
      );
      expect(res.status).to.equal(404);
    });
  });
}
