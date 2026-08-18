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
import { createQueryFanoutTransport } from '../../../src/support/serenity/query-fanout-transport.js';
import { SerenityTransportError } from '../../../src/support/serenity/serenity-transport-error.js';

use(chaiAsPromised);
use(sinonChai);

const BASE_URL = 'https://www.semrush.com';
const IMS_TOKEN = 'test-ims-token';
const WORKSPACE_ID = 'ws-uuid-123';
const RUN_ID = '01a00fae-053a-7ec4-83d6-a8c45a07fc1b'; // real Lovesac run id, used as the reference fixture
const EXPECTED_URL = `${BASE_URL}/enterprise/data-builder/gateway/api/v1/query-fanouts/${RUN_ID}?workspace_id=${WORKSPACE_ID}`;
const ENV = { SEMRUSH_PROJECTS_BASE_URL: BASE_URL };

function makeResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: sinon.stub().resolves(text),
  };
}

describe('createQueryFanoutTransport', () => {
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
      expect(() => createQueryFanoutTransport({ env: {}, imsToken: IMS_TOKEN }))
        .to.throw().with.property('status', 503);
    });

    it('throws 503 when SEMRUSH_PROJECTS_BASE_URL is not a valid URL', () => {
      expect(() => createQueryFanoutTransport({
        env: { SEMRUSH_PROJECTS_BASE_URL: 'not a url' },
        imsToken: IMS_TOKEN,
      })).to.throw().with.property('status', 503);
    });

    it('throws 503 when SEMRUSH_PROJECTS_BASE_URL is not https', () => {
      expect(() => createQueryFanoutTransport({
        env: { SEMRUSH_PROJECTS_BASE_URL: 'http://www.semrush.com' },
        imsToken: IMS_TOKEN,
      })).to.throw().with.property('status', 503);
    });
  });

  describe('getRunStatus', () => {
    it('GETs the status endpoint with the workspace_id query param and IMS bearer', async () => {
      fetchStub.resolves(makeResponse(200, { id: RUN_ID, status: 'succeeded' }));
      const transport = createQueryFanoutTransport({ env: ENV, imsToken: IMS_TOKEN });

      const result = await transport.getRunStatus({ workspaceId: WORKSPACE_ID, runId: RUN_ID });

      expect(result).to.deep.equal({ id: RUN_ID, status: 'succeeded' });
      expect(fetchStub).to.have.been.calledOnce;
      const [url, opts] = fetchStub.getCall(0).args;
      expect(url).to.equal(EXPECTED_URL);
      expect(opts.method).to.equal('GET');
      expect(opts.headers.Authorization).to.equal(`Bearer ${IMS_TOKEN}`);
    });

    it('URL-encodes workspaceId and runId', async () => {
      fetchStub.resolves(makeResponse(200, { status: 'queued' }));
      const transport = createQueryFanoutTransport({ env: ENV, imsToken: IMS_TOKEN });

      await transport.getRunStatus({ workspaceId: 'ws with space', runId: 'run/with/slash' });

      const [url] = fetchStub.getCall(0).args;
      expect(url).to.equal(
        `${BASE_URL}/enterprise/data-builder/gateway/api/v1/query-fanouts/run%2Fwith%2Fslash?workspace_id=ws%20with%20space`,
      );
    });

    it('throws SerenityTransportError with the missing-token message when imsToken is empty', async () => {
      const transport = createQueryFanoutTransport({ env: ENV, imsToken: '' });
      await expect(transport.getRunStatus({ workspaceId: WORKSPACE_ID, runId: RUN_ID }))
        .to.be.rejectedWith(SerenityTransportError, /Missing IMS bearer token/);
      expect(fetchStub).to.not.have.been.called;
    });

    it('throws SerenityTransportError on a non-2xx response, carrying the parsed body', async () => {
      fetchStub.resolves(makeResponse(404, { error: 'job not found' }));
      const transport = createQueryFanoutTransport({ env: ENV, imsToken: IMS_TOKEN });

      const err = await transport.getRunStatus({ workspaceId: WORKSPACE_ID, runId: RUN_ID })
        .then(() => null, (e) => e);

      expect(err).to.be.instanceOf(SerenityTransportError);
      expect(err.status).to.equal(404);
      expect(err.body).to.deep.equal({ error: 'job not found' });
    });

    it('falls back to raw text when the response body is not valid JSON', async () => {
      fetchStub.resolves(makeResponse(500, 'internal error'));
      const transport = createQueryFanoutTransport({ env: ENV, imsToken: IMS_TOKEN });

      const err = await transport.getRunStatus({ workspaceId: WORKSPACE_ID, runId: RUN_ID })
        .then(() => null, (e) => e);

      expect(err.body).to.equal('internal error');
    });

    it('returns null for an empty response body on success', async () => {
      fetchStub.resolves(makeResponse(200, ''));
      const transport = createQueryFanoutTransport({ env: ENV, imsToken: IMS_TOKEN });

      const result = await transport.getRunStatus({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
      expect(result).to.equal(null);
    });

    it('wraps an AbortError as a 504 timeout', async () => {
      fetchStub.callsFake(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      });
      const transport = createQueryFanoutTransport({ env: ENV, imsToken: IMS_TOKEN, timeoutMs: 5 });

      const err = await transport.getRunStatus({ workspaceId: WORKSPACE_ID, runId: RUN_ID })
        .then(() => null, (e) => e);

      expect(err).to.be.instanceOf(SerenityTransportError);
      expect(err.status).to.equal(504);
      expect(err.message).to.match(/timed out/);
    });

    it('rethrows a non-abort network error unchanged', async () => {
      const networkError = new Error('ECONNRESET');
      fetchStub.rejects(networkError);
      const transport = createQueryFanoutTransport({ env: ENV, imsToken: IMS_TOKEN });

      await expect(transport.getRunStatus({ workspaceId: WORKSPACE_ID, runId: RUN_ID }))
        .to.be.rejectedWith('ECONNRESET');
    });
  });
});
