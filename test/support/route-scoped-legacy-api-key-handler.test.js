/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';
import sinon from 'sinon';

use(sinonChai);

/**
 * RouteScopedLegacyApiKeyHandler extends LegacyApiKeyHandler from
 * @adobe/spacecat-shared-http-utils. esmock replaces the imported
 * LegacyApiKeyHandler with a minimal stub so we exercise only the
 * route-scoping logic in isolation.
 */
async function loadHandler({ superCheckAuthStub } = {}) {
  return (await esmock(
    '../../src/support/route-scoped-legacy-api-key-handler.js',
    {
      '@adobe/spacecat-shared-http-utils': {
        LegacyApiKeyHandler: class StubLegacyApiKeyHandler {
          constructor(log) {
            this.name = 'legacyApiKey';
            this.log = (message, level) => log?.[level || 'info']?.(`[${this.name}] ${message}`);
          }

          // eslint-disable-next-line class-methods-use-this
          checkAuth(...args) {
            return superCheckAuthStub(...args);
          }
        },
      },
    },
  )).default;
}

describe('RouteScopedLegacyApiKeyHandler', () => {
  let superCheckAuthStub;
  let HandlerClass;
  let handler;
  let logStubs;

  beforeEach(async () => {
    superCheckAuthStub = sinon.stub().resolves('SUPER_RESULT');
    HandlerClass = await loadHandler({ superCheckAuthStub });
    logStubs = {
      debug: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };
    handler = new HandlerClass(logStubs);
  });

  // --- scoped routes: must delegate to parent ---

  it('delegates to LegacyApiKeyHandler.checkAuth for POST /event/fulfillment', async () => {
    const req = {};
    const ctx = { pathInfo: { method: 'POST', suffix: '/event/fulfillment' }, log: logStubs };
    const result = await handler.checkAuth(req, ctx);
    expect(result).to.equal('SUPER_RESULT');
    expect(superCheckAuthStub).to.have.been.calledOnceWith(req, ctx);
  });

  it('delegates to LegacyApiKeyHandler.checkAuth for POST /slack/channels/invite-by-user-id', async () => {
    const req = {};
    const ctx = { pathInfo: { method: 'POST', suffix: '/slack/channels/invite-by-user-id' }, log: logStubs };
    const result = await handler.checkAuth(req, ctx);
    expect(result).to.equal('SUPER_RESULT');
    expect(superCheckAuthStub).to.have.been.calledOnceWith(req, ctx);
  });

  // --- success logging ---

  it('emits an info log when auth succeeds on POST /event/fulfillment', async () => {
    superCheckAuthStub.resolves({ getType: () => 'legacyApiKey' });
    await handler.checkAuth({}, { pathInfo: { method: 'POST', suffix: '/event/fulfillment' }, log: logStubs });
    expect(logStubs.info).to.have.been.calledOnceWithExactly(
      '[legacyApiKey] request authenticated via route-scoped legacy API key handler [POST /event/fulfillment]',
    );
  });

  it('emits an info log when auth succeeds on POST /slack/channels/invite-by-user-id', async () => {
    superCheckAuthStub.resolves({ getType: () => 'legacyApiKey' });
    await handler.checkAuth({}, { pathInfo: { method: 'POST', suffix: '/slack/channels/invite-by-user-id' }, log: logStubs });
    expect(logStubs.info).to.have.been.calledOnceWithExactly(
      '[legacyApiKey] request authenticated via route-scoped legacy API key handler [POST /slack/channels/invite-by-user-id]',
    );
  });

  it('does NOT emit the success log when super.checkAuth returns null (auth failed)', async () => {
    superCheckAuthStub.resolves(null);
    await handler.checkAuth({}, { pathInfo: { method: 'POST', suffix: '/event/fulfillment' } });
    expect(logStubs.info).to.not.have.been.called;
  });

  // --- out-of-scope routes: must return null without calling super ---

  it('returns null without calling super for GET /trigger', async () => {
    const ctx = { pathInfo: { method: 'GET', suffix: '/trigger' } };
    const result = await handler.checkAuth({}, ctx);
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

  it('returns null without calling super for POST /sites', async () => {
    const ctx = { pathInfo: { method: 'POST', suffix: '/sites' } };
    const result = await handler.checkAuth({}, ctx);
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

  it('returns null without calling super for GET /sites', async () => {
    const ctx = { pathInfo: { method: 'GET', suffix: '/sites' } };
    const result = await handler.checkAuth({}, ctx);
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

  it('returns null without calling super for POST /tools/api-keys', async () => {
    const ctx = { pathInfo: { method: 'POST', suffix: '/tools/api-keys' } };
    const result = await handler.checkAuth({}, ctx);
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

  it('returns null for GET /event/fulfillment (wrong method, same path)', async () => {
    const ctx = { pathInfo: { method: 'GET', suffix: '/event/fulfillment' } };
    const result = await handler.checkAuth({}, ctx);
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

  it('returns null for GET /slack/channels/invite-by-user-id (wrong method)', async () => {
    const ctx = { pathInfo: { method: 'GET', suffix: '/slack/channels/invite-by-user-id' } };
    const result = await handler.checkAuth({}, ctx);
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

  // --- edge cases ---

  it('returns null when context.pathInfo is missing', async () => {
    const result = await handler.checkAuth({}, {});
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

  it('returns null when context is undefined', async () => {
    const result = await handler.checkAuth({});
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

  it('returns null when method and suffix are missing', async () => {
    const ctx = { pathInfo: {} };
    const result = await handler.checkAuth({}, ctx);
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

  it('propagates exceptions from super.checkAuth without catching', async () => {
    superCheckAuthStub.rejects(new Error('key validation failed'));
    const ctx = { pathInfo: { method: 'POST', suffix: '/event/fulfillment' } };
    await expect(handler.checkAuth({}, ctx)).to.be.rejectedWith('key validation failed');
  });
});
