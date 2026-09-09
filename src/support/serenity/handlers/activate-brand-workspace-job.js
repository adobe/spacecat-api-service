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
 * Job type dispatched to {@link activateBrandWorkspaceJobHandler} by the runner
 * (`src/serenity-prompt-classification/index.js`). Phase 4 (LLMO-7352/LLMO-7418): the second
 * phase of `activate`'s two "skip"-mode branches' async flow (pending→active, and bare
 * reactivation of an already-active brand) — enqueued by `provision-workspace-job.js` as its
 * `chainedJobType` once the sub-workspace it depends on is confirmed `ready`, never enqueued
 * directly by an HTTP controller.
 */
export const ACTIVATE_BRAND_WORKSPACE_JOB_TYPE = 'serenity-activate-brand-workspace';

/**
 * Reports the brand's current status now that its sub-workspace is confirmed ready — READ-ONLY,
 * never writes.
 *
 * `promoteProvisioningReady` (the hop immediately before this chain is enqueued —
 * `provision-workspace-job.js`) already durably flips the brand to `active` as part of the SAME
 * atomic compare-and-set write that promotes `semrush_provisioning_status` to `ready`; the chain
 * is only ever enqueued once that write has succeeded. So by the time this job runs, the brand
 * is ALREADY `active` in the common case — this handler's own job is not to repeat that write
 * (an earlier version of this file did, via `brand.setStatus('active'); brand.save()`, which was
 * both redundant on success AND unguarded: a chained job can run minutes after its enqueue
 * (self-requeue backoff, plain SQS delivery latency), and blindly re-writing `active` with no
 * CAS/re-check would silently RESURRECT a brand a legitimate concurrent `/serenity/deactivate`
 * had already moved back to `pending` in the meantime — exactly the "active brand bound to a
 * workspace nobody meant it to have" failure class this whole epic exists to prevent, just
 * reached through a different door. Fixed in review before merge.)
 *
 * @param {object} context - worker context (`dataAccess`, `log`).
 * @param {object} job - the current `AsyncJob`. `job.getMetadata()` carries
 *   `{ brandId, wasPending? }` (the chain-enqueue's `chainedJobMetadata` — no `workspaceId` is
 *   needed here, unlike the market-creating chained jobs, since this job never talks to Semrush).
 * @returns {Promise<object>} `{ status: 200, body: {...} }` when the brand is (still) active —
 *   the common case; `{ status: 207, body: {...} }` reporting whatever the brand's CURRENT
 *   status actually is when it is no longer active (a legitimate concurrent deactivate raced
 *   ahead of this chain) — never a manufactured 502 "incomplete", since the sub-workspace itself
 *   provisioned successfully; only the brand's separate, later-changed active/pending state
 *   diverged from what this chain expected to find.
 */
export async function activateBrandWorkspaceJobHandler(context, job) {
  const { dataAccess, log } = context;
  const metadata = job.getMetadata() ?? {};
  const { brandId, wasPending = false } = metadata;

  const brand = await dataAccess.Brand.findById(brandId);
  const currentStatus = brand.getStatus?.();

  if (currentStatus === 'active') {
    return { status: 200, body: { brandId, status: 'active', markets: [] } };
  }

  log?.info?.('activate-brand-workspace-job: brand is no longer active by the time this chain ran; reporting its current state instead of overwriting it', {
    brandId, wasPending, currentStatus,
  });
  return { status: 207, body: { brandId, status: currentStatus, markets: [] } };
}
