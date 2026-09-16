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

import * as helixWrapPkg from '@adobe/helix-shared-wrap';
import { helixStatus } from '@adobe/helix-status';
import vaultSecrets from '@adobe/spacecat-shared-vault-secrets';
import { logWrapper } from '@adobe/spacecat-shared-utils';
import { ok } from '@adobe/spacecat-shared-http-utils';

import dataAccess from '../support/data-access.js';
import { emitMetric, resolveEnvironment } from '../support/metrics-emf.js';
import { METRICS_NAMESPACE } from '../support/serenity/drs-generation-client.js';
import { SEMRUSH_MARKET_GENERATION_JOB_TYPE } from '../support/serenity/handlers/semrush-market-generation-job.js';
import { NEEDS_REAUTH_ERROR_CODE } from '../support/serenity/async-job-runner.js';

// See the sibling worker (`src/serenity-prompt-classification/index.js`) for the
// full rationale of this declaration-gap workaround: `@adobe/helix-shared-wrap`'s
// runtime default export exists but its `.d.ts` only declares it as a named
// export. Reach it through a namespace import rather than widening anything shared.
const { default: wrap } = /** @type {{ default: (fn: Function) => { with: Function } }} */ (
  /** @type {unknown} */ (helixWrapPkg)
);

/**
 * The physical table backing the `AsyncJob` model (v3 / PostgreSQL). The probe
 * counts rows with a filtered, head-only PostgREST query rather than loading
 * `AsyncJob` records — it needs cardinality, not the jobs themselves, and must
 * never touch (mutate) a job. Column names are snake_case (`started_at`,
 * `metadata`, `error`), matching the async_jobs schema.
 */
const ASYNC_JOBS_TABLE = 'async_jobs';

/**
 * Metric names emitted here. These are a CONTRACT with the CloudWatch alarms in
 * spacecat-infrastructure `modules/serenity_market_worker/alarms.tf` (issue #786),
 * which read `StuckInProgressJobs` (PAGED) and `NeedsReauthBacklog` (warning) from
 * namespace {@link METRICS_NAMESPACE} with a single `Environment` dimension. Those
 * alarms sit INSUFFICIENT_DATA until this probe emits — do not rename without the
 * matching infra change.
 */
export const STUCK_IN_PROGRESS_METRIC = 'StuckInProgressJobs';
export const NEEDS_REAUTH_BACKLOG_METRIC = 'NeedsReauthBacklog';

/** Env key overriding the stuck-job age deadline (ms). */
export const STUCK_JOB_DEADLINE_MS_ENV = 'STUCK_JOB_DEADLINE_MS';

/**
 * Default age past which an `IN_PROGRESS` serenity-market job is deemed stuck.
 *
 * Sized to sit safely ABOVE any legitimate run so only a genuinely abandoned job
 * trips it. The infra timeout nesting (spacecat-infrastructure#780) is
 * `visibility 960s > lease 930s > worker 900s`, and a token-bearing message may be
 * redelivered up to `max_receive_count` times before it lands in the DLQ; across
 * those attempts the job legitimately stays `IN_PROGRESS`. One hour clears the
 * worst-case redelivery span with wide headroom, so a job older than this is one
 * whose holder died without reaching a terminal state (the exact invisible failure
 * the PAGED alarm exists to catch). Override per-env via
 * {@link STUCK_JOB_DEADLINE_MS_ENV} if the queue's retry budget changes.
 */
export const DEFAULT_STUCK_JOB_DEADLINE_MS = 60 * 60 * 1000;

/**
 * Reads the raw PostgREST client, or throws. The probe fails LOUD (throws) when it
 * cannot query — better an errored invocation (logged, retried on the next
 * schedule) than a silent all-clear from an emitter that never ran.
 *
 * @param {object} context
 * @returns {{ from: Function }}
 */
function requirePostgrestClient(context) {
  const postgrestClient = /** @type {any} */ (context)?.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from) {
    throw new Error('[serenity-market-probe] PostgREST client unavailable; cannot count serenity-market jobs');
  }
  return postgrestClient;
}

/**
 * Runs one head-only, count-exact PostgREST query and returns the matched row
 * count. Uses `head: true` so only the count header is transferred, never the rows.
 *
 * @param {(query: any) => any} build - applies the filters to a base query.
 * @param {{ from: Function }} postgrestClient
 * @returns {Promise<number>}
 * @throws when the query errors, or returns a non-numeric count.
 */
async function countJobs(build, postgrestClient) {
  const base = postgrestClient
    .from(ASYNC_JOBS_TABLE)
    .select('id', { count: 'exact', head: true });
  const { count, error } = await build(base);
  if (error) {
    const queryError = new Error(`[serenity-market-probe] count query failed: ${error.message}`);
    /** @type {any} */ (queryError).cause = error;
    throw queryError;
  }
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new Error('[serenity-market-probe] count query returned no numeric count');
  }
  return count;
}

/**
 * Counts serenity-market jobs stuck `IN_PROGRESS` past the deadline: the same
 * job type the worker dispatches, still `IN_PROGRESS`, whose `started_at` is older
 * than `now - deadlineMs`.
 *
 * @param {{ from: Function }} postgrestClient
 * @param {number} now - ms epoch (injectable for tests).
 * @param {number} deadlineMs
 * @returns {Promise<number>}
 */
export function countStuckInProgress(postgrestClient, now, deadlineMs) {
  const stuckBefore = new Date(now - deadlineMs).toISOString();
  return countJobs(
    (query) => query
      .eq('status', 'IN_PROGRESS')
      .eq('metadata->>jobType', SEMRUSH_MARKET_GENERATION_JOB_TYPE)
      .lt('started_at', stuckBefore),
    postgrestClient,
  );
}

/**
 * Counts the NEEDS_REAUTH backlog: serenity-market jobs that terminated `FAILED`
 * with `error.code === NEEDS_REAUTH` (the #3252 contract — a job blocked awaiting
 * the user to re-authenticate). Bounded naturally by the async_jobs 7-day TTL.
 *
 * @param {{ from: Function }} postgrestClient
 * @returns {Promise<number>}
 */
export function countNeedsReauthBacklog(postgrestClient) {
  return countJobs(
    (query) => query
      .eq('status', 'FAILED')
      .eq('metadata->>jobType', SEMRUSH_MARKET_GENERATION_JOB_TYPE)
      .eq('error->>code', NEEDS_REAUTH_ERROR_CODE),
    postgrestClient,
  );
}

/**
 * Scheduled EventBridge entry point (see the `build:probe`/`deploy-*:probe`
 * scripts and the infra EventBridge rule in
 * `modules/serenity_market_worker`). Deployed as a distinct Lambda from the
 * API-Gateway `src/index.js` and the SQS worker `src/serenity-prompt-classification`
 * — same repo and shared `src/support/*` modules, but its own `hedy --entryFile`
 * build wired to a ~5-minute schedule instead of an event source.
 *
 * It is a read-only OBSERVABILITY probe. On each tick it counts, in the
 * async_jobs table, (a) serenity-market jobs stuck `IN_PROGRESS` past the deadline
 * and (b) the NEEDS_REAUTH backlog, and emits each as an EMF metric matching the
 * infra alarm contract exactly (namespace {@link METRICS_NAMESPACE}, metric names
 * {@link STUCK_IN_PROGRESS_METRIC}/{@link NEEDS_REAUTH_BACKLOG_METRIC}, single
 * `Environment` dimension). It NEVER mutates a job.
 *
 * Each metric is emitted only when its own count query SUCCEEDS — a failed query
 * logs and skips that metric rather than emitting a (false) 0, so a transient DB
 * error can never mask a real backlog into an all-clear. `treat_missing_data`
 * on the alarms turns a skipped tick into a gap, not a page. A successful count of
 * zero IS emitted explicitly, so the alarm leaves INSUFFICIENT_DATA and can
 * evaluate. The whole probe is best-effort: it logs and returns `ok()` rather than
 * crash-looping (it is a metrics probe, not a writer).
 *
 * @param {object} request - the universal request (a scheduled invoke carries no
 *   meaningful payload; ignored).
 * @param {object} context
 * @returns {Promise<object>}
 */
export async function run(request, context) {
  const { log, env = {} } = context;
  const environment = resolveEnvironment(env);
  const metricsOpts = { environment, namespace: METRICS_NAMESPACE };

  let postgrestClient;
  try {
    postgrestClient = requirePostgrestClient(context);
  } catch (error) {
    // No client → nothing to count. Log and leave both alarms in their prior
    // state (gap, not a false 0). The next scheduled tick retries.
    log.error(`[serenity-market-probe] cannot run probe: ${error.message}`);
    return ok();
  }

  const deadlineMs = Number.parseInt(env[STUCK_JOB_DEADLINE_MS_ENV], 10) > 0
    ? Number.parseInt(env[STUCK_JOB_DEADLINE_MS_ENV], 10)
    : DEFAULT_STUCK_JOB_DEADLINE_MS;
  const now = Date.now();

  // Independent try/catch per metric so one failing query never suppresses the
  // other, and a failure never emits a false 0.
  try {
    const stuck = await countStuckInProgress(postgrestClient, now, deadlineMs);
    emitMetric({ name: STUCK_IN_PROGRESS_METRIC, value: stuck }, metricsOpts);
    log.info(`[serenity-market-probe] ${STUCK_IN_PROGRESS_METRIC}=${stuck} (deadline ${deadlineMs}ms, env ${environment})`);
  } catch (error) {
    log.error(`[serenity-market-probe] ${STUCK_IN_PROGRESS_METRIC} scan failed; skipping emit: ${error.message}`);
  }

  try {
    const needsReauth = await countNeedsReauthBacklog(postgrestClient);
    emitMetric({ name: NEEDS_REAUTH_BACKLOG_METRIC, value: needsReauth }, metricsOpts);
    log.info(`[serenity-market-probe] ${NEEDS_REAUTH_BACKLOG_METRIC}=${needsReauth} (env ${environment})`);
  } catch (error) {
    log.error(`[serenity-market-probe] ${NEEDS_REAUTH_BACKLOG_METRIC} scan failed; skipping emit: ${error.message}`);
  }

  return ok();
}

// Reuse api-service's Vault identity (bootstrap secret + env-scoped data path) so
// the probe needs no dedicated AppRole — identical to the worker's `vaultOpts`
// (see `src/serenity-prompt-classification/index.js` for the full rationale). It
// loads POSTGREST_URL + Postgres credentials that `dataAccess` needs to build the
// PostgREST client. AWS_ENV is a deploy-time Lambda env var; a wrong/absent value
// fails closed rather than reading another environment's secrets.
const VAULT_SERVICE = 'api-service';

/**
 * @type {{ bootstrapPath: string, name: (ctx: { env?: Record<string, string> }) => string }}
 */
export const vaultOpts = {
  bootstrapPath: `/mysticat/bootstrap/${VAULT_SERVICE}`,
  name: (/** @type {{ env?: Record<string, string> }} */ ctx) => {
    const env = ctx.env?.AWS_ENV;
    if (!env) {
      throw new Error('[serenity-market-probe] AWS_ENV must be set (see the probe deploy scripts) to resolve the Vault secrets path');
    }
    return `${env}/${VAULT_SERVICE}`;
  },
};

// No SQS/event adapter: this Lambda is EventBridge-scheduled, so the trigger
// carries no records to parse — `run` ignores the request and works off `context`.
// `helixStatus` (outermost) still answers the platform health check; every other
// invoke falls through to `run`.
export const main = wrap(run)
  .with(logWrapper)
  .with(dataAccess)
  .with(vaultSecrets, vaultOpts)
  .with(helixStatus);
