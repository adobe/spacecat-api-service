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
export default function serenityTests(getHttpClient, resetData, resetMocks = async () => {}) {
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
      expect(res.body.tag).to.equal('category:Footwear');
      expect(res.body.geoTargetId).to.equal(US_GEO);
      expect(res.body.languageCode).to.equal('en');
      // The create echoes the upstream tag id (needed to nest / re-parent).
      expect(res.body.id).to.be.a('string').that.is.not.empty;
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

      const child = await createTag('Sneakers', parentId);
      expect(child.status).to.equal(201);
      // A child is created BARE (no dimension prefix) — mirrors the migration CLI's
      // write shape (serenity-docs#24 §2); only roots keep the `category:` prefix.
      expect(child.body.tag).to.equal('Sneakers');
      // parent_id echoes back through the JSON body faithfully — the child is nested.
      expect(child.body.parentId).to.equal(parentId);

      // Roots view (parentId=''): the parent lists as a root (parentId null) and its
      // childrenCount — derived server-side from the stored parentage — reflects the new child.
      const roots = await getHttpClient().admin.get(
        `${base}/tags?geoTargetId=${US_GEO}&languageCode=en&parentId=`,
      );
      expect(roots.status).to.equal(200);
      const parentRow = roots.body.items.find((t) => t.id === parentId);
      expect(parentRow, 'the parent should list among the roots').to.exist;
      expect(parentRow.parentId).to.equal(null);
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

    it('PATCH /serenity/tags/:tagId renames a child by id (URL-safe id round-trips through the path)', async () => {
      await createUsMarket();
      const parent = await createTag('Footwear');
      const child = await createTag('Sneakers', parent.body.id);
      const childId = child.body.id;

      // Rename-only: parentId omitted — the proxy must re-send the child's current parent itself
      // (gate 5) so the child stays nested, not promoted to root.
      const renamed = await getHttpClient().admin.patch(`${base}/tags/${childId}`, {
        name: 'Boots', geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(renamed.status).to.equal(200);
      expect(renamed.body.tag).to.equal('Boots');
      expect(renamed.body.parentId).to.equal(parent.body.id);

      // Promote to root: explicit parentId: null (gate 1).
      const promoted = await getHttpClient().admin.patch(`${base}/tags/${childId}`, {
        name: 'Boots', parentId: null, geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(promoted.status).to.equal(200);
      expect(promoted.body.parentId).to.equal(null);
    });

    it('PATCH /serenity/tags/:tagId route reaches upstream (unknown id → 502)', async () => {
      await createUsMarket();
      // A UUID tag id the mock has never stored → upstream 404, which the serenity proxy
      // deliberately collapses to 502 (mapError does not echo upstream detail — same convention as
      // every other serenity write). Proves the PATCH route → controller → handler → transport →
      // upstream wiring for a genuinely unknown id (the known-id round trip is covered above).
      const res = await getHttpClient().admin.patch(
        `${base}/tags/00000000-0000-4000-8000-000000000000`,
        { name: 'category:Ghost', geoTargetId: US_GEO, languageCode: 'en' },
      );
      expect(res.status).to.equal(502);
    });

    it('POST /serenity/tags resolves a closed-dimension tag idempotently (source/intent/type)', async () => {
      await createUsMarket();
      const first = await getHttpClient().admin.post(`${base}/tags`, {
        type: 'source', name: 'ai', geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(first.status).to.equal(200);
      expect(first.body).to.include({ tag: 'source:ai', created: true });
      expect(first.body.id).to.be.a('string').that.is.not.empty;

      // Same closed-dimension value again — resolved, not re-created (no upstream collision).
      const second = await getHttpClient().admin.post(`${base}/tags`, {
        type: 'source', name: 'ai', geoTargetId: US_GEO, languageCode: 'en',
      });
      expect(second.status).to.equal(200);
      expect(second.body).to.include({ tag: 'source:ai', id: first.body.id, created: false });
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
      // The write path now server-computes a branded/non-branded `type:` tag and
      // appends it to the supplied tagIds, so the created prompt carries the two
      // supplied tags plus one computed type tag.
      expect(created.body.created[0].tagIds).to.include.members([category.body.id, child.body.id]);
      expect(created.body.created[0].tagIds).to.have.lengthOf(3);
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
    });

    it('GET /serenity/markets/:geo/:lang resolves a created+published market', async () => {
      const created = await createUsMarket();
      const res = await getHttpClient().admin.get(`${base}/markets/${US_GEO}/en`);
      expect(res.status).to.equal(200);
      expect(res.body.geoTargetId).to.equal(US_GEO);
      expect(res.body.languageCode).to.equal('en');
      expect(res.body.semrushProjectId).to.equal(created.body.projectId);
    });

    it('POST /serenity/prompts attaches a prompt to the created slice, then lists it', async () => {
      await createUsMarket();
      const text = 'What are the best trail running shoes?';
      const post = await getHttpClient().admin.post(`${base}/prompts`, {
        prompts: [{ text, geoTargetId: US_GEO, languageCode: 'en' }],
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

    it('POST /serenity/prompts dedups a repeated prompt text on the same slice', async () => {
      await createUsMarket();
      const text = 'Which laptop has the best battery life?';
      const body = { prompts: [{ text, geoTargetId: US_GEO, languageCode: 'en' }] };
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
  });
}
