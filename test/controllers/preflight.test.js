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

// Add global fetch polyfill for tests
import { fetch } from '@adobe/fetch';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import esmock from 'esmock';

import * as utils from '../../src/support/utils.js';
import PreflightController, { countIssuesForAudit } from '../../src/controllers/preflight.js';

// Make fetch available globally
global.fetch = fetch;

use(chaiAsPromised);
use(sinonChai);

describe('Preflight Controller', () => {
  const sandbox = sinon.createSandbox();
  const jobId = '123e4567-e89b-12d3-a456-426614174000';

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
    debug: sandbox.stub(),
  };

  const mockJob = {
    getId: () => jobId,
    getStatus: () => 'IN_PROGRESS',
    getCreatedAt: () => '2024-03-20T10:00:00Z',
    getUpdatedAt: () => '2024-03-20T10:00:00Z',
    getStartedAt: () => '2024-03-20T10:00:00Z',
    getEndedAt: () => null,
    getRecordExpiresAt: () => 1710936000,
    getResultLocation: () => null,
    getResultType: () => null,
    getResult: () => null,
    getError: () => null,
    getMetadata: () => ({
      payload: {
        siteId: 'test-site-123',
        urls: ['https://main--example-site.aem.page/test.html'],
        step: 'identify',
      },
      jobType: 'preflight',
      tags: ['preflight'],
    }),
    remove: sandbox.stub().resolves(),
    setStatus: sandbox.stub(),
    save: sandbox.stub().resolves(),
  };

  const mockAuthInfo = {
    getProfile: () => ({
      email: 'user@example.com',
      first_name: 'Test',
      last_name: 'User',
      name: 'Test User',
    }),
  };

  const mockSite = {
    getId: () => 'test-site-123',
    getOrganizationId: () => 'org-123',
    getAuthoringType: () => SiteModel.AUTHORING_TYPES.SP,
  };

  const preflightId = 'aabbccdd-1234-5678-abcd-111122223333';
  let preflightStatus = 'IN_PROGRESS';
  let preflightError$ = null;
  const mockPreflight = {
    getId: () => preflightId,
    getStatus: () => preflightStatus,
    getUrl: () => 'https://main--example-site.aem.page/test.html',
    getCreatedAt: () => '2024-03-20T10:00:00Z',
    getCreatedBy: () => ({ email: 'user@example.com', displayName: 'Test User' }),
    getSiteId: () => 'test-site-123',
    getAsyncJobId: () => jobId,
    getAsyncJob: sandbox.stub().resolves(mockJob),
    getUpdatedAt: () => '2024-03-20T10:01:00Z',
    getStartedAt: () => '2024-03-20T10:00:00Z',
    getEndedAt: () => null,
    getResult: () => null,
    getError: () => preflightError$,
    setStatus: sandbox.stub().callsFake((s) => { preflightStatus = s; }),
    setError: sandbox.stub().callsFake((e) => { preflightError$ = e; }),
    setEndedAt: sandbox.stub(),
    save: sandbox.stub().resolves(),
  };

  const mockConfiguration = {
    getEnabledAuditsForSite: sandbox.stub().returns([
      'alt-text-preflight', 'headings-preflight', 'links-preflight',
    ]),
    isHandlerEnabledForSite: sandbox.stub().returns(true),
    getHandlers: sandbox.stub().returns({
      preflight: {
        productCodes: ['ASO'],
        enabledByDefault: false,
        enabled: { sites: ['test-site-123'], orgs: [] },
        disabled: { sites: [], orgs: [] },
      },
    }),
  };

  const mockDataAccess = {
    AsyncJob: {
      create: sandbox.stub().resolves(mockJob),
      findById: sandbox.stub().resolves(mockJob),
    },
    Site: {
      findByPreviewURL: sandbox.stub().resolves(mockSite),
      findById: sandbox.stub().resolves(mockSite),
    },
    Configuration: {
      findLatest: sandbox.stub().resolves(mockConfiguration),
    },
    Organization: {
      findById: sandbox.stub().resolves({ getId: () => 'org-123' }),
    },
    Preflight: {
      create: sandbox.stub().resolves(mockPreflight),
      findById: sandbox.stub().resolves(mockPreflight),
      allBySiteIdAndUrl: sandbox.stub().resolves([mockPreflight]),
    },
  };

  const mockSqs = {
    sendMessage: sandbox.stub().resolves(),
  };

  let preflightController;

  beforeEach(() => {
    preflightController = PreflightController(
      {
        dataAccess: mockDataAccess,
        sqs: mockSqs,
        attributes: { authInfo: mockAuthInfo },
        pathInfo: { headers: {} },
      },
      loggerStub,
      {
        AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
        AWS_ENV: 'prod',
      },
    );

    // Reset and recreate stubs
    mockDataAccess.AsyncJob.create = sandbox.stub().resolves(mockJob);
    mockDataAccess.AsyncJob.findById = sandbox.stub().resolves(mockJob);
    mockDataAccess.Site.findByPreviewURL = sandbox.stub().resolves(mockSite);
    mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);
    mockDataAccess.Preflight.create = sandbox.stub().resolves(mockPreflight);
    mockDataAccess.Preflight.findById = sandbox.stub().resolves(mockPreflight);
    mockDataAccess.Preflight.allBySiteIdAndUrl = sandbox.stub().resolves([mockPreflight]);
    // sandbox.restore() drops the module-level getAsyncJob stub between tests; re-attach.
    mockPreflight.getAsyncJob = sandbox.stub().resolves(mockJob);
    mockSqs.sendMessage = sandbox.stub().resolves();
    preflightStatus = 'IN_PROGRESS';
    preflightError$ = null;
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws an error if context is not an object', () => {
    expect(() => PreflightController(null, loggerStub, { test: 'env' })).to.throw('Context required');
  });

  it('throws an error if dataAccess is not an object', () => {
    expect(() => PreflightController({ dataAccess: null }, loggerStub, { test: 'env' })).to.throw('Data access required');
  });

  it('throws an error if sqs is not an object', () => {
    expect(() => PreflightController({ dataAccess: { test: 'property' }, sqs: null }, loggerStub, { test: 'env' })).to.throw('SQS client required');
  });

  it('throws an error if env is not object', () => {
    expect(() => PreflightController({ dataAccess: { test: 'property' }, sqs: { test: 'property' } }, loggerStub, null)).to.throw('Environment object required');
  });

  describe('createPreflightJob', () => {
    let fetchStub;
    const headResponse = { status: 401 };

    beforeEach(() => {
      // Ensure fetch is available globally before stubbing
      if (!global.fetch) {
        global.fetch = fetch;
      }
      fetchStub = sinon.stub(global, 'fetch');
      fetchStub.resolves(headResponse);
    });

    afterEach(() => {
      if (fetchStub && fetchStub.restore) {
        fetchStub.restore();
      }
    });

    it('creates a preflight job successfully in production environment', async () => {
      const context = {
        data: {
          urls: ['https://main--example-site.aem.page/test.html'],
          step: 'identify',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(202);

      const result = await response.json();
      expect(result).to.deep.equal({
        jobId,
        status: 'IN_PROGRESS',
        createdAt: '2024-03-20T10:00:00Z',
        pollUrl: `https://spacecat.experiencecloud.live/api/v1/preflight/jobs/${jobId}`,
      });

      expect(mockDataAccess.AsyncJob.create).to.have.been.calledWith({
        status: 'IN_PROGRESS',
        metadata: {
          payload: {
            siteId: 'test-site-123',
            urls: ['https://main--example-site.aem.page/test.html'],
            step: 'identify',
            enableAuthentication: true,
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });

      expect(mockSqs.sendMessage).to.have.been.calledWith(
        'https://sqs.test.amazonaws.com/audit-queue',
        {
          jobId,
          type: 'preflight',
          siteId: 'test-site-123',
        },
      );
    });

    it('includes traceId on SQS message when controller ctx includes traceId', async () => {
      const traceId = '1-6a141a79-44f2b03900247bc15c013d2e';
      const ctrlWithTrace = PreflightController(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
          traceId,
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );

      const context = {
        data: {
          urls: ['https://main--example-site.aem.page/test.html'],
          step: 'identify',
        },
      };

      const response = await ctrlWithTrace.createPreflightJob(context);
      expect(response.status).to.equal(202);

      expect(mockSqs.sendMessage).to.have.been.calledWith(
        'https://sqs.test.amazonaws.com/audit-queue',
        {
          jobId,
          type: 'preflight',
          siteId: 'test-site-123',
          traceId,
        },
      );
    });

    it('creates a preflight job successfully for AMS', async () => {
      const context = {
        data: {
          urls: ['http://author.adobecqms.net/path'],
          step: 'identify',
          siteId: 'd140668d-aacf-45fb-a8f2-27ffda65bab4',
        },
      };
      mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(202);

      const result = await response.json();
      expect(result).to.deep.equal({
        jobId,
        status: 'IN_PROGRESS',
        createdAt: '2024-03-20T10:00:00Z',
        pollUrl: `https://spacecat.experiencecloud.live/api/v1/preflight/jobs/${jobId}`,
      });

      expect(mockDataAccess.AsyncJob.create).to.have.been.calledWith({
        status: 'IN_PROGRESS',
        metadata: {
          payload: {
            siteId: 'test-site-123',
            urls: ['http://author.adobecqms.net/path'],
            step: 'identify',
            enableAuthentication: true,
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });

      expect(mockSqs.sendMessage).to.have.been.calledWith(
        'https://sqs.test.amazonaws.com/audit-queue',
        {
          jobId,
          type: 'preflight',
          siteId: 'test-site-123',
        },
      );
    });

    it('creates a preflight job successfully in production environment with authentication enabled', async () => {
      if (fetchStub && fetchStub.restore) {
        fetchStub.restore();
      }
      fetchStub = sinon.stub(global, 'fetch').resolves({ status: 200 });

      const context = {
        data: {
          urls: ['https://main--example-site.aem.page/test.html'],
          step: 'identify',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(202);

      const result = await response.json();
      expect(result).to.deep.equal({
        jobId,
        status: 'IN_PROGRESS',
        createdAt: '2024-03-20T10:00:00Z',
        pollUrl: `https://spacecat.experiencecloud.live/api/v1/preflight/jobs/${jobId}`,
      });

      expect(mockDataAccess.AsyncJob.create).to.have.been.calledWith({
        status: 'IN_PROGRESS',
        metadata: {
          payload: {
            siteId: 'test-site-123',
            urls: ['https://main--example-site.aem.page/test.html'],
            step: 'identify',
            enableAuthentication: false,
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });

      expect(mockSqs.sendMessage).to.have.been.calledWith(
        'https://sqs.test.amazonaws.com/audit-queue',
        {
          jobId,
          type: 'preflight',
          siteId: 'test-site-123',
        },
      );
    });

    it('creates a preflight job successfully in CI environment', async () => {
      const context = {
        data: {
          urls: ['https://main--example-site.aem.page/test.html'],
          step: 'identify',
        },
      };

      preflightController = PreflightController(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'dev',
        },
      );

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(202);

      const result = await response.json();
      expect(result).to.deep.equal({
        jobId,
        status: 'IN_PROGRESS',
        createdAt: '2024-03-20T10:00:00Z',
        pollUrl: `https://spacecat.experiencecloud.live/api/ci/preflight/jobs/${jobId}`,
      });

      expect(mockDataAccess.AsyncJob.create).to.have.been.calledWith({
        status: 'IN_PROGRESS',
        metadata: {
          payload: {
            siteId: 'test-site-123',
            urls: ['https://main--example-site.aem.page/test.html'],
            step: 'identify',
            enableAuthentication: true,
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });

      expect(mockSqs.sendMessage).to.have.been.calledWith(
        'https://sqs.test.amazonaws.com/audit-queue',
        {
          jobId,
          type: 'preflight',
          siteId: 'test-site-123',
        },
      );
    });

    it('extracts base URL correctly from full URL', async () => {
      const context = {
        data: {
          urls: ['https://main--example-site.aem.page/path/to/page?query=123'],
          step: 'identify',
        },
      };

      await preflightController.createPreflightJob(context);

      expect(mockDataAccess.Site.findByPreviewURL).to.have.been.calledWith('https://main--example-site.aem.page');
    });

    it('handles errors during site lookup', async () => {
      mockDataAccess.Site.findByPreviewURL.resolves(null);

      const context = {
        data: {
          urls: ['https://non-registered-site.com/test.html'],
          step: 'identify',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'No site found for preview URL: https://non-registered-site.com',
      });
    });

    it('returns 400 Bad Request if data is missing', async () => {
      const context = {
        data: {},
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: missing application/json data',
      });
    });

    it('returns 400 Bad Request for empty urls array', async () => {
      const context = {
        data: {
          urls: [],
          step: 'identify',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: urls must be a non-empty array',
      });
    });

    it('returns 400 Bad Request if urls is not an array', async () => {
      const context = {
        data: {
          urls: 'https://main--example-site.aem.page/test.html',
          step: 'identify',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: urls must be a non-empty array',
      });
    });

    it('returns 400 Bad Request for invalid URL format', async () => {
      const context = {
        data: {
          urls: ['not-a-valid-url'],
          step: 'identify',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: all urls must be valid URLs',
      });
    });

    it('returns 400 Bad Request for invalid step', async () => {
      const context = {
        data: {
          urls: ['https://main--example-site.aem.page/test.html'],
          step: 'invalid-step',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: step must be either identify or suggest',
      });
    });

    it('returns 400 Bad Request when URLs belong to different websites', async () => {
      const context = {
        data: {
          urls: [
            'https://main--example-site.aem.page/page1.html',
            'https://different-site.com/page2.html',
          ],
          step: 'identify',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: all urls must belong to the same website',
      });
    });

    it('handles errors during job creation', async () => {
      mockDataAccess.AsyncJob.create.rejects(new Error('Something went wrong'));

      const context = {
        data: {
          urls: ['https://main--example-site.aem.page/test.html'],
          step: 'identify',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Something went wrong',
      });
    });

    it('handles SQS message sending errors and rolls back the job', async () => {
      mockSqs.sendMessage.rejects(new Error('SQS error'));

      const context = {
        data: {
          urls: ['https://main--example-site.aem.page/test.html'],
          step: 'identify',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Failed to send message to SQS: SQS error',
      });

      expect(mockDataAccess.AsyncJob.create).to.have.been.calledOnce;
      expect(mockJob.remove).to.have.been.calledOnce;
    });

    it('creates a preflight job using x-promise-token header for promise-based authoring type', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getOrganizationId: () => 'org-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS_CW,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
      });

      const preflightControllerWithMock = PreflightControllerWithMock(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );

      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
        },
        pathInfo: {
          headers: {
            'x-promise-token': 'header-promise-token-456',
          },
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(202);
      expect(mockSqs.sendMessage).to.have.been.calledWith(
        'https://sqs.test.amazonaws.com/audit-queue',
        {
          jobId,
          siteId: mockSite.getId(),
          type: 'preflight',
          promiseToken: { promise_token: 'header-promise-token-456' },
        },
      );
    });

    it('returns 400 when x-promise-token header is absent for AEM_CS site', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getOrganizationId: () => 'org-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
      });

      const preflightControllerWithMock = PreflightControllerWithMock(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );

      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: missing required header: x-promise-token',
      });
    });

    it('returns 400 when x-promise-token header is empty or whitespace for AEM_CS site', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getOrganizationId: () => 'org-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
      });

      const preflightControllerWithMock = PreflightControllerWithMock(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );

      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
        },
        pathInfo: {
          headers: {
            'x-promise-token': '   ',
          },
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: missing required header: x-promise-token',
      });
    });

    it('returns 400 when headers are present but x-promise-token key is missing', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getOrganizationId: () => 'org-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
      });

      const preflightControllerWithMock = PreflightControllerWithMock(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );

      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
        },
        pathInfo: {
          headers: {
            'content-type': 'application/json',
            accept: '*/*',
          },
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: missing required header: x-promise-token',
      });
    });

    it('returns 400 when x-promise-token header value is empty string', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getOrganizationId: () => 'org-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
      });

      const preflightControllerWithMock = PreflightControllerWithMock(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );

      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
        },
        pathInfo: {
          headers: {
            'x-promise-token': '',
          },
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: missing required header: x-promise-token',
      });
    });

    it('returns 400 when x-promise-token header value is not a string', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getOrganizationId: () => 'org-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
      });

      const preflightControllerWithMock = PreflightControllerWithMock(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );

      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
        },
        pathInfo: {
          headers: {
            'x-promise-token': 12345,
          },
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: missing required header: x-promise-token',
      });
    });

    it('creates a preflight job when x-promise-token decodeURIComponent fails and uses trimmed literal', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getOrganizationId: () => 'org-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS_CW,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
      });

      const preflightControllerWithMock = PreflightControllerWithMock(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );

      const malformedPercentToken = 'abc::def%';
      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
        },
        pathInfo: {
          headers: {
            'x-promise-token': malformedPercentToken,
          },
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(202);
      expect(mockSqs.sendMessage).to.have.been.calledWith(
        'https://sqs.test.amazonaws.com/audit-queue',
        {
          jobId,
          siteId: mockSite.getId(),
          type: 'preflight',
          promiseToken: { promise_token: malformedPercentToken },
        },
      );
    });

    it('returns 500 when promise token resolution throws a non-ErrorWithStatusCode error', async () => {
      const siteWithBrokenAuthoring = {
        getId: () => 'test-site-123',
        getAuthoringType: () => {
          throw new Error('authoring type lookup failed');
        },
      };
      mockDataAccess.Site.findByPreviewURL.resolves(siteWithBrokenAuthoring);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
      });

      const preflightControllerWithMock = PreflightControllerWithMock(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );

      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result).to.deep.equal({ message: 'Error getting promise token' });
    });

    it('preserves full x-promise-token header value when token contains = characters (base64)', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getOrganizationId: () => 'org-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const base64Token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZw==';
      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
      });

      const preflightControllerWithMock = PreflightControllerWithMock(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );

      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
        },
        pathInfo: {
          headers: {
            'x-promise-token': base64Token,
          },
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(202);
      expect(mockSqs.sendMessage).to.have.been.calledWith(
        'https://sqs.test.amazonaws.com/audit-queue',
        {
          jobId,
          siteId: 'test-site-123',
          type: 'preflight',
          promiseToken: { promise_token: base64Token },
        },
      );
    });

    it('returns 400 when x-promise-token header is absent for CS_CW site', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getOrganizationId: () => 'org-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS_CW,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
      });

      const preflightControllerWithMock = PreflightControllerWithMock(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );

      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: missing required header: x-promise-token',
      });
    });
  });

  describe('createPreflight', () => {
    let fetchStub;
    let CreatePreflightController;
    let hasAccessStub;
    let mockImsClient;
    let createFromStub;

    beforeEach(async () => {
      if (!global.fetch) {
        global.fetch = fetch;
      }
      fetchStub = sinon.stub(global, 'fetch');
      // First call: HEAD check (200 = no auth needed), second: Mysticat analyze
      fetchStub.onFirstCall().resolves({ ok: true, status: 200 });
      fetchStub.onSecondCall().resolves({ ok: true });

      mockDataAccess.AsyncJob.create = sandbox.stub().resolves(mockJob);
      mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);
      mockDataAccess.Site.findByPreviewURL = sandbox.stub().resolves(mockSite);
      mockDataAccess.Preflight.create = sandbox.stub().resolves(mockPreflight);
      hasAccessStub = sandbox.stub().resolves(true);

      // SITES-43236 / SITES-46699: createPreflight constructs a custom-env
      // ImsClient with the dedicated PREFLIGHT_IMS_* credentials at the mint
      // call site (see preflight.js for rationale). Tests esmock
      // `ImsClient.createFrom` to return the shared mockImsClient stub; tests
      // control mint behavior by overriding getServiceAccessToken on that
      // stub per case (v2 authorization_code service-token mint).
      mockImsClient = {
        getServiceAccessToken: sandbox.stub().resolves({
          access_token: 'test-ims-service-token',
          token_type: 'bearer',
          expires_in: 3600,
        }),
      };
      // Stub-ify ImsClient.createFrom so tests can assert that the source
      // passes the dedicated PREFLIGHT_IMS_* credentials through to the
      // factory (the load-bearing contract of SITES-46699; if a future
      // refactor accidentally swaps the wrong env keys, this stub's call
      // args won't match and assertions fail).
      createFromStub = sandbox.stub().returns(mockImsClient);

      // SITES-46202: createPreflight no longer consults Configuration / TierClient
      // for eligibility — Mysticat owns that decision. The controller is mocked
      // here only against AccessControlUtil (tenancy boundary), the IMS client
      // factory (for the custom-env mint), and the standard dataAccess stubs.
      CreatePreflightController = await esmock('../../src/controllers/preflight.js', {
        '@adobe/spacecat-shared-ims-client': {
          ImsClient: { createFrom: createFromStub },
          retrievePageAuthentication: sandbox.stub().resolves('default-page-token'),
        },
        '../../src/support/access-control-util.js': {
          default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
        },
      });
      preflightController = CreatePreflightController(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
          // SITES-46699: dedicated IMS client credentials used by callMysticatAnalyze.
          PREFLIGHT_IMS_CLIENT_ID: 'test-preflight-client-id',
          PREFLIGHT_IMS_CLIENT_SECRET: 'test-preflight-client-secret',
          PREFLIGHT_IMS_CLIENT_CODE: 'test-preflight-client-code',
          PREFLIGHT_IMS_SCOPE: 'test-preflight-scope',
        },
      );
    });

    afterEach(() => {
      if (fetchStub?.restore) {
        fetchStub.restore();
      }
    });

    it('returns 400 for missing url', async () => {
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: {},
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INVALID_REQUEST');
    });

    it('returns 400 for invalid url', async () => {
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'not-a-url' },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INVALID_REQUEST');
      expect(result.message).to.include('url is missing or not a valid URI');
    });

    it('returns 500 when MYSTIQUE_API_BASE_URL is not configured', async () => {
      const controller = CreatePreflightController(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        { AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue', AWS_ENV: 'prod' },
      );
      const response = await controller.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
    });

    // -- mystiqueUrl dev override (SITES-46216) --

    // The default preflightController in this describe block is built with
    // AWS_ENV='prod'. Override tests need a separate dev-mode controller.
    const buildDevController = () => CreatePreflightController(
      {
        dataAccess: mockDataAccess,
        sqs: mockSqs,
        attributes: { authInfo: mockAuthInfo },
        pathInfo: { headers: {} },
      },
      loggerStub,
      {
        AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
        MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
        AWS_ENV: 'dev',
      },
    );

    it('honors mystiqueUrl override on non-prod when host is *.adobe.io', async () => {
      const devController = buildDevController();
      const response = await devController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          mystiqueUrl: 'https://m-dev.adobe.io',
        },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      const [calledUrl] = fetchStub.secondCall.args;
      expect(calledUrl).to.equal('https://m-dev.adobe.io/v1/preflight/analyze');
    });

    it('falls back to env.MYSTIQUE_API_BASE_URL when mystiqueUrl is absent on non-prod', async () => {
      const devController = buildDevController();
      const response = await devController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      const [calledUrl] = fetchStub.secondCall.args;
      expect(calledUrl).to.equal('https://mysticat.example.com/v1/preflight/analyze');
    });

    it('returns 400 PREFLIGHT_INVALID_REQUEST when mystiqueUrl is not a valid URL', async () => {
      const devController = buildDevController();
      const response = await devController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          mystiqueUrl: 'not-a-url',
        },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INVALID_REQUEST');
      expect(result.message).to.include('mystiqueUrl');
    });

    it('returns 400 PREFLIGHT_INVALID_REQUEST when mystiqueUrl host is not *.adobe.io', async () => {
      const devController = buildDevController();
      const response = await devController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          mystiqueUrl: 'https://evil.example.com',
        },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INVALID_REQUEST');
      expect(result.message).to.include('*.adobe.io');
    });

    it('returns 400 PREFLIGHT_INVALID_REQUEST when mystiqueUrl scheme is not https', async () => {
      const devController = buildDevController();
      const response = await devController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          mystiqueUrl: 'http://m-dev.adobe.io', // http, not https
        },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INVALID_REQUEST');
      expect(result.message).to.include('https');
    });

    it('ignores mystiqueUrl in prod (override is dead code there)', async () => {
      const controller = CreatePreflightController(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );
      const response = await controller.createPreflight({
        params: { siteId: 'test-site-123' },
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          mystiqueUrl: 'https://m-dev.adobe.io', // would be allowed in dev, ignored in prod
        },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      const [calledUrl] = fetchStub.secondCall.args;
      // Hit the env-configured URL, NOT the body-supplied override
      expect(calledUrl).to.equal('https://mysticat.example.com/v1/preflight/analyze');
    });

    it('allows mystiqueUrl override even when MYSTIQUE_API_BASE_URL env is empty (non-prod)', async () => {
      // Sanity check that an operator can use the override to test even if
      // the env var hasn't been configured yet — the override path should
      // sidestep the "Analyze service not configured" 500.
      const controller = CreatePreflightController(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'dev',
          // MYSTIQUE_API_BASE_URL: deliberately unset
        },
      );
      const response = await controller.createPreflight({
        params: { siteId: 'test-site-123' },
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          mystiqueUrl: 'https://m-dev.adobe.io',
        },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      // Confirm the override was actually used — not just that the request
      // avoided the "Analyze service not configured" 500.
      expect(fetchStub.secondCall.args[0]).to.equal('https://m-dev.adobe.io/v1/preflight/analyze');
    });

    it('returns 404 when site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(404);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_SITE_NOT_FOUND');
    });

    it('returns 500 when Site.findById throws', async () => {
      mockDataAccess.Site.findById.rejects(new Error('DB error'));
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
    });

    it('returns 403 when access is denied', async () => {
      hasAccessStub.resolves(false);
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(403);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_ACCESS_DENIED');
    });

    it('returns 400 when url does not belong to site', async () => {
      mockDataAccess.Site.findByPreviewURL.resolves(null);
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INVALID_REQUEST');
      expect(result.message).to.equal('URL does not belong to this site');
    });

    it('returns 400 when url belongs to a different site', async () => {
      mockDataAccess.Site.findByPreviewURL.resolves({ getId: () => 'different-site-id' });
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INVALID_REQUEST');
    });

    it('returns 500 when Site.findByPreviewURL throws', async () => {
      mockDataAccess.Site.findByPreviewURL.rejects(new Error('DB error'));
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
    });

    it('does not consult Configuration / TierClient (eligibility deferred to Mysticat per SITES-46202)', async () => {
      // Stub Configuration / TierClient to throw if anyone calls them. After
      // SITES-46202, createPreflight must not touch either — eligibility is
      // Mysticat's decision (Gate 0 tier features + Gates 1/2/3). This test
      // guards against a future regression that re-introduces SpaceCat-side
      // entitlement checks on the new endpoints.
      mockDataAccess.Configuration.findLatest = sandbox.stub().rejects(
        new Error('Configuration.findLatest must NOT be called by createPreflight'),
      );

      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });

      expect(response.status).to.equal(202);
      expect(mockDataAccess.Configuration.findLatest).to.not.have.been.called;
      // Mysticat WAS called (it owns the decision now).
      const mysticatCall = fetchStub.secondCall;
      expect(mysticatCall.args[0]).to.equal('https://mysticat.example.com/v1/preflight/analyze');
    });

    it('returns 202 and does NOT roll back rows when Mysticat returns 200 with empty audits (tier-ineligible site)', async () => {
      // Post-SITES-46202 contract: a site whose Mysticat tier disables preflight
      // (Gate 0 features.preflight=false, or all goals opted out via Gate 3) gets
      // a 200 with `audits: []` from Mysticat — NOT a 4xx. SpaceCat must treat
      // this as a successful dispatch: the Preflight + AsyncJob rows remain in
      // IN_PROGRESS, no FAILED rollback, no error response. The projector
      // eventually flips the rows to COMPLETED with empty result.
      fetchStub.onSecondCall().resolves({
        ok: true,
        status: 200,
        json: async () => ({ pageUrl: 'https://main--example-site.aem.page/test.html', audits: [], profiling: {} }),
      });

      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });

      // 202 with the Preflight payload — same as any other successful dispatch.
      expect(response.status).to.equal(202);
      const body = await response.json();
      expect(body.preflightId).to.equal(preflightId);

      // No FAILED rollback path was taken.
      expect(mockPreflight.setStatus).to.not.have.been.calledWith('FAILED');
      expect(mockJob.setStatus).to.not.have.been.calledWith('FAILED');
      expect(mockPreflight.setError).to.not.have.been.called;
    });

    it('returns 502 when Mysticat analyze returns non-ok status', async () => {
      fetchStub.onSecondCall().resolves({ ok: false, status: 503, text: async () => 'Service Unavailable' });
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(502);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_UPSTREAM_ERROR');
      expect(mockPreflight.setStatus).to.have.been.calledWith('FAILED');
      // Stored error mirrors the external 502 message — the raw upstream
      // body could leak via GET detail and is sanitized server-side.
      expect(mockPreflight.setError).to.have.been.calledWithMatch({
        code: 'MYSTICAT_ERROR',
        message: 'Upstream analyze service failed',
      });
      expect(mockPreflight.save).to.have.been.calledOnce;
      // AsyncJob row must also be flipped to FAILED; the controller updates
      // both records so a future refactor that drops the AsyncJob update is
      // caught here.
      expect(mockJob.setStatus).to.have.been.calledWith('FAILED');
      expect(mockJob.save).to.have.been.called;
    });

    it('creates preflight successfully and returns 202 with Location header (prod)', async () => {
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);

      const result = await response.json();
      expect(result.preflightId).to.equal(preflightId);
      expect(result.status).to.equal('IN_PROGRESS');
      expect(result.url).to.equal('https://main--example-site.aem.page/test.html');

      const locationHeader = response.headers.get('Location');
      expect(locationHeader).to.equal(
        `https://spacecat.experiencecloud.live/api/v1/sites/test-site-123/preflights/${preflightId}`,
      );
    });

    it('uses ci location url in dev environment', async () => {
      preflightController = CreatePreflightController(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'dev',
        },
      );
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      const locationHeader = response.headers.get('Location');
      expect(locationHeader).to.include('/api/ci/sites/test-site-123/preflights/');
    });

    it('calls Mysticat with correct parameters', async () => {
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      const [calledUrl, calledOptions] = fetchStub.secondCall.args;
      expect(calledUrl).to.equal('https://mysticat.example.com/v1/preflight/analyze');
      const body = JSON.parse(calledOptions.body);
      expect(body.site_id).to.equal('test-site-123');
      expect(body.url).to.equal('https://main--example-site.aem.page/test.html');
      expect(body.mode).to.be.undefined;
      expect(body.audits).to.be.undefined;
      // SITES-47173: wire field is `async_job_id` (the AsyncJob id spacecat
      // owns); mystique mints its own scan_id internally. The deprecated
      // `scan_id` body field must NOT be sent.
      expect(body.async_job_id).to.be.a('string').and.not.empty;
      expect(body.scan_id).to.be.undefined;
      // The async_job_id carries the AsyncJob row id that createPreflight
      // creates — pulled from the response's Preflight DTO via its
      // back-reference, but easier to assert it matches what's on the wire.
      const preflightBody = await response.json();
      expect(body.async_job_id).to.not.be.undefined;
      expect(preflightBody.preflightId).to.be.a('string');
    });

    it('does not include x-page-auth header when HEAD returns 200 (no page-auth needed)', async () => {
      await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      const [, calledOptions] = fetchStub.secondCall.args;
      // SITES-46967: page-auth header moved off Authorization onto x-page-auth.
      // Authorization is now reserved for the IMS service token (always set).
      expect(calledOptions.headers['x-page-auth']).to.be.undefined;
    });

    // -- IMS service token on Authorization, customer page-auth on x-page-auth (SITES-46967) --

    it('attaches the IMS service token on Authorization (Bearer prefix)', async () => {
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      // Load-bearing contracts (SITES-46699):
      //   1. Custom-env ImsClient construction passes the dedicated
      //      PREFLIGHT_IMS_* credentials through to ImsClient.createFrom.
      //   2. Mint uses getServiceAccessToken (v2 authorization_code against
      //      the IMSS-provisioned permanent code — no org_id, no SP binding).
      // If a future refactor swaps to v3 client_credentials or wires the
      // wrong env keys, one of these assertions fails.
      expect(createFromStub).to.have.been.calledWith(
        sinon.match({
          env: sinon.match({
            IMS_CLIENT_ID: 'test-preflight-client-id',
            IMS_CLIENT_SECRET: 'test-preflight-client-secret',
            IMS_CLIENT_CODE: 'test-preflight-client-code',
            IMS_SCOPE: 'test-preflight-scope',
          }),
        }),
      );
      expect(mockImsClient.getServiceAccessToken).to.have.been.calledOnce;
      const [, calledOptions] = fetchStub.secondCall.args;
      // SITES-46967: IMS service token rides Authorization (default CGW slot)
      // so the Ethos CGW-Flex edge emits X-Gw-Ims-Client-Id downstream — the
      // header mystique's require_preflight_service_client dep reads.
      expect(calledOptions.headers.Authorization).to.equal(
        'Bearer test-ims-service-token',
      );
      // No customer-page-auth header when the page is un-authenticated.
      expect(calledOptions.headers['x-page-auth']).to.be.undefined;
    });

    it('keeps Authorization (IMS) and x-page-auth (page-auth) on separate headers when both are present', async () => {
      // HEAD returns 401 → enableAuthentication=true → retrievePageAuthentication
      // resolves a customer-site token. SITES-46967: page-auth rides
      // x-page-auth (was Authorization); IMS service token rides Authorization
      // (was x-ims-authorization).
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      const aemCsSite = {
        ...mockSite,
        getDeliveryType: () => 'aem_cs',
      };
      mockDataAccess.Site.findById.resolves(aemCsSite);
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const pageAuthStub = sandbox.stub().resolves('customer-site-token');
      const controller = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/access-control-util.js': {
          default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
        },
        '@adobe/spacecat-shared-ims-client': {
          ImsClient: { createFrom: () => mockImsClient },
          retrievePageAuthentication: pageAuthStub,
        },
      });
      const preflightCtrl = controller(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await preflightCtrl.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      const [, calledOptions] = fetchStub.secondCall.args;
      expect(calledOptions.headers.Authorization).to.equal(
        'Bearer test-ims-service-token',
      );
      expect(calledOptions.headers['x-page-auth']).to.equal('token customer-site-token');
    });

    it('returns 500 PREFLIGHT_INTERNAL_ERROR when IMS service-token mint fails', async () => {
      mockImsClient.getServiceAccessToken.rejects(new Error('IMS down'));
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
      expect(result.message).to.include('IMS service token');
    });

    it('does not create AsyncJob or Preflight records when IMS mint fails', async () => {
      // Mint happens before DB writes — a transient IMS failure must not
      // leave orphaned IN_PROGRESS records that the caller can't reconcile.
      mockImsClient.getServiceAccessToken.rejects(new Error('IMS down'));
      await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(mockDataAccess.AsyncJob.create).to.not.have.been.called;
      expect(mockDataAccess.Preflight.create).to.not.have.been.called;
    });

    it('does not call Mysticat when IMS mint fails', async () => {
      mockImsClient.getServiceAccessToken.rejects(new Error('IMS down'));
      await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      // Filter by Mysticat URL — resilient to future fetch additions (HEAD
      // probe, IMS-client HTTP fetches, etc.) that could change the raw
      // call count without changing the load-bearing invariant.
      const mysticatCalls = fetchStub.getCalls().filter(
        (c) => typeof c.args[0] === 'string' && c.args[0].includes('/v1/preflight/analyze'),
      );
      expect(mysticatCalls).to.have.lengthOf(0);
    });

    it('returns 500 PREFLIGHT_INTERNAL_ERROR when IMS mint returns a payload missing access_token', async () => {
      // SDK shape drift guard (e.g. `{ accessToken: ... }` after a version bump
      // or `{}` on partial responses) — must surface as an explicit 500, not
      // silently drop the header.
      mockImsClient.getServiceAccessToken.resolves({});
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
      expect(result.message).to.include('IMS service token');
      // No DB writes when the post-condition rejects the mint result.
      expect(mockDataAccess.AsyncJob.create).to.not.have.been.called;
      expect(mockDataAccess.Preflight.create).to.not.have.been.called;
    });

    it('creates preflight with correct createdBy from IMS profile', async () => {
      await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(mockDataAccess.Preflight.create).to.have.been.calledWithMatch({
        siteId: 'test-site-123',
        url: 'https://main--example-site.aem.page/test.html',
        status: 'IN_PROGRESS',
        createdBy: { email: 'user@example.com', displayName: 'Test User' },
      });
    });

    it('creates AsyncJob and Preflight records with correct payloads', async () => {
      await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(mockDataAccess.AsyncJob.create).to.have.been.calledWithMatch({
        status: 'IN_PROGRESS',
        metadata: {
          payload: {
            siteId: 'test-site-123',
            url: 'https://main--example-site.aem.page/test.html',
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });
      expect(mockDataAccess.Preflight.create).to.have.been.calledWithMatch({
        siteId: 'test-site-123',
        asyncJobId: jobId,
        url: 'https://main--example-site.aem.page/test.html',
        status: 'IN_PROGRESS',
      });
    });

    // -- enableAuthentication=true path (HEAD returns 401) --

    it('forwards page-auth on x-page-auth to Mysticat for auth-required URL with x-promise-token header', async () => {
      // First fetch (HEAD): 401 → enableAuthentication=true.
      // Use CS_CW so resolvePromiseToken consults the x-promise-token header
      // (PROMISE_BASED_AUTHORING_TYPES = [CS, CS_CW, AMS]).
      fetchStub.resetBehavior();
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      fetchStub.onSecondCall().resolves({ ok: true });
      const cwSite = {
        getId: () => 'test-site-123',
        getOrganizationId: () => 'org-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS_CW,
        getDeliveryType: () => 'aem_edge',
      };
      mockDataAccess.Site.findById.resolves(cwSite);
      mockDataAccess.Site.findByPreviewURL.resolves(cwSite);

      const mockRetrievePageAuth = sandbox.stub().resolves('page-access-token');
      const ControllerWithIms = await esmock('../../src/controllers/preflight.js', {
        '@adobe/spacecat-shared-ims-client': {
          ImsClient: { createFrom: () => mockImsClient },
          retrievePageAuthentication: mockRetrievePageAuth,
        },
        '../../src/support/access-control-util.js': {
          default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
        },
      });
      const controller = ControllerWithIms(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: { 'x-promise-token': 'header-token' } },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await controller.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        pathInfo: { headers: { 'x-promise-token': 'header-token' } },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      const [, mystiOpts] = fetchStub.secondCall.args;
      // CS_CW + promiseToken → isBearer false (DeliveryType !== AEM_CS) → 'token <t>'.
      // SITES-46967: page-auth rides x-page-auth (Authorization now carries
      // the IMS service token, validated at the CGW-Flex edge).
      expect(mystiOpts.headers['x-page-auth']).to.equal('token page-access-token');
      expect(mystiOpts.headers.Authorization).to.equal('Bearer test-ims-service-token');
      expect(mockRetrievePageAuth).to.have.been.calledOnce;
    });

    it('returns 400 when x-promise-token header is missing for a promise-based site (auth required)', async () => {
      fetchStub.resetBehavior();
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      fetchStub.onSecondCall().resolves({ ok: true });
      const csSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
        getDeliveryType: () => 'aem_cs',
      };
      mockDataAccess.Site.findById.resolves(csSite);
      mockDataAccess.Site.findByPreviewURL.resolves(csSite);
      const ControllerWithStubbed = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/access-control-util.js': {
          default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
        },
      });
      const controller = ControllerWithStubbed(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );
      const response = await controller.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        pathInfo: { headers: {} },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INVALID_REQUEST');
      expect(result.message).to.equal('Invalid request: missing required header: x-promise-token');
    });

    it('returns 500 when resolvePromiseToken throws a non-ErrorWithStatusCode error', async () => {
      fetchStub.resetBehavior();
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      fetchStub.onSecondCall().resolves({ ok: true });
      // resolvePromiseToken reads site.getAuthoringType() first; a generic throw
      // there propagates as a non-ErrorWithStatusCode and hits the 500 branch.
      const brokenSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => { throw new Error('authoring type lookup failed'); },
        getDeliveryType: () => 'aem_cs',
      };
      mockDataAccess.Site.findById.resolves(brokenSite);
      mockDataAccess.Site.findByPreviewURL.resolves(brokenSite);
      const ControllerWithStubbed = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/access-control-util.js': {
          default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
        },
      });
      const controller = ControllerWithStubbed(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );
      const response = await controller.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        pathInfo: { headers: {} },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
      expect(result.message).to.equal('Error getting promise token');
    });

    it('returns 500 when retrievePageAuthentication throws', async () => {
      fetchStub.resetBehavior();
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      fetchStub.onSecondCall().resolves({ ok: true });
      const csSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
        getDeliveryType: () => 'aem_cs',
      };
      mockDataAccess.Site.findById.resolves(csSite);
      mockDataAccess.Site.findByPreviewURL.resolves(csSite);
      const mockRetrievePageAuth = sandbox.stub().rejects(new Error('IMS down'));
      const ControllerWithIms = await esmock('../../src/controllers/preflight.js', {
        '@adobe/spacecat-shared-ims-client': {
          ImsClient: { createFrom: () => mockImsClient },
          retrievePageAuthentication: mockRetrievePageAuth,
        },
        '../../src/support/access-control-util.js': {
          default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
        },
      });
      const controller = ControllerWithIms(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: { 'x-promise-token': 'header-token' } },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );
      const response = await controller.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        pathInfo: { headers: { 'x-promise-token': 'header-token' } },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
      expect(result.message).to.equal('Error retrieving page authentication');
    });

    // -- AsyncJob / Preflight create failure paths --

    it('returns 500 when AsyncJob.create throws', async () => {
      mockDataAccess.AsyncJob.create.rejects(new Error('db down'));
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
      expect(result.message).to.equal('Failed to create async job');
    });

    it('omits promiseToken from authOptions for non-promise-based authoring (SP) when auth required', async () => {
      // Covers the falsy side of `promiseTokenObj ? { promiseToken: ... } : {}`.
      // SP authoring → resolvePromiseToken returns null (not in PROMISE_BASED_TYPES).
      // retrievePageAuthentication is still called for page-protected sites,
      // but with an empty options object.
      fetchStub.resetBehavior();
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      fetchStub.onSecondCall().resolves({ ok: true });
      const spSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.SP,
        getDeliveryType: () => 'aem_edge',
      };
      mockDataAccess.Site.findById.resolves(spSite);
      mockDataAccess.Site.findByPreviewURL.resolves(spSite);

      const mockRetrievePageAuth = sandbox.stub().resolves('sp-page-token');
      const ControllerWithIms = await esmock('../../src/controllers/preflight.js', {
        '@adobe/spacecat-shared-ims-client': {
          ImsClient: { createFrom: () => mockImsClient },
          retrievePageAuthentication: mockRetrievePageAuth,
        },
        '../../src/support/access-control-util.js': {
          default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
        },
      });
      const controller = ControllerWithIms(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );
      const response = await controller.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      const [, , authOptsArg] = mockRetrievePageAuth.firstCall.args;
      expect(authOptsArg).to.deep.equal({});
    });

    it('uses Bearer prefix on x-page-auth for AEM_CS site with x-promise-token header', async () => {
      // Covers the `isBearer` branch where DeliveryType === AEM_CS && promiseTokenObj truthy.
      // SITES-46967: page-auth header moved to x-page-auth; Bearer prefix logic unchanged.
      fetchStub.resetBehavior();
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      fetchStub.onSecondCall().resolves({ ok: true });
      const csSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
        getDeliveryType: () => 'aem_cs',
      };
      mockDataAccess.Site.findById.resolves(csSite);
      mockDataAccess.Site.findByPreviewURL.resolves(csSite);

      const mockRetrievePageAuth = sandbox.stub().resolves('cs-token');
      const ControllerWithIms = await esmock('../../src/controllers/preflight.js', {
        '@adobe/spacecat-shared-ims-client': {
          ImsClient: { createFrom: () => mockImsClient },
          retrievePageAuthentication: mockRetrievePageAuth,
        },
        '../../src/support/access-control-util.js': {
          default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
        },
      });
      const controller = ControllerWithIms(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: { 'x-promise-token': 'header-token' } },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );
      const response = await controller.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        pathInfo: { headers: { 'x-promise-token': 'header-token' } },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      const [, mystiOpts] = fetchStub.secondCall.args;
      expect(mystiOpts.headers['x-page-auth']).to.equal('Bearer cs-token');
      expect(mystiOpts.headers.Authorization).to.equal('Bearer test-ims-service-token');
    });

    it('falls back to profile.name and profile.email when first_name/last_name are absent', async () => {
      // Covers the createdBy displayName fallback ladder (`first_name + last_name` empty → `name`)
      // and the email '|| unknown' default.
      const profileNameOnly = {
        getProfile: () => ({ name: 'Solo Name', email: 'solo@example.com' }),
      };
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: profileNameOnly },
      });
      expect(response.status).to.equal(202);
      expect(mockDataAccess.Preflight.create).to.have.been.calledWithMatch({
        createdBy: { email: 'solo@example.com', displayName: 'Solo Name' },
      });
    });

    it('falls back to profile.email as displayName when first_name/last_name/name are all absent', async () => {
      const profileEmailOnly = {
        getProfile: () => ({ email: 'just-email@example.com' }),
      };
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: profileEmailOnly },
      });
      expect(response.status).to.equal(202);
      expect(mockDataAccess.Preflight.create).to.have.been.calledWithMatch({
        createdBy: { email: 'just-email@example.com', displayName: 'just-email@example.com' },
      });
    });

    it('treats checkEnableAuthentication throw as auth-not-required (structured 502 if Mysticat then fails, not unstructured 500)', async () => {
      // checkEnableAuthentication does a bare HEAD fetch; DNS / TLS /
      // connection errors throw. We must catch and default to false so the
      // {errorCode, message} contract isn't broken downstream.
      fetchStub.resetBehavior();
      fetchStub.onFirstCall().rejects(new Error('ENOTFOUND'));
      fetchStub.onSecondCall().resolves({ ok: true }); // Mysticat call succeeds
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      // We proceeded past the HEAD failure (defaulting to auth-not-required)
      // and Mysticat accepted the call — so 202, not 500.
      expect(response.status).to.equal(202);
      // The Mysticat call was made without an x-page-auth header (page-auth
      // was skipped because the HEAD probe threw). Authorization is still
      // set — SITES-46967 moved the IMS service token onto Authorization.
      const [, mystiOpts] = fetchStub.secondCall.args;
      expect(mystiOpts.headers['x-page-auth']).to.be.undefined;
    });

    it('returns 500 and rolls back the AsyncJob when Preflight.create throws', async () => {
      const removeStub = sandbox.stub().resolves();
      mockDataAccess.AsyncJob.create.resolves({ ...mockJob, remove: removeStub });
      mockDataAccess.Preflight.create.rejects(new Error('preflight insert failed'));

      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
      expect(result.message).to.equal('Failed to create preflight record');
      expect(removeStub).to.have.been.calledOnce;
    });
  });

  describe('getPreflightJobStatusAndResult', () => {
    it('gets preflight job status successfully', async () => {
      const context = {
        params: {
          jobId,
        },
      };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(200);

      const result = await response.json();
      expect(result).to.deep.equal({
        jobId,
        status: 'IN_PROGRESS',
        createdAt: '2024-03-20T10:00:00Z',
        updatedAt: '2024-03-20T10:00:00Z',
        startedAt: '2024-03-20T10:00:00Z',
        endedAt: null,
        recordExpiresAt: 1710936000,
        resultLocation: null,
        resultType: null,
        result: null,
        error: null,
        metadata: {
          payload: {
            siteId: 'test-site-123',
            urls: ['https://main--example-site.aem.page/test.html'],
            step: 'identify',
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });
    });

    it('logs a compact summary with issue counts (all three counting modes)', async () => {
      loggerStub.info.resetHistory();
      const resultJob = {
        ...mockJob,
        getStatus: () => 'COMPLETED',
        getResult: () => [
          {
            pageUrl: 'https://main--example-site.aem.page/test.html',
            step: 'suggest',
            audits: [
              // empty audit -> 0
              { name: 'body-size', type: 'seo', opportunities: [] },
              // single-issue-per-opportunity -> 2
              {
                name: 'metatags',
                type: 'seo',
                opportunities: [{ issue: 'Title too short' }, { issue: 'Description too short' }],
              },
              // issue-is-an-array (links) -> 3 + 1 = 4
              {
                name: 'links',
                type: 'seo',
                opportunities: [
                  { check: 'broken-internal-links', issue: [{}, {}, {}] },
                  { check: 'broken-external-links', issue: [{}] },
                ],
              },
              // accessibility -> sum of occurrences = 5 + 40 = 45
              {
                name: 'accessibility',
                type: 'a11y',
                opportunities: [
                  { type: 'aria-allowed-attr', occurrences: 5 },
                  { type: 'color-contrast', occurrences: 40 },
                ],
              },
            ],
          },
        ],
      };
      mockDataAccess.AsyncJob.findById.resolves(resultJob);

      const context = { params: { jobId } };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(200);

      const infoCall = loggerStub.info.getCalls()
        .find((c) => typeof c.args[0] === 'string'
          && c.args[0].includes(`[Preflight] Run complete. jobId=${jobId}`)
          && c.args[0].includes('status=COMPLETED'));
      expect(infoCall, 'expected a [Preflight] jobId info log').to.not.be.undefined;
      const logged = JSON.parse(infoCall.args[0].split('results=')[1]);
      expect(logged).to.deep.equal([
        {
          pageUrl: 'https://main--example-site.aem.page/test.html',
          step: 'suggest',
          audits: [
            {
              name: 'body-size', type: 'seo', opportunities: 0, issues: 0,
            },
            {
              name: 'metatags', type: 'seo', opportunities: 2, issues: 2,
            },
            {
              name: 'links', type: 'seo', opportunities: 2, issues: 4,
            },
            {
              name: 'accessibility', type: 'a11y', opportunities: 2, issues: 45,
            },
          ],
        },
      ]);
    });

    it('handles malformed result entries (non-array audits / opportunities)', async () => {
      loggerStub.info.resetHistory();
      const resultJob = {
        ...mockJob,
        getStatus: () => 'COMPLETED',
        getResult: () => [
          // audits is not an array -> falls back to []
          { pageUrl: 'https://main--example-site.aem.page/a.html', step: 'identify', audits: undefined },
          // audit present but opportunities is not an array -> opportunities count falls back to 0
          {
            pageUrl: 'https://main--example-site.aem.page/b.html',
            step: 'identify',
            audits: [{ name: 'metatags', type: 'seo', opportunities: undefined }],
          },
        ],
      };
      mockDataAccess.AsyncJob.findById.resolves(resultJob);

      const context = { params: { jobId } };
      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(200);

      const infoCall = loggerStub.info.getCalls()
        .find((c) => typeof c.args[0] === 'string'
          && c.args[0].includes(`[Preflight] Run complete. jobId=${jobId}`)
          && c.args[0].includes('status=COMPLETED'));
      expect(infoCall, 'expected a [Preflight] jobId info log').to.not.be.undefined;
      const logged = JSON.parse(infoCall.args[0].split('results=')[1]);
      expect(logged).to.deep.equal([
        { pageUrl: 'https://main--example-site.aem.page/a.html', step: 'identify', audits: [] },
        {
          pageUrl: 'https://main--example-site.aem.page/b.html',
          step: 'identify',
          audits: [{
            name: 'metatags', type: 'seo', opportunities: 0, issues: 0,
          }],
        },
      ]);
    });

    it('does not log results while the job is still IN_PROGRESS', async () => {
      loggerStub.info.resetHistory();
      const inProgressJob = {
        ...mockJob,
        getStatus: () => 'IN_PROGRESS',
        getResult: () => [
          {
            pageUrl: 'https://main--example-site.aem.page/test.html',
            step: 'identify',
            audits: [{ name: 'Meta Tags', type: 'meta-tags', opportunities: [{}] }],
          },
        ],
      };
      mockDataAccess.AsyncJob.findById.resolves(inProgressJob);

      const context = { params: { jobId } };
      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(200);

      const infoCall = loggerStub.info.getCalls()
        .find((c) => typeof c.args[0] === 'string' && c.args[0].includes(`[Preflight] Run complete. jobId=${jobId}`));
      expect(infoCall, 'expected no [Preflight] jobId info log while IN_PROGRESS').to.be.undefined;
    });

    it('returns 400 Bad Request for invalid job ID', async () => {
      const context = {
        params: {
          jobId: 'invalid-uuid',
        },
      };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid jobId',
      });
    });

    it('returns 404 Not Found for non-existent job', async () => {
      mockDataAccess.AsyncJob.findById.resolves(null);

      const context = {
        params: {
          jobId,
        },
      };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(404);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: `Job with ID ${jobId} not found`,
      });
    });

    it('handles errors during job retrieval', async () => {
      mockDataAccess.AsyncJob.findById.rejects(new Error('Something went wrong'));

      const context = {
        params: {
          jobId,
        },
      };

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(500);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Something went wrong',
      });
    });
  });

  describe('getAllPreflights', () => {
    let GetAllPreflightsController;
    let hasAccessStub;

    beforeEach(async () => {
      mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);
      mockDataAccess.Preflight.allBySiteIdAndUrl = sandbox.stub().resolves([mockPreflight]);
      hasAccessStub = sandbox.stub().resolves(true);
      GetAllPreflightsController = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/access-control-util.js': {
          default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
        },
      });
      preflightController = GetAllPreflightsController(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );
    });

    it('returns 404 when site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const response = await preflightController.getAllPreflights({
        params: { siteId: 'test-site-123' },
      });
      expect(response.status).to.equal(404);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_SITE_NOT_FOUND');
    });

    it('returns 403 when access is denied', async () => {
      hasAccessStub.resolves(false);
      const response = await preflightController.getAllPreflights({
        params: { siteId: 'test-site-123' },
      });
      expect(response.status).to.equal(403);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_ACCESS_DENIED');
    });

    it('returns list of preflights for site', async () => {
      const response = await preflightController.getAllPreflights({
        params: { siteId: 'test-site-123' },
      });
      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].preflightId).to.equal(preflightId);
      expect(result[0].status).to.equal('IN_PROGRESS');
      // SITES-47254: list items carry siteId, updatedAt, endedAt
      expect(result[0].siteId).to.equal('test-site-123');
      expect(result[0].updatedAt).to.equal('2024-03-20T10:01:00Z');
      expect(result[0]).to.have.property('endedAt');
      // List does not surface asyncJobId/scanId/result/error
      expect(result[0]).to.not.have.property('asyncJobId');
      expect(result[0]).to.not.have.property('scanId');
      expect(result[0]).to.not.have.property('result');
      expect(result[0]).to.not.have.property('error');
    });

    it('returns empty array when no preflights exist', async () => {
      mockDataAccess.Preflight.allBySiteIdAndUrl.resolves([]);
      const response = await preflightController.getAllPreflights({
        params: { siteId: 'test-site-123' },
      });
      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('passes url filter to allBySiteIdAndUrl via rawQueryString', async () => {
      await preflightController.getAllPreflights({
        params: { siteId: 'test-site-123' },
        invocation: { event: { rawQueryString: 'url=https%3A%2F%2Fmain--example-site.aem.page%2Ftest.html' } },
      });
      expect(mockDataAccess.Preflight.allBySiteIdAndUrl).to.have.been.calledWith(
        'test-site-123',
        'https://main--example-site.aem.page/test.html',
      );
    });

    it('passes undefined url filter when no query string present', async () => {
      await preflightController.getAllPreflights({
        params: { siteId: 'test-site-123' },
      });
      expect(mockDataAccess.Preflight.allBySiteIdAndUrl).to.have.been.calledWith(
        'test-site-123',
        undefined,
      );
    });

    it('returns 500 when Site.findById throws', async () => {
      mockDataAccess.Site.findById.rejects(new Error('DB error'));
      const response = await preflightController.getAllPreflights({
        params: { siteId: 'test-site-123' },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
    });

    it('returns 500 when Preflight.allBySiteIdAndUrl throws', async () => {
      mockDataAccess.Preflight.allBySiteIdAndUrl.rejects(new Error('DB error'));
      const response = await preflightController.getAllPreflights({
        params: { siteId: 'test-site-123' },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
    });
  });

  describe('getPreflightById', () => {
    let GetPreflightByIdController;
    let hasAccessStub;

    beforeEach(async () => {
      mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);
      mockDataAccess.Preflight.findById = sandbox.stub().resolves(mockPreflight);
      hasAccessStub = sandbox.stub().resolves(true);
      GetPreflightByIdController = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/access-control-util.js': {
          default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
        },
      });
      preflightController = GetPreflightByIdController(
        {
          dataAccess: mockDataAccess,
          sqs: mockSqs,
          attributes: { authInfo: mockAuthInfo },
          pathInfo: { headers: {} },
        },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          AWS_ENV: 'prod',
        },
      );
    });

    it('returns 404 when site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const response = await preflightController.getPreflightById({
        params: { siteId: 'test-site-123', preflightId },
      });
      expect(response.status).to.equal(404);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_SITE_NOT_FOUND');
    });

    it('returns 403 when access is denied', async () => {
      hasAccessStub.resolves(false);
      const response = await preflightController.getPreflightById({
        params: { siteId: 'test-site-123', preflightId },
      });
      expect(response.status).to.equal(403);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_ACCESS_DENIED');
    });

    it('returns 404 when preflight is not found', async () => {
      mockDataAccess.Preflight.findById.resolves(null);
      const response = await preflightController.getPreflightById({
        params: { siteId: 'test-site-123', preflightId },
      });
      expect(response.status).to.equal(404);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_NOT_FOUND');
    });

    it('returns 404 when preflight belongs to a different site', async () => {
      const altPreflight = { getId: () => preflightId, getSiteId: () => 'other-site' };
      mockDataAccess.Preflight.findById.resolves(altPreflight);
      const response = await preflightController.getPreflightById({
        params: { siteId: 'test-site-123', preflightId },
      });
      expect(response.status).to.equal(404);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_NOT_FOUND');
    });

    it('returns 200 with preflight detail for valid request', async () => {
      const response = await preflightController.getPreflightById({
        params: { siteId: 'test-site-123', preflightId },
      });
      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.preflightId).to.equal(preflightId);
      expect(result.status).to.equal('IN_PROGRESS');
      expect(result.url).to.equal('https://main--example-site.aem.page/test.html');
      expect(result.result).to.be.null;
      expect(result.error).to.be.null;
      expect(result.updatedAt).to.equal('2024-03-20T10:01:00Z');
      // SITES-47254: detail carries siteId; result/error join AsyncJob
      expect(result.siteId).to.equal('test-site-123');
      // Internal correlation fields and AsyncJob-owned timing stay off the wire
      expect(result).to.not.have.property('asyncJobId');
      expect(result).to.not.have.property('scanId');
      expect(result).to.not.have.property('startedAt');
    });

    it('sources result/error from the joined AsyncJob, not from Preflight', async () => {
      const errorPayload = { code: 'DA_FETCH_ERROR', message: 'Document Authoring 502' };
      const completedJob = {
        ...mockJob,
        getResult: () => [{ pageUrl: 'https://example.com/page', audits: [] }],
        getError: () => errorPayload,
      };
      mockPreflight.getAsyncJob.resolves(completedJob);

      const response = await preflightController.getPreflightById({
        params: { siteId: 'test-site-123', preflightId },
      });
      const result = await response.json();
      expect(result.result).to.deep.equal([{ pageUrl: 'https://example.com/page', audits: [] }]);
      expect(result.error).to.deep.equal(errorPayload);
    });

    it('degrades result/error to null when getAsyncJob throws', async () => {
      mockPreflight.getAsyncJob.rejects(new Error('async_jobs unreachable'));

      const response = await preflightController.getPreflightById({
        params: { siteId: 'test-site-123', preflightId },
      });
      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.result).to.be.null;
      expect(result.error).to.be.null;
      // Rest of the detail is still populated from Preflight
      expect(result.preflightId).to.equal(preflightId);
      expect(result.status).to.equal('IN_PROGRESS');
      expect(loggerStub.warn).to.have.been.called;
    });

    it('returns 500 when Site.findById throws', async () => {
      mockDataAccess.Site.findById.rejects(new Error('DB error'));
      const response = await preflightController.getPreflightById({
        params: { siteId: 'test-site-123', preflightId },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
    });

    it('returns 500 when Preflight.findById throws', async () => {
      mockDataAccess.Preflight.findById.rejects(new Error('DB error'));
      const response = await preflightController.getPreflightById({
        params: { siteId: 'test-site-123', preflightId },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
    });
  });
});

describe('countIssuesForAudit', () => {
  it('returns 0 for an audit with no opportunities', () => {
    expect(countIssuesForAudit({ name: 'body-size', opportunities: [] })).to.equal(0);
  });

  it('returns 0 when opportunities is missing or not an array', () => {
    expect(countIssuesForAudit({ name: 'h1-count' })).to.equal(0);
    expect(countIssuesForAudit({ name: 'h1-count', opportunities: null })).to.equal(0);
    expect(countIssuesForAudit(undefined)).to.equal(0);
  });

  it('counts one issue per opportunity with a scalar issue (metatags/headings)', () => {
    const audit = {
      name: 'metatags',
      opportunities: [{ issue: 'Title too short' }, { issue: 'Description too short' }],
    };
    expect(countIssuesForAudit(audit)).to.equal(2);
  });

  it('ignores opportunities without an issue in the default mode', () => {
    const audit = {
      name: 'headings',
      opportunities: [{ issue: 'Empty Heading' }, { check: 'no-issue-field' }],
    };
    expect(countIssuesForAudit(audit)).to.equal(1);
  });

  it('sums issue-array lengths for links audits', () => {
    const audit = {
      name: 'links',
      opportunities: [
        { check: 'broken-internal-links', issue: [{}, {}, {}] },
        { check: 'broken-external-links', issue: [{}] },
        { check: 'bad-links', issue: [{}] },
      ],
    };
    expect(countIssuesForAudit(audit)).to.equal(5);
  });

  it('sums occurrences for accessibility audits (not htmlWithIssues length)', () => {
    const audit = {
      name: 'accessibility',
      opportunities: [
        { type: 'aria-allowed-attr', occurrences: 5, htmlWithIssues: [{}, {}] },
        { type: 'color-contrast', occurrences: 40 },
        { type: 'missing-occurrences' },
      ],
    };
    expect(countIssuesForAudit(audit)).to.equal(45);
  });
});
