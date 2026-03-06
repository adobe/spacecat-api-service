/*
 * Copyright 2025 Adobe. All rights reserved.
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

// eslint-disable-next-line import/no-extraneous-dependencies
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { Request } from '@adobe/fetch';
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { s2sAuthWrapper } from '@adobe/spacecat-shared-http-utils';
import routeRequiredCapabilities from '../src/routes/required-capabilities.js';

use(sinonChai);

const ISSUER = 'https://spacecat.experiencecloud.live';

describe('s2sAuthWrapper integration', () => {
  let keys;
  let publicKeyB64;
  let mockInnerHandler;
  let wrappedHandler;
  let logStub;

  before(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const publicKeyPEM = await exportSPKI(publicKey);
    publicKeyB64 = Buffer.from(publicKeyPEM).toString('base64');
    keys = { publicKey, privateKey };
  });

  beforeEach(() => {
    logStub = {
      debug: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };
    mockInnerHandler = sinon.stub().resolves(new Response('OK', { status: 200 }));
    wrappedHandler = s2sAuthWrapper(mockInnerHandler, {
      routeCapabilities: routeRequiredCapabilities,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  function buildContext(pathInfo = { method: 'GET', suffix: '/sites' }, headers = {}) {
    return {
      log: logStub,
      env: { AUTH_PUBLIC_KEY_B64: publicKeyB64 },
      pathInfo: {
        method: pathInfo.method || 'GET',
        suffix: pathInfo.suffix || '/sites',
        headers: headers.authorization ? { authorization: headers.authorization } : {},
      },
      dataAccess: {
        Consumer: {
          findByClientIdAndImsOrgId: sinon.stub(),
        },
      },
    };
  }

  async function createS2sToken(payloadOverrides = {}) {
    const payload = {
      is_s2s_consumer: true,
      client_id: 'test-s2s-client',
      org: 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg',
      ...payloadOverrides,
    };
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setExpirationTime('24h')
      .sign(keys.privateKey);
  }

  it('passes through to inner handler when no bearer token (e.g. API key request)', async () => {
    const request = new Request('https://example.com/sites', {
      method: 'GET',
      headers: { 'x-api-key': 'some-api-key' },
    });
    const context = buildContext();

    const response = await wrappedHandler(request, context);

    expect(response.status).to.equal(200);
    expect(mockInnerHandler).to.have.been.calledOnce;
    expect(mockInnerHandler.firstCall.args[1]).to.equal(context);
  });

  it('succeeds with s2sConsumer populated when valid S2S JWT hits mapped route with matching capability', async () => {
    const token = await createS2sToken();
    const request = new Request('https://example.com/sites', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const context = buildContext(
      { method: 'GET', suffix: '/sites' },
      { authorization: `Bearer ${token}` },
    );

    const mockConsumer = {
      isRevoked: () => false,
      getStatus: () => 'ACTIVE',
      getCapabilities: () => ['site:read'],
    };
    context.dataAccess.Consumer.findByClientIdAndImsOrgId.resolves(mockConsumer);

    const response = await wrappedHandler(request, context);

    expect(response.status).to.equal(200);
    expect(mockInnerHandler).to.have.been.calledOnce;
    expect(context.s2sConsumer).to.equal(mockConsumer);
  });

  it('returns 403 when valid S2S JWT hits unmapped route', async () => {
    const token = await createS2sToken();
    const request = new Request('https://example.com/slack/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const context = buildContext(
      { method: 'POST', suffix: '/slack/events' },
      { authorization: `Bearer ${token}` },
    );

    const mockConsumer = {
      isRevoked: () => false,
      getStatus: () => 'ACTIVE',
      getCapabilities: () => ['site:read'],
    };
    context.dataAccess.Consumer.findByClientIdAndImsOrgId.resolves(mockConsumer);

    const response = await wrappedHandler(request, context);

    expect(response.status).to.equal(403);
    expect(mockInnerHandler).to.not.have.been.called;
  });

  it('returns 403 when valid S2S JWT lacks required capability for route', async () => {
    const token = await createS2sToken();
    const request = new Request('https://example.com/sites', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const context = buildContext(
      { method: 'POST', suffix: '/sites' },
      { authorization: `Bearer ${token}` },
    );

    const mockConsumer = {
      isRevoked: () => false,
      getStatus: () => 'ACTIVE',
      getCapabilities: () => ['site:read'],
    };
    context.dataAccess.Consumer.findByClientIdAndImsOrgId.resolves(mockConsumer);

    const response = await wrappedHandler(request, context);

    expect(response.status).to.equal(403);
    expect(mockInnerHandler).to.not.have.been.called;
  });
});
