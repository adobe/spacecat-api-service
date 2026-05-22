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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

use(sinonChai);
use(chaiAsPromised);

const TEST_URL = 'https://main--project-elmo-ui-data--adobe.aem.live/folder/sheet.json';

const mockResponse = (data, ok = true, status = 200, statusText = 'OK') => ({
  ok,
  status,
  statusText,
  json: sinon.stub().resolves(data),
  headers: new Map([['content-type', 'application/json']]),
});

describe('llmo-source', () => {
  let fetchLlmoSource;
  let llmoSourceErrorResponse;
  let logNotProvisioned;
  let NOT_PROVISIONED_HEADER;
  let NOT_PROVISIONED_VALUE;
  let tracingFetchStub;
  let context;

  beforeEach(async () => {
    tracingFetchStub = sinon.stub();
    context = {
      log: {
        info: sinon.stub(), error: sinon.stub(), warn: sinon.stub(), debug: sinon.stub(),
      },
      env: { LLMO_HLX_API_KEY: 'test-key' },
    };
    const mod = await esmock('../../../src/controllers/llmo/llmo-source.js', {
      '@adobe/spacecat-shared-utils': {
        SPACECAT_USER_AGENT: 'test-ua',
        tracingFetch: tracingFetchStub,
      },
    });
    fetchLlmoSource = mod.fetchLlmoSource;
    llmoSourceErrorResponse = mod.llmoSourceErrorResponse;
    logNotProvisioned = mod.logNotProvisioned;
    NOT_PROVISIONED_HEADER = mod.NOT_PROVISIONED_HEADER;
    NOT_PROVISIONED_VALUE = mod.NOT_PROVISIONED_VALUE;
  });

  afterEach(() => sinon.restore());

  it('returns parsed data + headers on 2xx', async () => {
    tracingFetchStub.resolves(mockResponse({ rows: [1, 2] }));
    const result = await fetchLlmoSource(context, TEST_URL);
    expect(result.status).to.equal(200);
    expect(result.data).to.deep.equal({ rows: [1, 2] });
    expect(result.headers).to.be.an('object');
    expect(result.noData).to.be.undefined;
  });

  it('returns {status:404, noData:true} on upstream 404 (no throw)', async () => {
    tracingFetchStub.resolves(mockResponse(null, false, 404, 'Not Found'));
    const result = await fetchLlmoSource(context, TEST_URL);
    expect(result).to.deep.equal({ status: 404, noData: true });
  });

  it('drains the response body on a 404 so the connection can be reused', async () => {
    const cancel = sinon.stub().resolves();
    tracingFetchStub.resolves({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: sinon.stub(),
      headers: new Map(),
      body: { cancel },
    });
    const result = await fetchLlmoSource(context, TEST_URL);
    expect(result).to.deep.equal({ status: 404, noData: true });
    expect(cancel).to.have.been.calledOnce;
  });

  it('sends Authorization/User-Agent/Accept-Encoding headers and an abort signal', async () => {
    tracingFetchStub.resolves(mockResponse({}));
    await fetchLlmoSource(context, TEST_URL);
    const [url, opts] = tracingFetchStub.getCall(0).args;
    expect(url).to.equal(TEST_URL);
    expect(opts.headers.Authorization).to.equal('token test-key');
    expect(opts.headers['User-Agent']).to.equal('test-ua');
    expect(opts.headers['Accept-Encoding']).to.equal('br');
    expect(opts.signal).to.exist;
  });

  it('throws with upstreamStatus on non-404 non-OK (5xx)', async () => {
    tracingFetchStub.resolves(mockResponse(null, false, 500, 'Internal Server Error'));
    try {
      await fetchLlmoSource(context, TEST_URL);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.upstreamStatus).to.equal(500);
      expect(err.message).to.include('External API returned 500');
    }
  });

  it('throws with upstreamStatus on non-404 4xx (e.g. 401)', async () => {
    tracingFetchStub.resolves(mockResponse(null, false, 401, 'Unauthorized'));
    try {
      await fetchLlmoSource(context, TEST_URL);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.upstreamStatus).to.equal(401);
    }
  });

  it('throws isTimeout on AbortError', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    tracingFetchStub.rejects(abort);
    try {
      await fetchLlmoSource(context, TEST_URL);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.isTimeout).to.equal(true);
      expect(err.message).to.include('Request timeout');
    }
  });

  it('propagates non-AbortError fetch rejections unchanged', async () => {
    const netErr = new Error('ECONNREFUSED');
    tracingFetchStub.rejects(netErr);
    try {
      await fetchLlmoSource(context, TEST_URL);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.equal(netErr);
      expect(err.isTimeout).to.be.undefined;
    }
  });

  it('throws isConfigError when LLMO_HLX_API_KEY is missing (no fetch)', async () => {
    context.env.LLMO_HLX_API_KEY = undefined;
    try {
      await fetchLlmoSource(context, TEST_URL);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.isConfigError).to.equal(true);
      expect(tracingFetchStub).to.not.have.been.called;
    }
  });

  describe('llmoSourceErrorResponse', () => {
    it('maps isTimeout -> 504 with x-error header', () => {
      const e = new Error('Request timeout after 15000ms');
      e.isTimeout = true;
      const res = llmoSourceErrorResponse(e);
      expect(res.status).to.equal(504);
      expect(res.headers.get('x-error')).to.equal('Request timeout after 15000ms');
    });
    it('maps 5xx -> 502 with x-error header', () => {
      const e = new Error('External API returned 503');
      e.upstreamStatus = 503;
      const res = llmoSourceErrorResponse(e);
      expect(res.status).to.equal(502);
      expect(res.headers.get('x-error')).to.equal('External API returned 503');
    });
    it('passes through non-404 4xx with x-error header', () => {
      const e = new Error('External API returned 401');
      e.upstreamStatus = 401;
      const res = llmoSourceErrorResponse(e);
      expect(res.status).to.equal(401);
      expect(res.headers.get('x-error')).to.equal('External API returned 401');
    });
    it('maps isConfigError -> 500 with x-error header', () => {
      const e = new Error('LLMO_HLX_API_KEY environment variable is not configured');
      e.isConfigError = true;
      const res = llmoSourceErrorResponse(e);
      expect(res.status).to.equal(500);
      expect(res.headers.get('x-error')).to.equal('LLMO_HLX_API_KEY environment variable is not configured');
    });
    it('returns null for untagged errors (caller keeps its 400 fallback)', () => {
      expect(llmoSourceErrorResponse(new Error('Network error'))).to.equal(null);
    });
  });

  describe('logNotProvisioned', () => {
    it('emits a structured info line (not debug)', () => {
      logNotProvisioned(context.log, 'site-1', 'folder-1');
      expect(context.log.info).to.have.been.calledWith(
        'llmo_data_not_provisioned',
        { event: 'llmo_data_not_provisioned', siteId: 'site-1', dataFolder: 'folder-1' },
      );
      expect(context.log.debug).to.not.have.been.called;
    });
  });

  it('EMPTY_SHEET_PAYLOAD byte-matches the committed fixture', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = JSON.parse(readFileSync(join(here, '../../fixtures/llmo/empty-sheet.json'), 'utf-8'));
    const mod = await esmock('../../../src/controllers/llmo/llmo-source.js', {});
    expect(mod.EMPTY_SHEET_PAYLOAD).to.deep.equal(fixture);
  });

  it('exposes the not-provisioned discriminator header constants', () => {
    expect(NOT_PROVISIONED_HEADER).to.equal('x-llmo-data-status');
    expect(NOT_PROVISIONED_VALUE).to.equal('not-provisioned');
  });
});
