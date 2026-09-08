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

import { createSerenityTransport } from '../rest-transport.js';
import { createAndEnqueueJob } from '../async-job-runner.js';
import {
  createOrAdoptSubworkspaceCandidate,
  emptyWorkspaceBestEffort,
  isWorkspaceReady,
  isWorkspaceTerminalFailure,
} from '../workspace-lifecycle.js';
import {
  getBrandProvisioningState,
  persistProvisioningCandidate,
  updateProvisioningJobId,
  promoteProvisioningReady,
  promoteProvisioningFailed,
} from '../../brands-storage.js';

/** @typedef {import('../rest-transport.js').SerenityTransport} SerenityTransport */

/**
 * Job type dispatched to {@link provisionWorkspaceHandler} by the runner
 * (`src/serenity-prompt-classification/index.js`). LLMO-7352/LLMO-7418: the async worker
 * behind the bare-create and both `/serenity/activate` `skip`-mode call sites.
 */
export const PROVISION_WORKSPACE_JOB_TYPE = 'serenity-provision-workspace';

/**
 * Hard cap on self-requeue depth. Live-verified settle time for a SUCCESSFUL create is
 * seconds, not minutes (LLMO-7352 incident data: ~10s); this ladder exists for the
 * unusual case, not the common one. After this many hops without a terminal status, the
 * attempt is failed outright rather than requeuing forever — a genuinely stuck upstream
 * workspace is exactly the "creation failed"-shaped problem this whole redesign exists to
 * surface promptly, not paper over with an ever-longer wait.
 */
export const MAX_PROVISION_REQUEUE_DEPTH = 5;

/**
 * Bounded exponential backoff for the `not ready` re-poll delay: 5s, 10s, 20s, 40s, 80s
 * across the 5 allowed hops (well under the SQS 900s per-message cap `createAndEnqueueJob`
 * itself clamps to). Conservative by design — the ticket's own acceptance criteria note
 * there isn't yet enough live "still pending" data to tune this empirically; this schedule
 * is a deliberate starting point to revisit once there is.
 * @param {number} requeueDepth - the depth this hop is ABOUT to requeue TO (i.e. the new
 *   job's depth), so hop 0->1 uses `2**0`.
 * @returns {number} delay in whole seconds.
 */
export function computeProvisioningBackoffSeconds(requeueDepth) {
  return 5 * (2 ** requeueDepth);
}

/**
 * Sanitized, id-free terminal-failure message — mirrors the message
 * `pollUntilCreated` throws for the synchronous callers (LLMO-7352 Phase 1), so a brand's
 * `semrush_provisioning_error` reads identically regardless of which path failed it.
 * Exported so tests can assert the exact message per failure path rather than a loose matcher.
 */
export const TERMINAL_FAILURE_MESSAGE = 'Semrush sub-workspace provisioning failed and cannot be '
  + 'recovered by waiting; it must be re-created';

export const REQUEUE_EXHAUSTED_MESSAGE = 'Semrush sub-workspace did not settle after repeated '
  + 'retries; it must be re-created';

// Adversarial-review finding (LLMO-7418): a message for the generic catch-all below must never
// echo raw upstream error text (a Semrush 5xx body, a Postgres error) into a customer-visible
// `semrush_provisioning_error` column — that redaction is this module's job, same as every other
// promoteProvisioningFailed call site here.
export const UNEXPECTED_ERROR_MESSAGE = 'Semrush sub-workspace provisioning failed due to an '
  + 'unexpected error; it must be re-created';

/**
 * Best-effort cleanup of a candidate this invocation itself FRESHLY created, once it turns
 * out we no longer own the attempt (a compare-and-set write lost the race). Never tears down
 * an ADOPTED candidate — an adopted workspace may belong to a same-named sibling brand's own
 * still-in-flight provisioning (see `createOrAdoptSubworkspaceCandidate`'s own doc).
 * @param {SerenityTransport} transport
 * @param {{workspaceId: string, freshlyCreated: boolean}} candidate
 * @param {string} parentWorkspaceId
 * @param {object} log
 * @param {string} phase
 */
async function cleanupIfOwned(transport, candidate, parentWorkspaceId, log, phase) {
  if (candidate?.freshlyCreated) {
    await emptyWorkspaceBestEffort(transport, candidate.workspaceId, parentWorkspaceId, log, phase);
  }
}

/**
 * Best-effort terminal-failure promotion for the generic catch-all below: never lets a
 * secondary failure here (the CAS itself erroring, or already being superseded) mask the
 * ORIGINAL exception the caller is about to re-throw — mirrors `emptyWorkspaceBestEffort`'s
 * own swallow-and-log contract.
 * @param {object} params
 * @param {string} params.brandId
 * @param {string} params.attemptId
 * @param {object} params.postgrestClient
 * @param {object} log
 */
async function failBestEffort({
  brandId, attemptId, postgrestClient,
}, log) {
  try {
    await promoteProvisioningFailed({
      brandId, attemptId, error: UNEXPECTED_ERROR_MESSAGE, postgrestClient,
    });
  } catch (failError) {
    log?.error?.('provision-workspace-job: failed to record unexpected-error failure state', {
      brandId, attemptId, error: failError?.message,
    });
  }
}

/**
 * Async Semrush sub-workspace provisioning worker (LLMO-7352/LLMO-7418). One invocation does
 * AT MOST one create-or-adopt call and one status poll — it never loops or sleeps in-Lambda;
 * a `not ready` result self-requeues a brand-new job with a delayed `DelaySeconds` instead
 * (see {@link computeProvisioningBackoffSeconds}), and every terminal write is an
 * attempt-id-scoped compare-and-set so a stale/superseded attempt (a newer retry, or a late
 * at-least-once SQS redelivery racing a subsequent hop) can never clobber a newer winner.
 *
 * Candidate provenance (`freshlyCreated`) is threaded through the SELF-REQUEUE METADATA, not
 * re-derived from the DB on each hop (adversarial-review finding, LLMO-7418): the DB's candidate
 * column only ever records an id, never who created it, and by the time a later hop discovers
 * it has been superseded, the DB row may already belong to a DIFFERENT, newer attempt — so the
 * only reliable record of "did THIS attempt's chain create this workspace" is the metadata this
 * same chain has been carrying forward since the hop that resolved it.
 *
 * @param {object} context - worker context (`dataAccess`, `sqs`, `env`, `log`).
 * @param {object} job - the current `AsyncJob` being processed. `job.getMetadata()` carries
 *   `{ brandId, attemptId, parentWorkspaceId, title, requeueDepth?, candidateWorkspaceId?,
 *   freshlyCreated? }` plus the promise token.
 * @param {string} accessToken - already-exchanged Semrush access token (the runner's `run()`
 *   exchanges this before dispatch, per the spec's binding ordering rule).
 * @returns {Promise<object>} a small result object; `{ requeuedJobId }` when this hop
 *   self-requeued (the runner's dispatch loop keeps the promise token alive for that case),
 *   otherwise `{ provisioningStatus: 'ready'|'failed'|'superseded' }`.
 * @throws on any unexpected error, AFTER best-effort recording `semrush_provisioning_status:
 *   'failed'` on the brand row — so the row can no longer be stranded at `pending` forever with
 *   no further job ever revisiting it (the outer runner still marks the AsyncJob FAILED and
 *   does not redeliver, unchanged from every other handler's contract).
 */
export async function provisionWorkspaceHandler(context, job, accessToken) {
  const { dataAccess, env, log } = context;
  const { postgrestClient } = dataAccess.services;
  const metadata = job.getMetadata() ?? {};
  const {
    brandId, attemptId, parentWorkspaceId, title, requeueDepth = 0,
  } = metadata;

  /** @type {{workspaceId: string, freshlyCreated: boolean}|undefined} */
  let candidate;
  // Carried forward from a prior hop's metadata, if any — see the function doc for why this
  // (not the DB) is the source of truth for cleanup ownership once superseded.
  if (metadata.candidateWorkspaceId) {
    candidate = {
      workspaceId: metadata.candidateWorkspaceId,
      freshlyCreated: Boolean(metadata.freshlyCreated),
    };
  }

  try {
    // Re-check FIRST, before any Semrush call: a newer attempt (a retry) or a terminal write
    // from a raced-ahead hop may have already superseded this one. Stand down as a clean no-op
    // rather than doing pointless — or actively harmful — Semrush work for an attempt nothing
    // is waiting on anymore.
    const state = await getBrandProvisioningState(brandId, postgrestClient);
    if (!state || state.provisioningAttemptId !== attemptId || state.provisioningStatus !== 'pending') {
      log?.info?.('provision-workspace-job: attempt no longer current; standing down', {
        brandId,
        attemptId,
        currentAttemptId: state?.provisioningAttemptId,
        currentStatus: state?.provisioningStatus,
      });
      // A prior hop of THIS chain may already have created/persisted a candidate before losing
      // the race — the DB row now reflects the WINNING attempt, not ours, so `candidate` here
      // (from OUR OWN metadata) is the only place that ownership is still recorded.
      if (candidate) {
        const transport = createSerenityTransport({ env, imsToken: accessToken });
        await cleanupIfOwned(transport, candidate, parentWorkspaceId, log, 'provision-worker-superseded-stand-down');
      }
      return { provisioningStatus: 'superseded' };
    }

    const transport = createSerenityTransport({ env, imsToken: accessToken });

    if (!candidate) {
      const claim = { brandCollection: dataAccess.Brand, selfBrandId: brandId };
      candidate = await createOrAdoptSubworkspaceCandidate(
        transport,
        parentWorkspaceId,
        title,
        log,
        claim,
      );
      const persisted = await persistProvisioningCandidate({
        brandId, attemptId, candidateWorkspaceId: candidate.workspaceId, postgrestClient,
      });
      if (!persisted) {
        // Superseded (or a concurrent redelivery of this SAME hop already persisted its own
        // candidate first — persistProvisioningCandidate's CAS also requires the candidate
        // column to still be NULL, so at most one of two racing deliveries ever lands here with
        // `persisted: true`). Clean up only if we own it — an adopted workspace is never ours.
        await cleanupIfOwned(transport, candidate, parentWorkspaceId, log, 'provision-worker-superseded-pre-poll');
        return { provisioningStatus: 'superseded' };
      }
    }

    const statusResult = await transport.getWorkspaceStatus(candidate.workspaceId);
    const status = statusResult?.status;

    if (isWorkspaceReady(status)) {
      let promoted;
      try {
        promoted = await promoteProvisioningReady({
          brandId,
          attemptId,
          workspaceId: candidate.workspaceId,
          postgrestClient,
          updatedBy: 'serenity-provision-worker',
        });
      } catch (error) {
        if (error?.code === 'semrush_workspace_id_conflict') {
          // Two different attempts raced to the SAME candidate workspace id (e.g. a family
          // adoption both hops resolved to independently). The other write already won the
          // UNIQUE constraint, so ours is a genuine live duplicate — not a stale attempt this
          // brand no longer needs — and must be emptied if we own it, exactly like the CAS-loss
          // branch below, just reached via a different failure shape (DB constraint, not CAS).
          await cleanupIfOwned(transport, candidate, parentWorkspaceId, log, 'provision-worker-workspace-id-conflict');
          log?.warn?.('provision-workspace-job: workspace id already claimed by another attempt', {
            brandId, attemptId, semrushWorkspaceId: candidate.workspaceId,
          });
          return { provisioningStatus: 'superseded' };
        }
        throw error;
      }
      if (!promoted) {
        // A newer attempt won the race between our poll and this write. The workspace we just
        // confirmed ready is real and usable — but it is THIS attempt's, and this attempt no
        // longer owns the brand, so it must not be adopted into service via a side door. Only
        // clean it up if we created it fresh; an adopted one belongs to someone else already.
        log?.info?.('provision-workspace-job: attempt superseded between poll and ready-promotion', {
          brandId, attemptId, semrushWorkspaceId: candidate.workspaceId,
        });
        await cleanupIfOwned(transport, candidate, parentWorkspaceId, log, 'provision-worker-cas-lost-ready');
        return { provisioningStatus: 'superseded' };
      }
      log?.info?.('provision-workspace-job: promoted to ready', {
        brandId, attemptId, semrushWorkspaceId: candidate.workspaceId,
      });
      return { provisioningStatus: 'ready' };
    }

    if (isWorkspaceTerminalFailure(status)) {
      // A terminally-failed shell cannot be deleted (Semrush-side restriction) — no cleanup
      // call here regardless of freshlyCreated; the pointer is simply never promoted to it.
      await promoteProvisioningFailed({
        brandId, attemptId, error: TERMINAL_FAILURE_MESSAGE, postgrestClient,
      });
      log?.error?.('provision-workspace-job: sub-workspace settled to a terminal failure status', {
        brandId, attemptId, semrushWorkspaceId: candidate.workspaceId, status,
      });
      return { provisioningStatus: 'failed' };
    }

    // Still settling (`not ready`, or an unrecognized status — treated the same: keep waiting,
    // bounded). Self-requeue a brand-new job carrying the SAME candidate id (AND its provenance)
    // forward, with bounded exponential backoff, rather than looping/sleeping in this invocation.
    if (requeueDepth >= MAX_PROVISION_REQUEUE_DEPTH) {
      await promoteProvisioningFailed({
        brandId, attemptId, error: REQUEUE_EXHAUSTED_MESSAGE, postgrestClient,
      });
      log?.error?.('provision-workspace-job: requeue depth exhausted; failing the attempt', {
        brandId, attemptId, semrushWorkspaceId: candidate.workspaceId, requeueDepth,
      });
      return { provisioningStatus: 'failed' };
    }

    const nextDepth = requeueDepth + 1;
    const nextDelaySeconds = computeProvisioningBackoffSeconds(nextDepth - 1);
    const newJob = await createAndEnqueueJob(context, {
      jobType: PROVISION_WORKSPACE_JOB_TYPE,
      // Forward the CURRENT job's already-exchanged promise token explicitly — this worker has
      // no HTTP request context, so createAndEnqueueJob cannot mint a fresh one itself.
      promiseToken: metadata.promiseToken,
      promisePair: metadata.promisePair,
      metadata: {
        brandId,
        attemptId,
        parentWorkspaceId,
        title,
        requeueDepth: nextDepth,
        candidateWorkspaceId: candidate.workspaceId,
        freshlyCreated: candidate.freshlyCreated,
      },
      delaySeconds: nextDelaySeconds,
    });

    log?.info?.('provision-workspace-job: not ready; self-requeued with backoff', {
      brandId,
      attemptId,
      semrushWorkspaceId: candidate.workspaceId,
      requeueDepth: nextDepth,
      delaySeconds: nextDelaySeconds,
      requeuedJobId: newJob.getId(),
    });

    // Best-effort: keep brands.semrush_provisioning_job_id pointing at the CURRENT hop's job so
    // a reader (reconciliation, a status endpoint) never follows a stale, already-COMPLETED job
    // id. A rejected CAS here (attempt superseded in the tiny window since our earlier read)
    // is not itself an error — the new job's OWN next invocation re-checks currency and stands
    // down cleanly if so; this write is a freshness optimization, not a safety mechanism.
    await updateProvisioningJobId({
      brandId, attemptId, jobId: newJob.getId(), postgrestClient,
    });

    return { requeuedJobId: newJob.getId() };
  } catch (error) {
    // Anything NOT already handled above (a transport network error, a Postgres read/write
    // failure, an unexpected ErrorWithStatusCode from create-or-adopt, ...) lands here.
    // Adversarial-review finding (LLMO-7418): without this, the brand row is left at
    // `semrush_provisioning_status: 'pending'` forever — nothing else in this codebase ever
    // revisits it — which is exactly the "silently, permanently broken" failure mode this whole
    // redesign exists to eliminate. Record failure best-effort, then re-throw the ORIGINAL error
    // unchanged so the outer runner's existing FAILED-job handling is unaffected.
    await failBestEffort({ brandId, attemptId, postgrestClient }, log);
    throw error;
  }
}
