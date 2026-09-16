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
  SUGG_1_ID,
  SUGG_2_ID,
} from '../seed-ids.js';

// Canonical form of the seeded rows (test/it/postgres/seed-data/suggestion-urls.js).
const HERO_IMAGE_URL = 'example.com/hero-image-source';
const REDIRECT_URL = 'example.com/redirect-source';

/**
 * Shared `POST /sites/:siteId/suggestions/by-urls` endpoint tests.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function suggestionsByUrlsTests(getHttpClient, resetData) {
  describe('POST /sites/:siteId/suggestions/by-urls', () => {
    before(() => resetData());

    it('user: matches a non-canonical input variant against the canonically-stored index row', async () => {
      const variant = 'HTTPS://WWW.Example.com/hero-image-source/';
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/suggestions/by-urls`, { urls: [variant] });
      expect(res.status).to.equal(200);
      expect(res.body.results).to.deep.equal([{ url: variant, suggestionIds: [SUGG_1_ID] }]);
      expect(res.body.suggestions[SUGG_1_ID])
        .to.include({ id: SUGG_1_ID, opportunityId: OPPTY_1_ID });
      expect(res.body.unmatchedUrls).to.deep.equal([]);
    });

    it('user: returns matches, force-includes opportunityId, and reports a definitive unmatchedUrls', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/suggestions/by-urls`, {
        urls: [`https://${HERO_IMAGE_URL}`, `https://${REDIRECT_URL}`, 'https://example.com/never-indexed'],
      });
      expect(res.status).to.equal(200);
      expect(res.body.results).to.deep.equal([
        { url: `https://${HERO_IMAGE_URL}`, suggestionIds: [SUGG_1_ID] },
        { url: `https://${REDIRECT_URL}`, suggestionIds: [SUGG_2_ID] },
      ]);
      expect(res.body.suggestions[SUGG_1_ID].opportunityId).to.equal(OPPTY_1_ID);
      expect(res.body.unmatchedUrls).to.deep.equal(['https://example.com/never-indexed']);
    });

    it('user: returns 403 for a denied site, before any lookup runs', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_3_ID}/suggestions/by-urls`, {
        urls: [`https://${HERO_IMAGE_URL}`],
      });
      expect(res.status).to.equal(403);
    });

    it('admin: returns 404 for a non-existent site', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(`/sites/${NON_EXISTENT_SITE_ID}/suggestions/by-urls`, {
        urls: [`https://${HERO_IMAGE_URL}`],
      });
      expect(res.status).to.equal(404);
    });

    it('returns 400 for invalid site UUID', async () => {
      const http = getHttpClient();
      const res = await http.admin.post('/sites/not-a-uuid/suggestions/by-urls', { urls: [`https://${HERO_IMAGE_URL}`] });
      expect(res.status).to.equal(400);
    });

    it('returns 400 for a non-array urls body', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/suggestions/by-urls`, { urls: 'nope' });
      expect(res.status).to.equal(400);
    });

    it('user: returns an empty first-page result set (200, not 400) for an all-invalid urls list', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/suggestions/by-urls`, { urls: ['', null] });
      expect(res.status).to.equal(200);
      expect(res.body.results).to.deep.equal([]);
      expect(res.body.unmatchedUrls).to.deep.equal([]);
    });

    it('user: projects matched suggestions to requested fields, still force-including opportunityId', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/suggestions/by-urls`, {
        urls: [`https://${HERO_IMAGE_URL}`], fields: 'status',
      });
      expect(res.status).to.equal(200);
      expect(Object.keys(res.body.suggestions[SUGG_1_ID]).sort())
        .to.deep.equal(['id', 'opportunityId', 'status']);
    });

    it('user: honors an explicit status filter, excluding a match with a different status', async () => {
      // SUGG_1 is NEW, SUGG_2 is APPROVED - filtering to NEW must keep the former and
      // report the latter's URL as unmatched.
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/suggestions/by-urls`, {
        urls: [`https://${HERO_IMAGE_URL}`, `https://${REDIRECT_URL}`], status: 'NEW',
      });
      expect(res.status).to.equal(200);
      expect(res.body.results).to.deep.equal([{ url: `https://${HERO_IMAGE_URL}`, suggestionIds: [SUGG_1_ID] }]);
      expect(res.body.unmatchedUrls).to.deep.equal([`https://${REDIRECT_URL}`]);
    });

    it('returns 400 for a malformed locale', async () => {
      const http = getHttpClient();
      const res = await http.user.post(`/sites/${SITE_1_ID}/suggestions/by-urls`, {
        urls: [`https://${HERO_IMAGE_URL}`], locale: 'not-a-locale!!',
      });
      expect(res.status).to.equal(400);
    });
  });
}
