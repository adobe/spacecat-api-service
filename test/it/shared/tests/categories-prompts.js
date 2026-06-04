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
 * 1. Fallback path: category exists with unprefixed slug, prompt references prefixed slug
 *    — the fallback strips the DRS prefix and resolves to the existing category
 * 2. Fix verification: POST categories with explicit id preserves name, no duplicates
 * 3. Idempotency: duplicate category creation returns 200 (idempotent update),
 *    not 201 (insert). See LLMO-4370 — the status-code contract flipped from
 *    `201|409` (old upsert) to `200|201` (idempotent-by-name), so callers can
 *    discriminate a fresh row from a re-post without parsing the body.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function categoriesPromptsTests(getHttpClient, resetData) {
  describe('Categories & Prompts (LLMO-4060)', () => {
    // ── Fallback path (slugToName defense-in-depth) ──

    describe('Fallback: category exists with unprefixed slug, prompt references prefixed slug', () => {
      before(() => resetData());

      it('resolves to the existing category via unprefixed slug lookup', async () => {
        const http = getHttpClient();

        // 1. Create a category WITHOUT an explicit id — API auto-derives slug from name
        //    Stored category_id = "comparison-decision" (no prefix)
        const catRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/categories`,
          { name: 'Comparison & Decision', origin: 'ai' },
        );
        expect(catRes.status).to.equal(201);
        expect(catRes.body.id).to.equal('comparison-decision');

        // 2. Post prompts referencing "baseurl-comparison-decision" (prefixed slug).
        //    Upsert fails (name collision), fallback strips prefix and finds
        //    the existing "comparison-decision" category.
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

        // 3. Only ONE category should exist — no duplicate created
        const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/categories`);
        expect(listRes.status).to.equal(200);

        const cats = listRes.body.categories;
        const matches = cats.filter((c) => c.name === 'Comparison & Decision');
        expect(matches).to.have.lengthOf(1);
        expect(matches[0].id).to.equal('comparison-decision');
        expect(matches[0].origin).to.equal('ai');
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

    describe('Category creation is idempotent by name (200 on re-post)', () => {
      before(() => resetData());

      it('second POST with the same name returns 200 (idempotent update)', async () => {
        const http = getHttpClient();

        const payload = { id: 'baseurl-test', name: 'Test', origin: 'ai' };

        const res1 = await http.admin.post(`/v2/orgs/${ORG_1_ID}/categories`, payload);
        expect(res1.status).to.equal(201);

        // Second call — idempotent by name: the existing row is matched,
        // no-op short-circuits (identical fields), response is 200. This
        // lets DRS-class clients discriminate "created new" from "ensured
        // existing" without parsing the body. LLMO-4370.
        const res2 = await http.admin.post(`/v2/orgs/${ORG_1_ID}/categories`, payload);
        expect(res2.status).to.equal(200);

        // Only one category exists — no duplicate.
        const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/categories`);
        expect(listRes.status).to.equal(200);

        const matches = listRes.body.categories.filter((c) => c.id === 'baseurl-test');
        expect(matches).to.have.lengthOf(1);
        expect(matches[0].name).to.equal('Test');
      });
    });

    // ── Prompt intent field (LLMO-5161) ──

    describe('Prompt intent: upsert, retrieve, and filter', () => {
      before(() => resetData());

      it('upserted prompt with intent is returned in list and single-get responses', async () => {
        const http = getHttpClient();

        // 1. Upsert two prompts: one with intent, one without
        const upsertRes = await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts`,
          [
            {
              id: 'intent-test-prompt-1',
              prompt: 'What are the best laptops for students?',
              regions: ['us'],
              intent: 'informational',
            },
            {
              id: 'intent-test-prompt-2',
              prompt: 'Buy the best laptop now',
              regions: ['us'],
              intent: 'transactional',
            },
            {
              id: 'intent-test-prompt-3',
              prompt: 'No intent prompt',
              regions: ['us'],
            },
          ],
        );
        expect(upsertRes.status).to.equal(201);
        expect(upsertRes.body.created).to.equal(3);

        // 2. Single-get preserves intent
        const getRes = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts/intent-test-prompt-1`,
        );
        expect(getRes.status).to.equal(200);
        expect(getRes.body.intent).to.equal('informational');

        // 3. List without filter returns all three
        const listAll = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts`,
        );
        expect(listAll.status).to.equal(200);
        const allIds = listAll.body.items.map((p) => p.id);
        expect(allIds).to.include('intent-test-prompt-1');
        expect(allIds).to.include('intent-test-prompt-2');
        expect(allIds).to.include('intent-test-prompt-3');

        // 4. Filter by intent=informational returns only the matching prompt
        const listFiltered = await http.admin.get(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts?intent=informational`,
        );
        expect(listFiltered.status).to.equal(200);
        const filteredIds = listFiltered.body.items.map((p) => p.id);
        expect(filteredIds).to.include('intent-test-prompt-1');
        expect(filteredIds).to.not.include('intent-test-prompt-2');
        expect(filteredIds).to.not.include('intent-test-prompt-3');
        const filteredPrompt = listFiltered.body.items.find((p) => p.id === 'intent-test-prompt-1');
        expect(filteredPrompt.intent).to.equal('informational');

        // 5. Prompt without intent has null intent field
        const noIntentPrompt = listAll.body.items.find((p) => p.id === 'intent-test-prompt-3');
        expect(noIntentPrompt).to.exist;
        expect(noIntentPrompt.intent).to.be.null;
      });

      it('PATCH updates intent and null-clears it', async () => {
        const http = getHttpClient();

        // Seed a prompt with intent
        await http.admin.post(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts`,
          [{
            id: 'intent-patch-prompt', prompt: 'Compare these two tools', regions: ['us'], intent: 'comparative',
          }],
        );

        // PATCH to a different intent
        const patchRes = await http.admin.patch(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts/intent-patch-prompt`,
          { intent: 'planning' },
        );
        expect(patchRes.status).to.equal(200);
        expect(patchRes.body.intent).to.equal('planning');

        // PATCH to clear intent
        const clearRes = await http.admin.patch(
          `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/prompts/intent-patch-prompt`,
          { intent: null },
        );
        expect(clearRes.status).to.equal(200);
        expect(clearRes.body.intent).to.be.null;
      });
    });
  });
}
