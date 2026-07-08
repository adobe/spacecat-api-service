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

// "Release everything back to the parent pool" payload. The EXACT shape is a
// Gate-A live-smoke contract pin (design §6/§11) — release-to-parent is
// unobservable on the limits-disabled dev parent until verified. Zeroing the
// ai allocation is the documented intent; adjust here once Gate-A pins it.
export const RELEASE_ALLOCATION = Object.freeze({ ai: { projects: 0, prompts: 0 } });

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

// The sub-workspace title must be UNIQUE per brand within the org parent: it is
// the ONLY key ambiguous-create recovery (adoptFromFamily) has to match a
// timed-out create against the parent's family listing. Brand DISPLAY names are
// NOT unique within an org, so a name-only title would let one brand adopt a
// different, same-named brand's sub-workspace after a create timeout - and a
// later deactivate would then decommission the WRONG brand's live markets.
// Embed (the first 8 chars of) the immutable brand id so the title stays short
// in the Semrush UI while remaining collision-free for the adoption match: 8 hex
// chars is 2^32 of space, far more than a single org's brand count, so the
// name+suffix pair is still effectively unique per brand.
const ID_SUFFIX_LEN = 8;

function subworkspaceTitle(brand) {
  const name = brand?.getName?.();
  const id = brand?.getId?.();
  const suffix = hasText(id) ? id.slice(0, ID_SUFFIX_LEN) : '';
  // The id-suffix is the collision-free key the adoption match depends on (see
  // the block comment above). Without it the title would not be unique per
  // brand, so a missing brand id is a hard error, NOT a silent fallback to a
  // non-unique title that adoption could later mis-match. brandId is always a
  // UUID on every path that reaches here, so this is defensive-only.
  if (!hasText(suffix)) {
    throw new ErrorWithStatusCode(
      'Brand sub-workspace title requires a brand id (none resolved)',
      500,
    );
  }
  return hasText(name) ? `${name} [${suffix}]` : `brand-${suffix}`;
}

async function pollUntilCreated(transport, workspaceId, { attempts, intervalMs, sleep }) {
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
 * Finds the one adoptable same-title child in the parent's family, or `null` when
 * none exists. "Adoptable" means a `created`, project-empty sub-workspace.
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
 * @returns {Promise<object|null>} the sole adoptable family entry, or null.
 */
async function findAdoptableFamilyMatch(transport, parentWorkspaceId, title, log) {
  const family = await transport.listWorkspaceFamily(parentWorkspaceId);
  const items = familyItems(family);
  const matches = items.filter((w) => w?.title === title && w?.status === 'created');
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
 * ambiguous (no idempotency key). List the parent's family, match the exact
 * title, and adopt a `created`, project-empty subworkspace. No match → fail (the
 * create was attempted, so a missing entry is an error here, unlike the proactive
 * path where it just means "create one"). Multiple matches → fail with an alert,
 * never guess.
 */
async function adoptFromFamily(transport, parentWorkspaceId, title, log) {
  const adopted = await findAdoptableFamilyMatch(transport, parentWorkspaceId, title, log);
  if (!adopted) {
    throw new ErrorWithStatusCode(
      `Ambiguous subworkspace create for '${title}' and no family match to adopt`,
      502,
    );
  }
  return adopted;
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
) {
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
    await pollUntilCreated(transport, existing, poll);
    await transport.transferWorkspaceResources(existing, resourceAllocation(marketCount));
    await pollUntilCreated(transport, existing, poll);
    return existing;
  }

  if (!hasText(parentWorkspaceId)) {
    throw new ErrorWithStatusCode('Cannot create a subworkspace: organization has no parent workspace', 404);
  }

  const title = subworkspaceTitle(brand);
  // Idempotent create-or-adopt (issue #2718): a retry after a partial
  // provisioning failure must NOT spawn a duplicate same-title stub (titles embed
  // the brand-id suffix, so a retry collides on title). Check the parent family
  // for an existing `created`, empty same-title child FIRST and reuse it; only
  // create when none exists. Failed `not ready` zombies are filtered out by the
  // status check in findAdoptableFamilyMatch, so they are never reused and never
  // inflate the ambiguity 409.
  let created = await findAdoptableFamilyMatch(transport, parentWorkspaceId, title, log);
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
    } catch (e) {
      // 504 = our transport's timeout signal → ambiguous create, recover by
      // adoption. The transport timeout is a SerenityTransportError (status 504),
      // NOT an ErrorWithStatusCode — guard on that so a 504 from our own poll
      // helper (an ErrorWithStatusCode) re-throws instead of re-entering adoption.
      if (!(e instanceof ErrorWithStatusCode) && e?.status === 504) {
        created = await adoptFromFamily(transport, parentWorkspaceId, title, log);
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
      log?.error?.('ensureSubworkspace: concurrent activation won; releasing our orphaned workspace allocation', {
        keptWorkspaceId: concurrent,
        releasedWorkspaceId: workspaceId,
      });
      try {
        await transport.transferWorkspaceResources(workspaceId, RELEASE_ALLOCATION);
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
 * idempotent. NEVER deletes the workspace; it is emptied and de-resourced.
 * Self-defending: refuses if the target is the org parent OR still has active
 * linked (child) sub-workspaces. Steps:
 *   1. delete every project from the listing (404-as-success)
 *   2. release the ai allocation back to the parent pool
 *   3. (member removal is best-effort and currently deferred — parent admins
 *      inherit access regardless, workspace doc §7; enumerating members needs
 *      a listMembers transport method not added in this phase)
 *
 * This touches only the upstream workspace. Clearing the brand's
 * `semrush_sub_workspace_id` pointer (the disconnect) is the CALLER's job —
 * the deactivate handler does it after this resolves, leaving the
 * sub-workspace empty and unowned.
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

  const listing = await transport.listProjects(subworkspaceId);
  const projects = Array.isArray(listing?.items) ? listing.items : [];
  for (const project of projects) {
    const projectId = project?.id;
    if (!hasText(projectId)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await transport.deleteProject(subworkspaceId, projectId);
    } catch (e) {
      if (!isUpstreamGone(e)) {
        throw e;
      }
    }
  }
  // Release allocation back to the parent pool (payload Gate-A-pinned).
  await transport.transferWorkspaceResources(subworkspaceId, RELEASE_ALLOCATION);
  log?.info?.('decommissionBrandWorkspace: emptied and released', {
    subworkspaceId,
    deletedProjects: projects.length,
  });
}
