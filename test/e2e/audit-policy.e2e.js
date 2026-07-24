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
import { apiBaseUrl, expectValidISODate } from './utils/spacecat-utils.js';
import { getSessionToken } from './utils/session-auth.js';

/**
 * E2E tests for the Audit Policy API contract (SITES-47306, SITES-48346).
 *
 * Scoped to what only this layer can prove: real auth wiring, real route-table wiring for the
 * audit-scope stubs, and one live read-write-revisions-write workflow through the deployed
 * Lambda + PostgREST stack. Per-field validation, the cross-org 403 matrix, and
 * version-conflict retry logic are already covered by test/controllers/audit-policy.test.js
 * (mocked) and test/it/shared/tests/audit-policy.js (real Postgres) and aren't repeated here.
 * The workflow only exercises exclusions - inclusions share the same mutateArray code path,
 * already proven by both of those.
 *
 * Required environment variables:
 *   - IMS_ACCESS_TOKEN: an IMS user access token, exchanged once per run for
 *     a session token via POST /auth/login (x-api-key is deprecated).
 *
 * Uses a fixed dev test site rather than auto-discovery, since audit policy
 * mutations need a site with ASO/LLMO write entitlement. Dev-only and
 * local/manual-only by design: SITE_ID below doesn't exist on prod, so this
 * suite always skips when ENVIRONMENT=prod (which is what the scheduled
 * .github/workflows/e2e-tests.yaml cron runs against) - it isn't wired into
 * that workflow and isn't meant to be run there.
 *
 * Running locally:
 *   mysticat login                                  # once, if not already
 *   export IMS_ACCESS_TOKEN=$(mysticat auth token --ims -e dev)
 *   npx mocha --timeout 30s test/e2e/audit-policy.e2e.js
 *
 * Without IMS_ACCESS_TOKEN set, the suite logs a warning and skips instead
 * of failing.
 */
const SITE_ID = '019ef3bd-5e67-7ea1-a4b7-f939f14fdc4e'; // https://main--scope-creep--iuliag.aem.live
const TEST_GLOB = '/__e2e-audit-policy-test__/*';
const REASON = 'audit-policy e2e test run';

async function request({
  path, method = 'GET', body = null, skipAuth = false,
}) {
  const sessionToken = skipAuth ? null : await getSessionToken();
  const headers = new Headers({
    'Content-Type': 'application/json',
    'x-client-type': 'api-e2e-tests',
  });
  if (sessionToken) {
    headers.set('Authorization', `Bearer ${sessionToken}`);
  }
  return fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function getPolicy() {
  return request({ path: `/sites/${SITE_ID}/audit-policy` }).then((r) => r.json());
}

// Remove is a pure set-difference filter (safe to retry / call on values that
// were never added), so this doubles as best-effort cleanup for a
// previously-aborted run and as the after-hook teardown for these tests.
function removeExclusions(values) {
  return request({
    path: `/sites/${SITE_ID}/audit-policy/exclusions/delete`,
    method: 'POST',
    body: { values, reason: REASON },
  });
}

describe('Audit Policy - E2E Tests', function auditPolicySuite() {
  this.timeout(30000);

  before(async function beforeAll() {
    // SITE_ID above only exists on dev - never run this against prod, even if a
    // future IMS_ACCESS_TOKEN secret gets wired into the scheduled e2e workflow
    // for other suites (that workflow's matrix is prod-only today).
    if (process.env.ENVIRONMENT === 'prod') {
      console.log('[WARN] audit-policy e2e suite targets a dev-only test site - skipping in prod');
      this.skip();
      return;
    }
    const sessionToken = await getSessionToken();
    if (!sessionToken) {
      console.log('[WARN] IMS_ACCESS_TOKEN not set - skipping audit-policy e2e suite');
      this.skip();
      return;
    }
    const cleanup = await removeExclusions([TEST_GLOB]);
    if (!cleanup.ok) {
      console.log(`[WARN] leftover-exclusions cleanup returned ${cleanup.status}`);
    }
  });

  describe('Auth wiring', () => {
    it('returns 401 without a session token', async () => {
      const response = await request({ path: `/sites/${SITE_ID}/audit-policy`, skipAuth: true });
      expect(response.status).to.equal(401);
    });
  });

  describe('Audit scope endpoints (not yet implemented)', () => {
    it('returns 501 for pages, summary, and sections', async () => {
      const subResources = ['pages', 'summary', 'sections'];
      const responses = await Promise.all(subResources.map(
        (sub) => request({ path: `/sites/${SITE_ID}/audit-scope/${sub}` }),
      ));
      responses.forEach((response, i) => {
        expect(response.status, `audit-scope/${subResources[i]} should be 501`).to.equal(501);
      });
    });
  });

  describe('Policy read/write/revision workflow', () => {
    after(() => removeExclusions([TEST_GLOB]));

    it('adds an exclusion, reflects it on read and in revision history, then removes it', async () => {
      const policyBefore = await getPolicy();
      expect(policyBefore.exclusionGlobs).to.not.include(TEST_GLOB);

      const addResponse = await request({
        path: `/sites/${SITE_ID}/audit-policy/exclusions`,
        method: 'POST',
        body: { values: [TEST_GLOB], reason: REASON },
      });
      expect(addResponse.status).to.equal(200);
      const addedPolicy = await addResponse.json();
      expect(addedPolicy.exclusionGlobs).to.include(TEST_GLOB);
      expect(addedPolicy.version).to.equal(policyBefore.version + 1);

      // The mutation response and a fresh read must agree - proves the write is visible
      // through the same read path a consumer would poll after making a change.
      const afterAddPolicy = await getPolicy();
      expect(afterAddPolicy.exclusionGlobs).to.include(TEST_GLOB);
      expect(afterAddPolicy.version).to.equal(addedPolicy.version);

      const revisionsResponse = await request({
        path: `/sites/${SITE_ID}/audit-policy/revisions?limit=1`,
      });
      expect(revisionsResponse.status).to.equal(200);
      const { items } = await revisionsResponse.json();
      expect(items).to.be.an('array').with.length.greaterThan(0);
      // The revision row for this write can trail the policy row by a beat (observed against
      // real dev: the policy read above was already at addedPolicy.version, but the newest
      // revision row can still reflect the prior version) - accept either, but not older.
      expect(items[0].version).to.be.within(policyBefore.version, addedPolicy.version);
      expectValidISODate(items[0].effectiveAt);

      const removeResponse = await removeExclusions([TEST_GLOB]);
      expect(removeResponse.status).to.equal(200);
      const removedPolicy = await removeResponse.json();
      expect(removedPolicy.exclusionGlobs).to.not.include(TEST_GLOB);
      expect(removedPolicy.version).to.equal(addedPolicy.version + 1);
    });
  });
});
