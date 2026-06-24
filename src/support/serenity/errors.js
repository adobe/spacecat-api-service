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
});
