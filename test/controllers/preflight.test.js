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
  };

  const mockSite = {
    getId: () => 'test-site-123',
    getAuthoringType: () => SiteModel.AUTHORING_TYPES.SP,
  };

  const mockConfiguration = {
    getEnabledAuditsForSite: sandbox.stub().returns([
      'preflight-alt-text', 'preflight-headings', 'preflight-links',
    ]),
  };

  const mockDataAccess = {
    AsyncJob: {
      create: sandbox.stub().resolves(mockJob),
      findById: sandbox.stub().resolves(mockJob),
    },
    Site: {
      findByPreviewURL: sandbox.stub().resolves(mockSite),
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
      { dataAccess: mockDataAccess, sqs: mockSqs },
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
        { dataAccess: mockDataAccess, sqs: mockSqs },
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
        { dataAccess: mockDataAccess, sqs: mockSqs },
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
        { dataAccess: mockDataAccess, sqs: mockSqs },
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
        { dataAccess: mockDataAccess, sqs: mockSqs },
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
        { dataAccess: mockDataAccess, sqs: mockSqs },
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
        { dataAccess: mockDataAccess, sqs: mockSqs },
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
        { dataAccess: mockDataAccess, sqs: mockSqs },
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
        { dataAccess: mockDataAccess, sqs: mockSqs },
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

  describe('createBetaPreflightJob', () => {
    const mockBetaJob = {
      ...mockJob,
      setStatus: sandbox.stub(),
      setError: sandbox.stub(),
      setEndedAt: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    let fetchStub;

    beforeEach(() => {
      if (!global.fetch) {
        global.fetch = fetch;
      }
      fetchStub = sinon.stub(global, 'fetch');
      // First call is HEAD check (returns 200 = no auth needed), second is Mysticat
      fetchStub.onFirstCall().resolves({ ok: true, status: 200 });
      fetchStub.onSecondCall().resolves({ ok: true });
      mockDataAccess.AsyncJob.create = sandbox.stub().resolves(mockBetaJob);
    });

    afterEach(() => {
      if (fetchStub && fetchStub.restore) {
        fetchStub.restore();
      }
    });

    it('returns 400 for missing data', async () => {
      const response = await preflightController.createBetaPreflightJob({ data: {} });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.message).to.equal('Invalid request: missing application/json data');
    });

    it('returns 400 for missing or invalid url', async () => {
      const response = await preflightController.createBetaPreflightJob({
        data: { url: 'not-a-url', step: 'identify' },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.message).to.equal('Invalid request: url must be a valid URL');
    });

    it('returns 400 for invalid step', async () => {
      const response = await preflightController.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'bad-step' },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.message).to.equal('Invalid request: step must be either identify or suggest');
    });

    it('returns 500 when site is not found', async () => {
      mockDataAccess.Site.findByPreviewURL.resolves(null);
      const response = await preflightController.createBetaPreflightJob({
        data: { url: 'https://unknown-site.com/page.html', step: 'identify' },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result.message).to.include('No site found for URL');
    });

    it('calls Mysticat and returns 202 with jobId and pollUrl (prod)', async () => {
      const context = {
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      };

      preflightController = PreflightController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',

          AWS_ENV: 'prod',
        },
      );

      const response = await preflightController.createBetaPreflightJob(context);
      expect(response.status).to.equal(202);

      const result = await response.json();
      expect(result.jobId).to.equal(jobId);
      expect(result.pollUrl).to.equal(
        `https://spacecat.experiencecloud.live/api/v1/preflight/beta/jobs/${jobId}`,
      );

      expect(fetchStub).to.have.been.calledTwice;
      const [calledUrl, calledOptions] = fetchStub.secondCall.args;
      expect(calledUrl).to.equal('https://mysticat.example.com/v1/preflight/analyze');
      expect(JSON.parse(calledOptions.body)).to.deep.equal({
        site_id: 'test-site-123',
        url: 'https://main--example-site.aem.page/test.html',
        mode: 'identify',
        scan_id: jobId,
        persist: true,
      });

      // Mysticat owns the job result write-back — SpaceCat does not update the job on success
      expect(mockBetaJob.setStatus).to.not.have.been.called;
      expect(mockBetaJob.save).to.not.have.been.called;
    });

    it('uses ci pollUrl in dev environment', async () => {
      preflightController = PreflightController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'dev',
        },
      );

      const response = await preflightController.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      });
      expect(response.status).to.equal(202);
      const result = await response.json();
      expect(result.pollUrl).to.equal(
        `https://spacecat.experiencecloud.live/api/ci/preflight/beta/jobs/${jobId}`,
      );
    });

    it('uses mystiqueUrl override in dev environment (full URL)', async () => {
      const devCtrl = PreflightController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'dev',
        },
      );

      const response = await devCtrl.createBetaPreflightJob({
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          step: 'identify',
          mystiqueUrl: 'https://experience-platform-mystique-deploy-ethos102-stage-abc123.stage.cloud.adobe.io',
        },
      });
      expect(response.status).to.equal(202);

      const [calledUrl] = fetchStub.secondCall.args;
      expect(calledUrl).to.equal('https://experience-platform-mystique-deploy-ethos102-stage-abc123.stage.cloud.adobe.io/v1/preflight/analyze');
    });

    it('prepends https:// to mystiqueUrl when no scheme is provided', async () => {
      const devCtrl = PreflightController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'dev',
        },
      );

      const response = await devCtrl.createBetaPreflightJob({
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          step: 'identify',
          mystiqueUrl: 'experience-platform-mystique-deploy-ethos102-stage-abc123.stage.cloud.adobe.io',
        },
      });
      expect(response.status).to.equal(202);

      const [calledUrl] = fetchStub.secondCall.args;
      expect(calledUrl).to.equal('https://experience-platform-mystique-deploy-ethos102-stage-abc123.stage.cloud.adobe.io/v1/preflight/analyze');
    });

    it('returns 400 when mystiqueUrl override is used in prod', async () => {
      const prodCtrl = PreflightController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await prodCtrl.createBetaPreflightJob({
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          step: 'identify',
          mystiqueUrl: 'https://experience-platform-mystique-deploy-ethos102-stage-abc123.stage.cloud.adobe.io',
        },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.message).to.equal('mystiqueUrl override is only allowed in dev');
    });

    it('returns 400 when mystiqueUrl is not a valid URL', async () => {
      const devCtrl = PreflightController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'dev',
        },
      );

      const response = await devCtrl.createBetaPreflightJob({
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          step: 'identify',
          mystiqueUrl: 'https://not a valid url',
        },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.message).to.equal('Invalid request: mystiqueUrl must be a valid URL');
    });

    it('returns 400 when mystiqueUrl is not an allowed Mystique ephemeral host', async () => {
      const devCtrl = PreflightController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'dev',
        },
      );

      const response = await devCtrl.createBetaPreflightJob({
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          step: 'identify',
          mystiqueUrl: 'https://evil.example.com',
        },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result.message).to.equal('Invalid request: mystiqueUrl must be a valid Mystique ephemeral host');
    });

    it('sets job to FAILED and saves when Mysticat returns non-ok status', async () => {
      fetchStub.onFirstCall().resolves({ ok: true, status: 200 });
      fetchStub.onSecondCall().resolves({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

      preflightController = PreflightController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await preflightController.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      });
      expect(response.status).to.equal(500);
      expect(mockBetaJob.setStatus).to.have.been.calledWith('FAILED');
      expect(mockBetaJob.setError).to.have.been.calledWithMatch({ code: 'MYSTICAT_ERROR' });
      expect(mockBetaJob.save).to.have.been.calledOnce;
    });

    it('resolves site by siteId when provided', async () => {
      mockDataAccess.Site.findById = sandbox.stub().resolves(mockSite);

      preflightController = PreflightController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await preflightController.createBetaPreflightJob({
        data: {
          url: 'https://main--example-site.aem.page/test.html',
          step: 'identify',
          siteId: 'd140668d-aacf-45fb-a8f2-27ffda65bab4',
        },
      });
      expect(response.status).to.equal(202);
      expect(mockDataAccess.Site.findById).to.have.been
        .calledWith('d140668d-aacf-45fb-a8f2-27ffda65bab4');
      expect(mockDataAccess.Site.findByPreviewURL).to.not.have.been.called;
    });

    it('exchanges promiseToken cookie for access token and sends Bearer Authorization header for CS site (AEM_CS delivery)', async () => {
      // HEAD returns 401 to trigger auth
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      fetchStub.onSecondCall().resolves({ ok: true });

      const aemCsSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
        getDeliveryType: () => SiteModel.DELIVERY_TYPES.AEM_CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': { ...utils, ErrorWithStatusCode: utils.ErrorWithStatusCode },
        '@adobe/spacecat-shared-ims-client': { retrievePageAuthentication: async () => 'exchanged-access-token' },
      });

      const ctrl = PreflightControllerWithMock(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await ctrl.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
        pathInfo: { headers: { cookie: 'promiseToken=cookie-token-123' } },
      });
      expect(response.status).to.equal(202);

      const [, calledOptions] = fetchStub.secondCall.args;
      expect(calledOptions.headers.Authorization).to.equal('Bearer exchanged-access-token');
    });

    it('sends token Authorization header for AMS site (non-AEM_CS delivery)', async () => {
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      fetchStub.onSecondCall().resolves({ ok: true });

      const amsSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.AMS,
        getDeliveryType: () => SiteModel.DELIVERY_TYPES.AEM_AMS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(amsSite);

      const mockPromiseToken = { promise_token: 'ams-promise-token' };
      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: async () => mockPromiseToken,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
        '@adobe/spacecat-shared-ims-client': { retrievePageAuthentication: async () => 'exchanged-access-token' },
      });

      const ctrl = PreflightControllerWithMock(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await ctrl.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      });
      expect(response.status).to.equal(202);

      const [, calledOptions] = fetchStub.secondCall.args;
      expect(calledOptions.headers.Authorization).to.equal('token exchanged-access-token');
    });

    it('falls back to IMS when promiseToken cookie is absent for CS_CW site, then exchanges for access token', async () => {
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      fetchStub.onSecondCall().resolves({ ok: true });

      const cwSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS_CW,
        getDeliveryType: () => SiteModel.DELIVERY_TYPES.AEM_CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(cwSite);

      const mockPromiseToken = { promise_token: 'ims-promise-token-456' };
      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: async () => mockPromiseToken,
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
        '@adobe/spacecat-shared-ims-client': { retrievePageAuthentication: async () => 'exchanged-access-token' },
      });

      const ctrl = PreflightControllerWithMock(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await ctrl.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      });
      expect(response.status).to.equal(202);

      const [, calledOptions] = fetchStub.secondCall.args;
      expect(calledOptions.headers.Authorization).to.equal('Bearer exchanged-access-token');
    });

    it('uses Secrets Manager for non-promise-based SP site when auth is required', async () => {
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });
      fetchStub.onSecondCall().resolves({ ok: true });

      const spSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.SP,
        getDeliveryType: () => SiteModel.DELIVERY_TYPES.AEM_EDGE,
        getBaseURL: () => 'https://www.example.com',
      };
      mockDataAccess.Site.findByPreviewURL.resolves(spSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': { ...utils, ErrorWithStatusCode: utils.ErrorWithStatusCode },
        '@adobe/spacecat-shared-ims-client': { retrievePageAuthentication: async () => 'static-page-auth-token' },
      });

      const ctrl = PreflightControllerWithMock(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await ctrl.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      });
      expect(response.status).to.equal(202);

      const [, calledOptions] = fetchStub.secondCall.args;
      expect(calledOptions.headers.Authorization).to.equal('token static-page-auth-token');
    });

    it(
      'returns 400 when IMS promise token fetch fails with ErrorWithStatusCode for AMS site',
      async () => {
        fetchStub.onFirstCall().resolves({ ok: false, status: 401 });

        const amsSite = {
          getId: () => 'test-site-123',
          getAuthoringType: () => SiteModel.AUTHORING_TYPES.AMS,
        };
        mockDataAccess.Site.findByPreviewURL.resolves(amsSite);

        const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
          '../../src/support/utils.js': {
            ...utils,
            getIMSPromiseToken: async () => {
              throw new utils.ErrorWithStatusCode('Missing Authorization header', 400);
            },
            ErrorWithStatusCode: utils.ErrorWithStatusCode,
          },
          '@adobe/spacecat-shared-ims-client': { retrievePageAuthentication: async () => 'exchanged-access-token' },
        });

        const ctrl = PreflightControllerWithMock(
          { dataAccess: mockDataAccess, sqs: mockSqs },
          loggerStub,
          {
            AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
            MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
            AWS_ENV: 'prod',
          },
        );

        const response = await ctrl.createBetaPreflightJob({
          data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
        });
        expect(response.status).to.equal(400);
        const result = await response.json();
        expect(result).to.deep.equal({ message: 'Missing Authorization header' });
      },
    );

    it('returns 500 when IMS promise token fetch fails with generic error', async () => {
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });

      const amsSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.AMS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(amsSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          getIMSPromiseToken: async () => { throw new Error('IMS unavailable'); },
          ErrorWithStatusCode: utils.ErrorWithStatusCode,
        },
        '@adobe/spacecat-shared-ims-client': { retrievePageAuthentication: async () => 'exchanged-access-token' },
      });

      const ctrl = PreflightControllerWithMock(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await ctrl.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result).to.deep.equal({ message: 'Error getting promise token' });
    });

    it('returns 500 when retrievePageAuthentication fails', async () => {
      fetchStub.onFirstCall().resolves({ ok: false, status: 401 });

      const csSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS,
        getDeliveryType: () => SiteModel.DELIVERY_TYPES.AEM_CS,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(csSite);

      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': { ...utils, ErrorWithStatusCode: utils.ErrorWithStatusCode },
        '@adobe/spacecat-shared-ims-client': {
          retrievePageAuthentication: async () => { throw new Error('Exchange failed'); },
        },
      });

      const ctrl = PreflightControllerWithMock(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await ctrl.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
        pathInfo: { headers: { cookie: 'promiseToken=cookie-token-123' } },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result).to.deep.equal({ message: 'Error retrieving page authentication' });
    });

    it('does not send Authorization header when HEAD returns 200 (no auth needed)', async () => {
      const response = await preflightController.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
        pathInfo: { headers: { cookie: 'promiseToken=should-not-be-forwarded' } },
      });
      expect(response.status).to.equal(202);

      const [, calledOptions] = fetchStub.secondCall.args;
      expect(calledOptions.headers.Authorization).to.be.undefined;
    });

    it('passes enabled preflight audits from Configuration to Mysticat', async () => {
      mockConfiguration.getEnabledAuditsForSite.returns([
        'preflight-headings', 'preflight-links', 'lhs-mobile',
      ]);

      const response = await preflightController.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      });
      expect(response.status).to.equal(202);

      const [, calledOptions] = fetchStub.secondCall.args;
      const body = JSON.parse(calledOptions.body);
      expect(body.audits).to.deep.equal(['headings', 'links']);
    });

    it('passes all preflight audits when all handlers are enabled', async () => {
      mockConfiguration.getEnabledAuditsForSite.returns([
        'preflight-alt-text', 'preflight-headings', 'preflight-links',
      ]);

      const response = await preflightController.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      });
      expect(response.status).to.equal(202);

      const [, calledOptions] = fetchStub.secondCall.args;
      const body = JSON.parse(calledOptions.body);
      expect(body.audits).to.deep.equal(['alt-text', 'headings', 'links']);
    });

    it('omits audits field when no preflight handlers are enabled', async () => {
      mockConfiguration.getEnabledAuditsForSite.returns([
        'lhs-mobile', 'cwv',
      ]);

      const response = await preflightController.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      });
      expect(response.status).to.equal(202);

      const [, calledOptions] = fetchStub.secondCall.args;
      const body = JSON.parse(calledOptions.body);
      expect(body.audits).to.be.undefined;
    });

    it('runs all audits when Configuration.findLatest fails', async () => {
      mockDataAccess.Configuration.findLatest = sandbox.stub().rejects(new Error('DB error'));

      preflightController = PreflightController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await preflightController.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      });
      expect(response.status).to.equal(202);

      const [, calledOptions] = fetchStub.secondCall.args;
      const body = JSON.parse(calledOptions.body);
      expect(body.audits).to.be.undefined;
    });

    it('runs all audits when Configuration.findLatest returns null', async () => {
      mockDataAccess.Configuration.findLatest = sandbox.stub().resolves(null);

      preflightController = PreflightController(
        { dataAccess: mockDataAccess, sqs: mockSqs },
        loggerStub,
        {
          AUDIT_JOBS_QUEUE_URL: 'https://sqs.test.amazonaws.com/audit-queue',
          MYSTIQUE_API_BASE_URL: 'https://mysticat.example.com',
          AWS_ENV: 'prod',
        },
      );

      const response = await preflightController.createBetaPreflightJob({
        data: { url: 'https://main--example-site.aem.page/test.html', step: 'identify' },
      });
      expect(response.status).to.equal(202);

      const [, calledOptions] = fetchStub.secondCall.args;
      const body = JSON.parse(calledOptions.body);
      expect(body.audits).to.be.undefined;
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

  describe('getBetaPreflightJobStatusAndResult', () => {
    it('returns 400 for invalid jobId', async () => {
      const response = await preflightController.getBetaPreflightJobStatusAndResult({
        params: { jobId: 'invalid-uuid' },
      });
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({ message: 'Invalid jobId' });
    });

    it('returns 404 when job is not found', async () => {
      mockDataAccess.AsyncJob.findById.resolves(null);
      const response = await preflightController.getBetaPreflightJobStatusAndResult({
        params: { jobId },
      });
      expect(response.status).to.equal(404);
      const result = await response.json();
      expect(result).to.deep.equal({ message: `Job with ID ${jobId} not found` });
    });

    it('returns job status and result when job is found', async () => {
      const response = await preflightController.getBetaPreflightJobStatusAndResult({
        params: { jobId },
      });
      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result.jobId).to.equal(jobId);
      expect(result.status).to.equal('IN_PROGRESS');
    });

    it('handles errors during job retrieval', async () => {
      mockDataAccess.AsyncJob.findById.rejects(new Error('DB error'));
      const response = await preflightController.getBetaPreflightJobStatusAndResult({
        params: { jobId },
      });
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result).to.deep.equal({ message: 'DB error' });
    });
  });
});
