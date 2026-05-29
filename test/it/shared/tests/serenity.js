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
import { ORG_1_ID, BRAND_1_ID } from '../seed-ids.js';

/**
 * Integration tests for the /serenity/* surface (LLMO-5190).
 *
 * Scope and limitation
 * ────────────────────
 * The serenity controller enforces IMS-only authentication
 * (`requireImsBearer`) on every handler dispatch. The shared IT harness mints
 * JWT tokens via `test/it/shared/auth.js` — those are not IMS-typed, so any
 * authenticated GET against `/serenity/*` deterministically returns 401 from
 * the controller before reaching the handler. Until the harness grows the
 * ability to mint IMS-shaped tokens (and the local dev server is configured
 * to trust them), the IT-testable surface is restricted to:
 *
 *   1. Route-gate validation (`src/index.js:349-352`) which fires BEFORE auth:
 *      non-UUID spaceCatId / brandId → 400 with a deterministic message.
 *   2. The controller's 401 contract itself: JWT-authenticated requests must
 *      not be silently accepted by the IMS-required serenity proxy.
 *
 * The end-to-end "list/create/delete market" and "required-filter 400 on
 * prompts/tags/models" paths the bot review asked for are covered today by
 * the unit suites (`test/support/serenity/handlers/*.test.js` — 100% line +
 * branch coverage) and the OpenAPI contract suite (`test/openapi-contract/
 * serenity-api.test.js`). The remaining IT gap is structural (auth-token
 * shape) and is filed for follow-up rather than worked around inside this
 * PR — the workaround alternatives (stubbing requireImsBearer at IT time;
 * injecting a fake IMS token-mint side-by-side with the JWT mint) would
 * either ship test-only code into production paths or duplicate the auth
 * harness in a way that drifts independently.
 */
export default function serenityTests(getHttpClient) {
  describe('Serenity API — route-gate + auth contract (LLMO-5190)', () => {
    it('400s on non-UUID spaceCatId (route gate, before auth)', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/v2/orgs/not-a-uuid/brands/${BRAND_1_ID}/serenity/markets`);
      expect(res.status).to.equal(400);
      // The 400 message is owned by src/index.js — we assert the substring
      // that downstream callers grep for in their own error mapping.
      expect(res.body.message || res.body).to.match(/Organization Id.*invalid/i);
    });

    it('400s on non-UUID brandId (route gate, before auth)', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/not-a-uuid/serenity/markets`);
      expect(res.status).to.equal(400);
    });

    // Locks the contract: the serenity proxy refuses anything that isn't an
    // IMS-typed token. JWT-authenticated callers (which the harness mints by
    // default) get a 401 before the handler ever runs — this prevents
    // accidentally widening the proxy's accepted auth shape later.
    it('401s when the caller is authenticated but not via IMS', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity/markets`);
      expect(res.status).to.equal(401);
    });

    it('401s on prompts endpoint with JWT auth (same IMS-only contract)', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(
        `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity/prompts?geoTargetId=2840&languageCode=en`,
      );
      expect(res.status).to.equal(401);
    });

    it('401s on tags endpoint with JWT auth (same IMS-only contract)', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(
        `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity/tags?geoTargetId=2840&languageCode=en`,
      );
      expect(res.status).to.equal(401);
    });

    it('401s on models endpoint with JWT auth (same IMS-only contract)', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(
        `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity/models?geoTargetId=2840&languageCode=en`,
      );
      expect(res.status).to.equal(401);
    });

    it('401s on DELETE market with JWT auth (same IMS-only contract)', async () => {
      const http = getHttpClient();
      const res = await http.admin.delete(
        `/v2/orgs/${ORG_1_ID}/brands/${BRAND_1_ID}/serenity/markets/2840/en`,
      );
      expect(res.status).to.equal(401);
    });
  });
}
