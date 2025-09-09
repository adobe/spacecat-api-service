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

/* eslint-env mocha */

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

  const mockDataAccess = {
    AsyncJob: {
      create: sandbox.stub().resolves(mockJob),
      findById: sandbox.stub().resolves(mockJob),
    },
    Site: {
      findByPreviewURL: sandbox.stub().resolves(mockSite),
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
            checks: ['canonical', 'links', 'metatags', 'body-size', 'placeholder "lorem-ipsum" detection', 'h1-count', 'accessibility', 'readability'],
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
            checks: ['canonical', 'links', 'metatags', 'body-size', 'placeholder "lorem-ipsum" detection', 'h1-count', 'accessibility', 'readability'],
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

    it('creates a preflight job with specific checks', async () => {
      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
          checks: ['canonical', 'metatags'],
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(202);

      expect(mockDataAccess.AsyncJob.create).to.have.been.calledWith({
        status: 'IN_PROGRESS',
        metadata: {
          payload: {
            siteId: 'test-site-123',
            urls: ['https://example.com/test.html'],
            step: 'identify',
            enableAuthentication: true,
            checks: ['canonical', 'metatags'],
          },
          jobType: 'preflight',
          tags: ['preflight'],
        },
      });
    });

    it('returns 400 Bad Request for empty checks array', async () => {
      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
          checks: [],
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: checks must be a non-empty array of strings',
      });
    });

    it('returns 400 Bad Request for invalid check type', async () => {
      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
          checks: ['invalid-check'],
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: checks must be one of: canonical, links, metatags, body-size, placeholder "lorem-ipsum" detection, h1-count, accessibility, readability',
      });
    });

    it('returns 400 Bad Request if checks is not an array', async () => {
      const context = {
        data: {
          urls: ['https://example.com/test.html'],
          step: 'identify',
          checks: 'canonical',
        },
      };

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);

      const result = await response.json();
      expect(result).to.deep.equal({
        message: 'Invalid request: checks must be a non-empty array of strings',
      });
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
            checks: ['canonical', 'links', 'metatags', 'body-size', 'placeholder "lorem-ipsum" detection', 'h1-count', 'accessibility', 'readability'],
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

    it('creates a preflight job with crosswalk authoring type and includes promise token', async () => {
      const aemCsSite = {
        getId: () => 'test-site-123',
        getAuthoringType: () => SiteModel.AUTHORING_TYPES.CS_CW,
      };
      mockDataAccess.Site.findByPreviewURL.resolves(aemCsSite);

      const mockPromiseToken = { promise_token: 'test-token', expires_in: 3600, token_type: 'Bearer' };
      const PreflightControllerWithMock = await esmock('../../src/controllers/preflight.js', {
        '../../src/support/utils.js': {
          ...utils,
          getCSPromiseToken: async () => mockPromiseToken,
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
          siteId: mockSite.getId(),
          type: 'preflight',
          promiseToken: mockPromiseToken,
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
          getCSPromiseToken: async () => { throw new utils.ErrorWithStatusCode('Missing Authorization header', 400); },
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
          getCSPromiseToken: async () => { throw new Error('Generic error'); },
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
});
