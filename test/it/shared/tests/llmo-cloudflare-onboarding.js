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
 * Shared LLMO Cloudflare onboarding endpoint tests.
 *
 * Endpoints under test (src/controllers/llmo/llmo-cloudflare.js):
 *   GET  /sites/:siteId/llmo/cdn-onboard/cloudflare/config
 *   GET  /sites/:siteId/llmo/cdn-onboard/cloudflare/accounts
 *   GET  /sites/:siteId/llmo/cdn-onboard/cloudflare/zones
 *   POST /sites/:siteId/llmo/cdn-onboard/cloudflare/deploy
 *   POST /sites/:siteId/llmo/cdn-onboard/cloudflare/zones/:zoneId/routes
 *
 * SCOPE — IT only exercises code paths that short-circuit BEFORE any external call.
 * The accounts/zones/deploy/route-create handlers ultimately call the external Cloudflare
 * API (and deploy also calls Tokowaka + GitHub raw); the IT harness has no external-HTTP
 * mocking, so those success paths are covered by unit tests, not here. What IS covered:
 *   - access control: 404 (site not found), 403 (no org access), 403 (not an LLMO admin)
 *   - GET config happy path (returns CLOUDFLARE_CLIENT_ID from env)
 *   - 400 missing `x-cloudflare-token` header
 *   - 400 request-body / path-param validation (all evaluated before any external call)
 *
 * Every handler is gated behind AccessControlUtil.isLLMOAdministrator(), a raw JWT-claim
 * check with no admin bypass — so these tests rely on the `llmoAdmin` persona (ORG_1 tenancy
 * + is_llmo_administrator: true). The `admin`/`user` personas are used to assert the gate
 * denies non-LLMO-admins.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */

// SITE_1 belongs to ORG_1 (the llmoAdmin/user tenancy); SITE_3 belongs to ORG_2 (denied).
const VALID_ZONE_ID = '0123456789abcdef0123456789abcdef';
const VALID_ACCOUNT_ID = 'fedcba9876543210fedcba9876543210';
const CF_TOKEN_HEADERS = { 'x-cloudflare-token': 'it-cloudflare-token' };

export default function llmoCloudflareOnboardingTests(getHttpClient, resetData) {
  describe('LLMO Cloudflare Onboarding', () => {
    before(() => resetData());

    // ── access control (shared by all endpoints, exercised via GET config) ──────────

    describe('access control', () => {
      it('llmoAdmin: returns 404 for a non-existent site', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.get(
          `/sites/${NON_EXISTENT_SITE_ID}/llmo/cdn-onboard/cloudflare/config`,
        );
        expect(res.status).to.equal(404);
      });

      it('llmoAdmin: returns 403 for a site in another org', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.get(
          `/sites/${SITE_3_ID}/llmo/cdn-onboard/cloudflare/config`,
        );
        expect(res.status).to.equal(403);
      });

      it('user: returns 403 when the caller is not an LLMO administrator', async () => {
        const http = getHttpClient();
        const res = await http.user.get(
          `/sites/${SITE_1_ID}/llmo/cdn-onboard/cloudflare/config`,
        );
        expect(res.status).to.equal(403);
      });

      it('admin: returns 403 — admin access does not grant the LLMO-admin role', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(
          `/sites/${SITE_1_ID}/llmo/cdn-onboard/cloudflare/config`,
        );
        expect(res.status).to.equal(403);
      });
    });

    // ── GET config ───────────────────────────────────────────────────────────────

    describe('GET .../cloudflare/config', () => {
      it('llmoAdmin: returns the configured Cloudflare client ID', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.get(
          `/sites/${SITE_1_ID}/llmo/cdn-onboard/cloudflare/config`,
        );
        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({ clientId: 'it-cloudflare-client-id' });
      });
    });

    // ── GET accounts / zones — token check is the first gate after access control ──

    describe('GET .../cloudflare/accounts', () => {
      it('llmoAdmin: returns 400 when x-cloudflare-token header is missing', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.get(
          `/sites/${SITE_1_ID}/llmo/cdn-onboard/cloudflare/accounts`,
        );
        expect(res.status).to.equal(400);
      });
    });

    describe('GET .../cloudflare/zones', () => {
      it('llmoAdmin: returns 400 when x-cloudflare-token header is missing', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.get(
          `/sites/${SITE_1_ID}/llmo/cdn-onboard/cloudflare/zones`,
        );
        expect(res.status).to.equal(400);
      });
    });

    // ── POST deploy — validation runs before any external call ─────────────────────

    describe('POST .../cloudflare/deploy', () => {
      const deployPath = `/sites/${SITE_1_ID}/llmo/cdn-onboard/cloudflare/deploy`;

      it('returns 400 when x-cloudflare-token header is missing', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(deployPath, {
          accountId: VALID_ACCOUNT_ID, targetHost: 'www.example.com',
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when accountId is missing', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(
          deployPath,
          { targetHost: 'www.example.com' },
          CF_TOKEN_HEADERS,
        );
        expect(res.status).to.equal(400);
      });

      it('returns 400 when accountId is not a 32-char hex id', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(
          deployPath,
          { accountId: 'acc-123', targetHost: 'www.example.com' },
          CF_TOKEN_HEADERS,
        );
        expect(res.status).to.equal(400);
      });

      it('returns 400 when targetHost is not a valid hostname', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(
          deployPath,
          { accountId: VALID_ACCOUNT_ID, targetHost: 'not a host' },
          CF_TOKEN_HEADERS,
        );
        expect(res.status).to.equal(400);
      });
    });

    // ── POST route create — token, zoneId and body validation precede external calls ─

    describe('POST .../cloudflare/zones/:zoneId/routes', () => {
      const routesPath = (zoneId) => `/sites/${SITE_1_ID}/llmo/cdn-onboard/cloudflare/zones/${zoneId}/routes`;

      it('returns 400 when x-cloudflare-token header is missing', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(routesPath(VALID_ZONE_ID), {
          pattern: 'example.com/*',
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when zoneId is not a 32-char hex id', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(
          routesPath('zone-456'),
          { pattern: 'example.com/*' },
          CF_TOKEN_HEADERS,
        );
        expect(res.status).to.equal(400);
      });

      it('returns 400 when pattern is missing', async () => {
        const http = getHttpClient();
        const res = await http.llmoAdmin.post(
          routesPath(VALID_ZONE_ID),
          {},
          CF_TOKEN_HEADERS,
        );
        expect(res.status).to.equal(400);
      });
    });
  });
}
