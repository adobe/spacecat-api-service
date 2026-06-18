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
 * Recognises the zero-quota publish rejection — a `POST .../publish` against a
 * workspace with no `ai.projects` allocation. Semrush surfaces this as a bare
 * nginx **`405` with `text/html`** (no JSON envelope): a quota rejection wearing
 * the wrong status code (verified live 2026-06-11, serenity-docs §10).
 *
 * This is a PERMANENT resource-allocation failure, NOT a transient upstream
 * outage: the workspace must be re-provisioned with quota before publish can
 * ever succeed. Callers must therefore alert-and-stop rather than retry —
 * retrying loops create→405→delete forever. The `405 text/html` signature is
 * the discriminator: a genuine 405 from the app layer (e.g. wrong method on a
 * real route) carries a JSON body, so the `text/html` check keeps this narrow.
 */
export function isPublishQuotaExhausted(e) {
  return e instanceof SerenityTransportError
    && e.status === 405
    && /text\/html/i.test(e.contentType || '');
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
  // Attached to a publishFailed entry (finalize) / logged by handleCreateMarket
  // when publish is rejected for a zero `ai.projects` allocation. Marks the
  // failure as permanent so the trigger/worker alerts instead of retrying.
  PUBLISH_QUOTA_EXHAUSTED: 'publishQuotaExhausted',
});
