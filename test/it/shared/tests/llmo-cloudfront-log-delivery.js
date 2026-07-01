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

/**
 * Shared LLMO CloudFront CDN log-delivery endpoint tests.
 *
 * Endpoints under test (src/controllers/llmo/llmo-cloudfront.js):
 *   POST /sites/:siteId/llmo/cdn-onboard/cloudfront/log-delivery
 *   POST /sites/:siteId/llmo/cdn-onboard/cloudfront/log-rescan
 *
 * SCOPE — IT only exercises code paths that short-circuit BEFORE any external (AWS STS /
 * CloudWatch Logs) call. Both handlers (a) validate the caller-supplied credentials
 * (validateCloudfrontCredentials) and then (b) run the LLMO-admin access gate — both before
 * assuming the connector role. The IT harness has no AWS mocking, so the success path and the
 * org/destination resolution past the gate stay in the unit tests. What IS covered here:
 *   - access control: 404 (site not found), 403 (no org access), 403 (not an LLMO admin)
 *   - request-body validation: 400 (bad/missing accountId, externalId, distributionId)
 *
 * Validation runs BEFORE the gate, so the 400 cases use the llmoAdmin persona with bad input,
 * while the 404/403 cases use VALID credentials so execution reaches the gate. None of these
 * requests proceeds to an AWS call.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */

// SITE_1 belongs to ORG_1 (the llmoAdmin/user tenancy); SITE_3 belongs to ORG_2 (denied).
const VALID_ACCOUNT_ID = '120569600543';
const VALID_EXTERNAL_ID = '7ff9518a-cf59-40b4-aa53-68a3cb2e24a5';
const VALID_DISTRIBUTION_ID = 'E2EXAMPLE123';
const validCreds = {
  accountId: VALID_ACCOUNT_ID,
  externalId: VALID_EXTERNAL_ID,
  distributionId: VALID_DISTRIBUTION_ID,
};

export default function llmoCloudFrontLogDeliveryTests(getHttpClient, resetData) {
  describe('LLMO CloudFront CDN log delivery', () => {
    before(() => resetData());

    // ── access control (valid creds → execution reaches the gate before any AWS call) ──

    describe('access control', () => {
      it('llmoAdmin: returns 404 for a non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(
          `/sites/${NON_EXISTENT_SITE_ID}/llmo/cdn-onboard/cloudfront/log-delivery`,
          validCreds,
        );
        expect(res.status).to.equal(404);
      });

      it('llmoAdmin: returns 403 for a site in another org', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(
          `/sites/${SITE_3_ID}/llmo/cdn-onboard/cloudfront/log-delivery`,
          validCreds,
        );
        expect(res.status).to.equal(403);
      });

      it('user: returns 403 when the caller is not an LLMO administrator', async () => {
        const http = getHttpClient();
        const res = await http.user.post(
          `/sites/${SITE_1_ID}/llmo/cdn-onboard/cloudfront/log-delivery`,
          validCreds,
        );
        expect(res.status).to.equal(403);
      });

      it('admin: returns 403 — admin access does not grant the LLMO-admin role', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(
          `/sites/${SITE_1_ID}/llmo/cdn-onboard/cloudfront/log-rescan`,
          { accountId: VALID_ACCOUNT_ID, externalId: VALID_EXTERNAL_ID },
        );
        expect(res.status).to.equal(403);
      });
    });

    // ── POST log-delivery — body validation runs before the gate / any external call ──

    describe('POST .../cloudfront/log-delivery', () => {
      const path = `/sites/${SITE_1_ID}/llmo/cdn-onboard/cloudfront/log-delivery`;

      it('returns 400 when accountId is not a 12-digit AWS account id', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(path, { ...validCreds, accountId: '123' });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when externalId is missing', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(path, {
          accountId: VALID_ACCOUNT_ID, distributionId: VALID_DISTRIBUTION_ID,
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when distributionId is missing', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(path, {
          accountId: VALID_ACCOUNT_ID, externalId: VALID_EXTERNAL_ID,
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when distributionId is not a valid CloudFront id', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(path, { ...validCreds, distributionId: 'bad id' });
        expect(res.status).to.equal(400);
      });
    });

    // ── POST log-rescan — accountId + externalId required (no distribution) ────────────

    describe('POST .../cloudfront/log-rescan', () => {
      const path = `/sites/${SITE_1_ID}/llmo/cdn-onboard/cloudfront/log-rescan`;

      it('returns 400 when accountId is not a 12-digit AWS account id', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(path, {
          accountId: '123', externalId: VALID_EXTERNAL_ID,
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when externalId is missing', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(path, { accountId: VALID_ACCOUNT_ID });
        expect(res.status).to.equal(400);
      });
    });
  });
}
