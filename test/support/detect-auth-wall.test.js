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
   * Builds a fetch-like fake that routes each requested URL to a scripted response, so a
   * redirect chain can be modelled as `{ status: 302, location }` hops terminating in a
   * non-3xx response. Because the probe now follows redirects MANUALLY, the final URL is the
   * URL of the terminal response — not a `response.url` set by the runtime.
   *
   * @param {object} sandbox2 - the active sinon sandbox
   * @param {Record<string, { status?, location?, contentType?, body? }>} routes - URL → response
   */
  function routedFetch(sandbox2, routes) {
    return sandbox2.stub().callsFake(async (url) => {
      const r = routes[url] || routes.default || {};
      const location = r.location ?? null;
      const contentType = r.contentType ?? 'text/html';
      const headers = { location, 'content-type': contentType };
      return {
        status: r.status ?? 200,
        url,
        headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
        text: sandbox2.stub().resolves(r.body ?? ''),
      };
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
    const fetch = routedFetch(sandbox, { 'https://example.com': { status: 401 } });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.signal).to.equal('status-401');
  });

  it('flags a front door that redirects to a login URL as authenticated', async () => {
    const fetch = routedFetch(sandbox, {
      'https://example.com': { status: 302, location: 'https://example.com/sampoorna/login.html' },
      'https://example.com/sampoorna/login.html': { status: 200, body: '<title>Home</title>' },
    });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.signal).to.equal('login-url');
    expect(result.finalUrl).to.equal('https://example.com/sampoorna/login.html');
  });

  it('flags a redirect to a known IdP host as authenticated', async () => {
    const fetch = routedFetch(sandbox, {
      'https://acme.com': { status: 302, location: 'https://acme.okta.com/app/home' },
      'https://acme.okta.com/app/home': { status: 200 },
    });
    const result = await detectAuthWall({ baseUrl: 'https://acme.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.signal).to.equal('idp-host');
  });

  it('flags Adobe IMS login redirect as authenticated', async () => {
    const fetch = routedFetch(sandbox, {
      'https://portal.acme.com': { status: 302, location: 'https://ims-na1.adobelogin.com/ims/authorize/v1' },
      'https://ims-na1.adobelogin.com/ims/authorize/v1': { status: 200 },
    });
    const result = await detectAuthWall({ baseUrl: 'https://portal.acme.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.signal).to.equal('idp-host');
  });

  it('flags a login form (password input + login title) on a plain URL', async () => {
    const body = '<html><head><title>Sign in</title></head>'
      + '<body><form><input type="password" name="pw"></form></body></html>';
    const fetch = routedFetch(sandbox, { 'https://example.com': { status: 200, body } });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.signal).to.equal('login-form');
  });

  it('does NOT flag a public homepage with an incidental password field (no login title/url)', async () => {
    const body = '<html><head><title>Welcome to Acme</title></head>'
      + '<body><div class="account-widget"><input type="password"></div></body></html>';
    const fetch = routedFetch(sandbox, { 'https://example.com': { status: 200, body } });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(false);
    expect(result.signal).to.equal(null);
  });

  it('does NOT flag a normal public homepage', async () => {
    const body = '<html><head><title>Acme Home</title></head><body><h1>Welcome</h1></body></html>';
    const fetch = routedFetch(sandbox, { 'https://example.com': { status: 200, body } });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(false);
  });

  it('does NOT flag a bare 403 with no login signal (documents that 403 alone is not an auth wall)', async () => {
    // A 403 is a common anti-bot / geo / WAF response, NOT proof of a login wall. It must fall
    // through to the body scan (which finds nothing here) rather than being flagged like a 401.
    const body = '<html><head><title>Forbidden</title></head><body>Access denied</body></html>';
    const fetch = routedFetch(sandbox, { 'https://example.com': { status: 403, body } });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(false);
    expect(result.signal).to.equal(null);
  });

  it('does not misclassify /authors as a login URL', async () => {
    const body = '<html><head><title>Our Authors</title></head><body></body></html>';
    const fetch = routedFetch(sandbox, { 'https://example.com/authors': { status: 200, body } });
    const result = await detectAuthWall({ baseUrl: 'https://example.com/authors', log }, { fetch });
    expect(result.authenticated).to.equal(false);
  });

  it('flags an /auth/* front door (documents that the "auth" path segment is treated as a login endpoint)', async () => {
    // Accepted behavior: a front door that resolves to `/auth/...` is treated as a login/SSO
    // endpoint. On a front door this is intended — a public homepage that 3xx-redirects into
    // an /auth/ flow is gated. Tightening the pattern would risk missing real login redirects.
    const fetch = routedFetch(sandbox, {
      'https://example.com': { status: 302, location: 'https://example.com/auth/callback' },
      'https://example.com/auth/callback': { status: 200, body: '<title>Home</title>' },
    });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.signal).to.equal('login-url');
  });

  it('skips body scan for non-HTML content types', async () => {
    const body = '<input type="password"><title>login</title>';
    const fetch = routedFetch(sandbox, {
      'https://example.com': { status: 200, contentType: 'application/pdf', body },
    });
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

  it('probes the base URL with a browser user-agent and follows redirects manually', async () => {
    const fetch = routedFetch(sandbox, { 'https://example.com': { status: 200 } });
    await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
    expect(fetch).to.have.been.calledOnce;
    const [calledUrl, opts] = fetch.firstCall.args;
    expect(calledUrl).to.equal('https://example.com');
    expect(opts.redirect).to.equal('manual');
    expect(opts.headers['User-Agent']).to.be.a('string').and.match(/Mozilla/);
  });

  it('flags the TATA-style case (redirect to login.html + password form)', async () => {
    const body = '<html><head><title>Login</title></head>'
      + '<body><form id="mfa-form"><input type="password"></form></body></html>';
    const fetch = routedFetch(sandbox, {
      'https://sampoornanxt.tatasteel.com': { status: 302, location: 'https://sampoornanxt.tatasteel.com/sampoorna/login.html' },
      'https://sampoornanxt.tatasteel.com/sampoorna/login.html': { status: 200, body },
    });
    const result = await detectAuthWall({ baseUrl: 'https://sampoornanxt.tatasteel.com', log }, { fetch });
    expect(result.authenticated).to.equal(true);
    expect(result.finalUrl).to.equal('https://sampoornanxt.tatasteel.com/sampoorna/login.html');
  });

  describe('SSRF guard (redirect target host validation)', () => {
    it('refuses to follow a redirect to a cloud metadata / private host, and exposes nothing', async () => {
      const fetch = routedFetch(sandbox, {
        'https://example.com': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
      });
      const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
      // Fails open (public), and — crucially — the internal host is never fetched or surfaced.
      expect(result.authenticated).to.equal(false);
      expect(result.finalUrl).to.equal(null);
      expect(fetch).to.have.been.calledOnce; // only the public front door was requested
      expect(fetch).to.have.been.calledWith('https://example.com');
      expect(log.warn).to.have.been.called;
    });

    it('refuses to follow a redirect to an RFC1918 private host', async () => {
      const fetch = routedFetch(sandbox, {
        'https://example.com': { status: 302, location: 'http://10.1.2.3/admin' },
      });
      const result = await detectAuthWall({ baseUrl: 'https://example.com', log }, { fetch });
      expect(result.authenticated).to.equal(false);
      expect(result.finalUrl).to.equal(null);
      expect(fetch).to.have.been.calledOnce;
    });

    it('does not fetch at all when the base URL itself resolves to a private host', async () => {
      const fetch = routedFetch(sandbox, { default: { status: 200 } });
      const result = await detectAuthWall({ baseUrl: 'http://192.168.0.10', log }, { fetch });
      expect(result.authenticated).to.equal(false);
      expect(fetch).to.not.have.been.called;
      expect(log.warn).to.have.been.called;
    });

    it('fails open when the redirect chain exceeds the maximum', async () => {
      // Always 3xx to a new safe URL so the redirect budget is exhausted.
      const fetch = sandbox.stub().callsFake(async (url) => {
        const n = Number(new URL(url).searchParams.get('n') || '0');
        return {
          status: 302,
          url,
          headers: {
            get: (name) => (String(name).toLowerCase() === 'location'
              ? `https://example.com/?n=${n + 1}` : null),
          },
          text: sandbox.stub().resolves(''),
        };
      });
      const result = await detectAuthWall({ baseUrl: 'https://example.com/?n=0', log }, { fetch });
      expect(result.authenticated).to.equal(false);
      expect(result.finalUrl).to.equal(null);
      expect(log.warn).to.have.been.called;
    });
  });

  it('defaults fetch to global fetch when no dependency is injected', async () => {
    // No injected fetch: exercises the default parameter. We stub the global so no
    // real network call happens. Restored by sandbox.restore() in afterEach.
    sandbox.stub(globalThis, 'fetch').resolves({
      status: 200,
      url: 'https://example.com/',
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/html' : null) },
      text: sandbox.stub().resolves('<title>Home</title>'),
    });
    const result = await detectAuthWall({ baseUrl: 'https://example.com', log });
    expect(result.authenticated).to.equal(false);
    expect(globalThis.fetch).to.have.been.calledOnce;
  });
});
