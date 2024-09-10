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
import sinon from 'sinon';

import { createImportJob } from '@adobe/spacecat-shared-data-access/src/models/importer/import-job.js';
import { createImportUrl } from '@adobe/spacecat-shared-data-access/src/models/importer/import-url.js';
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { ErrorWithStatusCode } from '../../src/support/utils.js';
import ImportController from '../../src/controllers/import.js';

use(sinonChai);
use(chaiAsPromised);

const thisDirectory = dirname(fileURLToPath(import.meta.url));

describe('ImportController tests', () => {
  let sandbox;
  let importController;
  let baseRequest;
  let baseContext;
  let mockSqsClient;
  let mockDataAccess;
  let mockS3;
  let importConfiguration;
  let mockAuth;
  let mockAttributes;
  const defaultHeaders = {
    'x-api-key': 'b9ebcfb5-80c9-4236-91ba-d50e361db71d',
    'user-agent': 'Unit test',
    'content-type': 'multipart/form-data; boundary=12345',
  };
  const exampleCustomHeaders = {
    Authorization: 'Bearer aXsPb3183G',
  };

  const exampleJob = {
    id: 'f91afda0-afc8-467e-bfa3-fdbeba3037e8',
    status: 'RUNNING',
    options: {},
    baseURL: 'https://www.example.com',
    hashedApiKey: 'c0fd7780368f08e883651422e6b96cf2320cc63e17725329496e27eb049a5441',
    importQueueId: 'spacecat-import-queue-1',
    initiatedBy: {
      apiKeyName: 'Test key',
    },
  };

  const exampleApiKeyMetadata = {
    hashedApiKey: 'c0fd7780368f08e883651422e6b96cf2320cc63e17725329496e27eb049a5441',
    name: 'Test API Key',
    imsOrgId: 'Test Org',
  };

  const urls = [
    'https://example.com/page1',
    'https://example.com/page2',
    'https://example.com/page3',
  ];
  const customOptions = { enableJavascript: false };

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockSqsClient = {
      sendMessage: sandbox.stub(),
    };

    mockAuth = {
      checkScopes: sandbox.stub().resolves(true),
    };

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
      getImportJobsByStatus: sandbox.stub().resolves([]), // Simulate no running jobs
      createNewImportJob: (data) => createImportJob(data),
      createNewImportUrl: (data) => createImportUrl(data),
      getImportJobByID: sandbox.stub(),
      getApiKeyByHashedApiKey: sandbox.stub().resolves(exampleApiKeyMetadata),
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
      PutObjectCommand: sandbox.stub(),
      getSignedUrl: sandbox.stub(),
    };

    mockS3.getSignedUrl.callsFake(async () => 'https://example-bucket.s3.amazonaws.com/file-key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=EXAMPLE_ACCESS_KEY_ID%2F20240603%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20240603T123456Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abcdef1234567890');

    importConfiguration = {
      queues: ['spacecat-import-queue-1', 'spacecat-import-queue-2'],
      importWorkerQueue: 'https://sqs.us-east-1.amazonaws.com/1234567890/import-worker-queue',
      options: {
        enableJavascript: true,
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
        IMPORT_CONFIGURATION: JSON.stringify(importConfiguration),
      },
      sqs: mockSqsClient,
      s3: mockS3,
      dataAccess: mockDataAccess,
      auth: mockAuth,
      attributes: mockAttributes,
      pathInfo: {
        headers: {
          ...defaultHeaders,
        },
      },
      params: {},
      multipartFormData: {
        urls,
      },
    };

    importController = ImportController(baseRequest, baseContext);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should fail for a bad IMPORT_CONFIGURATION', () => {
    baseContext.env.IMPORT_CONFIGURATION = 'not a JSON string';
    ImportController(baseRequest, baseContext);
    expect(baseContext.log.error.getCall(0).args[0]).to.equal('Failed to parse import configuration: Unexpected token \'o\', "not a JSON string" is not valid JSON');
  });

  describe('createImportJob', () => {
    beforeEach(() => {
      // Prepare the new import job request, which is special because it is using the
      // multipart/form-data content type
      baseRequest = new Request('https://space.cat', {
        method: 'POST',
        headers: {
          ...defaultHeaders,
        },
      });

      importController = ImportController(baseRequest, baseContext);
    });

    it('should fail for a non-multipart/form-data request', async () => {
      delete baseContext.multipartFormData;
      const response = await importController.createImportJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: missing multipart/form-data request data');
    });

    it('should respond with an error code when the data format is incorrect', async () => {
      baseContext.multipartFormData.urls = 'https://example.com/must/be/an/array';
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: urls must be provided as a non-empty array');
    });

    it('should respond with an error code when custom header is not an object', async () => {
      baseContext.multipartFormData.customHeaders = JSON.stringify([42]);
      importController = ImportController(baseRequest, baseContext);
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: customHeaders must be an object');
    });

    it('should reject when auth scopes are invalid', async () => {
      baseContext.auth.checkScopes = sandbox.stub().throws(new Error('Invalid scopes'));
      const response = await importController.createImportJob(baseContext);
      expect(response.status).to.equal(401);
      expect(response.headers.get('x-error')).to.equal('Missing required scopes');
    });

    it('should reject when no import queues are defined', async () => {
      delete importConfiguration.queues;
      baseContext.env.IMPORT_CONFIGURATION = JSON.stringify(importConfiguration);

      const importControllerNoQueues = ImportController(baseRequest, baseContext);
      const response = await importControllerNoQueues.createImportJob(baseContext);
      expect(response.status).to.equal(503);
      expect(response.headers.get('x-error')).to.equal('Service Unavailable: No import queue available');
    });

    it('should reject when the given API key is already running an import job', async () => {
      baseContext.dataAccess.getImportJobsByStatus = sandbox.stub().resolves([
        createImportJob({
          ...exampleJob,
          hashedApiKey: 'c0fd7780368f08e883651422e6b96cf2320cc63e17725329496e27eb049a5441',
        }),
      ]);
      const response = await importController.createImportJob(baseContext);
      expect(response.status).to.equal(429);
      expect(response.headers.get('x-error')).to.equal('Too Many Requests: API key hash c0fd7780368f08e883651422e6b96cf2320cc63e17725329496e27eb049a5441 cannot be used to start any more import jobs');
    });

    it('should reject when invalid URLs are passed in', async () => {
      baseContext.multipartFormData.urls = ['https://example.com/page1', 'not-a-valid-url'];
      importController = ImportController(baseRequest, baseContext);
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: not-a-valid-url is not a valid URL');
    });

    it('should reject when an invalid options object is provided', async () => {
      baseContext.multipartFormData.options = 'options object should be an object, not a string';
      importController = ImportController(baseRequest, baseContext);
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: options must be an object');
    });

    it('should reject when an non-object options param is provided', async () => {
      baseContext.multipartFormData.urls = urls;
      baseContext.multipartFormData.options = [12345, 42];
      importController = ImportController(baseRequest, baseContext);
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: options must be an object');
    });

    it('should fail if sqs fails to send a message', async () => {
      baseContext.sqs.sendMessage = sandbox.stub().throws(new Error('Queue error'));
      importController = ImportController(baseRequest, baseContext);
      const response = await importController.createImportJob(baseContext);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Queue error');
    });

    it('should start a new import job', async () => {
      baseContext.multipartFormData.customHeaders = {
        ...exampleCustomHeaders,
      };
      const response = await importController.createImportJob(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(202);

      // Verify how many messages were sent to SQS
      // (we only send a single message now, instead of 1 per URL)
      expect(mockSqsClient.sendMessage).to.have.been.calledOnce;
      const firstCall = mockSqsClient.sendMessage.getCall(0);
      expect(firstCall.args[1].customHeaders).to.deep.equal({ Authorization: 'Bearer aXsPb3183G' });
    });

    it('should pick another import queue when the first one is in use', async () => {
      baseContext.dataAccess.getImportJobsByStatus = sandbox.stub().resolves([
        createImportJob({
          ...exampleJob,
          hashedApiKey: 'ac90ae98768efdb4c6349f23e63fc35e465333ca21bd30dd2838a100d1fd09d7', // Queue is in use by another API key
        }),
      ]);
      importController = ImportController(baseRequest, baseContext);
      const response = await importController.createImportJob(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(202);

      // Verify how many messages were sent to SQS
      // (we only send a single message now, instead of 1 per URL)
      expect(mockSqsClient.sendMessage).to.have.been.calledOnce;

      // Check the resulting message to the import-worker-queue
      const firstCall = mockSqsClient.sendMessage.getCall(0);
      expect(firstCall.args[1].urls.length).to.equal(3);
      expect(firstCall.args[0]).to.equal('https://sqs.us-east-1.amazonaws.com/1234567890/import-worker-queue');
    });

    it('should fail when all (both) available queues are in use', async () => {
      baseContext.dataAccess.getImportJobsByStatus = sandbox.stub().resolves([
        createImportJob({
          ...exampleJob,
          importQueueId: 'spacecat-import-queue-1',
          hashedApiKey: 'b76319539c6c50113d425259385cd1a382a369441d9242e641be22ed8c2d8069', // Queue is in use by another API key
        }),
        createImportJob({
          ...exampleJob,
          importQueueId: 'spacecat-import-queue-2',
          hashedApiKey: '23306638a0b7ed823e4da979b73592bf2a7ddd0ee027a58b1fc75b337b97cd9d', // Queue is in use by another API key
        }),
      ]);
      importController = ImportController(baseRequest, baseContext);
      const response = await importController.createImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(503); // Service unavailable
      expect(response.headers.get('x-error'))
        .to.equal('Service Unavailable: No import queue available');
    });

    it('should reject when s3Client fails to upload the importScript', async () => {
      baseContext.env.IMPORT_CONFIGURATION = JSON.stringify(importConfiguration);

      const importScriptStream = fs.readFileSync(path.join(thisDirectory, 'fixtures', 'sample-import-script.js'), 'utf8');
      baseContext.multipartFormData.options = customOptions;
      baseContext.multipartFormData.importScript = importScriptStream;
      importController = ImportController(baseRequest, baseContext);

      // Mock a rejection from the S3 API
      mockS3.s3Client.send.rejects(new Error('Cannot send message error'));
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(500);
    });

    it('should pick up the default options when none are provided', async () => {
      baseContext.env.IMPORT_CONFIGURATION = JSON.stringify(importConfiguration);

      const importScriptStream = fs.readFileSync(path.join(thisDirectory, 'fixtures', 'sample-import-script.js'), 'utf8');
      baseContext.multipartFormData.importScript = importScriptStream;
      baseContext.multipartFormData.customHeaders = exampleCustomHeaders;
      importController = ImportController(baseRequest, baseContext);
      const response = await importController.createImportJob(baseContext);
      const importJob = await response.json();

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(202);

      expect(importJob.options).to.deep.equal({
        enableJavascript: true,
        hasCustomHeaders: true,
        hasCustomImportJs: true,
      });
    });

    it('should fail when the number of URLs exceeds the maximum allowed', async () => {
      baseContext.multipartFormData.urls = [
        'https://example.com/page1',
        'https://example.com/page2',
        'https://example.com/page3',
        'https://example.com/page4',
      ];
      importController = ImportController(baseRequest, baseContext);
      const response = await importController.createImportJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: number of URLs provided (4) exceeds the maximum allowed (3)');
    });

    it('should fail when the number of URLs exceeds the (default) maximum allowed', async () => {
      delete importConfiguration.maxUrlsPerJob; // Should fall back to 1
      baseContext.env.IMPORT_CONFIGURATION = JSON.stringify(importConfiguration);
      baseContext.multipartFormData.urls = [
        'https://example.com/page1',
        'https://example.com/page2',
      ];
      importController = ImportController(baseRequest, baseContext);

      const response = await importController.createImportJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: number of URLs provided (2) exceeds the maximum allowed (1)');
    });

    it('should fail when URLs are empty', async () => {
      baseContext.multipartFormData.urls = [];
      importController = ImportController(baseRequest, baseContext);
      const response = await importController.createImportJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: urls must be provided as a non-empty array');
    });
  });

  describe('getImportJobStatus', () => {
    it('should fail when jobId is not provided', async () => {
      const response = await importController.getImportJobStatus(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Job ID is required');
    });

    it('should return 404 when the jobID cannot be found', async () => {
      baseContext.params.jobId = 'unknown-job-id';
      const response = await importController.getImportJobStatus(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Not found');
    });

    it('should return 404 when the api key is valid but does not match the key used to start the job', async () => {
      baseContext.pathInfo.headers['x-api-key'] = '7828b114-e20f-4234-bc4e-5b438b861edd';
      baseContext.params.jobId = exampleJob.id;
      const response = await importController.getImportJobStatus(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Not found');
    });

    it('should return job details for a valid jobId', async () => {
      baseContext.params.jobId = exampleJob.id;
      const response = await importController.getImportJobStatus(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      const jobStatus = await response.json();
      expect(jobStatus.id).to.equal('f91afda0-afc8-467e-bfa3-fdbeba3037e8');
      expect(jobStatus.apiKey).to.be.undefined;
      expect(jobStatus.baseURL).to.equal('https://www.example.com');
      expect(jobStatus.importQueueId).to.equal('spacecat-import-queue-1');
      expect(jobStatus.status).to.equal('RUNNING');
      expect(jobStatus.options).to.deep.equal({});
    });
  });

  describe('getImportJobResult', () => {
    beforeEach(() => {
      baseContext.pathInfo.headers['x-api-key'] = 'b9ebcfb5-80c9-4236-91ba-d50e361db71d';
      baseContext.params.jobId = exampleJob.id;
    });

    it('should fail to fetch the import result for a running job', async () => {
      // exampleJob is RUNNING
      const response = await importController.getImportJobResult(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Archive not available, job status is: RUNNING');
    });

    it('should handle an AWS presigner error', async () => {
      mockS3.getSignedUrl.throws(new Error('Presigner error'));
      exampleJob.status = 'COMPLETE';

      const response = await importController.getImportJobResult(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Error occurred generating a pre-signed job result URL');
    });

    it('should generate a presigned URL for a COMPLETE job', async () => {
      exampleJob.status = 'COMPLETE';

      const response = await importController.getImportJobResult(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      expect(await response.json()).to.deep.equal({
        downloadUrl: 'https://example-bucket.s3.amazonaws.com/file-key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=EXAMPLE_ACCESS_KEY_ID%2F20240603%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20240603T123456Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abcdef1234567890',
        id: 'f91afda0-afc8-467e-bfa3-fdbeba3037e8',
      });

      // Verify that GetObjectCommand was called with the expected key
      expect(mockS3.GetObjectCommand).to.have.been.calledOnce;
      expect(mockS3.GetObjectCommand.getCall(0).args[0].Key).to.equal(`imports/${exampleJob.id}/import-result.zip`);
    });

    it('should handle an unexpected promise rejection from the AWS presigner', async () => {
      mockS3.getSignedUrl.rejects(new Error('Presigner error'));
      exampleJob.status = 'COMPLETE';

      const response = await importController.getImportJobResult(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.equal('Presigner error');
    });
  });

  describe('getImportJobsByDateRange', () => {
    it('should throw an error when startDate is not present', async () => {
      baseContext.params.endDate = '2024-05-29T14:26:00.000Z';
      const response = await importController.getImportJobsByDateRange(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: startDate and endDate must be in ISO 8601 format');
    });

    it('should throw an error when endDate is not present', async () => {
      baseContext.params.startDate = '2024-05-29T14:26:00.000Z';
      const response = await importController.getImportJobsByDateRange(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: startDate and endDate must be in ISO 8601 format');
    });

    it('should return an array of import jobs', async () => {
      const job = createImportJob(exampleJob);
      baseContext.dataAccess.getImportJobsByDateRange = sandbox.stub().resolves([job]);
      baseContext.params.startDate = '2022-10-05T14:48:00.000Z';
      baseContext.params.endDate = '2022-10-07T14:48:00.000Z';

      const response = await importController.getImportJobsByDateRange(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      const responseResult = await response.json();
      expect(responseResult[0].initiatedBy).to.deep.equal({
        apiKeyName: 'Test key',
      });
      expect(responseResult[0].baseURL).to.equal('https://www.example.com');
    });
  });
});
