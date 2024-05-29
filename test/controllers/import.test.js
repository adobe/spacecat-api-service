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

describe('ImportController', () => {
  let importController;
  let context;
  let requestContext = {};

  beforeEach(() => {
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
      },
      sqsClient: {
        sendMessage: sinon.stub(),
      },
      s3Client: {
        send: sinon.stub(),
      },
    };

    importController = ImportController(context);
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

    it('should start a new import job', async () => {
      const response = await importController.createImportJob(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(501);
    });
  });

  describe('getImportJobStatus', () => {
    it('should query for an import job\'s status', async () => {
      const response = await importController.getImportJobStatus(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(501);
    });
  });

  describe('getImportJobResult', () => {
    it('should fetch the import job\'s result', async () => {
      const response = await importController.getImportJobResult(requestContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(501);
    });
  });
});
