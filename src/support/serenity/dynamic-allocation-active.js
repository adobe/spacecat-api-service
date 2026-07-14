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

import { ensureAiHeadroom, requireWorkspaceId } from './resource-manager.js';
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
 * - Flag OFF: `ensure` is a genuine no-op — it issues ZERO transport calls and returns immediately
 *   — so the OFF path is byte-for-byte the pre-PR behavior.
 * - Flag ON with the child/master ids missing: FAILS LOUD (throws) rather than silently degrading
 *   to a no-op. A brand whose org has no parent workspace would otherwise get neither the
 *   (now-skipped) flat carve nor a JIT top-up — its sub-workspace sits at zero AI resources and the
 *   very next metered write fails at the Semrush gateway with an opaque error, instead of a clear
 *   500 at the moment the misconfiguration is knowable. "Flag ON but silently not metering" is
 *   exactly the failure mode a kill-switch rollout must not have.
 * - Flag ON with both ids present: `ensure` serializes per child (see {@link withResourceLock}) and
 *   tops up just-in-time via the FAIL-FAST {@link ensureAiHeadroom} (one transfer, no poll; 503 if
 *   still settling).
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
  if (!enabled) {
    // Disabled path: a genuine no-op, byte-for-byte the pre-PR behavior.
    return {
      enabled: false,
      ensure: async () => ({ toppedUp: false }),
    };
  }
  // Flag ON: the ids are required from here on — fail loud (throw) rather than silently no-op.
  requireWorkspaceId('createHeadroomGuard', { subWorkspaceId, parentWorkspaceId });
  // requireWorkspaceId above throws unless both are non-empty strings; narrow the (JSDoc-optional)
  // params for tsc, which cannot narrow a destructured variable through a plain function call.
  const childId = /** @type {string} */ (subWorkspaceId);
  const parentId = /** @type {string} */ (parentWorkspaceId);
  return {
    enabled: true,
    ensure: (need = {}, { includeDrafted = false } = {}) => withResourceLock(
      childId,
      () => ensureAiHeadroom(transport, {
        subWorkspaceId: childId, parentWorkspaceId: parentId, need, ceiling, blocks, includeDrafted,
      }, log),
    ),
  };
}
