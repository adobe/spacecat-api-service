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

import {
  ensureAiHeadroom, requireWorkspaceId, DEFAULT_BRAND_AI_CEILING,
} from './resource-manager.js';
import { withResourceLock } from './resource-lock.js';
import { isMeteredQuota } from './errors.js';
import { recordQuotaRetryOutcome } from './allocation-metrics.js';

/** Default poll-retry shape for {@link createHeadroomGuard}'s `retryOnQuota` (LLMO-6190 follow-up:
 * live-verified ~9s Semrush gateway write-enforcement lag after a JIT top-up — see the doc comment
 * on `retryOnQuota` below). Sized with margin over the observed lag; a caller may override via
 * `opts.retryOnQuota` (tests inject a fake `sleep` + a tiny `backoffMs`/`totalBudgetMs`). */
const DEFAULT_RETRY_ON_QUOTA = {
  maxAttempts: 3,
  backoffMs: 3000,
  totalBudgetMs: 9000,
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now: () => Date.now(),
};

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
 * @property {(fn: () => Promise<any>, opts?: { callSite?: string }) => Promise<any>} retryOnQuota
 *   wraps a metered publish/write call with a bounded poll-retry cycle for the disguised
 *   metered-quota 405 (LLMO-6190 item 4 / follow-up — see
 *   {@link import('./errors.js').isMeteredQuota}). `opts.callSite` is a short, closed-vocabulary
 *   label (e.g. `'publishProject'`, `'createOnePrompt'`) used ONLY for the recovery-outcome metric
 *   dimension — never derived from user input, to keep metric cardinality bounded.
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
 *   still settling). The per-brand `ceiling` defaults to {@link DEFAULT_BRAND_AI_CEILING} (a
 *   PLACEHOLDER, effectively non-enforcing — see its doc) when the caller doesn't pass one, so the
 *   ceiling-enforcement PATH is always in force even though no real product number exists yet.
 *
 * @param {any} transport - Serenity transport.
 * @param {object} opts
 * @param {boolean} opts.enabled - the global kill-switch value for this request.
 * @param {string} [opts.subWorkspaceId] - the sub-workspace being written to (`auth.workspaceId`).
 * @param {string} [opts.parentWorkspaceId] - the org parent workspace (`auth.parentWorkspaceId`).
 * @param {import('./resource-manager.js').Blocks} [opts.ceiling] - per-brand ceiling (default
 *   {@link DEFAULT_BRAND_AI_CEILING} — a placeholder; pass an explicit value to override once a
 *   real per-brand number exists).
 * @param {import('./resource-manager.js').Blocks} [opts.blocks] - grace blocks (optional).
 * @param {Partial<typeof DEFAULT_RETRY_ON_QUOTA>} [opts.retryOnQuota] - poll-retry shape override
 *   for `retryOnQuota` (tests inject a fake `sleep` + tiny `backoffMs`/`totalBudgetMs`; production
 *   uses {@link DEFAULT_RETRY_ON_QUOTA} unmodified).
 * @param {any} [log]
 * @returns {HeadroomGuard}
 */
export function createHeadroomGuard(transport, {
  enabled, subWorkspaceId, parentWorkspaceId, ceiling = DEFAULT_BRAND_AI_CEILING, blocks,
  retryOnQuota: retryOnQuotaOpts = {},
}, log) {
  if (!enabled) {
    // Disabled path: a genuine no-op, byte-for-byte the pre-PR behavior. retryOnQuota is likewise a
    // pure passthrough — zero extra transport calls, since flag OFF has no top-up mechanism to
    // recover with (a retry would just hit the same 405 again).
    return {
      enabled: false,
      ensure: async () => ({ toppedUp: false }),
      retryOnQuota: (fn) => fn(),
    };
  }
  // Flag ON: the ids are required from here on — fail loud (throw) rather than silently no-op.
  requireWorkspaceId('createHeadroomGuard', { subWorkspaceId, parentWorkspaceId });
  // requireWorkspaceId above throws unless both are non-empty strings; narrow the (JSDoc-optional)
  // params for tsc, which cannot narrow a destructured variable through a plain function call.
  const childId = /** @type {string} */ (subWorkspaceId);
  const parentId = /** @type {string} */ (parentWorkspaceId);
  const ensure = (need = {}, { includeDrafted = false } = {}) => withResourceLock(
    childId,
    () => ensureAiHeadroom(transport, {
      subWorkspaceId: childId, parentWorkspaceId: parentId, need, ceiling, blocks, includeDrafted,
    }, log),
  );
  const {
    maxAttempts, backoffMs, totalBudgetMs, sleep, now,
  } = { ...DEFAULT_RETRY_ON_QUOTA, ...retryOnQuotaOpts };
  // The shared per-request deadline: computed ONCE, here, at guard-construction time — NOT per
  // `retryOnQuota` call. One guard is built per inbound request (see the subworkspace handlers),
  // so every call site that shares this guard instance (e.g. createProject → createPromptsByIds →
  // publishProject, all in one `generateTopics` create-market request) shares the SAME budget,
  // instead of each independently re-granting itself a fresh ~9s allowance. Round-2 SRE review: a
  // per-call cap would let 4 sequential wrap sites in one request compound to ~36s, blowing the
  // request's own ~15s hot-path budget.
  const requestDeadline = now() + totalBudgetMs;
  return {
    enabled: true,
    ensure,
    // Bounded poll-retry recovery for the disguised metered-quota 405 (serenity-docs#22 / LLMO-6190
    // follow-up): live-verified, the Semrush gateway's write-enforcement checkpoint can lag a JIT
    // top-up's transfer by ~9s — the transfer succeeds and a resource read already shows the new
    // total, but a write landing inside that window still 405s. Because the total is ALREADY
    // correct by then, re-checking headroom on every attempt would be a no-op read that only adds
    // per-child lock contention (round-2 SRE review) — so `ensure()` is called exactly ONCE, up
    // front, and the actual fix is the WAIT between retries, not a repeated top-up.
    //
    // Bounded by whichever comes first: `maxAttempts`, or the shared `requestDeadline` above — the
    // deadline is checked BEFORE every attempt (including the first poll attempt, not only between
    // retries), so a slow `ensure()` call (e.g. queued behind other same-child recoveries on
    // `withResourceLock`'s own safety valve) can't silently blow past the shared budget before the
    // budget is ever consulted. A non-metered error (or a second/subsequent metered error once
    // bounded) propagates untouched — this never masks a genuinely non-retryable failure, it only
    // spans the known settle lag.
    retryOnQuota: async (fn, { callSite = 'unknown' } = {}) => {
      try {
        return await fn();
      } catch (e) {
        if (!isMeteredQuota(e)) {
          throw e;
        }
        if (callSite === 'unknown') {
          // A caller forgot to pass `{ callSite }` — every wrap site in this codebase does, so this
          // is a code-review miss, not a runtime condition. Surfaced loudly (not just an 'unknown'
          // metric value) so it gets fixed rather than quietly widening QuotaRetryOutcome's
          // CallSite dimension with an open-vocabulary value.
          log?.warn?.('SERENITY_ALLOC retryOnQuota called without a callSite label', {
            subWorkspaceId: childId,
          });
        }
        log?.warn?.('SERENITY_ALLOC metered-405 — bounded top-up + poll-retry', {
          subWorkspaceId: childId, callSite,
        });
        await ensure({}, { includeDrafted: true });
        let attempt = 0;
        let lastError = e;
        for (;;) {
          // Checked BEFORE every attempt, including the first (not just between retries): if
          // `ensure()` itself already consumed the whole shared budget (e.g. it queued behind
          // other same-child recoveries on `withResourceLock`'s own up-to-10s safety valve), don't
          // spend a further `fn()` call on top of an already-blown deadline. This closes a real
          // gap found on self-review: checking the deadline only inside the catch (i.e. only after
          // a poll attempt had already failed) meant the FIRST attempt always ran regardless of
          // how long `ensure()` took, so the shared per-request budget this deadline exists to
          // enforce (see the comment above) wasn't actually a hard cap — exactly the
          // stacked-call-site compounding-latency risk the deadline was built to close.
          if (now() >= requestDeadline) {
            recordQuotaRetryOutcome('exhausted', { attempt, callSite });
            throw lastError;
          }
          attempt += 1;
          try {
            // eslint-disable-next-line no-await-in-loop
            const result = await fn();
            recordQuotaRetryOutcome('recovered', { attempt, callSite });
            return result;
          } catch (e2) {
            if (!isMeteredQuota(e2)) {
              // A non-quota error mid-recovery still ENDS this cycle (Alicia Adriani review):
              // record it as `abandoned` so a dashboard built on `recovered + exhausted +
              // abandoned` as "total recovery cycles" doesn't silently undercount cycles cut
              // short by an unrelated failure — distinct from `exhausted` (which specifically
              // means "still a metered 405 after every attempt").
              recordQuotaRetryOutcome('abandoned', { attempt, callSite });
              throw e2;
            }
            lastError = e2;
            if (attempt >= maxAttempts) {
              recordQuotaRetryOutcome('exhausted', { attempt, callSite });
              throw e2;
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(backoffMs);
          }
        }
      }
    },
  };
}
