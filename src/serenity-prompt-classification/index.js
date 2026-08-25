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
import { sqsEventAdapter, logWrapper } from '@adobe/spacecat-shared-utils';
import * as imsClientPkg from '@adobe/spacecat-shared-ims-client';
import { ok } from '@adobe/spacecat-shared-http-utils';

import dataAccess from '../support/data-access.js';
import sqs from '../support/sqs.js';
import {
  exchangeAndPersistPromiseToken,
  invalidateJobPromiseToken,
  NeedsReauthError,
} from '../support/serenity/async-job-runner.js';
import {
  classifyPromptsHandler,
  CLASSIFY_PROMPTS_JOB_TYPE,
} from '../support/serenity/handlers/classify-prompts-job.js';

// `wrap`'s runtime default export and `imsClientWrapper`'s runtime named export
// both exist (`@adobe/helix-shared-wrap/src/wrap.js`,
// `@adobe/spacecat-shared-ims-client/src/index.js`), but their `.d.ts` files
// don't declare them the same way (`wrap` only as a named export; no
// `imsClientWrapper` declaration at all) — the same upstream declaration-gap
// class as `ImsPromiseClient` in `async-job-runner.js`. Reach both through a
// namespace import rather than widening anything shared.
const { default: wrap } = /** @type {{ default: (fn: Function) => { with: Function } }} */ (
  /** @type {unknown} */ (helixWrapPkg)
);
const { imsClientWrapper } = /** @type {{ imsClientWrapper: Function }} */ (
  /** @type {unknown} */ (imsClientPkg)
);

// This worker is a second Lambda built from the api-service repo, and it needs the exact
// same Vault secrets the synchronous serenity path already loads (IMS_PROMISE_SEMRUSH_*,
// SEMRUSH_PROJECTS_BASE_URL, Postgres, AUTOFIX_CRYPT_*). Rather than provision a separate
// AppRole + bootstrap secret for this function's own name (`serenity-job-runner`), reuse
// api-service's existing Vault setup: `@adobe/spacecat-shared-vault-secrets` derives its
// AWS Secrets Manager bootstrap path and its Vault data path from the function name by
// default, but both are overridable. We point them at `api-service` so no vault_policies
// change is needed — the Lambda role already reads `/mysticat/bootstrap/*` via a wildcard,
// and api-service's env-scoped AppRole already grants read on `dx_mysticat/data/{env}/api-service`.
//
// AWS_ENV is a deploy-time Lambda env var (set per environment in the worker deploy scripts).
// A wrong or missing value fails closed rather than reading another environment's secrets:
// api-service's AppRole is scoped to a single env, so requesting a different env's path is denied.
const VAULT_SERVICE = 'api-service';
export const vaultOpts = {
  bootstrapPath: `/mysticat/bootstrap/${VAULT_SERVICE}`,
  name: (/** @type {{ env?: Record<string, string> }} */ ctx) => `${ctx.env?.AWS_ENV || ctx.env?.ENV || 'dev'}/${VAULT_SERVICE}`,
};

/**
 * SQS-triggered entry point for the deferred user-context Semrush job runner
 * (serenity-docs#186). Deployed as a distinct Lambda function from the
 * API-Gateway-triggered `src/index.js` (see `package.json`'s `build:worker`/
 * `deploy:worker` scripts) — same repo, same `src/support/serenity/*`
 * modules, but a separate `hedy --entryFile` build so it can be wired to an
 * SQS event source (Terraform-managed, not part of this build) instead of
 * API Gateway.
 *
 * This file owns only the runner mechanics (job-type dispatch, exchange-
 * first-and-persist promise-token handling, terminal-state invalidation).
 * Per-consumer job logic — serenity-docs#33's prompt intent classification
 * (classify -> create-with-tags -> publish) — lives in
 * `../support/serenity/handlers/classify-prompts-job.js` and is registered
 * below.
 *
 * @type {Record<string, (context: object, job: object,
 *   accessToken: string) => Promise<object>>}
 */
const HANDLERS = {
  [CLASSIFY_PROMPTS_JOB_TYPE]: classifyPromptsHandler,
};

/**
 * @param {object} message - the SQS message body (already JSON-parsed by
 *   `sqsEventAdapter`), carrying only `{ jobId, type }` — no promise token,
 *   per the runner's DLQ-redrive-safety design.
 * @param {object} context
 */
export async function run(message, context) {
  const { log, dataAccess: da } = context;
  const { jobId, type } = message ?? {};

  const job = await da.AsyncJob.findById(jobId);
  if (!job) {
    log.error(`[serenity-job-runner] Job ${jobId} not found; dropping message`);
    return ok();
  }

  // SQS is at-least-once delivery: a redelivery of a message whose first
  // delivery already reached a terminal state must not re-exchange the
  // (already-consumed) promise token — that exchange would fail and
  // overwrite a COMPLETED job's status with FAILED.
  if (job.getStatus() !== 'IN_PROGRESS') {
    log.info(`[serenity-job-runner] Job ${jobId} already in terminal state ${job.getStatus()}; dropping duplicate delivery`);
    return ok();
  }

  let accessToken;
  try {
    // Exchange first, before any other work: every exchange resets the
    // promise token's TTL from that moment (see async-job-runner.js).
    accessToken = await exchangeAndPersistPromiseToken(context, job);
  } catch (error) {
    if (error instanceof NeedsReauthError) {
      log.warn(`[serenity-job-runner] Job ${jobId} needs re-authentication: ${error.message}`);
      job.setStatus('FAILED');
      job.setError({ code: error.code, message: error.message });
      await job.save();
      return ok();
    }
    throw error;
  }

  const handler = HANDLERS[type];
  if (!handler) {
    log.warn(`[serenity-job-runner] No handler registered for job type: ${type}`);
    job.setStatus('FAILED');
    job.setError({ code: 'UNKNOWN_JOB_TYPE', message: `No handler for job type: ${type}` });
    await invalidateJobPromiseToken(context, job);
    await job.save();
    return ok();
  }

  let tokenOwnershipTransferred = false;
  try {
    const result = await handler(context, job, accessToken);
    job.setStatus('COMPLETED');
    job.setResult(result ?? null);
    // A handler that self-requeues (e.g. classify-prompts-job.js's
    // `requeuePending`) forwards this job's CURRENT promise token onto the new
    // job's metadata, rather than minting a fresh one — the worker has no HTTP
    // context to mint from. Revocation is by identity, so invalidating here
    // would also kill the requeued job's copy before it ever runs.
    tokenOwnershipTransferred = Boolean(result?.requeuedJobId);
  } catch (error) {
    log.error(`[serenity-job-runner] Job ${jobId} failed: ${error.message}`);
    job.setStatus('FAILED');
    job.setError({ code: 'JOB_FAILED', message: error.message });
  }

  if (!tokenOwnershipTransferred) {
    await invalidateJobPromiseToken(context, job);
  }
  await job.save();

  return ok();
}

export const main = wrap(run)
  .with(sqsEventAdapter)
  .with(logWrapper)
  .with(dataAccess)
  .with(sqs)
  .with(imsClientWrapper)
  .with(vaultSecrets, vaultOpts)
  .with(helixStatus);
