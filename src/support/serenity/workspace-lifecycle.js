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

// "Release everything back to the parent pool" payload. The EXACT shape is a
// Gate-A live-smoke contract pin (design §6/§11) — release-to-parent is
// unobservable on the limits-disabled dev parent until verified. Zeroing the
// ai allocation is the documented intent; adjust here once Gate-A pins it.
export const RELEASE_ALLOCATION = Object.freeze({ ai: { projects: 0, prompts: 0 } });

// Workspace create settles `not ready → created` in seconds (workspace doc §4).
// Bounded poll so a stuck create surfaces as a clean error rather than pinning
// the Lambda. Timing is injectable so unit tests run without real delays.
const DEFAULT_POLL_ATTEMPTS = 10;
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

/**
 * Ambiguous-create recovery (design §6): a timed-out createSubworkspace is
 * ambiguous (no idempotency key). List the parent's family, match the exact
 * title, and adopt a `created`, project-empty subworkspace. Multiple matches → fail
 * with an alert, never guess.
 */
async function adoptFromFamily(transport, parentWorkspaceId, title, log) {
  const family = await transport.listWorkspaceFamily(parentWorkspaceId);
  const items = Array.isArray(family?.items) ? family.items : [];
  const matches = items.filter((w) => w?.title === title);
  if (matches.length === 0) {
    throw new ErrorWithStatusCode(
      `Ambiguous subworkspace create for '${title}' and no family match to adopt`,
      502,
    );
  }
  if (matches.length > 1) {
    log?.error?.('ensureSubworkspace: ambiguous create — multiple family matches, refusing to guess', {
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
  log?.info?.('ensureSubworkspace: adopted subworkspace after ambiguous create', {
    parentWorkspaceId,
    title,
    adoptedId: matches[0]?.id,
  });
  return matches[0];
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
 * @returns {Promise<string>} the subworkspace id.
 */
export async function ensureSubworkspace(
  transport,
  brand,
  parentWorkspaceId,
  marketCount,
  log,
  timing = {},
) {
  const poll = {
    attempts: timing.attempts ?? DEFAULT_POLL_ATTEMPTS,
    intervalMs: timing.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    sleep: timing.sleep ?? defaultSleep,
  };

  const existing = brand.getSemrushWorkspaceId?.();
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

  const title = brand.getName?.();
  let created;
  try {
    created = await transport.createSubworkspace(
      parentWorkspaceId,
      title,
      resourceAllocation(marketCount),
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

  const workspaceId = String(created?.id || '');
  if (!hasText(workspaceId)) {
    throw new ErrorWithStatusCode('createSubworkspace returned no workspace id', 502);
  }
  // A create (or adoption) that handed back the parent id is a gateway bug;
  // never persist the parent as the brand's sub-workspace.
  assertNotParent(workspaceId, parentWorkspaceId);

  await pollUntilCreated(transport, workspaceId, poll);

  // Persist AFTER the workspace reads back `created` — flips the brand to subworkspace mode.
  brand.setSemrushWorkspaceId(workspaceId);
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
 * `semrush_workspace_id` pointer (the disconnect) is the CALLER's job — the
 * deactivate handler does it after this resolves, leaving the sub-workspace
 * empty and unowned.
 *
 * @param {object} transport
 * @param {string} subworkspaceId
 * @param {object} log
 * @param {string} [parentWorkspaceId] - when provided, a self-defending guard:
 *   refuse to empty/release the org's shared parent workspace even if a caller
 *   ever reaches here without the controller's authorize() guard.
 */
export async function decommissionBrandWorkspace(
  transport,
  subworkspaceId,
  log,
  parentWorkspaceId,
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
  // NOTE: the family endpoint is otherwise exercised only on the ORG parent; we
  // conservatively exclude the target's own id and treat any other returned
  // workspace as a blocking child (semantics not yet live-verified for a leaf).
  const family = await transport.listWorkspaceFamily(subworkspaceId);
  const children = (Array.isArray(family?.items) ? family.items : [])
    .filter((w) => hasText(w?.id) && w.id !== subworkspaceId);
  if (children.length > 0) {
    const err = new ErrorWithStatusCode(
      `Refusing to decommission ${subworkspaceId}: it has ${children.length} active linked sub-workspace(s)`,
      409,
    );
    err.code = ERROR_CODES.LINKED_SUBWORKSPACES;
    throw err;
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
