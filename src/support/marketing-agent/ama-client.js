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

/*
 * Minimal client for the Adobe Marketing Agent / AEP Agentic Orchestrator MCP endpoint.
 *
 * Speaks MCP "Streamable HTTP" over fetch (no SDK dependency): initialize -> notify
 * initialized -> tools/call. Responses may be JSON or an SSE (text/event-stream) frame;
 * both are handled. Auth is a Bearer IMS token (POC: the caller's forwarded token).
 *
 * NOTE (verify against a discovery spike): the default endpoint and tool name are best
 * guesses. Confirm the real values with `listTools()` and override via env
 * (AMA_MCP_ENDPOINT, AMA_TOOL_NAME) before relying on this.
 */

const DEFAULT_ENDPOINT = 'https://aep-ai-ama.adobe.io/mcp';
const DEFAULT_TOOL_NAME = 'adobe-marketing-agent-mcp-widget';
const REQUEST_TIMEOUT_MS = 60_000;

function parseMcpBody(contentType, raw) {
  if (!raw) {
    return null;
  }
  if (contentType.includes('application/json')) {
    return JSON.parse(raw);
  }
  // SSE frame: parse the last `data:` line.
  const dataLines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'));
  if (dataLines.length === 0) {
    return null;
  }
  const payload = dataLines[dataLines.length - 1].slice('data:'.length).trim();
  return payload ? JSON.parse(payload) : null;
}

/**
 * Pulls human-readable text out of the various response shapes the agent returns:
 * - the AEP AMA widget shape (verified live): result._meta['openai.com/widget'].resource.text
 *   is a JSON string wrapping { result: { parts: [{ kind:'text', text }] } }
 * - standard MCP tool results ({ content: [{ type:'text', text }] })
 * - the A2A-wrapped shape ({ result: { parts: [{ kind:'text', text }] } })
 */
function extractText(body) {
  if (!body) {
    return '';
  }
  const result = body.result ?? body;

  // AEP Adobe Marketing Agent nests the A2A message JSON as a string inside the widget meta.
  // eslint-disable-next-line no-underscore-dangle -- `_meta` is the MCP spec field name
  const widgetText = result?._meta?.['openai.com/widget']?.resource?.text;
  if (typeof widgetText === 'string') {
    try {
      const inner = extractText(JSON.parse(widgetText));
      if (inner) {
        return inner;
      }
    } catch {
      // fall through to the other shapes
    }
  }

  if (Array.isArray(result?.content)) {
    return result.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }

  const parts = result?.result?.parts ?? result?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((part) => typeof part?.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }

  if (typeof result === 'string') {
    return result;
  }
  return '';
}

async function mcpPost(endpoint, token, sessionId, payload) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const raw = await response.text();
  const contentType = response.headers.get('content-type') || '';
  return {
    ok: response.ok,
    status: response.status,
    sessionId: response.headers.get('mcp-session-id') || sessionId,
    body: parseMcpBody(contentType, raw),
    raw,
  };
}

/**
 * Creates an Adobe Marketing Agent MCP client.
 * @param {object} opts
 * @param {string} [opts.endpoint] - MCP endpoint (default AEP AMA prod)
 * @param {string} [opts.toolName] - MCP tool name to call
 * @param {string} opts.token - IMS bearer token
 * @param {object} [opts.log] - logger
 */
export function createAmaClient({
  endpoint = DEFAULT_ENDPOINT,
  toolName = DEFAULT_TOOL_NAME,
  token,
  log = console,
} = {}) {
  async function handshake() {
    const init = await mcpPost(endpoint, token, null, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'spacecat-marketing-consultant', version: '1.0.0' },
      },
    });
    if (!init.ok) {
      throw new Error(`MCP initialize failed (${init.status}): ${init.raw?.slice(0, 200)}`);
    }
    await mcpPost(endpoint, token, init.sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    return init.sessionId;
  }

  /** Calls the agent with a plain-text query and returns the synthesized text. */
  async function callAgent(query) {
    if (!token) {
      throw new Error('AMA client requires an IMS bearer token');
    }
    const sessionId = await handshake();

    const call = await mcpPost(endpoint, token, sessionId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: { query } },
    });
    if (!call.ok) {
      throw new Error(`MCP tools/call failed (${call.status}): ${call.raw?.slice(0, 200)}`);
    }

    const text = extractText(call.body);
    if (!text) {
      log.warn?.('AMA client: no text extracted from tools/call response');
    }
    return text;
  }

  /** Lists the tools the endpoint exposes — use this to confirm the tool name. */
  async function listTools() {
    if (!token) {
      throw new Error('AMA client requires an IMS bearer token');
    }
    const sessionId = await handshake();
    const res = await mcpPost(endpoint, token, sessionId, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });
    return res.body?.result?.tools ?? [];
  }

  return { callAgent, listTools };
}
