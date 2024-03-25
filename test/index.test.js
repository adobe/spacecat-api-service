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
import { createAudit } from '@adobe/spacecat-shared-data-access/src/models/audit.js';
import { expect } from 'chai';
import sinon from 'sinon';

import { main } from '../src/index.js';

const baseUrl = 'https://base.spacecat';

describe('Index Tests', () => {
  const apiKey = 'api-key';
  const slackBotToken = 'slack-bot-token';
  const slackSigningSecret = 'slack-signing-secret';

  let context;
  let request;

  const mockAuditData = {
    siteId: '123',
    auditType: 'lhs-mobile',
    auditedAt: '2023-12-16T09:21:09.000Z',
    isLive: true,
    fullAuditRef: 'https://example.com',
    auditResult: {
      runtimeError: {},
      scores: {
        performance: 0.9,
        seo: 0.8,
        accessibility: 0.7,
        'best-practices': 0.6,
      },
    },
  };

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
      dataAccess: {
        getSitesWithLatestAudit: sinon.stub().resolves([]),
        getAuditForSite: sinon.stub().resolves(createAudit(mockAuditData)),
      },
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

  it('handles options request', async () => {
    context.pathInfo.suffix = '/test';

    request = new Request(baseUrl, { method: 'OPTIONS', headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(204);
    expect(resp.headers.plain()).to.eql({
      'access-control-allow-methods': 'GET, HEAD, PATCH, POST, OPTIONS, DELETE',
      'access-control-allow-headers': 'x-api-key, origin, x-requested-with, content-type, accept',
      'access-control-max-age': '86400',
      'access-control-allow-origin': '*',
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

    request = new Request(`${baseUrl}/trigger?url=all&type=404`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(500);
    expect(resp.headers.plain()['x-error']).to.equal('Failed to trigger 404 audit for all');
  });

  it('handles dynamic route errors', async () => {
    context.pathInfo.suffix = '/sites/123';

    request = new Request(`${baseUrl}/sites/123`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(500);
    expect(resp.headers.plain()['x-error']).to.equal('dataAccess.getSiteByID is not a function');
  });

  it('handles dynamic route', async () => {
    context.pathInfo.suffix = '/sites/with-latest-audit/lhs-mobile';

    request = new Request(`${baseUrl}/sites/with-latest-audit/lhs-mobile`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(200);
    expect(context.dataAccess.getSitesWithLatestAudit.calledOnce).to.be.true;
  });

  it('handles dynamic route with three params', async () => {
    context.pathInfo.suffix = '/sites/1-2-3-4/audits/lhs-mobile/2023-12-17T00:50:39.470Z';

    request = new Request(`${baseUrl}/sites/1-2-3-4/audits/lhs-mobile/2023-12-17T00:50:39.470Z`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(200);
    expect(context.dataAccess.getAuditForSite.calledOnce).to.be.true;
  });
});
