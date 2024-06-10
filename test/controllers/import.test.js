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

import chai, { expect } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { createImportJob } from '@adobe/spacecat-shared-data-access/src/models/importer/import-job.js';
import { createImportUrl } from '@adobe/spacecat-shared-data-access/src/models/importer/import-url.js';
import ImportController from '../../src/controllers/import.js';
import { ErrorWithStatusCode } from '../../src/support/utils.js';

chai.use(sinonChai);
chai.use(chaiAsPromised);

describe('ImportController tests', () => {
  let sandbox;
  let importController;
  let context;
  let requestContext = {};
  let mockSqsClient;
  let mockDataAccess;
  let mockS3;
  let importConfiguration;

  const exampleJob = {
    id: 'f91afda0-afc8-467e-bfa3-fdbeba3037e8',
    status: 'RUNNING',
    options: {},
    baseURL: 'https://www.example.com',
    apiKey: 'b9ebcfb5-80c9-4236-91ba-d50e361db71d',
    importQueueId: 'spacecat-import-queue-1',
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockSqsClient = {
      sendMessage: sandbox.stub(),
    };

    requestContext = {
      data: {
        urls: [],
      },
      params: {
      },
      pathInfo: {
        headers: {
          'x-import-api-key': 'b9ebcfb5-80c9-4236-91ba-d50e361db71d',
        },
      },
    };

    mockDataAccess = {
      getImportJobsByStatus: sandbox.stub().resolves([]), // Simulate no running jobs
      createNewImportJob: (data) => createImportJob(data),
      createNewImportUrl: (data) => createImportUrl(data),
      getImportJobByID: sandbox.stub(),
    };

    mockDataAccess.getImportJobByID.callsFake(async (jobId) => {
      if (jobId !== exampleJob.id) {
        throw new ErrorWithStatusCode('Not found', 404);
      }
      return createImportJob(exampleJob);
    });

    mockS3 = {
      s3Client: {
        send: sandbox.stub(),
        getObject: sandbox.stub(),
      },
      GetObjectCommand: sandbox.stub(),
      getSignedUrl: sandbox.stub(),
    };

    mockS3.getSignedUrl.callsFake(async () => 'https://example-bucket.s3.amazonaws.com/file-key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=EXAMPLE_ACCESS_KEY_ID%2F20240603%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20240603T123456Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abcdef1234567890');

    importConfiguration = {
      allowedApiKeys: ['b9ebcfb5-80c9-4236-91ba-d50e361db71d', '7828b114-e20f-4234-bc4e-5b438b861edd'],
      queues: ['spacecat-import-queue-1', 'spacecat-import-queue-2'],
      queueUrlPrefix: 'https://sqs.us-east-1.amazonaws.com/1234567890/',
    };

    context = {
      log: console,
      env: {
        IMPORT_CONFIGURATION: JSON.stringify(importConfiguration),
      },
      sqs: mockSqsClient,
      s3: mockS3,
      dataAccess: mockDataAccess,
    };

    importController = ImportController(context);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('createImportJob', () => {
    beforeEach(() => {
      // Prepare the new import job request
      requestContext.data = {
        urls: ['https://example.com/page1', 'https://example.com/page2', 'https://example.com/page3'],
        options: {
          enableJavaScript: 'true',
        },
      };
    });

    it('should respond with an error code when the request is missing data', async () => {
      delete requestContext.data;
      const response = await importController.createImportJob(requestContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: request body data is required');
    });

    it('should respond with an error code when the data format is incorrect', async () => {
      requestContext.data.urls = 'https://example.com/must/be/an/array';
      const response = await importController.createImportJob(requestContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: urls must be provided as a non-empty array');
    });

    it('should reject an invalid import API key', async () => {
      requestContext.pathInfo.headers['x-import-api-key'] = 'unknown-api-key';
      const response = await importController.createImportJob(requestContext);

      expect(response.status).to.equal(401); // Unauthorized
      expect(response.headers.get('x-error')).to.equal('Invalid import API key');
    });

    it('should reject when no allowed API keys are defined', async () => {
      const contextNoApiKeys = { ...context };
      delete importConfiguration.allowedApiKeys;
      contextNoApiKeys.env.IMPORT_CONFIGURATION = JSON.stringify(importConfiguration);

      const importControllerNoApiKeys = new ImportController(contextNoApiKeys);
      const response = await importControllerNoApiKeys.createImportJob(requestContext);
      expect(response.status).to.equal(401); // Unauthorized
      expect(response.headers.get('x-error')).to.equal('Invalid import API key');
    });

    it('should reject when no import queues are defined', async () => {
      const contextNoQueues = { ...context };
      delete importConfiguration.queues;
      contextNoQueues.env.IMPORT_CONFIGURATION = JSON.stringify(importConfiguration);

      const importControllerNoQueues = new ImportController(contextNoQueues);
      const response = await importControllerNoQueues.createImportJob(requestContext);
      expect(response.status).to.equal(503);
      expect(response.headers.get('x-error')).to.equal('Service Unavailable: No import queue available');
    });

    it('should reject when invalid URLs are passed in', async () => {
      requestContext.data.urls = ['https://example.com/page1', 'not-a-valid-url'];
      const response = await importController.createImportJob(requestContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: not-a-valid-url is not a valid URL');
    });

    it('should reject when an invalid options object is passed in', async () => {
      requestContext.data.options = 'options object should be an object, not a string';
      const response = await importController.createImportJob(requestContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: options must be an object');
    });

    it('should fail if sqs fails to send a message', async () => {
      context.sqs.sendMessage = sandbox.stub().throws(new Error('Queue error'));
      importController = ImportController(context);
      const response = await importController.createImportJob(requestContext);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Queue error');
    });

    it('should start a new import job', async () => {
      const response = await importController.createImportJob(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(202);

      // Verify how many messages were sent to SQS
      expect(mockSqsClient.sendMessage).to.have.been.calledThrice;
    });

    it('should pick another import queue when the first one is in use', async () => {
      context.dataAccess.getImportJobsByStatus = sandbox.stub().resolves([
        'spacecat-import-queue-1',
      ]);
      importController = ImportController(context);
      const response = await importController.createImportJob(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(202);

      // Verify how many messages were sent to SQS
      expect(mockSqsClient.sendMessage).to.have.been.calledThrice;

      // Should be using the 2nd import queue
      const firstCall = mockSqsClient.sendMessage.getCall(0);
      expect(firstCall.args[0]).to.equal('https://sqs.us-east-1.amazonaws.com/1234567890/spacecat-import-queue-2');
    });

    it('should fail when both available queues are in use', async () => {
      context.dataAccess.getImportJobsByStatus = sandbox.stub().resolves([
        'spacecat-import-queue-1',
        'spacecat-import-queue-2',
      ]);
      importController = ImportController(context);
      const response = await importController.createImportJob(requestContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(503); // Service unavailable
      expect(response.headers.get('x-error')).to.equal('Service Unavailable: No import queue available');
    });
  });

  describe('getImportJobStatus', () => {
    it('should fail when jobId is not provided', async () => {
      const response = await importController.getImportJobStatus(requestContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Job ID is required');
    });

    it('should return 404 when the jobID cannot be found', async () => {
      requestContext.params.jobId = 'unknown-job-id';
      const response = await importController.getImportJobStatus(requestContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Not found');
    });

    it('should return 404 when the api key is valid but does not match the key used to start the job', async () => {
      requestContext.pathInfo.headers['x-import-api-key'] = '7828b114-e20f-4234-bc4e-5b438b861edd';
      requestContext.params.jobId = exampleJob.id;
      const response = await importController.getImportJobStatus(requestContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Not found');
    });

    it('should return job details for a valid jobId', async () => {
      requestContext.params.jobId = exampleJob.id;
      const response = await importController.getImportJobStatus(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      const jobStatus = await response.json();
      expect(jobStatus.id).to.equal('f91afda0-afc8-467e-bfa3-fdbeba3037e8');
      expect(jobStatus.apiKey).to.equal('b9ebcfb5-80c9-4236-91ba-d50e361db71d');
      expect(jobStatus.baseURL).to.equal('https://www.example.com');
      expect(jobStatus.importQueueId).to.equal('spacecat-import-queue-1');
      expect(jobStatus.status).to.equal('RUNNING');
      expect(jobStatus.options).to.deep.equal({});
    });
  });

  describe('getImportJobResult', () => {
    beforeEach(() => {
      requestContext.pathInfo.headers['x-import-api-key'] = 'b9ebcfb5-80c9-4236-91ba-d50e361db71d';
      requestContext.params.jobId = exampleJob.id;
    });

    it('should fail to fetch the import result for a running job', async () => {
      // exampleJob is RUNNING
      const response = await importController.getImportJobResult(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Archive not available, job is still running');
    });

    it('should handle an AWS presigner error', async () => {
      mockS3.getSignedUrl.throws(new Error('Presigner error'));
      exampleJob.status = 'COMPLETE';

      const response = await importController.getImportJobResult(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Error occurred generating a pre-signed job result URL');
    });

    it('should generate a presigned URL for a COMPLETE job', async () => {
      exampleJob.status = 'COMPLETE';

      const response = await importController.getImportJobResult(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      expect(await response.json()).to.deep.equal({
        downloadUrl: 'https://example-bucket.s3.amazonaws.com/file-key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=EXAMPLE_ACCESS_KEY_ID%2F20240603%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20240603T123456Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abcdef1234567890',
        id: 'f91afda0-afc8-467e-bfa3-fdbeba3037e8',
      });
    });

    it('should handle an unexpected promise rejection from the AWS presigner', async () => {
      mockS3.getSignedUrl.rejects(new Error('Presigner error'));
      exampleJob.status = 'COMPLETE';

      const response = await importController.getImportJobResult(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Presigner error');
    });
  });
});
