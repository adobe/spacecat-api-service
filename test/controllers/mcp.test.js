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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import McpController from '../../src/controllers/mcp.js';
import { buildRegistry } from '../../src/mcp/registry.js';

use(sinonChai);

describe('MCP Controller', () => {
  const sandbox = sinon.createSandbox();
  let context;
  let mcpController;

  beforeEach(() => {
    context = {
      log: console,
      dataAccess: {},
    };

    const registry = buildRegistry();
    mcpController = McpController(context, registry);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('lists configured tools via JSON-RPC', async () => {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    };

    context.data = payload;
    const resp = await mcpController.handleRpc(context);

    expect(resp.status).to.equal(200);
    const body = await resp.json();
    expect(body).to.have.property('result');
    const { tools } = body.result;
    const names = tools.map((t) => t.name);
    expect(names).to.include('echo');
  });

  it('executes echo tool', async () => {
    const payload = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'echo',
        arguments: { message: 'Hello World' },
      },
    };

    context.data = payload;
    const resp = await mcpController.handleRpc(context);

    expect(resp.status).to.equal(200);
    const body = await resp.json();
    expect(body).to.have.property('result');
    const [first] = body.result.content;
    expect(first.text).to.equal('Hello World');
  });

  it('returns Invalid params error for unknown tool', async () => {
    const payload = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'doesNotExist',
        arguments: {},
      },
    };

    context.data = payload;
    const resp = await mcpController.handleRpc(context);
    const body = await resp.json();

    expect(resp.status).to.equal(200);
    expect(body.error.code).to.equal(-32602);
    expect(body.id).to.equal(3);
  });

  it('returns Method not found error for unknown method', async () => {
    const payload = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/doesNotExist',
    };

    context.data = payload;
    const resp = await mcpController.handleRpc(context);
    const body = await resp.json();

    expect(resp.status).to.equal(200);
    expect(body).to.eql({
      jsonrpc: '2.0',
      id: 3,
      error: {
        code: -32601,
        message: 'Method not found',
      },
    });
  });

  it('rejects payloads exceeding size limit', async () => {
    // Create a payload slightly larger than 4 MB
    const huge = 'x'.repeat(4 * 1024 * 1024 + 10);
    context.data = huge;

    const resp = await mcpController.handleRpc(context);
    const body = await resp.json();

    expect(resp.status).to.equal(200);
    expect(body).to.eql({
      jsonrpc: '2.0',
      error: {
        code: -32602,
        message: 'Request body exceeds 4194304 bytes limit',
      },
      id: null,
    });
  });
});
