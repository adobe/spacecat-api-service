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
import esmock from 'esmock';

import AbstractHandler from '../../../src/auth/handlers/abstract.js';
import AuthInfo from '../../../src/auth/auth-info.js';

const dataAccess = { dataAccess: {} };
const ScopedApiKeyHandler = await esmock('../../../src/auth/handlers/scoped-api-key.js', {
  '@adobe/spacecat-shared-data-access/src/index.js': {
    createDataAccess: () => dataAccess.dataAccess,
  },
  // Mock out the getAcls call done by the handler to always return an empty object
  '../../../src/auth/rbac/acls.js': () => ({}),
});

use(chaiAsPromised);

describe('ScopedApiKeyHandler', () => {
  let logStub;
  let handler;

  let mockContext;

  const baseApiKeyData = {
    getHashedApiKey: () => '372c6ba5a67b01a8d6c45e5ade6b41db9586ca06c77f0ef7795dfe895111fd0b',
    getId: () => '1C4ED8DE-8ECD-42E1-9812-AF34082FB1B4',
    getApiKeyId: () => 'abcd-efgh-ijkl-mnop',
    getName: () => 'Test api key',
    getExpiresAt: () => null,
    getImsUserId: () => '999@888.e',
    getImsOrgId: () => '314159@AdobeOrg',
    getRevokedAt: () => null,
    getScopes: () => [
      {
        name: 'imports.write',
        domains: ['https://example.com'],
      },
      {
        name: 'sites.read_all',
        domains: ['https://example.com'],
      },
    ],
  };

  beforeEach(() => {
    dataAccess.dataAccess = {
      ApiKey: { findByHashedApiKey: sinon.stub().resolves(baseApiKeyData) },
    };
    logStub = {
      debug: sinon.stub(),
      info: sinon.stub(),
      error: sinon.stub(),
    };
    handler = new ScopedApiKeyHandler(logStub);

    mockContext = {
      pathInfo: {
        headers: {
          'x-api-key': 'test-scoped-api-key',
        },
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should be an instance of AbstractHandler', () => {
    expect(handler).to.be.instanceof(AbstractHandler);
  });

  it('should set the name and log properties correctly', () => {
    expect(handler.name).to.equal('scopedApiKey');
    expect(handler.logger).to.equal(logStub);
  });

  it('should log messages correctly', () => {
    handler.log('test message', 'info');
    expect(logStub.info.calledWith('[scopedApiKey] test message')).to.be.true;
  });

  it('should return null if no API key is provided in the request headers', async () => {
    const context = {
      ...mockContext,
      pathInfo: {
        headers: {},
      },
    };

    const result = await handler.checkAuth({}, context);
    expect(result).to.be.null;
  });

  it('should return null if no API key entity is found in the data layer', async () => {
    dataAccess.dataAccess = {
      ApiKey: { findByHashedApiKey: sinon.stub().resolves(null) },
    };

    const result = await handler.checkAuth({}, mockContext);
    expect(result).to.be.null;
    expect(logStub.error.getCall(0).args[0]).to.equal('[scopedApiKey] No API key entity found in the data layer for the provided API key: test-scoped-api-key');
  });

  it('should return null if the API key has expired', async () => {
    dataAccess.dataAccess = {
      ApiKey: {
        findByHashedApiKey: sinon.stub().resolves({
          ...baseApiKeyData,
          getExpiresAt: () => '2024-01-01T16:23:00.000Z',
        }),
      },
    };
    const result = await handler.checkAuth({}, mockContext);
    expect(result).to.be.instanceof(AuthInfo);
    expect(result.isAuthenticated()).to.be.false;
    expect(result.getReason()).to.equal('API key has expired');
    expect(logStub.error.getCall(0).args[0]).to.equal('[scopedApiKey] API key has expired. Name: Test api key, id: 1C4ED8DE-8ECD-42E1-9812-AF34082FB1B4');
  });

  it('should return null if the API key has been revoked', async () => {
    dataAccess.dataAccess = {
      ApiKey: {
        findByHashedApiKey: sinon.stub().resolves({
          ...baseApiKeyData,
          getRevokedAt: () => '2024-08-01T10:00:00.000Z',
        }),
      },
    };

    const result = await handler.checkAuth({}, mockContext);
    expect(result).to.be.instanceof(AuthInfo);
    expect(result.isAuthenticated()).to.be.false;
    expect(result.getReason()).to.equal('API key has been revoked');
    expect(logStub.error.getCall(0).args[0]).to.equal('[scopedApiKey] API key has been revoked. Name: Test api key id: 1C4ED8DE-8ECD-42E1-9812-AF34082FB1B4');
  });

  it('should return an AuthInfo object for a valid key', async () => {
    const result = await handler.checkAuth({}, mockContext);
    expect(result).to.be.instanceof(AuthInfo);
    expect(result.type).to.equal('scopedApiKey');
    expect(result.isAuthenticated()).to.be.true;
    expect(result.getScopes()).to.deep.equal([
      {
        name: 'imports.write',
        domains: ['https://example.com'],
      },
      {
        name: 'sites.read_all',
        domains: ['https://example.com'],
      },
    ]);
    expect(result.getProfile().getId()).to.equal('1C4ED8DE-8ECD-42E1-9812-AF34082FB1B4');
    expect(result.getProfile().getScopes()[0].name).to.equal('imports.write');
    expect(result.getProfile().getScopes()[1].name).to.equal('sites.read_all');
    expect(result.getProfile().getHashedApiKey()).to.equal('372c6ba5a67b01a8d6c45e5ade6b41db9586ca06c77f0ef7795dfe895111fd0b');
  });
});
