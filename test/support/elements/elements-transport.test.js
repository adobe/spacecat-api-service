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
import {
  createElementsTransport,
  createElementsTransportForPurpose,
  ELEMENTS_CREDENTIAL_PROFILE_BRAND_CLAIMS,
  ELEMENTS_PURPOSE_BRAND_CLAIMS,
} from '../../../src/support/elements/elements-transport.js';
import { ElementsTransportError } from '../../../src/support/elements/errors.js';

use(chaiAsPromised);
use(sinonChai);

const BASE_URL = 'https://www.semrush.com';
const IMS_TOKEN = 'test-ims-token';
const WORKSPACE_ID = 'ws-uuid-123';
const ELEMENT_ID = 'el-uuid-456';
const EXPECTED_URL = `${BASE_URL}/enterprise/pages/api/v3/workspaces/${WORKSPACE_ID}/products/ai/elements/${ELEMENT_ID}/data`;
const ENV = { SEMRUSH_PROJECTS_BASE_URL: BASE_URL };
const EXTERNAL_BASE_URL = 'https://api.semrush.com';
const TECHNICAL_API_KEY = 'technical-api-key';
const TECHNICAL_ENV = {
  ...ENV,
  SEMRUSH_BRAND_CLAIMS_TECHNICAL_AUTH_ENABLED: 'true',
  SEMRUSH_BRAND_CLAIMS_API_KEY: TECHNICAL_API_KEY,
};
const EXPECTED_EXTERNAL_URL = `${EXTERNAL_BASE_URL}/apis/v4-raw/external-api/v1/workspaces/`
  + `${WORKSPACE_ID}/products/ai/elements/${ELEMENT_ID}`;

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

  describe('purpose-aware technical authentication', () => {
    const makePurposeTransport = (extra = {}) => createElementsTransportForPurpose({
      env: TECHNICAL_ENV,
      purpose: 'brand_claims',
      resolveImsToken: sinon.stub().resolves(IMS_TOKEN),
      ...extra,
    });

    it('exports stable literal purpose and profile identifiers', () => {
      expect(ELEMENTS_PURPOSE_BRAND_CLAIMS).to.equal('brand_claims');
      expect(ELEMENTS_CREDENTIAL_PROFILE_BRAND_CLAIMS).to.equal('brand_claims');
    });

    it('uses the Brand Claims profile wire contract', async () => {
      fetchStub.resolves(makeResponse(200, { blocks: { value: [] } }));
      const resolveImsToken = sinon.stub().resolves(IMS_TOKEN);
      const payload = { comparison_data_formatting: 'union' };
      const transport = await makePurposeTransport({ resolveImsToken });

      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, payload);

      const [url, init] = fetchStub.firstCall.args;
      expect(url).to.equal(EXPECTED_EXTERNAL_URL);
      expect(url).to.not.match(/\/data$/);
      expect(init.headers.Authorization).to.equal(`Apikey ${TECHNICAL_API_KEY}`);
      expect(init.headers.Authorization).to.not.contain('Bearer');
      expect(init.body).to.equal(JSON.stringify({ render_data: payload }));
      expect(resolveImsToken).to.not.have.been.called;
    });

    ['TRUE', '1', 'false', true, undefined].forEach((flag) => {
      it(`keeps IMS auth when the enable flag is ${String(flag)}`, async () => {
        fetchStub.resolves(makeResponse(200, {}));
        const resolveImsToken = sinon.stub().resolves(IMS_TOKEN);
        const transport = await makePurposeTransport({
          env: {
            ...TECHNICAL_ENV,
            SEMRUSH_BRAND_CLAIMS_TECHNICAL_AUTH_ENABLED: flag,
          },
          resolveImsToken,
        });

        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, { original: true });

        expect(resolveImsToken).to.have.been.calledOnce;
        expect(fetchStub.firstCall.args[0]).to.equal(EXPECTED_URL);
        expect(fetchStub.firstCall.args[1].headers.Authorization).to.equal(`Bearer ${IMS_TOKEN}`);
        expect(fetchStub.firstCall.args[1].body).to.equal(JSON.stringify({ original: true }));
      });
    });

    [' true ', 'true\n'].forEach((flag) => {
      it(`trims surrounding whitespace from the enabled flag ${JSON.stringify(flag)}`, async () => {
        fetchStub.resolves(makeResponse(200, {}));
        const resolveImsToken = sinon.stub().resolves(IMS_TOKEN);
        const transport = await makePurposeTransport({
          env: {
            ...TECHNICAL_ENV,
            SEMRUSH_BRAND_CLAIMS_TECHNICAL_AUTH_ENABLED: flag,
          },
          resolveImsToken,
        });

        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});

        expect(resolveImsToken).to.not.have.been.called;
        expect(fetchStub.firstCall.args[0]).to.equal(EXPECTED_EXTERNAL_URL);
        expect(fetchStub.firstCall.args[1].headers.Authorization)
          .to.equal(`Apikey ${TECHNICAL_API_KEY}`);
      });
    });

    it('ignores broad or unrelated ABV credential variables', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const resolveImsToken = sinon.stub().resolves(IMS_TOKEN);
      const transport = await makePurposeTransport({
        env: {
          SEMRUSH_PROJECTS_BASE_URL: BASE_URL,
          SEMRUSH_ELEMENTS_TECHNICAL_AUTH_ENABLED: 'true',
          SEMRUSH_ELEMENTS_TECHNICAL_API_KEY: 'broad-key',
          SEMRUSH_ABV_SHARED_ELEMENTS_TECHNICAL_AUTH_ENABLED: 'true',
          SEMRUSH_ABV_SHARED_ELEMENTS_API_KEY: 'unrelated-abv-key',
        },
        resolveImsToken,
      });

      await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, { original: true });

      expect(resolveImsToken).to.have.been.calledOnce;
      expect(fetchStub.firstCall.args[0]).to.equal(EXPECTED_URL);
      expect(fetchStub.firstCall.args[1].headers.Authorization).to.equal(`Bearer ${IMS_TOKEN}`);
    });

    it('fails closed rather than consuming a broad or unrelated ABV key', async () => {
      const resolveImsToken = sinon.stub().resolves(IMS_TOKEN);
      const unrelatedKeys = ['broad-key', 'unrelated-abv-key'];
      let err;
      try {
        await makePurposeTransport({
          env: {
            SEMRUSH_PROJECTS_BASE_URL: BASE_URL,
            SEMRUSH_BRAND_CLAIMS_TECHNICAL_AUTH_ENABLED: 'true',
            SEMRUSH_ELEMENTS_TECHNICAL_API_KEY: unrelatedKeys[0],
            SEMRUSH_ABV_SHARED_ELEMENTS_API_KEY: unrelatedKeys[1],
          },
          resolveImsToken,
        });
      } catch (e) {
        err = e;
      }

      expect(err.status).to.equal(503);
      expect(err.message).to.contain('SEMRUSH_BRAND_CLAIMS_API_KEY');
      unrelatedKeys.forEach((key) => expect(err.message).to.not.contain(key));
      expect(resolveImsToken).to.not.have.been.called;
      expect(fetchStub).to.not.have.been.called;
    });

    [undefined, 'unknown'].forEach((purpose) => {
      it(`keeps IMS auth for purpose ${String(purpose)}`, async () => {
        fetchStub.resolves(makeResponse(200, {}));
        const resolveImsToken = sinon.stub().resolves(IMS_TOKEN);
        const transport = await makePurposeTransport({ purpose, resolveImsToken });

        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});

        expect(resolveImsToken).to.have.been.calledOnce;
        expect(fetchStub.firstCall.args[1].headers.Authorization).to.equal(`Bearer ${IMS_TOKEN}`);
      });
    });

    it('preserves IMS 429 retries when a mapped profile is disabled', async () => {
      fetchStub.onCall(0).resolves(makeResponse(429, { error: 'rate limited' }));
      fetchStub.onCall(1).resolves(makeResponse(200, { ok: true }));
      const resolveImsToken = sinon.stub().resolves(IMS_TOKEN);
      const transport = await makePurposeTransport({
        env: {
          ...TECHNICAL_ENV,
          SEMRUSH_BRAND_CLAIMS_TECHNICAL_AUTH_ENABLED: 'false',
        },
        resolveImsToken,
        maxRetries: 1,
        retryBaseDelayMs: 0,
      });

      const result = await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, { original: true });

      expect(result).to.deep.equal({ ok: true });
      expect(resolveImsToken).to.have.been.calledOnce;
      expect(fetchStub).to.have.been.calledTwice;
      expect(fetchStub.firstCall.args[0]).to.equal(EXPECTED_URL);
      expect(fetchStub.firstCall.args[1].headers.Authorization).to.equal(`Bearer ${IMS_TOKEN}`);
      expect(fetchStub.firstCall.args[1].body).to.equal(JSON.stringify({ original: true }));
    });

    [
      [{ SEMRUSH_BRAND_CLAIMS_API_KEY: undefined }, 'SEMRUSH_BRAND_CLAIMS_API_KEY'],
      [{ SEMRUSH_BRAND_CLAIMS_API_KEY: '   ' }, 'SEMRUSH_BRAND_CLAIMS_API_KEY'],
    ].forEach(([envOverride, variable]) => {
      it(`fails closed with 503 for invalid ${variable} configuration`, async () => {
        const resolveImsToken = sinon.stub().resolves(IMS_TOKEN);
        let err;
        try {
          await makePurposeTransport({
            env: { ...TECHNICAL_ENV, ...envOverride },
            resolveImsToken,
          });
        } catch (e) {
          err = e;
        }

        expect(err.status).to.equal(503);
        expect(err.message).to.contain(variable);
        expect(err.message).to.not.contain(TECHNICAL_API_KEY);
        expect(resolveImsToken).to.not.have.been.called;
        expect(fetchStub).to.not.have.been.called;
      });
    });

    it('uses the fixed Semrush external origin and URL-encodes ids', async () => {
      fetchStub.resolves(makeResponse(200, {}));
      const transport = await makePurposeTransport();

      await transport.fetchElement('ws/special', 'el/special', {});

      expect(fetchStub.firstCall.args[0]).to.equal(
        `${EXTERNAL_BASE_URL}/apis/v4-raw/external-api/v1/workspaces/ws%2Fspecial/`
        + 'products/ai/elements/el%2Fspecial',
      );
    });

    it('keeps technical credentials out of upstream error metadata', async () => {
      fetchStub.resolves(makeResponse(403, { error: 'denied' }));
      const transport = await makePurposeTransport();
      let err;
      try {
        await transport.fetchElement(WORKSPACE_ID, ELEMENT_ID, {});
      } catch (e) {
        err = e;
      }

      expect(err).to.be.instanceOf(ElementsTransportError);
      expect(err).to.include({
        method: 'POST',
        endpoint: `/apis/v4-raw/external-api/v1/workspaces/${WORKSPACE_ID}`
          + `/products/ai/elements/${ELEMENT_ID}`,
        workspaceId: WORKSPACE_ID,
        elementId: ELEMENT_ID,
      });
      expect(JSON.stringify(err)).to.not.contain(TECHNICAL_API_KEY);
      expect(err.message).to.not.contain(TECHNICAL_API_KEY);
    });

    it('does not retry a technical-account request on 429', async () => {
      fetchStub.resolves(makeResponse(429, { error: 'rate limited' }));
      const transport = await makePurposeTransport({
        maxRetries: 2,
        retryBaseDelayMs: 0,
      });

      await expect(transport.fetchElement(
        WORKSPACE_ID,
        ELEMENT_ID,
        {},
        { maxRetries: 2 },
      )).to.be.rejectedWith(ElementsTransportError);

      expect(fetchStub).to.have.been.calledOnce;
    });

    it('honors a per-call timeout override on the technical transport', async () => {
      const clock = sinon.useFakeTimers();
      try {
        fetchStub.callsFake((url, init) => new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        }));
        const transport = await makePurposeTransport();
        const settledPromise = transport
          .fetchElement(WORKSPACE_ID, ELEMENT_ID, {}, { timeoutMs: 1234 })
          .catch((e) => e);

        await clock.tickAsync(1233);
        expect(fetchStub.firstCall.args[1].signal.aborted).to.be.false;
        await clock.tickAsync(1);

        const err = await settledPromise;
        expect(err).to.be.instanceOf(ElementsTransportError);
        expect(err.status).to.equal(504);
        expect(fetchStub.firstCall.args[1].signal.aborted).to.be.true;
      } finally {
        clock.restore();
      }
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
});
