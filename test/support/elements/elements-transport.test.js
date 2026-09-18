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
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import { createElementsTransport } from '../../../src/support/elements/elements-transport.js';
import { ElementsTransportError } from '../../../src/support/elements/errors.js';

use(chaiAsPromised);
use(sinonChai);

const BASE_URL = 'https://www.semrush.com';
const IMS_TOKEN = 'test-ims-token';
const WORKSPACE_ID = 'ws-uuid-123';
const ELEMENT_ID = 'el-uuid-456';
const EXPECTED_URL = `${BASE_URL}/enterprise/pages/api/v3/workspaces/${WORKSPACE_ID}/products/ai/elements/${ELEMENT_ID}/data`;
const ENV = { SEMRUSH_PROJECTS_BASE_URL: BASE_URL };

function makeResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    text: sinon.stub().resolves(text),
    headers: {
      get: (name) => lowerHeaders[String(name).toLowerCase()] ?? null,
    },
  };
}

function makeStreamingResponse(status, chunks) {
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk));
  let index = 0;
  const cancel = sinon.stub().resolves();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= encoded.length) {
            return { done: true, value: undefined };
          }
          const value = encoded[index];
          index += 1;
          return { done: false, value };
        },
        cancel,
      }),
    },
    cancel,
  };
}

describe('createElementsTransport', () => {
  let fetchStub;
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchStub = sinon.stub();
    globalThis.fetch = fetchStub;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('baseUrl validation', () => {
    it('throws 503 when SEMRUSH_PROJECTS_BASE_URL is not set', () => {
      expect(() => createElementsTransport({ env: {}, imsToken: IMS_TOKEN }))
        .to.throw().with.property('status', 503);
    });

    it('throws 503 when SEMRUSH_PROJECTS_BASE_URL is null', () => {
      const env = { SEMRUSH_PROJECTS_BASE_URL: null };
      expect(() => createElementsTransport({ env, imsToken: IMS_TOKEN }))
        .to.throw().with.property('status', 503);
    });

    it('throws 503 when SEMRUSH_PROJECTS_BASE_URL is whitespace only', () => {
      expect(() => createElementsTransport({ env: { SEMRUSH_PROJECTS_BASE_URL: '   ' }, imsToken: IMS_TOKEN }))
        .to.throw().with.property('status', 503);
    });

    it('throws 503 when SEMRUSH_PROJECTS_BASE_URL is not a valid URL', () => {
      expect(() => createElementsTransport({ env: { SEMRUSH_PROJECTS_BASE_URL: 'not a url' }, imsToken: IMS_TOKEN }))
        .to.throw().with.property('status', 503);
    });

    it('throws 503 when SEMRUSH_PROJECTS_BASE_URL uses http instead of https', () => {
      expect(() => createElementsTransport({ env: { SEMRUSH_PROJECTS_BASE_URL: 'http://semrush.com' }, imsToken: IMS_TOKEN }))
        .to.throw().with.property('status', 503);
    });

    it('strips trailing slash from base URL and builds correct endpoint', async () => {
      fetchStub.resolves(makeResponse(200, { blocks: { value: [] } }));
      const transport = createElementsTransport({ env: { SEMRUSH_PROJECTS_BASE_URL: `${BASE_URL}/` }, imsToken: IMS_TOKEN });
      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      const [url] = fetchStub.firstCall.args;
      expect(url).to.equal(EXPECTED_URL);
    });
  });

  describe('fetchElement', () => {
    it('makes a POST request', async () => {
      fetchStub.resolves(makeResponse(200, { blocks: { value: [] } }));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      const [, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
    });

    it('calls fetch with the correct URL', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      const [url] = fetchStub.firstCall.args;
      expect(url).to.equal(EXPECTED_URL);
    });

    it('sends Authorization header with bearer token', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      const [, init] = fetchStub.firstCall.args;
      expect(init.headers.Authorization).to.equal(`Bearer ${IMS_TOKEN}`);
    });

    it('sends Content-Type application/json', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      const [, init] = fetchStub.firstCall.args;
      expect(init.headers['Content-Type']).to.equal('application/json');
    });

    it('sends Accept application/json', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      const [, init] = fetchStub.firstCall.args;
      expect(init.headers.Accept).to.equal('application/json');
    });

    it('serialises the payload as JSON body', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const payload = { comparison_data_formatting: 'union' };
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, payload);
      const [, init] = fetchStub.firstCall.args;
      expect(init.body).to.equal(JSON.stringify(payload));
    });

    it('returns parsed JSON on success', async () => {
      const responseBody = { blocks: { value: [{ value: 'Adobe' }] } };
      fetchStub.resolves(makeResponse(200, responseBody));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      const result = await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      expect(result).to.deep.equal(responseBody);
    });

    it('accepts a response exactly at the per-call decompressed byte ceiling', async () => {
      const body = JSON.stringify({ ok: true });
      fetchStub.resolves(makeStreamingResponse(200, [body]));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      const result = await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}, {
        maxResponseBytes: new TextEncoder().encode(body).byteLength,
      });
      expect(result).to.deep.equal({ ok: true });
    });

    it('cancels and rejects a streamed response above the decompressed byte ceiling', async () => {
      const response = makeStreamingResponse(200, ['1234', '5678']);
      fetchStub.resolves(response);
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await expect(transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}, {
        maxResponseBytes: 7,
      })).to.be.rejectedWith(ElementsTransportError, /exceeds configured 7-byte limit/);
      expect(response.cancel).to.have.been.calledOnce;
    });

    it('preserves the typed streamed-overflow error when cancellation fails', async () => {
      const response = makeStreamingResponse(200, ['1234', '5678']);
      response.cancel.rejects(new Error('cancel failed'));
      fetchStub.resolves(response);
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });

      await expect(transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}, {
        maxResponseBytes: 7,
      })).to.be.rejectedWith(ElementsTransportError, /exceeds configured 7-byte limit/);
      expect(response.cancel).to.have.been.calledOnce;
    });

    it('best-effort cancels an unread body rejected by Content-Length', async () => {
      const cancel = sinon.stub().rejects(new Error('cancel failed'));
      fetchStub.resolves({
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-length' ? '8' : null) },
        body: { cancel },
      });
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });

      await expect(transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}, {
        maxResponseBytes: 7,
      })).to.be.rejectedWith(ElementsTransportError, /exceeds configured 7-byte limit/);
      expect(cancel).to.have.been.calledOnce;
    });

    it('redacts the workspace from endpoint-specific error descriptors', async () => {
      fetchStub.resolves(makeResponse(500, { error: 'failed' }));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      let error;
      try {
        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}, {
          redactWorkspaceInErrors: true,
        });
      } catch (e) {
        error = e;
      }
      expect(error.workspaceId).to.equal(undefined);
      expect(error.endpoint).to.include('/workspaces/[redacted]/');
      expect(error.endpoint).to.not.include(WORKSPACE_ID);
      expect(error.message).to.include('/workspaces/[redacted]/');
      expect(error.message).to.not.include(WORKSPACE_ID);
    });

    it('URL-encodes workspaceId in the path', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await transport.fetchElement('ws/special', ELEMENT_ID, {});
      const [url] = fetchStub.firstCall.args;
      expect(url).to.include('ws%2Fspecial');
    });

    it('URL-encodes elementId in the path', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await transport.fetchElement(WORKSPACE_ID, 'el/special', {});
      const [url] = fetchStub.firstCall.args;
      expect(url).to.include('el%2Fspecial');
    });

    it('throws ElementsTransportError on non-2xx response', async () => {
      fetchStub.resolves(makeResponse(404, { error: 'not found' }));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await expect(transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}))
        .to.be.rejectedWith(ElementsTransportError);
    });

    it('sets correct status on ElementsTransportError from upstream status code', async () => {
      fetchStub.resolves(makeResponse(503, 'service unavailable'));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      let err;
      try {
        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(ElementsTransportError);
      expect(err.status).to.equal(503);
    });

    // SITES-49993: the error carries a structured request descriptor so the
    // controller's upstream-error log line can emit queryable fields.
    it('attaches method/endpoint/workspaceId/elementId to ElementsTransportError', async () => {
      fetchStub.resolves(makeResponse(403, { error: 'denied' }));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      let err;
      try {
        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      } catch (e) {
        err = e;
      }
      expect(err.method).to.equal('POST');
      expect(err.endpoint).to.equal(
        `/enterprise/pages/api/v3/workspaces/${WORKSPACE_ID}/products/ai/elements/${ELEMENT_ID}/data`,
      );
      expect(err.workspaceId).to.equal(WORKSPACE_ID);
      expect(err.elementId).to.equal(ELEMENT_ID);
    });

    it('attaches the request descriptor on timeout too (SITES-49993)', async () => {
      fetchStub.rejects(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      let err;
      try {
        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      } catch (e) {
        err = e;
      }
      expect(err.method).to.equal('POST');
      expect(err.workspaceId).to.equal(WORKSPACE_ID);
      expect(err.elementId).to.equal(ELEMENT_ID);
    });

    it('includes parsed response body on ElementsTransportError', async () => {
      const errorBody = { error: 'upstream detail' };
      fetchStub.resolves(makeResponse(422, errorBody));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      let err;
      try {
        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      } catch (e) {
        err = e;
      }
      expect(err.body).to.deep.equal(errorBody);
    });

    it('throws ElementsTransportError with status 401 when IMS token is missing', async () => {
      const transport = createElementsTransport({ env: ENV, imsToken: '' });
      await expect(transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}))
        .to.be.rejectedWith(ElementsTransportError, /Missing IMS bearer token/);
    });

    it('throws ElementsTransportError on timeout (AbortError)', async () => {
      fetchStub.rejects(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      let err;
      try {
        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(ElementsTransportError);
      expect(err.status).to.equal(504);
    });

    it('re-throws non-abort network errors as-is', async () => {
      const networkErr = new Error('ECONNREFUSED');
      fetchStub.rejects(networkErr);
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await expect(transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}))
        .to.be.rejectedWith('ECONNREFUSED');
    });

    it('returns null when response body is empty', async () => {
      fetchStub.resolves(makeResponse(200, ''));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      const result = await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      expect(result).to.be.null;
    });

    it('returns raw text when response body is not valid JSON', async () => {
      fetchStub.resolves(makeResponse(200, 'plain text response'));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      const result = await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      expect(result).to.equal('plain text response');
    });

    it('attaches an AbortSignal to the request', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      const [, init] = fetchStub.firstCall.args;
      expect(init.signal).to.be.instanceOf(AbortSignal);
    });

    it('honors a per-call timeoutMs override over the transport default', async () => {
      const clock = sinon.useFakeTimers();
      try {
        // Never resolves on its own — only rejects when the abort signal fires,
        // mirroring real fetch's behavior when combined with AbortController.
        fetchStub.callsFake((url, init) => new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        }));
        const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
        // Attached synchronously (same tick the promise is created) so a later
        // rejection is never "unhandled" from Node's perspective.
        const settledPromise = transport
          .fetchElement(WORKSPACE_ID, ELEMENT_ID, {}, { timeoutMs: 5000 })
          .catch((e) => e);

        // Just before the custom 5s deadline: no abort yet.
        await clock.tickAsync(4999);
        // Crossing 5000ms triggers the abort — well short of the 30s default.
        await clock.tickAsync(1);

        const err = await settledPromise;
        expect(err).to.be.instanceOf(ElementsTransportError);
        expect(err.status).to.equal(504);
      } finally {
        clock.restore();
      }
    });

    it('keeps the timeout active after headers while the response body is read', async () => {
      const clock = sinon.useFakeTimers();
      try {
        fetchStub.callsFake(async (url, init) => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: () => new Promise((resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                  reject(Object.assign(new Error('The operation was aborted'), {
                    name: 'AbortError',
                  }));
                }, { once: true });
              }),
              cancel: sinon.stub().resolves(),
            }),
          },
        }));
        const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
        const settledPromise = transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}, {
          timeoutMs: 5000,
          maxResponseBytes: 8 * 1024 * 1024,
        }).catch((e) => e);

        // Fetch has already returned headers, but its body remains stalled.
        await clock.tickAsync(4999);
        await clock.tickAsync(1);

        const err = await settledPromise;
        expect(err).to.be.instanceOf(ElementsTransportError);
        expect(err.status).to.equal(504);
        expect(err.message).to.include('timed out after 5000ms');
      } finally {
        clock.restore();
      }
    });

    it('falls back to the transport default timeoutMs when no per-call override is given', async () => {
      const clock = sinon.useFakeTimers();
      try {
        fetchStub.callsFake((url, init) => new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        }));
        const transport = createElementsTransport({ env: ENV, imsToken: IMS_TOKEN });
        let settled = false;
        // Attached synchronously (same tick the promise is created) so a later
        // rejection is never "unhandled" from Node's perspective.
        const settledPromise = transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {})
          .catch((e) => {
            settled = true;
            return e;
          });

        // Well past a 5s custom timeout, but short of the 30s default: no abort yet.
        await clock.tickAsync(29_999);
        expect(settled).to.equal(false);

        // Crossing 30000ms (DEFAULT_TIMEOUT_MS) triggers the abort.
        await clock.tickAsync(1);
        const err = await settledPromise;
        expect(err).to.be.instanceOf(ElementsTransportError);
        expect(err.status).to.equal(504);
      } finally {
        clock.restore();
      }
    });
  });

  describe('retry on 429', () => {
    // All retry tests use a zero base delay so the backoff sleep is instant unless a fake clock
    // is installed; pass overrides (e.g. maxRetries) as needed.
    const fastTransport = (extra = {}) => createElementsTransport({
      env: ENV, imsToken: IMS_TOKEN, retryBaseDelayMs: 0, ...extra,
    });

    it('retries a 429 then succeeds on the next attempt', async () => {
      const successBody = { blocks: { value: [{ value: 'Adobe' }] } };
      fetchStub.onCall(0).resolves(makeResponse(429, { error: 'rate limited' }));
      fetchStub.onCall(1).resolves(makeResponse(200, successBody));
      const transport = fastTransport();
      const result = await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      expect(fetchStub.callCount).to.equal(2);
      expect(result).to.deep.equal(successBody);
    });

    it('throws 429 after exhausting retries (maxRetries: 2 ⇒ 3 attempts)', async () => {
      fetchStub.resolves(makeResponse(429, { error: 'rate limited' }));
      const transport = createElementsTransport({
        env: ENV, imsToken: IMS_TOKEN, maxRetries: 2, retryBaseDelayMs: 0,
      });
      let err;
      try {
        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(ElementsTransportError);
      expect(err.status).to.equal(429);
      expect(err.body).to.deep.equal({ error: 'rate limited' });
      expect(fetchStub.callCount).to.equal(3);
    });

    it('maxRetries: 0 ⇒ single attempt on a 429 (throws, no retry)', async () => {
      fetchStub.resolves(makeResponse(429, { error: 'rate limited' }));
      const transport = fastTransport({ maxRetries: 0 });
      await expect(transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}))
        .to.be.rejectedWith(ElementsTransportError);
      expect(fetchStub.callCount).to.equal(1);
    });

    it('negative maxRetries ⇒ single attempt on a 429', async () => {
      fetchStub.resolves(makeResponse(429, { error: 'rate limited' }));
      const transport = fastTransport({ maxRetries: -5 });
      await expect(transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}))
        .to.be.rejectedWith(ElementsTransportError);
      expect(fetchStub.callCount).to.equal(1);
    });

    it('does NOT retry a 5xx (single attempt, throws)', async () => {
      fetchStub.resolves(makeResponse(503, 'service unavailable'));
      const transport = fastTransport();
      let err;
      try {
        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(ElementsTransportError);
      expect(err.status).to.equal(503);
      expect(fetchStub.callCount).to.equal(1);
    });

    it('does NOT retry a network error (single attempt)', async () => {
      fetchStub.rejects(new Error('ECONNREFUSED'));
      const transport = fastTransport();
      await expect(transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}))
        .to.be.rejectedWith('ECONNREFUSED');
      expect(fetchStub.callCount).to.equal(1);
    });

    it('does NOT retry an AbortError/timeout (single attempt, 504)', async () => {
      fetchStub.rejects(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      const transport = fastTransport();
      let err;
      try {
        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(ElementsTransportError);
      expect(err.status).to.equal(504);
      expect(fetchStub.callCount).to.equal(1);
    });

    it('honors the Retry-After header when deciding how long to wait', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const successBody = { ok: true };
        // Retry-After: 1s, with retryBaseDelayMs 0 so backoff alone would be ~0 — the wait must
        // come from the header. capped-to-header wait means the retry fires only after >= 1000ms.
        fetchStub.onCall(0).resolves(makeResponse(429, { error: 'slow down' }, { 'Retry-After': '1' }));
        fetchStub.onCall(1).resolves(makeResponse(200, successBody));
        const transport = fastTransport();
        const promise = transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});

        // Let the first fetch + parseBody microtasks settle, then assert we are still waiting.
        await clock.tickAsync(0);
        expect(fetchStub.callCount).to.equal(1);
        // Just before the Retry-After deadline: still no second attempt.
        await clock.tickAsync(999);
        expect(fetchStub.callCount).to.equal(1);
        // Crossing 1000ms triggers the retry.
        await clock.tickAsync(1);
        const result = await promise;
        expect(fetchStub.callCount).to.equal(2);
        expect(result).to.deep.equal(successBody);
      } finally {
        clock.restore();
      }
    });

    it('falls back to backoff when Retry-After is unparseable', async () => {
      const successBody = { ok: true };
      fetchStub.onCall(0).resolves(makeResponse(429, {}, { 'Retry-After': 'not-a-date' }));
      fetchStub.onCall(1).resolves(makeResponse(200, successBody));
      const transport = fastTransport();
      const result = await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      expect(fetchStub.callCount).to.equal(2);
      expect(result).to.deep.equal(successBody);
    });

    it('honors an HTTP-date Retry-After header', async () => {
      const successBody = { ok: true };
      const future = new Date(Date.now() + 1000).toUTCString();
      fetchStub.onCall(0).resolves(makeResponse(429, {}, { 'Retry-After': future }));
      fetchStub.onCall(1).resolves(makeResponse(200, successBody));
      const transport = fastTransport();
      const result = await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      expect(fetchStub.callCount).to.equal(2);
      expect(result).to.deep.equal(successBody);
    });

    it('caps the wait at MAX_RETRY_DELAY_MS even for an oversized Retry-After', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const successBody = { ok: true };
        // Retry-After far above the 20s ceiling — the wait must be clamped to 20000ms.
        fetchStub.onCall(0).resolves(makeResponse(429, {}, { 'Retry-After': '99999' }));
        fetchStub.onCall(1).resolves(makeResponse(200, successBody));
        const transport = fastTransport();
        const promise = transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
        await clock.tickAsync(0);
        expect(fetchStub.callCount).to.equal(1);
        await clock.tickAsync(20_000);
        const result = await promise;
        expect(fetchStub.callCount).to.equal(2);
        expect(result).to.deep.equal(successBody);
      } finally {
        clock.restore();
      }
    });

    it('treats a negative Retry-After (non-conforming) as absent → falls back to backoff', async () => {
      const successBody = { ok: true };
      // With retryBaseDelayMs 0, a null Retry-After ⇒ instant retry. A negative header value must
      // be ignored (parseRetryAfterMs returns null), never read as "retry immediately" or worse.
      fetchStub.onCall(0).resolves(makeResponse(429, {}, { 'Retry-After': '-5' }));
      fetchStub.onCall(1).resolves(makeResponse(200, successBody));
      const transport = fastTransport();
      const result = await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      expect(fetchStub.callCount).to.equal(2);
      expect(result).to.deep.equal(successBody);
    });

    it('applies jittered backoff (baseDelayMs > 0) using the [0.5, 1) multiplier', async () => {
      const clock = sinon.useFakeTimers();
      const randStub = sinon.stub(Math, 'random').returns(0); // multiplier = 0.5 + 0*0.5 = 0.5
      try {
        const successBody = { ok: true };
        // base 200ms, attempt 0, no Retry-After → 200 * 2**0 * 0.5 = 100ms.
        fetchStub.onCall(0).resolves(makeResponse(429, { error: 'rate limited' }));
        fetchStub.onCall(1).resolves(makeResponse(200, successBody));
        const transport = createElementsTransport({
          env: ENV, imsToken: IMS_TOKEN, maxRetries: 1, retryBaseDelayMs: 200,
        });
        const promise = transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
        await clock.tickAsync(0);
        expect(fetchStub.callCount).to.equal(1);
        await clock.tickAsync(99); // not yet — the jittered wait is 100ms
        expect(fetchStub.callCount).to.equal(1);
        await clock.tickAsync(1); // 100ms reached → retry fires
        const result = await promise;
        expect(fetchStub.callCount).to.equal(2);
        expect(result).to.deep.equal(successBody);
      } finally {
        randStub.restore();
        clock.restore();
      }
    });
  });

  describe('S2S consumer transport', () => {
    const S2S_BASE_URL = 'https://api.semrush.com';
    const API_KEY = 'test-admin-element-api-key';
    const S2S_ENV = { SEO_API_BASE_URL: S2S_BASE_URL, SEMRUSH_ADMIN_ELEMENT_API_KEY: API_KEY };
    const EXPECTED_S2S_URL = `${S2S_BASE_URL}/apis/v4-raw/external-api/v1/workspaces/${WORKSPACE_ID}/products/ai/elements/${ELEMENT_ID}`;

    describe('SEO_API_BASE_URL validation', () => {
      it('throws 503 when SEO_API_BASE_URL is not set', () => {
        expect(() => createElementsTransport({ env: {}, isS2SConsumer: true }))
          .to.throw().with.property('status', 503);
      });

      it('throws 503 when SEO_API_BASE_URL is not a valid URL', () => {
        expect(() => createElementsTransport({
          env: { SEO_API_BASE_URL: 'not a url' },
          isS2SConsumer: true,
        })).to.throw().with.property('status', 503);
      });

      it('throws 503 when SEO_API_BASE_URL uses http instead of https', () => {
        expect(() => createElementsTransport({
          env: { SEO_API_BASE_URL: 'http://api.semrush.com' },
          isS2SConsumer: true,
        })).to.throw().with.property('status', 503);
      });

      it('does not require SEMRUSH_PROJECTS_BASE_URL when isS2SConsumer is true', () => {
        expect(() => createElementsTransport({ env: S2S_ENV, isS2SConsumer: true })).to.not.throw();
      });
    });

    it('POSTs to the v4-raw external-api URL with no trailing /data', async () => {
      fetchStub.resolves(makeResponse(200, { blocks: { value: [] } }));
      const transport = createElementsTransport({ env: S2S_ENV, isS2SConsumer: true });
      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, { foo: 'bar' });
      const [url] = fetchStub.firstCall.args;
      expect(url).to.equal(EXPECTED_S2S_URL);
    });

    it('sends an Apikey Authorization header instead of Bearer', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const transport = createElementsTransport({ env: S2S_ENV, isS2SConsumer: true });
      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      const [, init] = fetchStub.firstCall.args;
      expect(init.headers.Authorization).to.equal(`Apikey ${API_KEY}`);
    });

    it('wraps the payload in { render_data: payload }', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const transport = createElementsTransport({ env: S2S_ENV, isS2SConsumer: true });
      const payload = { comparison_data_formatting: 'union' };
      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, payload);
      const [, init] = fetchStub.firstCall.args;
      expect(JSON.parse(init.body)).to.deep.equal({ render_data: payload });
    });

    it('throws 503 when SEMRUSH_ADMIN_ELEMENT_API_KEY is missing (server config gap, not caller auth failure)', async () => {
      const transport = createElementsTransport({
        env: { SEO_API_BASE_URL: S2S_BASE_URL },
        isS2SConsumer: true,
      });
      await expect(transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {}))
        .to.be.rejected.then((err) => {
          expect(err).to.have.property('status', 503);
        });
    });

    it('returns the same response shape as the regular (IMS) path', async () => {
      const successBody = { blocks: { value: [{ id: 1 }] } };
      fetchStub.resolves(makeResponse(200, successBody));
      const transport = createElementsTransport({ env: S2S_ENV, isS2SConsumer: true });
      const result = await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      expect(result).to.deep.equal(successBody);
    });

    it('still retries a 429 for S2S calls', async () => {
      const successBody = { ok: true };
      fetchStub.onCall(0).resolves(makeResponse(429, {}));
      fetchStub.onCall(1).resolves(makeResponse(200, successBody));
      const transport = createElementsTransport({
        env: S2S_ENV, isS2SConsumer: true, retryBaseDelayMs: 0,
      });
      const result = await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      expect(fetchStub.callCount).to.equal(2);
      expect(result).to.deep.equal(successBody);
    });
  });
});
