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

  try {
    const result = await handler(context, job, accessToken);
    job.setStatus('COMPLETED');
    job.setResult(result ?? null);
  } catch (error) {
    log.error(`[serenity-job-runner] Job ${jobId} failed: ${error.message}`);
    job.setStatus('FAILED');
    job.setError({ code: 'JOB_FAILED', message: error.message });
  }

  await invalidateJobPromiseToken(context, job);
  await job.save();

  return ok();
}

export const main = wrap(run)
  .with(sqsEventAdapter)
  .with(logWrapper)
  .with(dataAccess)
  .with(sqs)
  .with(imsClientWrapper)
  .with(vaultSecrets)
  .with(helixStatus);
