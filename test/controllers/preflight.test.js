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
import PreflightController, {
  countIssuesForAudit,
  PREFLIGHT_PROCESS_AUDW,
} from '../../src/controllers/preflight.js';

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
    setError: sandbox.stub(),
    setEndedAt: sandbox.stub(),
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
    // Default site identity getters for the mock. Per-test AEM CS / EDS site
    // fixtures override as needed.
    getBaseURL: () => 'https://main--example-site.aem.page',
    getDeliveryConfig: () => ({}),
    getHlxConfig: () => ({}),
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
    mockSqs.sendMessage = sandbox.stub().resolves();
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
          && c.args[0].includes('[Preflight] Run complete.')
          && c.args[0].includes(`process=${PREFLIGHT_PROCESS_AUDW}`)
          && c.args[0].includes(`jobId=${jobId}`)
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
          && c.args[0].includes('[Preflight] Run complete.')
          && c.args[0].includes(`process=${PREFLIGHT_PROCESS_AUDW}`)
          && c.args[0].includes(`jobId=${jobId}`)
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
        .find((c) => typeof c.args[0] === 'string' && c.args[0].includes('[Preflight] Run complete.'));
      expect(infoCall, 'expected no [Preflight] jobId info log while IN_PROGRESS').to.be.undefined;
    });

    it('warns with code + message (not the full error object) when the job is FAILED', async () => {
      loggerStub.warn.resetHistory();
      const failedError = { code: 'MYSTICAT_ERROR', message: 'Upstream analyze service failed', details: { secret: 'tok' } };
      const failedJob = {
        ...mockJob,
        getStatus: () => 'FAILED',
        getError: () => failedError,
      };
      mockDataAccess.AsyncJob.findById.resolves(failedJob);

      const context = { params: { jobId } };
      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(200);

      const warnCall = loggerStub.warn.getCalls()
        .find((c) => typeof c.args[0] === 'string'
          && c.args[0].includes('[Preflight] Run failed.')
          && c.args[0].includes(`process=${PREFLIGHT_PROCESS_AUDW}`)
          && c.args[0].includes(`jobId=${jobId}`)
          && c.args[0].includes('status=FAILED'));
      expect(warnCall, 'expected a [Preflight] Run failed warn log').to.not.be.undefined;
      expect(warnCall.args[0]).to.include('errorCode=MYSTICAT_ERROR');
      expect(warnCall.args[0]).to.include('errorMessage=Upstream analyze service failed');
      // details must NOT be logged (never log secrets / freeform worker content)
      expect(warnCall.args[0]).to.not.include('details');
      expect(warnCall.args[0]).to.not.include('tok');
    });

    it('warns with errorCode=none when the job is FAILED without a structured error', async () => {
      loggerStub.warn.resetHistory();
      const failedJob = {
        ...mockJob,
        getStatus: () => 'FAILED',
        getError: () => null,
      };
      mockDataAccess.AsyncJob.findById.resolves(failedJob);

      const context = { params: { jobId } };
      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(200);

      const warnCall = loggerStub.warn.getCalls()
        .find((c) => typeof c.args[0] === 'string'
          && c.args[0].includes('[Preflight] Run failed.')
          && c.args[0].includes(`process=${PREFLIGHT_PROCESS_AUDW}`)
          && c.args[0].includes(`jobId=${jobId}`)
          && c.args[0].includes('status=FAILED'));
      expect(warnCall, 'expected a [Preflight] Run failed warn log').to.not.be.undefined;
      expect(warnCall.args[0]).to.include('errorCode=none');
      expect(warnCall.args[0]).to.include('errorMessage=none');
    });

    it('logs FAILED at warn level, not error', async () => {
      loggerStub.warn.resetHistory();
      loggerStub.error.resetHistory();
      const failedJob = {
        ...mockJob,
        getStatus: () => 'FAILED',
        getError: () => ({ code: 'MYSTICAT_ERROR', message: 'boom' }),
      };
      mockDataAccess.AsyncJob.findById.resolves(failedJob);

      await preflightController.getPreflightJobStatusAndResult({ params: { jobId } });

      const errorRunFailed = loggerStub.error.getCalls()
        .find((c) => typeof c.args[0] === 'string' && c.args[0].includes('[Preflight] Run failed.'));
      expect(errorRunFailed, 'FAILED must not be logged at error level').to.be.undefined;
    });

    it('re-logs the terminal outcome on every poll (stateless — one warn per poll)', async () => {
      loggerStub.warn.resetHistory();
      const failedJob = {
        ...mockJob,
        getStatus: () => 'FAILED',
        getError: () => ({ code: 'MYSTICAT_ERROR', message: 'boom' }),
      };
      mockDataAccess.AsyncJob.findById.resolves(failedJob);

      const context = { params: { jobId } };
      await preflightController.getPreflightJobStatusAndResult(context);
      await preflightController.getPreflightJobStatusAndResult(context);
      await preflightController.getPreflightJobStatusAndResult(context);

      const runFailedWarns = loggerStub.warn.getCalls()
        .filter((c) => typeof c.args[0] === 'string' && c.args[0].includes('[Preflight] Run failed.'));
      expect(runFailedWarns).to.have.lengthOf(3);
    });

    it('does not log a failure for a COMPLETED job', async () => {
      loggerStub.warn.resetHistory();
      const completedJob = {
        ...mockJob,
        getStatus: () => 'COMPLETED',
        getResult: () => [],
      };
      mockDataAccess.AsyncJob.findById.resolves(completedJob);

      const context = { params: { jobId } };
      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(200);

      const warnCall = loggerStub.warn.getCalls()
        .find((c) => typeof c.args[0] === 'string' && c.args[0].includes('[Preflight] Run failed.'));
      expect(warnCall, 'expected no [Preflight] Run failed warn log for a COMPLETED job').to.be.undefined;
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
