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

import { expect, use } from 'chai';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';

import LegacyApiKeyHandler from '../../../src/auth/handlers/legacy-api-key.js';
import AbstractHandler from '../../../src/auth/handlers/abstract.js';
import AuthInfo from '../../../src/auth/auth-info.js';

use(chaiAsPromised);

describe('LegacyApiKeyHandler', () => {
  let logStub;
  let handler;

  const mockContext = (route, userApiKey, adminApiKey) => ({
    env: {
      USER_API_KEY: userApiKey,
      ADMIN_API_KEY: adminApiKey,
    },
    pathInfo: {
      route,
      headers: {
        'x-api-key': 'valid-user-key',
      },
    },
  });

  beforeEach(() => {
    logStub = {
      debug: sinon.stub(),
      info: sinon.stub(),
      error: sinon.stub(),
    };
    handler = new LegacyApiKeyHandler(logStub);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should be an instance of AbstractHandler', () => {
    expect(handler).to.be.instanceof(AbstractHandler);
  });

  it('should set the name and log properties correctly', () => {
    expect(handler.name).to.equal('legacyApiKey');
    expect(handler.logger).to.equal(logStub);
  });

  it('should log messages correctly', () => {
    handler.log('test message', 'info');
    expect(logStub.info.calledWith('[legacyApiKey] test message')).to.be.true;
  });

  it('should return null if API keys are not configured', async () => {
    const request = {};
    const context = mockContext('GET /some-endpoint', '', '');

    const result = await handler.checkAuth(request, context);
    expect(result).to.be.null;
    expect(logStub.error.calledWith('[legacyApiKey] API keys were not configured')).to.be.true;
  });

  it('should return null if no API key is provided in the request headers', async () => {
    const request = {};
    const context = {
      env: {
        USER_API_KEY: 'user-key',
        ADMIN_API_KEY: 'admin-key',
      },
      pathInfo: {
        route: 'GET /some-endpoint',
        headers: {},
      },
    };

    const result = await handler.checkAuth(request, context);
    expect(result).to.be.null;
  });

  it('returns auth info for valid user API key', async () => {
    const request = {};
    const context = mockContext('GET /some-endpoint', 'valid-user-key', 'valid-admin-key');

    const result = await handler.checkAuth(request, context);
    expect(result).to.be.instanceof(AuthInfo);
    expect(result.authenticated).to.be.true;
    expect(result.type).to.equal('legacyApiKey');
    expect(result.profile).to.deep.equal({ user_id: 'legacy-user' });
  });

  it('returns auth info for valid admin API key', async () => {
    const request = {};
    const context = mockContext('GET /trigger', 'valid-user-key', 'valid-admin-key');
    context.pathInfo.headers['x-api-key'] = 'valid-admin-key';

    const result = await handler.checkAuth(request, context);
    expect(result).to.be.instanceof(AuthInfo);
    expect(result.authenticated).to.be.true;
    expect(result.type).to.equal('legacyApiKey');
    expect(result.profile).to.deep.equal({ user_id: 'admin' });
  });

  it('returns null for invalid API key', async () => {
    const request = {};
    const context = mockContext('GET /some-endpoint', 'valid-user-key', 'valid-admin-key');
    context.pathInfo.headers['x-api-key'] = 'invalid-key';

    const result = await handler.checkAuth(request, context);
    expect(result).to.be.null;
  });

  it('returns null for user API key on admin endpoint', async () => {
    const request = {};
    const context = mockContext('POST /sites', 'valid-user-key', 'valid-admin-key');
    context.pathInfo.headers['x-api-key'] = 'valid-user-key';

    const result = await handler.checkAuth(request, context);
    expect(result).to.be.null;
  });
});
