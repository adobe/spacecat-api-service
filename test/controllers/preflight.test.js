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
import PreflightController from '../../src/controllers/preflight.js';

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

    it('creates a preflight job using promiseToken cookie for crosswalk authoring type', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS_CW,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const getIMSPromiseTokenStub = sandbox.stub();
      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: getIMSPromiseTokenStub,
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
            cookie: 'promiseToken=promiseToken123',
          },
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(202);
      expect(getIMSPromiseTokenStub).to.not.have.been.called;
      expect(mockSqs.sendMessage).to.have.been.calledWith(
        'https://sqs.test.amazonaws.com/audit-queue',
        {
          jobId,
          siteId: mockSite.getId(),
          type: 'preflight',
          promiseToken: { promise_token: 'promiseToken123' },
        },
      );
    });

    it('handles promise token error for AEM_CS site', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: async () => {
            throw new utils.ErrorWithStatusCode('Missing Authorization header', 400);
          },
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
        message: 'Missing Authorization header',
      });
    });

    it('handles promise token error for AEM_CS site with generic error', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: async () => { throw new Error('Generic error'); },
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
      expect(result).to.deep.equal({
        message: 'Error getting promise token',
      });
    });

    it('uses promiseToken cookie when present instead of IMS', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const getIMSPromiseTokenStub = sandbox.stub();
      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: getIMSPromiseTokenStub,
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
            cookie: 'promiseToken=promiseToken123',
          },
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(202);
      expect(getIMSPromiseTokenStub).to.not.have.been.called;
      expect(mockSqs.sendMessage).to.have.been.calledWith(
        'https://sqs.test.amazonaws.com/audit-queue',
        {
          jobId,
          siteId: 'test-site-123',
          type: 'preflight',
          promiseToken: { promise_token: 'promiseToken123' },
        },
      );
    });

    it('preserves full cookie value when token contains = characters (base64)', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const base64Token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZw==';
      const getIMSPromiseTokenStub = sandbox.stub();
      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: getIMSPromiseTokenStub,
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
            cookie: `promiseToken=${base64Token}`,
          },
        },
      };

      const response = await preflightControllerWithMock.createPreflightJob(context);
      expect(response.status).to.equal(202);
      expect(getIMSPromiseTokenStub).to.not.have.been.called;
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

    it('falls back to IMS when promiseToken cookie is absent', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS_CW,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const mockPromiseToken = { promise_token: 'ims-token', expires_in: 3600, token_type: 'Bearer' };
      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: async () => mockPromiseToken,
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
      expect(response.status).to.equal(202);
      expect(mockSqs.sendMessage).to.have.been.calledWith(
        'https://sqs.test.amazonaws.com/audit-queue',
        {
          jobId,
          siteId: aemCsSite.getId(),
          type: 'preflight',
          promiseToken: mockPromiseToken,
        },
      );
    });

    it('falls back to IMS when promiseToken cookie is empty', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.AMS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const mockPromiseToken = { promise_token: 'ims-fallback', expires_in: 3600, token_type: 'Bearer' };
      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: async () => mockPromiseToken,
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
            cookie: 'otherCookie=abc',
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
          promiseToken: mockPromiseToken,
        },
      );
    });
  });

  describe('createPreflight', () => {
    let fetchStub;
    let CreatePreflightController;
    const mockTierClient = {
      checkValidEntitlement: sandbox.stub().resolves({ siteEnrollment: true }),
    };
    let hasAccessStub;

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
      mockDataAccess.Configuration.findLatest = sandbox.stub().resolves(mockConfiguration);
      mockConfiguration.isHandlerEnabledForSite.returns(true);
      mockConfiguration.getHandlers.returns({
        preflight: {
          productCodes: ['ASO'],
          enabledByDefault: false,
          enabled: { sites: ['test-site-123'], orgs: [] },
          disabled: { sites: [], orgs: [] },
        },
      });
      mockConfiguration.getEnabledAuditsForSite.returns([
        'alt-text-preflight', 'headings-preflight', 'links-preflight',
      ]);
      mockTierClient.checkValidEntitlement.resolves({ siteEnrollment: true });
      hasAccessStub = sandbox.stub().resolves(true);

      CreatePreflightController = await esmock('../../src/controllers/preflight.js', {
        '@adobe/spacecat-shared-tier-client': {
          TierClient: { createForSite: sandbox.stub().resolves(mockTierClient) },
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

    it('returns 500 when Configuration.findLatest throws', async () => {
      mockDataAccess.Configuration.findLatest = sandbox.stub().rejects(new Error('DB error'));
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
      expect(result.message).to.equal('Failed to load configuration');
    });

    it('returns 500 when Configuration.findLatest returns null', async () => {
      mockDataAccess.Configuration.findLatest = sandbox.stub().resolves(null);
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
      expect(result.message).to.equal('Configuration not available');
    });

    it('returns 403 when preflight is not enabled for site', async () => {
      mockConfiguration.isHandlerEnabledForSite.returns(false);
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(403);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_NOT_ENABLED');
    });

    it('returns 403 when site has no valid entitlement', async () => {
      mockTierClient.checkValidEntitlement.resolves({ siteEnrollment: false });
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(403);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_NOT_ENABLED');
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
      await preflightController.createPreflight({
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
    });

    it('does not include Authorization header when HEAD returns 200 (no auth needed)', async () => {
      await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      const [, calledOptions] = fetchStub.secondCall.args;
      expect(calledOptions.headers.Authorization).to.be.undefined;
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

    // -- isAuditEnabledForSite error / not-found paths --

    it('returns 403 PREFLIGHT_NOT_ENABLED when the preflight handler is not in Configuration', async () => {
      mockConfiguration.getHandlers.returns({}); // no `preflight` handler
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(403);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_NOT_ENABLED');
    });

    it('returns 403 PREFLIGHT_NOT_ENABLED when the preflight handler has no productCodes', async () => {
      mockConfiguration.getHandlers.returns({
        preflight: {
          // no productCodes
          enabledByDefault: false,
          enabled: { sites: ['test-site-123'], orgs: [] },
          disabled: { sites: [], orgs: [] },
        },
      });
      const response = await preflightController.createPreflight({
        params: { siteId: 'test-site-123' },
        data: { url: 'https://main--example-site.aem.page/test.html' },
      });
      expect(response.status).to.equal(403);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_NOT_ENABLED');
    });

    it('returns 403 PREFLIGHT_NOT_ENABLED when TierClient.createForSite throws (caught, returns false)', async () => {
      // Rebuild the controller so the TierClient esmock rejects this run.
      const ControllerWithFailingTier = await esmock('../../src/controllers/preflight.js', {
        '@adobe/spacecat-shared-tier-client': {
          TierClient: { createForSite: sandbox.stub().rejects(new Error('tier-client-down')) },
        },
        '../../src/support/access-control-util.js': {
          default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
        },
      });
      const controller = ControllerWithFailingTier(
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
      });
      expect(response.status).to.equal(403);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_NOT_ENABLED');
    });

    // -- enableAuthentication=true path (HEAD returns 401) --

    it('forwards Authorization header to Mysticat for auth-required URL with promiseToken cookie', async () => {
      // First fetch (HEAD): 401 → enableAuthentication=true.
      // Use CS_CW so resolvePromiseToken consults the cookie
      // (PROMISE_BASED_TYPES = [CS, CS_CW, AMS]).
      fetchStub.resetBehavior();
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      fetchStub.onSecondCall().resolves({ ok: true });
      const cwSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS_CW,
        getDeliveryType: () => 'aem_edge',
      };
      mockDataAccess.Site.findById.resolves(cwSite);
      mockDataAccess.Site.findByPreviewURL.resolves(cwSite);

      const mockRetrievePageAuth = sandbox.stub().resolves('page-access-token');
      const ControllerWithIms = await esmock('../../src/controllers/preflight.js', {
        '@adobe/spacecat-shared-ims-client': {
          retrievePageAuthentication: mockRetrievePageAuth,
        },
        '@adobe/spacecat-shared-tier-client': {
          TierClient: { createForSite: sandbox.stub().resolves(mockTierClient) },
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
          pathInfo: { headers: { cookie: 'promiseToken=cookie-token' } },
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
        pathInfo: { headers: { cookie: 'promiseToken=cookie-token' } },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      const [, mystiOpts] = fetchStub.secondCall.args;
      // CS_CW + promiseToken → isBearer false (DeliveryType !== AEM_CS) → 'token <t>'
      expect(mystiOpts.headers.Authorization).to.equal('token page-access-token');
      expect(mockRetrievePageAuth).to.have.been.calledOnce;
    });

    it('returns 400 when resolvePromiseToken throws ErrorWithStatusCode', async () => {
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
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: async () => {
            throw new utils.ErrorWithStatusCode('Missing Authorization header', 400);
          },
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
        '@adobe/spacecat-shared-tier-client': {
          TierClient: { createForSite: sandbox.stub().resolves(mockTierClient) },
        },
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
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INVALID_REQUEST');
      expect(result.message).to.equal('Missing Authorization header');
    });

    it('returns 500 when resolvePromiseToken throws a non-ErrorWithStatusCode error', async () => {
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
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: async () => { throw new Error('IMS down'); },
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
        '@adobe/spacecat-shared-tier-client': {
          TierClient: { createForSite: sandbox.stub().resolves(mockTierClient) },
        },
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
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.errorCode).to.equal('PREFLIGHT_INTERNAL_ERROR');
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
          retrievePageAuthentication: mockRetrievePageAuth,
        },
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: async () => ({ promise_token: 'ims-token' }),
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
        '@adobe/spacecat-shared-tier-client': {
          TierClient: { createForSite: sandbox.stub().resolves(mockTierClient) },
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
          retrievePageAuthentication: mockRetrievePageAuth,
        },
        '@adobe/spacecat-shared-tier-client': {
          TierClient: { createForSite: sandbox.stub().resolves(mockTierClient) },
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

    it('uses Bearer prefix for AEM_CS site with promiseToken cookie', async () => {
      // Covers the `isBearer` branch where DeliveryType === AEM_CS && promiseTokenObj truthy.
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
          retrievePageAuthentication: mockRetrievePageAuth,
        },
        '@adobe/spacecat-shared-tier-client': {
          TierClient: { createForSite: sandbox.stub().resolves(mockTierClient) },
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
          pathInfo: { headers: { cookie: 'promiseToken=cookie-token' } },
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
        pathInfo: { headers: { cookie: 'promiseToken=cookie-token' } },
        attributes: { authInfo: mockAuthInfo },
      });
      expect(response.status).to.equal(202);
      const [, mystiOpts] = fetchStub.secondCall.args;
      expect(mystiOpts.headers.Authorization).to.equal('Bearer cs-token');
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
      // The Mysticat call was made without an Authorization header (auth
      // was skipped because the HEAD probe threw).
      const [, mystiOpts] = fetchStub.secondCall.args;
      expect(mystiOpts.headers.Authorization).to.be.undefined;
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
