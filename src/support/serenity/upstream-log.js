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

// @ts-check

/**
 * @fileoverview Structured, queryable logging for failed Semrush upstream calls
 * (SITES-49993). A failing Elements / Project Engine / User Manager call must
 * produce ONE log line carrying the upstream status, the (bounded, secret-
 * scrubbed) upstream body, and the request context that identifies the call —
 * as JSON embedded in the message, so a CloudWatch Logs Insights query can
 * `parse @message` and group Semrush failures by tenant and upstream reason.
 *
 * Everything here is server-side only. Client-facing responses stay generic —
 * the controllers' mapError/createErrorResponse redaction contract is untouched.
 */

import { scrubDeep } from '../feedback-redaction.js';

/**
 * Upper bound on the logged upstream body. The body is attacker-influenced
 * upstream content; an unbounded blob in every error line is its own problem.
 */
const MAX_BODY_LEN = 2000;

/**
 * Builds the structured payload for one failed upstream call: the fields the
 * error itself carries (`status`, `body`, and — where the transport attached
 * them — `method`, `endpoint`, `workspaceId`, `elementId`) merged over the
 * caller-supplied request context (tenant ids from the controller scope). The
 * error's own fields win on collision — they describe the call that actually
 * went to the wire.
 *
 * The upstream body is secret-scrubbed (same patterns as the feedback-capture
 * redaction), stringified, and truncated to {@link MAX_BODY_LEN} characters.
 *
 * @param {unknown} err - the upstream error (ElementsTransportError,
 *   SerenityTransportError, or ProjectEngineApiError).
 * @param {Record<string, unknown>} [reqCtx] - request context ids
 *   (workspaceId, brandId, spaceCatId, projectId, ...).
 * @returns {Record<string, unknown>}
 */
export function upstreamLogPayload(err, reqCtx = {}) {
  /** @type {{ status?: number, method?: string, endpoint?: string, workspaceId?: string,
   *   elementId?: string, message?: string, body?: unknown }} */
  const e = (err && typeof err === 'object') ? err : {};
  /** @type {Record<string, unknown>} */
  const payload = { ...reqCtx };
  if (e.status !== undefined) {
    payload.status = e.status;
  }
  if (e.method) {
    payload.method = e.method;
  }
  if (e.endpoint) {
    payload.endpoint = e.endpoint;
  }
  if (e.workspaceId) {
    payload.workspaceId = e.workspaceId;
  }
  if (e.elementId) {
    payload.elementId = e.elementId;
  }
  if (e.message) {
    // Server-side only: may embed the upstream URL (internal host + ids) —
    // exactly the detail the client-facing responses deliberately redact.
    payload.message = e.message;
  }
  if (e.body !== undefined && e.body !== null) {
    const scrubbed = scrubDeep(e.body, {});
    let text = typeof scrubbed === 'string' ? scrubbed : JSON.stringify(scrubbed);
    if (text.length > MAX_BODY_LEN) {
      text = `${text.slice(0, MAX_BODY_LEN)}...[truncated]`;
    }
    payload.body = text;
  }
  return payload;
}

/**
 * Logs one structured line for a failed upstream call:
 * `<label> {"status":403,"method":"GET","workspaceId":"...","body":"..."}`.
 *
 * The payload is embedded as JSON in the message (rather than passed as an
 * object argument) so Logs Insights can reliably `parse @message` —
 * `context.log` is bound `console.*`, which would render an object argument
 * as util.inspect text with unquoted keys. The error's STACK rides along as
 * the second argument so the trace stays in the log line — the stack string
 * only, never the error object itself: `console.error` renders an Error's
 * enumerable own properties, which would print the raw un-scrubbed `.body`
 * right next to the redacted payload and defeat the scrub. Field-level
 * `parse @message` filters are unaffected by the trailing stack.
 *
 * @param {{ error: (...args: unknown[]) => void }} log
 * @param {string} label - stable message prefix to filter on
 *   (e.g. 'Serenity upstream error').
 * @param {unknown} err
 * @param {Record<string, unknown>} [reqCtx]
 */
export function logUpstreamError(log, label, err, reqCtx = {}) {
  const line = `${label} ${JSON.stringify(upstreamLogPayload(err, reqCtx))}`;
  if (err instanceof Error && err.stack) {
    log.error(line, err.stack);
  } else {
    log.error(line);
  }
}
