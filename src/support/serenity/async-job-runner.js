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

import * as imsClientPkg from '@adobe/spacecat-shared-ims-client';
import { getIMSPromiseToken } from '../utils.js';

/**
 * Deferred user-context Semrush job runner (serenity-docs#186).
 *
 * Generic pieces shared by every consumer of the runner: enqueueing a job as the
 * signed-in user, and exchanging its promise token inside the worker with the
 * "exchange first, persist immediately" ordering the spec requires. Per-consumer
 * job logic (e.g. serenity-docs#33's classify -> create-with-tags -> publish) is
 * NOT here — this module only owns the runner mechanics.
 */

// `ImsPromiseClient` is a runtime value (`src/index.js` exports the class), but the
// package's `src/index.d.ts` re-exports it via `import type` / `export { ImsPromiseClient }`,
// which TS treats as a type-only export — the same upstream declaration gap noted for
// `@adobe/spacecat-shared-data-access` models (see this dir's CLAUDE.md). Reach the value
// through a namespace import rather than widening anything shared.
/**
 * @typedef {object} TypedImsPromiseClient
 * @property {(context: object, type: string) => {
 *   exchangeToken: (promiseToken: string, enableEncryption: boolean) => Promise<{
 *     access_token: string,
 *     promise_token: string,
 *     promise_token_expires_in: number,
 *   }>,
 *   invalidatePromiseToken: (promiseToken: string, enableEncryption: boolean) => Promise<void>,
 * }} createFrom
 * @property {{ EMITTER: string, CONSUMER: string }} CLIENT_TYPE
 */
const { ImsPromiseClient } = /** @type {{ ImsPromiseClient: TypedImsPromiseClient }} */ (
  /** @type {unknown} */ (imsClientPkg)
);

export const NEEDS_REAUTH_ERROR_CODE = 'NEEDS_REAUTH';

/**
 * Thrown when a promise token can no longer be exchanged for an access token because
 * IMS rejected the exchange itself (not a downstream Semrush failure). Distinguishes a
 * dead promise token (needs a human to re-mint, per the runner's ops `recover` command)
 * from an ordinary transient/retryable job failure.
 *
 * TODO: replace with `NeedsReauthError` from `@adobe/spacecat-shared-ims-client` once
 * adobe/spacecat-shared#1843 (PromiseTokenSession) is merged and published — that PR
 * adds the same typed error upstream, keyed on the real HTTP status rather than this
 * message-parsing workaround. `@adobe/spacecat-shared-ims-client` is pinned at 1.12.7
 * today, which predates that change.
 */
export class NeedsReauthError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'NeedsReauthError';
    this.code = NEEDS_REAUTH_ERROR_CODE;
    this.cause = cause;
  }
}

const REAUTH_STATUS_PATTERN = /status: (401|403)\b/;

/**
 * Creates an AsyncJob carrying the caller's promise token and enqueues its id to the
 * runner's SQS queue. The message body is intentionally minimal — `{ jobId, type }` —
 * per the spec: the promise token lives only on the job record so a DLQ redrive can
 * replay the bare message as-is rather than needing per-message token surgery.
 * @param {object} context - Request context (`dataAccess`, `sqs`, `env`, `log`).
 * @param {object} params
 * @param {string} params.jobType - Job type the worker dispatches on
 *   (e.g. 'serenity-classify-prompts').
 * @param {object} [params.metadata] - Consumer-specific payload, merged onto the job's
 *   `metadata` alongside `jobType` and the promise token.
 * @returns {Promise<object>} The created job (an AsyncJob instance).
 * @throws On SQS send failure, after rolling back the created job record.
 */
export async function createAndEnqueueJob(context, { jobType, metadata = {} }) {
  const {
    dataAccess, sqs, env, log,
  } = context;

  const promiseTokenResponse = await getIMSPromiseToken(context);

  const job = await dataAccess.AsyncJob.create({
    status: 'IN_PROGRESS',
    metadata: {
      ...metadata,
      jobType,
      promiseToken: promiseTokenResponse,
    },
  });

  try {
    await sqs.sendMessage(env.SERENITY_JOB_RUNNER_QUEUE_URL, {
      jobId: job.getId(),
      type: jobType,
    });
  } catch (error) {
    log.error(`[serenity-job-runner] Failed to enqueue job ${job.getId()}: ${error.message}, rolling back`);
    await job.remove().catch((removeError) => {
      log.warn(`[serenity-job-runner] Failed to roll back job ${job.getId()}: ${removeError.message}`);
      job.setStatus('FAILED');
      job.setError({ code: 'ENQUEUE_FAILED', message: error.message });
      return job.save();
    });
    throw error;
  }

  return job;
}

/**
 * Exchanges the promise token stored on a job's metadata for a fresh access token,
 * persisting the rolled-forward promise token onto the job record BEFORE returning —
 * per the spec's binding ordering rule: every exchange resets the token's TTL from that
 * moment, so a failure after this call has already banked a full fresh window, while a
 * failure before it leaves the original clock running. Callers must invoke this as the
 * very first action in a job attempt, ahead of any other work.
 * @param {object} context - Worker context (`env`).
 * @param {object} job - An AsyncJob instance.
 * @returns {Promise<string>} The exchanged access token.
 * @throws {NeedsReauthError} When IMS rejects the exchange itself (401/403) — the
 *   promise token is dead and needs a human to re-mint it (the ops `recover` command).
 */
export async function exchangeAndPersistPromiseToken(context, job) {
  const metadata = job.getMetadata() ?? {};
  const { promiseToken } = metadata;
  const enableEncryption = !!context.env?.AUTOFIX_CRYPT_SECRET
    && !!context.env?.AUTOFIX_CRYPT_SALT;

  const consumerClient = ImsPromiseClient.createFrom(
    context,
    ImsPromiseClient.CLIENT_TYPE.CONSUMER,
  );

  let exchangeResult;
  try {
    exchangeResult = await consumerClient.exchangeToken(
      promiseToken?.promise_token,
      enableEncryption,
    );
  } catch (error) {
    if (REAUTH_STATUS_PATTERN.test(error.message ?? '')) {
      throw new NeedsReauthError('Promise token exchange rejected by IMS; re-authentication required', error);
    }
    throw error;
  }

  job.setMetadata({
    ...metadata,
    promiseToken: {
      promise_token: exchangeResult.promise_token,
      expires_in: exchangeResult.promise_token_expires_in,
      token_type: promiseToken?.token_type,
    },
  });
  await job.save();

  return exchangeResult.access_token;
}

/**
 * Invalidates a job's current promise token by identity — this kills every token in the
 * exchange chain (rotation is not revocation; the spec requires an explicit invalidate
 * call on terminal state), so it is safe and required on both success and failure.
 * Best-effort: an invalidation failure is logged, not thrown, since it must never block
 * the job from reaching a terminal status.
 * @param {object} context
 * @param {object} job - An AsyncJob instance.
 */
export async function invalidateJobPromiseToken(context, job) {
  const { promiseToken } = job.getMetadata() ?? {};
  if (!promiseToken?.promise_token) {
    return;
  }

  const enableEncryption = !!context.env?.AUTOFIX_CRYPT_SECRET
    && !!context.env?.AUTOFIX_CRYPT_SALT;
  const consumerClient = ImsPromiseClient.createFrom(
    context,
    ImsPromiseClient.CLIENT_TYPE.CONSUMER,
  );

  try {
    await consumerClient.invalidatePromiseToken(promiseToken.promise_token, enableEncryption);
  } catch (error) {
    context.log?.warn(`[serenity-job-runner] Failed to invalidate promise token for job ${job.getId()}: ${error.message}`);
  }
}
