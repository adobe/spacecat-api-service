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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Integration tests for category identity and the category prompt-count filter.
 *
 * The legacy `categories.category_id` TEXT business key has been retired
 * (LLMO-5515). Categories are now addressed exclusively by their `categories.id`
 * UUID primary key, and the prompt-list `categoryId` filter resolves against
 * that UUID and FAILS CLOSED — a categoryId that does not resolve returns an
 * empty page rather than the brand's full prompt set. The original bug: a
 * UUID-shaped business key resolved to no row, the filter was silently dropped,
 * and a brand-new (e.g. Japanese-named) category showed a phantom prompt count
 * equal to every prompt for the brand.
 *
 * Validates:
 * 1. Category create returns a UUID `id` (== `uuid`), idempotent by name.
 * 2. A non-ASCII (multibyte) category name is stored and listed without error.
 * 3. The prompt-list `categoryId` filter resolves by UUID and fails closed for
 *    unknown UUIDs and for non-UUID values (no phantom counts).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function categoriesPromptsTests(getHttpClient, resetData) {
  describe('Categories & Prompts (UUID identity, LLMO-5515)', () => {
    // ── Category identity is a UUID, idempotent by name ──

    describe('Category create returns a UUID id and is idempotent by name', () => {
      before(() => resetData());

      it('returns a UUID id on create and the same id on idempotent re-post', async () => {
        const http = getHttpClient();

        const payload = { name: 'Comparison & Decision', origin: 'ai' };

        // First POST — inserts a new row, server assigns the UUID primary key.
        const res1 = await http.admin.post(`/v2/orgs/${ORG_1_ID}/categories`, payload);
        expect(res1.status).to.equal(201);
        expect(res1.body.id).to.match(UUID_RE);
        expect(res1.body.uuid).to.equal(res1.body.id);
        expect(res1.body.name).to.equal('Comparison & Decision');
        const { id: categoryUuid } = res1.body;

        // Second POST with the same name — idempotent by name, returns 200 and
        // the SAME stable UUID. No client-supplied identifier is honored.
        const res2 = await http.admin.post(`/v2/orgs/${ORG_1_ID}/categories`, payload);
        expect(res2.status).to.equal(200);
        expect(res2.body.id).to.equal(categoryUuid);

        // Only ONE category exists — no duplicate.
        const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/categories`);
        expect(listRes.status).to.equal(200);
        const matches = listRes.body.categories.filter((c) => c.name === 'Comparison & Decision');
        expect(matches).to.have.lengthOf(1);
        expect(matches[0].id).to.equal(categoryUuid);
        expect(matches[0].origin).to.equal('ai');
      });

      it('ignores a client-supplied id — the UUID primary key is authoritative', async () => {
        const http = getHttpClient();

        const res = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { id: 'baseurl-discovery-research', name: 'Discovery & Research', origin: 'ai' },
        );
        expect(res.status).to.equal(201);
        // The stray slug-shaped id is NOT used; the returned id is a UUID.
        expect(res.body.id).to.match(UUID_RE);
        expect(res.body.id).to.not.equal('baseurl-discovery-research');
        expect(res.body.name).to.equal('Discovery & Research');
      });
    });

    // ── Multibyte names (the cohort that surfaced the bug) ──

    describe('Multibyte category names are stored and listed without error', () => {
      before(() => resetData());

      it('creates a Japanese-named category with a UUID id', async () => {
        const http = getHttpClient();

        const res = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { name: '日本語カテゴリ', origin: 'human' },
        );
        expect(res.status).to.equal(201);
        expect(res.body.id).to.match(UUID_RE);
        expect(res.body.name).to.equal('日本語カテゴリ');

        const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/categories`);
        expect(listRes.status).to.equal(200);
        const matches = listRes.body.categories.filter((c) => c.name === '日本語カテゴリ');
        expect(matches).to.have.lengthOf(1);
        expect(matches[0].id).to.equal(res.body.id);
      });
    });

    // ── The category prompt-count filter (the LLMO-5515 regression guard) ──

    describe('Prompt-list categoryId filter resolves by UUID and fails closed', () => {
      before(() => resetData());

      it('returns only the prompts linked to the category, and an empty page for unresolved filters', async () => {
        const http = getHttpClient();

        // 1. Create a category; capture its UUID.
        const catRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { name: 'Editing', origin: 'human' },
        );
        expect(catRes.status).to.equal(201);
        const categoryUuid = catRes.body.id;
        expect(categoryUuid).to.match(UUID_RE);

        // 2. Post two prompts under that category (linked by category name) and
        //    one prompt with NO category.
        const promptRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts`,
          [
            { prompt: 'How do I crop an image?', regions: ['us'], category: 'Editing' },
            { prompt: 'How do I remove a background?', regions: ['us'], category: 'Editing' },
            { prompt: 'Unrelated prompt with no category', regions: ['us'] },
          ],
        );
        expect(promptRes.status).to.equal(201);
        expect(promptRes.body.created).to.equal(3);

        // 3. Filtering by the real category UUID returns exactly the two linked
        //    prompts — and their embedded category.id / .uuid is that UUID.
        const filtered = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts?categoryId=${categoryUuid}`,
        );
        expect(filtered.status).to.equal(200);
        expect(filtered.body.total).to.equal(2);
        expect(filtered.body.items).to.have.lengthOf(2);
        filtered.body.items.forEach((p) => {
          expect(p.category.id).to.equal(categoryUuid);
          expect(p.category.uuid).to.equal(categoryUuid);
        });

        // 4. No filter returns all three prompts — proving the filter above
        //    actually narrowed the set rather than the brand being empty.
        const unfiltered = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts`,
        );
        expect(unfiltered.status).to.equal(200);
        expect(unfiltered.body.total).to.equal(3);

        // 5. FAIL CLOSED: a valid-but-unknown category UUID returns an EMPTY
        //    page — never the brand's full prompt set (the LLMO-5515 phantom
        //    count). This is the core regression guard.
        const unknownUuid = 'f0000000-0000-4000-b000-000000000000';
        const unknown = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts?categoryId=${unknownUuid}`,
        );
        expect(unknown.status).to.equal(200);
        expect(unknown.body.total).to.equal(0);
        expect(unknown.body.items).to.have.lengthOf(0);

        // 6. FAIL CLOSED: a non-UUID categoryId (e.g. a legacy business key)
        //    also returns an empty page — business keys are retired.
        const legacyKey = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts?categoryId=baseurl-editing`,
        );
        expect(legacyKey.status).to.equal(200);
        expect(legacyKey.body.total).to.equal(0);
        expect(legacyKey.body.items).to.have.lengthOf(0);
      });
    });

    // ── The region/market filter is case-insensitive (LLMO-5755) ──

    describe('Prompt-list region filter matches case-insensitively', () => {
      before(() => resetData());

      it('matches prompts whose stored region casing differs from the query', async () => {
        const http = getHttpClient();

        // Region codes are persisted with mixed casing: onboard-llmo and
        // Serenity provisioning store them UPPERCASE, while CSV / config-mapper
        // imports store them lowercase. The UI always sends the code lowercased.
        // Store one prompt UPPERCASE and one lowercase, then filter with the
        // lowercased code — both must come back. A case-sensitive containment
        // (the pre-LLMO-5755 behaviour) returned nothing for the uppercase row,
        // which is what made the Creditsafe market filter look broken.
        const created = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts`,
          [
            { prompt: 'Uppercase region prompt', regions: ['US'] },
            { prompt: 'Lowercase region prompt', regions: ['us'] },
            { prompt: 'Other region prompt', regions: ['gb'] },
          ],
        );
        expect(created.status).to.equal(201);
        expect(created.body.created).to.equal(3);

        // Lowercase query returns BOTH the US and us rows, not the gb one.
        const filtered = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts?region=us`,
        );
        expect(filtered.status).to.equal(200);
        expect(filtered.body.total).to.equal(2);
        expect(filtered.body.items).to.have.lengthOf(2);

        // Uppercase query is symmetric — also returns both rows.
        const filteredUpper = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts?region=US`,
        );
        expect(filteredUpper.status).to.equal(200);
        expect(filteredUpper.body.total).to.equal(2);

        // No filter returns all three — proving the filter narrowed the set
        // rather than the brand simply having those prompts.
        const unfiltered = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts`,
        );
        expect(unfiltered.status).to.equal(200);
        expect(unfiltered.body.total).to.equal(3);
      });
    });

    // ── Multibyte / non-ASCII-only names (LLMO-5515) ──

    describe('Category creation with an all-multibyte name (no explicit id)', () => {
      before(() => resetData());

      it('creates a CJK-named category with a UUID id, and is idempotent by name', async () => {
        const http = getHttpClient();

        // An all-multibyte name (no ASCII alphanumerics) once collapsed to a
        // degenerate slug and surfaced as HTTP 500. We no longer derive a slug
        // at all (LLMO-5515): the UUID primary key is the only identifier, so
        // the create just succeeds and the returned id is the server UUID.
        const res1 = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { name: 'カテゴリ' },
        );
        expect(res1.status).to.equal(201);
        expect(res1.body.name).to.equal('カテゴリ');
        expect(res1.body.id).to.match(UUID_RE);

        const generatedId = res1.body.id;

        // Idempotent by name: re-posting the same name resolves the existing
        // row (same UUID id) and returns 200.
        const res2 = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { name: 'カテゴリ' },
        );
        expect(res2.status).to.equal(200);
        expect(res2.body.id).to.equal(generatedId);

        // Exactly one category exists, name preserved verbatim, stable id.
        const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/categories`);
        expect(listRes.status).to.equal(200);

        const matches = listRes.body.categories.filter((c) => c.name === 'カテゴリ');
        expect(matches).to.have.lengthOf(1);
        expect(matches[0].id).to.equal(generatedId);
      });
    });
  });
}
