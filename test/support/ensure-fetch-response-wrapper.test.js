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

/* eslint-env mocha */

import { expect } from 'chai';
import { Response as AdobeFetchResponse } from '@adobe/fetch';

import { ensureFetchResponseWrapper } from '../../src/support/ensure-fetch-response-wrapper.js';

describe('ensureFetchResponseWrapper', () => {
  it('passes through an @adobe/fetch Response unchanged (fast path)', async () => {
    const original = new AdobeFetchResponse('hello', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'x-custom': 'yes' },
    });
    const wrapped = ensureFetchResponseWrapper(async () => original);
    const result = await wrapped({}, {});
    // Identity check — the fast path must not rebuild the response, so the
    // returned object is the exact same reference the inner handler returned.
    expect(result).to.equal(original);
  });

  it('rewraps a native Response into an @adobe/fetch Response (slow path)', async () => {
    // Simulate the failure mode: some upstream returned the global Response
    // (undici / Web-Fetch-API), whose Headers has no .raw() method. This is
    // the exact scenario that produces the aws-adapter 500 in production.
    const native = new Response('overlay body', {
      status: 200,
      headers: { 'content-type': 'text/plain', etag: '"abc123"' },
    });
    expect(typeof native.headers.raw).to.equal('undefined');

    const wrapped = ensureFetchResponseWrapper(async () => native);
    const result = await wrapped({}, {});

    // After the wrapper, headers.raw() must exist — that's the aws-adapter
    // contract we're preserving.
    expect(typeof result.headers.raw).to.equal('function');
    expect(result.status).to.equal(200);
    expect(result.headers.get('content-type')).to.equal('text/plain');
    expect(result.headers.get('etag')).to.equal('"abc123"');
    expect(await result.text()).to.equal('overlay body');
  });

  it('rewraps a native Response on a non-200 status (e.g. 404)', async () => {
    const native = new Response('{"message":"not found"}', {
      status: 404,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
    const wrapped = ensureFetchResponseWrapper(async () => native);
    const result = await wrapped({}, {});
    expect(result.status).to.equal(404);
    expect(typeof result.headers.raw).to.equal('function');
    expect(result.headers.get('cache-control')).to.equal('no-store');
  });

  it('rewraps a native Response with an empty body (304 shape)', async () => {
    // 304 responses in RFC 7232 have no body; must still emit ETag +
    // Cache-Control headers, and the rewrap must not corrupt that. The
    // native Response constructor forbids a body on 304 so we build the
    // simulate-native-Response with `null`, matching what our controller
    // does via `createResponse('', 304, ...)` → `new Response('', 304)`
    // in the source path (which @adobe/fetch permits).
    const native = new Response(null, {
      status: 304,
      headers: { etag: '"d41d8cd"', 'cache-control': 'max-age=10' },
    });
    const wrapped = ensureFetchResponseWrapper(async () => native);
    const result = await wrapped({}, {});
    expect(result.status).to.equal(304);
    expect(typeof result.headers.raw).to.equal('function');
    expect(result.headers.get('etag')).to.equal('"d41d8cd"');
    expect(await result.text()).to.equal('');
  });

  it('returns non-object results unchanged (e.g. helix-status raw payloads)', async () => {
    // Some non-HTTP handlers can return primitives that helix-universal
    // passes through without touching aws-adapter's Response path. We must
    // not try to call .arrayBuffer() on those.
    const wrapped = ensureFetchResponseWrapper(async () => undefined);
    expect(await wrapped({}, {})).to.equal(undefined);

    const wrapped2 = ensureFetchResponseWrapper(async () => null);
    expect(await wrapped2({}, {})).to.equal(null);

    const wrapped3 = ensureFetchResponseWrapper(async () => 'a string');
    expect(await wrapped3({}, {})).to.equal('a string');
  });

  it('preserves single-value headers on rewrap (aso-overlay Surrogate-Key shape)', async () => {
    // Regression guard: the aso-overlay response headers (Cache-Control,
    // ETag, Content-Type, Surrogate-Key) are all single-value. This test
    // documents the shape that matters for the actual failing endpoint —
    // multi-value Set-Cookie is out of scope (api-service is a token-auth
    // API, not a cookie-issuing service). If Set-Cookie support is ever
    // needed, the wrapper's forEach loop would need to switch to
    // getSetCookie() for that one header per WHATWG fetch spec.
    const native = new Response('overlay body', {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        etag: '"abc123"',
        'cache-control': 'max-age=10',
        'surrogate-key': 'aso-overlay-cm-p154709-e1629980',
      },
    });
    const wrapped = ensureFetchResponseWrapper(async () => native);
    const result = await wrapped({}, {});
    expect(typeof result.headers.raw).to.equal('function');
    expect(result.headers.get('content-type')).to.equal('text/plain; charset=utf-8');
    expect(result.headers.get('etag')).to.equal('"abc123"');
    expect(result.headers.get('cache-control')).to.equal('max-age=10');
    expect(result.headers.get('surrogate-key')).to.equal('aso-overlay-cm-p154709-e1629980');
  });

  it('propagates errors from the inner handler', async () => {
    // Errors from downstream must not be swallowed by the wrapper — we only
    // transform successful Response instances.
    const wrapped = ensureFetchResponseWrapper(async () => {
      throw new Error('downstream boom');
    });
    let caught;
    try {
      await wrapped({}, {});
    } catch (e) {
      caught = e;
    }
    expect(caught?.message).to.equal('downstream boom');
  });
});
