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

// Canonical form of the seeded rows (test/it/postgres/seed-data/opportunity-urls.js) -
// this file's tests exist specifically to prove the writer's persisted canonical form and
// this endpoint's own `canonicalizeUrl` call agree; a mock could never prove that.
const CWV_URL = 'example.com/cwv-article';
const BROKEN_LINK_URL = 'example.com/broken-link-source';
const CROSS_SITE_DRIFT_URL = 'example.com/cross-site-drift';

/**
 * Shared `POST /sites/:siteId/opportunities/by-urls` endpoint tests.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function opportunitiesByUrlsTests(getHttpClient, resetData) {
  describe('POST /sites/:siteId/opportunities/by-urls', () => {
    before(() => resetData());

    it('user: matches a non-canonical input variant against the canonically-stored index row', async () => {
      // scheme + www + case + trailing-slash variant of the seeded canonical URL - proves the
      // real writer-persisted form and this endpoint's canonicalizeUrl call actually agree.
      const variant = 'HTTPS://WWW.Example.com/cwv-article/';
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-urls`, { urls: [variant] });
      expect(res.status).to.equal(200);
      expect(res.body.results).to.deep.equal([{ url: variant, opportunityIds: [OPPTY_1_ID] }]);
      expect(res.body.opportunities[OPPTY_1_ID]).to.include({ id: OPPTY_1_ID, type: 'code-suggestions' });
      expect(res.body.unmatchedUrls).to.deep.equal([]);
    });

    it('user: returns matches and no-match entries for multiple URLs in one call', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-urls`, {
        urls: [`https://${CWV_URL}`, `https://${BROKEN_LINK_URL}`, 'https://example.com/never-indexed'],
      });
      expect(res.status).to.equal(200);
      expect(res.body.results).to.deep.equal([
        { url: `https://${CWV_URL}`, opportunityIds: [OPPTY_1_ID] },
        { url: `https://${BROKEN_LINK_URL}`, opportunityIds: [OPPTY_2_ID] },
        { url: 'https://example.com/never-indexed', opportunityIds: [] },
      ]);
      expect(res.body.unmatchedUrls).to.deep.equal(['https://example.com/never-indexed']);
    });

    it('user: drops a hydrated opportunity whose real siteId does not match the requested site (stale/cross-site index row)', async () => {
      // The seeded row for this URL claims site_id = SITE_1, but its entity_id actually
      // belongs to SITE_3 - simulating a stale/mis-written index row. The lookup's own
      // PostgREST query is site-scoped and returns the row (it trusts the index's own
      // site_id column), but the endpoint must still drop it once hydration reveals the
      // real owning site - this is exactly the check a mocked opportunity entity can't prove.
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-urls`, {
        urls: [`https://${CROSS_SITE_DRIFT_URL}`],
      });
      expect(res.status).to.equal(200);
      expect(res.body.opportunities).to.deep.equal({});
      expect(res.body.results).to.deep.equal([{ url: `https://${CROSS_SITE_DRIFT_URL}`, opportunityIds: [] }]);
    });

    it('user: returns 403 for a denied site, before any lookup runs', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_3_ID}/opportunities/by-urls`, {
        urls: [`https://${CWV_URL}`],
      });
      expect(res.status).to.equal(403);
    });

    it('admin: returns 404 for a non-existent site', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(`/sites/${NON_EXISTENT_SITE_ID}/opportunities/by-urls`, {
        urls: [`https://${CWV_URL}`],
      });
      expect(res.status).to.equal(404);
    });

    it('returns 400 for invalid site UUID', async () => {
      const http = getHttpClient();
      const res = await http.admin.post('/sites/not-a-uuid/opportunities/by-urls', { urls: [`https://${CWV_URL}`] });
      expect(res.status).to.equal(400);
    });

    it('returns 400 for a non-array urls body', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-urls`, { urls: 'nope' });
      expect(res.status).to.equal(400);
    });

    it('user: returns an empty result set (200, not 400) for an all-invalid urls list', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-urls`, { urls: ['', null] });
      expect(res.status).to.equal(200);
      expect(res.body.results).to.deep.equal([]);
      expect(res.body.opportunities).to.deep.equal({});
    });

    it('user: projects matched opportunities to requested fields with ?fields=', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-urls`, {
        urls: [`https://${CWV_URL}`], fields: 'title,type',
      });
      expect(res.status).to.equal(200);
      expect(Object.keys(res.body.opportunities[OPPTY_1_ID]).sort()).to.deep.equal(['id', 'title', 'type']);
    });

    it('user: honors an explicit status filter, excluding a match with a different status', async () => {
      // OPPTY_1 is NEW, OPPTY_2 is RESOLVED - filtering to NEW must keep the former and
      // drop the latter, proving the filter is applied rather than merely accepted.
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-urls`, {
        urls: [`https://${CWV_URL}`, `https://${BROKEN_LINK_URL}`], status: 'NEW',
      });
      expect(res.status).to.equal(200);
      expect(Object.keys(res.body.opportunities)).to.deep.equal([OPPTY_1_ID]);
      expect(res.body.results).to.deep.equal([
        { url: `https://${CWV_URL}`, opportunityIds: [OPPTY_1_ID] },
        { url: `https://${BROKEN_LINK_URL}`, opportunityIds: [] },
      ]);
    });

    it('returns 400 for a malformed locale', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/opportunities/by-urls`, {
        urls: [`https://${CWV_URL}`], locale: 'not-a-locale!!',
      });
      expect(res.status).to.equal(400);
    });
  });
}
