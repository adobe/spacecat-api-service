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
 * Coverage in this suite:
 *   - Route gate (UUID validation, fires before auth).
 *   - The IMS-only relaxation reaching the handler (unknown brand → 404).
 *   - Brand-INDEPENDENT org catalog reads (models, languages) live via the mock.
 *   - Brand-level reads driven through SUB-WORKSPACE resolution: BRAND_1's
 *     `semrush_workspace_id` is aligned to the mock seed (SERENITY_MOCK_WORKSPACE_ID),
 *     so `GET models` / `GET markets` resolve a real workspace and read live data.
 *   - Every brand-level WRITE endpoint reaching its handler past auth + brand
 *     resolution and failing at body/slice validation (the deepest 2xx is blocked
 *     by the mock — see below), which still proves each route → controller wiring.
 *
 * Not covered (mock limitation, NOT a gap to fix here): the create/activate happy
 * paths. The Project Engine mock returns 406 on the project `publish` step, so
 * `POST markets` / `activate` cannot reach a 2xx against the pinned mock image —
 * the suite asserts their validation surface instead. A mock that implements
 * `publish` is the prerequisite for the create/lifecycle 2xx increment;
 * `resetSemrushMocks()` in setup.js is already wired for it.
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
      // Same { items: [...] } envelope as models; asserting the shape (not just
      // "an object") catches schema drift / an error body slipping through as 200.
      expect(res.body).to.be.an('object');
      expect(res.body.items).to.be.an('array').that.is.not.empty;
    });
  });

  describe('Serenity API — relaxed auth reaches the handler', () => {
    // Before SERENITY_ALLOW_NON_IMS_AUTH the harness's JWT deterministically
    // 401'd at requireImsBearer. With the flag, the same call now passes auth
    // and proceeds to brand resolution: an unknown brand under an accessible org
    // resolves to 404 (NOT 401), proving the relaxed path reaches the handler.
    const unknownBrand = '99999999-9999-4999-b999-999999999999';

    it('brand-level GET markets returns 404 for an unknown brand (not 401)', async () => {
      const res = await getHttpClient().admin.get(
        `/v2/orgs/${ORG_1_ID}/brands/${unknownBrand}/serenity/markets`,
      );
      expect(res.status).to.equal(404);
      // Assert the handler's own 404 body ("brand not found ..."), not just the
      // status: this distinguishes the controller running and rejecting the
      // unknown brand from a generic unmatched-route / middleware 404.
      expect(res.body.message).to.match(/brand not found/i);
    });

    // A second brand-level route for breadth: a different controller method
    // (listPrompts) carrying a query string still routes, passes the relaxed
    // auth, and 404s on the unknown brand — not 401, not a 500 from the query.
    it('brand-level GET prompts returns 404 for an unknown brand (not 401)', async () => {
      const res = await getHttpClient().admin.get(
        `/v2/orgs/${ORG_1_ID}/brands/${unknownBrand}/serenity/prompts?geoTargetId=2840&languageCode=en`,
      );
      expect(res.status).to.equal(404);
      expect(res.body.message).to.match(/brand not found/i);
    });
  });

  describe('Serenity API — brand-level reads via the live sub-workspace', () => {
    // BRAND_1 is in sub-workspace mode and its semrush_workspace_id is aligned to
    // the mock seed, so these reads resolve a REAL workspace and return live mock
    // data — exercising the sub-workspace brand-resolution path the unknown-brand
    // 404 tests above never reach.
    const base = `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity`;

    it('GET /serenity/models returns the workspace AI model catalog', async () => {
      const res = await getHttpClient().admin.get(`${base}/models`);
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array').that.is.not.empty;
      // Every model carries the id/key/name the UI renders; assert the shape so a
      // contract drift (renamed field / error body as 200) fails loudly.
      res.body.items.forEach((m) => {
        expect(m).to.include.keys('id', 'key', 'name');
        expect(m.id).to.be.a('string');
        expect(m.key).to.be.a('string');
      });
    });

    it('GET /serenity/markets returns the (empty) market list envelope', async () => {
      // The seed ships no market slice for this workspace, so the list is empty —
      // but a 200 with an `items` array proves the full read chain (relaxed auth →
      // brand resolution → sub-workspace transport → HTTPS to the mock → parse).
      const res = await getHttpClient().admin.get(`${base}/markets`);
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array');
    });

    it('GET /serenity/markets/:geo/:lang 404s when the slice has no market', async () => {
      // A well-formed slice that the workspace has no market for: this resolves
      // the brand, builds the transport, lists projects from the mock, finds no
      // matching slice → 404 marketNotFound. Deeper reach than the unknown-brand
      // 404 (it actually queries the mock), and distinct from the bad-geo 400.
      const res = await getHttpClient().admin.get(`${base}/markets/2840/en`);
      expect(res.status).to.equal(404);
      expect(res.body.error).to.equal('marketNotFound');
    });
  });

  describe('Serenity API — write endpoints reach the handler (post-auth validation)', () => {
    // These drive the real seeded BRAND_1: each request passes the relaxed auth
    // AND brand resolution, then fails at the handler's own body/slice validation.
    // That proves every write route is wired to its controller method and runs
    // the real handler — the create/activate 2xx is blocked by the mock's publish
    // 406 (see file header), so the validation surface is what we can assert.
    const base = `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity`;

    it('GET /serenity/tags 400s without a (geoTargetId, languageCode) slice', async () => {
      const res = await getHttpClient().admin.get(`${base}/tags`);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('invalidRequest');
    });

    it('PUT /serenity/models 400s without a market slice', async () => {
      const res = await getHttpClient().admin.put(`${base}/models`, { modelIds: [] });
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('invalidRequest');
    });

    it('POST /serenity/markets 400s when brandDomain/brandNames are missing', async () => {
      const res = await getHttpClient().admin.post(`${base}/markets`, { market: 'US', languageCode: 'en' });
      expect(res.status).to.equal(400);
      expect(res.body.message).to.match(/brandDomain is required/i);
    });

    it('POST /serenity/markets 400s when market is not an ISO-2 country code', async () => {
      const res = await getHttpClient().admin.post(`${base}/markets`, {
        market: 'USA', languageCode: 'en', brandDomain: 'example.com', brandNames: ['Test Brand'],
      });
      expect(res.status).to.equal(400);
      expect(res.body.message).to.match(/market must be an ISO-2 country code/i);
    });

    it('POST /serenity/prompts 400s on an empty prompts array', async () => {
      const res = await getHttpClient().admin.post(`${base}/prompts`, { prompts: [] });
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('invalidRequest');
    });

    it('POST /serenity/prompts/bulk-delete 400s on an empty body', async () => {
      const res = await getHttpClient().admin.post(`${base}/prompts/bulk-delete`, {});
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('invalidRequest');
    });

    it('PATCH /serenity/prompts/:id 400s when text/tags are missing', async () => {
      const res = await getHttpClient().admin.patch(`${base}/prompts/some-prompt-id`, {});
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('missingFields');
    });

    it('DELETE /serenity/markets/:geo/:lang 400s on a non-integer geoTargetId', async () => {
      const res = await getHttpClient().admin.delete(`${base}/markets/not-a-number/en`);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.equal('invalidRequest');
    });
  });
}
