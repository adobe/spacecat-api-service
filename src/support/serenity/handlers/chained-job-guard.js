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

import { getBrandProvisioningState } from '../../brands-storage.js';

/**
 * Re-asserts, at the START of a chained job, that the brand it was enqueued for still exists and
 * is still bound to the workspace that job was handed.
 *
 * The provisioning worker enqueues the chain AFTER promoting its workspace to canonical, and the
 * chained handlers then act on Semrush — creating and publishing real projects. Between those two
 * moments a `deactivate` can land: it decommissions the workspace, clears the pointer and
 * tombstones the brand's mapping rows. Without this check the chained job then creates a live
 * project inside the workspace that was just decommissioned and writes a fresh mapping row for a
 * brand that no longer points anywhere — the "a late worker cannot recreate, repoint, or
 * reactivate" acceptance criterion, violated.
 *
 * A DELETE or an offboard is the same hazard reached a different way, and needs its own check:
 * both are soft writes that change `status` and leave the workspace pointer in place, so the
 * pointer comparison alone does not see them.
 *
 * The chained handlers cannot rely on the orchestration to catch this: they pass
 * `preResolvedWorkspaceId`, which makes `ensureSubworkspace` skip its own pointer read entirely.
 *
 * Deliberately compares against the CANONICAL pointer rather than the provisioning status: by the
 * time the chain runs, the attempt is legitimately no longer `pending` (it was promoted), so
 * status tells us nothing here. The pointer is the fact that matters — it is what deactivate
 * clears and what a re-provision replaces.
 *
 * @param {object} params
 * @param {string} params.brandId
 * @param {string} params.workspaceId - the workspace this job was enqueued against.
 * @param {object} params.postgrestClient
 * @param {object} [params.log]
 * @param {string} params.jobName - for the stand-down log.
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>} `ok: false` means stand down.
 */
export async function assertChainedJobStillApplies({
  brandId, workspaceId, postgrestClient, log, jobName,
}) {
  let state;
  try {
    state = await getBrandProvisioningState(brandId, postgrestClient);
  } catch (error) {
    // Fail OPEN on an unreadable state, deliberately. This guard exists to prevent acting on a
    // brand that demonstrably moved on; a transient read error is not that evidence, and failing
    // closed here would abandon legitimate market creation on a blip.
    log?.warn?.(`${jobName}: could not re-read brand state; proceeding`, {
      brandId, error: error?.message,
    });
    return { ok: true };
  }
  if (!state) {
    log?.info?.(`${jobName}: brand no longer exists; standing down without touching Semrush`, { brandId });
    return { ok: false, reason: 'brand-deleted' };
  }
  // A brand delete is a SOFT delete: `deleteBrand` writes `status = 'deleted'` and renames the
  // row, but deliberately leaves `semrush_sub_workspace_id` intact. So a deleted brand is still
  // returned by the state read AND still matches the pointer check below — checking only the
  // pointer would wave this job straight through and publish a live, billable Semrush project
  // for a brand the customer just deleted. Offboarding (`status = 'ignored'`) is the same shape.
  //
  // This mirrors the predicate `promoteProvisioningReady` already uses on its own write
  // (`status IN ('pending','active')`); the promotion path was protected and this one was not.
  if (state.status !== 'pending' && state.status !== 'active') {
    log?.info?.(`${jobName}: brand is no longer active or pending; standing down without touching Semrush`, {
      brandId, brandStatus: state.status,
    });
    return { ok: false, reason: 'brand-not-live' };
  }
  if (state.semrushSubWorkspaceId !== workspaceId) {
    log?.info?.(`${jobName}: brand is no longer bound to this workspace; standing down without touching Semrush`, {
      brandId,
      enqueuedWorkspaceId: workspaceId,
      currentWorkspaceId: state.semrushSubWorkspaceId ?? null,
    });
    return { ok: false, reason: 'workspace-repointed-or-cleared' };
  }
  return { ok: true };
}
