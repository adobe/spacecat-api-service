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
  TRIAL_USER_1_EMAIL,
  ENTERPRISE_USER_ID,
  ENTERPRISE_USER_EMAIL,
  ENTERPRISE_USER_FIRST_NAME,
  ENTERPRISE_USER_LAST_NAME,
} from '../seed-ids.js';

const OTHER_USER_ID = 'AAAA111122223344BBBBCCDD@1122334455667788990011.e';

/**
 * Shared user-details endpoint tests.
 *
 * Exercises GET /organizations/:organizationId/userDetails/:externalUserId and
 * POST /organizations/:organizationId/userDetails through the real auth stack, so
 * the claim precedence is proven against a signed-and-validated token rather than a
 * hand-built profile object. The `enterpriseUser` persona carries the claim shape
 * spacecat-auth-service actually mints (no `user_id`; the IMS id in both `sub` and
 * `email`; the address only in `preferred_username` / `trial_email`), which is what
 * makes the id-vs-address assertions below meaningful.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function userDetailsTests(getHttpClient, resetData) {
  describe('User Details', () => {
    before(() => resetData());

    describe('GET /organizations/:organizationId/userDetails/:externalUserId', () => {
      it('enterpriseUser: resolves their own details from the auth profile', async () => {
        const http = getHttpClient();
        const res = await http.enterpriseUser.get(
          `/organizations/${ORG_1_ID}/userDetails/${ENTERPRISE_USER_ID}`,
        );
        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({
          firstName: ENTERPRISE_USER_FIRST_NAME,
          lastName: ENTERPRISE_USER_LAST_NAME,
          email: ENTERPRISE_USER_EMAIL,
          organizationId: ORG_1_ID,
        });
      });

      it('enterpriseUser: never surfaces the IMS id as the email address', async () => {
        // The regression this guards: `email` on the JWT carries the IMS user id, so
        // sourcing the response's email field from it would put an id in an email column.
        const http = getHttpClient();
        const res = await http.enterpriseUser.get(
          `/organizations/${ORG_1_ID}/userDetails/${ENTERPRISE_USER_ID}`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.email).to.not.equal(ENTERPRISE_USER_ID);
        expect(res.body.email).to.contain('@example.com');
      });

      it('enterpriseUser: still gets the placeholder for another user', async () => {
        // Resolving arbitrary ids stays admin-gated — the caller-self path must not
        // widen into a general-purpose id-to-name lookup.
        const http = getHttpClient();
        const res = await http.enterpriseUser.get(
          `/organizations/${ORG_1_ID}/userDetails/${OTHER_USER_ID}`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.firstName).to.equal('system');
        expect(res.body.email).to.equal('');
      });

      it('trialUser: a seeded TrialUser row still wins over the self path', async () => {
        const http = getHttpClient();
        const res = await http.trialUser.get(
          `/organizations/${ORG_1_ID}/userDetails/${TRIAL_USER_1_EMAIL}`,
        );
        expect(res.status).to.equal(200);
        expect(res.body.email).to.equal(TRIAL_USER_1_EMAIL);
        expect(res.body.organizationId).to.equal(ORG_1_ID);
      });

      it('enterpriseUser: returns 403 for an org without access', async () => {
        const http = getHttpClient();
        const res = await http.enterpriseUser.get(
          `/organizations/${ORG_2_ID}/userDetails/${ENTERPRISE_USER_ID}`,
        );
        expect(res.status).to.equal(403);
      });

      it('enterpriseUser: returns 404 for a non-existent org', async () => {
        const http = getHttpClient();
        const res = await http.enterpriseUser.get(
          `/organizations/${NON_EXISTENT_ORG_ID}/userDetails/${ENTERPRISE_USER_ID}`,
        );
        expect(res.status).to.equal(404);
      });
    });

    describe('POST /organizations/:organizationId/userDetails', () => {
      it('enterpriseUser: resolves own id and gates the other in one batch', async () => {
        const http = getHttpClient();
        const res = await http.enterpriseUser.post(
          `/organizations/${ORG_1_ID}/userDetails`,
          { userIds: [ENTERPRISE_USER_ID, OTHER_USER_ID] },
        );
        expect(res.status).to.equal(200);

        expect(res.body[ENTERPRISE_USER_ID]).to.deep.equal({
          firstName: ENTERPRISE_USER_FIRST_NAME,
          lastName: ENTERPRISE_USER_LAST_NAME,
          email: ENTERPRISE_USER_EMAIL,
          organizationId: ORG_1_ID,
        });
        expect(res.body[OTHER_USER_ID].firstName).to.equal('system');
        expect(res.body[OTHER_USER_ID].email).to.equal('');
      });

      it('enterpriseUser: returns 400 for an empty userIds array', async () => {
        const http = getHttpClient();
        const res = await http.enterpriseUser.post(
          `/organizations/${ORG_1_ID}/userDetails`,
          { userIds: [] },
        );
        expect(res.status).to.equal(400);
      });
    });
  });
}
