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
import { expectISOTimestamp } from '../helpers/assertions.js';
import {
  ORG_1_IMS_ORG_ID,
  ORG_2_IMS_ORG_ID,
  PLG_ONBOARDING_1_ID,
  PLG_ONBOARDING_1_DOMAIN,
  PLG_ONBOARDING_2_ID,
  PLG_ONBOARDING_3_ID,
  NON_EXISTENT_IMS_ORG_ID,
} from '../seed-ids.js';

/**
 * Asserts that an object has the PlgOnboardingDto shape.
 */
function expectPlgOnboardingDto(onboarding) {
  expect(onboarding).to.be.an('object');
  expect(onboarding.id).to.be.a('string');
  expect(onboarding.imsOrgId).to.be.a('string');
  expect(onboarding.domain).to.be.a('string');
  expect(onboarding.baseURL).to.be.a('string');
  expect(onboarding.status).to.be.a('string');
  expectISOTimestamp(onboarding.createdAt, 'createdAt');
  expectISOTimestamp(onboarding.updatedAt, 'updatedAt');
}

/**
 * Shared PLG Onboarding endpoint tests.
 *
 * POST /plg/onboard — validation tests only (happy path needs external services).
 * GET /plg/sites — admin-only list of PLG onboarding rows.
 * GET /plg/onboard/status/:imsOrgId — validation + lookup.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 * @param {object} [options]
 * @param {boolean} [options.skipPlgOnboardingTests=false]
 *   Skip tests requiring PlgOnboarding model (v2/DynamoDB)
 */
export default function plgOnboardingTests(getHttpClient, resetData, options = {}) {
  const { skipPlgOnboardingTests = false } = options;

  describe('PlgOnboarding', () => {
    before(() => resetData());

    // ── POST /plg/onboard — validation ──

    describe('POST /plg/onboard', () => {
      it('returns 400 for missing body', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/plg/onboard');
        expect(res.status).to.equal(400);
      });

      it('returns 400 for missing domain', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/plg/onboard', {});
        expect(res.status).to.equal(400);
      });

      it('returns 400 for invalid domain (not a hostname)', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/plg/onboard', {
          domain: '../../etc/passwd',
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for unsafe domain', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/plg/onboard', {
          domain: 'localhost',
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for invalid domain via non-admin user', async () => {
        const http = getHttpClient();
        const res = await http.user.post('/plg/onboard', {
          domain: '../../etc/passwd',
        });
        expect(res.status).to.equal(400);
      });
    });

    // ── GET /plg/sites ──

    describe('GET /plg/sites', () => {
      it('returns 403 for non-admin user', async () => {
        const http = getHttpClient();
        const res = await http.user.get('/plg/sites');
        expect(res.status).to.equal(403);
      });

      if (!skipPlgOnboardingTests) {
        it('admin: returns 200 with all seeded onboardings', async () => {
          const http = getHttpClient();
          const res = await http.admin.get('/plg/sites');
          expect(res.status).to.equal(200);
          expect(res.body).to.be.an('array').with.length.of.at.least(1);
          const match = res.body.find((r) => r.id === PLG_ONBOARDING_1_ID);
          expect(match).to.be.an('object');
          expectPlgOnboardingDto(match);
          expect(match.domain).to.equal(PLG_ONBOARDING_1_DOMAIN);
        });

        it('admin: returns 400 for invalid limit query', async () => {
          const http = getHttpClient();
          const res = await http.admin.get('/plg/sites?limit=0');
          expect(res.status).to.equal(400);
        });

        it('admin: returns 400 for limit that is not an integer token', async () => {
          const http = getHttpClient();
          const res = await http.admin.get('/plg/sites?limit=1.5');
          expect(res.status).to.equal(400);
        });

        it('admin: returns 400 for limit with trailing junk', async () => {
          const http = getHttpClient();
          const res = await http.admin.get('/plg/sites?limit=50abc');
          expect(res.status).to.equal(400);
        });

        it('admin: returns 400 for negative limit', async () => {
          const http = getHttpClient();
          const res = await http.admin.get('/plg/sites?limit=-1');
          expect(res.status).to.equal(400);
        });

        it('admin: respects limit query when listing', async () => {
          const http = getHttpClient();
          const res = await http.admin.get('/plg/sites?limit=1');
          expect(res.status).to.equal(200);
          expect(res.body).to.be.an('array');
          expect(res.body.length).to.be.at.most(1);
        });
      }
    });

    // ── GET /plg/onboard/status/:imsOrgId ──

    describe('GET /plg/onboard/status/:imsOrgId', () => {
      it('returns 400 for invalid imsOrgId', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/plg/onboard/status/not-valid');
        expect(res.status).to.equal(400);
      });

      it('admin: returns 404 for org with no onboarding records', async () => {
        // admin bypasses org check but ORG_2 has no PlgOnboarding records
        const http = getHttpClient();
        const res = await http.admin.get(`/plg/onboard/status/${ORG_2_IMS_ORG_ID}`);
        expect(res.status).to.equal(404);
      });

      it('returns 403 for non-admin user with mismatched org', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/plg/onboard/status/${ORG_2_IMS_ORG_ID}`);
        expect(res.status).to.equal(403);
      });

      // Tests below require PlgOnboarding model (v3/PostgreSQL only)
      if (!skipPlgOnboardingTests) {
        it('returns 404 for non-existent imsOrgId', async () => {
          const http = getHttpClient();
          const res = await http.admin.get(`/plg/onboard/status/${NON_EXISTENT_IMS_ORG_ID}`);
          expect(res.status).to.equal(404);
        });

        it('returns 200 with onboarding records for existing imsOrgId', async () => {
          const http = getHttpClient();
          const res = await http.admin.get(`/plg/onboard/status/${ORG_1_IMS_ORG_ID}`);
          expect(res.status).to.equal(200);

          expect(res.body).to.be.an('array').with.length.of.at.least(3);
          const record = res.body.find((r) => r.id === PLG_ONBOARDING_1_ID);
          expectPlgOnboardingDto(record);
          expect(record.imsOrgId).to.equal(ORG_1_IMS_ORG_ID);
          expect(record.domain).to.equal(PLG_ONBOARDING_1_DOMAIN);
          expect(record.status).to.equal('ONBOARDED');
          expect(record.siteId).to.be.a('string');
          expect(record.organizationId).to.be.a('string');
        });

        it('returns 200 for non-admin user with matching org', async () => {
          const http = getHttpClient();
          const res = await http.user.get(`/plg/onboard/status/${ORG_1_IMS_ORG_ID}`);
          expect(res.status).to.equal(200);
          expect(res.body).to.be.an('array').with.length.of.at.least(3);
        });
      }
    });

    // ── PATCH /plg/onboard/:onboardingId ──

    describe('PATCH /plg/onboard/:onboardingId', () => {
      it('returns 403 for non-admin user', async () => {
        const http = getHttpClient();
        const res = await http.user.patch(`/plg/onboard/${PLG_ONBOARDING_2_ID}`, {
          decision: 'BYPASSED',
          justification: 'test',
        });
        expect(res.status).to.equal(403);
      });

      it('returns 400 for missing decision', async () => {
        const http = getHttpClient();
        const res = await http.admin.patch(`/plg/onboard/${PLG_ONBOARDING_2_ID}`, {
          justification: 'test',
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for missing justification', async () => {
        const http = getHttpClient();
        const res = await http.admin.patch(`/plg/onboard/${PLG_ONBOARDING_2_ID}`, {
          decision: 'BYPASSED',
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for invalid decision value', async () => {
        const http = getHttpClient();
        const res = await http.admin.patch(`/plg/onboard/${PLG_ONBOARDING_2_ID}`, {
          decision: 'INVALID',
          justification: 'test',
        });
        expect(res.status).to.equal(400);
      });

      it('returns 404 for non-existent onboardingId', async () => {
        const http = getHttpClient();
        const res = await http.admin.patch('/plg/onboard/aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee', {
          decision: 'BYPASSED',
          justification: 'test',
        });
        expect(res.status).to.equal(404);
      });

      it('returns 400 when onboarding is not WAITLISTED or ONBOARDED', async () => {
        const http = getHttpClient();
        // PLG_ONBOARDING_3 is IN_PROGRESS — admin PATCH is only allowed for WAITLISTED or ONBOARDED
        const res = await http.admin.patch(`/plg/onboard/${PLG_ONBOARDING_3_ID}`, {
          decision: 'BYPASSED',
          justification: 'test',
        });
        expect(res.status).to.equal(400);
        expect(res.body).to.be.an('object');
        expect(res.body.message).to.equal(
          'Onboarding record must be in WAITLISTED or ONBOARDED state',
        );
      });

      if (!skipPlgOnboardingTests) {
        it('UPHELD: stores review and keeps WAITLISTED status', async () => {
          const http = getHttpClient();
          const res = await http.admin.patch(`/plg/onboard/${PLG_ONBOARDING_2_ID}`, {
            decision: 'UPHELD',
            justification: 'Not ready to proceed',
          });
          expect(res.status).to.equal(200);
          expectPlgOnboardingDto(res.body);
          expect(res.body.status).to.equal('WAITLISTED');
          expect(res.body.reviews).to.be.an('array').with.lengthOf(1);
          expect(res.body.reviews[0].decision).to.equal('UPHELD');
          expect(res.body.reviews[0].justification).to.equal('Not ready to proceed');
          expect(res.body.reviews[0].reason).to.include('already onboarded');
          expect(res.body.reviews[0].reviewedBy).to.be.a('string');
          expectISOTimestamp(res.body.reviews[0].reviewedAt, 'reviewedAt');
        });
      }
    });
  });
}
