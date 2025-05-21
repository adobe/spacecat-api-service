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

/* c8 ignore start */

import { createResponse } from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMockResponse } from '../mcp/http-adapter.js';
import { getSdkServer } from '../mcp/server.js';
import { checkBodySize } from '../utils/validations.js';
import { createJsonRpcErrorResponse, JSON_RPC_ERROR_CODES } from '../utils/jsonrpc.js';

export default function McpController(ctx, registry) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  if (!isNonEmptyObject(registry)) {
    throw new Error('MCP registry required');
  }

  /* ===== helpers ===== */
  const send = (status, body) => createResponse(body, status);

  /* ----- JSON-RPC endpoint ----- */
  const handleRpc = async (context) => {
    try {
      const MAX_BODY_SIZE = 4 * 1024 * 1024; // 4 MB

      if (!checkBodySize(context.data, MAX_BODY_SIZE)) {
        return createJsonRpcErrorResponse({
          id: context?.data?.id ?? null,
          code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          message: `Request body exceeds ${MAX_BODY_SIZE} bytes limit`,
        });
      }

      const server = await getSdkServer(registry);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      await server.connect(transport); // idempotent

      // Build minimal Node-style request/response objects for the SDK transport
      const nodeReq = {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
      };

      const nodeRes = createMockResponse();

      await transport.handleRequest(nodeReq, nodeRes, context.data);

      // wait until transport signals the response is finished with a 30s timeout
      if (!nodeRes.finished) {
        const TIMEOUT_MS = 30_000;
        await Promise.race([
          nodeRes.done,
          new Promise((_, reject) => { setTimeout(() => reject(new Error('MCP response timeout')), TIMEOUT_MS); }),
        ]);
      }

      let parsedBody;
      try {
        parsedBody = JSON.parse(nodeRes.body || '{}');
      } catch {
        parsedBody = nodeRes.body;
      }

      return send(nodeRes.status || 200, parsedBody);
    } catch (e) {
      return createJsonRpcErrorResponse({
        id: context?.data?.id ?? null,
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: e.message || 'Internal error',
      });
    }
  };

  return { handleRpc };
}

/* c8 ignore end */
