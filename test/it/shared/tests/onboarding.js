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
  ORG_3_ID, // user persona is NOT a member of ORG_3
  NON_EXISTENT_ORG_ID,
} from '../seed-ids.js';

/**
 * Shared integration tests for POST /v2/orgs/:spaceCatId/onboarding.
 *
 * Scope is the auth gate that resolves against the real DB *before* the endpoint
 * calls the external Slack webhook: org existence and membership. The webhook
 * success path (200) depends on an external service and is covered by the unit
 * suites (test/controllers/onboarding.test.js, test/support/onboarding).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function onboardingTests(getHttpClient, resetData) {
  describe('POST /v2/orgs/:spaceCatId/onboarding', () => {
    before(() => resetData());

    const onboardingPath = (orgId) => `/v2/orgs/${orgId}/onboarding`;

    it('returns 404 when the organization does not exist', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(onboardingPath(NON_EXISTENT_ORG_ID), {});
      expect(res.status).to.equal(404);
    });

    it('returns 403 for a non-member (user persona on an org they do not belong to)', async () => {
      const http = getHttpClient();
      const res = await http.user.post(onboardingPath(ORG_3_ID), {});
      expect(res.status).to.equal(403);
    });
  });
}
