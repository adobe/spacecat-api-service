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

import { tracingFetch } from '@adobe/spacecat-shared-utils';

/**
 * The write-capable AEM Content MCP server (Streamable HTTP transport). The
 * read-only variant is `.../adobe/mcp/content-readonly`.
 */
export const AEM_CONTENT_MCP_URL = 'https://mcp.adobeaemcloud.com/adobe/mcp/content';

/**
 * Parse a Streamable-HTTP MCP response body, which may be a plain JSON-RPC object
 * or an SSE frame (`event: message\ndata: {json}`). Returns the parsed JSON-RPC object.
 * @param {string} raw
 * @returns {object}
 */
const parseJsonRpc = (raw) => {
  const text = raw.includes('\ndata:') || raw.startsWith('data:')
    ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    : raw;
  return text.trim() ? JSON.parse(text) : {};
};

/**
 * Concatenate the text parts of an MCP tool result (`result.content[].text`).
 * @param {object} rpc - Parsed JSON-RPC response.
 * @returns {string}
 */
const toolResultText = (rpc) => (rpc?.result?.content || [])
  .map((p) => p.text || '')
  .join('\n');

/**
 * Opens an AEM Content MCP session over Streamable HTTP and returns a thin
 * `callTool` wrapper. Deterministic, no LLM: the caller decides which tool and
 * arguments to invoke. Auth is the caller's IMS user access token, forwarded as
 * `Authorization: Bearer` — the same token the AEM UI holds (see feasibility
 * notes). One handshake (`initialize` + `notifications/initialized`) per session;
 * reuse the returned client across several tool calls in one request.
 *
 * @param {object} opts
 * @param {string} opts.authorization - Full `Authorization` header value (`Bearer <ims-token>`).
 * @param {string} [opts.mcpUrl] - MCP endpoint; defaults to the write-capable content server.
 * @param {object} [opts.log] - Logger.
 * @param {Function} [opts.fetch] - fetch implementation (defaults to tracingFetch; for tests).
 * @returns {Promise<{ callTool: (name: string, args: object) => Promise<string> }>}
 * @throws {Error} If the initialize handshake fails (bad/insufficient token, unreachable server).
 */
export async function createAemContentMcpSession({
  authorization,
  mcpUrl = AEM_CONTENT_MCP_URL,
  log = console,
  fetch = tracingFetch,
}) {
  const baseHeaders = {
    Authorization: authorization,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  const post = (body, sessionId) => fetch(mcpUrl, {
    method: 'POST',
    headers: sessionId ? { ...baseHeaders, 'mcp-session-id': sessionId } : baseHeaders,
    body: JSON.stringify(body),
  });

  // 1. initialize -> the server returns the session id in the mcp-session-id header.
  const initRes = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'spacecat-api-service', version: '1.0.0' },
    },
  });
  if (!initRes.ok) {
    const detail = await initRes.text().catch(() => '');
    throw new Error(`AEM MCP initialize failed (HTTP ${initRes.status}): ${detail.slice(0, 300)}`);
  }
  const sessionId = initRes.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new Error('AEM MCP initialize returned no session id');
  }

  // 2. required notification to complete the handshake.
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);

  let nextId = 2;
  const callTool = async (name, args) => {
    const res = await post({
      jsonrpc: '2.0',
      // eslint-disable-next-line no-plusplus
      id: nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    }, sessionId);
    const raw = await res.text();
    const rpc = parseJsonRpc(raw);
    if (rpc.error) {
      throw new Error(`AEM MCP tool "${name}" error: ${rpc.error.message || JSON.stringify(rpc.error)}`);
    }
    // A tool that reports an application-level failure sets result.isError with the
    // detail in the text content; surface it as a thrown error for the caller.
    if (rpc?.result?.isError) {
      throw new Error(`AEM MCP tool "${name}" failed: ${toolResultText(rpc).slice(0, 300)}`);
    }
    log?.debug?.(`[aem-mcp] tool ${name} ok`);
    return toolResultText(rpc);
  };

  return { callTool };
}
