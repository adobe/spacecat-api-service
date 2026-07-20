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
import { recordMeteredQuotaClassifier } from './allocation-metrics.js';

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
 * Used by every "upstream target gone" site in the serenity surface:
 *   - markets.js handleDeleteMarket  (upstream project gone)
 *   - prompts.js handleUpdatePrompt  (in-place rename of a missing prompt → promptNotFound)
 *   - prompts.js handleBulkDeletePrompts  (per-project bucket delete)
 */
export function isUpstreamGone(e) {
  return e instanceof SerenityTransportError && e.status === 404;
}

/**
 * The upstream error body as a lowercased string, for message-based classification. The gateway
 * returns either a JSON `{ message }` object or a bare text/html string (the disguised-405 case);
 * this normalises both so a predicate can match on substrings. Callers guard `instanceof
 * SerenityTransportError` (short-circuit) before calling, so `e` is always a transport error here.
 * @param {SerenityTransportError} e
 * @returns {string}
 */
function bodyText(e) {
  const { body } = e;
  if (typeof body === 'string') {
    return body.toLowerCase();
  }
  // Only trust the upstream body's `message`; never fall back to `e.message` (the transport URL),
  // which would let a classifier match on the request URL rather than the upstream content.
  const msg = body && typeof body === 'object' ? /** @type {{message?: unknown}} */ (body).message : undefined;
  return typeof msg === 'string' ? msg.toLowerCase() : '';
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
 * The disguised metered-quota rejection: a `405` from a metered write/publish whose body signals a
 * quota (`used + need > total`). Matches ONLY on an explicit quota signal in the body — NOT any
 * `405`, so a legitimate Method-Not-Allowed is not absorbed. The exact disguised-405 body is pinned
 * by the PR-4 live-gateway canary; widen the signal here only from that pinned shape.
 *
 * Emits the `MeteredQuotaClassifier` observability metric (LLMO-6191 item 2) ONLY when `e` is an
 * actual `405` (the metric's denominator is "how many 405s", not "how many errors of any kind" —
 * see the non-405 early return), dimensioned by match/no-match, so the "405-classifier match
 * ratio" the rollout-hardening ticket asks for is available the moment a caller wires this
 * predicate into a metered handler's catch path. NOTE: as of this PR no production call site
 * invokes `isMeteredQuota` yet — see the module doc above — so this metric will read zero in
 * every environment until one is added.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isMeteredQuota(e) {
  if (!(e instanceof SerenityTransportError) || e.status !== 405) {
    // Not a 405 at all — outside the classifier's domain (the metric's denominator is "how many
    // 405s", not "how many errors of any kind"), so no metric here (MysticatBot review, LLMO-6191):
    // emitting `Matched=false` for every unrelated error (a TypeError, a timeout, a 409, ...) would
    // drown the actual 405-classifier signal once a real caller is wired up.
    return false;
  }
  const text = bodyText(e);
  const matched = text.includes('quota') || text.includes('allocation exhausted');
  recordMeteredQuotaClassifier(matched);
  return matched;
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
  // A PATCH target that is not present anywhere in the project's tag tree. The
  // upstream has no "get tag by id" read, and a PATCH cannot omit `parent_id`
  // without promoting the tag to a root, so an unresolvable id is refused here
  // rather than forwarded.
  TAG_NOT_FOUND: 'tagNotFound',
  // Subworkspace provisioning (serenity dual-mode, subworkspace path).
  AMBIGUOUS_WORKSPACE: 'ambiguousWorkspace',
  LINKED_SUBWORKSPACES: 'linkedSubworkspaces',
  // Dynamic AI resource allocation (JIT top-up path).
  ORG_POOL_EXHAUSTED: 'orgPoolExhausted',
  BRAND_AI_LIMIT: 'brandAiLimit',
  // Transient: a transfer never cleared the async `workspace not ready` lock — retryable, NOT
  // pool exhaustion (distinct from ORG_POOL_EXHAUSTED so the operator/client isn't misled).
  WORKSPACE_BUSY: 'workspaceBusy',
});
