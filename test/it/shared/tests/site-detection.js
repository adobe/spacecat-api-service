/*
 * Copyright 2025 Adobe. All rights reserved.
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
  ASYNC_JOB_2_ID,
  NON_EXISTENT_JOB_ID,
} from '../seed-ids.js';

/**
 * Shared Site Detection endpoint tests.
 *
 * POST /sites/detect/jobs — validation only.
 *   (202 happy path requires a live SQS queue; duplicate detection is owned
 *   by the worker, so the API no longer returns 409.)
 * GET /sites/detect/jobs/:jobId — validation + lookup.
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function siteDetectionTests(getHttpClient, resetData) {
  describe('Site Detection', () => {
    before(() => resetData());

    // ── POST /sites/detect/jobs — validation ──

    describe('POST /sites/detect/jobs', () => {
      it('returns 400 when body is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/sites/detect/jobs');
        expect(res.status).to.equal(400);
      });

      it('returns 400 when domain is missing', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/sites/detect/jobs', { hlxVersion: 5 });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when domain contains a scheme', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/sites/detect/jobs', {
          domain: 'https://foo.example.com',
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when hlxVersion is not an integer', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/sites/detect/jobs', {
          domain: 'foo.example.com',
          hlxVersion: 'five',
        });
        expect(res.status).to.equal(400);
      });
    });

    // ── GET /sites/detect/jobs/:jobId ──

    describe('GET /sites/detect/jobs/:jobId', () => {
      it('returns 400 for an invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/sites/detect/jobs/not-a-uuid');
        expect(res.status).to.equal(400);
      });

      it('returns 404 for a non-existent job', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/detect/jobs/${NON_EXISTENT_JOB_ID}`);
        expect(res.status).to.equal(404);
      });

      it('returns 200 with job fields for an existing site-detection job', async () => {
        const http = getHttpClient();
        const res = await http.admin.get(`/sites/detect/jobs/${ASYNC_JOB_2_ID}`);
        expect(res.status).to.equal(200);

        const job = res.body;
        expect(job.jobId).to.equal(ASYNC_JOB_2_ID);
        expect(job.status).to.equal('IN_PROGRESS');
        expect(job.result).to.be.null;
        expect(job.error).to.be.null;
        expect(job.createdAt).to.be.a('string');
        expect(job.updatedAt).to.be.a('string');
      });
    });
  });
}
