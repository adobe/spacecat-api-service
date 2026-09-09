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

import { randomUUID } from 'crypto';

/**
 * Atomic per-job processing lease (Gap 4 — a SECURITY control, not only
 * correctness). SQS is at-least-once, so two concurrent deliveries of the same
 * message can both observe `status === 'IN_PROGRESS'` and both process the job —
 * for a token-bearing Semrush-write job that is a promise-token replay window
 * plus a double-write to Semrush. The runner's terminal-state guard
 * (`job.getStatus() !== 'IN_PROGRESS'`) is a non-atomic read and cannot prevent
 * this.
 *
 * The `AsyncJob` Active-Record `save()` is an unconditional UPDATE by primary key
 * (no version column, no conditional write — verified against
 * `@adobe/spacecat-shared-data-access`), so it cannot express a compare-and-set.
 * We therefore claim the lease with ONE conditional PostgREST `UPDATE` against the
 * `async_jobs` table, guarded so it matches only when the job is still
 * `IN_PROGRESS` AND no live lease is held (the `lease` sub-object is absent or its
 * `expiresAt` has passed). Under READ COMMITTED the row lock serialises concurrent
 * claimers and the guard is re-evaluated after each commit, so **exactly one**
 * claimer gets a row back — the DB, not the worker, decides the winner.
 *
 * The lease TTL must sit safely ABOVE the worker's own timeout and the SQS
 * visibility timeout (owned by spacecat-infrastructure#780) so a lease only frees
 * for reclaim once its holder is genuinely dead, never mid-run.
 */

/** The physical table backing the `AsyncJob` model. */
const ASYNC_JOBS_TABLE = 'async_jobs';

/**
 * Default lease lifetime, sized to sit STRICTLY BETWEEN the worker Lambda timeout
 * and the SQS visibility timeout that spacecat-infrastructure#780 asserts:
 * `visibility 960s > lease 930s > worker 900s > (DRS 300s + Semrush writes 120s)`.
 * A live worker therefore holds its lease for its entire run, while a genuinely
 * dead worker's lease frees (at ~930s) just BEFORE the 960s redelivery, so the
 * redelivery can atomically re-claim rather than being blocked by a stale lease.
 */
export const DEFAULT_LEASE_TTL_MS = 930 * 1000;

/**
 * Mints a fresh, unguessable lease token identifying one worker's claim.
 * @returns {string}
 */
export function newLeaseToken() {
  return randomUUID();
}

/**
 * Reads the raw PostgREST client, or throws — a lease-required job type MUST fail
 * closed (not process) when it cannot claim atomically.
 * @param {object} context
 * @returns {{ from: Function }}
 */
function requirePostgrestClient(context) {
  const postgrestClient = context?.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    throw new Error('[job-lease] PostgREST client unavailable; cannot claim job lease atomically');
  }
  return postgrestClient;
}

/**
 * Atomically claims the processing lease for a job. Wins iff the DB updates
 * exactly this one row under the compare-and-set guard.
 *
 * On a win, the claimed `lease` is also reflected onto the in-memory `job` so the
 * worker's own subsequent `job.save()` calls (which write the full metadata) keep
 * the lease rather than dropping it.
 *
 * @param {object} context - worker context (`dataAccess.services.postgrestClient`, `log`).
 * @param {object} job - the loaded `AsyncJob` instance being claimed.
 * @param {object} opts
 * @param {string} opts.leaseToken - this worker's lease token (see {@link newLeaseToken}).
 * @param {number} [opts.ttlMs] - lease lifetime in ms (default {@link DEFAULT_LEASE_TTL_MS}).
 * @param {number} [opts.now] - injectable clock (ms epoch) for tests.
 * @returns {Promise<boolean>} true iff this worker won the lease.
 * @throws when the PostgREST client is unavailable or the claim query errors —
 *   the caller must treat this as "not claimed" and let SQS redeliver rather than
 *   process unguarded.
 */
export async function claimJobLease(context, job, {
  leaseToken, ttlMs = DEFAULT_LEASE_TTL_MS, now = Date.now(),
}) {
  const postgrestClient = requirePostgrestClient(context);
  const jobId = job.getId();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const currentMeta = job.getMetadata?.() ?? {};
  const nextMeta = { ...currentMeta, lease: { token: leaseToken, expiresAt } };

  const { data, error } = await postgrestClient
    .from(ASYNC_JOBS_TABLE)
    .update({ metadata: nextMeta })
    .eq('id', jobId)
    .eq('status', 'IN_PROGRESS')
    // Free lease = the sub-object is absent, or its expiry has already passed.
    .or(`metadata->lease.is.null,metadata->lease->>expiresAt.lt.${nowIso}`)
    .select('id');

  if (error) {
    const claimError = new Error(`[job-lease] lease claim query failed for job ${jobId}: ${error.message}`);
    /** @type {any} */ (claimError).cause = error;
    throw claimError;
  }

  const won = Array.isArray(data) && data.length === 1;
  if (won) {
    job.setMetadata?.(nextMeta);
  }
  return won;
}

/**
 * Renews (heartbeats) a lease this worker already holds, extending its expiry.
 * Best-effort: a renew failure is logged, never thrown — losing a renew does not
 * invalidate work already in flight, it only shortens the window before a
 * genuinely-dead holder's job can be reclaimed.
 *
 * @param {object} context
 * @param {object} job - the `AsyncJob` instance whose lease to renew.
 * @param {object} opts
 * @param {string} opts.leaseToken - the token this worker holds; the renew matches on it.
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.now]
 * @returns {Promise<boolean>} true iff the lease was still ours and got extended.
 */
export async function renewJobLease(context, job, {
  leaseToken, ttlMs = DEFAULT_LEASE_TTL_MS, now = Date.now(),
}) {
  const postgrestClient = context?.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    return false;
  }
  const jobId = job.getId();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const currentMeta = job.getMetadata?.() ?? {};
  const nextMeta = { ...currentMeta, lease: { token: leaseToken, expiresAt } };

  const { data, error } = await postgrestClient
    .from(ASYNC_JOBS_TABLE)
    .update({ metadata: nextMeta })
    .eq('id', jobId)
    .eq('metadata->lease->>token', leaseToken)
    .select('id');

  if (error) {
    context.log?.warn?.(`[job-lease] lease renew failed for job ${jobId}: ${error.message}`);
    return false;
  }
  const renewed = Array.isArray(data) && data.length === 1;
  if (renewed) {
    job.setMetadata?.(nextMeta);
  }
  return renewed;
}

/**
 * Scrubs the lease off a job's in-memory metadata on terminal state, so a dead
 * job record does not retain a stale claim. The caller persists this via its own
 * `job.save()`.
 * @param {object} job
 */
export function clearJobLease(job) {
  const metadata = { ...(job.getMetadata?.() ?? {}) };
  delete metadata.lease;
  job.setMetadata?.(metadata);
}
