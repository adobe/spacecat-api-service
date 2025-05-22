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

import { ok } from '@adobe/spacecat-shared-http-utils';
import McpController from '../../src/controllers/mcp.js';
import buildRegistry from '../../src/mcp/registry.js';

use(sinonChai);

describe('MCP Controller', () => {
  const sandbox = sinon.createSandbox();
  let context;
  let mcpController;
  let auditsController;
  let sitesController;

  beforeEach(() => {
    context = {
      log: console,
      dataAccess: {},
    };

    auditsController = {
      getLatestForSite: sandbox.stub().resolves(ok({
        siteId: 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14',
        auditedAt: '2024-01-20T12:00:00Z',
        expiresAt: '2024-07-20T12:00:00Z',
        auditType: 'cwv',
        isError: false,
        deliveryType: 'aem_edge',
        fullAuditRef: 'https://some-audit-system/full-report/1234',
        auditResult: {
          someProperty: 'someValue',
        },
        previousAuditResult: {
          someProperty: 'somePreviousValue',
        },
      })),
    };

    sitesController = {
      getByID: sandbox.stub().resolves(ok({
        siteId: 'siteId',
        name: 'siteName',
        description: 'siteDescription',
        baseURL: 'https://example.com',
      })),
      getByBaseURL: sandbox.stub().resolves(ok({
        siteId: 'siteId',
        name: 'siteName',
        description: 'siteDescription',
        baseURL: 'https://example.com',
      })),
    };
    const registry = buildRegistry({
      auditsController,
      sitesController,
    });
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

  it('lists configured resources via JSON-RPC', async () => {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/templates/list',
      params: {},
    };

    context.data = payload;
    const resp = await mcpController.handleRpc(context);

    expect(resp.status).to.equal(200);
    const body = await resp.json();
    expect(body).to.have.property('result');
    const { resourceTemplates } = body.result;
    expect(resourceTemplates).to.be.an('array');

    const siteResource = resourceTemplates.find((r) => r.name === 'site');
    expect(siteResource).to.exist;
    expect(siteResource).to.have.property('uriTemplate');
    expect(siteResource.uriTemplate).to.equal('spacecat-data://sites/{siteId}');
    expect(siteResource).to.have.property('mimeType', 'application/json');
  });

  it('retrieves site resource by UUID', async () => {
    const siteId = '123e4567-e89b-12d3-a456-426614174000';
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: {
        uri: `spacecat-data://sites/${siteId}`,
      },
    };

    context.data = payload;
    const resp = await mcpController.handleRpc(context);

    expect(resp.status).to.equal(200);
    const body = await resp.json();
    expect(body).to.have.property('result');
    const [first] = body.result.contents;
    expect(JSON.parse(first.text)).to.deep.include({
      siteId: 'siteId',
      name: 'siteName',
      description: 'siteDescription',
      baseURL: 'https://example.com',
    });
  });

  it('retrieves site resource by base URL', async () => {
    const baseURL = 'https://example,.com';
    const baseURLBase64 = Buffer.from(baseURL).toString('base64');
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: {
        uri: `spacecat-data://sites/by-base-url/${baseURLBase64}`,
      },
    };

    context.data = payload;
    const resp = await mcpController.handleRpc(context);

    expect(resp.status).to.equal(200);
    const body = await resp.json();
    expect(body).to.have.property('result');
    const [first] = body.result.contents;
    expect(first).to.have.property('uri', `spacecat-data://sites/by-base-url/${baseURLBase64}`);
    expect(JSON.parse(first.text)).to.deep.include({
      siteId: 'siteId',
      name: 'siteName',
      description: 'siteDescription',
      baseURL: 'https://example.com',
    });
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
