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
import { SITE_1_ID } from '../seed-ids.js';
import {
  OAE_JOB_1_ID,
  OAE_JOB_SITE_3_ID,
} from '../../postgres/seed-data/oae-validations.js';

/**
 * Shared OAE validation endpoint tests.
 *
 * POST /oae-validation/jobs — validation tests only (happy path needs real SQS
 * delivery to spacecat-import-worker, same scoping as the Preflight IT).
 * GET /oae-validation/jobs/:jobId — validation + lookup + resource-level
 * access-control scoping (suggestion -> opportunity -> site -> hasAccess).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function oaeValidationTests(getHttpClient, resetData) {
  describe('OAE Validation', () => {
    before(() => resetData());

    // ── POST /oae-validation/jobs — validation ──

    describe('POST /oae-validation/jobs', () => {
      it('returns 400 for missing body', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/oae-validation/jobs');
        expect(res.status).to.equal(400);
      });

      it('returns 400 for missing siteId', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/oae-validation/jobs', {
          type: 'routing',
          suggestionIds: ['bb111111-1111-4111-b111-111111111111'],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for an invalid siteId', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/oae-validation/jobs', {
          siteId: 'not-a-uuid',
          type: 'routing',
          suggestionIds: ['bb111111-1111-4111-b111-111111111111'],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for a missing type', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/oae-validation/jobs', {
          siteId: SITE_1_ID,
          suggestionIds: ['bb111111-1111-4111-b111-111111111111'],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for an unrecognized type', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/oae-validation/jobs', {
          siteId: SITE_1_ID,
          type: 'bogus-type',
          suggestionIds: ['bb111111-1111-4111-b111-111111111111'],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for empty suggestionIds', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/oae-validation/jobs', {
          siteId: SITE_1_ID,
          type: 'routing',
          suggestionIds: [],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for a non-UUID suggestionId', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/oae-validation/jobs', {
          siteId: SITE_1_ID,
          type: 'routing',
          suggestionIds: ['not-a-uuid'],
        });
        expect(res.status).to.equal(400);
      });
    });

    // ── GET /oae-validation/jobs/:jobId ──

    describe('GET /oae-validation/jobs/:jobId', () => {
      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/oae-validation/jobs/not-a-uuid');
        expect(res.status).to.equal(400);
      });

      it('returns 404 for a non-existent job', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/oae-validation/jobs/99999999-9999-4999-b999-999999999999');
        expect(res.status).to.equal(404);
      });

      it('returns 200 with the per-suggestion results for an existing job', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/oae-validation/jobs/${OAE_JOB_1_ID}`);
        expect(res.status).to.equal(200);
        expect(res.body.jobId).to.equal(OAE_JOB_1_ID);
        expect(res.body.suggestions).to.have.lengthOf(1);
        expect(res.body.suggestions[0]).to.deep.include({
          suggestionId: 'bb111111-1111-4111-b111-111111111111',
          status: 'COMPLETE',
          outcome: 'pass',
        });
      });

      // ── cross-tenant credential-exposure (IDOR) scoping ──
      // oae_validations rows carry no siteId of their own; the owning site is
      // resolved via suggestion -> opportunity -> site and checked with
      // AccessControlUtil, failing closed (404, no existence disclosure) —
      // same shape as loadJobScopedToCaller for the AsyncJob-backed endpoints.

      it('owner: returns 200 for a job whose site the `user` persona has access to', async () => {
        // SITE_1 belongs to ORG_1, of which the `user` persona is a member.
        const http = getHttpClient();
        const res = await http.user.get(`/oae-validation/jobs/${OAE_JOB_1_ID}`);
        expect(res.status).to.equal(200);
        expect(res.body.jobId).to.equal(OAE_JOB_1_ID);
      });

      it('returns 404 for a job owned by a different tenant (no cross-tenant read)', async () => {
        // SITE_3 is ORG_2 — denied to the `user` persona. The job exists, but its
        // existence must not be disclosed to a non-owner.
        const http = getHttpClient();
        const res = await http.user.get(`/oae-validation/jobs/${OAE_JOB_SITE_3_ID}`);
        expect(res.status).to.equal(404);
      });
    });
  });
}
