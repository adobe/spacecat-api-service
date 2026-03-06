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
import { gzipSync } from 'zlib';
import { Request } from '@adobe/fetch';
import gzipBody from '../../src/support/gzip-body.js';

describe('gzipBody middleware', () => {
  let sandbox;
  let handler;
  const context = { log: { info: () => {} } };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    handler = sandbox.stub().resolves(new Response('ok'));
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('decompresses a gzip-encoded request body', async () => {
    const payload = JSON.stringify({ key: 'value', nested: { a: 1 } });
    const compressed = gzipSync(Buffer.from(payload));

    const request = new Request('https://example.com/api/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      body: compressed,
    });

    const wrapped = gzipBody(handler);
    await wrapped(request, context);

    expect(handler.calledOnce).to.be.true;

    const [forwardedRequest] = handler.firstCall.args;
    const body = await forwardedRequest.json();

    expect(body).to.deep.equal({ key: 'value', nested: { a: 1 } });
    expect(forwardedRequest.headers.get('content-encoding')).to.be.null;
    expect(forwardedRequest.headers.get('content-type')).to.equal('application/json');
    expect(forwardedRequest.method).to.equal('POST');
  });

  it('passes through non-gzipped requests unchanged', async () => {
    const payload = JSON.stringify({ key: 'value' });
    const request = new Request('https://example.com/api/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: payload,
    });

    const wrapped = gzipBody(handler);
    await wrapped(request, context);

    expect(handler.calledOnce).to.be.true;

    const [forwardedRequest] = handler.firstCall.args;
    expect(forwardedRequest).to.equal(request);
  });

  it('passes through GET requests without Content-Encoding', async () => {
    const request = new Request('https://example.com/api/test', {
      method: 'GET',
    });

    const wrapped = gzipBody(handler);
    await wrapped(request, context);

    expect(handler.calledOnce).to.be.true;
    expect(handler.firstCall.args[0]).to.equal(request);
  });

  it('preserves the context object', async () => {
    const payload = JSON.stringify({ data: true });
    const compressed = gzipSync(Buffer.from(payload));
    const testContext = { log: { info: () => {} }, custom: 'value' };

    const request = new Request('https://example.com/api/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      body: compressed,
    });

    const wrapped = gzipBody(handler);
    await wrapped(request, testContext);

    expect(handler.firstCall.args[1]).to.equal(testContext);
  });

  it('preserves other headers when decompressing', async () => {
    const payload = JSON.stringify({ test: true });
    const compressed = gzipSync(Buffer.from(payload));

    const request = new Request('https://example.com/api/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'x-trigger-audits': 'true',
        Authorization: 'Bearer token123',
      },
      body: compressed,
    });

    const wrapped = gzipBody(handler);
    await wrapped(request, context);

    const [forwardedRequest] = handler.firstCall.args;
    expect(forwardedRequest.headers.get('x-trigger-audits')).to.equal('true');
    expect(forwardedRequest.headers.get('authorization')).to.equal('Bearer token123');
    expect(forwardedRequest.headers.get('content-type')).to.equal('application/json');
  });
});
