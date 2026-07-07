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

import { SITE_1_ID } from '../seed-ids.js';

/**
 * Shared LLMO Referral Traffic endpoint tests.
 *
 * Covers the has-data handler widened in LLMO-5599:
 *   GET /sites/:siteId/referral-traffic/has-data
 *
 * The handler now probes ALL five referral source tables
 * (referral_traffic_{adobe_analytics,cja,ga4,cdn,optel}) via a direct
 * PostgREST table existence check (LIMIT 1) and returns `availableSources`
 * in resolution-priority order (adobe_analytics > cja > ga4 > cdn > optel),
 * with hasData true iff any source has rows. Because this is a plain table
 * read (not an RPC), it does not depend on the RPC-signature migrations the
 * url-inspector IT is waiting on.
 *
 * NOTE on referral seeding:
 *   The baseline IT seed does not populate the partitioned
 *   referral_traffic_* tables, so the runnable cases below exercise the
 *   empty-data and access-validation paths end-to-end through PostgREST. The
 *   source-presence + priority-ordering exercises are skipped pending a
 *   referral seed helper, mirroring the deferred referral-source exercises
 *   in llmo-url-inspector.js.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function llmoReferralTrafficTests(getHttpClient, resetData) {
  describe('LLMO Referral Traffic — has-data handler (LLMO-5599)', () => {
    before(() => resetData());

    const hasDataPath = (siteId) => `/sites/${siteId}/referral-traffic/has-data`;

    it('returns hasData:false and empty availableSources for a site with no referral rows', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(hasDataPath(SITE_1_ID));
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('hasData', false);
      expect(res.body).to.have.property('availableSources').that.deep.equals([]);
    });

    it('rejects an unknown site with a non-2xx (access validation runs before the probe)', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(hasDataPath('99999999-9999-4999-8999-999999999999'));
      expect(res.status).to.be.oneOf([400, 403, 404, 500]);
    });

    // ── Skipped: source presence + priority ordering (needs referral seed) ──
    // Enable once the IT harness can seed rows into the partitioned
    // referral_traffic_{optel,cdn,adobe_analytics,ga4,cja} tables. Mirrors the
    // deferred referral-source exercises in llmo-url-inspector.js. With seeded
    // rows for SITE_1_ID, assert availableSources is returned in
    // resolution-priority order and hasData flips to true.
    describe('source presence + priority ordering (skipped pending referral seed)', () => {
      it.skip('returns availableSources in priority order when multiple sources have rows', async () => {
        // Seed e.g. referral_traffic_adobe_analytics + referral_traffic_cdn rows
        // for SITE_1_ID, then:
        const http = getHttpClient();
        const res = await http.admin.get(hasDataPath(SITE_1_ID));
        expect(res.status).to.equal(200);
        expect(res.body.hasData).to.equal(true);
        expect(res.body.availableSources).to.deep.equal(['adobe_analytics', 'cdn']);
      });
    });
  });
}
