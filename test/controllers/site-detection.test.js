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

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import { AsyncJob } from '@adobe/spacecat-shared-data-access';

import SiteDetectionController from '../../src/controllers/site-detection.js';

use(sinonChai);

const JOB_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('SiteDetectionController', () => {
  const sandbox = sinon.createSandbox();

  // Stubs are created at describe-scope (not inside beforeEach) intentionally.
  // sandbox.resetHistory() in beforeEach clears call records between tests, and
  // sandbox.restore() in afterEach does NOT nullify these standalone stubs
  // (restore() only uninstalls stubs created via sandbox.stub(obj, 'method')).
  // This pattern is safe here because none of these stubs replace object properties.
  const log = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
    debug: sandbox.stub(),
  };

  const mockJob = {
    getId: sandbox.stub().returns(JOB_ID),
    getStatus: sandbox.stub().returns(AsyncJob.Status.IN_PROGRESS),
    getCreatedAt: sandbox.stub().returns('2025-01-01T00:00:00Z'),
    getUpdatedAt: sandbox.stub().returns('2025-01-01T00:00:01Z'),
    getResult: sandbox.stub().returns(null),
    getError: sandbox.stub().returns(null),
    remove: sandbox.stub().resolves(),
    setStatus: sandbox.stub(),
    setError: sandbox.stub(),
    save: sandbox.stub().resolves(),
  };

  const mockDataAccess = {
    AsyncJob: { create: sandbox.stub(), findById: sandbox.stub() },
    Site: { findByBaseURL: sandbox.stub() },
    Organization: { findById: sandbox.stub() },
  };

  const mockSqs = {
    sendMessage: sandbox.stub().resolves(),
  };

  const env = {
    AUDIT_JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/queue/audit-jobs',
    AWS_ENV: 'prod',
  };

  let controller;

  beforeEach(() => {
    sandbox.resetHistory();
    mockDataAccess.AsyncJob.create.resolves(mockJob);
    mockDataAccess.AsyncJob.findById.resolves(mockJob);
    mockDataAccess.Site.findByBaseURL.resolves(null);
    mockDataAccess.Organization.findById.resolves(null);
    mockJob.getResult.returns(null);
    mockJob.getError.returns(null);
    mockJob.getStatus.returns(AsyncJob.Status.IN_PROGRESS);

    controller = SiteDetectionController(
      { dataAccess: mockDataAccess, sqs: mockSqs },
      log,
      env,
    );
  });

  afterEach(() => {
    sandbox.restore();
  });

  // ── Constructor validation ────────────────────────────────────────────────

  it('throws when context is not an object', () => {
    expect(() => SiteDetectionController(null, log, env)).to.throw('Context required');
  });

  it('throws when dataAccess is missing', () => {
    expect(() => SiteDetectionController({ dataAccess: null, sqs: mockSqs }, log, env))
      .to.throw('Data access required');
  });

  it('throws when sqs is missing', () => {
    expect(() => SiteDetectionController({ dataAccess: mockDataAccess, sqs: null }, log, env))
      .to.throw('SQS client required');
  });

  it('throws when env is not an object', () => {
    expect(() => SiteDetectionController(
      { dataAccess: mockDataAccess, sqs: mockSqs },
      log,
      null,
    )).to.throw('Environment object required');
  });

  it('returns 500 from createSiteDetectionJob when AUDIT_JOBS_QUEUE_URL is missing', async () => {
    const ctrl = SiteDetectionController(
      { dataAccess: mockDataAccess, sqs: mockSqs },
      log,
      { AWS_ENV: 'prod' },
    );
    const resp = await ctrl.createSiteDetectionJob({ data: { domain: 'foo.example.com' } });
    expect(resp.status).to.equal(500);
  });

  it('getSiteDetectionJobStatus still works when AUDIT_JOBS_QUEUE_URL is missing', async () => {
    const ctrl = SiteDetectionController(
      { dataAccess: mockDataAccess, sqs: mockSqs },
      log,
      { AWS_ENV: 'prod' },
    );
    const resp = await ctrl.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
    expect(resp.status).to.equal(200);
  });

  // ── createSiteDetectionJob ────────────────────────────────────────────────

  describe('createSiteDetectionJob', () => {
    it('returns 400 when body data is missing', async () => {
      const resp = await controller.createSiteDetectionJob({ data: null });
      expect(resp.status).to.equal(400);
    });

    it('returns 400 when domain is missing', async () => {
      const resp = await controller.createSiteDetectionJob({ data: { hlxVersion: 5 } });
      expect(resp.status).to.equal(400);
    });

    it('returns 400 when domain contains a scheme', async () => {
      const resp = await controller.createSiteDetectionJob({
        data: { domain: 'https://foo.example.com' },
      });
      expect(resp.status).to.equal(400);
    });

    it('returns 400 when domain contains a path', async () => {
      const resp = await controller.createSiteDetectionJob({
        data: { domain: 'foo.example.com/path' },
      });
      expect(resp.status).to.equal(400);
    });

    it('returns 400 when domain contains whitespace', async () => {
      const resp = await controller.createSiteDetectionJob({
        data: { domain: 'foo example.com' },
      });
      expect(resp.status).to.equal(400);
    });

    it('returns 400 when domain exceeds 253 characters', async () => {
      const resp = await controller.createSiteDetectionJob({
        data: { domain: `${'a'.repeat(250)}.com` },
      });
      expect(resp.status).to.equal(400);
    });

    it('returns 400 when hlxVersion is not an integer', async () => {
      const resp = await controller.createSiteDetectionJob({
        data: { domain: 'foo.example.com', hlxVersion: 'five' },
      });
      expect(resp.status).to.equal(400);
    });

    it('returns 202 with jobId and pollUrl for a valid domain', async () => {
      const resp = await controller.createSiteDetectionJob({
        data: { domain: 'foo.example.com', hlxVersion: 5 },
      });
      expect(resp.status).to.equal(202);

      const body = await resp.json();
      expect(body.jobId).to.equal(JOB_ID);
      expect(body.status).to.equal(AsyncJob.Status.IN_PROGRESS);
      expect(body.pollUrl).to.include(JOB_ID);
      expect(body.pollUrl).to.include('/v1/sites/detect/jobs/');
    });

    it('uses ci in pollUrl when AWS_ENV is dev', async () => {
      controller = SiteDetectionController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        log,
        { ...env, AWS_ENV: 'dev' },
      );

      const resp = await controller.createSiteDetectionJob({
        data: { domain: 'foo.example.com' },
      });
      const body = await resp.json();
      expect(body.pollUrl).to.include('/ci/sites/detect/jobs/');
    });

    it('creates the AsyncJob with correct payload and enum status', async () => {
      await controller.createSiteDetectionJob({
        data: { domain: 'foo.example.com', hlxVersion: 4 },
      });

      expect(mockDataAccess.AsyncJob.create).to.have.been.calledWith({
        status: AsyncJob.Status.IN_PROGRESS,
        metadata: {
          payload: { domain: 'foo.example.com', hlxVersion: 4 },
          jobType: 'site-detection',
          tags: ['site-detection'],
        },
      });
    });

    it('sets hlxVersion to null when not provided', async () => {
      await controller.createSiteDetectionJob({ data: { domain: 'foo.example.com' } });

      const createArg = mockDataAccess.AsyncJob.create.lastCall.args[0];
      expect(createArg.metadata.payload.hlxVersion).to.be.null;
    });

    it('sends SQS message with jobId and type', async () => {
      await controller.createSiteDetectionJob({ data: { domain: 'foo.example.com' } });

      expect(mockSqs.sendMessage).to.have.been.calledWith(
        env.AUDIT_JOBS_QUEUE_URL,
        { jobId: JOB_ID, type: 'site-detection' },
      );
    });

    it('removes the job and returns 500 when SQS send fails', async () => {
      mockSqs.sendMessage.rejects(new Error('SQS unavailable'));

      const resp = await controller.createSiteDetectionJob({ data: { domain: 'foo.example.com' } });
      expect(resp.status).to.equal(500);
      expect(mockJob.remove).to.have.been.calledOnce;
    });

    it('marks job FAILED and returns 500 when both SQS send and job.remove fail', async () => {
      mockSqs.sendMessage.rejects(new Error('SQS unavailable'));
      mockJob.remove.rejects(new Error('DB unavailable'));

      const resp = await controller.createSiteDetectionJob({ data: { domain: 'foo.example.com' } });
      expect(resp.status).to.equal(500);
      expect(mockJob.setStatus).to.have.been.calledWith(AsyncJob.Status.FAILED);
      expect(mockJob.setError).to.have.been.calledWith(sinon.match({ code: 'SQS_FAILURE' }));
      expect(mockJob.save).to.have.been.calledOnce;
    });

    it('logs the save failure when SQS, remove, and save all fail', async () => {
      mockSqs.sendMessage.rejects(new Error('SQS unavailable'));
      mockJob.remove.rejects(new Error('DB unavailable'));
      mockJob.save.rejects(new Error('Save also unavailable'));

      const resp = await controller.createSiteDetectionJob({ data: { domain: 'foo.example.com' } });
      expect(resp.status).to.equal(500);
      expect(log.error).to.have.been.calledWith(
        sinon.match(/Failed to mark orphan job .* as FAILED/),
      );
    });

    it('returns 500 when AsyncJob.create throws', async () => {
      mockDataAccess.AsyncJob.create.rejects(new Error('DB error'));

      const resp = await controller.createSiteDetectionJob({ data: { domain: 'foo.example.com' } });
      expect(resp.status).to.equal(500);
    });
  });

  // ── getSiteDetectionJobStatus ─────────────────────────────────────────────

  describe('getSiteDetectionJobStatus', () => {
    it('returns 400 for an invalid jobId', async () => {
      const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: 'not-a-uuid' } });
      expect(resp.status).to.equal(400);
    });

    it('returns 404 when the job does not exist', async () => {
      mockDataAccess.AsyncJob.findById.resolves(null);

      const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
      expect(resp.status).to.equal(404);
    });

    it('returns 200 with job status and null result/error when pending', async () => {
      const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
      expect(resp.status).to.equal(200);

      const body = await resp.json();
      expect(body.jobId).to.equal(JOB_ID);
      expect(body.status).to.equal(AsyncJob.Status.IN_PROGRESS);
      expect(body.result).to.be.null;
      expect(body.error).to.be.null;
    });

    it('returns result with action/domain/reason when job has result', async () => {
      mockJob.getResult.returns({
        action: 'created',
        domain: 'foo.example.com',
        reason: undefined,
        baseURL: 'https://foo.example.com',
      });

      const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
      const body = await resp.json();
      expect(body.result.action).to.equal('created');
      expect(body.result.domain).to.equal('foo.example.com');
      expect(body.result.baseURL).to.equal('https://foo.example.com');
    });

    it('strips stack trace — only exposes code and message from error', async () => {
      mockJob.getError.returns({
        code: 'EXCEPTION',
        message: 'Something broke',
        details: 'Error: Something broke\n  at handler.js:42',
      });

      const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
      const body = await resp.json();
      expect(body.error.code).to.equal('EXCEPTION');
      expect(body.error.message).to.equal('Something broke');
      expect(body.error).to.not.have.property('details');
    });

    it('returns 500 when AsyncJob.findById throws', async () => {
      mockDataAccess.AsyncJob.findById.rejects(new Error('DB error'));

      const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
      expect(resp.status).to.equal(500);
    });

    // ── imsOrgId resolution ────────────────────────────────────────────────

    describe('imsOrgId resolution', () => {
      const completedCreatedResult = {
        action: 'created',
        domain: 'foo.example.com',
        reason: null,
        baseURL: 'https://foo.example.com',
      };

      beforeEach(() => {
        mockDataAccess.Site.findByBaseURL.resetHistory();
        mockDataAccess.Organization.findById.resetHistory();
        mockJob.getStatus.returns(AsyncJob.Status.COMPLETED);
        mockJob.getResult.returns(completedCreatedResult);
      });

      it('returns imsOrgId when Site is linked to an Organization', async () => {
        const site = { getOrganizationId: sandbox.stub().returns('org-123') };
        const organization = { getImsOrgId: sandbox.stub().returns('1234567890ABCDEF12345678@AdobeOrg') };
        mockDataAccess.Site.findByBaseURL.resolves(site);
        mockDataAccess.Organization.findById.resolves(organization);

        const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
        const body = await resp.json();
        expect(body.result.imsOrgId).to.equal('1234567890ABCDEF12345678@AdobeOrg');
        expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledWith('https://foo.example.com');
        expect(mockDataAccess.Organization.findById).to.have.been.calledWith('org-123');
      });

      it('returns null imsOrgId when Site does not exist yet', async () => {
        mockDataAccess.Site.findByBaseURL.resolves(null);

        const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
        const body = await resp.json();
        expect(body.result.imsOrgId).to.be.null;
        expect(mockDataAccess.Organization.findById).to.not.have.been.called;
      });

      it('returns null imsOrgId when Site exists but has no organizationId', async () => {
        mockDataAccess.Site.findByBaseURL.resolves({
          getOrganizationId: sandbox.stub().returns(null),
        });

        const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
        const body = await resp.json();
        expect(body.result.imsOrgId).to.be.null;
        expect(mockDataAccess.Organization.findById).to.not.have.been.called;
      });

      it('returns null imsOrgId when Organization is not found', async () => {
        mockDataAccess.Site.findByBaseURL.resolves({
          getOrganizationId: sandbox.stub().returns('org-123'),
        });
        mockDataAccess.Organization.findById.resolves(null);

        const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
        const body = await resp.json();
        expect(body.result.imsOrgId).to.be.null;
      });

      it('logs and returns null imsOrgId when Site lookup throws', async () => {
        mockDataAccess.Site.findByBaseURL.rejects(new Error('DB unavailable'));

        const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
        const body = await resp.json();
        expect(resp.status).to.equal(200);
        expect(body.result.imsOrgId).to.be.null;
        expect(log.warn).to.have.been.calledWith(
          sinon.match(/Failed to resolve imsOrgId for job/),
        );
      });

      it('does not look up Site when status is IN_PROGRESS', async () => {
        mockJob.getStatus.returns(AsyncJob.Status.IN_PROGRESS);

        await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
        expect(mockDataAccess.Site.findByBaseURL).to.not.have.been.called;
      });

      it('does not look up Site when status is FAILED', async () => {
        mockJob.getStatus.returns(AsyncJob.Status.FAILED);

        await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
        expect(mockDataAccess.Site.findByBaseURL).to.not.have.been.called;
      });

      it('does not look up Site when result has no baseURL (rejected/duplicate)', async () => {
        mockJob.getResult.returns({
          action: 'rejected',
          domain: 'foo.example.com',
          reason: 'Site did not serve a Helix-format DOM',
        });

        const resp = await controller.getSiteDetectionJobStatus({ params: { jobId: JOB_ID } });
        const body = await resp.json();
        expect(body.result.imsOrgId).to.be.null;
        expect(mockDataAccess.Site.findByBaseURL).to.not.have.been.called;
      });
    });
  });
});
