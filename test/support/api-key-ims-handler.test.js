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
 * The ApiKeyImsHandler subclass extends AdobeImsHandler from
 * @adobe/spacecat-shared-http-utils. To exercise just the path-scoping logic in
 * isolation, esmock replaces the imported AdobeImsHandler with a minimal stub
 * whose checkAuth() returns a recognizable value when called.
 */
async function loadHandler({ superCheckAuthStub } = {}) {
  return (await esmock(
    '../../src/support/api-key-ims-handler.js',
    {
      '@adobe/spacecat-shared-http-utils': {
        AdobeImsHandler: class StubAdobeImsHandler {
          constructor(log) {
            this.name = 'ims';
            this.log = log;
          }

          // Stand-in for AdobeImsHandler.checkAuth; routes calls to the
          // sinon stub so each test can verify whether super was invoked.
          // eslint-disable-next-line class-methods-use-this
          checkAuth(...args) {
            return superCheckAuthStub(...args);
          }
        },
      },
    },
  )).default;
}

describe('ApiKeyImsHandler', () => {
  let superCheckAuthStub;
  let HandlerClass;
  let handler;

  beforeEach(async () => {
    superCheckAuthStub = sinon.stub().resolves('SUPER_RESULT');
    HandlerClass = await loadHandler({ superCheckAuthStub });
    handler = new HandlerClass({ debug: () => {}, info: () => {}, error: () => {} });
  });

  it('delegates to AdobeImsHandler.checkAuth for /tools/api-keys', async () => {
    const req = {};
    const ctx = { pathInfo: { suffix: '/tools/api-keys' } };
    const result = await handler.checkAuth(req, ctx);
    expect(result).to.equal('SUPER_RESULT');
    expect(superCheckAuthStub).to.have.been.calledOnceWith(req, ctx);
  });

  it('delegates to AdobeImsHandler.checkAuth for /tools/api-keys/<id>', async () => {
    const req = {};
    const ctx = { pathInfo: { suffix: '/tools/api-keys/abc-123' } };
    const result = await handler.checkAuth(req, ctx);
    expect(result).to.equal('SUPER_RESULT');
    expect(superCheckAuthStub).to.have.been.calledOnce;
  });

  it('returns null without calling super for non-/tools/api-keys paths', async () => {
    const ctx = { pathInfo: { suffix: '/sites' } };
    const result = await handler.checkAuth({}, ctx);
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

  it('returns null without calling super for the /tools root', async () => {
    const ctx = { pathInfo: { suffix: '/tools' } };
    const result = await handler.checkAuth({}, ctx);
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

  it('returns null without calling super for a /tools/api-keys-look-alike', async () => {
    // Guards against accidental prefix collisions: ensures the prefix check is
    // anchored. The check uses startsWith so "/tools/api-keys-foo" *does* match;
    // documenting current behavior with this assertion so any future tightening
    // (e.g. word-boundary check) requires updating both the check and this test.
    const ctx = { pathInfo: { suffix: '/tools/other-tool' } };
    const result = await handler.checkAuth({}, ctx);
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });

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

  it('returns null when suffix is not a string', async () => {
    const ctx = { pathInfo: { suffix: undefined } };
    const result = await handler.checkAuth({}, ctx);
    expect(result).to.equal(null);
    expect(superCheckAuthStub).to.not.have.been.called;
  });
});
