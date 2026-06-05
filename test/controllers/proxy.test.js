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

import { expect } from 'chai';
import sinon from 'sinon';

import ProxyController from '../../src/controllers/proxy.js';

function makeContext(url) {
  return { request: { url } };
}

function mockFetchHtml(html, contentType = 'text/html; charset=utf-8') {
  return sinon.stub(globalThis, 'fetch').resolves(
    new Response(html, { status: 200, headers: { 'Content-Type': contentType } }),
  );
}

describe('Proxy Controller', () => {
  let proxyController;
  let fetchStub;

  before(() => {
    proxyController = ProxyController();
  });

  afterEach(() => {
    if (fetchStub) {
      fetchStub.restore();
      fetchStub = null;
    }
  });

  describe('getPreview', () => {
    it('returns 400 when url param is missing', async () => {
      const response = await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy'),
      );
      expect(response.status).to.equal(400);
    });

    it('returns 400 for a malformed url', async () => {
      const response = await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy?url=not-a-valid-url'),
      );
      expect(response.status).to.equal(400);
    });

    it('returns 400 for a non-http/https scheme', async () => {
      const response = await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy?url=ftp%3A%2F%2Fevil.com'),
      );
      expect(response.status).to.equal(400);
    });

    it('returns 400 for localhost', async () => {
      const response = await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy?url=http%3A%2F%2Flocalhost%2Fsecret'),
      );
      expect(response.status).to.equal(400);
    });

    it('returns 400 for AWS metadata IP', async () => {
      const response = await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F'),
      );
      expect(response.status).to.equal(400);
    });

    it('returns 400 for private 10.x IP', async () => {
      const response = await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy?url=http%3A%2F%2F10.0.0.1%2Fsecret'),
      );
      expect(response.status).to.equal(400);
    });

    it('returns 415 when upstream returns non-HTML content-type', async () => {
      fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response('{"data":1}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

      const response = await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy?url=https%3A%2F%2Fexample.com%2Fpage'),
      );
      expect(response.status).to.equal(415);
    });

    it('returns 502 when upstream fetch throws', async () => {
      fetchStub = sinon.stub(globalThis, 'fetch').rejects(new Error('connection refused'));

      const response = await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy?url=https%3A%2F%2Funreachable.example.com%2F'),
      );
      expect(response.status).to.equal(502);
    });

    it('returns proxied HTML with injected base tag after <head>', async () => {
      fetchStub = mockFetchHtml('<html><head><title>Test</title></head><body>hello</body></html>');

      const response = await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy?url=https%3A%2F%2Fexample.com%2Farticle'),
      );

      expect(response.status).to.equal(200);
      const body = await response.text();
      expect(body).to.include('<base href="https://example.com/article">');
      expect(body).to.include('<title>Test</title>');
    });

    it('prepends base tag when no <head> element is present', async () => {
      fetchStub = mockFetchHtml('<body>fragment</body>');

      const response = await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy?url=https%3A%2F%2Fexample.com%2Ffragment'),
      );

      expect(response.status).to.equal(200);
      const body = await response.text();
      expect(body).to.match(/^<base href="https:\/\/example\.com\/fragment">/);
    });

    it('sets Content-Type to text/html', async () => {
      fetchStub = mockFetchHtml('<html><head></head><body></body></html>');

      const response = await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy?url=https%3A%2F%2Fexample.com%2F'),
      );

      expect(response.headers.get('content-type')).to.include('text/html');
    });

    it('follows redirects and fetches the target URL', async () => {
      fetchStub = mockFetchHtml('<html><head></head><body>redirected</body></html>');

      await proxyController.getPreview(
        makeContext('https://api.example.com/tools/proxy?url=https%3A%2F%2Fexample.com%2Fredirect'),
      );

      const [calledUrl, calledOpts] = fetchStub.firstCall.args;
      expect(calledUrl).to.equal('https://example.com/redirect');
      expect(calledOpts.redirect).to.equal('follow');
    });
  });
});
