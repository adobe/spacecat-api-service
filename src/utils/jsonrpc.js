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

/*
 * JSON-RPC 2.0 helper utilities.
 *
 * Currently only error responses are covered.
 */

import { createResponse } from '@adobe/spacecat-shared-http-utils';

// --- JSON-RPC 2.0 pre-defined error codes (spec §5.1) ---
export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // implementation-defined range: -32000 to -32099 (Server error)
};

// ---------------------------------------------------------------------------
// Server-defined error codes for tool handlers (subset of -32000..-32099)
export const TOOL_ERROR_CODES = {
  NOT_FOUND: -32010,
  INTERNAL_ERROR: -32020,
  FORBIDDEN: -32030,
};

// Map controller HTTP status codes to JSON-RPC error codes
export function mapHttpStatusToRpcCode(status) {
  if (status === 400) return JSON_RPC_ERROR_CODES.INVALID_PARAMS; // validation
  if (status === 403) return TOOL_ERROR_CODES.FORBIDDEN; // authz
  if (status === 404) return TOOL_ERROR_CODES.NOT_FOUND; // missing
  return TOOL_ERROR_CODES.INTERNAL_ERROR; // generic
}

/**
 * Extract payload from a Fetch Response object produced by an existing
 * SpaceCat controller.  If the response status is not ok, throw an Error
 * annotated with `.code` and `.data` so the MCP SDK turns it into a
 * JSON-RPC error automatically.
 *
 * @param {Response} response
 * @param {object} opts
 * @param {string} [opts.notFoundMessage]
 * @param {object} [opts.context]
 * @returns {Promise<any>} parsed body
 */
export async function unwrapControllerResponse(
  response,
  { notFoundMessage = 'Resource not found', context = {} } = {},
) {
  if (!response) {
    const err = new Error('Empty response');
    err.code = TOOL_ERROR_CODES.INTERNAL_ERROR;
    err.data = context;
    throw err;
  }

  if (!response.ok) {
    let message = notFoundMessage;
    // controllers typically send { message } JSON bodies; fall back to text
    try {
      const payload = await response.clone().json();
      if (payload && typeof payload.message === 'string') message = payload.message;
    } catch {
      try {
        message = await response.clone().text();
      } catch { /* ignore */ }
    }

    const err = new Error(message);
    err.code = mapHttpStatusToRpcCode(response.status);
    err.data = { status: response.status, ...context };
    throw err;
  }

  const ct = response.headers.get('content-type') || '';
  return ct.includes('application/json') ? response.json() : response.text();
}

/**
 * Executes an async function and converts any unexpected exception into an
 * annotated JSON-RPC error unless it already carries a `.code` property.
 *
 * @param {Function} fn
 * @param {object} context – merged into error.data when wrapping
 * @returns {Promise<any>}
 */
export async function withRpcErrorBoundary(fn, context = {}) {
  try {
    return await fn();
  } catch (err) {
    if (err && typeof err.code === 'number') throw err;
    const wrapped = new Error(err instanceof Error ? err.message : String(err));
    wrapped.code = TOOL_ERROR_CODES.INTERNAL_ERROR;
    wrapped.data = context;
    throw wrapped;
  }
}

/**
 * Maps error codes to HTTP status when caller explicitly requests it.
 * By default JSON-RPC error responses will use HTTP 200, because the
 * transport succeeded and only the RPC layer reported an error.
 *
 * @param {number} code – JSON-RPC error code.
 * @returns {number}
 */
function mapErrorCodeToStatus(code) {
  if (code === JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND) return 404;
  if ([
    JSON_RPC_ERROR_CODES.PARSE_ERROR,
    JSON_RPC_ERROR_CODES.INVALID_REQUEST,
    JSON_RPC_ERROR_CODES.INVALID_PARAMS,
  ].includes(code)) return 400;
  return 500;
}

/**
 * Build a JSON-RPC 2.0 compliant error `Response`.
 *
 * @param {object} options
 * @param {string|number|null} options.id – id of the request (or null).
 * @param {number} options.code – JSON-RPC error code.
 * @param {string} options.message – error message.
 * @param {any} [options.data] – optional data field with additional details.
 * @param {number} [options.httpStatus] – optional HTTP status; defaults to 200.
 * @returns {Response}
 */
export function createJsonRpcErrorResponse({
  id = null, code, message, data, httpStatus,
}) {
  const body = {
    jsonrpc: '2.0',
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
    id,
  };

  const status = httpStatus !== undefined ? httpStatus : 200;
  return createResponse(body, status);
}

export default {
  createJsonRpcErrorResponse,
  mapErrorCodeToStatus,
  TOOL_ERROR_CODES,
  unwrapControllerResponse,
  withRpcErrorBoundary,
  mapHttpStatusToRpcCode,
};

/* c8 ignore end */
