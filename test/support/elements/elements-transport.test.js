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

function makeResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: sinon.stub().resolves(text),
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
  });
});
