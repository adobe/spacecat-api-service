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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import { detectAuthWall } from '../../src/support/detect-auth-wall.js';

use(sinonChai);

describe('detectAuthWall', () => {
  let sandbox;
  let log;

  /**
   * Builds a fetch-like fake resolving to a minimal Response.
   */
  function fakeFetch(sandbox2, {
    status = 200, url = 'https://example.com/', contentType = 'text/html', body = '',
  } = {}) {
    return sandbox2.stub().resolves({
      status,
      url,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
      text: sandbox2.stub().resolves(body),
    });
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(), debug: sandbox.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('flags a 401 response as authenticated', async () => {
    const fetch = fakeFetch(sandbox, { status: 401, url: 'https://example.com/' });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.signal).to.equal('status-401');
  });

  it('flags a front door that resolves to a login URL as authenticated', async () => {
    const fetch = fakeFetch(sandbox, { url: 'https://example.com/sampoorna/login.html' });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.signal).to.equal('login-url');
    expect(result.finalUrl).to.equal('https://example.com/sampoorna/login.html');
  });

  it('flags a redirect to a known IdP host as authenticated', async () => {
    const fetch = fakeFetch(sandbox, { url: 'https://acme.okta.com/app/home' });
    const result = await detectAuthWall({ baseUrl: 'https://acme.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.signal).to.equal('idp-host');
  });

  it('flags Adobe IMS login redirect as authenticated', async () => {
    const fetch = fakeFetch(sandbox, { url: 'https://ims-na1.adobelogin.com/ims/authorize/v1' });
    const result = await detectAuthWall({ baseUrl: 'https://portal.acme.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.signal).to.equal('idp-host');
  });

  it('flags a login form (password input + login title) on a plain URL', async () => {
    const body = '<html><head><title>Sign in</title></head>'
      + '<body><form><input type="password" name="pw"></form></body></html>';
    const fetch = fakeFetch(sandbox, { url: 'https://example.com/', body });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.signal).to.equal('login-form');
  });

  it('does NOT flag a public homepage with an incidental password field (no login title/url)', async () => {
    const body = '<html><head><title>Welcome to Acme</title></head>'
      + '<body><div class="account-widget"><input type="password"></div></body></html>';
    const fetch = fakeFetch(sandbox, { url: 'https://example.com/', body });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(false);
    expect(result.signal).to.equal(null);
  });

  it('does NOT flag a normal public homepage', async () => {
    const body = '<html><head><title>Acme Home</title></head><body><h1>Welcome</h1></body></html>';
    const fetch = fakeFetch(sandbox, { url: 'https://example.com/', body });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(false);
  });

  it('does not misclassify /authors as a login URL', async () => {
    const body = '<html><head><title>Our Authors</title></head><body></body></html>';
    const fetch = fakeFetch(sandbox, { url: 'https://example.com/authors', body });
    const result = await detectAuthWall({ baseUrl: 'https://example.com/authors', log }, { fetch });
    expect(result.authenticated).to.equal(false);
  });

  it('skips body scan for non-HTML content types', async () => {
    const body = '<input type="password"><title>login</title>';
    const fetch = fakeFetch(sandbox, { url: 'https://example.com/', contentType: 'application/pdf', body });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(false);
  });

  it('fails open (not authenticated) and warns when the fetch throws', async () => {
    const fetch = sandbox.stub().rejects(new Error('ETIMEDOUT'));
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(false);
    expect(result.signal).to.equal(null);
    expect(log.warn).to.have.been.called;
  });

  it('probes the base URL with a browser user-agent and follows redirects', async () => {
    const fetch = fakeFetch(sandbox, { url: 'https://example.com/' });
    await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(fetch).to.have.been.calledOnce;
    const [calledUrl, opts] = fetch.firstCall.args;
    expect(calledUrl).to.equal('https://example.com');
    expect(opts.redirect).to.equal('follow');
    expect(opts.headers['User-Agent']).to.be.a('string').and.match(/Mozilla/);
  });

  it('flags the TATA-style case (redirect to login.html + password form)', async () => {
    const body = '<html><head><title>Login</title></head>'
      + '<body><form id="mfa-form"><input type="password"></form></body></html>';
    const fetch = fakeFetch(sandbox, { url: 'https://sampoornanxt.tatasteel.com/sampoorna/login.html', body });
    const result = await detectAuthWall({ baseUrl: 'https://sampoornanxt.tatasteel.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.finalUrl).to.equal('https://sampoornanxt.tatasteel.com/sampoorna/login.html');
  });

  it('defaults fetch to global fetch when no dependency is injected', async () => {
    // No injected fetch: exercises the default parameter. We stub the global so no
    // real network call happens. Restored by sandbox.restore() in afterEach.
    sandbox.stub(globalThis, 'fetch').resolves({
      status: 200,
      url: 'https://example.com/',
      headers: { get: () => 'text/html' },
      text: sandbox.stub().resolves('<title>Home</title>'),
    });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log });
    expect(result.authenticated).to.equal(false);
    expect(globalThis.fetch).to.have.been.calledOnce;
  });
});
