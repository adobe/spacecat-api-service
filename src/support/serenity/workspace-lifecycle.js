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
 *   - column set        → re-grant an allocation onto the kept workspace
 *                         (handles the decommissioned case; a no-op-ish
 *                         re-grant on an already-resourced ws — the transfer
 *                         contract is Gate-A-pinned).
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
    // Re-grant the allocation onto the kept (possibly decommissioned) workspace.
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
    // 504 = our transport's timeout signal → ambiguous create, recover by adoption.
    if (e instanceof ErrorWithStatusCode === false && e?.status === 504) {
      created = await adoptFromFamily(transport, parentWorkspaceId, title, log);
    } else {
      throw e;
    }
  }

  const workspaceId = String(created?.id || '');
  if (!hasText(workspaceId)) {
    throw new ErrorWithStatusCode('createSubworkspace returned no workspace id', 502);
  }

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
 * Decommissions a brand's subworkspace (design §6) — convergent and
 * idempotent. NEVER deletes the workspace; it is emptied and de-resourced and
 * the `semrush_workspace_id` pointer is kept for reuse:
 *   1. delete every project from the listing (404-as-success)
 *   2. release the ai allocation back to the parent pool
 *   3. (member removal is best-effort and currently deferred — parent admins
 *      inherit access regardless, workspace doc §7; enumerating members needs
 *      a listMembers transport method not added in this phase)
 *
 * @param {object} transport
 * @param {string} subworkspaceId
 * @param {object} log
 */
export async function decommissionBrandWorkspace(transport, subworkspaceId, log) {
  if (!hasText(subworkspaceId)) {
    return;
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
