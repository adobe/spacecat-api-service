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
          'x-gw-ims-org-id': 'test-org',
        },
      },
      data: {
        name: 'test-key',
        feature: 'imports',
        domains: ['example.com'],
      },
      params: {
        id: '56hjhkj309r989ra90',
      },
    };

    context = {
      log: console,
    };
    apiKeyController = ApiKeyController(context);
  });

  describe('createApiKey', () => {
    it('should throw a not implemented error', async () => {
      const response = await apiKeyController.createApiKey({ ...requestContext });
      expect(response.status).to.equal(501);
    });
  });

  describe('deleteApiKey', () => {
    it('should throw a not implemented error', async () => {
      const response = await apiKeyController.deleteApiKey({ ...requestContext });
      expect(response.status).to.equal(501);
    });
  });

  describe('getApiKeys', () => {
    it('should throw a not implemented error', async () => {
      const response = await apiKeyController.getApiKeys({ ...requestContext });
      expect(response.status).to.equal(501);
    });
  });
});
