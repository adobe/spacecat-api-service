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

import { SerenityTransportError } from './rest-transport.js';

/**
 * Recognises an upstream "already gone" response — the signal that an
 * idempotent DELETE-style operation can treat as success without falling
 * through to the generic 502 path.
 *
 * Strict shape: must be a SerenityTransportError AND status === 404.
 * Refuses to match generic Error subclasses or ad-hoc objects whose
 * `.status` happens to equal 404. This is the safe variant — a future
 * library or test stub decorating an unrelated error with `status: 404`
 * cannot silently turn into "upstream-idempotent-success" and swallow
 * a real failure.
 *
 * Used by every idempotent-DELETE site in the serenity surface:
 *   - markets.js handleDeleteMarket  (upstream project gone)
 *   - prompts.js handleUpdatePrompt  (deleted-then-create, the delete leg)
 *   - prompts.js handleBulkDeletePrompts  (per-project bucket delete)
 */
export function isUpstreamGone(e) {
  return e instanceof SerenityTransportError && e.status === 404;
}

/**
 * The upstream error body as a lowercased string, for message-based classification. The gateway
 * returns either a JSON `{ message }` object or a bare text/html string (the disguised-405 case);
 * this normalises both so a predicate can match on substrings.
 * @param {unknown} e
 * @returns {string}
 */
function bodyText(e) {
  if (!(e instanceof SerenityTransportError)) {
    return '';
  }
  const { body } = e;
  if (typeof body === 'string') {
    return body.toLowerCase();
  }
  const msg = body && typeof body === 'object' ? /** @type {{message?: unknown}} */ (body).message : undefined;
  return (typeof msg === 'string' ? msg : `${e.message}`).toLowerCase();
}

/**
 * Terminal parent-pool exhaustion: a `422` whose body says the subscription is out of units. The
 * dynamic allocator maps this to `orgPoolExhausted` (409). MUST match on the message, not the bare
 * status — the same route also emits a transient `422 "workspace not ready"` (see
 * {@link isWorkspaceNotReady}) that is retried, not surfaced.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isPoolExhausted(e) {
  return e instanceof SerenityTransportError
    && e.status === 422
    && bodyText(e).includes('insufficient available units');
}

/**
 * Transient async-lock `422 "workspace not ready"` — fired when a transfer/delete races a still
 * settling workspace, and (Gate 0) can persist even after `getWorkspaceStatus` reports `created`.
 * Retry with backoff; do NOT surface as pool exhaustion.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isWorkspaceNotReady(e) {
  return e instanceof SerenityTransportError
    && e.status === 422
    && bodyText(e).includes('workspace not ready');
}

/**
 * The disguised metered-quota rejection: a `405` from a metered write/publish (the gateway returns
 * a non-JSON/HTML body, or a "quota" message) when `used + need > total`. Under dynamic allocation
 * a 405 right after a top-up signals stale-read / racing consumption (see the 405-recovery loop).
 * @param {unknown} e
 * @returns {boolean}
 */
export function isMeteredQuota(e) {
  return e instanceof SerenityTransportError
    && e.status === 405
    && (bodyText(e).includes('quota') || typeof e.body === 'string' || e.body == null);
}

/**
 * Upstream rate limiting (`429`) — retryable with backoff rather than the generic 502.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isRateLimited(e) {
  return e instanceof SerenityTransportError && e.status === 429;
}

/**
 * Frozen catalog of error-token strings handlers attach to
 * `ErrorWithStatusCode.code` so the controller's `mapError` emits them
 * verbatim in the response envelope (instead of the generic
 * `errorTokenForStatus` default).
 *
 * Why a frozen map and not just a string literal at the throw site: API
 * error tokens are part of the public contract that clients pattern-match
 * on. The single existing token (`marketNotFound`) was chosen as
 * lowerCamel; without a central catalog, the second author at a different
 * throw site picks `'market_not_found'` or `'MarketNotFound'` and the
 * vocabulary diverges silently. Catalog this here so adding a token is a
 * three-character edit at one place and `grep ERROR_CODES src/` enumerates
 * every code currently emitted by the serenity surface.
 */
export const ERROR_CODES = Object.freeze({
  MARKET_NOT_FOUND: 'marketNotFound',
  // Subworkspace provisioning (serenity dual-mode, subworkspace path).
  AMBIGUOUS_WORKSPACE: 'ambiguousWorkspace',
  LINKED_SUBWORKSPACES: 'linkedSubworkspaces',
  // Dynamic AI resource allocation (JIT top-up path).
  ORG_POOL_EXHAUSTED: 'orgPoolExhausted',
  BRAND_AI_LIMIT: 'brandAiLimit',
});
