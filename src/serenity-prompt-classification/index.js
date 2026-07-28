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

import wrap from '@adobe/helix-shared-wrap';
import { helixStatus } from '@adobe/helix-status';
import vaultSecrets from '@adobe/spacecat-shared-vault-secrets';
import { sqsEventAdapter, logWrapper } from '@adobe/spacecat-shared-utils';
import { imsClientWrapper } from '@adobe/spacecat-shared-ims-client';
import { ok } from '@adobe/spacecat-shared-http-utils';

import dataAccess from '../support/data-access.js';
import sqs from '../support/sqs.js';
import {
  exchangeAndPersistPromiseToken,
  invalidateJobPromiseToken,
  NeedsReauthError,
} from '../support/serenity/async-job-runner.js';

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
 * Per-consumer job logic — e.g. serenity-docs#33's prompt intent
 * classification (classify -> create-with-tags -> publish) — is registered
 * as a handler below but is not itself implemented here.
 *
 * @type {Record<string, (context: UniversalContext, job: object) => Promise<object>>}
 */
const HANDLERS = {
  // 'serenity-classify-prompts': classifyPromptsHandler, // serenity-docs#33
};

/**
 * @param {object} message - the SQS message body (already JSON-parsed by
 *   `sqsEventAdapter`), carrying only `{ jobId, type }` — no promise token,
 *   per the runner's DLQ-redrive-safety design.
 * @param {UniversalContext} context
 */
export async function run(message, context) {
  const { log, dataAccess: da } = context;
  const { jobId, type } = message ?? {};

  const job = await da.AsyncJob.findById(jobId);
  if (!job) {
    log.error(`[serenity-job-runner] Job ${jobId} not found; dropping message`);
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
