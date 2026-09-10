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

// LLMO-7418 external-review Finding 14: retry classification for a status-poll failure.
// `SerenityTransportError` always carries a numeric `.status` (the upstream HTTP status);
// a raw network-level failure (fetch itself throwing — DNS, connection reset, timeout) has
// none. Only these are treated as transient and routed through the existing bounded
// self-requeue ladder below; everything else (a permanent 4xx like an expired/invalid IMS
// token, or an unexpected non-transport error) keeps today's fail-fast behavior via the
// outer catch.
const RETRYABLE_TRANSPORT_STATUSES = new Set([429, 500, 502, 503, 504]);
function isRetryableWorkspaceStatusError(error) {
  const { status } = error ?? {};
  if (typeof status !== 'number') {
    // No upstream status at all — a network-level failure, not an application error.
    return true;
  }
  return RETRYABLE_TRANSPORT_STATUSES.has(status);
}

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

// LLMO-7418 external-review Finding 12: bounded retry for the chained-job enqueue below — one
// transient SQS blip must not permanently strand an otherwise-successful attempt (brand active
// and ready, but no market and nothing left to ever retry it). 3 attempts total, short backoff;
// this is fire-and-forget-adjacent (awaited inline, but genuinely brief) so a couple of quick
// retries covers the common transient case without meaningfully extending this hop's runtime.
export const CHAINED_JOB_ENQUEUE_ATTEMPTS = 3;
const CHAINED_JOB_ENQUEUE_RETRY_DELAYS_MS = [250, 750];
const defaultSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Enqueues the follow-up job named in `metadata.chainedJobType` (PR-C, LLMO-7352/LLMO-7418) once
 * the sub-workspace this attempt was provisioning is confirmed `ready` — e.g. the
 * `serenity-create-market` job that runs {@link orchestrateCreateMarketSubworkspace} against the
 * now-ready workspace. Absent `chainedJobType`, this is a no-op (the bare-workspace-only callers
 * never set it).
 *
 * Retries a bounded number of times (LLMO-7418 external-review Finding 12) before giving up —
 * still swallows the failure after that, rather than letting it propagate: the workspace IS
 * genuinely ready and already durably promoted by the time this runs, so a failure here must
 * NEVER be mistaken for a provisioning failure (the outer catch's best-effort `failed` write
 * would incorrectly try to un-ready a brand that is, in fact, fine) — it only means the
 * follow-up work never got scheduled. Logged at `error` so it is not silently lost.
 *
 * @param {object} context
 * @param {object} metadata - the CURRENT job's metadata (`chainedJobType`/`chainedJobMetadata`).
 * @param {string} workspaceId - the just-confirmed-ready workspace id, merged into the chained
 *   job's own metadata under the same key the async worker itself uses.
 * @param {object} log
 * @param {(ms: number) => Promise<void>} [sleep] - injectable delay (tests pass a no-op).
 * @returns {Promise<string|null>} the chained job's id, or null if none was configured or every
 *   enqueue attempt failed.
 */
async function enqueueChainedJobIfConfigured(
  context,
  metadata,
  workspaceId,
  log,
  sleep = defaultSleep,
) {
  if (!metadata.chainedJobType) {
    return null;
  }
  let lastError;
  for (let attempt = 0; attempt < CHAINED_JOB_ENQUEUE_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const chainedJob = await createAndEnqueueJob(context, {
        jobType: metadata.chainedJobType,
        // Forward the SAME token this attempt already exchanged — the chained job has no HTTP
        // context to mint its own, identical to every other self-requeue in this file.
        promiseToken: metadata.promiseToken,
        promisePair: metadata.promisePair,
        metadata: { ...metadata.chainedJobMetadata, workspaceId },
      });
      log?.info?.('provision-workspace-job: chained job enqueued after ready promotion', {
        chainedJobType: metadata.chainedJobType,
        chainedJobId: chainedJob.getId(),
        workspaceId,
        attempt,
      });
      return chainedJob.getId();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === CHAINED_JOB_ENQUEUE_ATTEMPTS - 1;
      log?.warn?.('provision-workspace-job: chained job enqueue attempt failed', {
        chainedJobType: metadata.chainedJobType,
        workspaceId,
        attempt,
        error: error?.message,
        willRetry: !isLastAttempt,
      });
      if (!isLastAttempt) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(CHAINED_JOB_ENQUEUE_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  log?.error?.(
    'provision-workspace-job: failed to enqueue the chained job after all retries; workspace '
    + 'IS ready, but no follow-up job was scheduled',
    {
      chainedJobType: metadata.chainedJobType,
      workspaceId,
      attempts: CHAINED_JOB_ENQUEUE_ATTEMPTS,
      error: lastError?.message,
    },
  );
  // LLMO-7418 external-review Finding 12: a configured chain that could NOT be enqueued is a
  // real failure of the operation the caller requested (a market / activation), NOT the plain
  // bare-workspace success that `return null` would signal. Returning null here made the handler
  // answer `{ provisioningStatus: 'ready' }`, the runner mark the job COMPLETED, and the client
  // poll back a green success while no market was ever created and nothing would retry it. Throw
  // instead so the job goes FAILED and the caller learns the chained work did not run. The
  // workspace promotion is already durable (the brand stays ready/active — failBestEffort's CAS
  // no longer matches a non-pending row), and the caller can safely re-issue the request.
  /** @type {Error & { code?: string }} */
  const err = new Error('chained provisioning job could not be enqueued after retries');
  err.code = 'chained_job_enqueue_failed';
  throw err;
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
 * AT MOST one create-or-adopt-or-existing-pointer call and one status poll — it never loops or
 * sleeps in-Lambda; a `not ready` result self-requeues a brand-new job with a delayed
 * `DelaySeconds` instead (see {@link computeProvisioningBackoffSeconds}), and every terminal
 * write is an attempt-id-scoped compare-and-set so a stale/superseded attempt (a newer retry, or
 * a late at-least-once SQS redelivery racing a subsequent hop) can never clobber a newer winner.
 *
 * Existing-pointer fast path (PR-C): when the brand ALREADY has a canonical
 * `semrush_sub_workspace_id` (e.g. an already-active brand starting an Add-Market attempt), that
 * pointer is polled directly instead of create-or-adopting a second workspace — mirrors
 * `ensureSubworkspace`'s own existing-pointer branch, just non-blocking (one status read per hop,
 * not `pollUntilCreated`'s in-Lambda loop). A pointer that has since gone terminally `failed` is
 * detected the same way a fresh create's failure is (see the terminal-failure branch below); the
 * canonical pointer itself is left untouched on failure — quarantining/clearing a dead pointer is
 * the reconciliation sweep's job (LLMO-7418 AC), not this worker's, consistent with Phase 1's
 * synchronous `pollUntilCreated` behavior for the same case.
 *
 * Candidate provenance (`freshlyCreated`) is threaded through the SELF-REQUEUE METADATA, not
 * re-derived from the DB on each hop (adversarial-review finding, LLMO-7418): the DB's candidate
 * column only ever records an id, never who created it, and by the time a later hop discovers
 * it has been superseded, the DB row may already belong to a DIFFERENT, newer attempt — so the
 * only reliable record of "did THIS attempt's chain create this workspace" is the metadata this
 * same chain has been carrying forward since the hop that resolved it.
 *
 * `chainedJobType`/`chainedJobMetadata` (PR-C, LLMO-7352/LLMO-7418): a caller that needs MORE
 * than a bare sub-workspace (e.g. a market-creating endpoint) sets these on the FIRST hop's
 * metadata; once `ready` is confirmed, this handler enqueues that job type with the resolved
 * `workspaceId` merged into `chainedJobMetadata`, and returns its id as `chainedJobId` so the
 * outer runner keeps the promise token alive for it (same mechanism as `requeuedJobId`). Absent
 * entirely, behavior is unchanged from the bare-workspace-only contract.
 *
 * @param {object} context - worker context (`dataAccess`, `sqs`, `env`, `log`).
 * @param {object} job - the current `AsyncJob` being processed. `job.getMetadata()` carries
 *   `{ brandId, attemptId, parentWorkspaceId, title, requeueDepth?, candidateWorkspaceId?,
 *   freshlyCreated?, chainedJobType?, chainedJobMetadata? }` plus the promise token.
 * @param {string} accessToken - already-exchanged Semrush access token (the runner's `run()`
 *   exchanges this before dispatch, per the spec's binding ordering rule).
 * @returns {Promise<object>} a small result object; `{ requeuedJobId }` when this hop
 *   self-requeued (the runner's dispatch loop keeps the promise token alive for that case),
 *   otherwise `{ provisioningStatus: 'ready', chainedJobId? }` (chainedJobId present only when a
 *   chain was configured AND enqueued successfully) or
 *   `{ provisioningStatus: 'failed'|'superseded' }`.
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
  // LLMO-7418 external-review Finding 16: set the instant the self-requeue's own
  // createAndEnqueueJob call succeeds — a FUTURE hop now owns `candidate` and will poll/use it,
  // so the outer catch below must NOT clean it up even if something AFTER the enqueue (e.g.
  // updateProvisioningJobId) throws. Stays false for every other failure path, where nothing
  // else will ever revisit this candidate.
  let requeueEnqueued = false;
  // Set by the one inner catch (promoteProvisioningReady's own, on a non-conflict failure) that
  // already cleans up `candidate` before rethrowing — avoids a harmless but noisy double
  // cleanupIfOwned call from the outer catch below for that specific path.
  let candidateAlreadyCleanedUp = false;
  // Set once promoteProvisioningReady succeeds: `candidate` is now the brand's CANONICAL, live
  // workspace, not an orphan. If the chained-job enqueue then throws (Finding 12), the outer
  // catch must NOT clean it up — emptying the canonical workspace would delete live data.
  let candidatePromoted = false;

  // Declared above the try (LLMO-7418 external-review Finding 5) so the catch below can reach it
  // for cleanupIfOwned — but ASSIGNED inside the try (external-review Finding N3): its
  // construction runs normalizeBaseUrl, which throws ErrorWithStatusCode(503) on a missing or
  // malformed SEMRUSH_PROJECTS_BASE_URL. Building it before the try let that 503 escape
  // failBestEffort and strand the brand at `pending` forever — the exact failure mode this
  // handler's outer catch exists to prevent. `candidate` is still undefined at this point, so a
  // construction failure records `failed` and re-throws without any cleanup to do. `transport`
  // can therefore be undefined in the catch below, where its only use (cleanupIfOwned) is
  // guarded on it explicitly.
  let transport;

  try {
    transport = createSerenityTransport({ env, imsToken: accessToken });
    // Re-check FIRST, before any Semrush call: a newer attempt (a retry) or a terminal write
    // from a raced-ahead hop may have already superseded this one. Stand down as a clean no-op
    // rather than doing pointless — or actively harmful — Semrush work for an attempt nothing
    // is waiting on anymore.
    const state = await getBrandProvisioningState(brandId, postgrestClient);
    // LLMO-7418 external-review Blocker 2: a DIFFERENT attempt now owning the brand (or the
    // brand no longer existing) is a genuine supersession — our OWN candidate, if any, is a
    // stale leftover nothing needs, so clean it up if we own it.
    if (!state || state.provisioningAttemptId !== attemptId) {
      log?.info?.('provision-workspace-job: attempt no longer current (a different attempt owns the brand); standing down', {
        brandId,
        attemptId,
        currentAttemptId: state?.provisioningAttemptId,
        currentStatus: state?.provisioningStatus,
      });
      // A prior hop of THIS chain may already have created/persisted a candidate before losing
      // the race — the DB row now reflects the WINNING attempt, not ours, so `candidate` here
      // (from OUR OWN metadata) is the only place that ownership is still recorded.
      if (candidate) {
        await cleanupIfOwned(transport, candidate, parentWorkspaceId, log, 'provision-worker-superseded-stand-down');
      }
      return { provisioningStatus: 'superseded' };
    }
    // Our OWN attempt already reached a terminal state (`ready` or `failed`) — this is NOT a
    // supersession, it is an at-least-once SQS redelivery of a message whose EARLIER delivery
    // already finished this exact job (a duplicate concurrent delivery, or one that arrived
    // after the visibility timeout expired mid-processing). `candidate` here can be the
    // brand's now-CANONICAL, LIVE workspace — including a real market project a chained job
    // may have already created in it — so cleaning it up would delete live customer data, not
    // an orphan. Stand down as a true no-op: never call cleanupIfOwned on this path.
    if (state.provisioningStatus !== 'pending') {
      log?.info?.('provision-workspace-job: this attempt already reached a terminal state (redelivery); standing down without cleanup', {
        brandId,
        attemptId,
        currentStatus: state.provisioningStatus,
      });
      return { provisioningStatus: 'superseded' };
    }

    if (!candidate) {
      // Existing-pointer fast path (PR-C, LLMO-7352/LLMO-7418): mirrors `ensureSubworkspace`'s
      // own existing-pointer branch (workspace-lifecycle.js). A converted caller like
      // `/serenity/markets` runs on a brand that is ALREADY active and (almost always) already
      // has a canonical, healthy workspace — create-or-adopting here would provision a SECOND
      // workspace for a brand that doesn't need one, exactly the kind of duplicate this whole
      // redesign exists to prevent. When the canonical pointer is already set, poll it directly
      // (one status read per hop, same bounded self-requeue as the create-or-adopt path below —
      // never `pollUntilCreated`'s blocking loop, which would sleep in-Lambda) instead of
      // create-or-adopting a new candidate. `freshlyCreated: false` — this worker did not create
      // it, so it must never be torn down as an orphan on a lost race below.
      if (hasText(state.semrushSubWorkspaceId)) {
        candidate = { workspaceId: state.semrushSubWorkspaceId, freshlyCreated: false };
      } else {
        // LLMO-7418 external-review Finding 4: every known caller now supplies `title` at
        // enqueue time, but this is the worker's own last line of defense — a future HTTP call
        // site that forgets it (exactly the bug this finding found, in 2 of the 4 `activate`
        // async branches) must fail loudly here rather than silently asking Semrush to create an
        // UNTITLED sub-workspace, which can never be found again by title-based adoption.
        if (!hasText(title)) {
          throw new Error(`provision-workspace-job: metadata.title is required to create a sub-workspace (brandId=${brandId})`);
        }
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
    }

    let statusResult;
    try {
      statusResult = await transport.getWorkspaceStatus(candidate.workspaceId);
    } catch (error) {
      if (!isRetryableWorkspaceStatusError(error)) {
        throw error;
      }
      // Transient upstream/network failure — leave `statusResult` undefined so `status`
      // below is `undefined`, which is neither ready nor terminal-failure, and this hop
      // falls straight into the existing "still settling" self-requeue branch below (same
      // bounded backoff/depth cap already used for an actual `not ready` poll result).
      log?.warn?.('provision-workspace-job: transient error polling workspace status; treating as not-ready and self-requeuing', {
        brandId,
        attemptId,
        semrushWorkspaceId: candidate.workspaceId,
        error: error?.message,
        status: error?.status,
      });
    }
    const status = statusResult?.status;

    if (isWorkspaceReady(status)) {
      let promoted;
      try {
        promoted = await promoteProvisioningReady({
          brandId,
          attemptId,
          workspaceId: candidate.workspaceId,
          // LLMO-7418 external-review Finding 5: `state` was already read (and re-validated as
          // current) at the top of this hop — reuse it rather than a second read. See
          // promoteProvisioningReady's own doc for why this must gate the `status: 'active'`
          // write.
          hasSiteAnchor: hasText(state.siteId),
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
        // Any OTHER promotion failure (LLMO-7418 external-review Finding 5 — most notably a
        // chk_active_brand_has_site_id 23514, though `hasSiteAnchor` above should make that
        // unreachable now; kept generic for any other unexpected write failure too) means this
        // candidate was CONFIRMED ready upstream but never became the canonical pointer — clean
        // it up here (if we own it) before the generic outer catch records the attempt failed,
        // rather than leaking it. Distinct from the requeue path below, which must NOT clean up
        // the candidate it is deliberately carrying forward to the next hop.
        await cleanupIfOwned(transport, candidate, parentWorkspaceId, log, 'provision-worker-ready-promotion-failed');
        candidateAlreadyCleanedUp = true;
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
      // From here the candidate is the canonical workspace — never an orphan to clean up.
      candidatePromoted = true;
      const chainedJobId = await enqueueChainedJobIfConfigured(
        context,
        metadata,
        candidate.workspaceId,
        log,
      );
      // Omit chainedJobId entirely when no chain was configured — preserves the exact
      // `{ provisioningStatus: 'ready' }` shape for the bare-workspace-only callers that never
      // set `chainedJobType` (activate's skip-mode branches).
      return chainedJobId
        ? { provisioningStatus: 'ready', chainedJobId }
        : { provisioningStatus: 'ready' };
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
      // LLMO-7418 external-review Finding 16: no further hop will ever revisit this candidate
      // once the attempt is failed here — clean it up if we own it. The shell is still "not
      // ready" upstream (nothing has published a project into it yet in the common case), so
      // this is normally a no-op, but it closes the gap for the rarer case where a project
      // exists despite the not-ready status.
      await cleanupIfOwned(transport, candidate, parentWorkspaceId, log, 'provision-worker-requeue-exhausted');
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
        // Threaded forward so a chain configured on hop 0 survives every backoff hop —
        // otherwise a market-creating conversion endpoint's attempt would silently degrade
        // into a workspace-only one the moment it needed even a single requeue.
        ...(metadata.chainedJobType ? {
          chainedJobType: metadata.chainedJobType,
          chainedJobMetadata: metadata.chainedJobMetadata,
        } : {}),
      },
      delaySeconds: nextDelaySeconds,
    });
    // LLMO-7418 external-review Finding 16: the self-requeue succeeded — a future hop now owns
    // `candidate` (forwarded in its metadata above) and will poll/use it, so the outer catch
    // must not clean it up even if the freshness-optimization write just below throws.
    requeueEnqueued = true;

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
    //
    // LLMO-7418 external-review Finding N9: this write MUST NOT reach the outer catch. The
    // self-requeue has already succeeded and a future hop now owns the candidate; letting a
    // transient failure here fall through would (a) mark the still-live attempt `failed` via
    // failBestEffort and (b) throw, which invalidates the promise token the requeued hop needs
    // to run — killing a healthy attempt and orphaning its workspace. Swallow it locally,
    // consistent with this write's own "optimization, not safety mechanism" contract.
    try {
      await updateProvisioningJobId({
        brandId, attemptId, jobId: newJob.getId(), postgrestClient,
      });
    } catch (jobIdWriteError) {
      log?.warn?.('provision-workspace-job: best-effort job-id refresh failed after a successful '
        + 'self-requeue; the requeued hop is unaffected', {
        brandId,
        attemptId,
        requeuedJobId: newJob.getId(),
        error: jobIdWriteError?.message,
      });
    }

    return { requeuedJobId: newJob.getId() };
  } catch (error) {
    // Anything NOT already handled above (a transport network error, a Postgres read/write
    // failure, an unexpected ErrorWithStatusCode from create-or-adopt, ...) lands here.
    // Adversarial-review finding (LLMO-7418): without this, the brand row is left at
    // `semrush_provisioning_status: 'pending'` forever — nothing else in this codebase ever
    // revisits it — which is exactly the "silently, permanently broken" failure mode this whole
    // redesign exists to eliminate. Record failure best-effort, then re-throw the ORIGINAL error
    // unchanged so the outer runner's existing FAILED-job handling is unaffected.
    //
    // LLMO-7418 external-review Finding 16: clean up `candidate` here too if we own it — UNLESS
    // a self-requeue already enqueued a future hop for it (`requeueEnqueued`), which will poll
    // it itself. Without this, an unexpected error anywhere before that point (a Postgres read
    // failure, create-or-adopt throwing mid-flow, ...) left a freshly-created candidate an
    // orphan: this attempt is about to be marked failed, so nothing else will ever revisit it.
    if (transport && candidate && !requeueEnqueued && !candidateAlreadyCleanedUp
      && !candidatePromoted) {
      await cleanupIfOwned(transport, candidate, parentWorkspaceId, log, 'provision-worker-unexpected-error');
    }
    // Skip the failure-record when the attempt already reached `ready` (Finding 12): the only way
    // to land here after promotion is a chained-job enqueue failure, and the brand is genuinely
    // ready/active — its provisioning attempt SUCCEEDED. Marking it `failed` would be wrong
    // intent (its CAS no-ops on a non-pending row anyway). Re-throw so the JOB goes FAILED and
    // the caller learns the chained work did not run, without defacing the ready brand.
    if (!candidatePromoted) {
      await failBestEffort({ brandId, attemptId, postgrestClient }, log);
    }
    throw error;
  }
}
