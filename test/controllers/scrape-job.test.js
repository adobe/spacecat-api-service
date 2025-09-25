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

import { Response } from '@adobe/fetch';
import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import sinon, { stub } from 'sinon';

import { ScrapeJob, ScrapeUrl } from '@adobe/spacecat-shared-data-access';
import ScrapeJobSchema from '@adobe/spacecat-shared-data-access/src/models/scrape-job/scrape-job.schema.js';
import ScrapeUrlSchema from '@adobe/spacecat-shared-data-access/src/models/scrape-url/scrape-url.schema.js';
import ScrapeJobController from '../../src/controllers/scrapeJob.js';
import { ErrorWithStatusCode } from '../../src/support/utils.js';

use(sinonChai);
use(chaiAsPromised);

const createScrapeJob = (data) => (new ScrapeJob(
  {
    entities: {
      scrapeJob: {
        model: {
          schema: { attributes: { status: { type: 'string', get: (value) => value } } },
        },
        patch: sinon.stub().returns({ go: () => { }, set: () => { } }),
        remove: sinon.stub().returns({ go: () => { } }),
      },
    },
  },
  {
    log: console,
    getCollection: stub().returns({
      schema: ScrapeJobSchema,
      findById: stub(),
    }),
  },
  ScrapeJobSchema,
  data,
  console,
));

const createScrapeUrl = (data) => (new ScrapeUrl(
  { entities: { scrapeUrl: {} } },
  {
    log: console,
    getCollection: stub().returns({
      schema: ScrapeUrlSchema,
      findById: stub(),
    }),
  },
  ScrapeUrlSchema,
  data,
  console,
));

describe('ScrapeJobController tests', () => {
  let sandbox;
  let scrapeJobController;
  let baseContext;
  let mockSqsClient;
  let mockDataAccess;
  let scrapeJobConfiguration;
  let mockAuth;
  let mockAttributes;

  const defaultHeaders = {
    'user-agent': 'Unit test',
    'content-type': 'application/json',
  };

  const exampleCustomHeaders = {
    Authorization: 'Bearer aXsPb3183G',
  };

  const exampleJob = {
    scrapeJobId: 'f91afda0-afc8-467e-bfa3-fdbeba3037e8',
    status: 'RUNNING',
    options: {},
    baseURL: 'https://www.example.com',
    scrapeQueueId: 'spacecat-scrape-queue-1',
    processingType: 'form',
  };

  const urls = [
    'https://www.example.com/page1',
    'https://www.example.com/page2',
    'https://www.example.com/page3',
  ];

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockSqsClient = {
      sendMessage: sandbox.stub(),
      purgeQueue: sandbox.stub(),
      getQueueMessageCount: sandbox.stub(),
    };

    mockSqsClient.getQueueMessageCount.callsFake(async (queueUrl) => {
      if (queueUrl === 'spacecat-scrape-queue-1') {
        return Promise.resolve(2);
      }
      if (queueUrl === 'spacecat-scrape-queue-2') {
        return Promise.resolve(1);
      }
      if (queueUrl === 'spacecat-scrape-queue-3') {
        return Promise.resolve(4);
      }
      return Promise.resolve(0);
    });

    mockAttributes = {
      authInfo: {
        profile: {
          getName: () => 'Test User',
          getImsOrgId: () => 'TestOrgId',
          getImsUserId: () => 'TestUserId',
        },
      },
    };

    mockDataAccess = {
      ScrapeJob: {
        allByDateRange: sandbox.stub().resolves([]),
        allByStatus: sandbox.stub().resolves([]),
        create: (data) => createScrapeJob(data),
        findById: sandbox.stub(),
      },
      ScrapeUrl: {
        allByScrapeJobId: sandbox.stub().resolves([]),
        create: (data) => createScrapeUrl(data),
      },
    };

    mockDataAccess.ScrapeJob.findById.callsFake(async (jobId) => {
      if (jobId !== exampleJob.scrapeJobId) {
        throw new ErrorWithStatusCode('Not found', 404);
      }
      return createScrapeJob(exampleJob);
    });

    scrapeJobConfiguration = {
      queues: ['spacecat-scrape-queue-1', 'spacecat-scrape-queue-2', 'spacecat-scrape-queue-3'],
      scrapeWorkerQueue: 'https://sqs.us-east-1.amazonaws.com/1234567890/scrape-worker-queue',
      scrapeQueueUrlPrefix: 'https://sqs.us-east-1.amazonaws.com/1234567890/',
      s3Bucket: 's3-bucket',
      options: {
        enableJavascript: true,
        hideConsentBanners: false,
      },
      maxUrlsPerJob: 3,
    };

    const { info, debug, error } = console;

    // Set up the base context
    baseContext = {
      log: {
        info,
        debug,
        error: sandbox.stub().callsFake(error),
      },
      env: {
        SCRAPE_JOB_CONFIGURATION: JSON.stringify(scrapeJobConfiguration),
      },
      sqs: mockSqsClient,
      dataAccess: mockDataAccess,
      auth: mockAuth,
      attributes: mockAttributes,
      pathInfo: {
        headers: {
          ...defaultHeaders,
        },
      },
      params: {},
      data: {
        urls,
      },
    };

    scrapeJobController = ScrapeJobController(baseContext);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should fail for a bad SCRAPE_JOB_CONFIGURATION', () => {
    baseContext.env.SCRAPE_JOB_CONFIGURATION = 'not a JSON string';
    try {
      ScrapeJobController(baseContext);
    } catch (e) {
      expect(e.message).to.equal('Invalid scrape job configuration: Unexpected token \'o\', "not a JSON string" is not valid JSON');
    }
  });

  describe('createScrapeJob', () => {
    beforeEach(() => {
      scrapeJobController = ScrapeJobController(baseContext);
    });

    it('should fail for a non-multipart/form-data request', async () => {
      delete baseContext.data;
      const response = await scrapeJobController.createScrapeJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Failed to create a new scrape job: Invalid request: missing application/json request data');
    });

    it('should respond with an error code when the data format is incorrect', async () => {
      baseContext.data.urls = 'https://example.com/must/be/an/array';
      const response = await scrapeJobController.createScrapeJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Failed to create a new scrape job: Invalid request: urls must be provided as a non-empty array');
    });

    it('should respond with an error code when custom header is not an object', async () => {
      baseContext.data.customHeaders = JSON.stringify([42]);
      const response = await scrapeJobController.createScrapeJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Failed to create a new scrape job: Invalid request: customHeaders must be an object');
    });

    it('should reject when invalid URLs are passed in', async () => {
      baseContext.data.urls = ['https://example.com/page1', 'not-a-valid-url'];
      const response = await scrapeJobController.createScrapeJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Failed to create a new scrape job: Invalid request: not-a-valid-url is not a valid URL');
    });

    it('should reject when an invalid options object is provided', async () => {
      baseContext.data.options = 'options object should be an object, not a string';
      const response = await scrapeJobController.createScrapeJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Failed to create a new scrape job: Invalid request: options must be an object');
    });

    it('should reject when an non-object options param is provided', async () => {
      baseContext.data.urls = urls;
      baseContext.data.options = [12345, 42];
      const response = await scrapeJobController.createScrapeJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Failed to create a new scrape job: Invalid request: options must be an object');
    });

    it('should fail if sqs fails to send a message', async () => {
      baseContext.sqs.sendMessage = sandbox.stub().throws(new Error('Queue error'));
      const response = await scrapeJobController.createScrapeJob(baseContext);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Failed to create a new scrape job: Queue error');
    });

    it('should start a new scrape job', async () => {
      baseContext.data.customHeaders = {
        ...exampleCustomHeaders,
      };
      const response = await scrapeJobController.createScrapeJob(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(202);

      // Verify how many messages were sent to SQS
      // (we only send a single message now, instead of 1 per URL)
      expect(mockSqsClient.sendMessage).to.have.been.calledOnce;
      const firstCall = mockSqsClient.sendMessage.getCall(0);
      expect(firstCall.args[1].customHeaders).to.deep.equal({ Authorization: 'Bearer aXsPb3183G' });
    });

    it('should pick another scrape queue when the first one is in use', async () => {
      baseContext.dataAccess.getScrapeJobsByStatus = sandbox.stub().resolves([
        createScrapeJob({
          ...exampleJob,
        }),
      ]);
      const response = await scrapeJobController.createScrapeJob(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(202);

      // Verify how many messages were sent to SQS
      // (we only send a single message now, instead of 1 per URL)
      expect(mockSqsClient.sendMessage).to.have.been.calledOnce;

      // Check the resulting message to the scrape-worker-queue
      const firstCall = mockSqsClient.sendMessage.getCall(0);
      expect(firstCall.args[1].batch.length).to.equal(3);
      expect(firstCall.args[0]).to.equal('https://sqs.us-east-1.amazonaws.com/1234567890/scrape-worker-queue');
    });

    it('should pick up the default options when none are provided', async () => {
      baseContext.env.SCRAPE_JOB_CONFIGURATION = JSON.stringify(scrapeJobConfiguration);
      baseContext.data.customHeaders = exampleCustomHeaders;
      const response = await scrapeJobController.createScrapeJob(baseContext);
      const scrapeJob = await response.json();

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(202);

      expect(scrapeJob.options).to.deep.equal({
        enableJavascript: true,
        hideConsentBanners: false,
      });
    });

    it('should fail when the number of URLs exceeds the maximum allowed', async () => {
      baseContext.data.urls = [
        'https://example.com/page1',
        'https://example.com/page2',
        'https://example.com/page3',
        'https://example.com/page4',
      ];
      const response = await scrapeJobController.createScrapeJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Failed to create a new scrape job: Invalid request: number of URLs provided (4) exceeds the maximum allowed (3)');
    });

    it('should fail when the number of URLs exceeds the (default) maximum allowed', async () => {
      delete scrapeJobConfiguration.maxUrlsPerJob; // Should fall back to 1
      baseContext.env.SCRAPE_JOB_CONFIGURATION = JSON.stringify(scrapeJobConfiguration);
      baseContext.data.urls = [
        'https://example.com/page1',
        'https://example.com/page2',
      ];
      scrapeJobController = ScrapeJobController(baseContext);
      const response = await scrapeJobController.createScrapeJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Failed to create a new scrape job: Invalid request: number of URLs provided (2) exceeds the maximum allowed (1)');
    });

    it('should fail when URLs are empty', async () => {
      baseContext.data.urls = [];
      const response = await scrapeJobController.createScrapeJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Failed to create a new scrape job: Invalid request: urls must be provided as a non-empty array');
    });
  });

  describe('getScrapeJobUrlResults', () => {
    it('should respond with an expected progress response', async () => {
      baseContext.dataAccess.getScrapeJobUrlResults = sandbox.stub().resolves([
        createScrapeJob({
          ...exampleJob,
        }),
      ]);

      // only need to provide enough scrape url data to satisfy the scrape-supervisor, no need
      // for all the other properties of a ImportUrl object.
      baseContext.dataAccess.ScrapeUrl.allByScrapeJobId = sandbox.stub().resolves([
        {
          getStatus: () => ScrapeJob.ScrapeUrlStatus.COMPLETE,
          getPath: () => 'path/to/result1',
          getUrl: () => 'https://example.com/page1',
          getReason: () => null,
        },
        {
          getStatus: () => ScrapeJob.ScrapeUrlStatus.COMPLETE,
          getPath: () => 'path/to/result2',
          getUrl: () => 'https://example.com/page2',
          getReason: () => null,
        },
        {
          getStatus: () => ScrapeJob.ScrapeUrlStatus.RUNNING,
          getPath: () => 'path/to/result3',
          getUrl: () => 'https://example.com/page3',
          getReason: () => null,
        },
        {
          getStatus: () => ScrapeJob.ScrapeUrlStatus.PENDING,
          getPath: () => 'path/to/result5',
          getUrl: () => 'https://example.com/page5',
          getReason: () => null,
        },
        {
          getStatus: () => ScrapeJob.ScrapeUrlStatus.REDIRECT,
          getPath: () => 'path/to/result6',
          getUrl: () => 'https://example.com/page6',
          getReason: () => null,
        },
        {
          getStatus: () => ScrapeJob.ScrapeUrlStatus.FAILED,
          getPath: () => 'path/to/result7',
          getUrl: () => 'https://example.com/page7',
          getReason: () => 'An error occurred',
        },
      ]);

      baseContext.params.jobId = exampleJob.scrapeJobId;
      scrapeJobController = ScrapeJobController(baseContext);
      const response = await scrapeJobController.getScrapeJobUrlResults(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      const results = await response.json();
      expect(results).to.deep.equal({
        jobId: exampleJob.scrapeJobId,
        results: [
          {
            url: 'https://example.com/page1',
            status: 'COMPLETE',
            reason: null,
            path: 'path/to/result1',
          },
          {
            url: 'https://example.com/page2',
            status: 'COMPLETE',
            reason: null,
            path: 'path/to/result2',
          },
          {
            url: 'https://example.com/page3',
            status: 'RUNNING',
            reason: null,
            path: 'path/to/result3',
          },
          {
            url: 'https://example.com/page5',
            status: 'PENDING',
            reason: null,
            path: 'path/to/result5',
          },
          {
            url: 'https://example.com/page6',
            status: 'REDIRECT',
            reason: null,
            path: 'path/to/result6',
          },
          {
            url: 'https://example.com/page7',
            status: 'FAILED',
            reason: 'An error occurred',
            path: 'path/to/result7',
          },
        ],
      });
    });

    it('should respond a job not found for non existent jobs', async () => {
      baseContext.dataAccess.getScrapeJobByID = sandbox.stub().resolves(null);
      baseContext.params.jobId = '3ec88567-c9f8-4fb1-8361-b53985a2898b'; // non existent job

      scrapeJobController = ScrapeJobController(baseContext);
      const response = await scrapeJobController.getScrapeJobUrlResults(baseContext);
      expect(response.status).to.equal(404);
    });

    it('should return default values when no scrape urls are available', async () => {
      baseContext.dataAccess.getScrapeJobProgress = sandbox.stub().resolves([
        createScrapeJob({ ...exampleJob }),
      ]);

      baseContext.params.jobId = exampleJob.scrapeJobId;
      scrapeJobController = ScrapeJobController(baseContext);

      const response = await scrapeJobController.getScrapeJobUrlResults(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);

      expect(await response.json()).to.deep.equal({
        jobId: exampleJob.scrapeJobId,
        results: [],
      });
    });

    it('should handle errors while trying to fetch scrape job url results gracefully', async () => {
      baseContext.dataAccess.ScrapeUrl.allByScrapeJobId = sandbox.stub().rejects(new Error('Failed to fetch scrape job url results'));
      baseContext.params.jobId = exampleJob.scrapeJobId;
      const response = await scrapeJobController.getScrapeJobUrlResults(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Failed to fetch the scrape job result: Failed to fetch scrape job url results');
    });
  });

  describe('getScrapeJobStatus', () => {
    it('should fail when jobId is not provided', async () => {
      const response = await scrapeJobController.getScrapeJobStatus(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Job ID is required');
    });

    it('should return 404 when the jobID cannot be found', async () => {
      baseContext.params.jobId = '3ec88567-c9f8-4fb1-8361-b53985a2898b'; // non existent job
      const response = await scrapeJobController.getScrapeJobStatus(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Error: Failed to fetch scrape job status for jobId: 3ec88567-c9f8-4fb1-8361-b53985a2898b, message: Not found');
    });

    it('should return job details for a valid jobId', async () => {
      baseContext.params.jobId = exampleJob.scrapeJobId;
      const response = await scrapeJobController.getScrapeJobStatus(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      const jobStatus = await response.json();
      expect(jobStatus.id).to.equal('f91afda0-afc8-467e-bfa3-fdbeba3037e8');
      expect(jobStatus.baseURL).to.equal('https://www.example.com');
      expect(jobStatus.status).to.equal('RUNNING');
      expect(jobStatus.options).to.deep.equal({});
    });

    it('should handle errors while trying to fetch scrape job status gracefully', async () => {
      baseContext.dataAccess.ScrapeJob.findById = sandbox.stub().rejects(new Error('Failed to fetch scrape job status'));
      baseContext.params.jobId = exampleJob.scrapeJobId;
      const response = await scrapeJobController.getScrapeJobStatus(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Failed to fetch scrape job status for jobId: f91afda0-afc8-467e-bfa3-fdbeba3037e8, message: Failed to fetch scrape job status');
    });
  });

  describe('getScrapeJobsByDateRange', () => {
    it('should throw an error when startDate is not present', async () => {
      baseContext.params.endDate = '2024-05-29T14:26:00.000Z';
      const response = await scrapeJobController.getScrapeJobsByDateRange(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Invalid request: startDate and endDate must be in ISO 8601 format');
    });

    it('should throw an error when endDate is not present', async () => {
      baseContext.params.startDate = '2024-05-29T14:26:00.000Z';
      const response = await scrapeJobController.getScrapeJobsByDateRange(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Error: Invalid request: startDate and endDate must be in ISO 8601 format');
    });

    it('should return an array of scrape jobs', async () => {
      const job = createScrapeJob(exampleJob);
      baseContext.dataAccess.ScrapeJob.allByDateRange = sandbox.stub().resolves([job]);
      baseContext.params.startDate = '2022-10-05T14:48:00.000Z';
      baseContext.params.endDate = '2022-10-07T14:48:00.000Z';

      const response = await scrapeJobController.getScrapeJobsByDateRange(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      const responseResult = await response.json();
      expect(responseResult[0].baseURL).to.equal('https://www.example.com');
    });

    it('should handle errors while trying to fetch scrape jobs by date range gracefully', async () => {
      baseContext.dataAccess.ScrapeJob.allByDateRange = sandbox.stub().rejects(new Error('Failed to fetch scrape jobs by date range'));
      baseContext.params.startDate = '2022-10-05T14:48:00.000Z';
      baseContext.params.endDate = '2022-10-07T14:48:00.000Z';

      const response = await scrapeJobController.getScrapeJobsByDateRange(baseContext);
      expect(response).to.be.instanceOf(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Failed to fetch scrape jobs between startDate: 2022-10-05T14:48:00.000Z and endDate: 2022-10-07T14:48:00.000Z, Failed to fetch scrape jobs by date range');
    });
  });

  describe('ScrapeJobSupervisor', () => {
    it('should fail to validate the required services, if one is missing', async () => {
      const context = {
        ...baseContext,
        dataAccess: undefined,
      };
      expect(() => ScrapeJobController(context)).to.throw('Invalid services: dataAccess is required');
    });
  });

  describe('getScrapeJobsByBaseURL', () => {
    it('should return an array of scrape jobs', async () => {
      const job = createScrapeJob(exampleJob);
      baseContext.dataAccess.ScrapeJob.allByBaseURL = sandbox.stub().resolves([job]);
      baseContext.params.baseURL = 'aHR0cHM6Ly93d3cuZXhhbXBsZS5jb20=';

      const response = await scrapeJobController.getScrapeJobsByBaseURL(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      const responseResult = await response.json();
      expect(responseResult[0].baseURL).to.equal('https://www.example.com');
    });

    it('should return an array of scrape jobs for baseUrl and processingType', async () => {
      const job = createScrapeJob(exampleJob);
      baseContext.dataAccess.ScrapeJob.allByBaseURLAndProcessingType = sandbox
        .stub()
        .resolves([job]);
      baseContext.params.baseURL = 'aHR0cHM6Ly93d3cuZXhhbXBsZS5jb20=';
      baseContext.params.processingType = 'form';

      const response = await scrapeJobController.getScrapeJobsByBaseURL(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      const responseResult = await response.json();
      expect(responseResult[0].baseURL).to.equal('https://www.example.com');
    });

    it('should return an empty array if no jobs are found for this baseUrl', async () => {
      baseContext.dataAccess.ScrapeJob.allByBaseURL = sandbox.stub().resolves([]);
      baseContext.params.baseURL = 'aHR0cHM6Ly93d3cuZXhhbXBsZS5jb20=';

      const response = await scrapeJobController.getScrapeJobsByBaseURL(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      const responseResult = await response.json();
      expect(responseResult).to.deep.equal([]);
    });

    it('should handle errors while trying to fetch scrape jobs by baseURL gracefully', async () => {
      baseContext.dataAccess.ScrapeJob.allByBaseURL = sandbox.stub().rejects(new Error('Failed to fetch scrape jobs by baseURL'));
      baseContext.params.baseURL = 'aHR0cHM6Ly93d3cuZXhhbXBsZS5jb20=';

      const response = await scrapeJobController.getScrapeJobsByBaseURL(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Failed to fetch scrape jobs by baseURL: https://www.example.com, Failed to fetch scrape jobs by baseURL');
    });

    it('should handle invalid baseURL gracefully', async () => {
      baseContext.params.baseURL = 'invalid-baseURL';
      const response = await scrapeJobController.getScrapeJobsByBaseURL(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: baseURL must be a valid URL');
    });

    it('should handle errors when no baseUrl is provided', async () => {
      baseContext.params.baseURL = '';
      const response = await scrapeJobController.getScrapeJobsByBaseURL(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Base URL required');
    });
  });
});
