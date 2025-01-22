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

import ApiKeyController from '../../src/controllers/api-key.js';
import {
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_BAD_REQUEST,
  STATUS_CREATED,
  STATUS_FORBIDDEN,
  STATUS_NO_CONTENT,
  STATUS_OK, STATUS_UNAUTHORIZED, STATUS_NOT_FOUND,
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
          'x-gw-ims-org-id': 'test-org',
          authorization: 'Bearer test-token',
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
      getId: () => '56hjhkj309r989ra90',
      getHashedApiKey: () => '786786423ghfp9-9',
      getName: () => 'test-key',
      getImsUserId: () => 'test-user-id',
      getImsOrgId: () => 'test-org',
      getCreatedAt: () => '2024-05-29T14:26:00.000Z',
      getExpiresAt: () => '2034-05-29T14:26:00.000Z',
      getDeletedAt: () => null,
      getRevokedAt: () => null,
      getScopes: () => [{ name: 'imports.read' }, { name: 'imports.write', domains: ['https://example.com'] }],
      isValid: () => true,
    };

    context = {
      log: console,
      dataAccess: {
        ApiKey: {
          allByImsOrgIdAndImsUserId: sinon.stub(),
          create: (data) => ({
            getId: () => '56',
            getCreatedAt: () => '2024-05-29T14:26:00.000Z',
            getExpiresAt: () => '2034-05-29T14:26:00.000Z',
            getDeletedAt: () => null,
            getRevokedAt: () => null,
            getImsUserId: () => 'some-id',
            getImsOrgId: () => 'test-org',
            getHashedApiKey: () => data.hashedApiKey,
            getName: () => data.name,
            getDomains: () => data.domains,
            getUrls: () => data.urls,
            getScopes: () => data.scopes,
          }),
          findById: sinon.stub(),
        },
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
        getImsUserProfile: sinon.stub().returns({ organizations: ['test-org'], email: 'test@email.com' }),
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
      requestContext.pathInfo.headers['x-gw-ims-org-id'] = '';
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_UNAUTHORIZED);
    });

    it('should throw an error if the organization is not found', async () => {
      context.imsClient.getImsUserProfile.returns({ organizations: [] });
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_UNAUTHORIZED);
    });

    it('should throw an error if bearer token is missing', async () => {
      requestContext.pathInfo.headers.authorization = '';
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_UNAUTHORIZED);
    });

    it('should create a new API key', async () => {
      context.dataAccess.ApiKey.allByImsOrgIdAndImsUserId.returns([]);
      const response = await apiKeyController.createApiKey({ ...requestContext });
      const responseJson = await response.json();
      expect(response.status).to.equal(STATUS_CREATED);
      expect(responseJson).to.have.property('apiKey');
    });

    it('should create a new API key if email is not present in the imsUserProfile', async () => {
      context.imsClient.getImsUserProfile.returns({ organizations: ['test-org'] });
      context.dataAccess.ApiKey.allByImsOrgIdAndImsUserId.returns([]);
      const response = await apiKeyController.createApiKey({ ...requestContext });
      const responseJson = await response.json();
      expect(response.status).to.equal(STATUS_CREATED);
      expect(responseJson).to.have.property('apiKey');
    });

    it('should create a new API key if the bearer prefix is missing', async () => {
      requestContext.pathInfo.headers.authorization = 'test-token';
      context.dataAccess.ApiKey.allByImsOrgIdAndImsUserId.returns([]);
      const response = await apiKeyController.createApiKey({ ...requestContext });
      const responseJson = await response.json();
      expect(response.status).to.equal(STATUS_CREATED);
      expect(responseJson).to.have.property('apiKey');
    });

    it('should throw an error if the number of domains exceeds the limit', async () => {
      requestContext.data.domains = ['https://example.com', 'https://another.com'];
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_FORBIDDEN);
      expect(response.headers.get('x-error')).to.equal('Invalid request: Exceeds the limit of 1 allowed domain(s)');
    });

    it('should throw an error if the user has reached the maximum number of API keys', async () => {
      context.dataAccess.ApiKey.allByImsOrgIdAndImsUserId
        .returns([exampleApiKey, exampleApiKey, exampleApiKey]);
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_FORBIDDEN);
      expect(response.headers.get('x-error')).to.equal('Invalid request: Exceeds the limit of 3 allowed API keys');
    });
  });

  describe('deleteApiKey', () => {
    it('should delete an API key', async () => {
      context.dataAccess.ApiKey.findById.returns({
        getImsUserId: () => 'test@example.com',
        getImsOrgId: () => 'test-org',
        setDeletedAt(deletedAt) { this.deletedAt = deletedAt; },
        updateDeletedAt: sinon.stub(),
        save: sinon.stub(),
      });

      const response = await apiKeyController.deleteApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_NO_CONTENT);
    });

    it('should throw an error if the API key is not found', async () => {
      context.dataAccess.ApiKey.findById.returns({
        getImsUserId: () => 'other@example.com',
        getImsOrgId: () => 'other-org',
      });

      const response = await apiKeyController.deleteApiKey({ ...requestContext });
      expect(response.status).to.equal(STATUS_NOT_FOUND);
    });
  });

  describe('getApiKeys', () => {
    it('should return all the API Keys', async () => {
      context.dataAccess.ApiKey.allByImsOrgIdAndImsUserId.returns([exampleApiKey]);
      const response = await apiKeyController.getApiKeys({ ...requestContext });
      const responseJson = await response.json();
      expect(response.status).to.equal(STATUS_OK);
      const expectedJson = {
        id: '56hjhkj309r989ra90',
        name: 'test-key',
        imsUserId: 'test-user-id',
        imsOrgId: 'test-org',
        expiresAt: '2034-05-29T14:26:00.000Z',
        createdAt: '2024-05-29T14:26:00.000Z',
        deletedAt: null,
        revokedAt: null,
        scopes: [{ name: 'imports.read' }, { name: 'imports.write', domains: ['https://example.com'] }],
      };
      expect(responseJson).to.deep.equal([expectedJson]);
    });

    it('should throw an error when getApiKeysByImsUserIdAndImsOrgId fails', async () => {
      context.dataAccess.ApiKey.allByImsOrgIdAndImsUserId.throws(new Error('Dynamo Error'));
      const response = await apiKeyController.getApiKeys({ ...requestContext });
      expect(response.status).to.equal(STATUS_INTERNAL_SERVER_ERROR);
    });
  });
});
