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
    ScrapeJobController(baseContext);
    expect(baseContext.log.error.getCall(0).args[0]).to.equal('Failed to parse scrape job configuration: Unexpected token \'o\', "not a JSON string" is not valid JSON');
  });

  describe('createScrapeJob', () => {
    beforeEach(() => {
      scrapeJobController = ScrapeJobController(baseContext);
    });

    it('should fail for a non-multipart/form-data request', async () => {
      delete baseContext.data;
      const response = await scrapeJobController.createScrapeJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: missing application/json request data');
    });

    it('should fail if processingType is provided but invalid', async () => {
      baseContext.data.processingType = 'invalid';
      const response = await scrapeJobController.createScrapeJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.match(/^Invalid request: processingType must be either/);
    });

    it('should respond with an error code when the data format is incorrect', async () => {
      baseContext.data.urls = 'https://example.com/must/be/an/array';
      const response = await scrapeJobController.createScrapeJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: urls must be provided as a non-empty array');
    });

    it('should respond with an error code when custom header is not an object', async () => {
      baseContext.data.customHeaders = JSON.stringify([42]);
      const response = await scrapeJobController.createScrapeJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: customHeaders must be an object');
    });

    it('should reject when no scrape queues are defined', async () => {
      delete scrapeJobConfiguration.queues;
      baseContext.env.SCRAPE_JOB_CONFIGURATION = JSON.stringify(scrapeJobConfiguration);

      const scrapeJobControllerNoQueues = ScrapeJobController(baseContext);
      const response = await scrapeJobControllerNoQueues.createScrapeJob(baseContext);
      expect(response.status).to.equal(503);
      expect(response.headers.get('x-error')).to.equal('Service Unavailable: No scrape queue available');
    });

    it('correctly returns queue with least messages', async () => {
      scrapeJobConfiguration.queues = ['spacecat-scrape-queue-1', 'spacecat-scrape-queue-2'];
      baseContext.env.SCRAPE_JOB_CONFIGURATION = JSON.stringify(scrapeJobConfiguration);
      baseContext.log.info = sandbox.stub();
      const testScrapeJobController = ScrapeJobController(baseContext);
      const response = await testScrapeJobController.createScrapeJob(baseContext);
      expect(response.status).to.equal(202);
      expect(baseContext.log.info.getCalls()[1].args[0]).to.equal('Queue with least messages: spacecat-scrape-queue-2');

      scrapeJobConfiguration.queues = ['spacecat-scrape-queue-1', 'spacecat-scrape-queue-3'];
      baseContext.log.info = sandbox.stub();
      baseContext.env.SCRAPE_JOB_CONFIGURATION = JSON.stringify(scrapeJobConfiguration);
      const testScrapeJobController2 = ScrapeJobController(baseContext);
      const response2 = await testScrapeJobController2.createScrapeJob(baseContext);
      expect(response2.status).to.equal(202);
      expect(baseContext.log.info.getCalls()[1].args[0]).to.equal('Queue with least messages: spacecat-scrape-queue-1');
    });

    it('should reject when invalid URLs are passed in', async () => {
      baseContext.data.urls = ['https://example.com/page1', 'not-a-valid-url'];
      const response = await scrapeJobController.createScrapeJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: not-a-valid-url is not a valid URL');
    });

    it('should reject when an invalid options object is provided', async () => {
      baseContext.data.options = 'options object should be an object, not a string';
      const response = await scrapeJobController.createScrapeJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: options must be an object');
    });

    it('should reject when an non-object options param is provided', async () => {
      baseContext.data.urls = urls;
      baseContext.data.options = [12345, 42];
      const response = await scrapeJobController.createScrapeJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: options must be an object');
    });

    it('should fail if sqs fails to send a message', async () => {
      baseContext.sqs.sendMessage = sandbox.stub().throws(new Error('Queue error'));
      const response = await scrapeJobController.createScrapeJob(baseContext);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Queue error');
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
      expect(firstCall.args[1].urls.length).to.equal(3);
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
      expect(response.headers.get('x-error')).to.equal('Invalid request: number of URLs provided (4) exceeds the maximum allowed (3)');
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
      expect(response.headers.get('x-error')).to.equal('Invalid request: number of URLs provided (2) exceeds the maximum allowed (1)');
    });

    it('should fail when URLs are empty', async () => {
      baseContext.data.urls = [];
      const response = await scrapeJobController.createScrapeJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: urls must be provided as a non-empty array');
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

      expect(response).to.be.an.instanceOf(Response);
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

      const results = await response.json();
      expect(results).to.deep.equal({
        jobId: exampleJob.scrapeJobId,
        results: [],
      });
    });
  });

  describe('getScrapeJobStatus', () => {
    it('should fail when jobId is not provided', async () => {
      const response = await scrapeJobController.getScrapeJobStatus(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Job ID is required');
    });

    it('should return 404 when the jobID cannot be found', async () => {
      baseContext.params.jobId = '3ec88567-c9f8-4fb1-8361-b53985a2898b'; // non existent job
      const response = await scrapeJobController.getScrapeJobStatus(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Not found');
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
  });

  describe('getScrapeJobsByDateRange', () => {
    it('should throw an error when startDate is not present', async () => {
      baseContext.params.endDate = '2024-05-29T14:26:00.000Z';
      const response = await scrapeJobController.getScrapeJobsByDateRange(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: startDate and endDate must be in ISO 8601 format');
    });

    it('should throw an error when endDate is not present', async () => {
      baseContext.params.startDate = '2024-05-29T14:26:00.000Z';
      const response = await scrapeJobController.getScrapeJobsByDateRange(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: startDate and endDate must be in ISO 8601 format');
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
});
