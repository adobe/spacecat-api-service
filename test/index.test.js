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
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import { main } from '../src/index.js';

use(sinonChai);

const baseUrl = 'https://base.spacecat';

describe('Index Tests', () => {
  const apiKey = 'api-key';
  const slackBotToken = 'slack-bot-token';
  const slackSigningSecret = 'slack-signing-secret';

  let context;
  let request;

  const mockAuditData = {
    getSiteId: () => '123',
    getAuditType: () => 'lhs-mobile',
    getAuditedAt: () => '2023-12-16T09:21:09.000Z',
    getIsError: () => false,
    getIsLive: () => true,
    getFullAuditRef: () => 'https://example.com',
    getAuditResult: () => ({
      runtimeError: {},
      scores: {
        performance: 0.9,
        seo: 0.8,
        accessibility: 0.7,
        'best-practices': 0.6,
      },
    }),
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
        SLACK_OPS_CHANNEL_WORKSPACE_EXTERNAL: 'mock-external-channel',
        SLACK_TOKEN_WORKSPACE_EXTERNAL_ELEVATED: 'mock-elevated-external-token',
        IMS_HOST: 'mock-ims-host.example.com',
        IMS_CLIENT_ID: 'mock-client-id',
        IMS_CLIENT_CODE: 'mock-client-code',
        IMS_CLIENT_SECRET: 'mock-client-secret',
        IMPORT_CONFIGURATION: '{}',
      },
      dataAccess: {
        Audit: {
          findBySiteIdAndAuditTypeAndAuditedAt: sinon.stub().resolves(mockAuditData),
        },
        Organization: {
          findById: sinon.stub().resolves({
            getId: () => 'default',
            getName: () => 'default',
            getImsOrgId: () => 'default',
            getCreatedAt: () => '2023-12-16T09:21:09.000Z',
            getUpdatedAt: () => '2023-12-16T09:21:09.000Z',
            getConfig: () => ({
              getSlackConfig: () => {},
              getHandlers: () => {},
              getImports: () => [],
            }),
          }),
        },
        Site: {
          allWithLatestAudit: sinon.stub().resolves([]),
        },
        Opportunity: {},
        Suggestion: {},
      },
      s3Client: {
        send: sinon.stub(),
      },
      sqsClient: {
        sendMessage: sinon.stub(),
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
      'access-control-allow-headers': 'x-api-key, authorization, origin, x-requested-with, content-type, accept, x-import-api-key',
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

    request = new Request(`${baseUrl}/trigger?url=all&type=cwv`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(500);
    expect(resp.headers.plain()['x-error']).to.equal('Failed to trigger cwv audit for all');
  });

  it('handles siteId not correctly formated error', async () => {
    context.pathInfo.suffix = '/sites/"e730ec12-4325-4bdd-ac71-0f4aa5b18cff"';

    request = new Request(`${baseUrl}/sites/"e730ec12-4325-4bdd-ac71-0f4aa5b18cff"`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(400);
    expect(resp.headers.plain()['x-error']).to.equal('Site Id is invalid. Please provide a valid UUID.');
  });

  it('handles organizationId not correctly formated error', async () => {
    context.pathInfo.suffix = '/organizations/1234';

    request = new Request(`${baseUrl}/organizations/1234`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(400);
    expect(resp.headers.plain()['x-error']).to.equal('Organization Id is invalid. Please provide a valid UUID.');
  });

  it('handles dynamic route errors', async () => {
    context.pathInfo.suffix = '/sites/e730ec12-4325-4bdd-ac71-0f4aa5b18cff';

    request = new Request(`${baseUrl}/sites/e730ec12-4325-4bdd-ac71-0f4aa5b18cff`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(500);
    expect(resp.headers.plain()['x-error']).to.equal('Site.findById is not a function');
  });

  it('handles dynamic route', async () => {
    context.pathInfo.suffix = '/sites/with-latest-audit/lhs-mobile';

    request = new Request(`${baseUrl}/sites/with-latest-audit/lhs-mobile`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(200);
    expect(context.dataAccess.Site.allWithLatestAudit).to.have.been.calledOnce;
  });

  it('handles dynamic route with three params', async () => {
    context.pathInfo.suffix = '/sites/e730ec12-4325-4bdd-ac71-0f4aa5b18cff/audits/lhs-mobile/2023-12-17T00:50:39.470Z';

    request = new Request(`${baseUrl}/sites/e730ec12-4325-4bdd-ac71-0f4aa5b18cff/audits/lhs-mobile/2023-12-17T00:50:39.470Z`, { headers: { 'x-api-key': apiKey } });

    const resp = await main(request, context);

    expect(resp.status).to.equal(200);
    expect(context.dataAccess.Audit.findBySiteIdAndAuditTypeAndAuditedAt).to.have.been.calledOnce;
  });
});
