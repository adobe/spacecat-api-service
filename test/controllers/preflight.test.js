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

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import PreflightController from '../../src/controllers/preflight.js';

use(chaiAsPromised);
use(sinonChai);

describe('Preflight Controller', () => {
  const sandbox = sinon.createSandbox();

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
  };

  const MOCK_JOB_ID = '9d222c6d-893e-4e79-8201-3c9ca16a0f39';
  const MOCK_CREATED_AT = '2019-08-24T14:15:22Z';
  const MOCK_UPDATED_AT = '2019-08-24T14:15:22Z';
  const MOCK_STARTED_AT = '2019-08-24T14:15:22Z';
  const MOCK_ENDED_AT = '2019-08-24T14:15:22Z';
  const MOCK_RECORD_EXPIRES_AT = 0;
  const MOCK_RESULT = {
    audits: [
      {
        name: 'metatags',
        type: 'seo',
        opportunities: [
          {
            tagName: 'description',
            tagContent: 'Enjoy.',
            issue: 'Description too short',
            issueDetails: '94 chars below limit',
            seoImpact: 'Moderate',
            seoRecommendation: '140-160 characters long',
            aiSuggestion: 'Enjoy the best of Adobe Creative Cloud.',
            aiRationale: "Short descriptions can be less informative and may not attract users' attention.",
          },
          {
            tagName: 'title',
            tagContent: 'Adobe',
            issue: 'Title too short',
            issueDetails: '20 chars below limit',
            seoImpact: 'Moderate',
            seoRecommendation: '40-60 characters long',
            aiSuggestion: 'Adobe Creative Cloud: Your All-in-One Solution',
            aiRationale: "Short titles can be less informative and may not attract users' attention.",
          },
        ],
      },
      {
        name: 'canonical',
        type: 'seo',
        opportunities: [
          {
            check: 'canonical-url-4xx',
            explanation: 'The canonical URL returns a 4xx error, indicating it is inaccessible, which can harm SEO visibility.',
          },
        ],
      },
    ],
  };
  const MOCK_ERROR = {
    code: 'string',
    message: 'string',
    details: {},
  };

  class MockAsyncJob {
    constructor() {
      this.id = MOCK_JOB_ID;
      this.status = 'IN_PROGRESS';
      this.createdAt = MOCK_CREATED_AT;
      this.updatedAt = MOCK_UPDATED_AT;
      this.startedAt = MOCK_STARTED_AT;
      this.endedAt = MOCK_ENDED_AT;
      this.recordExpiresAt = MOCK_RECORD_EXPIRES_AT;
      this.result = MOCK_RESULT;
      this.error = MOCK_ERROR;
      this.data = {};
      this.type = null;
    }

    getId() {
      return this.id;
    }

    getStatus() {
      return this.status;
    }

    getCreatedAt() {
      return this.createdAt;
    }

    getUpdatedAt() {
      return this.updatedAt;
    }

    getStartedAt() {
      return this.startedAt;
    }

    getEndedAt() {
      return this.endedAt;
    }

    getRecordExpiresAt() {
      return this.recordExpiresAt;
    }

    getResult() {
      return this.result;
    }

    getError() {
      return this.error;
    }

    static getEntityName() {
      return 'AsyncJob';
    }

    setStatus(status) {
      this.status = status;
    }

    setType(type) {
      this.type = type;
    }

    setData(data) {
      this.data = data;
    }
  }

  let preflightController;
  let mockAsyncJob;
  let mockAsyncJobInstance;

  const createTestContext = ({
    data = {},
    params = {},
    func = { version: 'ci' },
    sqs = { sendMessage: sandbox.stub().resolves() },
    dataAccess = { AsyncJob: mockAsyncJob },
  } = {}) => ({
    data,
    params,
    func,
    sqs,
    dataAccess,
  });

  beforeEach(() => {
    mockAsyncJobInstance = new MockAsyncJob();
    mockAsyncJob = {
      findById: sandbox.stub().resolves(mockAsyncJobInstance),
      save: sandbox.stub().resolves(mockAsyncJobInstance),
      create: sandbox.stub().returns(mockAsyncJobInstance),
    };

    MockAsyncJob.Status = {
      IN_PROGRESS: 'IN_PROGRESS',
    };

    preflightController = PreflightController(
      {
        dataAccess: {
          AsyncJob: mockAsyncJob,
        },
      },
      loggerStub,
      { AUDIT_WORKER_QUEUE_URL: 'test' },
    );
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws an error if context is not an object', () => {
    expect(() => PreflightController(null, loggerStub, { test: 'env' })).to.throw('Context required');
  });

  it('throws an error if dataAccess is not an object', () => {
    const context = { dataAccess: null };
    const preflightControllerWithNullDataAccess = PreflightController(context, loggerStub, { test: 'env' });
    return expect(preflightControllerWithNullDataAccess.createPreflightJob({ data: {} })).to.be.rejectedWith('Data access required');
  });

  it('throws an error if env is not object', () => {
    expect(() => PreflightController({ dataAccess: { AsyncJob: mockAsyncJob } }, loggerStub, null)).to.throw('Environment object required');
  });

  describe('createPreflightJob', () => {
    it('creates a preflight job successfully', async () => {
      const url = 'https://example.com';
      const context = createTestContext({
        data: { pageUrl: url },
      });

      const response = await preflightController.createPreflightJob(context);
      expect(loggerStub.info).to.have.been.calledWith(`Creating preflight job for pageUrl: ${url}`);
      expect(response.status).to.equal(202);

      const jobResult = await response.json();
      expect(jobResult).to.deep.equal({
        jobId: MOCK_JOB_ID,
        status: 'IN_PROGRESS',
        createdAt: MOCK_CREATED_AT,
        pollUrl: 'https://spacecat.experiencecloud.live/api/ci/preflight/jobs/9d222c6d-893e-4e79-8201-3c9ca16a0f39',
      });

      expect(context.sqs.sendMessage).to.have.been.calledWith(
        'test',
        {
          jobId: MOCK_JOB_ID,
          urls: [{ url }],
          type: 'preflight',
        },
      );
    });

    it('returns correct pollUrl for non-ci version', async () => {
      const url = 'https://example.com';
      const context = createTestContext({
        data: { pageUrl: url },
        func: { version: 'v1' },
      });

      const response = await preflightController.createPreflightJob(context);
      expect(loggerStub.info).to.have.been.calledWith(`Creating preflight job for pageUrl: ${url}`);
      expect(response.status).to.equal(202);

      const jobResult = await response.json();
      expect(jobResult).to.deep.equal({
        jobId: MOCK_JOB_ID,
        status: 'IN_PROGRESS',
        createdAt: MOCK_CREATED_AT,
        pollUrl: 'https://spacecat.experiencecloud.live/api/v1/preflight/jobs/9d222c6d-893e-4e79-8201-3c9ca16a0f39',
      });
    });

    it('returns bad request for missing request data', async () => {
      const context = createTestContext({
        data: null,
      });

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: 'Invalid request: missing application/json in request data' } });
    });

    it('returns bad request for missing pageUrl in request data', async () => {
      const context = createTestContext({
        data: {},
      });

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: 'Invalid request: missing application/json in request data' } });
    });

    it('returns bad request for invalid pageUrl format', async () => {
      const context = createTestContext({
        data: { pageUrl: 'invalid-url' },
      });

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: 'Invalid request: invalid pageUrl format' } });
    });

    it('handles SQS send message error', async () => {
      const url = 'https://example.com';
      const context = createTestContext({
        data: { pageUrl: url },
        sqs: { sendMessage: sandbox.stub().rejects(new Error('SQS error')) },
      });

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: 'SQS error' } });
    });

    it('handles AsyncJob.save() error', async () => {
      const url = 'https://example.com';
      mockAsyncJob.save.rejects(new Error('Save error'));
      const context = createTestContext({
        data: { pageUrl: url },
      });

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: 'Save error' } });
    });

    it('handles AsyncJob.create() error', async () => {
      const url = 'https://example.com';
      mockAsyncJob.create.throws(new Error('Create error'));
      const context = createTestContext({
        data: { pageUrl: url },
      });

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: 'Create error' } });
    });

    it('handles missing dataAccess in createPreflightJob', async () => {
      const context = createTestContext({ dataAccess: null });
      await expect(preflightController.createPreflightJob(context)).to.be.rejectedWith('Data access required');
    });

    it('should hit final catch in createPreflightJob due to unexpected error outside inner blocks', async () => {
      const mockAsyncJobRepo = {
        create: () => ({
          setStatus: () => {},
          setType: () => {},
          setData: () => {},
          getId: () => 'abc-123',
        }),
        save: async () => {},
      };

      const controller = PreflightController(
        { dataAccess: { AsyncJob: mockAsyncJobRepo } },
        loggerStub,
        { AUDIT_WORKER_QUEUE_URL: 'test' },
      );

      const context = {
        data: { pageUrl: 'https://example.com' },
        func: null,
        sqs: { sendMessage: sinon.stub().resolves() },
        dataAccess: { AsyncJob: mockAsyncJobRepo },
      };

      const response = await controller.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: "Cannot read properties of null (reading 'version')" } });
    });

    it('should return 400 when pageUrl is empty string', async () => {
      const context = {
        data: { pageUrl: '' },
        func: { version: 'ci' },
        sqs: { sendMessage: sinon.stub().resolves() },
        dataAccess: {
          AsyncJob: {
            create: () => ({}),
            save: async () => {},
          },
        },
      };

      const controller = PreflightController(context, loggerStub, { AUDIT_WORKER_QUEUE_URL: 'test' });
      const response = await controller.createPreflightJob(context);
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: 'Invalid request: missing pageUrl in request data' } });
    });
  });

  describe('getPreflightJobStatusAndResult', () => {
    it('returns job status and result successfully', async () => {
      const context = createTestContext({
        params: { jobId: MOCK_JOB_ID },
      });

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.deep.equal({
        jobId: MOCK_JOB_ID,
        status: 'IN_PROGRESS',
        createdAt: MOCK_CREATED_AT,
        updatedAt: MOCK_UPDATED_AT,
        startedAt: MOCK_STARTED_AT,
        endedAt: MOCK_ENDED_AT,
        recordExpiresAt: MOCK_RECORD_EXPIRES_AT,
        result: MOCK_RESULT,
        error: MOCK_ERROR,
      });
    });

    it('returns 404 for non-existent job', async () => {
      mockAsyncJob.findById.resolves(null);
      const context = createTestContext({
        params: { jobId: MOCK_JOB_ID },
      });

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(404);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: `Job with ID ${MOCK_JOB_ID} not found` } });
    });

    it('returns 400 for invalid jobId', async () => {
      const context = createTestContext({
        params: { jobId: 'invalid-id' },
      });

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(400);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: 'Invalid jobId' } });
    });

    it('handles database error', async () => {
      mockAsyncJob.findById.rejects(new Error('Database error'));
      const context = createTestContext({
        params: { jobId: MOCK_JOB_ID },
      });

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: 'Database error' } });
    });

    it('handles missing dataAccess in getPreflightJobStatusAndResult', async () => {
      const context = createTestContext({ dataAccess: null });
      await expect(preflightController.getPreflightJobStatusAndResult(context)).to.be.rejectedWith('Data access required');
    });

    it('handles response creation error', async () => {
      const circularJob = new MockAsyncJob();
      circularJob.result = { circular: circularJob };
      mockAsyncJob.findById.resolves(circularJob);
      const context = createTestContext({
        params: { jobId: MOCK_JOB_ID },
      });

      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result).to.deep.equal({
        message: {
          message: "Converting circular structure to JSON\n    --> starting at object with constructor 'Object'\n    |     property 'circular' -> object with constructor 'MockAsyncJob'\n    --- property 'result' closes the circle",
        },
      });
    });

    it('should hit final catch in getPreflightJobStatusAndResult due to broken context structure', async () => {
      const context = {
        dataAccess: { AsyncJob: mockAsyncJob },
      };

      const controller = PreflightController(context, loggerStub, { AUDIT_WORKER_QUEUE_URL: 'test' });
      const response = await controller.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(500);
      const result = await response.json();
      expect(result).to.deep.equal({ message: { message: "Cannot destructure property 'jobId' of 'params' as it is undefined." } });
    });
  });
});
