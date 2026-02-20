/*
 * Copyright 2025 Adobe. All rights reserved.
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
import { expectISOTimestamp, expectBatch207 } from '../helpers/assertions.js';
import {
  SITE_1_ID,
  SITE_3_ID,
  OPPTY_1_ID,
  OPPTY_2_ID,
  OPPTY_3_ID,
  SUGG_1_ID,
  SUGG_2_ID,
  FIX_1_ID,
  NON_EXISTENT_SUGG_ID,
} from '../seed-ids.js';

const BASE = `/sites/${SITE_1_ID}/opportunities/${OPPTY_1_ID}/suggestions`;
const DENIED_BASE = `/sites/${SITE_3_ID}/opportunities/${OPPTY_3_ID}/suggestions`;

/**
 * Asserts that an object has the SuggestionDto shape (full view).
 */
function expectSuggestionDto(suggestion) {
  expect(suggestion).to.be.an('object');
  expect(suggestion.id).to.be.a('string');
  expect(suggestion.opportunityId).to.be.a('string');
  expect(suggestion.type).to.be.a('string');
  expect(suggestion.rank).to.be.a('number');
  expect(suggestion.status).to.be.a('string');
  expect(suggestion).to.have.property('data');
  expectISOTimestamp(suggestion.createdAt, 'createdAt');
  expectISOTimestamp(suggestion.updatedAt, 'updatedAt');
}

/**
 * Shared Suggestion endpoint tests.
 * Runs identically against both DynamoDB (v2) and PostgreSQL (v3).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function suggestionTests(getHttpClient, resetData) {
  describe('Suggestions', () => {
    // ── Read endpoints ──

    describe('GET .../suggestions', () => {
      before(() => resetData());

      it('user: returns suggestions for opportunity', async () => {
        const http = getHttpClient();
        const res = await http.user.get(BASE);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(3);
        res.body.forEach((s) => expectSuggestionDto(s));
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(DENIED_BASE);
        expect(res.status).to.equal(403);
      });

      it('user: returns empty for opportunity with no suggestions', async () => {
        const http = getHttpClient();
        const res = await http.user.get(
          `/sites/${SITE_1_ID}/opportunities/${OPPTY_2_ID}/suggestions`,
        );
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });
    });

    describe('GET .../suggestions/paged/:limit', () => {
      before(() => resetData());

      it('user: returns paginated suggestions', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/paged/2`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        expect(res.body.suggestions).to.be.an('array').with.lengthOf(2);
        expect(res.body.pagination).to.be.an('object');
        expect(res.body.pagination.limit).to.equal(2);
        expect(res.body.pagination.hasMore).to.equal(true);
      });

      it('user: returns second page with cursor', async () => {
        const http = getHttpClient();
        // Get first page to obtain cursor
        const page1 = await http.user.get(`${BASE}/paged/2`);
        expect(page1.status).to.equal(200);
        const { cursor } = page1.body.pagination;
        expect(cursor).to.be.a('string');

        // Get second page
        const page2 = await http.user.get(`${BASE}/paged/2/${cursor}`);
        expect(page2.status).to.equal(200);
        expect(page2.body.suggestions).to.be.an('array').with.lengthOf(1);
        expect(page2.body.pagination.hasMore).to.equal(false);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${DENIED_BASE}/paged/10`);
        expect(res.status).to.equal(403);
      });
    });

    describe('GET .../suggestions/by-status/:status', () => {
      before(() => resetData());

      it('user: returns suggestions filtered by status', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/by-status/NEW`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);
        res.body.forEach((s) => {
          expectSuggestionDto(s);
          expect(s.status).to.equal('NEW');
        });
      });

      it('user: returns empty for status with no matches', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/by-status/SKIPPED`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${DENIED_BASE}/by-status/NEW`);
        expect(res.status).to.equal(403);
      });
    });

    describe('GET .../suggestions/:suggestionId', () => {
      before(() => resetData());

      it('user: returns specific suggestion', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/${SUGG_1_ID}`);
        expect(res.status).to.equal(200);
        expectSuggestionDto(res.body);
        expect(res.body.id).to.equal(SUGG_1_ID);
        expect(res.body.opportunityId).to.equal(OPPTY_1_ID);
        expect(res.body.type).to.equal('CODE_CHANGE');
        expect(res.body.status).to.equal('NEW');
        expect(res.body.rank).to.equal(1);

        // Enriched fields — exercises kpiDeltas↔kpi_deltas conversion
        expect(res.body.kpiDeltas).to.deep.equal({ estimatedKPILift: 0.15 });
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${DENIED_BASE}/${SUGG_1_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent suggestion', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/${NON_EXISTENT_SUGG_ID}`);
        expect(res.status).to.equal(404);
      });

      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`${BASE}/not-a-uuid`);
        expect(res.status).to.equal(400);
      });
    });

    describe('GET .../suggestions/:suggestionId/fixes', () => {
      before(() => resetData());

      it('user: returns fixes linked to suggestion via junction', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/${SUGG_1_ID}/fixes`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        expect(res.body.data).to.be.an('array').with.lengthOf(1);
        expect(res.body.data[0].id).to.equal(FIX_1_ID);
      });

      it('user: returns empty for suggestion with no fix associations', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/${SUGG_2_ID}/fixes`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
      });

      it('user: returns 200 with empty data for non-existent suggestion', async () => {
        // getSuggestionFixes does NOT check suggestion existence — returns empty array
        const http = getHttpClient();
        const res = await http.user.get(`${BASE}/${NON_EXISTENT_SUGG_ID}/fixes`);
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
      });
    });

    // ── Write endpoints ──

    describe('POST .../suggestions (batch 207)', () => {
      before(() => resetData());

      it('user: creates single suggestion', async () => {
        const http = getHttpClient();
        const res = await http.user.post(BASE, [
          {
            type: 'CONTENT_UPDATE',
            rank: 10,
            data: { title: 'Test suggestion', from: '/a', to: '/b' },
          },
        ]);
        expectBatch207(res, 1, 'suggestions');
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.suggestions[0].statusCode).to.equal(201);
        expect(res.body.suggestions[0].suggestion).to.be.an('object');
        expect(res.body.suggestions[0].suggestion.type).to.equal('CONTENT_UPDATE');
      });

      it('user: creates multiple suggestions', async () => {
        const http = getHttpClient();
        const res = await http.user.post(BASE, [
          { type: 'CODE_CHANGE', rank: 20, data: { title: 'Batch 1' } },
          { type: 'METADATA_UPDATE', rank: 21, data: { title: 'Batch 2' } },
        ]);
        expectBatch207(res, 2, 'suggestions');
        expect(res.body.metadata.success).to.equal(2);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.post(DENIED_BASE, [
          { type: 'CODE_CHANGE', rank: 1, data: { title: 'Denied' } },
        ]);
        expect(res.status).to.equal(403);
      });

      it('user: returns 400 for non-array body', async () => {
        const http = getHttpClient();
        const res = await http.user.post(BASE, { type: 'CODE_CHANGE' });
        expect(res.status).to.equal(400);
      });
    });

    describe('PATCH .../suggestions/:suggestionId', () => {
      let testSuggId;

      before(async () => {
        await resetData();
        // Create a test-scoped suggestion to mutate
        const http = getHttpClient();
        const res = await http.user.post(BASE, [
          { type: 'CODE_CHANGE', rank: 50, data: { title: 'Patch test' } },
        ]);
        expect(res.status).to.equal(207);
        testSuggId = res.body.suggestions[0].suggestion.id;
      });

      it('user: updates suggestion rank', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`${BASE}/${testSuggId}`, { rank: 99 });
        expect(res.status).to.equal(200);
        expectSuggestionDto(res.body);
        expect(res.body.rank).to.equal(99);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`${DENIED_BASE}/${testSuggId}`, { rank: 1 });
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent suggestion', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(
          `${BASE}/${NON_EXISTENT_SUGG_ID}`,
          { rank: 1 },
        );
        expect(res.status).to.equal(404);
      });
    });

    describe('PATCH .../suggestions/status (batch 207)', () => {
      let testSuggId;

      before(async () => {
        await resetData();
        // Create a test-scoped suggestion for status update
        const http = getHttpClient();
        const res = await http.user.post(BASE, [
          { type: 'CODE_CHANGE', rank: 60, data: { title: 'Status test' } },
        ]);
        expect(res.status).to.equal(207);
        testSuggId = res.body.suggestions[0].suggestion.id;
      });

      it('user: updates single suggestion status', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`${BASE}/status`, [
          { id: testSuggId, status: 'APPROVED' },
        ]);
        expectBatch207(res, 1, 'suggestions');
        expect(res.body.metadata.success).to.equal(1);
        expect(res.body.suggestions[0].statusCode).to.equal(200);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`${DENIED_BASE}/status`, [
          { id: testSuggId, status: 'APPROVED' },
        ]);
        expect(res.status).to.equal(403);
      });

      it('user: returns 400 for non-array body', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`${BASE}/status`, { id: testSuggId, status: 'APPROVED' });
        expect(res.status).to.equal(400);
      });
    });

    describe('DELETE .../suggestions/:suggestionId', () => {
      let testSuggId;

      before(async () => {
        await resetData();
        // Create a test-scoped suggestion to delete
        const http = getHttpClient();
        const res = await http.user.post(BASE, [
          { type: 'CODE_CHANGE', rank: 70, data: { title: 'Delete test' } },
        ]);
        expect(res.status).to.equal(207);
        testSuggId = res.body.suggestions[0].suggestion.id;
      });

      it('user: deletes suggestion', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`${BASE}/${testSuggId}`);
        expect(res.status).to.equal(204);

        // Verify it's gone
        const check = await http.user.get(`${BASE}/${testSuggId}`);
        expect(check.status).to.equal(404);
      });

      it('user: returns 403 for denied site', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`${DENIED_BASE}/${NON_EXISTENT_SUGG_ID}`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent suggestion', async () => {
        const http = getHttpClient();
        const res = await http.user.delete(`${BASE}/${NON_EXISTENT_SUGG_ID}`);
        expect(res.status).to.equal(404);
      });
    });
  });
}
