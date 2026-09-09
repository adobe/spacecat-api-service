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
 * directly by an HTTP controller. Unlike `serenity-create-market`/`serenity-activate-markets`,
 * this job creates no Semrush project — its only job is the brand's own status flip, the one
 * piece of business logic the generic provisioning worker doesn't do.
 */
export const ACTIVATE_BRAND_WORKSPACE_JOB_TYPE = 'serenity-activate-brand-workspace';

/**
 * Flips (or re-affirms) the brand's status to `active` now that its sub-workspace is confirmed
 * ready — the deferred half of what the synchronous `wasPending`/bare-reactivation branches in
 * `serenity.js` do inline. Shared by both call sites: `wasPending` (a real pending→active
 * transition) is distinguished from bare reactivation (already active, a no-op re-affirm) only
 * by `wasPending` in this job's own metadata, so the result body mirrors each sync branch's own
 * response shape exactly (a save failure is a retryable 502 for a real transition, but only a
 * 207 for a reactivation that was already active regardless).
 *
 * @param {object} context - worker context (`dataAccess`, `log`).
 * @param {object} job - the current `AsyncJob`. `job.getMetadata()` carries
 *   `{ brandId, wasPending? }` (the chain-enqueue's `chainedJobMetadata` — no `workspaceId` is
 *   needed here, unlike the market-creating chained jobs, since this job never talks to Semrush).
 * @returns {Promise<object>} the same `{ status, body }` shape the synchronous branches
 *   themselves return — surfaced verbatim as this AsyncJob's `result`.
 */
export async function activateBrandWorkspaceJobHandler(context, job) {
  const { dataAccess, log } = context;
  const metadata = job.getMetadata() ?? {};
  const { brandId, wasPending = false } = metadata;

  const brand = await dataAccess.Brand.findById(brandId);
  let succeeded = true;
  if (typeof brand.setStatus === 'function') {
    brand.setStatus('active');
  }
  try {
    await brand.save();
  } catch (saveError) {
    succeeded = false;
    log?.error?.('serenity activate (async): SERENITY_ACTIVATE_SAVE_DIVERGENCE — sub-workspace ensured, but failed to persist active status', {
      brandId, wasPending, error: saveError?.message,
    });
  }

  if (succeeded) {
    return { status: 200, body: { brandId, status: 'active', markets: [] } };
  }
  // Mirrors the sync branches' own divergence handling: a genuine pending→active transition
  // that failed to persist stays pending (retryable, 502); an already-active brand's no-op
  // re-affirm failing is not a real regression (207, still `active`).
  return wasPending
    ? {
      status: 502,
      body: {
        brandId,
        status: 'pending',
        error: 'serenityActivationIncomplete',
        message: 'Sub-workspace provisioned but the active status could not be persisted.',
        markets: [],
      },
    }
    : { status: 207, body: { brandId, status: 'active', markets: [] } };
}
