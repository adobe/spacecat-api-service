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
/* eslint-disable no-unused-expressions */ // expect statements

import { expect } from 'chai';
import { Request } from '@adobe/fetch';
import wrap from '@adobe/helix-shared-wrap';
import authWrapper, { ADMIN_ENDPOINTS } from '../../src/support/auth.js';
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

  it('no api key should', async () => {
    const resp = await action(new Request('https://space.cat/'), context);

    expect(resp.status).to.equal(401);
  });

  it('no api key should2', async () => {
    const resp = await action(new Request('https://space.cat/', {
      headers: {
        'x-api-key': 'wrong-key',
      },
    }), context);

    expect(resp.status).to.equal(401);
  });

  it('no api key should33', async () => {
    const resp = await action(new Request('https://space.cat/', {
      headers: {
        'x-api-key': context.env.USER_API_KEY,
      },
    }), context);

    expect(resp).to.equal(42);
  });

  it('no api key should3', async () => {
    context.pathInfo.suffix = `/${ADMIN_ENDPOINTS[0]}`;
    const resp = await action(new Request('https://space.cat/'), context);

    expect(resp.status).to.equal(401);
  });

  it('no api key should4', async () => {
    context.pathInfo.suffix = `/${ADMIN_ENDPOINTS[0]}`;
    const resp = await action(new Request('https://space.cat/', {
      headers: {
        'x-api-key': 'wrong-key',
      },
    }), context);

    expect(resp.status).to.equal(401);
  });

  it('no api key should5', async () => {
    context.pathInfo.suffix = `/${ADMIN_ENDPOINTS[0]}`;
    const resp = await action(new Request('https://space.cat/', {
      headers: {
        'x-api-key': context.env.ADMIN_API_KEY,
      },
    }), context);

    expect(resp).to.equal(42);
  });
});
