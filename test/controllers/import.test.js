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

import { ImportJob, ImportUrl } from '@adobe/spacecat-shared-data-access';
import ImportJobSchema from '@adobe/spacecat-shared-data-access/src/models/import-job/import-job.schema.js';
import ImportUrlSchema from '@adobe/spacecat-shared-data-access/src/models/import-url/import-url.schema.js';
import ImportController from '../../src/controllers/import.js';
import { ErrorWithStatusCode } from '../../src/support/utils.js';

use(sinonChai);
use(chaiAsPromised);

const createImportJob = (data) => (new ImportJob(
  {
    entities: {
      importJob: {
        model: {
          schema: { attributes: { status: { type: 'string', get: (value) => value } } },
        },
        patch: sinon.stub().returns({ go: () => {}, set: () => {} }),
        remove: sinon.stub().returns({ go: () => {} }),
      },
    },
  },
  {
    log: console,
    getCollection: stub().returns({
      schema: ImportJobSchema,
      findById: stub(),
    }),
  },
  ImportJobSchema,
  data,
  console,
));

const createImportUrl = (data) => (new ImportUrl(
  { entities: { importUrl: {} } },
  {
    log: console,
    getCollection: stub().returns({
      schema: ImportUrlSchema,
      findById: stub(),
    }),
  },
  ImportUrlSchema,
  data,
  console,
));

describe('ImportController tests', () => {
  let sandbox;
  let importController;
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

  const xwalkMultipartArgs = {
    // the values for models, filters, definitions, and the import script just need to be strings
    options: { type: 'xwalk', data: { siteName: 'xwalk', assetFolder: 'xwalk' } },
    models: 'models',
    filters: 'filters',
    definitions: 'definitions',
    importScript: 'importScript',
  };

  const exampleJob = {
    importJobId: 'f91afda0-afc8-467e-bfa3-fdbeba3037e8',
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
    'https://www.example.com/page1',
    'https://www.example.com/page2',
    'https://www.example.com/page3',
  ];
  const customOptions = { enableJavascript: false };

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockSqsClient = {
      sendMessage: sandbox.stub(),
      purgeQueue: sandbox.stub(),
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
          getScopes: () => [{ name: 'imports.write', domains: ['https://www.example.com'] }],
        },
      },
    };

    mockDataAccess = {
      ApiKey: {
        allByHashedApiKey: sandbox.stub().resolves(exampleApiKeyMetadata),
      },
      ImportJob: {
        allByDateRange: sandbox.stub().resolves([]),
        allByStatus: sandbox.stub().resolves([]),
        create: (data) => createImportJob(data),
        findById: sandbox.stub(),
      },
      ImportUrl: {
        allByImportJobId: sandbox.stub().resolves([]),
        create: (data) => createImportUrl(data),
      },
    };

    mockDataAccess.ImportJob.findById.callsFake(async (jobId) => {
      if (jobId !== exampleJob.importJobId) {
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
      importQueueUrlPrefix: 'https://sqs.us-east-1.amazonaws.com/1234567890/',
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

    importController = ImportController(baseContext);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should fail for a bad IMPORT_CONFIGURATION', () => {
    baseContext.env.IMPORT_CONFIGURATION = 'not a JSON string';
    ImportController(baseContext);
    expect(baseContext.log.error.getCall(0).args[0]).to.equal('Failed to parse import configuration: Unexpected token \'o\', "not a JSON string" is not valid JSON');
  });

  describe('createImportJob', () => {
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

    it('should fail when url is not part of the allowed domains', async () => {
      baseContext.multipartFormData.urls = ['https://test.com/page1'];
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: URLs not allowed: https://test.com/page1');
    });

    it('should fail when there are no domains listed for the user scope imports.write', async () => {
      baseContext.attributes.authInfo.profile.getScopes = () => [{ name: 'imports.write', domains: [] }];
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(401);
      expect(response.headers.get('x-error')).to.equal('Missing domain information');
    });

    it('should create an import job for the user scope imports.write', async () => {
      baseContext.attributes.authInfo.profile.getScopes = () => [
        { name: 'imports.write', domains: ['https://www.example.com'] },
        { name: 'imports.read', domains: ['https://www.example.com'] },
      ];
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(202);
    });

    it('should create an import job for the user scope imports.all_domains', async () => {
      baseContext.attributes.authInfo.profile.getScopes = () => [{ name: 'imports.all_domains' }, { name: 'imports.write' }];
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(202);
    });

    it('should fail when the domains listed for imports.write do not match the URL', async () => {
      baseContext.attributes.authInfo.profile.getScopes = () => [{ name: 'imports.read', domains: ['https://www.example.com'] }, { name: 'imports.write', domains: ['https://www.test.com'] }];

      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: URLs not allowed: https://www.example.com/page1, https://www.example.com/page2, https://www.example.com/page3');
    });

    it('should respond with an error code when custom header is not an object', async () => {
      baseContext.multipartFormData.customHeaders = JSON.stringify([42]);
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

      const importControllerNoQueues = ImportController(baseContext);
      const response = await importControllerNoQueues.createImportJob(baseContext);
      expect(response.status).to.equal(503);
      expect(response.headers.get('x-error')).to.equal('Service Unavailable: No import queue available');
    });

    it('should reject when the given API key is already running an import job with the same baseURL', async () => {
      baseContext.dataAccess.ImportJob.allByStatus = sandbox.stub().resolves([
        createImportJob({
          ...exampleJob,
          hashedApiKey: 'c0fd7780368f08e883651422e6b96cf2320cc63e17725329496e27eb049a5441',
        }),
      ]);
      const response = await importController.createImportJob(baseContext);
      expect(response.status).to.equal(429);
      expect(response.headers.get('x-error')).to.equal('Too Many Requests: API key hash c0fd7780368f08e883651422e6b96cf2320cc63e17725329496e27eb049a5441 cannot be used to start any more import jobs for https://www.example.com');
    });

    it('should create an import job when the given API key is already running an import job with a different baseURL', async () => {
      baseContext.dataAccess.ImportJob.allByStatus = sandbox.stub().resolves([
        createImportJob({
          ...exampleJob,
          baseURL: 'https://www.another-example.com',
        }),
      ]);
      const response = await importController.createImportJob(baseContext);
      expect(response.status).to.equal(202);
    });

    it('should reject when invalid URLs are passed in', async () => {
      baseContext.multipartFormData.urls = ['https://example.com/page1', 'not-a-valid-url'];
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: not-a-valid-url is not a valid URL');
    });

    it('should reject when an invalid options object is provided', async () => {
      baseContext.multipartFormData.options = 'options object should be an object, not a string';
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: options must be an object');
    });

    it('should reject when an non-object options param is provided', async () => {
      baseContext.multipartFormData.urls = urls;
      baseContext.multipartFormData.options = [12345, 42];
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: options must be an object');
    });

    it('should fail if sqs fails to send a message', async () => {
      baseContext.sqs.sendMessage = sandbox.stub().throws(new Error('Queue error'));
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
      baseContext.dataAccess.ImportJob.allByStatus = sandbox.stub().resolves([
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
      const response = await importController.createImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(503); // Service unavailable
      expect(response.headers.get('x-error'))
        .to.equal('Service Unavailable: No import queue available');
    });

    it('should reject when s3Client fails to upload the importScript', async () => {
      baseContext.env.IMPORT_CONFIGURATION = JSON.stringify(importConfiguration);
      baseContext.multipartFormData.options = customOptions;
      baseContext.multipartFormData.importScript = 'Filler content to create a file > 10 bytes.';

      // Mock a rejection from the S3 API
      mockS3.s3Client.send.rejects(new Error('Cannot send message error'));
      const response = await importController.createImportJob(baseContext);

      expect(response.status).to.equal(500);
    });

    it('should pick up the default options when none are provided', async () => {
      baseContext.env.IMPORT_CONFIGURATION = JSON.stringify(importConfiguration);
      baseContext.multipartFormData.importScript = 'Filler content';
      baseContext.multipartFormData.customHeaders = exampleCustomHeaders;
      const response = await importController.createImportJob(baseContext);
      const importJob = await response.json();

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(202);

      expect(importJob.options).to.deep.equal({
        enableJavascript: true,
      });
    });

    it('should fail when the number of URLs exceeds the maximum allowed', async () => {
      baseContext.multipartFormData.urls = [
        'https://example.com/page1',
        'https://example.com/page2',
        'https://example.com/page3',
        'https://example.com/page4',
      ];
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
      importController = ImportController(baseContext);
      const response = await importController.createImportJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: number of URLs provided (2) exceeds the maximum allowed (1)');
    });

    it('should fail when URLs are empty', async () => {
      baseContext.multipartFormData.urls = [];
      const response = await importController.createImportJob(baseContext);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: urls must be provided as a non-empty array');
    });

    /**
     * Test the xwalk createImportJob use case.
     */
    describe('xwalk createImportJob', () => {
      it('should create an import job with the option.type of doc or xwalk', async () => {
        baseContext.multipartFormData.options = { type: 'doc' };
        const response = await importController.createImportJob(baseContext);
        expect(response.status).to.equal(202);

        Object.assign(baseContext.multipartFormData, xwalkMultipartArgs);
        const response2 = await importController.createImportJob(baseContext);
        expect(response2.status).to.equal(202);
      });

      it('should fail when the option.type is not doc or xwalk', async () => {
        baseContext.multipartFormData.urls = urls;
        baseContext.multipartFormData.options = { type: 'invalid' };
        const response = await importController.createImportJob(baseContext);
        expect(response.status).to.equal(400);
        expect(response.headers.get('x-error')).to.equal('Invalid request: type must be either doc or xwalk');
      });

      // it should not fail if type is not provided
      it('should create an import job without the option.type', async () => {
        baseContext.multipartFormData.urls = urls;
        const response = await importController.createImportJob(baseContext);
        expect(response.status).to.equal(202);
      });

      it('should call the s3client 4 times for the xwalk create job use case', async () => {
        Object.assign(baseContext.multipartFormData, xwalkMultipartArgs);
        const response = await importController.createImportJob(baseContext);
        expect(response.status).to.equal(202);
        // 4 invokes: 1 for the import script, 1 for models, 1 for filters, 1 for definitions
        expect(mockS3.s3Client.send.callCount).to.equal(4);
      });

      it('should fail when models, filters, or definitions are missing', async () => {
        baseContext.multipartFormData.options = xwalkMultipartArgs.options;
        const response = await importController.createImportJob(baseContext);
        expect(response.status).to.equal(400);
        expect(response.headers.get('x-error')).to.contain('Invalid request: models must be an string');

        baseContext.multipartFormData.models = 'models';
        const response2 = await importController.createImportJob(baseContext);
        expect(response2.status).to.equal(400);
        expect(response2.headers.get('x-error')).to.contain('Invalid request: filters must be an string');

        baseContext.multipartFormData.filters = 'filters';
        const response3 = await importController.createImportJob(baseContext);
        expect(response3.status).to.equal(400);
        expect(response3.headers.get('x-error')).to.contain('Invalid request: definitions must be an string');

        baseContext.multipartFormData.definitions = 'definitions';
        // now all the required fields are present
        const response4 = await importController.createImportJob(baseContext);
        expect(response4.status).to.equal(202);
        expect(response4.headers.get('x-error')).to.be.null;
      });

      it('should create an import job with all required fields', async () => {
        Object.assign(baseContext.multipartFormData, xwalkMultipartArgs);
        const response = await importController.createImportJob(baseContext);
        expect(response.status).to.equal(202);
      });

      it('should fail to create an import job when options are missing', async () => {
        // remove the options.data.assetFolder from xwalkMultipartArgs
        delete xwalkMultipartArgs.options.data.assetFolder;
        Object.assign(baseContext.multipartFormData, xwalkMultipartArgs);
        const response = await importController.createImportJob(baseContext);
        expect(response.status).to.equal(400);
        expect(response.headers.get('x-error')).to.contain('Missing option(s): { data: { assetFolder, siteName } } are required');
      });
    });
  });

  describe('getImportJobProgress', () => {
    it('should respond with an expected progress response', async () => {
      baseContext.dataAccess.getImportJobProgress = sandbox.stub().resolves([
        createImportJob({
          ...exampleJob,
          hashedApiKey: '123',
        }),
      ]);

      // only need to provide enough import url data to satisfy the import-supervisor, no need
      // for all the other properties of a ImportUrl object.
      baseContext.dataAccess.ImportUrl.allByImportJobId = sandbox.stub().resolves([
        { getStatus: () => ImportJob.ImportUrlStatus.COMPLETE },
        { getStatus: () => ImportJob.ImportUrlStatus.COMPLETE },
        // setting a status to RUNNING should not affect the result
        // as no process will flip a ImportUrl status to running at this time, therefore
        // the code will ignore running in the results
        { getStatus: () => ImportJob.ImportUrlStatus.RUNNING },
        { getStatus: () => ImportJob.ImportUrlStatus.PENDING },
        { getStatus: () => ImportJob.ImportUrlStatus.REDIRECT },
        { getStatus: () => ImportJob.ImportUrlStatus.FAILED },
      ]);

      baseContext.params.jobId = exampleJob.importJobId;
      importController = ImportController(baseContext);
      const response = await importController.getImportJobProgress(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      const progress = await response.json();
      expect(progress).to.deep.equal({
        pending: 1,
        redirect: 1,
        completed: 2,
        failed: 1,
      });
    });

    it('should respond a job not found for non existent jobs', async () => {
      baseContext.dataAccess.getImportJobByID = sandbox.stub().resolves(null);
      baseContext.params.jobId = '3ec88567-c9f8-4fb1-8361-b53985a2898b'; // non existent job

      importController = ImportController(baseContext);
      const response = await importController.getImportJobProgress(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
    });

    it('should return default values when no import urls are available', async () => {
      baseContext.dataAccess.getImportJobProgress = sandbox.stub().resolves([
        createImportJob({ ...exampleJob, hashedApiKey: '123' }),
      ]);

      baseContext.params.jobId = exampleJob.importJobId;
      importController = ImportController(baseContext);

      const response = await importController.getImportJobProgress(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);

      const progress = await response.json();
      expect(progress).to.deep.equal({
        pending: 0,
        redirect: 0,
        completed: 0,
        failed: 0,
      });
    });

    it('should return 404 when the api key is valid but does not match the key used to start the job', async () => {
      baseContext.pathInfo.headers['x-api-key'] = '7828b114-e20f-4234-bc4e-5b438b861edd';
      baseContext.params.jobId = exampleJob.importJobId;
      const response = await importController.getImportJobProgress(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Not found');
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
      baseContext.params.jobId = '3ec88567-c9f8-4fb1-8361-b53985a2898b'; // non existent job
      const response = await importController.getImportJobStatus(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Not found');
    });

    it('should return 404 when the api key is valid but does not match the key used to start the job', async () => {
      baseContext.pathInfo.headers['x-api-key'] = '7828b114-e20f-4234-bc4e-5b438b861edd';
      baseContext.params.jobId = exampleJob.importJobId;
      const response = await importController.getImportJobStatus(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Not found');
    });

    it('should return job details for a valid jobId', async () => {
      baseContext.params.jobId = exampleJob.importJobId;
      const response = await importController.getImportJobStatus(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(200);
      const jobStatus = await response.json();
      expect(jobStatus.id).to.equal('f91afda0-afc8-467e-bfa3-fdbeba3037e8');
      expect(jobStatus.apiKey).to.be.undefined;
      expect(jobStatus.baseURL).to.equal('https://www.example.com');
      expect(jobStatus.status).to.equal('RUNNING');
      expect(jobStatus.options).to.deep.equal({});
    });
  });

  describe('getImportJobResult', () => {
    beforeEach(() => {
      baseContext.pathInfo.headers['x-api-key'] = 'b9ebcfb5-80c9-4236-91ba-d50e361db71d';
      baseContext.params.jobId = exampleJob.importJobId;
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
      expect(mockS3.GetObjectCommand.getCall(0).args[0].Key).to.equal(`imports/${exampleJob.importJobId}/import-result.zip`);
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
      baseContext.dataAccess.ImportJob.allByDateRange = sandbox.stub().resolves([job]);
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

  describe('deleteImportJob', () => {
    it('should fail when api key does not have the correct scopes', async () => {
      baseContext.auth.checkScopes = sandbox.stub().throws(new Error('Invalid scopes'));
      baseContext.params.jobId = exampleJob.importJobId;
      const response = await importController.deleteImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(401);
      expect(response.headers.get('x-error')).to.equal('Missing required scopes');

      expect(mockDataAccess.ImportJob.findById).to.not.have.been.called;
    });

    it('should return 404 when the api key is valid but does not match the key used to start the job', async () => {
      baseContext.pathInfo.headers['x-api-key'] = '7828b114-e20f-4234-bc4e-5b438b861edd';
      baseContext.params.jobId = exampleJob.importJobId;
      const job = await mockDataAccess.ImportJob.findById(exampleJob.importJobId);
      job.remove = sandbox.stub().resolves();

      const response = await importController.deleteImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(404);
      expect(response.headers.get('x-error')).to.equal('Not found');

      expect(job.remove).to.not.have.been.called;
    });

    it('should delete the specified job', async () => {
      baseContext.params.jobId = exampleJob.importJobId;
      const job = createImportJob(exampleJob);
      job.remove = sandbox.stub().resolves();
      baseContext.dataAccess.ImportJob.findById = sandbox.stub().resolves(job);

      const response = await importController.deleteImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(204);

      // Check that removeImportJob was invoked with the expected jobId
      expect(job.remove).to.have.been.calledOnce;
    });
  });

  describe('stopImportJob', () => {
    it('should fail when api key does not have the correct scopes', async () => {
      baseContext.auth.checkScopes = sandbox.stub().throws(new Error('Invalid scopes'));
      baseContext.params.jobId = exampleJob.importJobId;
      const response = await importController.stopImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(401);
      expect(response.headers.get('x-error')).to.equal('Missing required scopes');

      expect(mockSqsClient.purgeQueue).to.not.have.been.called;
    });

    it('should fail when request data is not an array', async () => {
      baseContext.data = 'not an array';
      const response = await importController.stopImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: Patch request data needs to be an array');
    });

    it('should fail when request data is an empty array', async () => {
      baseContext.data = [];
      const response = await importController.stopImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: Patch request data needs to contain exactly one operation');
    });

    it('should fail when request data does not contain an object', async () => {
      baseContext.data = ['not an object'];
      const response = await importController.stopImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: Patch request data needs to be an array of objects');
    });

    it('should fail when request data does not contain an operation', async () => {
      baseContext.data = [{ notAnOperation: 'not an operation' }];
      const response = await importController.stopImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: Patch request supports the following operations: ["replace"]');
    });

    it('should fail when request data does not contain a valid path', async () => {
      baseContext.data = [{ op: 'replace', path: '/not-a-valid-path', value: 'not a valid value' }];
      const response = await importController.stopImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: Patch request supports the following paths: ["/status"]');
    });

    it('should fail when request data does not contain a valid value', async () => {
      baseContext.data = [{ op: 'replace', path: '/status', value: 'not a valid value' }];
      const response = await importController.stopImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Invalid request: Patch request supports the following values: ["STOPPED"]');
    });

    it('should fail when import job is not provided', async () => {
      baseContext.dataAccess.getImportJobByID = sandbox.stub().resolves(null);
      baseContext.data = [{ op: 'replace', path: '/status', value: 'STOPPED' }];
      const response = await importController.stopImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Job ID is required');
    });

    it('should fail when import job is not running', async () => {
      baseContext.dataAccess.getImportJobByID = sandbox.stub().resolves(createImportJob({
        ...exampleJob,
        status: 'STOPPED',
      }));
      baseContext.data = [{ op: 'replace', path: '/status', value: 'STOPPED' }];
      baseContext.params.jobId = 'f91afda0-afc8-467e-bfa3-fdbeba3037e8';
      const response = await importController.stopImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(400);
      expect(response.headers.get('x-error')).to.equal('Job with jobId: f91afda0-afc8-467e-bfa3-fdbeba3037e8 cannot be stopped as it is already in a terminal state');
    });

    it('should successfully stop an import job', async () => {
      const job = createImportJob({
        ...exampleJob,
        status: 'RUNNING',
      });
      job.save = sandbox.stub().resolves();
      baseContext.dataAccess.ImportJob.findById = sandbox.stub().resolves(job);
      baseContext.data = [{ op: 'replace', path: '/status', value: 'STOPPED' }];
      baseContext.params.jobId = 'f91afda0-afc8-467e-bfa3-fdbeba3037e8';
      const response = await importController.stopImportJob(baseContext);

      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(204);
      expect(job.save).to.have.been.calledOnce;
      expect(mockSqsClient.purgeQueue).to.have.been.calledOnce;
    });
  });
});
