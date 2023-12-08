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
import { expect } from 'chai';
import nock from 'nock';

import { main } from '../src/index.js';

const baseUrl = 'https://base.spacecat';

describe('Index Tests', () => {
  const apiKey = 'api-key';
  const slackBotToken = 'slack-bot-token';
  const slackSigningSecret = 'slack-signing-secret';

  let context;
  let request;

  beforeEach('setup', () => {
    context = {
      boltApp: {

      },
      log: console,
      runtime: {
        region: 'us-east-1',
      },
      pathInfo: {
        suffix: '',
      },
      env: {
        USER_API_KEY: apiKey,
        ADMIN_API_KEY: apiKey,
        SLACK_BOT_TOKEN: slackBotToken,
        SLACK_SIGNING_SECRET: slackSigningSecret,
      },
      dataAccess: { },
    };
    request = new Request(baseUrl, {
      headers: {
        'x-api-key': apiKey,
      },
    });
  });

  it('sends 404 for missing suffix', async () => {
    delete context.pathInfo.suffix;
    const resp = await main(request, context);

    expect(resp.status).to.equal(404);
    expect(resp.headers.plain()['x-error']).to.equal('wrong path format');
  });

  it('throws error when slack signing secret is missing', async () => {
    context.pathInfo.suffix = '/test';
    delete context.env.SLACK_SIGNING_SECRET;

    const resp = await main(request, context);

    expect(resp.status).to.equal(500);
    expect(resp.headers.plain()['x-error']).to.equal('internal server error: Missing SLACK_SIGNING_SECRET');
  });

  it('throws error when slack bot token is missing', async () => {
    context.pathInfo.suffix = '/test';
    delete context.env.SLACK_BOT_TOKEN;

    const resp = await main(request, context);

    expect(resp.status).to.equal(500);
    expect(resp.headers.plain()['x-error']).to.equal('internal server error: Missing SLACK_BOT_TOKEN');
  });

  it('initializes the slack bot', async () => {
    context.pathInfo.suffix = '/test';
    delete context.boltApp;

    nock('https://slack.com', { reqheaders: { authorization: `Bearer ${slackBotToken}` } })
      .post('/api/auth.test')
      .reply(200, {
        ok: true,
        ts: '123',
      });

    const resp = await main(request, context);

    expect(context.boltApp).to.not.be.undefined;
    expect(context.boltApp).to.have.property('use');
    expect(context.boltApp).to.have.property('event');
    expect(context.boltApp).to.have.property('processEvent');

    await context.boltApp.middleware[2]({ context, next: () => true });

    expect(resp.status).to.equal(404);
    expect(resp.headers.plain()['x-error']).to.equal('no such route /test');
  });

  it('handles options request', async () => {
    context.pathInfo.suffix = '/test';

    request = new Request(baseUrl, { method: 'OPTIONS', headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(204);
    expect(resp.headers.plain()).to.eql({
      'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS, DELETE',
      'access-control-allow-headers': 'x-api-key',
      'access-control-max-age': '86400',
      'content-type': 'application/json; charset=utf-8',
    });
  });

  it('returns 404 when unknown route', async () => {
    context.pathInfo.suffix = '/unknown-handler';
    const resp = await main(request, context);

    expect(resp.status).to.equal(404);
    expect(resp.headers.plain()['x-error']).to.equal('no such route /unknown-handler');
  });

  it('handles errors', async () => {
    context.pathInfo.suffix = '/trigger';

    request = new Request(`${baseUrl}/trigger?url=all&type=cwv`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(500);
    expect(resp.headers.plain()['x-error']).to.equal('internal server error: Failed to trigger cwv audit for all');
  });

  it('handles dynamic route errors', async () => {
    context.pathInfo.suffix = '/sites/123';

    request = new Request(`${baseUrl}/sites/123`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(500);
    expect(resp.headers.plain()['x-error']).to.equal('internal server error: dataAccess.getSiteByID is not a function');
  });
});
