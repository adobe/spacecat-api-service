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
import { SerenityTransportError } from './serenity-transport-error.js';
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
 * ratio" the rollout-hardening ticket asks for reflects the real shape-based signal at the
 * metered-write/publish call sites (markets-subworkspace.js, prompts-subworkspace.js).
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
  INVALID_REQUEST: 'invalidRequest',
  PROMPT_NOT_FOUND: 'promptNotFound',
  SERENITY_UPSTREAM_ERROR: 'serenityUpstreamError',
  JOB_FAILED: 'jobFailed',
  MARKET_NOT_FOUND: 'marketNotFound',
  INVALID_TAG_FILTER: 'invalidTagFilter',
  TAG_FILTER_TOO_LARGE: 'tagFilterTooLarge',
  TAG_LIMIT_EXCEEDED: 'tagLimitExceeded',
  IMPACT_UNAVAILABLE: 'impactUnavailable',
  IMPACT_STALE: 'impactStale',
  TAG_TREE_READ_INCOMPLETE: 'tagTreeReadIncomplete',
  PROMPT_CORPUS_INCOMPLETE: 'promptCorpusIncomplete',
  UNSUPPORTED_TAG_FILTER: 'unsupportedTagFilter',
  IDEMPOTENCY_CONFLICT: 'idempotencyConflict',
  INCOMPATIBLE_TAG_TAXONOMY: 'incompatibleTagTaxonomy',
  // A PATCH target that is not present anywhere in the project's tag tree. The
  // upstream has no "get tag by id" read, and a PATCH cannot omit `parent_id`
  // without promoting the tag to a root, so an unresolvable id is refused here
  // rather than forwarded.
  TAG_NOT_FOUND: 'tagNotFound',
  // Subworkspace provisioning (serenity dual-mode, subworkspace path).
  AMBIGUOUS_WORKSPACE: 'ambiguousWorkspace',
  LINKED_SUBWORKSPACES: 'linkedSubworkspaces',
  // A sub-workspace settled to a terminal Semrush failure status (#3241/LLMO-7352) — the
  // workspace will never become usable and must not be adopted or reused; the caller needs a
  // fresh create/retry, not a wait. Distinct from the timeout token (a `not ready` workspace MAY
  // still settle) so a client can tell "give it more time" apart from "this one is dead".
  SUBWORKSPACE_CREATION_FAILED: 'subworkspaceCreationFailed',
  SUBWORKSPACE_CREATION_TIMEOUT: 'subworkspaceCreationTimeout',
  // Publish-after-populate (LLMO-5492): a publish rejected because the workspace
  // has no `ai.projects` quota (Semrush's disguised metered 405). PERMANENT —
  // alert, do not retry — distinct from the transient publish failures.
  PUBLISH_QUOTA_EXHAUSTED: 'publishQuotaExhausted',
  // Case-1 quota rejection (serenity-docs#72 §2): the disguised-405 signal classified by
  // isMeteredQuota, surfaced via toQuotaExceededError.
  QUOTA_EXCEEDED: 'quotaExceeded',
  // LLMO-7421: the blocking main-brand benchmark provisioning invariant (exactly one
  // main_brand:true) could not be established. Surfaced via
  // MainBrandBenchmarkInvariantError, below.
  MAIN_BRAND_BENCHMARK_INVARIANT: 'mainBrandBenchmarkInvariant',
  // Async sub-workspace provisioning (LLMO-7352/LLMO-7418). Both are 409s, and both are raised
  // from BOTH serenity.js and brands.js, so they live here rather than as string literals at each
  // throw site -- the two controllers previously spelled the in-progress one two different ways
  // (`semrush_provisioning_in_progress` vs `semrushProvisioningInProgress`) and published both
  // spellings in their respective OpenAPI documents, which no client could branch on reliably.
  //
  // They are NOT interchangeable, which is why there are two:
  //   IN_PROGRESS  -- an attempt is live right now. RETRYABLE: wait and retry, it will converge.
  //   INCOMPLETE   -- provisioning is pending or has FAILED, so the brand has no sub-workspace of
  //                   its own to write into. NOT retryable on its own; the brand's provisioning
  //                   has to complete (or be retried) first.
  // A client that collapses them shows "please retry shortly" on a brand that will never converge.
  SEMRUSH_PROVISIONING_IN_PROGRESS: 'semrushProvisioningInProgress',
  SEMRUSH_PROVISIONING_INCOMPLETE: 'semrushProvisioningIncomplete',
});

/**
 * Thrown by `brand-urls.js` `assertMainBrandBenchmark` when a project's DRAFT
 * benchmark state does not carry exactly one `main_brand: true` benchmark. A
 * blocking pre-publish provisioning invariant (LLMO-7421): without exactly
 * one, Brand Presence has no customer baseline, so the caller must not
 * publish.
 *
 * Deliberately scoped to the DRAFT view only — publish is asynchronous
 * (`publish-status.js`: a 202 with the project transitioning to `live` in the
 * background, no completion webhook), so a published-view read taken
 * immediately after `publishProject` resolves races that transition and would
 * spuriously fail even when provisioning succeeded. Confirming the invariant
 * on the PUBLISHED view is deferred to the fleet reconciliation this ticket
 * also scopes (out of scope for this change) rather than attempted here
 * unsoundly.
 *
 * Extends `ErrorWithStatusCode` so it maps through the controller's existing
 * `mapError` (`ErrorWithStatusCode` branch) to a stable `mainBrandBenchmarkInvariant`
 * token instead of falling through to a generic, unactionable 500 — see
 * `ERROR_CODES.MAIN_BRAND_BENCHMARK_INVARIANT` above. 502: the failure means
 * the upstream project's benchmark state doesn't (yet) satisfy the invariant
 * we require, which a caller may retry.
 *
 * Co-located here with `ERROR_CODES` rather than in `brand-urls.js` (its only
 * throw site) for discoverability — this is the error-catalog module, and a
 * reader grepping for `mainBrandBenchmarkInvariant` should find both the code
 * and the error class that carries it in one place (MysticatBot review).
 */
export class MainBrandBenchmarkInvariantError extends ErrorWithStatusCode {
  /**
   * @param {string} workspaceId
   * @param {string} projectId
   * @param {object} [opts]
   * @param {number} [opts.count=0] - the number of `main_brand: true`
   *   benchmarks actually found (0 = none, 2+ = duplicates).
   */
  constructor(workspaceId, projectId, { count = 0 } = {}) {
    // Client-facing message deliberately generic (LLMO-7421 review): the
    // stable `mainBrandBenchmarkInvariant` code is all a client needs to
    // decide retry. workspaceId/projectId/count stay on the error instance
    // for the controller to log server-side — see `mapError`.
    super('Main-brand benchmark invariant not satisfied; retry the request', 502);
    this.name = 'MainBrandBenchmarkInvariantError';
    this.code = ERROR_CODES.MAIN_BRAND_BENCHMARK_INVARIANT;
    this.workspaceId = workspaceId;
    this.projectId = projectId;
    this.count = count;
  }
}

/**
 * Case-1 quota rejection (serenity-docs#72 §2): the disguised 405 surfaced on a metered write.
 * A sub-workspace carries no allocation of its own to exhaust (see `workspace-lifecycle.js`), so
 * our own sizing is never the cause — this means the upstream refused the write on its own terms.
 * Maps the classified {@link isMeteredQuota} signal to a stable customer-facing contract (409,
 * `quotaExceeded` token) so a caller never needs to distinguish rejection sub-types — see
 * `ERROR_CODES.QUOTA_EXCEEDED`.
 *
 * Client-facing message is deliberately generic — no internal ids, no upstream body. Callers should
 * log the upstream detail themselves before throwing this (see the markets-subworkspace.js call
 * sites).
 * @returns {ErrorWithStatusCode}
 */
export function toQuotaExceededError() {
  recordRejection('quotaExceeded'); // dashboard-only — expected under normal pool load
  const e = new ErrorWithStatusCode('AI resource allocation quota exceeded', 409);
  e.code = ERROR_CODES.QUOTA_EXCEEDED;
  return e;
}
