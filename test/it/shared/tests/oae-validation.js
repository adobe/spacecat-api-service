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
import { SITE_1_ID, SITE_3_ID, OPPTY_1_ID } from '../seed-ids.js';
import {
  OAE_JOB_1_ID,
  OAE_JOB_SITE_3_ID,
} from '../../postgres/seed-data/oae-validations.js';

const SUGG_1_ID = 'bb111111-1111-4111-b111-111111111111'; // OPPTY_1 (SITE_1)
const SUGG_4_ID = 'bb444444-4444-4444-a444-444444444444'; // OPPTY_3 (SITE_3) -- NOT under OPPTY_1

/**
 * Shared OAE validation endpoint tests.
 *
 * POST /sites/:siteId/llmo/oae-validation/jobs — validation tests only (happy path needs
 * real SQS delivery to spacecat-import-worker, same scoping as the Preflight IT).
 * GET /sites/:siteId/llmo/oae-validation/jobs/:jobId — validation + lookup + resource-level
 * access-control scoping (suggestion -> opportunity -> site, compared against the URL's
 * siteId, then hasAccess).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function oaeValidationTests(getHttpClient, resetData) {
  describe('OAE Validation', () => {
    before(() => resetData());

    // ── POST /sites/:siteId/llmo/oae-validation/jobs — validation ──

    describe('POST /sites/:siteId/llmo/oae-validation/jobs', () => {
      it('returns 400 for missing body', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs`);
        expect(res.status).to.equal(400);
      });

      it('returns 400 for an invalid siteId', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/sites/not-a-uuid/llmo/oae-validation/jobs', {
          opportunityId: OPPTY_1_ID,
          type: 'routing',
          suggestionIds: [SUGG_1_ID],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for a missing opportunityId', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs`, {
          type: 'routing',
          suggestionIds: [SUGG_1_ID],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for a missing type', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs`, {
          opportunityId: OPPTY_1_ID,
          suggestionIds: [SUGG_1_ID],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for an unrecognized type', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs`, {
          opportunityId: OPPTY_1_ID,
          type: 'bogus-type',
          suggestionIds: [SUGG_1_ID],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for empty suggestionIds', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs`, {
          opportunityId: OPPTY_1_ID,
          type: 'routing',
          suggestionIds: [],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for a non-UUID suggestionId', async () => {
        const http = getHttpClient();
        const res = await http.admin.post(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs`, {
          opportunityId: OPPTY_1_ID,
          type: 'routing',
          suggestionIds: ['not-a-uuid'],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when a suggestionId does not belong to opportunityId', async () => {
        const http = getHttpClient();
        // SUGG_4 is under OPPTY_3, not OPPTY_1.
        const res = await http.admin.post(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs`, {
          opportunityId: OPPTY_1_ID,
          type: 'routing',
          suggestionIds: [SUGG_4_ID],
        });
        expect(res.status).to.equal(400);
      });
    });

    // ── GET /sites/:siteId/llmo/oae-validation/jobs/:jobId ──

    describe('GET /sites/:siteId/llmo/oae-validation/jobs/:jobId', () => {
      it('returns 400 for invalid jobId', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs/not-a-uuid`);
        expect(res.status).to.equal(400);
      });

      it('returns 400 for invalid siteId', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/not-a-uuid/llmo/oae-validation/jobs/${OAE_JOB_1_ID}`);
        expect(res.status).to.equal(400);
      });

      it('returns 404 for a non-existent job', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs/99999999-9999-4999-b999-999999999999`);
        expect(res.status).to.equal(404);
      });

      it('returns 200 with the per-suggestion results for an existing job', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs/${OAE_JOB_1_ID}`);
        expect(res.status).to.equal(200);
        expect(res.body.jobId).to.equal(OAE_JOB_1_ID);
        expect(res.body.suggestions).to.have.lengthOf(1);
        expect(res.body.suggestions[0]).to.deep.include({
          suggestionId: SUGG_1_ID,
          status: 'COMPLETE',
          outcome: 'pass',
        });
      });

      // ── cross-tenant credential-exposure (IDOR) scoping ──
      // oae_validations rows carry no siteId of their own; the owning site is resolved via
      // suggestion -> opportunity -> site, compared against the URL's siteId (fail closed, 404,
      // no existence disclosure, if it doesn't match), then checked with AccessControlUtil
      // (403 once the site is confirmed) -- same shape as loadJobScopedToCaller for the
      // AsyncJob-backed endpoints.

      it('owner: returns 200 for a job whose site the `user` persona has access to', async () => {
        // SITE_1 belongs to ORG_1, of which the `user` persona is a member.
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs/${OAE_JOB_1_ID}`);
        expect(res.status).to.equal(200);
        expect(res.body.jobId).to.equal(OAE_JOB_1_ID);
      });

      it('returns 403 when the `user` persona correctly names the job\'s real site but lacks access to it', async () => {
        // SITE_3 is ORG_2 -- denied to the `user` persona, but this URL truthfully names the
        // job's real owning site, so the site-match check passes and access control is the
        // only thing standing in the way.
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_3_ID}/llmo/oae-validation/jobs/${OAE_JOB_SITE_3_ID}`);
        expect(res.status).to.equal(403);
      });

      it('returns 404 when the URL names a site the job does not actually belong to (no cross-tenant read via site substitution)', async () => {
        // The job exists and really belongs to SITE_3, but the caller names SITE_1 (their own,
        // accessible site) instead -- the site-match check must fail closed before access
        // control ever runs, so the job's existence under a different site is not disclosed.
        const http = getHttpClient();
        const res = await http.user.get(`/sites/${SITE_1_ID}/llmo/oae-validation/jobs/${OAE_JOB_SITE_3_ID}`);
        expect(res.status).to.equal(404);
      });
    });
  });
}
