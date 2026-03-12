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
    });

    // ── GET /plg/onboard/status/:imsOrgId ──

    describe('GET /plg/onboard/status/:imsOrgId', () => {
      it('returns 400 for invalid imsOrgId', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/plg/onboard/status/not-valid');
        expect(res.status).to.equal(400);
      });

      it('returns 403 when caller org does not match requested org', async () => {
        // admin token has ORG_1 tenant; requesting ORG_2 status should be forbidden
        const http = getHttpClient();
        const res = await http.admin.get(`/plg/onboard/status/${ORG_2_IMS_ORG_ID}`);
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

          expect(res.body).to.be.an('array').with.lengthOf(1);
          const record = res.body[0];
          expectPlgOnboardingDto(record);
          expect(record.id).to.equal(PLG_ONBOARDING_1_ID);
          expect(record.imsOrgId).to.equal(ORG_1_IMS_ORG_ID);
          expect(record.domain).to.equal(PLG_ONBOARDING_1_DOMAIN);
          expect(record.status).to.equal('ONBOARDED');
          expect(record.siteId).to.be.a('string');
          expect(record.organizationId).to.be.a('string');
        });
      }
    });
  });
}
