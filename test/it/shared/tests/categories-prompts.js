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
 * Integration tests for the category slug-as-name bug (LLMO-4060).
 *
 * Validates:
 * 1. Fallback path: POST categories without id, then prompts with prefixed categoryId
 *    — the auto-created fallback should get a readable name (slugToName), not the raw slug
 * 2. Fix verification: POST categories with explicit id preserves name, no duplicates
 * 3. Idempotency: duplicate category creation upserts (201), not conflicts (409)
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function categoriesPromptsTests(getHttpClient, resetData) {
  describe('Categories & Prompts (LLMO-4060)', () => {
    // ── Fallback path (slugToName defense-in-depth) ──

    describe('Fallback: POST categories without id then prompts with prefixed categoryId', () => {
      before(() => resetData());

      it('auto-created fallback category has a readable name, not the raw slug', async () => {
        const http = getHttpClient();

        // 1. Create a category WITHOUT an explicit id — API auto-derives slug from name
        const catRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { name: 'Comparison & Decision', origin: 'ai' },
        );
        expect(catRes.status).to.equal(201);
        expect(catRes.body.id).to.equal('comparison-decision');
        expect(catRes.body.name).to.equal('Comparison & Decision');

        // 2. Post prompts referencing a PREFIXED categoryId that doesn't match the stored slug
        const promptRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts`,
          [
            {
              prompt: 'What is the best tool for comparison?',
              regions: ['us'],
              categoryId: 'baseurl-comparison-decision',
            },
          ],
        );
        expect(promptRes.status).to.equal(201);
        expect(promptRes.body.created).to.equal(1);

        // 3. List all categories — the auto-created fallback should have a readable name
        const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/categories`);
        expect(listRes.status).to.equal(200);

        const cats = listRes.body.categories;
        const fallback = cats.find((c) => c.id === 'baseurl-comparison-decision');
        expect(fallback, 'fallback category should exist').to.be.an('object');
        // slugToName strips "baseurl-" prefix and joins with " & "
        expect(fallback.name).to.equal('Comparison & Decision');
        expect(fallback.origin).to.equal('human');
      });
    });

    // ── Fix verification ──

    describe('Fix: POST categories with explicit id', () => {
      before(() => resetData());

      it('stores category with the provided id and preserves the readable name', async () => {
        const http = getHttpClient();

        // 1. Create category WITH explicit id (the DRS fix)
        const catRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { id: 'baseurl-discovery-research', name: 'Discovery & Research', origin: 'ai' },
        );
        expect(catRes.status).to.equal(201);
        expect(catRes.body.id).to.equal('baseurl-discovery-research');
        expect(catRes.body.name).to.equal('Discovery & Research');

        // 2. Post prompts referencing the same prefixed categoryId
        const promptRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts`,
          [
            {
              prompt: 'How do users discover products?',
              regions: ['us'],
              categoryId: 'baseurl-discovery-research',
            },
          ],
        );
        expect(promptRes.status).to.equal(201);
        expect(promptRes.body.created).to.equal(1);

        // 3. Verify: only ONE category with that id, name is the readable one
        const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/categories`);
        expect(listRes.status).to.equal(200);

        const cats = listRes.body.categories;
        const matches = cats.filter((c) => c.id === 'baseurl-discovery-research');
        expect(matches).to.have.lengthOf(1);
        expect(matches[0].name).to.equal('Discovery & Research');
        expect(matches[0].origin).to.equal('ai');
      });
    });

    // ── Idempotency ──

    describe('Category creation with id is idempotent (upsert)', () => {
      before(() => resetData());

      it('second POST with same id upserts without error', async () => {
        const http = getHttpClient();

        const payload = { id: 'baseurl-test', name: 'Test', origin: 'ai' };

        const res1 = await http.admin.post(`/v2/orgs/${ORG_1_ID}/categories`, payload);
        expect(res1.status).to.equal(201);

        // Second call — the API uses upsert, so same id should succeed
        const res2 = await http.admin.post(`/v2/orgs/${ORG_1_ID}/categories`, payload);
        expect(res2.status).to.equal(201);

        // Verify only one category exists with that id
        const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/categories`);
        expect(listRes.status).to.equal(200);

        const matches = listRes.body.categories.filter((c) => c.id === 'baseurl-test');
        expect(matches).to.have.lengthOf(1);
        expect(matches[0].name).to.equal('Test');
      });
    });
  });
}
