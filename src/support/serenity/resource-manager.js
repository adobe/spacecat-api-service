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

/**
 * Dynamic (just-in-time) Semrush AI resource allocation — the pure allocator.
 *
 * Replaces the up-front flat carve: before a metered op, read the sub-workspace's real headroom and
 * transfer only the delta from the parent; hand surplus back on delete. Semrush model,
 * live-verified 2026-07-02 ("Gate 0"): a transfer is ABSOLUTE (sets `total`) + idempotent; a carve
 * decrements the MASTER's `total`; `free = total − used`; over-carving the master → terminal
 * `422 "insufficient available units in subscription"`; a transfer briefly flips the child off
 * `created` and may `422 "workspace not ready"` transiently even past `status:created`.
 *
 * Two pure, transport-injected entry points sit between the handlers and the transport:
 * - {@link ensureAiHeadroom} BEFORE a metered op — reads child headroom, tops up in grace-sized
 *   blocks only when needed (hot path = read + compare, no transfer).
 * - {@link releaseAiSurplus} AFTER a delete/removal (async/reconciler) — hands whole freed blocks
 *   back, never below the child's floor; best-effort (never throws).
 *
 * `used` reconciles asynchronously after publish (post-publish reads are stale-low), so the caller
 * fronting the PROMPT dimension should size `need` at the publish seam from `used + drafted`
 * (drafted is set synchronously at draft time) — see the handler-fronting plan; this module exposes
 * both figures via {@link readAiTotals}.
 */

import { ErrorWithStatusCode } from '../utils.js';
import { SerenityTransportError } from './rest-transport.js';
import { pollUntilCreated } from './workspace-lifecycle.js';
import {
  ERROR_CODES, isPoolExhausted, isWorkspaceNotReady,
} from './errors.js';

/** @typedef {{ used: number, drafted: number, total: number }} AiDim */
/** @typedef {{ projects: AiDim, prompts: AiDim }} AiTotals */
/** @typedef {{ projects?: number, prompts?: number }} Dims a per-dimension unit count */
/** @typedef {{ projects: number, prompts: number }} Blocks */
/**
 * @typedef {object} PollOpts
 * @property {number} attempts
 * @property {number} intervalMs
 * @property {(ms: number) => Promise<void>} sleep
 */

/** Grace-sized top-up blocks: projects one-at-a-time (checked at publish), prompts in bulk. */
export const PROJECT_BLOCK = 1;
export const PROMPT_BLOCK = 100;
/** @type {Blocks} */
export const DEFAULT_BLOCKS = Object.freeze({ projects: PROJECT_BLOCK, prompts: PROMPT_BLOCK });

/** The AI dimensions this allocator moves. */
const DIMS = Object.freeze(/** @type {const} */ (['projects', 'prompts']));

/** Real-clock sleep; overridable via the injected `poll.sleep` in tests. */
const realSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Budget-sized settle poll — deliberately tighter than the 30-attempt provisioning poll
 * (`workspace-lifecycle.js`) so a transfer-settle wait cannot alone exceed the request budget.
 * @type {PollOpts}
 */
export const DEFAULT_POLL = Object.freeze({ attempts: 12, intervalMs: 1000, sleep: realSleep });

/** Bounded RETRIES for the transient `422 "workspace not ready"` — 3 retries after the initial
 * attempt (4 transfer attempts total). */
export const NOT_READY_RETRIES = 3;

/**
 * Rounds a unit count up to the next whole block (never below the count; 0 → 0).
 * @param {number} n
 * @param {number} block
 * @returns {number}
 */
export function roundUpToBlock(n, block) {
  if (n <= 0) {
    return 0;
  }
  return Math.ceil(n / block) * block;
}

// ---- need calculators (domain intent — a transport decorator can't compute these) --------------

/**
 * Prompt units re-metered when a project's model set changes by `deltaModels` — every one of its
 * `publishedTexts` published texts re-meters by the model delta (`texts × Δmodels`, live-verified).
 * The model-update seam sizes on the SIGNED net delta (`finalModelCount − currentModelCount`): a
 * positive value is a top-up need, and this clamps a swap (net 0) or a net removal (net < 0) to 0
 * so no top-up fires — the freed units are handed back by `releaseAiSurplus` after the publish
 * instead. (The create/bulk-prompt seams size at their PUBLISH seam from `used + drafted` via
 * `ensureAiHeadroom({ includeDrafted })`, which is staleness-immune, so they need no calculator.)
 * @param {number} publishedTexts @param {number} deltaModels @returns {number}
 */
export const modelChangeUnits = (publishedTexts, deltaModels) => Math.max(0, publishedTexts)
  * Math.max(0, deltaModels);

/**
 * Fail-loud guard for the workspace ids the allocator needs. A missing/blank id means a caller
 * didn't thread the resolved auth ids into the fronting seam — a wiring bug, not a client error, so
 * this throws a plain Error (→ 500, surfaced in monitoring) rather than a mapped 4xx. Exported so
 * {@link createHeadroomGuard} (dynamic-allocation-active.js) can enforce it at the guard's own
 * construction point — the only place the flag-ON, ids-missing case is actually reachable from the
 * request path (this module's own `ensureAiHeadroom`/`releaseAiSurplus` callers are only ever
 * invoked once the guard has already decided to proceed).
 * @param {string} fn calling function name (for the message)
 * @param {Record<string, unknown>} ids id name → value
 * @returns {void}
 */
export function requireWorkspaceId(fn, ids) {
  for (const [name, value] of Object.entries(ids)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`resource-manager: ${fn} requires a non-empty ${name}`);
    }
  }
}

// ---- reads --------------------------------------------------------------------------------------

/**
 * STRICT accessor over a `NewWorkspaceResources` body — pulls the nested
 * `product_resources.ai.resources.{projects,prompts}` triples. Fails LOUD on a missing/renamed key
 * rather than defaulting to 0 (a silent `undefined→0` would cause pool drain or spurious 405s).
 * @param {any} resources the `getWorkspaceResources` response
 * @returns {AiTotals}
 */
export function readAiTotals(resources) {
  const ai = resources?.product_resources?.ai?.resources;
  if (!ai || typeof ai !== 'object') {
    throw new Error('resource-manager: product_resources.ai.resources missing from workspace resources');
  }
  /** @param {'projects'|'prompts'} name @returns {AiDim} */
  const dim = (name) => {
    const d = ai[name];
    if (!d || typeof d.used !== 'number' || typeof d.total !== 'number') {
      throw new Error(`resource-manager: ai.resources.${name}.{used,total} missing/non-numeric`);
    }
    return { used: d.used, drafted: typeof d.drafted === 'number' ? d.drafted : 0, total: d.total };
  };
  return { projects: dim('projects'), prompts: dim('prompts') };
}

// ---- typed errors -------------------------------------------------------------------------------
//
// Client-facing messages are GENERIC and carry NO internal ids or pool numbers — the controller's
// mapError echoes `.message` to the client, so anything embedded here (child/master workspace ids,
// free/needed counts) would leak internal Semrush topology + capacity. The distinguishing signal is
// `.code` (part of the public contract); the detailed context (ids, numbers) is logged at the throw
// site instead.

/** @returns {ErrorWithStatusCode} */
function orgPoolExhausted() {
  const e = new ErrorWithStatusCode('Organization AI resource pool is exhausted', 409);
  e.code = ERROR_CODES.ORG_POOL_EXHAUSTED;
  return e;
}

/** @returns {ErrorWithStatusCode} */
function brandAiLimit() {
  const e = new ErrorWithStatusCode('Brand AI resource allocation limit reached', 409);
  e.code = ERROR_CODES.BRAND_AI_LIMIT;
  return e;
}

/**
 * A transient failure — the transfer hit the async `workspace not ready` lock. `503` (retryable),
 * NOT `orgPoolExhausted`: this is lock contention, not a full pool.
 * @returns {ErrorWithStatusCode}
 */
function workspaceBusy() {
  const e = new ErrorWithStatusCode('Sub-workspace is provisioning, retry', 503);
  e.code = ERROR_CODES.WORKSPACE_BUSY;
  return e;
}

// ---- transfer + settle --------------------------------------------------------------------------

/**
 * Absolute transfer of `{ projects, prompts }` totals onto `workspaceId`, then settle-poll. Retries
 * the transient `422 "workspace not ready"` with backoff; maps terminal pool exhaustion to
 * `orgPoolExhausted`. Idempotent, so retry after a poll timeout is safe (the poll's 504 propagates;
 * the controller maps it to a retryable `503`).
 * @param {any} transport
 * @param {string} workspaceId
 * @param {{ projects: number, prompts: number }} totals
 * @param {PollOpts} poll
 * @param {any} [log]
 * @returns {Promise<void>}
 */
async function transferAndSettle(transport, workspaceId, totals, poll, log) {
  for (let attempt = 0; attempt <= NOT_READY_RETRIES; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await transport.transferWorkspaceResources(workspaceId, { ai: totals });
      // eslint-disable-next-line no-await-in-loop
      await pollUntilCreated(transport, workspaceId, poll);
      return;
    } catch (e) {
      if (isPoolExhausted(e)) {
        log?.warn?.('SERENITY_ALLOC org pool exhausted on transfer', { workspaceId });
        throw orgPoolExhausted();
      }
      if (!isWorkspaceNotReady(e)) {
        throw e; // any other error (incl. poll timeout 504) propagates for the caller to map
      }
      if (attempt === NOT_READY_RETRIES) {
        break; // exhausted retries on the transient lock
      }
      log?.info?.(`SERENITY_ALLOC workspace-not-ready, retrying transfer (attempt ${attempt + 1})`, { workspaceId });
      // eslint-disable-next-line no-await-in-loop
      await poll.sleep(poll.intervalMs * (attempt + 1));
    }
  }
  // Lock contention, not a full pool — surface a retryable 503, not orgPoolExhausted.
  log?.warn?.('SERENITY_ALLOC transfer never cleared workspace-not-ready', { workspaceId });
  throw workspaceBusy();
}

/**
 * FAIL-FAST hot-path transfer (serenity-docs#22, Rainer's hard constraint). A synchronous metered
 * write cannot afford the {@link transferAndSettle} settle-poll + not-ready retry loop: a Semrush
 * `/resources` transfer now gates every Adobe write, and stacking a 12s poll + 1+2+3s backoff blows
 * the ~15s Fastly/Lambda edge budget → a 504 with a half-applied absolute transfer stranded. So on
 * the request path we do exactly ONE transfer attempt and NO blocking settle loop: the transfer is
 * absolute + idempotent, so if the child is still settling (`422 "workspace not ready"`) we return
 * a retryable `503` (`workspaceBusy`) IMMEDIATELY and let the client/UI retry — the next attempt
 * finds it settled. Terminal pool exhaustion still maps to `orgPoolExhausted` (409); anything else
 * propagates for the controller to map. (The multi-second settle is a hot-path defect, not a tuning
 * knob — shrinking the poll doesn't fix it, removing it from the request does.)
 * @param {any} transport
 * @param {string} workspaceId
 * @param {{ projects: number, prompts: number }} totals
 * @param {any} [log]
 * @returns {Promise<void>}
 */
async function transferOnce(transport, workspaceId, totals, log) {
  try {
    await transport.transferWorkspaceResources(workspaceId, { ai: totals });
  } catch (e) {
    if (isPoolExhausted(e)) {
      log?.warn?.('SERENITY_ALLOC org pool exhausted on transfer', { workspaceId });
      throw orgPoolExhausted();
    }
    if (isWorkspaceNotReady(e)) {
      // Still settling — do NOT poll. Fail fast with a retryable 503; the transfer is idempotent.
      log?.info?.('SERENITY_ALLOC workspace not ready on transfer — returning 503', { workspaceId });
      throw workspaceBusy();
    }
    throw e;
  }
}

// ---- entry points -------------------------------------------------------------------------------

/**
 * Ensure `subWorkspaceId` has headroom for `need` before a metered op. Hot path (already covered)
 * does a single read and returns without a transfer. Otherwise tops up in whole blocks, gating on
 * the per-brand ceiling and the org pool (read from the parent workspace's own `/resources`).
 * @param {any} transport
 * @param {object} opts
 * @param {string} opts.subWorkspaceId the sub-workspace being written to
 * @param {string} opts.parentWorkspaceId the parent/master workspace (units source; the org pool)
 * @param {Dims} opts.need per-dimension units the imminent op will consume
 * @param {Partial<Blocks>} [opts.ceiling] per-brand max `total` per dim (default: no ceiling)
 * @param {Blocks} [opts.blocks] grace blocks (default {@link DEFAULT_BLOCKS})
 * @param {boolean} [opts.includeDrafted] size the PROMPT dimension from `used + drafted + need`
 *   instead of `used + need`. Set at the PUBLISH seam: `drafted` is written synchronously at draft
 *   time and converts to `used` at publish, but the post-publish `used` reconciles asynchronously
 *   (stale-low). Sizing from `used + drafted` is staleness-immune, so a just-drafted batch has the
 *   quota it needs the instant it publishes (plan §21). Prompts only — a project has
 *   no draft-then-publish metering seam.
 * @param {any} [log]
 * @returns {Promise<{ toppedUp: boolean, newTotal: { projects: number, prompts: number } }>}
 */
export async function ensureAiHeadroom(transport, {
  subWorkspaceId, parentWorkspaceId, need,
  ceiling = {}, blocks = DEFAULT_BLOCKS, includeDrafted = false,
}, log) {
  // Fail LOUD on a missing sub-/parent-workspace id: an empty id is a fronting/wiring bug (the
  // caller failed to thread auth.workspaceId / auth.parentWorkspaceId), and silently reading `''`
  // would either drain the wrong pool or throw an opaque transport error. Surface it as a 500.
  requireWorkspaceId('ensureAiHeadroom', { subWorkspaceId, parentWorkspaceId });

  const child = readAiTotals(await transport.getWorkspaceResources(subWorkspaceId));

  /** @type {{ projects: number, prompts: number }} */
  const newTotal = { projects: child.projects.total, prompts: child.prompts.total };
  let toppedUp = false;
  for (const dim of DIMS) {
    const draftedAdd = includeDrafted && dim === 'prompts' ? child[dim].drafted : 0;
    const required = child[dim].used + draftedAdd + (Number(need?.[dim]) || 0);
    if (required > child[dim].total) {
      const target = roundUpToBlock(required, blocks[dim]);
      const cap = ceiling[dim];
      if (typeof cap === 'number' && target > cap) {
        log?.warn?.('SERENITY_ALLOC brand ceiling reached', {
          subWorkspaceId, dim, target, cap,
        });
        throw brandAiLimit();
      }
      newTotal[dim] = target;
      toppedUp = true;
    }
  }

  if (!toppedUp) {
    return { toppedUp: false, newTotal }; // hot path — no transfer, no poll
  }

  // Advisory pool gauge (NOT a gate): read the MASTER's OWN /resources — NOT /parent/resources,
  // which returns child-relative numbers (Gate 0). This read is a non-atomic advisory: under
  // concurrent top-ups it can race ahead of the authoritative transfer and report the pool low when
  // it isn't. So we do NOT throw on it — a low reading is logged (a greppable pool-free signal for
  // the observability follow-up) and we PROCEED to the transfer, whose `422 insufficient units` is
  // the single authoritative exhaustion signal (mapped to orgPoolExhausted in transferOnce).
  const master = readAiTotals(await transport.getWorkspaceResources(parentWorkspaceId));
  for (const dim of DIMS) {
    const delta = newTotal[dim] - child[dim].total;
    const free = master[dim].total - master[dim].used;
    if (delta > 0 && free < delta) {
      log?.warn?.('SERENITY_ALLOC advisory pool-free low (proceeding; transfer 422 is authoritative)', {
        subWorkspaceId, dim, free, delta,
      });
    }
  }

  // FAIL-FAST: one transfer attempt, no settle poll (serenity-docs#22). A still-settling child
  // returns a retryable 503 immediately rather than blocking the request on a poll.
  log?.info?.('SERENITY_ALLOC top-up', { subWorkspaceId, newTotal });
  await transferOnce(transport, subWorkspaceId, newTotal, log);
  return { toppedUp: true, newTotal };
}

/**
 * Release whole freed blocks back to the parent AFTER a delete/removal has been re-published (so
 * `used` reflects the removal). Never drops the child below `floor`; best-effort — logs and returns
 * on any failure.
 *
 * SCOPE DECISION (serenity-docs#22, Rainer 2026-07-08 — explicit, not an oversight): release runs
 * INLINE, fail-fast, best-effort, with NO async/queue/worker/reconciler infra — and none is
 * needed. Because a transfer is ABSOLUTE + idempotent, a missed or failed release simply leaves
 * surplus units stranded on the child; that self-heals three ways — the child's next
 * `ensureAiHeadroom` reuses the headroom (no re-transfer), a later release retry lowers it, or
 * decommission reclaims the whole allocation. So do NOT read "reconciler" here as "async infra
 * still needed"; the earlier "async/reconciler path" framing is superseded by this inline
 * best-effort decision. If/when a caller wires release into the delete / model-remove paths, keep
 * this same inline best-effort shape — do not introduce a queue or worker for it.
 * @param {any} transport
 * @param {object} opts
 * @param {string} opts.subWorkspaceId
 * @param {Partial<Blocks>} [opts.floor] minimum `total` per dim to retain (default 0)
 * @param {Blocks} [opts.blocks]
 * @param {PollOpts} [opts.poll]
 * @param {boolean} [opts.failFast] when true, do the release transfer with ONE attempt and NO
 *   settle poll (via the hot-path {@link transferOnce}) instead of the poll-based settle loop. Set
 *   this for a SYNCHRONOUS request-path caller (e.g. the model-update seam releasing units the
 *   removal just freed): honours the fail-fast hot-path rule, and is safe because release is
 *   best-effort + the transfer is absolute/idempotent and has no dependent op after it in-request.
 * @param {any} [log]
 * @returns {Promise<{
 *   released: boolean,
 *   reason?: 'nothing-to-release' | 'requires-decommission' | 'error',
 *   target?: { projects: number, prompts: number },
 * }>} `released:false` carries a `reason`: `nothing-to-release` (already at/below target),
 *   `requires-decommission` (surplus exists but its target floors to 0 — unreclaimable via
 *   transfer; see below), or `error` (a swallowed best-effort transport failure).
 */
export async function releaseAiSurplus(transport, {
  subWorkspaceId, floor = {}, blocks = DEFAULT_BLOCKS, poll = DEFAULT_POLL, failFast = false,
}, log) {
  try {
    // Fail LOUD on a missing/blank id, same as ensureAiHeadroom: a blank id is a caller wiring bug,
    // not a client error. Deliberately INSIDE the try — the surrounding catch only re-throws
    // unexpected errors (this is one) and swallows expected/best-effort ones, so a wiring bug still
    // propagates as a clear 500 rather than the opaque transport error a blank id would otherwise
    // produce, while still going through the same instanceof re-throw gate below.
    requireWorkspaceId('releaseAiSurplus', { subWorkspaceId });
    const child = readAiTotals(await transport.getWorkspaceResources(subWorkspaceId));
    /** @type {{ projects: number, prompts: number }} */
    const target = { projects: child.projects.total, prompts: child.prompts.total };
    let lowered = false;
    let requiresDecommission = false;
    for (const dim of DIMS) {
      const t = Math.max(Number(floor[dim]) || 0, roundUpToBlock(child[dim].used, blocks[dim]));
      if (t < child[dim].total) {
        if (t > 0) {
          // Only ever lower a dim to a NON-ZERO target. A transfer that sets a dim to 0 is a
          // SILENT NO-OP (live-verified 2026-07, release-probe.mjs): the gateway ignores an
          // all-zero (and, by extension, a to-zero) transfer. `target` deliberately keeps BOTH
          // dims (an un-lowered dim retains its current total), so the emitted payload is always
          // the live-verified both-dims shape — never a partial object (which the strict
          // transferAndSettle/transferOnce type also forbids) and never a newly-introduced 0.
          target[dim] = t;
          lowered = true;
        } else {
          // Surplus exists but the target floors to 0. It CANNOT be reclaimed via transfer (the
          // no-op above); full reclamation is via workspace delete/decommission. Leave this dim at
          // its current total and flag the caller — do NOT emit a 0 and falsely report success
          // (the quiet twin of the original all-zero-no-op bug).
          requiresDecommission = true;
        }
      }
    }
    if (!lowered) {
      if (requiresDecommission) {
        log?.warn?.('SERENITY_ALLOC releaseAiSurplus: surplus cannot be reclaimed via transfer '
          + `(target floors to 0) — needs decommission for ${subWorkspaceId}`);
        return { released: false, reason: 'requires-decommission' };
      }
      return { released: false, reason: 'nothing-to-release' };
    }
    if (failFast) {
      await transferOnce(transport, subWorkspaceId, target, log);
    } else {
      await transferAndSettle(transport, subWorkspaceId, target, poll, log);
    }
    return { released: true, target };
  } catch (e) {
    // Best-effort for EXPECTED failures (transport / pool / busy) — a reconciler converges strays.
    // Let unexpected bugs (TypeError, malformed-response Error) propagate so they surface in
    // monitoring rather than disappearing into a warn log.
    if (!(e instanceof SerenityTransportError) && !(e instanceof ErrorWithStatusCode)) {
      throw e;
    }
    log?.warn?.('SERENITY_ALLOC releaseAiSurplus best-effort failure', {
      subWorkspaceId, error: e?.message,
    });
    return { released: false, reason: 'error' };
  }
}
