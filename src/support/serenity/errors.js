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

import { ProjectEngineApiError } from '@adobe/spacecat-shared-project-engine-client';
import { ErrorWithStatusCode } from '../utils.js';
import { SerenityTransportError } from './rest-transport.js';
import { recordMeteredQuotaClassifier, recordRejection } from './allocation-metrics.js';

/**
 * The single type guard every Semrush error classifier gates on. A failing Semrush call now
 * surfaces as ONE of two typed errors, and both carry the same classification-relevant fields
 * (`.status` — number|undefined — and `.body`):
 *   - Project Engine calls (the ~28 project/prompt/benchmark ops routed through the shared facade)
 *     throw `ProjectEngineApiError` directly (LLMO-6386, retiring the old adaptPE boundary);
 *   - the User Manager (`users.*`) sub-workspace lifecycle calls and the raw `brand-topics`
 *     (`projectsRaw`) call still throw the transport's own `SerenityTransportError` (via `unwrap`).
 * Every classifier below keys ONLY on `.status`/`.body`, never on the concrete type, so widening
 * the guard here recognises both without changing a single classification outcome.
 * @param {unknown} e
 * @returns {e is (SerenityTransportError | ProjectEngineApiError)}
 */
export function isSemrushTransportError(e) {
  return e instanceof SerenityTransportError || e instanceof ProjectEngineApiError;
}

/**
 * Unwraps a network/timeout/auth Project Engine failure to the original error it wraps, for the
 * error→HTTP mapping layer ONLY (the controllers' `mapError` / `createErrorResponse`).
 *
 * A Project Engine call with no HTTP response (per-attempt timeout, exhausted network, or the
 * shared `authToken` getter refusing a missing IMS token) surfaces as a `ProjectEngineApiError`
 * whose `status` is `undefined` and whose `.cause` is the original throw — `createTimeoutFetch`'s
 * 504 `SerenityTransportError`, `authToken`'s 401 `SerenityTransportError`, or a raw network Error.
 * The retired `adaptPE` boundary used to rethrow that `.cause` directly, so the controller mapped
 * it by the cause's status (auth → 401, timeout → 502, raw network → 500). This helper reproduces
 * that unwrap so those HTTP codes are preserved EXACTLY — without it, a bare `undefined` status
 * flattens every one of them to 502 and an auth failure would silently regress from 401 to 502.
 *
 * Only applied at the HTTP-mapping seam: the status-driven classifiers never fire on these causes
 * (their statuses are 504/401/network, none of the 404/422/405/429 triggers), so widening the
 * classifiers alone leaves their outcomes unchanged and does not need this. A
 * `ProjectEngineApiError` that DID carry an HTTP status, a `SerenityTransportError`, and every
 * other error pass through unchanged.
 * @param {unknown} e
 * @returns {unknown}
 */
export function unwrapTransportCause(e) {
  return e instanceof ProjectEngineApiError && e.status === undefined && e.cause != null
    ? e.cause
    : e;
}

/**
 * Recognises an upstream "already gone" response — the signal that an
 * idempotent DELETE-style operation can treat as success without falling
 * through to the generic 502 path.
 *
 * Strict shape: must be a Semrush transport error (SerenityTransportError or
 * ProjectEngineApiError) AND status === 404. Refuses to match generic Error
 * subclasses or ad-hoc objects whose `.status` happens to equal 404. This is
 * the safe variant — a future library or test stub decorating an unrelated
 * error with `status: 404` cannot silently turn into
 * "upstream-idempotent-success" and swallow a real failure.
 *
 * Used by every "upstream target gone" site in the serenity surface:
 *   - markets.js handleDeleteMarket  (upstream project gone)
 *   - prompts.js handleUpdatePrompt  (in-place rename of a missing prompt → promptNotFound)
 *   - prompts.js handleBulkDeletePrompts  (per-project bucket delete)
 */
export function isUpstreamGone(e) {
  return isSemrushTransportError(e) && e.status === 404;
}

/**
 * The upstream error body as a lowercased string, for message-based classification. The gateway
 * returns either a JSON `{ message }` object or a bare text/html string (the disguised-405 case);
 * this normalises both so a predicate can match on substrings. Callers guard
 * `isSemrushTransportError` (short-circuit) before calling, so `e` is always a Semrush transport
 * error here.
 * @param {SerenityTransportError | ProjectEngineApiError} e
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
  return isSemrushTransportError(e)
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
  return isSemrushTransportError(e)
    && e.status === 422
    && bodyText(e).includes('workspace not ready');
}

/**
 * The disguised metered-quota rejection: a `405` from a metered write/publish when
 * `used + need > total`. Live-verified (Rainer, LLMO-6190, `LLMO-Dev-2`): the body carries NO
 * "quota"/"allocation exhausted" text at all — it is a bare nginx `text/html` page
 * (`<html>...405 Not Allowed...nginx...</html>`), while every genuine app-level Method-Not-Allowed
 * this gateway returns comes back as JSON (`{ message: 'Method Not Allowed' }`). Body content
 * cannot distinguish the two cases — only SHAPE can: a string body is the disguised gateway-level
 * quota rejection, an object body is a real app-level error. Widen this only from a newly pinned
 * live fixture, never from a guessed substring.
 *
 * Emits the `MeteredQuotaClassifier` observability metric (LLMO-6191 item 2) ONLY when `e` is an
 * actual `405` (the metric's denominator is "how many 405s", not "how many errors of any kind" —
 * see the non-405 early return), dimensioned by match/no-match, so the "405-classifier match
 * ratio" the rollout-hardening ticket asks for reflects the real shape-based signal now that
 * `retryOnQuota` (dynamic-allocation-active.js) is a live production caller.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isMeteredQuota(e) {
  if (!isSemrushTransportError(e) || e.status !== 405) {
    // Not a 405 at all — outside the classifier's domain (the metric's denominator is "how many
    // 405s", not "how many errors of any kind"), so no metric here (MysticatBot review, LLMO-6191):
    // emitting `Matched=false` for every unrelated error (a TypeError, a timeout, a 409, ...) would
    // drown the actual 405-classifier signal once a real caller is wired up.
    return false;
  }
  const matched = typeof e.body === 'string' && e.body.length > 0;
  recordMeteredQuotaClassifier(matched);
  return matched;
}

/**
 * Upstream rate limiting (`429`) — retryable with backoff rather than the generic 502.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isRateLimited(e) {
  return isSemrushTransportError(e) && e.status === 429;
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
  // Tag delete (DELETE /serenity/tags/:tagId, tag-dimension only for now).
  TAG_HAS_CHILDREN: 'tagHasChildren',
  CATEGORY_DELETE_NOT_YET_SUPPORTED: 'categoryDeleteNotYetSupported',
  TAG_NOT_RESOLVED: 'tagNotResolved',
  // Dynamic AI resource allocation (JIT top-up path).
  ORG_POOL_EXHAUSTED: 'orgPoolExhausted',
  BRAND_AI_LIMIT: 'brandAiLimit',
  // Transient: a transfer never cleared the async `workspace not ready` lock — retryable, NOT
  // pool exhaustion (distinct from ORG_POOL_EXHAUSTED so the operator/client isn't misled).
  WORKSPACE_BUSY: 'workspaceBusy',
  // Case-1 quota rejection (serenity-docs#72 §2): the disguised-405 signal classified by
  // isMeteredQuota, surfaced via toQuotaExceededError. Distinct from ORG_POOL_EXHAUSTED /
  // BRAND_AI_LIMIT (the allocator-ON tokens) so a client need not tell them apart, but a caller
  // debugging a specific rejection still can from the log line at the throw site.
  QUOTA_EXCEEDED: 'quotaExceeded',
});

/**
 * Case-1 quota rejection (serenity-docs#72 §2): the brand's flat pre-carved sub-workspace
 * allocation is exhausted — the allocator-OFF path production runs today, or the allocator-ON
 * path's per-child ceiling isn't the cause but the disguised 405 still surfaced. Maps the
 * classified {@link isMeteredQuota} signal to the same customer-facing contract as
 * `orgPoolExhausted` / `brandAiLimit` (409, stable token), so a caller never needs to
 * distinguish them — see `ERROR_CODES.QUOTA_EXCEEDED`.
 *
 * Client-facing message is deliberately generic — no internal ids, no upstream body — matching
 * the `orgPoolExhausted`/`brandAiLimit` factories in resource-manager.js. Callers should log the
 * upstream detail themselves before throwing this (see the markets-subworkspace.js call sites).
 * @returns {ErrorWithStatusCode}
 */
export function toQuotaExceededError() {
  recordRejection('quotaExceeded'); // dashboard-only — expected under normal pool load
  const e = new ErrorWithStatusCode('AI resource allocation quota exceeded', 409);
  e.code = ERROR_CODES.QUOTA_EXCEEDED;
  return e;
}
