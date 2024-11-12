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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import { createApiKey } from '@adobe/spacecat-shared-data-access/src/models/api-key/api-key.js';
import ApiKeyController from '../../src/controllers/api-key.js';
import {
  SERVER_ERROR,
  STATUS_BAD_REQUEST,
  STATUS_CREATED,
  STATUS_FORBIDDEN,
  STATUS_NO_CONTENT,
  STATUS_OK, STATUS_UNAUTHORIZED,
} from '../../src/utils/constants.js';

use(sinonChai);
use(chaiAsPromised);

describe('ApiKeyController tests', () => {
  let context;
  let apiKeyController;
  let requestContext = {};
  let exampleApiKey;

  beforeEach(() => {
    requestContext = {
      pathInfo: {
        headers: {
          'x-ims-gw-org-id': 'test-org',
          Authorization: 'Bearer test-token',
        },
      },
      data: {
        name: 'test-key',
        features: ['imports'],
        domains: ['https://example.com'],
        urls: ['https://example.com'],
      },
      params: {
        id: '56hjhkj309r989ra90',
      },
    };

    exampleApiKey = {
      id: '56hjhkj309r989ra90',
      hashedApiKey: '786786423ghfp9-9',
      name: 'test-key',
      imsUserId: 'test-user-id',
      imsOrgId: 'test-org',
      expiresAt: '2034-05-29T14:26:00.000Z',
      createdAt: '2024-05-29T14:26:00.000Z',
      scopes: [{ name: 'imports.read' }, { name: 'imports.write', domains: ['https://example.com'] }],
    };

    context = {
      log: console,
      dataAccess: {
        getApiKeysByImsUserIdAndImsOrgId: sinon.stub(),
        createNewApiKey: (data) => createApiKey(data),
        getApiKeyById: sinon.stub(),
        updateApiKey: sinon.stub(),
      },
      env: {
        API_KEY_CONFIGURATION: JSON.stringify({ maxDomainsPerApiKey: 1, maxApiKeys: 3 }),
      },
      attributes: {
        authInfo: {
          profile: {
            email: 'test@example.com',
          },
        },
      },
      imsClient: {
        getImsUserProfile: sinon.stub().returns({ organizations: ['test-org'] }),
      },
    };
    apiKeyController = ApiKeyController(context);
  });

  describe('createApiKey', () => {
    it('should throw an error if request data is not a valid JSON', async () => {
      requestContext.data = 'invalid-json';
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('should throw an error if request data is missing features', async () => {
      requestContext.data = { domains: ['https://example.com'] };
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('should throw an error if request data is missing domains', async () => {
      requestContext.data = { features: ['imports'] };
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('should throw an error if request data is missing name', async () => {
      requestContext.data = { features: ['imports'], domains: ['https://example.com'] };
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('should throw an error if the domain is not valid', async () => {
      requestContext.data.domains = ['invalid-domain'];
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_BAD_REQUEST);
    });

    it('should throw an error if imsOrgId is missing', async () => {
      requestContext.pathInfo.headers['x-ims-gw-org-id'] = '';
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_UNAUTHORIZED);
    });

    it('should throw an error if the organization is not found', async () => {
      context.imsClient.getImsUserProfile.returns({ organizations: [] });
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_UNAUTHORIZED);
    });

    it('should throw an error if bearer token is missing', async () => {
      requestContext.pathInfo.headers.Authorization = '';
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_UNAUTHORIZED);
    });

    it('should create a new API key', async () => {
      context.dataAccess.getApiKeysByImsUserIdAndImsOrgId.returns([]);
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_CREATED);
    });

    it('should throw an error if the number of domains exceeds the limit', async () => {
      requestContext.data.domains = ['https://example.com', 'https://another.com'];
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_FORBIDDEN);
    });

    it('should throw an error if the user has reached the maximum number of API keys', async () => {
      context.dataAccess.getApiKeysByImsUserIdAndImsOrgId
        .returns([createApiKey(exampleApiKey),
          createApiKey(exampleApiKey), createApiKey(exampleApiKey)]);
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_FORBIDDEN);
    });
  });

  describe('deleteApiKey', () => {
    it('should delete an API key', async () => {
      context.dataAccess.getApiKeyById.returns({
        getImsUserId: () => 'test@example.com',
        getImsOrgId: () => 'test-org',
        updateDeletedAt: sinon.stub(),
      });

      const response = await apiKeyController.deleteApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_NO_CONTENT);
    });

    it('should throw an error if the API key is not found', async () => {
      context.dataAccess.getApiKeyById.returns({
        getImsUserId: () => 'other@example.com',
        getImsOrgId: () => 'other-org',
      });

      const response = await apiKeyController.deleteApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_FORBIDDEN);
    });
  });

  describe('getApiKeys', () => {
    it('should return all the API Keys', async () => {
      context.dataAccess.getApiKeysByImsUserIdAndImsOrgId.returns([createApiKey(exampleApiKey)]);
      const response = await apiKeyController.getApiKeys({ ...requestContext });
      expect(response.status).to.equal(STATUS_OK);
    });

    it('should throw an error when getApiKeysByImsUserIdAndImsOrgId fails', async () => {
      context.dataAccess.getApiKeysByImsUserIdAndImsOrgId.throws(new Error('Dynamo Error'));
      const response = await apiKeyController.getApiKeys({ ...requestContext });
      expect(response.status).to.equal(SERVER_ERROR);
    });
  });
});
