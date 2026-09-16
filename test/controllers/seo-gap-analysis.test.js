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

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import { AsyncJob } from '@adobe/spacecat-shared-data-access';

import SeoGapAnalysisController from '../../src/controllers/seo-gap-analysis.js';

use(sinonChai);

const JOB_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TARGET = 'https://mybrand.com/page';

describe('SeoGapAnalysisController', () => {
  const sandbox = sinon.createSandbox();

  const log = {
    info: sandbox.stub(), error: sandbox.stub(), warn: sandbox.stub(), debug: sandbox.stub(),
  };

  const mockJob = {
    getId: sandbox.stub().returns(JOB_ID),
    getStatus: sandbox.stub().returns(AsyncJob.Status.IN_PROGRESS),
    getCreatedAt: sandbox.stub().returns('2026-01-01T00:00:00Z'),
    getUpdatedAt: sandbox.stub().returns('2026-01-01T00:00:01Z'),
    getResult: sandbox.stub().returns(null),
    getError: sandbox.stub().returns(null),
    getMetadata: sandbox.stub().returns({ jobType: 'seo-gap-analysis', payload: {} }),
    remove: sandbox.stub().resolves(),
    setStatus: sandbox.stub(),
    setError: sandbox.stub(),
    save: sandbox.stub().resolves(),
  };

  const mockDataAccess = {
    AsyncJob: { create: sandbox.stub(), findById: sandbox.stub() },
  };
  const mockSqs = { sendMessage: sandbox.stub().resolves() };
  const env = {
    AUDIT_JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/queue/audit-jobs',
    AWS_ENV: 'prod',
  };

  let controller;

  beforeEach(() => {
    sandbox.resetHistory();
    mockDataAccess.AsyncJob.create.resolves(mockJob);
    mockDataAccess.AsyncJob.findById.resolves(mockJob);
    mockJob.getResult.returns(null);
    mockJob.getError.returns(null);
    mockJob.getMetadata.returns({ jobType: 'seo-gap-analysis', payload: {} });
    mockSqs.sendMessage.resolves();
    controller = SeoGapAnalysisController({ dataAccess: mockDataAccess, sqs: mockSqs }, log, env);
  });

  afterEach(() => sandbox.restore());

  describe('constructor validation', () => {
    it('throws when context is missing', () => {
      expect(() => SeoGapAnalysisController(null, log, env)).to.throw('Context required');
    });
    it('throws when dataAccess is missing', () => {
      expect(() => SeoGapAnalysisController({ dataAccess: null, sqs: mockSqs }, log, env))
        .to.throw('Data access required');
    });
    it('throws when sqs is missing', () => {
      expect(() => SeoGapAnalysisController({ dataAccess: mockDataAccess, sqs: null }, log, env))
        .to.throw('SQS client required');
    });
    it('throws when env is missing', () => {
      const ctx = { dataAccess: mockDataAccess, sqs: mockSqs };
      expect(() => SeoGapAnalysisController(ctx, log, null))
        .to.throw('Environment object required');
    });
  });

  describe('createSeoGapAnalysisJob', () => {
    const validBody = { keyword: 'running shoes', targetUrl: TARGET, filterDomains: ['mybrand.com'] };

    it('returns 500 when the queue URL is not configured', async () => {
      const ctrl = SeoGapAnalysisController({ dataAccess: mockDataAccess, sqs: mockSqs }, log, { AWS_ENV: 'prod' });
      const res = await ctrl.createSeoGapAnalysisJob({ data: validBody });
      expect(res.status).to.equal(500);
    });

    it('returns 400 when body is missing', async () => {
      const res = await controller.createSeoGapAnalysisJob({ data: null });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when keyword is missing', async () => {
      const res = await controller.createSeoGapAnalysisJob({ data: { targetUrl: TARGET } });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when targetUrl is invalid', async () => {
      const res = await controller.createSeoGapAnalysisJob({
        data: { keyword: 'x', targetUrl: 'not-a-url' },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when filterDomains is not a valid list', async () => {
      const res = await controller.createSeoGapAnalysisJob({
        data: { keyword: 'x', targetUrl: TARGET, filterDomains: ['https://bad.com/x'] },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when filterDomains exceeds the cap', async () => {
      const res = await controller.createSeoGapAnalysisJob({
        data: { keyword: 'x', targetUrl: TARGET, filterDomains: Array(51).fill('a.com') },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 202 and enqueues the job for a valid request', async () => {
      const res = await controller.createSeoGapAnalysisJob({ data: validBody });
      expect(res.status).to.equal(202);
      const body = await res.json();
      expect(body.jobId).to.equal(JOB_ID);
      expect(body.pollUrl).to.contain(`/seo-gap-analysis/jobs/${JOB_ID}`);
      expect(mockSqs.sendMessage).to.have.been.calledOnce;
      const msg = mockSqs.sendMessage.firstCall.args[1];
      expect(msg.type).to.equal('seo-gap-analysis');
      expect(msg.keyword).to.equal('running shoes');
    });

    it('accepts a request without optional fields (dev pollUrl)', async () => {
      const ctrl = SeoGapAnalysisController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        log,
        { AUDIT_JOBS_QUEUE_URL: 'q', AWS_ENV: 'dev' },
      );
      const res = await ctrl.createSeoGapAnalysisJob({
        data: { keyword: 'x', targetUrl: TARGET },
      });
      expect(res.status).to.equal(202);
      const body = await res.json();
      expect(body.pollUrl).to.contain('/api/ci/');
    });

    it('removes the orphan job and returns 500 when SQS fails', async () => {
      mockSqs.sendMessage.rejects(new Error('sqs down'));
      const res = await controller.createSeoGapAnalysisJob({ data: validBody });
      expect(res.status).to.equal(500);
      expect(mockJob.remove).to.have.been.calledOnce;
    });

    it('logs but does not throw when orphan removal also fails', async () => {
      mockSqs.sendMessage.rejects(new Error('sqs down'));
      mockJob.remove.rejects(new Error('remove failed'));
      const res = await controller.createSeoGapAnalysisJob({ data: validBody });
      expect(res.status).to.equal(500);
      mockJob.remove.resolves();
    });

    it('returns 500 when job creation throws', async () => {
      mockDataAccess.AsyncJob.create.rejects(new Error('db down'));
      const res = await controller.createSeoGapAnalysisJob({ data: validBody });
      expect(res.status).to.equal(500);
    });
  });

  describe('getSeoGapAnalysisJobStatus', () => {
    it('returns 400 for an invalid jobId', async () => {
      const res = await controller.getSeoGapAnalysisJobStatus({ params: { jobId: 'nope' } });
      expect(res.status).to.equal(400);
    });

    it('returns 404 when the job is of a different type', async () => {
      mockJob.getMetadata.returns({ jobType: 'site-detection' });
      const res = await controller.getSeoGapAnalysisJobStatus({ params: { jobId: JOB_ID } });
      expect(res.status).to.equal(404);
    });

    it('returns 200 with the report result', async () => {
      mockJob.getResult.returns({ summary: { gapsFound: 3 } });
      const res = await controller.getSeoGapAnalysisJobStatus({ params: { jobId: JOB_ID } });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.jobId).to.equal(JOB_ID);
      expect(body.result.summary.gapsFound).to.equal(3);
    });

    it('surfaces a job error object', async () => {
      mockJob.getError.returns({ code: 'EXCEPTION', message: 'boom' });
      const res = await controller.getSeoGapAnalysisJobStatus({ params: { jobId: JOB_ID } });
      const body = await res.json();
      expect(body.error.code).to.equal('EXCEPTION');
    });

    it('returns 500 when the lookup throws', async () => {
      mockDataAccess.AsyncJob.findById.rejects(new Error('db boom'));
      const res = await controller.getSeoGapAnalysisJobStatus({ params: { jobId: JOB_ID } });
      expect(res.status).to.equal(500);
    });
  });
});
