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

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import { apiBaseUrl } from './utils/spacecat-utils.js';
import { getSessionToken } from './utils/session-auth.js';

use(sinonChai);
use(chaiAsPromised);

/**
 * E2E tests for the Audit Policy API contract (SITES-47306, SITES-48346):
 * policy read, cursor-paginated revision history, exclusion/inclusion
 * add-remove mutation endpoints, and the still-unimplemented audit-scope
 * view stubs.
 *
 * Required environment variables:
 *   - IMS_ACCESS_TOKEN: an IMS user access token, exchanged once per run for
 *     a session token via POST /auth/login (x-api-key is deprecated).
 *
 * Uses a fixed dev test site rather than auto-discovery, since audit policy
 * mutations need a site with ASO/LLMO write entitlement.
 *
 * Running locally:
 *   mysticat login                                  # once, if not already
 *   export IMS_ACCESS_TOKEN=$(mysticat auth token --ims -e dev)
 *   npx mocha --timeout 30s test/e2e/audit-policy.e2e.js
 *
 * `-e dev` matches this suite's default target (the CI/dev API); set
 * ENVIRONMENT=prod (and get a prod-scoped token instead) to run against prod.
 * Without IMS_ACCESS_TOKEN set, the suite logs a warning and skips instead
 * of failing.
 */
const SITE_ID = '019ef3bd-5e67-7ea1-a4b7-f939f14fdc4e'; // https://main--scope-creep--iuliag.aem.live
// The nil UUID fails isValidUUID (version nibble '0' is not 1-8), so it 400s
// before ever reaching the "site not found" check. Use a well-formed one instead.
const UNKNOWN_SITE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const TEST_GLOB = '/__e2e-audit-policy-test__/*';
const TEST_URL = 'https://main--scope-creep--iuliag.aem.live/__e2e-audit-policy-test__/manual-page';
const REASON = 'audit-policy e2e test run';

// audit_policy_revision timestamps come back as raw Postgres timestamptz text
// (offset + microseconds, e.g. "2026-07-23T14:03:38.083934+00:00"), not the
// app-level Z-suffixed ISO8601 the shared expectValidISODate() expects -
// so just confirm it parses, rather than pinning an exact format.
function expectParsableTimestamp(value) {
  expect(value).to.be.a('string');
  expect(new Date(value).toString()).to.not.equal('Invalid Date', `Expected a valid timestamp, got: ${value}`);
}

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
function removeValues(resource, values) {
  return request({
    path: `/sites/${SITE_ID}/audit-policy/${resource}/delete`,
    method: 'POST',
    body: { values, reason: REASON },
  });
}

describe('Audit Policy - E2E Tests', function auditPolicySuite() {
  this.timeout(30000);

  before(async function beforeAll() {
    const sessionToken = await getSessionToken();
    if (!sessionToken) {
      console.log('[WARN] IMS_ACCESS_TOKEN not set - skipping audit-policy e2e suite');
      this.skip();
      return;
    }
    await removeValues('exclusions', [TEST_GLOB]);
    await removeValues('inclusions', [TEST_URL]);
  });

  describe('GET /audit-policy', () => {
    it('returns a policy document with the expected shape', async () => {
      const response = await request({ path: `/sites/${SITE_ID}/audit-policy` });
      expect(response.status).to.equal(200);
      const policy = await response.json();
      expect(policy).to.include.all.keys(
        'siteId',
        'version',
        'budget',
        'strategyName',
        'exclusionGlobs',
        'manualUrls',
        'scopeConfig',
        'lifecycleOverrides',
        'createdBy',
        'updatedBy',
        'reason',
        'note',
        'createdAt',
        'updatedAt',
      );
      expect(policy.siteId).to.equal(SITE_ID);
      expect(policy.version).to.be.a('number');
      expect(policy.exclusionGlobs).to.be.an('array');
      expect(policy.manualUrls).to.be.an('array');
    });

    it('returns 404 for an unknown site', async () => {
      const response = await request({ path: `/sites/${UNKNOWN_SITE_ID}/audit-policy` });
      expect(response.status).to.equal(404);
    });

    it('returns 400 for a non-UUID site id', async () => {
      const response = await request({ path: '/sites/not-a-uuid/audit-policy' });
      expect(response.status).to.equal(400);
    });

    it('returns 401 without a session token', async () => {
      const response = await request({ path: `/sites/${SITE_ID}/audit-policy`, skipAuth: true });
      expect(response.status).to.equal(401);
    });
  });

  describe('GET /audit-policy/revisions', () => {
    it('returns a paginated list ordered newest-first', async () => {
      const response = await request({ path: `/sites/${SITE_ID}/audit-policy/revisions?limit=5` });
      expect(response.status).to.equal(200);
      const { items, cursor } = await response.json();
      expect(items).to.be.an('array');

      for (let i = 1; i < items.length; i += 1) {
        expect(items[i - 1].version).to.be.greaterThan(items[i].version);
      }
      items.forEach((revision) => {
        expect(revision).to.not.have.property('siteId');
        expect(revision).to.have.property('effectiveAt');
        expectParsableTimestamp(revision.effectiveAt);
      });
      if (cursor !== undefined) {
        expect(cursor).to.be.a('string');
      }
    });

    it('returns 400 for a malformed cursor', async () => {
      // Cursors are base64url integers; "not-base64url" is itself valid
      // base64url alphabet, so it silently decodes instead of failing to
      // decode. Encode a value that decodes to something decodeCursor
      // actually rejects: non-numeric text (parseInt -> NaN).
      const malformedCursor = Buffer.from('not-a-real-cursor', 'utf8').toString('base64url');
      const response = await request({
        path: `/sites/${SITE_ID}/audit-policy/revisions?cursor=${malformedCursor}`,
      });
      expect(response.status).to.equal(400);
    });
  });

  describe('Exclusions - add/remove round trip', () => {
    after(() => removeValues('exclusions', [TEST_GLOB]));

    it('adds an exclusion glob and bumps the version', async () => {
      const before1 = await getPolicy();
      const response = await request({
        path: `/sites/${SITE_ID}/audit-policy/exclusions`,
        method: 'POST',
        body: { values: [TEST_GLOB], reason: REASON },
      });
      expect(response.status).to.equal(200);
      const policy = await response.json();
      expect(policy.exclusionGlobs).to.include(TEST_GLOB);
      expect(policy.version).to.equal(before1.version + 1);
    });

    it('removes the exclusion glob and bumps the version again', async () => {
      const before1 = await getPolicy();
      const response = await removeValues('exclusions', [TEST_GLOB]);
      expect(response.status).to.equal(200);
      const policy = await response.json();
      expect(policy.exclusionGlobs).to.not.include(TEST_GLOB);
      expect(policy.version).to.equal(before1.version + 1);
    });

    it('rejects a path-traversal exclusion glob', async () => {
      const response = await request({
        path: `/sites/${SITE_ID}/audit-policy/exclusions`,
        method: 'POST',
        body: { values: ['../../etc/passwd'], reason: REASON },
      });
      expect(response.status).to.equal(400);
    });

    it('rejects a request missing reason', async () => {
      const response = await request({
        path: `/sites/${SITE_ID}/audit-policy/exclusions`,
        method: 'POST',
        body: { values: [TEST_GLOB] },
      });
      expect(response.status).to.equal(400);
    });

    it('rejects an empty values array', async () => {
      const response = await request({
        path: `/sites/${SITE_ID}/audit-policy/exclusions`,
        method: 'POST',
        body: { values: [], reason: REASON },
      });
      expect(response.status).to.equal(400);
    });
  });

  describe('Inclusions - add/remove round trip', () => {
    after(() => removeValues('inclusions', [TEST_URL]));

    it('adds a manual URL and bumps the version', async () => {
      const before1 = await getPolicy();
      const response = await request({
        path: `/sites/${SITE_ID}/audit-policy/inclusions`,
        method: 'POST',
        body: { values: [TEST_URL], reason: REASON },
      });
      expect(response.status).to.equal(200);
      const policy = await response.json();
      expect(policy.manualUrls).to.include(TEST_URL);
      expect(policy.version).to.equal(before1.version + 1);
    });

    it('removes the manual URL and bumps the version again', async () => {
      const before1 = await getPolicy();
      const response = await removeValues('inclusions', [TEST_URL]);
      expect(response.status).to.equal(200);
      const policy = await response.json();
      expect(policy.manualUrls).to.not.include(TEST_URL);
      expect(policy.version).to.equal(before1.version + 1);
    });
  });

  describe('Audit scope endpoints (not yet implemented)', () => {
    ['pages', 'summary', 'sections'].forEach((subResource) => {
      it(`GET /audit-scope/${subResource} returns 501`, async () => {
        const response = await request({ path: `/sites/${SITE_ID}/audit-scope/${subResource}` });
        expect(response.status).to.equal(501);
        const body = await response.json();
        expect(body).to.have.property('message');
      });
    });
  });
});
