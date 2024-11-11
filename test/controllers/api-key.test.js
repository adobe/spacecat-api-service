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

/* eslint-env mocha */

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import ApiKeyController from '../../src/controllers/api-key.js';

use(sinonChai);
use(chaiAsPromised);

describe('ApiKeyController tests', () => {
  let context;
  let apiKeyController;
  let requestContext = {};

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
        domains: ['example.com'],
        urls: ['https://example.com'],
      },
      params: {
        id: '56hjhkj309r989ra90',
      },
    };

    context = {
      log: console,
      dataAccess: {
        getApiKeysByImsOrgIdAndImsUserId: sinon.stub(),
        createApiKey: sinon.stub(),
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
    it('should create a new API key', async () => {
      context.dataAccess.getApiKeysByImsOrgIdAndImsUserId.returns([]);
      context.dataAccess.createApiKey.returns({
        id: 'new-api-key-id',
        name: 'test-key',
        scopes: [{ name: 'imports.read' }, { name: 'imports.write', domains: 'example.com' }],
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        imsOrgId: 'test-org',
        imsUserId: 'test@example.com',
        hashedApiKey: 'hashed-api-key',
        status: 'ACTIVE',
      });

      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(201);
      expect(response.body.apiKey).to.exist;
    });

    it('should throw an error if the number of domains exceeds the limit', async () => {
      requestContext.data.domains = ['example.com', 'another.com'];
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(403);
    });

    it('should throw an error if the user has reached the maximum number of API keys', async () => {
      context.dataAccess.getApiKeysByImsOrgIdAndImsUserId.returns([{ status: 'ACTIVE' }, { status: 'ACTIVE' }, { status: 'ACTIVE' }]);
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(403);
    });
  });

  describe('deleteApiKey', () => {
    it('should delete an API key', async () => {
      context.dataAccess.getApiKeyById.returns({
        getImsUserId: () => 'test@example.com',
        getImsOrgId: () => 'test-org',
        setStatus: sinon.stub(),
        setDeletedAt: sinon.stub(),
      });

      const response = await apiKeyController.deleteApiKey({ ...requestContext });
      expect(response.status).to.equal(204);
    });

    it('should throw an error if the API key is not found', async () => {
      context.dataAccess.getApiKeyById.returns({
        getImsUserId: () => 'other@example.com',
        getImsOrgId: () => 'other-org',
      });

      const response = await apiKeyController.deleteApiKey({ ...requestContext });
      expect(response.status).to.equal(403);
    });
  });

  describe('getApiKeys', () => {
    it('should return a 501 status code', async () => {
      const response = await apiKeyController.getApiKeys({ ...requestContext });
      expect(response.status).to.equal(501);
    });
  });
});
