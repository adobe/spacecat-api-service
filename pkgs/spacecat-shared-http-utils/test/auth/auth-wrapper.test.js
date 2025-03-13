/*
 * Copyright 2023 Adobe. All rights reserved.
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

import { Request } from '@adobe/fetch';
import wrap from '@adobe/helix-shared-wrap';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';

import { authWrapper, enrichPathInfo } from '../../src/index.js';
import AbstractHandler from '../../src/auth/handlers/abstract.js';

use(chaiAsPromised);

describe('auth wrapper', () => {
  const DummyHandler = class extends AbstractHandler {
    constructor(log) {
      super('dummy', log);
    }

    // eslint-disable-next-line class-methods-use-this,no-unused-vars
    async checkAuth(request, context) {
      return context.pathInfo.headers['x-api-key'] === 'test' ? { type: 'dummy' } : null;
    }
  };

  const action = wrap(() => 42)
    .with(authWrapper, { authHandlers: [DummyHandler] })
    .with(enrichPathInfo);

  let context;
  let mockApiKey;

  beforeEach('setup', () => {
    context = {
      attributes: {},
      log: console,
      pathInfo: {
        suffix: '',
      },
    };
    mockApiKey = {
      getId: () => 'test-id',
      getApiKeyId: () => 'xxx-yyy-zzz',
      getExpiresAt: () => null,
      getImsUserId: () => 'aaa@bbb.c',
      getImsOrgId: () => 'B00BAA@AdobeOrg',
      getRevokedAt: () => null,
      getHashedApiKey: () => '372c6ba5a67b01a8d6c45e5ade6b41db9586ca06c77f0ef7795dfe895111fd0b',
      getName: () => 'Test API key name',
      getScopes: () => [
        {
          name: 'imports.write',
          domains: ['https://www.example.com'],
        },
      ],
    };
  });

  it('throws error if no auth handler is provided', async () => {
    const fn = wrap(() => 42)
      .with(authWrapper)
      .with(enrichPathInfo);

    const resp = await fn(new Request('https://space.cat/slack/events'), context);

    expect(await resp.text()).to.equal('Server error');
    expect(resp.status).to.equal(500);
  });

  it('passes anonymous route', async () => {
    context.pathInfo.suffix = '/slack/events';

    const resp = await action(new Request('https://space.cat/slack/events'), context);

    expect(resp).to.equal(42);
    expect(context.attributes.authInfo).to.be.undefined;
  });

  it('passes options method', async () => {
    context.pathInfo.method = 'OPTIONS';
    context.pathInfo.suffix = '/sites';

    const resp = await action(new Request('https://space.cat/sites', { method: 'OPTIONS' }), context);

    expect(resp).to.deep.equal(42);
    expect(context.attributes.authInfo).to.be.undefined;
  });

  it('successful authentication key invokes the user scoped handler', async () => {
    expect(context.attributes.authInfo).to.be.undefined;

    const resp = await action(new Request('https://space.cat/', {
      headers: { 'x-api-key': 'test' },
    }), context);

    expect(resp).to.equal(42);
    expect(context.attributes.authInfo).to.deep.equal({ type: 'dummy' });
  });

  it('unsuccessful authentication results in unauthorized', async () => {
    const resp = await action(new Request('https://space.cat/', {
      headers: { 'x-api-key': 'wrong-key' },
    }), context);

    expect(await resp.text()).to.equal('Unauthorized');
    expect(resp.status).to.equal(401);
  });

  it('should add auth.checkScopes to the context', async () => {
    async function mockGetAcls({ imsUserId, imsOrgs, apiKey }) {
      if (imsUserId === 'aaa@bbb.c' && imsOrgs[0] === 'B00BAA@AdobeOrg' && apiKey === 'xxx-yyy-zzz') {
        return {
          aclEntities: { exclude: ['myentity'] },
        };
      }
      throw new Error('Unexpected arguments');
    }

    const ScopedApiKeyHandler = await esmock('../../src/auth/handlers/scoped-api-key.js', {
      '../../src/auth/rbac/acls.js': mockGetAcls,
      '@adobe/spacecat-shared-data-access/src/index.js': {
        createDataAccess: () => ({ ApiKey: { findByHashedApiKey: async () => mockApiKey } }),
      },
    });

    const scopedAction = wrap(() => 42)
      .with(authWrapper, { authHandlers: [ScopedApiKeyHandler] })
      .with(enrichPathInfo);

    const resp = await scopedAction(new Request('https://space.cat/', {
      headers: { 'x-api-key': 'test-api-key' },
    }), context);

    expect(resp).to.equal(42);
    expect(context.auth.checkScopes).to.be.a('function');

    // Throws an error if checkScopes check fails
    context.auth.checkScopes(['imports.write']);

    const expectedError = 'API key is missing the [scope-user-does-not-have] scope(s) required for this resource';
    expect(() => context.auth.checkScopes(['scope-user-does-not-have'])).to.throw(expectedError);

    expect(context.attributes.authInfo.rbac.aclEntities.exclude).to.deep.equal(['myentity']);
  });
});
