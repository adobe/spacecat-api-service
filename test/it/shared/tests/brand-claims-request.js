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
} from '../seed-ids.js';

const REQUEST_PATH = (siteId) => `/sites/${siteId}/llmo/brand-claims/request`;
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Shared tests for the on-demand Brand Claims request endpoint (LLMO-7263):
 *   POST /sites/:siteId/llmo/brand-claims/request
 *
 * The 202 happy path is NOT exercised here: it enqueues to `AUDIT_JOBS_QUEUE_URL`,
 * and the IT harness has no live SQS (the dummy queue would make the send fail),
 * so the accepted path is covered by the controller unit tests instead. What the
 * harness CAN exercise against real PostgreSQL is the full request lifecycle up to
 * (and including) the 7-day cooldown gate, which reads the latest `brand-claims`
 * Audit via `Site.getLatestAuditByAuditType`.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 * @param {(siteId: string, opts?: object) => Promise<string>} seedRecentBrandClaimsAudit
 *   - Seeds a recent `brand-claims` audit and returns its ISO `auditedAt`.
 */
export default function brandClaimsRequestTests(
  getHttpClient,
  resetData,
  seedRecentBrandClaimsAudit,
) {
  describe('POST /sites/:siteId/llmo/brand-claims/request', () => {
    beforeEach(() => resetData());

    it('returns 404 for a non-existent site', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(REQUEST_PATH(NON_EXISTENT_SITE_ID), {});
      expect(res.status).to.equal(404);
    });

    it('returns 400 for an invalid site UUID', async () => {
      const http = getHttpClient();
      const res = await http.admin.post('/sites/not-a-uuid/llmo/brand-claims/request', {});
      expect(res.status).to.equal(400);
    });

    it('returns 403 for a site the caller cannot access', async () => {
      // SITE_3 belongs to ORG_2; the `user` persona (ORG_1) has no access.
      const http = getHttpClient();
      const res = await http.user.post(REQUEST_PATH(SITE_3_ID), {});
      expect(res.status).to.equal(403);
    });

    it('returns 429 when a brand-claims run ran within the 7-day cooldown', async () => {
      const auditedAt = await seedRecentBrandClaimsAudit(SITE_1_ID);
      const http = getHttpClient();
      const res = await http.admin.post(REQUEST_PATH(SITE_1_ID), {});

      expect(res.status).to.equal(429);
      expect(res.body.siteId).to.equal(SITE_1_ID);
      // availableAt is exactly auditedAt + 7 days (deterministic, unlike elapsed).
      const expectedAvailableAt = new Date(Date.parse(auditedAt) + COOLDOWN_MS).toISOString();
      expect(res.body.availableAt).to.equal(expectedAvailableAt);
      // Retry-After header is a positive integer number of seconds.
      const retryAfter = Number(res.headers.get('retry-after'));
      expect(Number.isInteger(retryAfter)).to.equal(true);
      expect(retryAfter).to.be.greaterThan(0);
    });
  });
}
