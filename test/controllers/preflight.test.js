/*
 * Copyright 2024 Adobe. All rights reserved.
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

  const preflightFunctions = [
    'createPreflightJob',
    'getPreflightJobStatusAndResult',
  ];

  const MOCK_JOB_ID = 'test-job-id';
  const MOCK_PAGE_URL = 'https://example.com';
  const MOCK_CREATED_AT = '2024-01-01T00:00:00.000Z';
  const MOCK_UPDATED_AT = '2024-01-01T00:01:00.000Z';
  const MOCK_STARTED_AT = '2024-01-01T00:00:01.000Z';
  const MOCK_ENDED_AT = '2024-01-01T00:02:00.000Z';
  const MOCK_RECORD_EXPIRES_AT = '2024-01-08T00:00:00.000Z';
  const MOCK_RESULT = { test: 'result' };
  const MOCK_ERROR = { message: 'test error' };
  const MOCK_QUEUE_URL = 'https://sqs.queue.url';

  let loggerStub;
  let asyncJobStub;
  let asyncJobCollectionStub;
  let sqsStub;
  let mockDataAccess;
  let preflightController;
  let context;
  let AsyncJobConstructorStub;
  let utilsStub;

  beforeEach(async () => {
    loggerStub = {
      info: sandbox.stub(),
      error: sandbox.stub(),
    };

    asyncJobStub = {
      getId: sandbox.stub().returns(MOCK_JOB_ID),
      getStatus: sandbox.stub().returns('IN_PROGRESS'),
      getCreatedAt: sandbox.stub().returns(MOCK_CREATED_AT),
      getUpdatedAt: sandbox.stub().returns(MOCK_UPDATED_AT),
      getStartedAt: sandbox.stub().returns(MOCK_STARTED_AT),
      getEndedAt: sandbox.stub().returns(MOCK_ENDED_AT),
      getRecordExpiresAt: sandbox.stub().returns(MOCK_RECORD_EXPIRES_AT),
      getResult: sandbox.stub().returns(MOCK_RESULT),
      getError: sandbox.stub().returns(MOCK_ERROR),
      setStatus: sandbox.stub(),
      setType: sandbox.stub(),
      setData: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    AsyncJobConstructorStub = sandbox.stub().returns(asyncJobStub);
    AsyncJobConstructorStub.Status = {
      IN_PROGRESS: 'IN_PROGRESS',
      COMPLETED: 'COMPLETED',
      FAILED: 'FAILED',
    };

    asyncJobCollectionStub = {
      findById: sandbox.stub().resolves(asyncJobStub),
    };

    sqsStub = {
      sendMessage: sandbox.stub().resolves(),
    };

    mockDataAccess = {
      AsyncJob: asyncJobCollectionStub,
    };

    utilsStub = {
      isNonEmptyObject: sandbox.stub().returns(true),
      isValidUrl: sandbox.stub().returns(true),
    };

    context = {
      data: { pageUrl: MOCK_PAGE_URL },
      func: { version: 'v1' },
      sqs: sqsStub,
      env: { AUDIT_WORKER_QUEUE_URL: MOCK_QUEUE_URL },
    };

    preflightController = PreflightController(
      mockDataAccess,
      loggerStub,
      context.env,
      utilsStub,
      AsyncJobConstructorStub,
    );
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    preflightFunctions.forEach((funcName) => {
      expect(preflightController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(preflightController).forEach((funcName) => {
      expect(preflightFunctions).to.include(funcName);
    });
  });

  it('throws an error if data access is not provided', () => {
    expect(() => PreflightController()).to.throw('Data access required');
  });

  it('throws an error if data access is not an object', () => {
    expect(() => PreflightController('not-an-object', loggerStub, context.env)).to.throw('Data access required');
  });

  it('throws an error if environment object is not provided', () => {
    expect(() => PreflightController(mockDataAccess)).to.throw('Environment object required');
  });

  it('throws an error if environment object is not an object', () => {
    expect(() => PreflightController(mockDataAccess, loggerStub, 'not-an-object')).to.throw('Environment object required');
  });

  describe('createPreflightJob', () => {
    it('should return 400 when request data is missing', async () => {
      utilsStub.isNonEmptyObject.returns(false);
      const response = await preflightController.createPreflightJob({ func: { version: 'v1' } });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Invalid request: missing application/json data');
      expect(loggerStub.error).to.have.been.calledWith('Failed to create preflight job: Invalid request: missing application/json data');
    });

    it('should return 400 when pageUrl is missing', async () => {
      const response = await preflightController.createPreflightJob({ data: {}, func: { version: 'v1' } });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Invalid request: missing pageUrl in request data');
      expect(loggerStub.error).to.have.been.calledWith('Failed to create preflight job: Invalid request: missing pageUrl in request data');
    });

    it('should return 400 when pageUrl is invalid', async () => {
      utilsStub.isValidUrl.returns(false);
      const response = await preflightController.createPreflightJob({ data: { pageUrl: 'invalid-url' }, func: { version: 'v1' } });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Invalid request: missing pageUrl in request data');
      expect(loggerStub.error).to.have.been.calledWith('Failed to create preflight job: Invalid request: missing pageUrl in request data');
    });

    it('should return 500 when AsyncJob constructor fails', async () => {
      AsyncJobConstructorStub.throws(new Error('Failed to create job'));
      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to create job');
    });

    it('should return 500 when setStatus fails', async () => {
      asyncJobStub.setStatus.throws(new Error('Failed to set status'));
      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to set status');
    });

    it('should return 500 when setType fails', async () => {
      asyncJobStub.setType.throws(new Error('Failed to set type'));
      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to set type');
    });

    it('should return 500 when setData fails', async () => {
      asyncJobStub.setData.throws(new Error('Failed to set data'));
      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to set data');
    });

    it('should return 500 when save fails', async () => {
      asyncJobStub.save.rejects(new Error('Failed to save job'));
      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to save job');
    });

    it('should return 500 when sending SQS message fails', async () => {
      const error = new Error('Failed to send SQS message');
      error.name = 'SQSError';

      delete context.sqs;

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.match(/Cannot read properties of undefined/);
      expect(loggerStub.error).to.have.been.calledWith(sinon.match(/Failed to create preflight job: Cannot read properties of undefined/));
      expect(asyncJobStub.setType).to.have.been.calledWith('preflight');
      expect(asyncJobStub.setData).to.have.been.calledWith({ pageUrl: MOCK_PAGE_URL });
      expect(asyncJobStub.setStatus).to.have.been.calledWith('IN_PROGRESS');
      expect(asyncJobStub.save).to.have.been.called;
    });

    it('should return 500 when an unexpected error occurs in createPreflightJob', async () => {
      delete context.sqs;
      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.match(/Cannot read properties of undefined/);
      expect(loggerStub.error).to.have.been.calledWith(sinon.match(/Failed to create preflight job: Cannot read properties of undefined/));
    });

    it('should return 500 when SQS message sending fails', async () => {
      sqsStub.sendMessage.throws(new Error('Failed to send SQS message'));
      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to send SQS message');
      expect(loggerStub.error).to.have.been.calledWith('Failed to create preflight job: Failed to send SQS message');
    });

    it('should return 500 when outer catch block is hit', async () => {
      const malformedContext = {
        data: { pageUrl: MOCK_PAGE_URL },
        func: { version: 'v1' },
        sqs: undefined,
      };
      const response = await preflightController.createPreflightJob(malformedContext);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Cannot read properties of undefined (reading \'sendMessage\')');
      expect(loggerStub.error).to.have.been.calledWith('Failed to create preflight job: Cannot read properties of undefined (reading \'sendMessage\')');
    });

    it('should successfully create a preflight job with valid input', async () => {
      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(202);
      const body = await response.json();
      expect(body).to.deep.include({
        jobId: MOCK_JOB_ID,
        status: 'IN_PROGRESS',
        createdAt: MOCK_CREATED_AT,
        pollUrl: 'https://spacecat.experiencecloud.live/api/v1/preflight/jobs/test-job-id',
      });
      expect(asyncJobStub.setType).to.have.been.calledWith('preflight');
      expect(asyncJobStub.setData).to.have.been.calledWith({ pageUrl: MOCK_PAGE_URL });
      expect(sqsStub.sendMessage).to.have.been.calledWith(
        MOCK_QUEUE_URL,
        {
          jobId: MOCK_JOB_ID,
          pageUrl: MOCK_PAGE_URL,
          type: 'preflight',
        },
      );
    });

    it('should use ci base URL when func.version is ci', async () => {
      const ciContext = { ...context, func: { version: 'ci' } };
      const response = await preflightController.createPreflightJob(ciContext);
      expect(response.status).to.equal(202);
      const body = await response.json();
      expect(body.pollUrl).to.equal('https://spacecat.experiencecloud.live/api/ci/preflight/jobs/test-job-id');
    });

    it('should return 500 when AsyncJob constructor throws an error', async () => {
      const error = new Error('AsyncJob constructor error');
      AsyncJobConstructorStub.throws(error);

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('AsyncJob constructor error');
      expect(loggerStub.error).to.have.been.calledWith('Failed to create preflight job: AsyncJob constructor error');

      AsyncJobConstructorStub.reset();
    });

    it('should return 500 when an error occurs after AsyncJob creation but before SQS message', async () => {
      const errorAsyncJob = {
        ...asyncJobStub,
        getId: sandbox.stub().throws(new Error('Failed to get job ID')),
      };
      AsyncJobConstructorStub.returns(errorAsyncJob);

      const response = await preflightController.createPreflightJob(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to get job ID');
      expect(loggerStub.error).to.have.been.calledWith('Failed to create preflight job: Failed to get job ID');

      AsyncJobConstructorStub.reset();
    });
  });

  describe('getPreflightJobStatusAndResult', () => {
    it('should return 400 when jobId is missing', async () => {
      const response = await preflightController.getPreflightJobStatusAndResult({ params: {} });
      expect(response.status).to.equal(400);
      const body = await response.json();
      expect(body.message).to.equal('Invalid request: missing jobId parameter');
    });

    it('should return 404 when job is not found', async () => {
      asyncJobCollectionStub.findById.resolves(null);
      const response = await preflightController.getPreflightJobStatusAndResult(
        { params: { jobId: 'non-existent' } },
      );
      expect(response.status).to.equal(404);
      const body = await response.json();
      expect(body.message).to.equal('Job not found');
    });

    it('should return 500 when findById fails', async () => {
      asyncJobCollectionStub.findById.rejects(new Error('Database error'));
      const response = await preflightController.getPreflightJobStatusAndResult(
        { params: { jobId: MOCK_JOB_ID } },
      );
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Database error');
    });

    it('should return 500 when a getter method fails', async () => {
      asyncJobStub.getStatus.throws(new Error('Failed to get status'));
      const response = await preflightController.getPreflightJobStatusAndResult(
        { params: { jobId: MOCK_JOB_ID } },
      );
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.equal('Failed to get status');
    });

    it('should return 500 when an unexpected error occurs in getPreflightJobStatusAndResult', async () => {
      // Force an error that will be caught by the outer catch block
      delete context.params;
      const response = await preflightController.getPreflightJobStatusAndResult(context);
      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.match(/Cannot destructure property/);
      expect(loggerStub.error).to.have.been.calledWith(sinon.match(/Failed to get preflight job: Cannot destructure property/));
    });

    it('should successfully return job status and result', async () => {
      const response = await preflightController.getPreflightJobStatusAndResult(
        { params: { jobId: MOCK_JOB_ID } },
      );
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.deep.equal({
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
  });
});
