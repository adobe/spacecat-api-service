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

import { expect } from 'chai';
import { Request } from '@adobe/fetch';
import wrap from '@adobe/helix-shared-wrap';
import authWrapper from '../../src/support/auth.js';
import { enrichPathInfo } from '../../src/index.js';

describe('auth', () => {
  const action = wrap(() => 42)
    .with(authWrapper)
    .with(enrichPathInfo);

  let context;

  beforeEach('setup', () => {
    context = {
      log: console,
      pathInfo: {
        suffix: '',
      },
      env: {
        ADMIN_API_KEY: 'admin-key',
        USER_API_KEY: 'user-key',
      },
    };
  });

  it('no user key provided in env variables results in internal server error', async () => {
    context.env = {};
    const resp = await action(new Request('https://space.cat/', {
      headers: {
        'x-api-key': context.env.USER_API_KEY,
      },
    }), context);

    expect(await resp.text()).to.equal('Server configuration error');
    expect(resp.status).to.equal(500);
  });

  it('no admin key provided in env variables results in internal server error', async () => {
    context.env = {};
    context.pathInfo.suffix = '/trigger';
    const resp = await action(new Request('https://space.cat/', {
      headers: {
        'x-api-key': context.env.ADMIN_API_KEY,
      },
    }), context);

    expect(await resp.text()).to.equal('Server configuration error');
    expect(resp.status).to.equal(500);
  });

  it('no user api key in header results in bad request', async () => {
    const resp = await action(new Request('https://space.cat/'), context);

    expect(resp.status).to.equal(400);
  });

  it('wrong user api key in header results in unauthorized', async () => {
    const resp = await action(new Request('https://space.cat/', {
      headers: {
        'x-api-key': 'wrong-key',
      },
    }), context);

    expect(resp.status).to.equal(401);
  });

  it('correct user key invokes the user scoped handler', async () => {
    const resp = await action(new Request('https://space.cat/', {
      headers: {
        'x-api-key': context.env.USER_API_KEY,
      },
    }), context);

    expect(resp).to.equal(42);
  });

  it('no admin api key in header results in bad request', async () => {
    context.pathInfo.suffix = '/trigger';
    const resp = await action(new Request('https://space.cat/'), context);

    expect(resp.status).to.equal(400);
  });

  it('wrong admin api key in header results in unauthorized', async () => {
    context.pathInfo.suffix = '/trigger';
    const resp = await action(new Request('https://space.cat/', {
      headers: {
        'x-api-key': 'wrong-key',
      },
    }), context);

    expect(resp.status).to.equal(401);
  });

  it('correct admin key invokes the admin scoped handler', async () => {
    context.pathInfo.method = 'GET';
    context.pathInfo.suffix = '/trigger';
    const resp = await action(new Request('https://space.cat/', {
      headers: {
        'x-api-key': context.env.ADMIN_API_KEY,
      },
    }), context);

    expect(resp).to.equal(42);
  });
});
