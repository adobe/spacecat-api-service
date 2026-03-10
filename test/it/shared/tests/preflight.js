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
  ASYNC_JOB_1_ID,
  NON_EXISTENT_JOB_ID,
} from '../seed-ids.js';

/**
 * Shared Preflight endpoint tests.
 *
 * POST /preflight/jobs — validation tests only (happy path needs external fetch + SQS).
 * GET /preflight/jobs/:jobId — validation + lookup (AsyncJob is v3/PostgreSQL only).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 * @param {object} [options]
 * @param {boolean} [options.skipAsyncJobTests=false] - Skip tests requiring AsyncJob (v2/DynamoDB)
 */
export default function preflightTests(getHttpClient, resetData, options = {}) {
  const { skipAsyncJobTests = false } = options;

  describe('Preflight', () => {
    before(() => resetData());

    // ── POST /preflight/jobs — validation ──

    describe('POST /preflight/jobs', () => {
      it('returns 400 for missing body', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/preflight/jobs');
        expect(res.status).to.equal(400);
      });

      it('returns 400 for missing urls', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/preflight/jobs', { step: 'identify' });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for empty urls array', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/preflight/jobs', { urls: [], step: 'identify' });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for invalid urls', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/preflight/jobs', {
          urls: ['not-a-url'],
          step: 'identify',
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for urls from different hostnames', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/preflight/jobs', {
          urls: ['https://site-a.example.com/page1', 'https://site-b.example.com/page2'],
          step: 'identify',
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for missing step', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/preflight/jobs', {
          urls: ['https://site1.example.com/page1'],
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 for invalid step', async () => {
        const http = getHttpClient();
        const res = await http.admin.post('/preflight/jobs', {
          urls: ['https://site1.example.com/page1'],
          step: 'invalid-step',
        });
        expect(res.status).to.equal(400);
      });
    });

    // ── GET /preflight/jobs/:jobId ──

    describe('GET /preflight/jobs/:jobId', () => {
      it('returns 400 for invalid UUID', async () => {
        const http = getHttpClient();
        const res = await http.admin.get('/preflight/jobs/not-a-uuid');
        expect(res.status).to.equal(400);
      });

      // Tests below require AsyncJob (v3/PostgreSQL only)
      if (!skipAsyncJobTests) {
        it('returns 404 for non-existent job', async () => {
          const http = getHttpClient();
          const res = await http.admin.get(`/preflight/jobs/${NON_EXISTENT_JOB_ID}`);
          expect(res.status).to.equal(404);
        });

        it('returns 200 with full job details for existing job', async () => {
          const http = getHttpClient();
          const res = await http.admin.get(`/preflight/jobs/${ASYNC_JOB_1_ID}`);
          expect(res.status).to.equal(200);

          const job = res.body;
          expect(job.jobId).to.equal(ASYNC_JOB_1_ID);
          expect(job.status).to.equal('COMPLETED');
          expect(job.resultLocation).to.equal('https://results.example.com/preflight-001');
          expect(job.resultType).to.equal('URL');
          expect(job.result).to.deep.equal({
            summary: { totalIssues: 3, criticalIssues: 1 },
          });
          expect(job.metadata).to.be.an('object');
          expect(job.metadata.jobType).to.equal('preflight');
          expect(job.startedAt).to.be.a('string');
          expect(job.endedAt).to.be.a('string');
          expect(job.createdAt).to.be.a('string');
          expect(job.updatedAt).to.be.a('string');
        });
      }
    });
  });
}
