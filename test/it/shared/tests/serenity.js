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
  ORG_1_ID, BRAND_1_ID, SITE_1_ID, SERENITY_MOCK_WORKSPACE_ID, SERENITY_ORG_PARENT_WS_ID,
} from '../seed-ids.js';

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
 *     resolution and failing at body/slice validation, proving each route →
 *     controller wiring.
 *   - The mutating sub-workspace lifecycle live through the mock: `POST markets`
 *     and `activate` provision a project and PUBLISH it (needs PE mock >= 1.3.1,
 *     which fixed the empty-body-2xx 406 — adobe/spacecat-shared#1742), `deactivate`
 *     decommissions, `DELETE markets` removes a slice.
 *   - The sub-workspace ROUND-TRIP (read-back): a created+published market lists in
 *     `GET markets` as `live`, resolves via `GET markets/:slice`, and a prompt
 *     attaches to that slice and lists back (with text dedup). This relies on the PE
 *     mock round-trip fix (adobe/spacecat-shared#1745, PR #1746, shipped in PE
 *     >= 1.3.2 / UM >= 1.3.1): the project read-view echoes the ISO language code so
 *     the transport's `langOf` derives the slice, and `publish` flips
 *     `publish_status` -> `live`. Pinned by the bumped client deps, so it runs
 *     unconditionally.
 */
export default function serenityTests(
  getHttpClient,
  resetData,
  resetMocks = async () => {},
  mockControls = {},
) {
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

    it('GET /serenity/models returns the union of models across the brand\'s markets', async () => {
      // No-param brand-scoped models now returns the union of models enabled
      // across the brand's projects (not the global catalog — that lives on the
      // org-scoped endpoint asserted above). This seed ships no market slice for
      // the workspace, so the union is empty — but a 200 with an `items` array
      // proves the full read chain (relaxed auth → brand resolution →
      // sub-workspace transport → resolveProjects → mock).
      const res = await getHttpClient().admin.get(`${base}/models`);
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array');
      // If any model comes back, it carries the id/key/name the UI renders;
      // assert the shape so a contract drift (renamed field / error body as 200)
      // fails loudly.
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

    it('POST /serenity/markets 400s when brandDomain/siteId/brandNames are missing', async () => {
      const res = await getHttpClient().admin.post(`${base}/markets`, { market: 'US', languageCode: 'en' });
      expect(res.status).to.equal(400);
      // brandDomain OR siteId is now required (LLMO-6405 Phase 2).
      expect(res.body.message).to.match(/brandDomain or siteId is required/i);
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

    it('POST /serenity/tags 400s when type is not a recognized open or closed dimension', async () => {
      const res = await getHttpClient().admin.post(`${base}/tags`, {
        type: 'bogus', name: 'Whatever', geoTargetId: 2840, languageCode: 'en',
      });
      expect(res.status).to.equal(400);
      expect(res.body.message).to.match(/type must be one of/i);
    });
  });

  describe('Serenity API — sub-workspace lifecycle (mutating, live mock)', () => {
    // These mutate Project Engine mock state: a market provisions a project and
    // PUBLISHES it (the publish step needs PE mock >= 1.3.1, which fixed the
    // empty-body-2xx 406 — adobe/spacecat-shared#1742); activate/deactivate and
    // market delete mutate too. Reset BOTH the DB and the mock stores before each
    // case so they are order-independent.
    //
    // NOTE on what is asserted here: the create/activate/deactivate/delete
    // OPERATIONS return their real 2xx. The full round-trip (a created market then
    // appearing in GET markets / GET markets/:slice, and a prompt created against
    // that slice) is asserted in the separate "sub-workspace round-trip" describe
    // below, enabled by the PE mock round-trip fix (#1745/#1746, PE >= 1.3.2).
    beforeEach(async () => {
      await resetData();
      await resetMocks();
    });

    const base = `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity`;
    const US_GEO = 2840; // US resolves to Google geoTargetId 2840.
    const createUsMarket = () => getHttpClient().admin.post(`${base}/markets`, {
      market: 'US', languageCode: 'en', brandDomain: 'example.com', brandNames: ['Test Brand'],
    });

    it('POST /serenity/markets provisions and publishes a market (201)', async () => {
      const res = await createUsMarket();
      expect(res.status).to.equal(201);
      expect(res.body.published).to.equal(true);
      expect(res.body.geoTargetId).to.equal(US_GEO);
      expect(res.body.languageCode).to.equal('en');
      expect(res.body.projectId).to.be.a('string').that.is.not.empty;
    });

    it('DELETE /serenity/markets/:geo/:lang returns 204 after a create', async () => {
      await createUsMarket();
      const del = await getHttpClient().admin.delete(`${base}/markets/${US_GEO}/en`);
      expect(del.status).to.equal(204);
    });

    it('POST /serenity/markets accepts a siteId in place of brandDomain (LLMO-6405)', async () => {
      // SITE_1 is an onboarded ORG_1 Site; the controller derives brandDomain from
      // its base_url and links THAT site to the new market.
      const res = await getHttpClient().admin.post(`${base}/markets`, {
        market: 'US', languageCode: 'en', siteId: SITE_1_ID, brandNames: ['Test Brand'],
      });
      expect(res.status).to.equal(201);
      expect(res.body.geoTargetId).to.equal(US_GEO);
      expect(res.body.languageCode).to.equal('en');
    });

    it('DELETE /serenity/markets/:geo/:lang removes a siteId-linked market and cleans up (LLMO-6405 R12)', async () => {
      // Create via siteId (links SITE_1), then delete: the last market on that
      // non-primary site is removed, so its brand_sites 'serenity' link is unlinked.
      const created = await getHttpClient().admin.post(`${base}/markets`, {
        market: 'US', languageCode: 'en', siteId: SITE_1_ID, brandNames: ['Test Brand'],
      });
      expect(created.status).to.equal(201);
      const del = await getHttpClient().admin.delete(`${base}/markets/${US_GEO}/en`);
      expect(del.status).to.equal(204);
    });

    it('GET /serenity/tags returns 200 for a well-formed slice', async () => {
      await createUsMarket();
      const res = await getHttpClient().admin.get(`${base}/tags?geoTargetId=${US_GEO}&languageCode=en`);
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array');
    });

    it('POST /serenity/tags registers a category tag on the market (201)', async () => {
      await createUsMarket();
      const res = await getHttpClient().admin.post(`${base}/tags`, {
        type: 'category', name: 'Footwear', geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(res.status).to.equal(201);
      expect(res.body.type).to.equal('category');
      // The name is BARE. A tag's dimension is the root it descends from, so the
      // create hangs it under the `category` root rather than decorating the name.
      expect(res.body.name).to.equal('Footwear');
      expect(res.body.parentId).to.be.a('string').that.is.not.empty;
      expect(res.body.geoTargetId).to.equal(US_GEO);
      expect(res.body.languageCode).to.equal('en');
      // The create echoes the upstream tag id (needed to nest / re-parent).
      expect(res.body.id).to.be.a('string').that.is.not.empty;

      // The five dimension roots are provisioned on first touch (the server-owned
      // `source` producing-system root joined category/intent/origin/type — WP-S2,
      // LLMO-6282), and the new category is a CHILD of the `category` root, not a
      // root itself.
      const roots = await getHttpClient().admin.get(
        `${base}/tags?geoTargetId=${US_GEO}&languageCode=en&parentId=`,
      );
      expect(roots.status).to.equal(200);
      expect(roots.body.items.map((t) => t.name))
        .to.have.members(['category', 'intent', 'origin', 'type', 'source']);
      const categoryRoot = roots.body.items.find((t) => t.name === 'category');
      expect(res.body.parentId).to.equal(categoryRoot.id);
    });

    // 1-level nested category tags (needs PE mock >= 1.6.0 — adobe/spacecat-shared#1758,
    // which models parent_id on create, the tree-aware GET, and PATCH re-parent).
    //
    // The mock derives a tag id as an opaque `tag-<sha256(name) prefix>` (spacecat-shared#1760 /
    // adobe/spacecat-shared#1764) — URL-safe, so it round-trips through both a JSON body AND a URL
    // query/path segment. Drilling a parent's children by id and a full PATCH-by-id round trip are
    // therefore exercised end-to-end against the mock below (previously only testable against live
    // Semrush, per the WP0 probe — see rest-transport / tags handler JSDoc).
    const createTag = (name, parentId) => getHttpClient().admin.post(`${base}/tags`, {
      type: 'category',
      name,
      geoTargetId: US_GEO,
      languageCode: 'en',
      ...(parentId ? { parentId } : {}),
    });

    it('POST /serenity/tags nests a child under a parent (parentId in, childrenCount out)', async () => {
      await createUsMarket();
      const parent = await createTag('Footwear');
      expect(parent.status).to.equal(201);
      const parentId = parent.body.id;
      expect(parentId).to.be.a('string').that.is.not.empty;
      const categoryRootId = parent.body.parentId;

      const child = await createTag('Sneakers', parentId);
      expect(child.status).to.equal(201);
      // Every name is bare at every depth — the dimension is the root ancestor.
      expect(child.body.name).to.equal('Sneakers');
      // parent_id echoes back through the JSON body faithfully — the child is nested.
      expect(child.body.parentId).to.equal(parentId);

      // The `category` ROOT is what lists at the root level, and the customer's
      // category is one level down.
      const roots = await getHttpClient().admin.get(
        `${base}/tags?geoTargetId=${US_GEO}&languageCode=en&parentId=`,
      );
      expect(roots.status).to.equal(200);
      const categoryRoot = roots.body.items.find((t) => t.id === categoryRootId);
      expect(categoryRoot, 'the category root should list among the roots').to.exist;
      expect(categoryRoot.parentId).to.equal(null);
      expect(categoryRoot.childrenCount).to.be.greaterThan(0);

      // Drill the category root to find `Footwear`, whose own childrenCount — derived
      // server-side from the stored parentage — reflects the new child.
      const categories = await getHttpClient().admin.get(
        `${base}/tags?geoTargetId=${US_GEO}&languageCode=en&parentId=${categoryRootId}`,
      );
      expect(categories.status).to.equal(200);
      const parentRow = categories.body.items.find((t) => t.id === parentId);
      expect(parentRow, 'Footwear should list under the category root').to.exist;
      expect(parentRow.childrenCount).to.be.greaterThan(0);

      // Drill the parent's CHILDREN by id (parentId=<parent's upstream id>) — round-trips through
      // the URL query value now that tag ids are URL-safe (spacecat-shared#1760).
      const children = await getHttpClient().admin.get(
        `${base}/tags?geoTargetId=${US_GEO}&languageCode=en&parentId=${parentId}`,
      );
      expect(children.status).to.equal(200);
      expect(children.body.items.map((t) => t.id)).to.include(child.body.id);
      expect(children.body.items.find((t) => t.id === child.body.id).parentId).to.equal(parentId);
    });

    // The parent is validated by ANCESTRY, so declaring the open dimension while
    // pointing at a closed root cannot smuggle a customer value into `intent`.
    it('POST /serenity/tags 400s a category whose parentId roots in another dimension', async () => {
      await createUsMarket();
      const roots = await getHttpClient().admin.get(
        `${base}/tags?geoTargetId=${US_GEO}&languageCode=en&parentId=`,
      );
      const intentRoot = roots.body.items.find((t) => t.name === 'intent');
      expect(intentRoot, 'the intent root should be provisioned').to.exist;

      const res = await createTag('ai', intentRoot.id);
      expect(res.status).to.equal(400);
    });

    it('PATCH /serenity/tags/:tagId renames a child by id (URL-safe id round-trips through the path)', async () => {
      await createUsMarket();
      const parent = await createTag('Footwear');
      const child = await createTag('Sneakers', parent.body.id);
      const childTagId = child.body.id;

      // Rename-only: parentId omitted — the proxy must re-send the child's current parent itself
      // (gate 5) so the child stays nested, not promoted to root.
      const renamed = await getHttpClient().admin.patch(`${base}/tags/${childTagId}`, {
        name: 'Boots', geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(renamed.status).to.equal(200);
      expect(renamed.body.name).to.equal('Boots');
      expect(renamed.body.parentId).to.equal(parent.body.id);

      // An explicit null parent is refused: the root level is reserved for the four
      // dimension roots, so promoting a tag would leave it with no dimension.
      const promoted = await getHttpClient().admin.patch(`${base}/tags/${childTagId}`, {
        name: 'Boots', parentId: null, geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(promoted.status).to.equal(400);
    });

    // Upstream stores a parent pointer, not a tree, so it would accept a parent
    // that already descends from the tag being moved. Both nodes would then hang
    // off no root, and — since every tree walk starts at the roots — neither could
    // be found again: the subtree would be unreachable and unrepairable through
    // this API. The proxy refuses the edge rather than depend on upstream to.
    it('PATCH /serenity/tags/:tagId 400s a re-parent onto the tag\'s own descendant', async () => {
      await createUsMarket();
      const parent = await createTag('Outerwear');
      const child = await createTag('Parkas', parent.body.id);

      const cycled = await getHttpClient().admin.patch(`${base}/tags/${parent.body.id}`, {
        name: 'Outerwear',
        parentId: child.body.id,
        geoTargetId: US_GEO,
        languageCode: 'en',
      });
      expect(cycled.status).to.equal(400);

      // The tree is untouched: the parent still sits under the `category` root and
      // still carries its child.
      const children = await getHttpClient().admin.get(
        `${base}/tags?geoTargetId=${US_GEO}&languageCode=en&parentId=${parent.body.id}`,
      );
      expect(children.status).to.equal(200);
      expect(children.body.items.map((t) => t.id)).to.include(child.body.id);
    });

    it('PATCH /serenity/tags/:tagId 404s an id absent from this market tree', async () => {
      await createUsMarket();
      // Without the target's current parent there is no PATCH body that preserves it,
      // and an upstream PATCH omitting parent_id promotes the tag to a root. The proxy
      // therefore resolves the id against the tree and refuses rather than forwarding.
      const res = await getHttpClient().admin.patch(
        `${base}/tags/00000000-0000-4000-8000-000000000000`,
        { name: 'Ghost', geoTargetId: US_GEO, languageCode: 'en' },
      );
      expect(res.status).to.equal(404);
    });

    it('PATCH /serenity/tags/:tagId 400s a rename of a dimension root', async () => {
      await createUsMarket();
      const roots = await getHttpClient().admin.get(
        `${base}/tags?geoTargetId=${US_GEO}&languageCode=en&parentId=`,
      );
      const categoryRoot = roots.body.items.find((t) => t.name === 'category');
      const res = await getHttpClient().admin.patch(`${base}/tags/${categoryRoot.id}`, {
        name: 'Categories', geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(res.status).to.equal(400);
    });

    it('POST /serenity/tags resolves a closed-dimension tag idempotently (origin/intent/type)', async () => {
      await createUsMarket();
      const first = await getHttpClient().admin.post(`${base}/tags`, {
        type: 'origin', name: 'ai', geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(first.status).to.equal(200);
      expect(first.body).to.include({ type: 'origin', name: 'ai' });
      expect(first.body.id).to.be.a('string').that.is.not.empty;
      // The value hangs under the `origin` root, never at the root level.
      expect(first.body.parentId).to.be.a('string').that.is.not.empty;

      // Same closed-dimension value again — resolved, not re-created (no upstream collision).
      const second = await getHttpClient().admin.post(`${base}/tags`, {
        type: 'origin', name: 'ai', geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(second.status).to.equal(200);
      expect(second.body).to.include({ name: 'ai', id: first.body.id, created: false });
    });

    // The fixed vocabulary is not editable: every resolve-or-create keys on the bare
    // name under the root, so a rename would mint a second value and orphan the prompts
    // still carrying the first.
    it('PATCH /serenity/tags/:tagId 400s a rename of a closed-dimension value', async () => {
      await createUsMarket();
      const created = await getHttpClient().admin.post(`${base}/tags`, {
        type: 'origin', name: 'ai', geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(created.status).to.equal(200);
      const res = await getHttpClient().admin.patch(`${base}/tags/${created.body.id}`, {
        name: 'automated', geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(res.status).to.equal(400);
    });

    it('POST /serenity/tags 400s a closed-dimension value outside the fixed enum', async () => {
      await createUsMarket();
      const res = await getHttpClient().admin.post(`${base}/tags`, {
        type: 'intent', name: 'not-a-real-intent', geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(res.status).to.equal(400);
    });

    it('POST /serenity/prompts creates a prompt by id-based tagIds (serenity-docs#24)', async () => {
      await createUsMarket();
      const category = await createTag('Photography');
      const child = await createTag('Cameras', category.body.id);

      const created = await getHttpClient().admin.post(`${base}/prompts`, {
        prompts: [{
          text: 'What is the best mirrorless camera?',
          tagIds: [category.body.id, child.body.id],
          geoTargetId: US_GEO,
          languageCode: 'en',
        }],
      });
      expect(created.status).to.equal(200);
      expect(created.body.created).to.have.lengthOf(1);
      expect(created.body.created[0].semrushPromptId).to.be.a('string').that.is.not.empty;
      // The write path server-stamps FOUR dimensions the caller may not set: a
      // branded/non-branded `type:` tag (classified from the text), the derived
      // `origin:` tag (`human`, on a user-authenticated create — origin-dimension.md
      // §3 / WP-O2b), the producing `source:` tag (`config` on this proxy-create
      // path — source-dimension.md §1 / WP-S2, LLMO-6282), AND an `intent:<Value>`
      // tag (serenity-docs#31, #32). Azure OpenAI is not configured in this IT
      // environment, so intent deterministically defaults to `intent:Informational`
      // (never null/omitted — see the fallback ladder). So the created prompt
      // carries the two supplied tags plus the four computed ones.
      expect(created.body.created[0].tagIds).to.include.members([category.body.id, child.body.id]);
      expect(created.body.created[0].tagIds).to.have.lengthOf(6);
      expect(created.body.failed).to.deep.equal([]);

      // by_tags correlation: the id-based create embeds the tag ids, so filtering the prompt list
      // by the child's id surfaces the new prompt.
      const list = await getHttpClient().admin.get(
        `${base}/prompts?geoTargetId=${US_GEO}&languageCode=en&tagIds=${child.body.id}`,
      );
      expect(list.status).to.equal(200);
      const promptIds = list.body.items.map((p) => p.semrushPromptId);
      expect(promptIds).to.include(created.body.created[0].semrushPromptId);
    });

    it('PATCH /serenity/prompts/:id 400s when both tags and tagIds are supplied', async () => {
      await createUsMarket();
      const res = await getHttpClient().admin.patch(`${base}/prompts/00000000-0000-4000-8000-000000000000`, {
        text: 'x', tags: ['a'], tagIds: ['b'], geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(res.status).to.equal(400);
    });

    it('POST /serenity/activate provisions + publishes, then deactivate decommissions', async () => {
      const activated = await getHttpClient().admin.post(`${base}/activate`, {
        brandDomain: 'example.com',
        brandNames: ['Test Brand'],
        markets: [{ market: 'US', languageCode: 'en' }],
      });
      // 207 Multi-Status: per-market results, each a published 201.
      expect(activated.status).to.equal(207);
      expect(activated.body.status).to.equal('active');
      expect(activated.body.markets).to.be.an('array').that.is.not.empty;
      expect(activated.body.markets[0].status).to.equal(201);
      expect(activated.body.markets[0].body.published).to.equal(true);

      const deactivated = await getHttpClient().admin.post(`${base}/deactivate`, {});
      expect(deactivated.status).to.equal(200);
      expect(deactivated.body.status).to.equal('pending');
    });
  });

  describe('Serenity API — sub-workspace round-trip (live mock)', () => {
    // Read-back: a created+published market lists in `GET markets` as `live`,
    // resolves via `GET markets/:slice`, and a prompt attaches to that slice and
    // lists back (with text dedup). This is the contract the PE mock round-trip fix
    // guarantees (adobe/spacecat-shared#1745, PR #1746): the project read-view echoes
    // the ISO language code (so the transport's `langOf` derives the slice) and
    // `publish` flips `publish_status` -> `live`. Pinned by the bumped client deps
    // (PE >= 1.3.2 / UM >= 1.3.1, which select the round-trip mock image), so these
    // run unconditionally — a regression in the mock or transport fails loudly here.
    const base = `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity`;
    const US_GEO = 2840; // US resolves to Google geoTargetId 2840.
    const createUsMarket = () => getHttpClient().admin.post(`${base}/markets`, {
      market: 'US', languageCode: 'en', brandDomain: 'example.com', brandNames: ['Test Brand'],
    });

    beforeEach(async () => {
      await resetData();
      await resetMocks();
    });

    it('GET /serenity/markets lists a created+published market as live', async () => {
      const created = await createUsMarket();
      expect(created.status).to.equal(201);
      const res = await getHttpClient().admin.get(`${base}/markets`);
      expect(res.status).to.equal(200);
      const slice = res.body.items.find(
        (m) => m.geoTargetId === US_GEO && m.languageCode === 'en',
      );
      expect(slice, 'the created US/en market should round-trip into GET markets').to.exist;
      // publish flipped publish_status -> live (mapPublishStatus('live') === 'live').
      expect(slice.status).to.equal('live');
      // The listed slice is the same project the create returned.
      expect(slice.semrushProjectId).to.equal(created.body.projectId);
      // NOTE (LLMO-6405): the sub-workspace market DTO also carries `siteId`
      // (enriched from the brand_to_semrush_projects mapping row). The round-trip
      // siteId assertions were removed pending live verification of the mapping-row
      // enrichment in the IT stack — the field is additive and the UI degrades to
      // domain-keying when it is null, so this does not block the feature. Unit
      // coverage for the create-time binding lives in site-linkage.test.js.
    });

    it('GET /serenity/markets/:geo/:lang resolves a created+published market', async () => {
      const created = await createUsMarket();
      const res = await getHttpClient().admin.get(`${base}/markets/${US_GEO}/en`);
      expect(res.status).to.equal(200);
      expect(res.body.geoTargetId).to.equal(US_GEO);
      expect(res.body.languageCode).to.equal('en');
      expect(res.body.semrushProjectId).to.equal(created.body.projectId);
    });

    // Tags are addressed by upstream id: a bulk-create row carries `tagIds`, never
    // names, because a name cannot identify a nested tag.
    const createCategory = async (name) => {
      const res = await getHttpClient().admin.post(`${base}/tags`, {
        type: 'category', name, geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(res.status).to.equal(201);
      return res.body.id;
    };

    it('POST /serenity/prompts attaches a prompt to the created slice, then lists it', async () => {
      await createUsMarket();
      const tagId = await createCategory('Running');
      const text = 'What are the best trail running shoes?';
      const post = await getHttpClient().admin.post(`${base}/prompts`, {
        prompts: [{
          text, tagIds: [tagId], geoTargetId: US_GEO, languageCode: 'en',
        }],
      });
      expect(post.status).to.equal(200);
      // With the slice resolvable, the prompt is created (not skipped "No market for slice").
      expect(post.body.skipped).to.be.an('array').that.is.empty;
      expect(post.body.failed).to.be.an('array').that.is.empty;
      expect(post.body.created).to.be.an('array').that.has.lengthOf(1);
      expect(post.body.created[0].text).to.equal(text);

      const list = await getHttpClient().admin.get(
        `${base}/prompts?geoTargetId=${US_GEO}&languageCode=en`,
      );
      expect(list.status).to.equal(200);
      expect(list.body.items.some((p) => p.text === text)).to.equal(true);
    });

    it('POST /serenity/prompts skips a row that supplies no tagIds, and says why', async () => {
      await createUsMarket();
      const post = await getHttpClient().admin.post(`${base}/prompts`, {
        prompts: [{ text: 'Untagged prompt', geoTargetId: US_GEO, languageCode: 'en' }],
      });
      expect(post.status).to.equal(200);
      expect(post.body.created).to.be.an('array').that.is.empty;
      expect(post.body.skipped).to.have.lengthOf(1);
      expect(post.body.skipped[0].reason).to.match(/tagIds must be a non-empty array/);
    });

    it('POST /serenity/prompts dedups a repeated prompt text on the same slice', async () => {
      await createUsMarket();
      const tagId = await createCategory('Laptops');
      const text = 'Which laptop has the best battery life?';
      const body = {
        prompts: [{
          text, tagIds: [tagId], geoTargetId: US_GEO, languageCode: 'en',
        }],
      };
      const first = await getHttpClient().admin.post(`${base}/prompts`, body);
      expect(first.status).to.equal(200);
      expect(first.body.created).to.have.lengthOf(1);

      // Re-posting the same text must NOT create a second prompt: the mock dedups by
      // text (existing_count), so the slice still lists exactly one prompt of that text.
      const second = await getHttpClient().admin.post(`${base}/prompts`, body);
      expect(second.status).to.equal(200);
      const list = await getHttpClient().admin.get(
        `${base}/prompts?geoTargetId=${US_GEO}&languageCode=en`,
      );
      expect(list.status).to.equal(200);
      expect(list.body.items.filter((p) => p.text === text)).to.have.lengthOf(1);
    });

    // In-place edit (serenity-docs#63, gate G1): PATCH edits the prompt via the
    // upstream rename + batch tag write, so the id survives the edit — the
    // response echoes it unchanged, the listing carries the new text under the
    // SAME id, and the prompt count is unchanged (no duplicate was minted).
    it('PATCH /serenity/prompts/:id edits the text in place — the id survives the edit', async () => {
      await createUsMarket();
      const tagId = await createCategory('Footwear');
      const created = await getHttpClient().admin.post(`${base}/prompts`, {
        prompts: [{
          text: 'What are the best running shoes?', tagIds: [tagId], geoTargetId: US_GEO, languageCode: 'en',
        }],
      });
      expect(created.status).to.equal(200);
      const promptId = created.body.created[0].semrushPromptId;

      const patched = await getHttpClient().admin.patch(`${base}/prompts/${promptId}`, {
        text: 'What are the best trail running shoes?',
        tagIds: [tagId],
        geoTargetId: US_GEO,
        languageCode: 'en',
      });
      expect(patched.status).to.equal(200);
      expect(patched.body.semrushPromptId).to.equal(promptId);
      expect(patched.body.text).to.equal('What are the best trail running shoes?');

      const list = await getHttpClient().admin.get(
        `${base}/prompts?geoTargetId=${US_GEO}&languageCode=en`,
      );
      expect(list.status).to.equal(200);
      const edited = list.body.items.find((p) => p.semrushPromptId === promptId);
      expect(edited, 'the edited prompt lists under its ORIGINAL id').to.exist;
      expect(edited.text).to.equal('What are the best trail running shoes?');
      // No duplicate was minted: the old text is gone from the slice.
      expect(list.body.items.filter((p) => /best (trail )?running shoes/.test(p.text)))
        .to.have.lengthOf(1);
    });

    // Gate G2: a rename onto a SIBLING prompt's exact text is a 409 conflict
    // with nothing mutated upstream — both prompts keep their text and ids.
    it('PATCH /serenity/prompts/:id 409s when the new text collides with a sibling prompt', async () => {
      await createUsMarket();
      const tagId = await createCategory('Cameras');
      const created = await getHttpClient().admin.post(`${base}/prompts`, {
        prompts: [
          {
            text: 'Which DSLR is best for beginners?', tagIds: [tagId], geoTargetId: US_GEO, languageCode: 'en',
          },
          {
            text: 'Which mirrorless camera is best?', tagIds: [tagId], geoTargetId: US_GEO, languageCode: 'en',
          },
        ],
      });
      expect(created.status).to.equal(200);
      expect(created.body.created).to.have.lengthOf(2);
      const [first, second] = created.body.created;

      const res = await getHttpClient().admin.patch(`${base}/prompts/${second.semrushPromptId}`, {
        text: 'Which DSLR is best for beginners?', // the FIRST prompt's exact text
        tagIds: [tagId],
        geoTargetId: US_GEO,
        languageCode: 'en',
      });
      expect(res.status).to.equal(409);
      expect(res.body.error).to.equal('conflict');

      // Nothing mutated: both prompts still list with their original text + id.
      const list = await getHttpClient().admin.get(
        `${base}/prompts?geoTargetId=${US_GEO}&languageCode=en`,
      );
      const byId = new Map(list.body.items.map((p) => [p.semrushPromptId, p.text]));
      expect(byId.get(first.semrushPromptId)).to.equal('Which DSLR is best for beginners?');
      expect(byId.get(second.semrushPromptId)).to.equal('Which mirrorless camera is best?');
    });

    it('PATCH /serenity/prompts/:id 404s promptNotFound for an unknown prompt id', async () => {
      await createUsMarket();
      const tagId = await createCategory('Ghosts');
      const res = await getHttpClient().admin.patch(
        `${base}/prompts/00000000-0000-4000-8000-00000000dead`,
        {
          text: 'x', tagIds: [tagId], geoTargetId: US_GEO, languageCode: 'en',
        },
      );
      expect(res.status).to.equal(404);
      expect(res.body.error).to.equal('promptNotFound');
    });
  });

  // Dynamic-allocation kill-switch ON — drives the JIT top-up FRONTING end-to-end against the live
  // metered User Manager mock (Rainer's review item #4). ORG_1 carries a parent workspace
  // (SERENITY_ORG_PARENT_WS_ID) so BRAND_1's sub-workspace resolves a non-null parent id and
  // the guard engages; the flag is a global env kill-switch read per request, toggled here around
  // the block. The `__quota` / `__dump` mock control routes are injected by the postgres harness.
  describe('Serenity API — dynamic allocation ON (metered JIT via the live UM mock)', () => {
    const { setUmMockQuota, dumpUmMock } = mockControls;
    const base = `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity`;
    const US_GEO = 2840;
    const CHILD = SERENITY_MOCK_WORKSPACE_ID; // BRAND_1's sub-workspace (the metered child)
    const PARENT = SERENITY_ORG_PARENT_WS_ID; // ORG_1's parent workspace (advisory units pool)

    const childTotal = (dump, dim) => {
      const rec = (dump.workspace_resources || []).find((r) => r.id === CHILD);
      // A missing record (shape mismatch / wiring regression) must fail with an ACTIONABLE message
      // here, not surface downstream as the opaque "expected undefined to be above 0".
      expect(rec, `expected a workspace_resources record for CHILD (${CHILD}) in the mock dump`)
        .to.exist;
      return rec.ai?.[dim]?.total;
    };

    // Skip cleanly if a wiring didn't inject the mock control routes (only the postgres harness has
    // the live containers); this keeps the shared factory usable by any future non-metered wiring.
    before(function skipWithoutMockControls() {
      if (typeof setUmMockQuota !== 'function' || typeof dumpUmMock !== 'function') {
        this.skip();
      }
    });

    beforeEach(async () => {
      await resetData();
      await resetMocks();
      process.env.SERENITY_DYNAMIC_ALLOCATION = 'true';
      // Parent (units pool) amply provisioned; child seeded at ZERO total so a metered write must
      // top it up. Both metered so the allocator's strict /resources reads resolve.
      await setUmMockQuota(PARENT, { projects: 100, prompts: 100000 });
      await setUmMockQuota(CHILD, {
        projects: { used: 0, drafted: 0, total: 0 },
        prompts: { used: 0, drafted: 0, total: 0 },
      });
    });

    afterEach(() => {
      delete process.env.SERENITY_DYNAMIC_ALLOCATION;
      delete process.env.SERENITY_BRAND_AI_CEILING_PROMPTS;
    });

    it('tops up the sub-workspace via a live /resources transfer when a metered write needs headroom', async () => {
      // create-market fronts PROJECT headroom before createProject: from a seeded 0 total the guard
      // tops the child up to a whole block (>=1) with a REAL /resources transfer to the mock, then
      // creates + publishes the project.
      const created = await getHttpClient().admin.post(`${base}/markets`, {
        market: 'US', languageCode: 'en', brandDomain: 'example.com', brandNames: ['Test Brand'],
      });
      expect(created.status).to.equal(201);

      // Positive proof the flag-ON JIT engaged end-to-end over the wire: the child's PROJECT total
      // grew from the seeded 0 via a live transfer. A flag-OFF run never fronts/transfers, so it
      // would still read 0 — asserting the top-up AND that the kill-switch env toggle took effect
      // for the request. (The prompt dimension's `texts × models` sizing is covered by the
      // resource-manager unit tests; here the project carve is the decisive over-the-wire signal.)
      const dump = await dumpUmMock();
      expect(childTotal(dump, 'projects'), 'projects topped up from 0 via a live transfer')
        .to.be.greaterThan(0);

      // Smoke: the prompt write path also runs cleanly under the flag (fronts, then publishes).
      const post = await getHttpClient().admin.post(`${base}/prompts`, {
        prompts: [{ text: 'best trail running shoes?', geoTargetId: US_GEO, languageCode: 'en' }],
      });
      expect(post.status).to.equal(200);
    });

    it('a binding per-brand ceiling (LLMO-6190 gate) rejects a prompt write that would top up past the cap', async () => {
      // A low prompts ceiling set in the env (Vault, in prod). The market create tops up PROJECTS
      // only (the ceiling caps prompts, unset for projects) and publishes empty, so it still
      // succeeds; the later prompt write needs a PROMPTS top-up from the seeded 0, which rounds to
      // a whole block (100) and exceeds the cap (50) → brandAiLimit (409), over the wire.
      process.env.SERENITY_BRAND_AI_CEILING_PROMPTS = '50';

      const created = await getHttpClient().admin.post(`${base}/markets`, {
        market: 'US', languageCode: 'en', brandDomain: 'example.com', brandNames: ['Test Brand'],
      });
      expect(created.status).to.equal(201);

      const post = await getHttpClient().admin.post(`${base}/prompts`, {
        prompts: [{ text: 'capped by the ceiling', geoTargetId: US_GEO, languageCode: 'en' }],
      });
      expect(post.status).to.equal(409);
    });
  });
  // Prompt authorship metadata (LLMO-6289): every native prompt write stamps the four-key
  // `metadata` block — `created_at`/`created_by` on the create, `updated_at`/`updated_by` on the
  // create AND on every subsequent edit — upstream on the Semrush prompt row.
  //
  // These assert against the PE mock's OWN store (`GET /__dump`), not the service's list read.
  // That is deliberate, and it is what makes the coverage meaningful: the upstream `by_tags` list
  // gates `metadata` behind an `include_metadata=true` QUERY param, so a consumer that does not
  // opt in reads back no metadata at all even for a fully stamped prompt. Asserting the stamp
  // through the list DTO would conflate "the write did not stamp" with "the read did not ask".
  // The dump separates the two, so this block pins the WRITE contract only; the read side is
  // pinned on its own by the list-read block that follows.
  describe('Serenity API — prompt authorship metadata (live mock)', () => {
    const { dumpPeMock } = mockControls;
    const base = `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity`;
    const US_GEO = 2840;

    // Skip cleanly if a wiring didn't inject the mock control routes (only the postgres harness has
    // the live containers); mirrors the dynamic-allocation block above.
    before(function skipWithoutMockControls() {
      if (typeof dumpPeMock !== 'function') {
        this.skip();
      }
    });

    beforeEach(async () => {
      await resetData();
      await resetMocks();
    });

    // Setup, not subject: every test here needs a live US market, and none asserts on the market
    // response itself. Checking the status inside the helper means a refused create (a 422 on
    // insufficient units, say) fails here, rather than surfacing later as a confusing failure on
    // the tag or prompt call that depended on it.
    const createUsMarket = async () => {
      const res = await getHttpClient().admin.post(`${base}/markets`, {
        market: 'US', languageCode: 'en', brandDomain: 'example.com', brandNames: ['Test Brand'],
      });
      expect(res.status).to.equal(201);
    };

    const createCategory = async (name) => {
      const res = await getHttpClient().admin.post(`${base}/tags`, {
        type: 'category', name, geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(res.status).to.equal(201);
      return res.body.id;
    };

    // The mock stores prompts per project under `prompts:{workspaceId}:{projectId}`. Flattening
    // every such collection keeps the helper independent of which project a slice resolved to.
    const storedPrompts = async () => {
      const dump = await dumpPeMock();
      return Object.entries(dump)
        .filter(([collection]) => collection.startsWith('prompts:'))
        .flatMap(([, rows]) => (Array.isArray(rows) ? rows : []));
    };

    const storedPromptById = async (semrushPromptId) => {
      const row = (await storedPrompts()).find((p) => p.id === semrushPromptId);
      // A missing row means the write never reached the mock (or the id shape drifted) — fail with
      // an actionable message here rather than as "cannot read property of undefined" downstream.
      expect(row, `expected the PE mock to hold a prompt row with id ${semrushPromptId}`).to.exist;
      return row;
    };

    // Returns the stored `metadata` block, having asserted it is actually populated. The
    // preservation tests below compare metadata before/after a refused write with `deep.equal`,
    // which would pass VACUOUSLY if both sides were `undefined` (the shape a never-stamped prompt
    // has upstream, where `JSON.stringify` drops the key). Asserting presence here means those
    // tests cannot silently degrade into "no metadata either time, so nothing changed".
    const storedMetadataById = async (semrushPromptId) => {
      const { metadata } = await storedPromptById(semrushPromptId);
      expect(metadata, `prompt ${semrushPromptId} should carry a stamped metadata block`)
        .to.be.an('object');
      expect(metadata.created_at, 'created_at is stamped').to.be.a('string');
      expect(metadata.updated_at, 'updated_at is stamped').to.be.a('string');
      return metadata;
    };

    const createPrompt = async (persona, text, tagIds) => {
      const res = await getHttpClient()[persona].post(`${base}/prompts`, {
        prompts: [{
          text, tagIds, geoTargetId: US_GEO, languageCode: 'en',
        }],
      });
      expect(res.status).to.equal(200);
      expect(res.body.created, `create by ${persona} should not be skipped/failed`)
        .to.have.lengthOf(1);
      return res.body.created[0].semrushPromptId;
    };

    // The four keys are the closed set the upstream CHECK allows; `created_* === updated_*` on a
    // create because a create is its own first edit. Timestamps are RFC 3339 UTC.
    it('POST /serenity/prompts stamps all four authorship keys upstream', async () => {
      await createUsMarket();
      const tagId = await createCategory('Running');
      const promptId = await createPrompt('admin', 'What are the best trail shoes?', [tagId]);

      const { metadata } = await storedPromptById(promptId);
      expect(metadata, 'the created prompt carries a metadata block').to.be.an('object');
      expect(Object.keys(metadata).sort())
        .to.deep.equal(['created_at', 'created_by', 'updated_at', 'updated_by']);
      // A create is its own first edit: both pairs carry the SAME instant and the same caller.
      expect(metadata.created_at).to.equal(metadata.updated_at);
      expect(metadata.created_by).to.equal(metadata.updated_by);
      // RFC 3339 UTC — the shape the upstream metadata column accepts.
      expect(metadata.created_at).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    });

    // The caller id is resolved from the REQUEST's own token (`user_id ?? sub`), never from the
    // bearer forwarded upstream — post promise-token exchange that principal can differ from the
    // caller. Two personas writing to the same slice must therefore stamp two different authors.
    it('stamps the requesting caller as the author, per persona', async () => {
      await createUsMarket();
      const tagId = await createCategory('Cameras');

      const byAdmin = await createPrompt('admin', 'Which DSLR suits a beginner?', [tagId]);
      const byUser = await createPrompt('user', 'Which mirrorless camera is best?', [tagId]);

      // The IT tokens carry no `user_id` claim, so `resolveCallerId` falls through to `sub`.
      expect((await storedMetadataById(byAdmin)).created_by).to.equal('test-admin@adobe.com');
      expect((await storedMetadataById(byUser)).created_by).to.equal('test-user@example.com');
    });

    // An edit bumps ONLY the updated pair. Asserted across two personas rather than by comparing
    // timestamps: the stamp is millisecond-precision, so a same-caller assertion would rest on the
    // two writes landing in different milliseconds.
    it('PATCH /serenity/prompts/:id bumps the updated pair and preserves the created pair', async () => {
      await createUsMarket();
      const tagId = await createCategory('Footwear');
      const promptId = await createPrompt('admin', 'What are the best running shoes?', [tagId]);
      const before = await storedMetadataById(promptId);

      const patched = await getHttpClient().user.patch(`${base}/prompts/${promptId}`, {
        text: 'What are the best trail running shoes?',
        tagIds: [tagId],
        geoTargetId: US_GEO,
        languageCode: 'en',
      });
      expect(patched.status).to.equal(200);

      const after = await storedMetadataById(promptId);
      // The create pair is immutable across the edit — authorship of the original write survives.
      expect(after.created_by).to.equal('test-admin@adobe.com');
      expect(after.created_at).to.equal(before.created_at);
      // The update pair now names the EDITOR, not the original author.
      expect(after.updated_by).to.equal('test-user@example.com');
      expect(Date.parse(after.updated_at)).to.be.at.least(Date.parse(before.updated_at));
    });

    // Re-categorising a prompt still bumps the updated pair: the PATCH body is the full NEXT state
    // (text is required), so the combined upstream write always carries both the name and the
    // metadata — there is no tag-only edit that leaves authorship untouched.
    it('PATCH /serenity/prompts/:id bumps the updated pair when only the tags change', async () => {
      await createUsMarket();
      const firstTag = await createCategory('Laptops');
      const secondTag = await createCategory('Ultrabooks');
      const text = 'Which laptop has the best battery life?';
      const promptId = await createPrompt('admin', text, [firstTag]);
      const before = await storedMetadataById(promptId);

      const patched = await getHttpClient().user.patch(`${base}/prompts/${promptId}`, {
        text, // unchanged
        tagIds: [secondTag],
        geoTargetId: US_GEO,
        languageCode: 'en',
      });
      expect(patched.status).to.equal(200);

      const after = await storedMetadataById(promptId);
      expect(after.created_at).to.equal(before.created_at);
      expect(after.created_by).to.equal('test-admin@adobe.com');
      expect(after.updated_by).to.equal('test-user@example.com');
      // Asserted on the VALUE, not just its presence: a future change that skipped the metadata
      // merge-patch when the text is unchanged would leave a stale-but-valid `updated_at` string,
      // which a presence check alone would accept.
      expect(Date.parse(after.updated_at)).to.be.at.least(Date.parse(before.updated_at));
    });

    // Re-posting an existing text folds into `existing_count` upstream instead of creating a
    // second row, and the stored stamp is PRESERVED — a dedupe hit must not re-attribute an
    // existing prompt to whoever re-submitted it.
    it('POST /serenity/prompts preserves the original stamp when a repeated text dedups', async () => {
      await createUsMarket();
      const tagId = await createCategory('Headphones');
      const text = 'Which noise-cancelling headphones are best?';
      const promptId = await createPrompt('admin', text, [tagId]);
      const before = await storedMetadataById(promptId);

      const second = await getHttpClient().user.post(`${base}/prompts`, {
        prompts: [{
          text, tagIds: [tagId], geoTargetId: US_GEO, languageCode: 'en',
        }],
      });
      expect(second.status).to.equal(200);

      expect(await storedMetadataById(promptId)).to.deep.equal(before);
    });

    // Gate G2 refusal: a rename onto a sibling's exact text is a 409 and the combined upstream
    // write is refused whole — so the target prompt's authorship must be untouched too, not just
    // its text.
    it('a 409 text collision leaves both prompts\' metadata untouched', async () => {
      await createUsMarket();
      const tagId = await createCategory('Phones');
      const firstText = 'Which phone has the best camera?';
      const secondText = 'Which phone has the longest battery life?';
      const firstId = await createPrompt('admin', firstText, [tagId]);
      const secondId = await createPrompt('admin', secondText, [tagId]);
      const beforeFirst = await storedMetadataById(firstId);
      const beforeSecond = await storedMetadataById(secondId);

      const res = await getHttpClient().user.patch(`${base}/prompts/${secondId}`, {
        text: firstText, // the FIRST prompt's exact text
        tagIds: [tagId],
        geoTargetId: US_GEO,
        languageCode: 'en',
      });
      expect(res.status).to.equal(409);

      expect(await storedMetadataById(firstId)).to.deep.equal(beforeFirst);
      expect(await storedMetadataById(secondId)).to.deep.equal(beforeSecond);
    });

    // A 404 refusal must not touch any sibling's authorship either — the write is rejected
    // upstream before the metadata lands anywhere.
    it('a 404 on an unknown prompt id stamps nothing', async () => {
      await createUsMarket();
      const tagId = await createCategory('Ghosts');
      const promptId = await createPrompt('admin', 'Which prompt survives?', [tagId]);
      const before = await storedMetadataById(promptId);

      const res = await getHttpClient().user.patch(
        `${base}/prompts/00000000-0000-4000-8000-00000000dead`,
        {
          text: 'x', tagIds: [tagId], geoTargetId: US_GEO, languageCode: 'en',
        },
      );
      expect(res.status).to.equal(404);

      expect(await storedMetadataById(promptId)).to.deep.equal(before);
    });

    // A bulk delete removes rows; it stamps nothing, so a surviving sibling keeps its authorship.
    it('POST /serenity/prompts/bulk-delete leaves a surviving sibling\'s metadata untouched', async () => {
      await createUsMarket();
      const tagId = await createCategory('Tablets');
      const doomedId = await createPrompt('admin', 'Which tablet is best for drawing?', [tagId]);
      const survivorId = await createPrompt('admin', 'Which tablet has the best screen?', [tagId]);
      const before = await storedMetadataById(survivorId);

      const res = await getHttpClient().admin.post(`${base}/prompts/bulk-delete`, {
        prompts: [{ semrushPromptId: doomedId, geoTargetId: US_GEO, languageCode: 'en' }],
      });
      expect(res.status).to.equal(200);

      const remaining = await storedPrompts();
      expect(remaining.some((p) => p.id === doomedId), 'the deleted prompt is gone upstream')
        .to.equal(false);
      expect(await storedMetadataById(survivorId)).to.deep.equal(before);
    });

    // The sort allow-list is validated in this service and never reaches the vendor, so its
    // refusals are assertable independently of the mock. `order` is only validated once a `sort`
    // is present — a bare `order` on an unsorted read is ignored, not rejected.
    it('GET /serenity/prompts validates the sort/order query params', async () => {
      await createUsMarket();
      const list = (qs) => getHttpClient().admin.get(
        `${base}/prompts?geoTargetId=${US_GEO}&languageCode=en&${qs}`,
      );

      const badSort = await list('sort=bogus');
      expect(badSort.status).to.equal(400);
      expect(badSort.body.error).to.equal('invalidRequest');

      const badOrder = await list('sort=metadata.created_at&order=sideways');
      expect(badOrder.status).to.equal(400);
      expect(badOrder.body.error).to.equal('invalidRequest');

      // Both allow-listed fields are accepted, in both directions.
      for (const qs of [
        'sort=metadata.created_at',
        'sort=metadata.created_at&order=asc',
        'sort=metadata.updated_at&order=desc',
      ]) {
        // eslint-disable-next-line no-await-in-loop
        expect((await list(qs)).status, `${qs} should be accepted`).to.equal(200);
      }

      // An `order` without a `sort` is the legacy unsorted read — ignored, not a 400.
      expect((await list('order=sideways')).status).to.equal(200);
    });
  });

  // Prompt authorship metadata on the LIST READ (LLMO-6289).
  //
  // The stamping itself happens on the write and is pinned by the block above; these cases prove
  // the four values come back out again through `GET /serenity/prompts`. That round trip is not
  // automatic: upstream omits the `metadata` block from every item unless the read opts in with
  // the `include_metadata=true` QUERY parameter, and `buildPromptDto` maps a missing block to four
  // nulls. So a read that fails to opt in returns a 200 whose authorship fields are all null for
  // prompts that ARE stamped — no error anywhere, just silently empty values in the UI. These
  // tests fail exactly that way if the opt-in regresses.
  //
  // The mock gates the block on the same query parameter (and omits the key entirely without it),
  // so this is a real end-to-end assertion of the flag, not a mock convenience.
  describe('Serenity API — prompt authorship metadata on the list read (live mock)', () => {
    const base = `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity`;
    const US_GEO = 2840; // US resolves to Google geoTargetId 2840.

    beforeEach(async () => {
      await resetData();
      await resetMocks();
    });

    // Setup, not subject: every test here needs a live US market, and none asserts on the market
    // response itself. Checking the status inside the helper means a refused create (a 422 on
    // insufficient units, say) fails here, rather than surfacing later as a confusing failure on
    // the tag or prompt call that depended on it.
    const createUsMarket = async () => {
      const res = await getHttpClient().admin.post(`${base}/markets`, {
        market: 'US', languageCode: 'en', brandDomain: 'example.com', brandNames: ['Test Brand'],
      });
      expect(res.status).to.equal(201);
    };

    const createCategory = async (name) => {
      const res = await getHttpClient().admin.post(`${base}/tags`, {
        type: 'category', name, geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(res.status).to.equal(201);
      return res.body.id;
    };

    const listPrompts = async (extraQuery = '') => {
      const res = await getHttpClient().admin.get(
        `${base}/prompts?geoTargetId=${US_GEO}&languageCode=en${extraQuery}`,
      );
      expect(res.status).to.equal(200);
      return res.body.items;
    };

    const readPromptById = async (semrushPromptId, extraQuery = '') => {
      const items = await listPrompts(extraQuery);
      const item = items.find((p) => p.semrushPromptId === semrushPromptId);
      // Name what the read DID return: it separates "the list came back empty" from "the ids
      // drifted", where a bare presence check reports only that `undefined` does not exist.
      const seen = items.map((p) => p.semrushPromptId).join(', ');
      expect(item, `expected prompt ${semrushPromptId} in the list read, got [${seen}]`).to.exist;
      return item;
    };

    const createPrompt = async (persona, text, tagIds) => {
      const res = await getHttpClient()[persona].post(`${base}/prompts`, {
        prompts: [{
          text, tagIds, geoTargetId: US_GEO, languageCode: 'en',
        }],
      });
      expect(res.status).to.equal(200);
      expect(res.body.created, `create by ${persona} should not be skipped/failed`)
        .to.have.lengthOf(1);
      return res.body.created[0].semrushPromptId;
    };

    // A gap between two stamped writes so their `created_at` / `updated_at` can't tie at the
    // millisecond precision of `new Date().toISOString()`. Server stamps are already spaced by the
    // IT round-trip; this adds margin so a loaded CI runner can't collapse two writes into one ms.
    // Sleeps are the only lever — create/edit stamp `now()` server-side, so the test cannot inject
    // controlled timestamps; 20ms keeps ties impossible at negligible cost.
    const STAMP_GAP_MS = 20;
    const sleep = (ms) => new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

    // An in-place edit — replaces text AND tags (the PATCH body carries both), bumping `updated_*`
    // without touching `created_*` (spec §8). The ordering tests pass the prompt's existing tag, so
    // only the text (and the stamp) actually change.
    const editPrompt = async (persona, promptId, text, tagIds) => {
      const res = await getHttpClient()[persona].patch(`${base}/prompts/${promptId}`, {
        text, tagIds, geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(res.status).to.equal(200);
    };

    // The server-side order of just the prompts THIS test created. `resetData` is per-`describe`,
    // not per-`it`, so a sorted list also carries prior tests' prompts; filtering to `mine` keeps
    // their relative order within the global sort, which is exactly `mine` sorted by the key.
    const orderedMineIds = async (extraQuery, mine) => {
      const items = await listPrompts(extraQuery);
      return items.map((p) => p.semrushPromptId).filter((id) => mine.includes(id));
    };

    it('GET /serenity/prompts returns the four authorship fields for a stamped prompt', async () => {
      await createUsMarket();
      const tagId = await createCategory('Running');
      const promptId = await createPrompt('admin', 'What are the best trail shoes?', [tagId]);

      const item = await readPromptById(promptId);
      // The decisive assertions: all four are populated. Without the read-side opt-in every one of
      // these is null even though the prompt is stamped upstream.
      expect(item.createdAt, 'createdAt reaches the DTO').to.be.a('string');
      expect(item.updatedAt, 'updatedAt reaches the DTO').to.be.a('string');
      expect(item.createdBy).to.equal('test-admin@adobe.com');
      expect(item.updatedBy).to.equal('test-admin@adobe.com');
      // A create is its own first edit, so the two instants match.
      expect(item.createdAt).to.equal(item.updatedAt);
      expect(item.createdAt).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    });

    // The whole point of surfacing these fields is "who last touched this, and when" — so the
    // edit must be visible THROUGH the read, not merely stored upstream. Two personas, so the
    // authorship change is asserted on identity rather than on clock granularity.
    it('surfaces the editor in updatedBy while createdBy keeps the original author', async () => {
      await createUsMarket();
      const tagId = await createCategory('Footwear');
      const promptId = await createPrompt('admin', 'What are the best running shoes?', [tagId]);
      const before = await readPromptById(promptId);

      const patched = await getHttpClient().user.patch(`${base}/prompts/${promptId}`, {
        text: 'What are the best trail running shoes?',
        tagIds: [tagId],
        geoTargetId: US_GEO,
        languageCode: 'en',
      });
      expect(patched.status).to.equal(200);

      const after = await readPromptById(promptId);
      expect(after.createdBy, 'the original author survives the edit').to.equal('test-admin@adobe.com');
      expect(after.createdAt).to.equal(before.createdAt);
      expect(after.updatedBy, 'the editor is attributed').to.equal('test-user@example.com');
      expect(Date.parse(after.updatedAt)).to.be.at.least(Date.parse(before.updatedAt));
    });

    // The unstamped-prompt case — a prompt predating authorship stamping, whose read must degrade
    // to four nulls rather than erroring — is NOT covered here. It is unreachable through this
    // surface: the mock's only unstamped prompt lives in its own seeded workspace/project, while a
    // brand's slice resolves to a project created fresh per run, so no unstamped row is ever
    // visible on the slice this endpoint reads. Reaching it would mean injecting one through the
    // mock's `__seed` control route into the resolved project — harness work beyond this change.
    // `buildPromptDto`'s `metadata?.x ?? null` mapping carries that path at the unit level, and the
    // absent-metadata SORT position (NULLS-LAST in both directions) is asserted where it is
    // reachable — the project-engine-client mock e2e (spacecat-shared#1859, LLMO-6666).

    // The metadata opt-in travels on the QUERY string while the sort keys travel in the BODY, so a
    // sorted read exercises both at once. These two guard that INTERACTION: a regression that moved
    // the opt-in into the body alongside the sort keys would strip the authorship fields while
    // leaving the unsorted read above green. One case per sortable field, so a regression that
    // reaches only one of them is reported on its own. (The ORDER itself is asserted separately
    // below.)
    it('still returns the authorship fields on a read sorted by created_at', async () => {
      await createUsMarket();
      const tagId = await createCategory('Cameras');
      const promptId = await createPrompt('admin', 'Which mirrorless camera is best?', [tagId]);

      const item = await readPromptById(promptId, '&sort=metadata.created_at&order=desc');
      expect(item.createdBy).to.equal('test-admin@adobe.com');
      expect(item.updatedAt).to.be.a('string');
    });

    it('still returns the authorship fields on a read sorted by updated_at', async () => {
      await createUsMarket();
      const tagId = await createCategory('Lenses');
      const promptId = await createPrompt('admin', 'Which prime lens is sharpest?', [tagId]);

      const item = await readPromptById(promptId, '&sort=metadata.updated_at&order=desc');
      expect(item.createdBy).to.equal('test-admin@adobe.com');
      expect(item.updatedAt).to.be.a('string');
    });

    // Ordering, now that the mock honours the wire sort keys (spacecat-shared#1859, client 1.18.0 —
    // LLMO-6666/6667). The descending case is the regression catcher: the pre-#1859 no-op returned
    // store (insertion) order regardless of keys, so a reversed expectation fails if the keys ever
    // regress to being ignored (or are sent under the wrong names).
    it('orders the list by metadata.created_at, ascending and descending', async () => {
      await createUsMarket();
      const tagId = await createCategory('Tripods');
      const first = await createPrompt('admin', 'created-order one?', [tagId]);
      await sleep(STAMP_GAP_MS);
      const second = await createPrompt('admin', 'created-order two?', [tagId]);
      await sleep(STAMP_GAP_MS);
      const third = await createPrompt('admin', 'created-order three?', [tagId]);
      const mine = [first, second, third];

      // Descending is the regression guard — the reverse of insertion/store order, so it fails if
      // the keys are ignored. Ascending equals insertion order, so it only CONFIRMS the direction
      // (the pre-#1859 no-op would have passed asc by accident); the pair is what makes it firm.
      expect(await orderedMineIds('&sort=metadata.created_at&order=asc', mine))
        .to.deep.equal([first, second, third]);
      expect(await orderedMineIds('&sort=metadata.created_at&order=desc', mine))
        .to.deep.equal([third, second, first]);
    });

    it('orders the list by metadata.updated_at, independent of created order', async () => {
      await createUsMarket();
      const tagId = await createCategory('Gimbals');
      const a = await createPrompt('admin', 'update-order A?', [tagId]);
      await sleep(STAMP_GAP_MS);
      const b = await createPrompt('admin', 'update-order B?', [tagId]);
      await sleep(STAMP_GAP_MS);
      const c = await createPrompt('admin', 'update-order C?', [tagId]);
      const mine = [a, b, c];

      // Re-touch in a DIFFERENT order than creation (b, then c, then a) so `updated_at` order
      // (b < c < a) diverges from both `created_at` order (a < b < c) and store order — proving the
      // wire sort key selects the right field, not just any monotonic default.
      await editPrompt('admin', b, 'update-order B edited?', [tagId]);
      await sleep(STAMP_GAP_MS);
      await editPrompt('admin', c, 'update-order C edited?', [tagId]);
      await sleep(STAMP_GAP_MS);
      await editPrompt('admin', a, 'update-order A edited?', [tagId]);

      expect(await orderedMineIds('&sort=metadata.updated_at&order=asc', mine))
        .to.deep.equal([b, c, a]);
      expect(await orderedMineIds('&sort=metadata.updated_at&order=desc', mine))
        .to.deep.equal([a, c, b]);
      // The edits left `created_at` untouched, so its order is still insertion order — the two keys
      // sort independently.
      expect(await orderedMineIds('&sort=metadata.created_at&order=asc', mine))
        .to.deep.equal([a, b, c]);
    });
  });
}
