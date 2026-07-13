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

import { hasText } from '@adobe/spacecat-shared-utils';

import { ensureAiHeadroom } from './resource-manager.js';
import { withResourceLock } from './resource-lock.js';

/**
 * The GLOBAL kill-switch for dynamic (just-in-time) Semrush AI resource allocation
 * (serenity-docs#22, Rainer's item 3 — supersedes the per-org DB flag of the abandoned #2750).
 *
 * A single env/Vault boolean, DEFAULT OFF, read once per request off `context.env` on the hot path
 * — the same shape this codebase already uses for its other global serenity toggles
 * (`SERENITY_ALLOW_WORKSPACE_DELETE`, `SERENITY_ENFORCE_LINKED_SUBWORKSPACE_GUARD`,
 * `SERENITY_ALLOW_NON_IMS_AUTH` in rest-transport.js / serenity.js). No PostgREST read, no per-org
 * cache: a rollback is one env flip, and when OFF `ensureAiHeadroom` never runs, so the metered
 * handlers behave byte-for-byte as they did before this PR. Wired to Vault at
 * `dx_mysticat/<env>/api-service`.
 */
export const DYNAMIC_ALLOCATION_ENV_FLAG = 'SERENITY_DYNAMIC_ALLOCATION';

/**
 * Reads the global dynamic-allocation kill-switch. `true` ONLY for the exact string `'true'`
 * (env values are strings); anything else — unset, `'false'`, a typo — is OFF. Fail-safe by design.
 * @param {object} [env] - the request env (`context.env`).
 * @returns {boolean}
 */
export function isDynamicAllocationEnabled(env) {
  return env?.[DYNAMIC_ALLOCATION_ENV_FLAG] === 'true';
}

/**
 * @typedef {object} HeadroomGuard
 * @property {boolean} enabled whether JIT top-up is active for this request.
 * @property {(need?: import('./resource-manager.js').Dims,
 *   opts?: { includeDrafted?: boolean }) => Promise<{ toppedUp: boolean }>} ensure
 *   the choke point every subworkspace metered-write path calls before its metered op.
 */

/**
 * Builds the per-request AI-headroom guard the metered-write handlers front their ops through — the
 * single enforcement choke point for JIT top-up. Handlers ALWAYS call `guard.ensure(need, opts)`
 * before a metered `createProject` / `publishProject` / model-add publish, regardless of the flag.
 *
 * - Flag OFF (or the child/master ids are missing): `ensure` is a genuine no-op — it issues ZERO
 *   transport calls and returns immediately — so the OFF path is byte-for-byte the pre-PR behavior.
 * - Flag ON: `ensure` serializes per child (see {@link withResourceLock}) and tops up just-in-time
 *   via the FAIL-FAST {@link ensureAiHeadroom} (one transfer, no poll; 503 if still settling).
 *
 * @param {any} transport - Serenity transport.
 * @param {object} opts
 * @param {boolean} opts.enabled - the global kill-switch value for this request.
 * @param {string} [opts.subWorkspaceId] - the sub-workspace being written to (`auth.workspaceId`).
 * @param {string} [opts.parentWorkspaceId] - the org parent workspace (`auth.parentWorkspaceId`).
 * @param {import('./resource-manager.js').Blocks} [opts.ceiling] - per-brand ceiling (optional).
 * @param {import('./resource-manager.js').Blocks} [opts.blocks] - grace blocks (optional).
 * @param {any} [log]
 * @returns {HeadroomGuard}
 */
export function createHeadroomGuard(transport, {
  enabled, subWorkspaceId, parentWorkspaceId, ceiling, blocks,
}, log) {
  // Disabled path: a no-op guard. Also taken when ON but the ids needed to top up are missing — a
  // wiring/misconfiguration we must NOT let block a customer write; log it (a PR-4 pre-flip guard
  // will assert the ids are present before the flag can be flipped on for real).
  // The `!id` checks first narrow away undefined/'' (hasText is not a TS type guard — see this
  // dir's CLAUDE.md), so hasText only guards whitespace-only and both are `string` below.
  const idsMissing = !subWorkspaceId || !parentWorkspaceId
    || !hasText(subWorkspaceId) || !hasText(parentWorkspaceId);
  if (!enabled || idsMissing) {
    if (enabled) {
      log?.warn?.(
        '[serenity] dynamic allocation ON but subWorkspaceId/parentWorkspaceId missing '
        + '— skipping JIT top-up for this request',
        { subWorkspaceId, parentWorkspaceId },
      );
    }
    return {
      enabled: false,
      ensure: async () => ({ toppedUp: false }),
    };
  }
  return {
    enabled: true,
    ensure: (need = {}, { includeDrafted = false } = {}) => withResourceLock(
      subWorkspaceId,
      () => ensureAiHeadroom(transport, {
        subWorkspaceId, parentWorkspaceId, need, ceiling, blocks, includeDrafted,
      }, log),
    ),
  };
}
