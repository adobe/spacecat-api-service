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

import { ErrorWithStatusCode } from '../utils.js';
import { ERROR_CODES, isUpstreamGone } from './errors.js';
import { clearBrandWorkspaceCache } from './workspace-resolver.js';

// Per-brand resource allocation. PLACEHOLDER sizing (design §6/§12) until a
// sizing owner decides: one slot per market plus headroom, prompts scaled to
// project count. Tunable per call.
export function resourceAllocation(marketCount) {
  const projects = Math.max(1, Number(marketCount) || 0) + 2;
  return { ai: { projects, prompts: 500 * projects } };
}

// Fixed resource allocation carved onto a brand's child workspace at CREATE.
// A child created with an empty/inherited allocation lands with 0 metered quota,
// so anything metered (prompt writes, live publish) 405s as a disguised quota
// rejection (workspace doc §5). Carving a real allocation up front gives the
// child the quota it needs to take prompts and publish. Flat sizing (1 project,
// 500 prompts) per the sizing owner; this draws from the parent pool, so a
// parent without enough free units 422s "insufficient available units".
// Object.freeze so a caller can't mutate the shared singleton.
export const CREATE_ALLOCATION = Object.freeze({ ai: { projects: 1, prompts: 500 } });

// HISTORICAL NOTE (LLMO-6189): a payload of `{ ai: { projects: 0, prompts: 0 } }` was the
// documented "release everything back to the parent pool" shape, sent via
// transferWorkspaceResources. The Gate-A live smoke this comment used to defer to has since run:
// it confirmed a transfer that sets a dimension to ZERO is silently ignored by the Semrush gateway
// (2xx, no units moved). Every call site that sent this payload was therefore logging false success
// while permanently stranding the released workspace's ENTIRE carve on the parent pool — brand
// deactivation, the ensureSubworkspace concurrency-loser cleanup, and both brand-provisioning
// failure-cleanup paths.
//
// CORRECTED APPROACH (Rainer, 2026-07-16 PR review): production never deletes a sub-workspace —
// only Semrush CS reclaims a shell (docs/serenity.md). So the fix is not "delete instead of
// transfer-to-zero" — it is "transfer to a small NON-ZERO floor instead of zero". A non-zero
// transfer resizes a child up/down instantly and reliably (live-verified, resource-manager.js's
// `releaseAiSurplus` already relies on exactly this for ordinary rightsizing); only the to-ZERO
// case is the broken one. See {@link releaseFullAllocation} below.
export const DEFAULT_RELEASE_FLOOR = Object.freeze({ projects: 1, prompts: 1 });

// Workspace create normally settles `not ready → created` in seconds (workspace
// doc §4), but a busy upstream can take noticeably longer — so we poll up to ~30s
// (30 × 1s) before giving up. Still bounded so a genuinely stuck create surfaces
// as a clean error rather than pinning the Lambda. Timing is injectable so unit
// tests run without real delays.
const DEFAULT_POLL_ATTEMPTS = 30;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const defaultSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

// A brand's sub-workspace must never coincide with the org's shared parent
// workspace - sub-workspace ops (notably decommission: delete every project +
// release the allocation) against the parent would wipe the shared pool for
// the whole org. Throw rather than ever act on the parent.
function assertNotParent(workspaceId, parentWorkspaceId) {
  if (hasText(parentWorkspaceId) && workspaceId === parentWorkspaceId) {
    throw new ErrorWithStatusCode(
      'Brand sub-workspace must not be the organization parent workspace',
      409,
    );
  }
}

// A brand's sub-workspace is titled with the brand's bare display name — the
// same convention the migration CLI uses, so a customer sees ONE naming scheme
// in the Semrush UI regardless of how the brand was onboarded.
//
// Brand display names are NOT unique within an org, so the title alone is a weak
// key for the two adoption paths in ensureSubworkspace. It is deliberately not
// the only one: findAdoptableFamilyMatch drops every family candidate already
// bound to a DIFFERENT brand before it counts matches, which is what keeps a
// timed-out create from adopting a same-named sibling brand's sub-workspace (and
// a later deactivate from decommissioning the wrong brand's live markets). See
// the claim filter there for the full rule set.
//
// The name is therefore required: an untitled workspace would collide with every
// other untitled one and is not something adoption could ever disambiguate. Every
// path reaching here validates the name earlier (brand create 400s without one),
// so this is defensive-only.
function subworkspaceTitle(brand) {
  const name = brand?.getName?.();
  if (!hasText(name)) {
    throw new ErrorWithStatusCode(
      'Brand sub-workspace title requires a brand name (none resolved)',
      500,
    );
  }
  return name;
}

export async function pollUntilCreated(transport, workspaceId, { attempts, intervalMs, sleep }) {
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const status = await transport.getWorkspaceStatus(workspaceId);
    if (status?.status === 'created') {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  throw new ErrorWithStatusCode(
    `Subworkspace ${workspaceId} did not settle to 'created' in time`,
    504,
  );
}

// The user-manager family endpoint (GET /v1/workspaces/{id}/family) returns a
// BARE ARRAY of workspaces — live-verified against the gateway (the swagger types
// it as a top-level array too). An earlier `family?.items` read assumed an
// `{ items: [...] }` envelope, so on the real bare-array response `.items` was
// undefined and EVERY family entry was discarded: ambiguous-create recovery never
// matched (always 502 "no family match to adopt") and the linked-child guard saw
// zero children. Read the array directly; the guard only protects against a
// non-array (null / error body) so a malformed response can't throw here.
function familyItems(family) {
  return Array.isArray(family) ? family : [];
}

/**
 * Resolves the id of the brand currently bound to `workspaceId`, or `null` when no
 * brand claims it. `brands.semrush_sub_workspace_id` carries a DB UNIQUE constraint,
 * so at most one brand can ever be returned.
 *
 * @param {object} brandCollection - the data-access Brand collection.
 * @param {string} [workspaceId]
 * @returns {Promise<string|null>}
 */
async function claimedBrandId(brandCollection, workspaceId) {
  if (!workspaceId || !hasText(workspaceId)) {
    return null;
  }
  const owner = await brandCollection.findBySemrushSubWorkspaceId(workspaceId);
  return owner?.getId?.() ?? null;
}

/**
 * Finds the one adoptable same-title child in the parent's family, or `null` when
 * none exists. "Adoptable" means a `created`, project-empty sub-workspace that no
 * other brand has claimed.
 *
 * Claim filter: titles are bare brand display names, which are not unique within an
 * org (prod carries same-named brand pairs today, some with a sub-workspace already
 * bound). A candidate whose id is already persisted as another brand's
 * `semrush_sub_workspace_id` is therefore provably NOT ours — adopting it would graft
 * this brand onto a sibling's workspace, and the sibling's next deactivate would
 * decommission markets belonging to both. Such candidates are DROPPED rather than
 * escalated: dropping lets the proactive path correctly create a fresh workspace, and
 * lets a genuine lone match still be adopted when a claimed twin sits beside it in the
 * listing. A candidate claimed by THIS brand stays adoptable — that is a concurrent
 * request for the same brand, which the caller's `reloadPointer` guard settles.
 *
 * The claim lookup is mandatory whenever there is at least one same-title `created`
 * candidate: without it the title is the only key left, which is exactly the
 * mis-adoption this filter exists to prevent. A create with no candidates has nothing
 * to mis-adopt, so it does not need one.
 *
 * Status filter (issue #2718): a Semrush child create can be 200-acked and then
 * fail provisioning asynchronously, leaving a stub permanently stuck at
 * `status: 'not ready'` ("invalid subscription") that we cannot delete. Such a
 * zombie also has `projectCount 0`, so a title+empty-only match would (a) adopt
 * it as the brand's workspace (then immediately re-time-out at pollUntilCreated)
 * and (b) once ≥2 accumulate, inflate the multiple-match `409` and wedge the
 * brand. Considering ONLY `status === 'created'` entries makes accumulated
 * zombies invisible to the matcher, breaking that snowball. The live family
 * endpoint always returns a status, so the strict equality is safe.
 *
 * Shared by both adoption paths so the match/ambiguity/empty rules live in one
 * place: the proactive create-or-adopt check (returns the match to reuse, or
 * null → create) and the 504 timeout recovery (null → no-match error).
 *
 * @param {object} transport
 * @param {string} parentWorkspaceId
 * @param {string} title
 * @param {object} log
 * @param {object} claim - claim-filter inputs.
 * @param {object} [claim.brandCollection] - the data-access Brand collection used to
 *   detect a candidate already bound to another brand.
 * @param {string} [claim.selfBrandId] - this brand's id; a candidate claimed by it is
 *   still adoptable.
 * @returns {Promise<object|null>} the sole adoptable family entry, or null.
 */
async function findAdoptableFamilyMatch(transport, parentWorkspaceId, title, log, claim) {
  const { brandCollection, selfBrandId } = claim;
  const family = await transport.listWorkspaceFamily(parentWorkspaceId);
  const items = familyItems(family);
  const sameTitle = items.filter((w) => w?.title === title && w?.status === 'created');

  if (sameTitle.length > 0
    && typeof brandCollection?.findBySemrushSubWorkspaceId !== 'function') {
    throw new ErrorWithStatusCode(
      `Cannot evaluate subworkspace candidates for '${title}': no Brand collection to detect a `
      + 'candidate already claimed by another brand',
      500,
    );
  }
  const owners = await Promise.all(
    sameTitle.map((w) => claimedBrandId(brandCollection, w?.id)),
  );
  // One predicate for both partitions so they can never drift apart.
  const isAdoptable = (i) => !owners[i] || owners[i] === selfBrandId;
  const matches = sameTitle.filter((w, i) => isAdoptable(i));
  const claimedByOthers = sameTitle.filter((w, i) => !isAdoptable(i));
  if (claimedByOthers.length > 0) {
    log?.info?.('ensureSubworkspace: ignoring same-title family entr(ies) already claimed by another brand', {
      parentWorkspaceId,
      title,
      claimedCount: claimedByOthers.length,
      claimedIds: claimedByOthers.map((w) => w?.id),
    });
  }

  if (matches.length === 0) {
    // Surface filtered-out non-`created` same-title stubs (Semrush ack-then-fail
    // zombies) so their accumulation is visible in logs without a manual family
    // query — they are the exact failure mode this status filter absorbs (#2718).
    const ignored = items.filter((w) => w?.title === title && w?.status !== 'created');
    if (ignored.length > 0) {
      log?.info?.('ensureSubworkspace: ignoring non-created same-title family stub(s)', {
        parentWorkspaceId,
        title,
        ignoredCount: ignored.length,
        ignoredStatuses: [...new Set(ignored.map((w) => w?.status))],
      });
    }
    return null;
  }
  if (matches.length > 1) {
    log?.error?.('ensureSubworkspace: ambiguous create — multiple created family matches, refusing to guess', {
      parentWorkspaceId,
      title,
      matchIds: matches.map((m) => m?.id),
    });
    const err = new ErrorWithStatusCode(
      `Ambiguous subworkspace create for '${title}': multiple workspaces share the title`,
      409,
    );
    err.code = ERROR_CODES.AMBIGUOUS_WORKSPACE;
    throw err;
  }
  const adopted = matches[0];
  const adoptedId = String(adopted?.id || '');
  if (!hasText(adoptedId)) {
    throw new ErrorWithStatusCode(
      `Ambiguous subworkspace create for '${title}': sole family match has no id`,
      502,
    );
  }
  // Defense-in-depth: adopt ONLY a genuinely empty sub-workspace. An interrupted
  // create has not yet created any projects (projects are created only after the
  // workspace settles to `created`), so a non-empty match is NOT our create —
  // adopting it would graft this brand onto an already-provisioned workspace.
  // Refuse rather than risk contamination.
  const adoptedListing = await transport.listProjects(adoptedId);
  const projectCount = Array.isArray(adoptedListing?.items) ? adoptedListing.items.length : 0;
  if (projectCount > 0) {
    log?.error?.('ensureSubworkspace: refusing to adopt a non-empty family match', {
      parentWorkspaceId,
      title,
      adoptedId,
      projectCount,
    });
    throw new ErrorWithStatusCode(
      `Ambiguous subworkspace create for '${title}': sole family match has ${projectCount} project(s), refusing to adopt`,
      502,
    );
  }
  log?.info?.('ensureSubworkspace: adopted same-title family match', {
    parentWorkspaceId,
    title,
    adoptedId,
  });
  return adopted;
}

/**
 * Ambiguous-create recovery (design §6): a timed-out createSubworkspace is
 * ambiguous (no idempotency key). List the parent's family, match the title among
 * the candidates no other brand has claimed, and adopt a `created`, project-empty
 * subworkspace. No match → fail (the create was attempted, so a missing entry is an
 * error here, unlike the proactive path where it just means "create one"). Multiple
 * matches → fail with an alert, never guess.
 *
 * @param {object} transport
 * @param {string} parentWorkspaceId
 * @param {string} title
 * @param {object} log
 * @param {object} claim - claim-filter inputs, forwarded to findAdoptableFamilyMatch.
 * @param {object} [claim.brandCollection]
 * @param {string} [claim.selfBrandId]
 * @returns {Promise<object>} the adopted family entry.
 */
async function adoptFromFamily(transport, parentWorkspaceId, title, log, claim) {
  const adopted = await findAdoptableFamilyMatch(transport, parentWorkspaceId, title, log, claim);
  if (!adopted) {
    throw new ErrorWithStatusCode(
      `Ambiguous subworkspace create for '${title}' and no family match to adopt`,
      502,
    );
  }
  return adopted;
}

/**
 * Deletes every project currently listed in `workspaceId` (404-as-success, convergent /
 * idempotent). Extracted so it is shared by `decommissionBrandWorkspace` and every other
 * LLMO-6189 full-allocation-release call site that must empty a sub-workspace's projects before
 * {@link releaseFullAllocation} can safely delete the (now-empty) workspace itself.
 * @param {object} transport
 * @param {string} workspaceId
 * @returns {Promise<number>} the number of projects the listing returned (i.e. attempted deletes).
 */
export async function deleteAllProjects(transport, workspaceId) {
  const listing = await transport.listProjects(workspaceId);
  const projects = Array.isArray(listing?.items) ? listing.items : [];
  for (const project of projects) {
    const projectId = project?.id;
    if (!hasText(projectId)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await transport.deleteProject(workspaceId, projectId);
    } catch (e) {
      if (!isUpstreamGone(e)) {
        throw e;
      }
    }
  }
  return projects.length;
}

/**
 * Reclaims `workspaceId`'s AI resource carve back to the parent pool, down to a small non-zero
 * floor (LLMO-6189). Production never deletes a sub-workspace (docs/serenity.md — a shell is only
 * ever reclaimed by Semrush CS), so this does NOT delete anything. It transfers the workspace's
 * `{projects, prompts}` totals down to `floor` — a NON-ZERO target, which resizes reliably
 * (live-verified; the same mechanism `releaseAiSurplus` already uses for ordinary rightsizing).
 * Only a transfer that sets a dimension to exactly ZERO is a silent no-op against the gateway —
 * this function's whole point is to never send that payload.
 *
 * `assertNotParent` guards the call — a captured/adopted id that turns out to be the org parent (a
 * gateway bug; see the create-path comment on `assertNotParent`) must never have its allocation
 * touched.
 *
 * A caller-supplied `floor` with either dimension `<= 0` is REJECTED (MysticatBot review, PR
 * #2812): that is exactly the zero-transfer payload this whole fix exists to eliminate — no
 * current caller passes a custom floor, but the option is exported/documented, so a future one
 * could silently reintroduce the stranding bug this PR fixes. Fail loud instead.
 *
 * @param {object} transport
 * @param {string} workspaceId - the (already project-emptied) sub-workspace to reclaim.
 * @param {string} [parentWorkspaceId] - the org parent workspace; assertNotParent guard.
 * @param {object} [log]
 * @param {object} [options]
 * @param {{projects: number, prompts: number}} [options.floor] - the non-zero total to lower the
 *   workspace's AI allocation to. Defaults to {@link DEFAULT_RELEASE_FLOOR} (1 project, 1 prompt) —
 *   enough to keep the workspace immediately usable on its next re-activation without a fresh
 *   create, while returning everything above that to the shared pool. Both dimensions must be > 0.
 * @returns {Promise<{ released: boolean, reason: 'lowered-to-floor' | 'no-workspace' }>}
 */
export async function releaseFullAllocation(
  transport,
  workspaceId,
  parentWorkspaceId,
  log,
  { floor = DEFAULT_RELEASE_FLOOR } = {},
) {
  if (!hasText(workspaceId)) {
    return { released: false, reason: 'no-workspace' };
  }
  if (!(floor?.projects > 0) || !(floor?.prompts > 0)) {
    throw new ErrorWithStatusCode(
      'releaseFullAllocation: floor must have both dimensions > 0 — a zero-dimension transfer is '
      + 'a silent no-op against the Semrush gateway (the exact bug this function exists to fix)',
      500,
    );
  }
  assertNotParent(workspaceId, parentWorkspaceId);

  await transport.transferWorkspaceResources(workspaceId, { ai: floor });
  log?.info?.(
    'SERENITY_ALLOC releaseFullAllocation: allocation lowered to floor, surplus returned to the parent pool',
    { workspaceId, floor },
  );
  return { released: true, reason: 'lowered-to-floor' };
}

/**
 * Guarantees the brand has a resourced subworkspace and returns its id
 * (design §6). Three cases:
 *   - column set        → the brand is already bound to a sub-workspace
 *                         (idempotent re-activate): re-grant an allocation onto
 *                         it (a no-op-ish re-grant on an already-resourced ws —
 *                         the transfer contract is Gate-A-pinned). Note a
 *                         deactivated brand has a NULL column (deactivate clears
 *                         it), so it takes the create path below, not this one.
 *   - no column, create → create subworkspace → poll `created` → persist the column
 *                         AFTER it reads back created.
 *   - create timeout    → adopt from the parent family by exact title.
 *
 * Persisting the column flips the brand into subworkspace mode (resolveBrandWorkspace).
 *
 * @param {object} transport - serenity transport.
 * @param {object} brand - Brand model instance (dataAccess.Brand.findById).
 * @param {string} parentWorkspaceId - the org parent workspace.
 * @param {number} marketCount - sizing input for the allocation.
 * @param {object} log
 * @param {object} [timing] - injectable poll timing for tests.
 * @param {function|null} [reloadPointer] - optional async () => string|null that
 *   re-reads the brand's CURRENT semrush_sub_workspace_id from the data layer.
 *   When supplied, the create path uses it as a last-update concurrency guard
 *   (see below) so a parallel activation cannot orphan a resourced workspace.
 * @param {object} [options] - feature-flag toggles for the dual-mode carve.
 * @param {boolean} [options.dynamicAllocation] - when true (LLMO/dynamic-allocation ON), skip
 *   the flat re-grant on an existing sub-workspace; JIT top-up owns sizing. Default false.
 * @param {object} [options.brandCollection] - the data-access Brand collection. Required on the
 *   create path whenever the parent family holds a same-title `created` candidate: titles are
 *   bare brand names, so the claim lookup is what distinguishes our own interrupted create from
 *   a same-named sibling brand's sub-workspace (see findAdoptableFamilyMatch).
 * @param {function} [options.onWorkspaceCreated] - called with the sub-workspace id when this
 *   call FRESHLY CREATED it upstream, and never when it adopted an existing one. Failure
 *   compensation must key off this rather than off the returned id: a caller that tears down
 *   an ADOPTED workspace is tearing down a workspace it does not own. Titles are bare brand
 *   names, so an adopted workspace can belong to a same-named sibling brand whose own
 *   provisioning is still in flight and has not yet persisted its claim.
 * @returns {Promise<string>} the subworkspace id.
 */
export async function ensureSubworkspace(
  transport,
  brand,
  parentWorkspaceId,
  marketCount,
  log,
  timing = {},
  reloadPointer = null,
  options = {},
) {
  const { dynamicAllocation = false, brandCollection, onWorkspaceCreated } = options;
  const poll = {
    attempts: timing.attempts ?? DEFAULT_POLL_ATTEMPTS,
    intervalMs: timing.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    sleep: timing.sleep ?? defaultSleep,
  };

  const existing = brand.getSemrushSubWorkspaceId?.();
  if (hasText(existing)) {
    // Defense-in-depth: a sub-workspace must never BE the org parent (else a
    // re-grant/transfer would mutate the shared pool). The controller's
    // authorize() already refuses such requests; guard here too so a direct
    // caller can never transfer-onto / later decommission the parent.
    assertNotParent(existing, parentWorkspaceId);
    // Re-grant the allocation onto the already-bound sub-workspace (idempotent
    // re-activate of a still-active brand; a deactivated brand has a NULL
    // pointer and takes the create path instead).
    // resources/transfer is ASYNC: it briefly flips the workspace to `locked`
    // and a subsequent op 422s "workspace not ready" (verified live
    // 2026-06-15). So settle before AND after the transfer so the caller can
    // immediately create/publish projects against it.
    // This pre-poll runs regardless of mode — the workspace must be `created` before we return it
    // (dynamic allocation only skips the flat re-grant below, not the readiness settle).
    await pollUntilCreated(transport, existing, poll);
    // Dynamic allocation (flag ON): SKIP the flat re-grant. The pre-sized
    // `resourceAllocation(marketCount)` carve is exactly the up-front over/under-allocation JIT
    // replaces — the metered handlers top up just-in-time (ensureAiHeadroom) and release surplus,
    // so re-flattening the total here would both undo a JIT top-up and, on an ON→OFF rollback of an
    // already-grown child, risk setting `total` below `used`. Flag OFF unchanged (byte-for-byte).
    //
    // SCOPE DECISION (serenity-docs#22, Rainer 2026-07-08 — explicit, NOT a deferral): there is NO
    // rightsizing/backfill sweep for children already carved under the OLD flat allocation, and
    // none is planned. It was evaluated and rejected as unnecessary: decommission already releases
    // a child's FULL allocation to the parent pool, and any over-provisioned survivor self-heals
    // on its next delete/model-remove release or on decommission (the carve only over-reserves — it
    // never breaks the child). So do not read the absence of a migration sweep as missing work.
    if (!dynamicAllocation) {
      await transport.transferWorkspaceResources(existing, resourceAllocation(marketCount));
      await pollUntilCreated(transport, existing, poll);
    }
    return existing;
  }

  if (!hasText(parentWorkspaceId)) {
    throw new ErrorWithStatusCode('Cannot create a subworkspace: organization has no parent workspace', 404);
  }

  const title = subworkspaceTitle(brand);
  const claim = { brandCollection, selfBrandId: brand?.getId?.() };
  // Idempotent create-or-adopt (issue #2718): a retry after a partial
  // provisioning failure must NOT spawn a duplicate stub for this brand (a retry
  // rebuilds the same title). Check the parent family for an existing `created`,
  // empty, unclaimed same-title child FIRST and reuse it; only create when none
  // exists. Failed `not ready` zombies are filtered out by the status check in
  // findAdoptableFamilyMatch, and a same-named SIBLING brand's workspace by the
  // claim check there, so neither is ever reused nor inflates the ambiguity 409.
  let created = await findAdoptableFamilyMatch(transport, parentWorkspaceId, title, log, claim);
  // Provenance, not just identity: everything that later tears this workspace down must know
  // whether WE brought it into existence. An adopted workspace may belong to a same-named
  // sibling brand whose provisioning is still in flight (its claim is not persisted yet), so
  // releasing it would strip a workspace we do not own.
  let freshlyCreated = false;
  if (!created) {
    try {
      // Carve a fixed allocation (CREATE_ALLOCATION) onto the child so it has the
      // metered quota to take prompts and publish. marketCount does not size the
      // create — the allocation is flat (1 project, 500 prompts). If the parent
      // pool can't cover it the create 422s "insufficient available units".
      created = await transport.createSubworkspace(
        parentWorkspaceId,
        title,
        CREATE_ALLOCATION,
      );
      freshlyCreated = true;
    } catch (e) {
      // 504 = our transport's timeout signal → ambiguous create, recover by
      // adoption. The transport timeout is a SerenityTransportError (status 504),
      // NOT an ErrorWithStatusCode — guard on that so a 504 from our own poll
      // helper (an ErrorWithStatusCode) re-throws instead of re-entering adoption.
      if (!(e instanceof ErrorWithStatusCode) && e?.status === 504) {
        created = await adoptFromFamily(transport, parentWorkspaceId, title, log, claim);
      } else {
        throw e;
      }
    }
  }

  const workspaceId = String(created?.id || '');
  if (!hasText(workspaceId)) {
    throw new ErrorWithStatusCode('createSubworkspace returned no workspace id', 502);
  }
  // A create (or adoption) that handed back the parent id is a gateway bug;
  // never persist the parent as the brand's sub-workspace.
  assertNotParent(workspaceId, parentWorkspaceId);

  await pollUntilCreated(transport, workspaceId, poll);

  // Concurrency guard (defense-in-depth against a lost-update orphan): a
  // parallel activate / createMarket for the SAME brand may have created and
  // persisted its own sub-workspace while we were creating + polling ours.
  // Overwriting the pointer now would orphan the winner's workspace AND leave
  // two resourced sub-workspaces drawing from the shared parent pool. Re-read
  // the brand's current pointer; if another request already won, release OUR
  // freshly-created workspace's allocation back to the parent (it cannot be
  // deleted — deletion is forbidden) and adopt the winner's id instead.
  // Residual: two requests that both re-read null in the same instant still
  // both persist; a fully race-free fix needs a conditional "set pointer where
  // pointer is null" write at the data layer (tracked follow-up).
  if (typeof reloadPointer === 'function') {
    const concurrent = await reloadPointer();
    if (hasText(concurrent) && concurrent !== workspaceId) {
      log?.error?.('ensureSubworkspace: concurrent activation won; standing down', {
        keptWorkspaceId: concurrent,
        standDownWorkspaceId: workspaceId,
        // False → we adopted this workspace rather than creating it, so it is not
        // ours to release; we simply let it be.
        releasing: freshlyCreated,
      });
      try {
        // Release ONLY a workspace this call created. An ADOPTED one is not ours to tear down:
        // titles are bare brand names, so it can be a same-named sibling brand's workspace whose
        // claim is not persisted yet, and emptying it would destroy that brand's provisioning.
        // The loser's workspace is provably project-empty here — the create-or-adopt path above
        // never creates a project itself (that only happens in the CALLER, strictly after this
        // function returns). Still run deleteAllProjects defensively (cheap, idempotent) so this
        // stays uniform with the other release sites (LLMO-6189) rather than leaning on that
        // invariant holding forever.
        if (freshlyCreated) {
          await deleteAllProjects(transport, workspaceId);
          await releaseFullAllocation(transport, workspaceId, parentWorkspaceId, log);
        }
      } catch (e) {
        // Best-effort: a failed release leaves the orphan resourced, but we
        // still must NOT clobber the winner's pointer below.
        log?.error?.('ensureSubworkspace: failed to release orphaned workspace allocation', {
          releasedWorkspaceId: workspaceId,
          error: e.message,
        });
      }
      return concurrent;
    }
  }

  if (freshlyCreated && typeof onWorkspaceCreated === 'function') {
    onWorkspaceCreated(workspaceId);
  }

  // Persist AFTER the workspace reads back `created` — flips the brand to subworkspace mode.
  brand.setSemrushSubWorkspaceId(workspaceId);
  await brand.save();
  // Invalidate the resolver's brand cache so the next request sees subworkspace mode
  // without waiting out the negative TTL.
  clearBrandWorkspaceCache();
  return workspaceId;
}

/**
 * Decommissions a brand's sub-workspace (design §6) — convergent and
 * idempotent. Steps:
 *   1. delete every project from the listing (404-as-success)
 *   2. reclaim the ai allocation back to the parent pool via
 *      {@link releaseFullAllocation} — lowered to a small non-zero floor, never deleted —
 *      production never deletes a sub-workspace (LLMO-6189).
 *   3. (member removal is best-effort and currently deferred — parent admins
 *      inherit access regardless, workspace doc §7; enumerating members needs
 *      a listMembers transport method not added in this phase)
 *
 * Self-defending: refuses if the target is the org parent OR still has active
 * linked (child) sub-workspaces.
 *
 * This touches only the upstream workspace. Clearing the brand's
 * `semrush_sub_workspace_id` pointer (the disconnect) is the CALLER's job —
 * the deactivate handler does it after this resolves, leaving the
 * sub-workspace empty and unowned (or, with the flag on, gone).
 *
 * @param {object} transport
 * @param {string} subworkspaceId
 * @param {object} log
 * @param {string} [parentWorkspaceId] - when provided, a self-defending guard:
 *   refuse to empty/release the org's shared parent workspace even if a caller
 *   ever reaches here without the controller's authorize() guard.
 * @param {object} [options]
 * @param {boolean} [options.enforceLinkedGuard=false] - enable the
 *   linked-sub-workspace guard (refuse if the target still has active children).
 *   Default OFF: the guard relies on `GET …/family` returning a leaf's
 *   DESCENDANTS only. That leaf-direction semantic is NOT yet live-verified - if
 *   `family(leaf)` instead returns SIBLINGS, an always-on guard would falsely
 *   409 EVERY deactivate in any org with ≥2 sub-workspaces. Keep it gated until
 *   the dev gateway is probed, then flip the flag on
 *   (SERENITY_ENFORCE_LINKED_SUBWORKSPACE_GUARD=true). The parent-equality guard
 *   below is always on - that invariant is verified and safe.
 */
export async function decommissionBrandWorkspace(
  transport,
  subworkspaceId,
  log,
  parentWorkspaceId,
  { enforceLinkedGuard = false } = {},
) {
  if (!hasText(subworkspaceId)) {
    return;
  }
  // Destructive primitive made self-defending: never delete projects from /
  // release the allocation of the shared org parent workspace.
  assertNotParent(subworkspaceId, parentWorkspaceId);

  // Defense-in-depth: refuse to decommission a workspace that still has active
  // linked (child / nested) sub-workspaces - releasing its allocation would pull
  // the resource pool out from under its dependents. A brand sub-workspace is a
  // leaf by design, so this is normally empty; any child means the target is
  // acting as a parent and must not be emptied. Fail-closed: a family-listing
  // error propagates and aborts the decommission rather than guessing.
  // Gated (default off) because the family endpoint's leaf-direction semantics
  // are not yet live-verified - see the @param note. When enabled we
  // conservatively exclude the target's own id and treat any other returned
  // workspace as a blocking child.
  if (enforceLinkedGuard) {
    const family = await transport.listWorkspaceFamily(subworkspaceId);
    const children = familyItems(family)
      .filter((w) => hasText(w?.id) && w.id !== subworkspaceId);
    if (children.length > 0) {
      const err = new ErrorWithStatusCode(
        `Refusing to decommission ${subworkspaceId}: it has ${children.length} active linked sub-workspace(s)`,
        409,
      );
      err.code = ERROR_CODES.LINKED_SUBWORKSPACES;
      throw err;
    }
  }

  const deletedProjects = await deleteAllProjects(transport, subworkspaceId);
  const release = await releaseFullAllocation(transport, subworkspaceId, parentWorkspaceId, log);
  log?.info?.(
    'decommissionBrandWorkspace: emptied projects, allocation lowered to floor — surplus returned to the parent pool',
    {
      subworkspaceId, deletedProjects, released: release.released, reason: release.reason,
    },
  );
}
