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

import ImportController from '../../src/controllers/import.js';

chai.use(sinonChai);
chai.use(chaiAsPromised);

describe('ImportController tests', () => {
  let sandbox;
  let importController;
  let context;
  let requestContext = {};
  let mockSqsClient;

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
        jobId: '88fdb3c0-bbc1-4a13-ad5e-959f712cee0e',
      },
      pathInfo: {
        headers: {
          'x-import-api-key': 'b9ebcfb5-80c9-4236-91ba-d50e361db71d',
        },
      },
    };

    context = {
      log: console,
      env: {
        ALLOWED_IMPORT_API_KEYS: 'b9ebcfb5-80c9-4236-91ba-d50e361db71d,7828b114-e20f-4234-bc4e-5b438b861edd',
        IMPORT_QUEUE_URL_PREFIX: 'https://sqs.us-east-1.amazonaws.com/1234567890/',
        IMPORT_QUEUES: 'spacecat-import-queue-1,spacecat-import-queue-2',
      },
      sqs: mockSqsClient,
      s3Client: {
        send: sandbox.stub(),
        getObject: sandbox.stub(),
      },
      dataAccess: {
        getImportJobsByStatus: sandbox.stub().resolves([]), // Simulate no running jobs
        createNewImportJob: sandbox.stub().resolves({
          getId: () => 'c9188df2-a183-4592-93f5-2f1c5f956f91',
        }),
        createNewImportUrl: (urlRecord) => ({
          ...urlRecord,
          id: crypto.randomUUID(),
        }),
      },
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
    });

    it('should respond with an error code when the data format is incorrect', async () => {
      requestContext.data.urls = 'https://example.com/must/be/an/array';
      const response = await importController.createImportJob(requestContext);
      expect(response.status).to.equal(400);
    });

    it('should reject an invalid import API key', async () => {
      requestContext.pathInfo.headers['x-import-api-key'] = 'unknown-api-key';
      const response = await importController.createImportJob(requestContext);
      expect(response.status).to.equal(401); // Unauthorized
    });

    it('should reject when no allowed API keys are defined', async () => {
      const contextNoApiKeys = { ...context };
      delete contextNoApiKeys.env.ALLOWED_IMPORT_API_KEYS;
      const importControllerNoApiKeys = new ImportController(contextNoApiKeys);
      const response = await importControllerNoApiKeys.createImportJob(requestContext);
      expect(response.status).to.equal(401); // Unauthorized
    });

    it('should reject when invalid URLs are passed in', async () => {
      requestContext.data.urls = ['https://example.com/page1', 'not-a-valid-url'];
      const response = await importController.createImportJob(requestContext);
      expect(response.status).to.equal(400);
    });

    it('should reject when an invalid options object is passed in', async () => {
      requestContext.data.options = 'options object should be an object, not a string';
      const response = await importController.createImportJob(requestContext);
      expect(response.status).to.equal(400);
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
      expect(firstCall.args[0]).to.equal('spacecat-import-queue-2');
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
    });
  });

  describe('getImportJobStatus', () => {
    it('should query for an import job\'s status (not yet implemented)', async () => {
      const response = await importController.getImportJobStatus(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(501);
    });
  });

  describe('getImportJobResult', () => {
    it('should fetch the import job\'s result (not yet implemented)', async () => {
      const response = await importController.getImportJobResult(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(501);
    });
  });
});
