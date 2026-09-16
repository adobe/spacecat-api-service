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
  SITE_1_ID,
  SITE_3_ID,
  NON_EXISTENT_SITE_ID,
  OPPTY_1_ID,
  OPPTY_2_ID,
} from '../seed-ids.js';

// Query strings whose embeddings are seeded into semantic_query_embedding
// (test/it/postgres/seed-data/semantic-query-embedding.js) as unit vectors e0 / e1, so the read
// path resolves them from the durable cache (no real Azure embedding call in this suite) and the
// RPC's cosine ranking against the seeded opportunity vectors is exact.
const BANKING_QUERY = 'online banking security'; // e0 -> OPPTY_1 (+ the OPPTY_3 cross-site drift row)
const BACKLINKS_QUERY = 'broken backlinks'; // e1 -> OPPTY_2

/**
 * Shared `POST /sites/:siteId/opportunities/by-topics` endpoint tests.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function opportunitiesByTopicsTests(getHttpClient, resetData) {
  describe('POST /sites/:siteId/opportunities/by-topics', () => {
    before(() => resetData());

    it('user: returns the semantically matched opportunity ranked by score, dropping sub-floor matches', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-topics`, { topics: [BANKING_QUERY] });
      expect(res.status).to.equal(200);
      expect(res.body.results).to.have.length(1);
      expect(res.body.results[0].topic).to.equal(BANKING_QUERY);
      // OPPTY_1 (e0) scores 1.0; OPPTY_2 (e1) scores 0, dropped by the default minScore floor.
      expect(res.body.results[0].matches).to.have.length(1);
      expect(res.body.results[0].matches[0].opportunityId).to.equal(OPPTY_1_ID);
      expect(res.body.results[0].matches[0].score).to.be.closeTo(1, 1e-6);
      expect(res.body.opportunities[OPPTY_1_ID]).to.include({ id: OPPTY_1_ID, type: 'code-suggestions' });
      // The cross-site drift row (OPPTY_3, real site SITE_3) is dropped by the siteId re-check.
      expect(res.body.opportunities).to.not.have.property('aa333333-3333-4333-b333-333333333333');
    });

    it('user: returns one result entry per input topic, ranked independently', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-topics`, {
        topics: [BANKING_QUERY, BACKLINKS_QUERY],
      });
      expect(res.status).to.equal(200);
      expect(res.body.results.map((r) => r.topic)).to.deep.equal([BANKING_QUERY, BACKLINKS_QUERY]);
      expect(res.body.results[0].matches.map((m) => m.opportunityId)).to.deep.equal([OPPTY_1_ID]);
      expect(res.body.results[1].matches.map((m) => m.opportunityId)).to.deep.equal([OPPTY_2_ID]);
      expect(Object.keys(res.body.opportunities)).to.have.members([OPPTY_1_ID, OPPTY_2_ID]);
    });

    it('user: honors an explicit status filter, excluding a match with a different status', async () => {
      // OPPTY_2 is RESOLVED; filtering to NEW drops it, leaving the topic with no matches.
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-topics`, {
        topics: [BACKLINKS_QUERY], status: 'NEW',
      });
      expect(res.status).to.equal(200);
      expect(res.body.results[0].matches).to.deep.equal([]);
      expect(res.body.opportunities).to.deep.equal({});
    });

    it('user: projects matched opportunities to requested fields with fields=', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-topics`, {
        topics: [BANKING_QUERY], fields: 'title,type',
      });
      expect(res.status).to.equal(200);
      expect(Object.keys(res.body.opportunities[OPPTY_1_ID]).sort()).to.deep.equal(['id', 'title', 'type']);
    });

    it('user: returns 403 for a denied site, before any lookup runs', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_3_ID}/opportunities/by-topics`, { topics: [BANKING_QUERY] });
      expect(res.status).to.equal(403);
    });

    it('admin: returns 404 for a non-existent site', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(`/sites/${NON_EXISTENT_SITE_ID}/opportunities/by-topics`, { topics: [BANKING_QUERY] });
      expect(res.status).to.equal(404);
    });

    it('returns 400 for an invalid site UUID', async () => {
      const http = getHttpClient();
      const res = await http.admin.post('/sites/not-a-uuid/opportunities/by-topics', { topics: [BANKING_QUERY] });
      expect(res.status).to.equal(400);
    });

    it('returns 400 for a non-array topics body', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-topics`, { topics: 'nope' });
      expect(res.status).to.equal(400);
    });

    it('user: returns an empty result set (200, not 400) for an all-invalid topics list', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-topics`, { topics: ['', null] });
      expect(res.status).to.equal(200);
      expect(res.body.results).to.deep.equal([]);
      expect(res.body.opportunities).to.deep.equal({});
    });

    it('returns 400 for a malformed locale', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-topics`, {
        topics: [BANKING_QUERY], locale: 'not-a-locale!!',
      });
      expect(res.status).to.equal(400);
    });
  });
}
