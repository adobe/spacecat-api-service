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
const DIMS = /** @type {const} */ (['projects', 'prompts']);

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

/** Bounded retries for the transient `422 "workspace not ready"` on a transfer. */
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
 * Prompt units for M texts across K attached models — metered at publish (`texts × models`).
 * @param {number} texts @param {number} models @returns {number}
 */
export const promptUnits = (texts, models) => Math.max(0, texts) * Math.max(0, models);

/**
 * Prompt units for attaching/removing Δmodels to a project that already has `publishedTexts`
 * published texts — every existing text re-meters by the model delta.
 * @param {number} publishedTexts @param {number} deltaModels @returns {number}
 */
export const modelChangeUnits = (publishedTexts, deltaModels) => Math.max(0, publishedTexts)
  * Math.max(0, deltaModels);

/**
 * Need for creating + publishing a market: one project plus its generated prompts' units.
 * @param {{ generatedTexts?: number, models?: number }} [spec]
 * @returns {Dims}
 */
export const marketNeed = ({ generatedTexts = 0, models = 0 } = {}) => ({
  projects: 1,
  prompts: promptUnits(generatedTexts, models),
});

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

/** @param {string} message @returns {ErrorWithStatusCode} */
function orgPoolExhausted(message) {
  const e = new ErrorWithStatusCode(message, 409);
  e.code = ERROR_CODES.ORG_POOL_EXHAUSTED;
  return e;
}

/** @param {string} message @returns {ErrorWithStatusCode} */
function brandAiLimit(message) {
  const e = new ErrorWithStatusCode(message, 409);
  e.code = ERROR_CODES.BRAND_AI_LIMIT;
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
 * @param {any} log
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
        throw orgPoolExhausted(`Org pool cannot cover the transfer for ${workspaceId}`);
      }
      if (!isWorkspaceNotReady(e)) {
        throw e; // any other error (incl. poll timeout 504) propagates for the caller to map
      }
      if (attempt === NOT_READY_RETRIES) {
        break; // exhausted retries on the transient lock
      }
      log?.info?.(`SERENITY_ALLOC workspace-not-ready, retrying transfer (attempt ${attempt + 1})`);
      // eslint-disable-next-line no-await-in-loop
      await poll.sleep(poll.intervalMs * (attempt + 1));
    }
  }
  throw orgPoolExhausted(`Transfer for ${workspaceId} never cleared 'workspace not ready'`);
}

// ---- entry points -------------------------------------------------------------------------------

/**
 * Ensure `childId` has headroom for `need` before a metered op. Hot path (already covered) does a
 * single read and returns without a transfer. Otherwise tops up in whole blocks, gating on the
 * per-brand ceiling and the org pool (read from the MASTER's own `/resources`).
 * @param {any} transport
 * @param {object} opts
 * @param {string} opts.childId the sub-workspace being written to
 * @param {string} opts.masterId the parent/master workspace (units source; the org pool)
 * @param {Dims} opts.need per-dimension units the imminent op will consume
 * @param {Partial<Blocks>} [opts.ceiling] per-brand max `total` per dim (default: no ceiling)
 * @param {Blocks} [opts.blocks] grace blocks (default {@link DEFAULT_BLOCKS})
 * @param {PollOpts} [opts.poll] settle-poll budget (default {@link DEFAULT_POLL})
 * @param {any} [log]
 * @returns {Promise<{ toppedUp: boolean, newTotal: { projects: number, prompts: number } }>}
 */
export async function ensureAiHeadroom(transport, {
  childId, masterId, need, ceiling = {}, blocks = DEFAULT_BLOCKS, poll = DEFAULT_POLL,
}, log) {
  const child = readAiTotals(await transport.getWorkspaceResources(childId));

  /** @type {{ projects: number, prompts: number }} */
  const newTotal = { projects: child.projects.total, prompts: child.prompts.total };
  let toppedUp = false;
  for (const dim of DIMS) {
    const required = child[dim].used + (Number(need?.[dim]) || 0);
    if (required > child[dim].total) {
      const target = roundUpToBlock(required, blocks[dim]);
      const cap = ceiling[dim];
      if (typeof cap === 'number' && target > cap) {
        throw brandAiLimit(`Brand AI ${dim} allocation ${target} exceeds ceiling ${cap} for ${childId}`);
      }
      newTotal[dim] = target;
      toppedUp = true;
    }
  }

  if (!toppedUp) {
    return { toppedUp: false, newTotal }; // hot path — no transfer, no poll
  }

  // Advisory pool precheck (the transfer 422 is authoritative). Read the MASTER's OWN /resources —
  // NOT /parent/resources, which returns child-relative numbers (Gate 0).
  const master = readAiTotals(await transport.getWorkspaceResources(masterId));
  for (const dim of DIMS) {
    const delta = newTotal[dim] - child[dim].total;
    const free = master[dim].total - master[dim].used;
    if (delta > 0 && free < delta) {
      throw orgPoolExhausted(`Org pool ${dim} free ${free} < needed ${delta} for ${childId}`);
    }
  }

  await transferAndSettle(transport, childId, newTotal, poll, log);
  return { toppedUp: true, newTotal };
}

/**
 * Release whole freed blocks back to the parent AFTER a delete/removal has been re-published (so
 * `used` reflects the removal). Never drops the child below `floor`; best-effort — logs and returns
 * on any failure (a reconciler converges strays). Intended for the async/reconciler path, not the
 * synchronous delete request.
 * @param {any} transport
 * @param {object} opts
 * @param {string} opts.childId
 * @param {Partial<Blocks>} [opts.floor] minimum `total` per dim to retain (default 0)
 * @param {Blocks} [opts.blocks]
 * @param {PollOpts} [opts.poll]
 * @param {any} [log]
 * @returns {Promise<{ released: boolean, target?: { projects: number, prompts: number } }>}
 */
export async function releaseAiSurplus(transport, {
  childId, floor = {}, blocks = DEFAULT_BLOCKS, poll = DEFAULT_POLL,
}, log) {
  try {
    const child = readAiTotals(await transport.getWorkspaceResources(childId));
    /** @type {{ projects: number, prompts: number }} */
    const target = { projects: child.projects.total, prompts: child.prompts.total };
    let lowered = false;
    for (const dim of DIMS) {
      const t = Math.max(Number(floor[dim]) || 0, roundUpToBlock(child[dim].used, blocks[dim]));
      if (t < child[dim].total) {
        target[dim] = t;
        lowered = true;
      }
    }
    if (!lowered) {
      return { released: false };
    }
    await transferAndSettle(transport, childId, target, poll, log);
    return { released: true, target };
  } catch (e) {
    log?.warn?.(`SERENITY_ALLOC releaseAiSurplus best-effort failure for ${childId}: ${e?.message}`);
    return { released: false };
  }
}
