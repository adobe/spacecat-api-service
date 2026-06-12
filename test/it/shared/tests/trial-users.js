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
  ORG_1_ID,
  ORG_2_ID,
  NON_EXISTENT_ORG_ID,
  TRIAL_USER_1_ID,
} from '../seed-ids.js';

/**
 * Shared trial-users endpoint tests.
 * Exercises GET /organizations/:organizationId/trial-users across auth personas,
 * including the S2S capability grant/denial paths introduced in this PR.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function trialUsersTests(getHttpClient, resetData) {
  describe('Trial Users', () => {
    describe('GET /organizations/:organizationId/trial-users', () => {
      before(() => resetData());

      // ── Admin path ──

      it('admin: returns trial users for accessible org', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/organizations/${ORG_1_ID}/trial-users`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf.at.least(1);
        const ids = res.body.map((u) => u.id);
        expect(ids).to.include(TRIAL_USER_1_ID);
      });

      // ── Regular user paths ──

      it('user: returns trial users for accessible org', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${ORG_1_ID}/trial-users`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf.at.least(1);
      });

      it('user: returns 403 for org without access', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${ORG_2_ID}/trial-users`);
        expect(res.status).to.equal(403);
      });

      it('user: returns 404 for non-existent org', async () => {
        const http = getHttpClient();
        const res = await http.user.get(`/organizations/${NON_EXISTENT_ORG_ID}/trial-users`);
        expect(res.status).to.equal(404);
      });

      // ── S2S capability paths ──

      it('s2sConsumerReadAll: returns trial users (has trialUser:read)', async () => {
        const http = getHttpClient();
        const res = await http.s2sConsumerReadAll.get(`/organizations/${ORG_1_ID}/trial-users`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array').with.lengthOf.at.least(1);
        const ids = res.body.map((u) => u.id);
        expect(ids).to.include(TRIAL_USER_1_ID);
      });

      it('s2sConsumerReadOnly: returns 403 (missing trialUser:read)', async () => {
        // CONSUMER_1 has only site:read + site:write — Layer 1 denies at the
        // capability check before the controller is even reached.
        const http = getHttpClient();
        const res = await http.s2sConsumerReadOnly.get(`/organizations/${ORG_1_ID}/trial-users`);
        expect(res.status).to.equal(403);
      });

      it('s2sConsumerUnknown: returns 403 (no Consumer row)', async () => {
        const http = getHttpClient();
        const res = await http.s2sConsumerUnknown.get(`/organizations/${ORG_1_ID}/trial-users`);
        expect(res.status).to.equal(403);
      });
    });
  });
}
