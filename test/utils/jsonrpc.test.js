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

/* eslint-env mocha */

import { expect } from 'chai';
import { createJsonRpcErrorResponse, JSON_RPC_ERROR_CODES } from '../../src/utils/jsonrpc.js';

async function parseJson(response) {
  if (typeof response.json === 'function') {
    return response.json();
  }
  const txt = await response.text();
  return JSON.parse(txt);
}

describe('utils/jsonrpc', () => {
  it('builds error response with correct structure', async () => {
    const resp = createJsonRpcErrorResponse({
      id: 1,
      code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'Invalid Request',
    });

    expect(resp.status).to.equal(200);
    const body = await parseJson(resp);
    expect(body).to.deep.equal({
      jsonrpc: '2.0',
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request',
      },
      id: 1,
    });
  });

  it('includes optional data', async () => {
    const resp = createJsonRpcErrorResponse({
      id: null,
      code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
      data: { foo: 'bar' },
    });

    expect(resp.status).to.equal(200);
    const body = await parseJson(resp);
    expect(body.error.data).to.eql({ foo: 'bar' });
  });
});

describe('response processing', () => {
  function makeResponse({
    ok = true, status = 200, body = {}, isJson = true,
  } = {}) {
    return {
      ok,
      status,
      headers: new Map([['content-type', isJson ? 'application/json' : 'text/plain']]),
      clone() {
        return makeResponse({
          ok, status, body, isJson,
        });
      },
      async json() {
        if (isJson) return body;
        throw new Error('not json');
      },
      async text() { return isJson ? JSON.stringify(body) : String(body); },
    };
  }

  it('unwrapControllerResponse succeeds on ok json response', async () => {
    const { unwrapControllerResponse } = await import('../../src/utils/jsonrpc.js');
    const payload = { foo: 'bar' };
    const resp = makeResponse({ body: payload });
    const result = await unwrapControllerResponse(resp);
    expect(result).to.eql(payload);
  });

  it('unwrapControllerResponse maps 404 to NOT_FOUND code', async () => {
    const { unwrapControllerResponse, TOOL_ERROR_CODES } = await import('../../src/utils/jsonrpc.js');
    const resp = makeResponse({ ok: false, status: 404, body: { message: 'not here' } });
    try {
      await unwrapControllerResponse(resp, { context: { id: 1 } });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).to.equal(TOOL_ERROR_CODES.NOT_FOUND);
      expect(err.data.status).to.equal(404);
    }
  });

  it('withRpcErrorBoundary wraps unexpected error', async () => {
    const { withRpcErrorBoundary, TOOL_ERROR_CODES } = await import('../../src/utils/jsonrpc.js');
    const fn = async () => {
      throw new Error('boom');
    };
    try {
      await withRpcErrorBoundary(fn, { foo: 'ctx' });
      throw new Error('should fail');
    } catch (err) {
      expect(err.code).to.equal(TOOL_ERROR_CODES.INTERNAL_ERROR);
      expect(err.data.foo).to.equal('ctx');
    }
  });
});
