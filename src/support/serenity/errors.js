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
 * Permanent allocation failure on publish. Live-verified (workspace doc §5):
 * publishing a project in a subworkspace whose `ai.projects` quota is zero
 * fails as a **bare nginx 405 with an HTML body** — a quota rejection in
 * disguise, NOT a normal "method not allowed". The fix is to grant the
 * workspace a non-zero ai allocation; never retry this as a transient.
 *
 * Signal: status 405 with a non-JSON (string) body. `parseBody` in
 * rest-transport returns the raw text when the body is not valid JSON, so an
 * HTML error page surfaces as `e.body` being a string. A genuine JSON 405
 * (object body) is deliberately NOT matched.
 */
export function isAllocationFailure(e) {
  return e instanceof SerenityTransportError
    && e.status === 405
    && typeof e.body === 'string';
}

/**
 * Transient "workspace still settling" signal. Live-verified (workspace doc
 * §4/§5): creating a project (or publishing) against a freshly created subworkspace
 * workspace that is still `status: "not ready"` can 500; the workspace settles
 * to `created` within seconds. Callers apply this ONLY in the
 * create-then-poll context (ensureSubworkspace) — a 500 elsewhere is a real
 * server error and must propagate.
 */
export function isWorkspaceNotReady(e) {
  return e instanceof SerenityTransportError && e.status === 500;
}

/**
 * Out-of-band workspace deletion drift. Live-verified (workspace doc §4):
 * reads against a deleted workspace (or its former projects) return 403
 * "invalid access attempt", not 404. Our flows never delete subworkspaces
 * (decommission keeps them — design §6), so a 403 on a brand's own workspace
 * means it was removed out-of-band: alert and repair the `semrush_workspace_id`
 * pointer rather than treating it as an expected state.
 */
export function isWorkspaceDrift(e) {
  return e instanceof SerenityTransportError && e.status === 403;
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
  ALLOCATION_FAILURE: 'allocationFailure',
  WORKSPACE_NOT_READY: 'workspaceNotReady',
  WORKSPACE_DRIFT: 'workspaceDrift',
  AMBIGUOUS_WORKSPACE: 'ambiguousWorkspace',
});
