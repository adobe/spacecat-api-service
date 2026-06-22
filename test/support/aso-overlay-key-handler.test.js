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

import { expect } from 'chai';
import sinon from 'sinon';
import AsoOverlayKeyHandler from '../../src/support/aso-overlay-key-handler.js';

describe('AsoOverlayKeyHandler', () => {
  const API_KEY = 'super-secret-aso-key';
  const OVERLAY_SUFFIX = '/config/cm-p154709-e1629980/redirects.txt';
  let handler;
  let sandbox;
  let mockLog;

  function makeRequest(headers = {}) {
    return { headers: { get: (name) => headers[name] ?? null } };
  }

  function makeContext(overrides = {}) {
    return {
      pathInfo: { method: 'GET', suffix: OVERLAY_SUFFIX },
      env: { ASO_OVERLAY_API_KEY: API_KEY },
      ...overrides,
    };
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockLog = { info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub() };
    handler = new AsoOverlayKeyHandler(mockLog);
  });

  afterEach(() => sandbox.restore());

  it('authenticates a valid key on the overlay route', async () => {
    const authInfo = await handler.checkAuth(
      makeRequest({ 'x-aso-api-key': API_KEY }),
      makeContext(),
    );
    expect(authInfo).to.not.be.null;
    expect(authInfo.isAuthenticated()).to.be.true;
    expect(authInfo.getType()).to.equal('aso_overlay_key');
    expect(authInfo.getProfile().user_id).to.equal('aso-overlay');
  });

  it('returns null for a non-overlay path even with a valid key', async () => {
    const authInfo = await handler.checkAuth(
      makeRequest({ 'x-aso-api-key': API_KEY }),
      makeContext({ pathInfo: { method: 'GET', suffix: '/sites/123' } }),
    );
    expect(authInfo).to.be.null;
  });

  it('returns null for a non-GET method on the overlay path', async () => {
    const authInfo = await handler.checkAuth(
      makeRequest({ 'x-aso-api-key': API_KEY }),
      makeContext({ pathInfo: { method: 'POST', suffix: OVERLAY_SUFFIX } }),
    );
    expect(authInfo).to.be.null;
  });

  it('returns null for a malformed service segment (route regex boundary)', async () => {
    const authInfo = await handler.checkAuth(
      makeRequest({ 'x-aso-api-key': API_KEY }),
      makeContext({ pathInfo: { method: 'GET', suffix: '/config/not-a-service/redirects.txt' } }),
    );
    expect(authInfo).to.be.null;
  });

  it('returns null when the X-ASO-API-Key header is missing', async () => {
    const authInfo = await handler.checkAuth(makeRequest({}), makeContext());
    expect(authInfo).to.be.null;
  });

  it('returns null and warns when the key is wrong', async () => {
    const authInfo = await handler.checkAuth(
      makeRequest({ 'x-aso-api-key': 'wrong-key' }),
      makeContext(),
    );
    expect(authInfo).to.be.null;
    expect(mockLog.warn.called).to.be.true;
  });

  it('returns null without throwing for a non-string header value (defensive)', async () => {
    // headers.get normally yields string|null, but the constant-time compare must
    // never throw on a non-string input (it would otherwise blow up in createHmac).
    const authInfo = await handler.checkAuth(
      makeRequest({ 'x-aso-api-key': 12345 }),
      makeContext(),
    );
    expect(authInfo).to.be.null;
  });

  it('returns null when pathInfo has no method/suffix', async () => {
    const authInfo = await handler.checkAuth(
      makeRequest({ 'x-aso-api-key': API_KEY }),
      makeContext({ pathInfo: {} }),
    );
    expect(authInfo).to.be.null;
  });

  it('returns null and logs error when ASO_OVERLAY_API_KEY is not configured', async () => {
    const authInfo = await handler.checkAuth(
      makeRequest({ 'x-aso-api-key': API_KEY }),
      makeContext({ env: {} }),
    );
    expect(authInfo).to.be.null;
    expect(mockLog.error.called).to.be.true;
  });

  it('tolerates a suffix without a leading slash', async () => {
    const authInfo = await handler.checkAuth(
      makeRequest({ 'x-aso-api-key': API_KEY }),
      makeContext({ pathInfo: { method: 'GET', suffix: 'config/cm-p1-e2/redirects.txt' } }),
    );
    expect(authInfo).to.not.be.null;
    expect(authInfo.getType()).to.equal('aso_overlay_key');
  });

  describe('dual-key rotation overlap', () => {
    const PREVIOUS_KEY = 'old-aso-key-being-rotated';

    it('accepts the previous key during rotation overlap', async () => {
      const authInfo = await handler.checkAuth(
        makeRequest({ 'x-aso-api-key': PREVIOUS_KEY }),
        makeContext({ env: { ASO_OVERLAY_API_KEY: API_KEY, ASO_OVERLAY_API_KEY_PREVIOUS: PREVIOUS_KEY } }),
      );
      expect(authInfo).to.not.be.null;
      expect(authInfo.isAuthenticated()).to.be.true;
    });

    it('still accepts the current key when previous is also set', async () => {
      const authInfo = await handler.checkAuth(
        makeRequest({ 'x-aso-api-key': API_KEY }),
        makeContext({ env: { ASO_OVERLAY_API_KEY: API_KEY, ASO_OVERLAY_API_KEY_PREVIOUS: PREVIOUS_KEY } }),
      );
      expect(authInfo).to.not.be.null;
      expect(authInfo.isAuthenticated()).to.be.true;
    });

    it('rejects a wrong key even when previous key is set', async () => {
      const authInfo = await handler.checkAuth(
        makeRequest({ 'x-aso-api-key': 'totally-wrong' }),
        makeContext({ env: { ASO_OVERLAY_API_KEY: API_KEY, ASO_OVERLAY_API_KEY_PREVIOUS: PREVIOUS_KEY } }),
      );
      expect(authInfo).to.be.null;
    });

    it('works in steady state when previous key is empty', async () => {
      const authInfo = await handler.checkAuth(
        makeRequest({ 'x-aso-api-key': API_KEY }),
        makeContext({ env: { ASO_OVERLAY_API_KEY: API_KEY, ASO_OVERLAY_API_KEY_PREVIOUS: '' } }),
      );
      expect(authInfo).to.not.be.null;
      expect(authInfo.isAuthenticated()).to.be.true;
    });

    it('works in steady state when previous key is not set at all', async () => {
      const authInfo = await handler.checkAuth(
        makeRequest({ 'x-aso-api-key': API_KEY }),
        makeContext({ env: { ASO_OVERLAY_API_KEY: API_KEY } }),
      );
      expect(authInfo).to.not.be.null;
      expect(authInfo.isAuthenticated()).to.be.true;
    });
  });
});
