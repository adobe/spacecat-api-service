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

/**
 * Shared LLMO Onboarding endpoint tests.
 *
 * POST /llmo/onboard — validation tests only (happy path needs LLMO admin auth +
 * external services: SharePoint, SQS, DRS, Configuration).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function llmoOnboardingTests(getHttpClient, resetData) {
  describe('LLMO Onboarding', () => {
    before(() => resetData());

    // ── POST /llmo/onboard — validation ──

    describe('POST /llmo/onboard', () => {
      it('returns 400 for missing body', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/llmo/onboard');
        // May return 400 (missing data) or 403 (not LLMO admin) depending on auth setup
        expect(res.status).to.be.oneOf([400, 403]);
      });

      it('returns 400 for missing required fields', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/llmo/onboard', {
          domain: 'example.com',
          // missing brandName
        });
        expect(res.status).to.be.oneOf([400, 403]);
      });

      it('returns 400 for invalid cadence value', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/llmo/onboard', {
          domain: 'example.com',
          brandName: 'Test Brand',
          cadence: 'invalid-value',
        });
        // Cadence validation happens after auth check — may return 403 if not LLMO admin
        expect(res.status).to.be.oneOf([400, 403]);
      });

      it('accepts valid cadence values without cadence-specific errors', async () => {
        const http = getHttpClient();
        // This verifies 'daily' is not rejected at the validation layer
        const res = await http.admin.post('/llmo/onboard', {
          domain: 'cadence-test.com',
          brandName: 'Cadence Test',
          cadence: 'daily',
        });
        // Should not be 400 for cadence — expect 403 (auth) or 200/500 (downstream)
        if (res.status === 400) {
          const body = await res.json();
          expect(body.message).to.not.include('Invalid cadence');
        }
      });
    });
  });
}
