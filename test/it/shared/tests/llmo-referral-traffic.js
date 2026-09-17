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

import { SITE_1_ID, SITE_2_ID, SITE_3_ID } from '../seed-ids.js';

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
 *   The baseline IT seed does not populate the partitioned referral_traffic_*
 *   tables, so `seedReferralPresence` inserts minimal per-source rows on demand
 *   (see test/it/postgres/seed.js) to drive the source-presence + ordering
 *   cases; the empty-data + access-validation cases run without it.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 * @param {(siteId: string, sources: string[]) => void} seedReferralPresence -
 *   Seeds referral source presence for a site (see seed.js).
 */
export default function llmoReferralTrafficTests(getHttpClient, resetData, seedReferralPresence) {
  describe('LLMO Referral Traffic — has-data handler (LLMO-5599)', () => {
    before(() => resetData());
    // Baseline clearData() doesn't touch the partitioned referral_traffic_*
    // tables, so a crashed prior run could leave presence rows behind and turn
    // the empty-data assertion red. Clear them up front so the suite is
    // self-contained regardless of prior state.
    before(() => seedReferralPresence(SITE_1_ID, []));

    const hasDataPath = (siteId) => `/sites/${siteId}/referral-traffic/has-data`;

    it('returns hasData:false and empty availableSources for a site with no referral rows', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(hasDataPath(SITE_1_ID));
      expect(res.status).to.equal(200);
      expect(res.headers.get('cache-control')).to.equal('private, max-age=7200');
      expect(res.body).to.have.property('hasData', false);
      expect(res.body).to.have.property('availableSources').that.deep.equals([]);
      expect(res.body).to.have.property('activeSource', null);
    });

    it('rejects an unknown site with a non-2xx (access validation runs before the probe)', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(hasDataPath('99999999-9999-4999-8999-999999999999'));
      // Access validation runs before the probe: a bad/unknown site is a client
      // error (400/403/404). 500 is intentionally excluded so an internal crash
      // can't masquerade as access validation.
      expect(res.status).to.be.oneOf([400, 403, 404]);
    });

    describe('source presence + priority ordering', () => {
      // Clear the referral tables after each case so presence rows don't leak.
      afterEach(() => seedReferralPresence(SITE_1_ID, []));

      it('returns only sources that have rows, in backend priority order (excludes absent sources)', async () => {
        // Seed a 2-source subset (cdn written first) with the other three
        // absent: the response must drop the absent sources and order the
        // present pair by backend priority (adobe_analytics before cdn),
        // independent of the order rows were written.
        seedReferralPresence(SITE_1_ID, ['cdn', 'adobe_analytics']);
        const http = getHttpClient();
        const res = await http.admin.get(hasDataPath(SITE_1_ID));
        expect(res.status).to.equal(200);
        expect(res.body.hasData).to.equal(true);
        expect(res.body.availableSources).to.deep.equal(['adobe_analytics', 'cdn']);
        expect(res.body.activeSource).to.equal('adobe_analytics');
      });

      it('returns a Business Impact-only source when that is the only source with rows', async () => {
        seedReferralPresence(SITE_1_ID, ['ga4']);
        const http = getHttpClient();
        const res = await http.admin.get(hasDataPath(SITE_1_ID));
        expect(res.status).to.equal(200);
        expect(res.body.hasData).to.equal(true);
        expect(res.body.availableSources).to.deep.equal(['ga4']);
        expect(res.body.activeSource).to.equal('ga4');
      });

      it('preserves full priority order (adobe_analytics > cja > ga4 > cdn > optel) when all sources have rows', async () => {
        seedReferralPresence(SITE_1_ID, ['optel', 'cdn', 'adobe_analytics', 'ga4', 'cja']);
        const http = getHttpClient();
        const res = await http.admin.get(hasDataPath(SITE_1_ID));
        expect(res.status).to.equal(200);
        expect(res.body.hasData).to.equal(true);
        expect(res.body.availableSources).to.deep.equal(['adobe_analytics', 'cja', 'ga4', 'cdn', 'optel']);
        expect(res.body.activeSource).to.equal('adobe_analytics');
      });

      it('keeps source presence isolated by site and denies out-of-org user access', async () => {
        seedReferralPresence(SITE_3_ID, ['cja']);
        const http = getHttpClient();

        const sameOrgOtherSite = await http.admin.get(hasDataPath(SITE_2_ID));
        expect(sameOrgOtherSite.status).to.equal(200);
        expect(sameOrgOtherSite.body.hasData).to.equal(false);
        expect(sameOrgOtherSite.body.availableSources).to.deep.equal([]);
        expect(sameOrgOtherSite.body.activeSource).to.equal(null);

        const denied = await http.user.get(hasDataPath(SITE_3_ID));
        expect(denied.status).to.equal(403);
      });
    });
  });
}
