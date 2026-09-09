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
import { getIMSPromiseToken, resolvePromisePair } from '../utils.js';

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
 * @property {(context: object, type: string, opts?: { pair?: string }) => {
 *   exchangeToken: (promiseToken: string, enableEncryption: boolean) => Promise<{
 *     access_token: string,
 *     promise_token: string,
 *     promise_token_expires_in: number,
 *   }>,
 *   invalidatePromiseToken: (promiseToken: string, enableEncryption: boolean) => Promise<void>,
 * }} createFrom
 * @property {{ EMITTER: string, CONSUMER: string }} CLIENT_TYPE
 * @property {{ SEMRUSH: string }} PROMISE_PAIR
 */
const { ImsPromiseClient } = /** @type {{ ImsPromiseClient: TypedImsPromiseClient }} */ (
  /** @type {unknown} */ (imsClientPkg)
);

/**
 * The Semrush promise-pair selector, hard-coded so a token-bearing Semrush-**write**
 * job type binds to it server-side rather than trusting the caller's optional
 * `x-promise-audience` header (Gap 1). The runtime value is `'SEMRUSH'`; the `??`
 * fallback keeps this resolvable even if a test double stubs `ImsPromiseClient`
 * without the frozen `PROMISE_PAIR` map.
 */
export const PROMISE_PAIR_SEMRUSH = ImsPromiseClient?.PROMISE_PAIR?.SEMRUSH ?? 'SEMRUSH';

export const NEEDS_REAUTH_ERROR_CODE = 'NEEDS_REAUTH';

/**
 * The persisted promise-token contract (Gap 2): every token carried on a job
 * record is the typed `{ promise_token, ... }` object `getIMSPromiseToken`
 * returns — never the bare header string. A bare string silently leaves
 * `promiseToken?.promise_token` undefined and strands the job in the exchange
 * (→ DLQ), so both the enqueue and the worker exchange assert the shape up front
 * and fail loudly instead.
 *
 * @param {unknown} token
 * @returns {asserts token is { promise_token: string, token_type?: string, expires_in?: number }}
 * @throws {Error} code `INVALID_PROMISE_TOKEN` when the shape is wrong.
 */
export function assertTypedPromiseToken(token) {
  const t = /** @type {{ promise_token?: unknown } | null} */ (token);
  if (!t || typeof t !== 'object' || Array.isArray(t)
    || typeof t.promise_token !== 'string' || t.promise_token.length === 0) {
    const error = new Error(
      'Promise token must be a typed { promise_token, ... } object, not a bare string',
    );
    /** @type {any} */ (error).code = 'INVALID_PROMISE_TOKEN';
    throw error;
  }
}

/**
 * Thrown when a promise token can no longer be exchanged for an access token because
 * IMS rejected the exchange itself (not a downstream Semrush failure). Distinguishes a
 * dead promise token (needs a human to re-mint, per the runner's ops `recover` command)
 * from an ordinary transient/retryable job failure.
 *
 * TODO: replace with `NeedsReauthError` from `@adobe/spacecat-shared-ims-client` once
 * adobe/spacecat-shared#1843 (PromiseTokenSession) is merged and published — that PR
 * adds the same typed error upstream, keyed on the real HTTP status rather than this
 * message-parsing workaround. That PR is not yet published, so the message-parsing
 * workaround stays.
 */
export class NeedsReauthError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'NeedsReauthError';
    this.code = NEEDS_REAUTH_ERROR_CODE;
    this.cause = cause;
  }
}

export function retryableJobError(message, cause) {
  const error = new Error(message, { cause });
  error.name = 'RetryableJobError';
  /** @type {any} */ (error).code = 'RETRY_JOB';
  /** @type {any} */ (error).retryJob = true;
  return error;
}

export function isRetryableJobError(error) {
  return error instanceof Error
    && /** @type {any} */ (error).code === 'RETRY_JOB'
    && /** @type {any} */ (error).retryJob === true;
}

const REAUTH_STATUS_PATTERN = /status: (401|403)\b/;

/**
 * Creates an AsyncJob carrying the caller's promise token and enqueues its id to the
 * runner's SQS queue. The message body is intentionally minimal — `{ jobId, type }` —
 * per the spec: the promise token lives only on the job record so a DLQ redrive can
 * replay the bare message as-is rather than needing per-message token surgery.
 * @param {object} context - Request/worker context (`dataAccess`, `sqs`, `env`, `log`).
 * @param {object} params
 * @param {string} params.jobType - Job type the worker dispatches on
 *   (e.g. 'serenity-classify-prompts').
 * @param {object} [params.metadata] - Consumer-specific payload, merged onto the job's
 *   `metadata` alongside `jobType` and the promise token.
 * @param {object} [params.promiseToken] - An already-minted promise token to carry
 *   onto the new job, bypassing `getIMSPromiseToken`. Required when enqueueing from
 *   inside the SQS worker itself (e.g. a handler's self-requeue): the worker has no
 *   HTTP request context (`getIMSPromiseToken` reads the caller's `Authorization`
 *   header, which does not exist there) — the worker instead forwards the token it
 *   already exchanged for the job it is currently processing.
 * @param {string} [params.promisePair] - IMS promise-pair selector to mint with and
 *   persist on the job (see `resolvePromisePair`). Pass this on the worker self-requeue
 *   path (the worker has no request headers); from a request it defaults to the
 *   `x-promise-audience` header. Persisted so the worker exchanges/invalidates on the
 *   same pair.
 * @param {string} [params.jobId] - Optional deterministic UUID used by callers
 *   that require durable idempotency across Lambda containers.
 * @param {string} [params.requirePair] - When set, the resolved promise pair MUST
 *   equal this value or the enqueue **fails** before any token is minted (Gap 1).
 *   A token-bearing Semrush-write job type passes {@link PROMISE_PAIR_SEMRUSH} here
 *   so it can never silently run on the default IMS pair when `x-promise-audience`
 *   is absent (which current callers never send).
 * @returns {Promise<object>} The created job (an AsyncJob instance).
 * @throws On SQS send failure, after rolling back the created job record; on an
 *   unresolvable required pair (`PROMISE_PAIR_REQUIRED`); on a non-typed token
 *   (`INVALID_PROMISE_TOKEN`).
 */
export async function createAndEnqueueJob(
  context,
  {
    jobType, metadata = {}, promiseToken, promisePair, jobId, requirePair,
  },
) {
  const {
    dataAccess, sqs, env, log,
  } = context;

  // When a pre-minted token is supplied (worker self-requeue), the pair must come
  // from the explicit promisePair only — never re-derived from the request context,
  // which could diverge from the pair that actually minted that token.
  const pair = promisePair ?? (promiseToken ? undefined : resolvePromisePair(context));

  // Fail-closed pair binding (Gap 1): a Semrush-write job type must resolve to the
  // Semrush pair. Reject the enqueue rather than mint on — and later write to
  // Semrush with — the wrong delegated credential. This runs BEFORE the token is
  // minted, so a rejected job never touches IMS.
  if (requirePair && pair !== requirePair) {
    const error = new Error(
      `Job type '${jobType}' requires promise pair '${requirePair}' but resolved `
      + `'${pair ?? 'default'}'; refusing to enqueue on the wrong pair`,
    );
    /** @type {any} */ (error).code = 'PROMISE_PAIR_REQUIRED';
    throw error;
  }

  const promiseTokenResponse = promiseToken ?? await getIMSPromiseToken(context, pair);
  // Reject a bare-string token before it is persisted (Gap 2).
  assertTypedPromiseToken(promiseTokenResponse);

  const job = await dataAccess.AsyncJob.create({
    ...(jobId ? { id: jobId } : {}),
    status: 'IN_PROGRESS',
    metadata: {
      ...metadata,
      jobType,
      promiseToken: promiseTokenResponse,
      promisePair: pair,
    },
  });

  try {
    await sqs.sendMessage(env.SERENITY_JOB_RUNNER_QUEUE_URL, {
      jobId: job.getId(),
      type: jobType,
    });
  } catch (error) {
    log.error(`[serenity-job-runner] Failed to enqueue job ${job.getId()}: ${error.message}, rolling back`);
    await job.remove().catch(async (removeError) => {
      log.warn(`[serenity-job-runner] Failed to roll back job ${job.getId()}: ${removeError.message}`);
      job.setStatus('FAILED');
      job.setError({ code: 'ENQUEUE_FAILED', message: error.message });
      // Best-effort: a failure here must never mask the original enqueue
      // error below — it only means the job record is left IN_PROGRESS
      // rather than marked FAILED.
      await job.save().catch((saveError) => {
        log.warn(`[serenity-job-runner] Failed to mark job ${job.getId()} as FAILED: ${saveError.message}`);
      });
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
  const { promiseToken, promisePair } = metadata;
  // The persisted token must be the typed object shape (Gap 2). A bare string
  // here would fail opaquely at `promiseToken?.promise_token` below; assert it
  // up front so the failure names the real cause.
  assertTypedPromiseToken(promiseToken);
  const enableEncryption = !!context.env?.AUTOFIX_CRYPT_SECRET
    && !!context.env?.AUTOFIX_CRYPT_SALT;

  const consumerClient = ImsPromiseClient.createFrom(
    context,
    ImsPromiseClient.CLIENT_TYPE.CONSUMER,
    { pair: promisePair },
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
  const { promiseToken, promisePair } = job.getMetadata() ?? {};
  if (!promiseToken?.promise_token) {
    return;
  }

  const enableEncryption = !!context.env?.AUTOFIX_CRYPT_SECRET
    && !!context.env?.AUTOFIX_CRYPT_SALT;
  const consumerClient = ImsPromiseClient.createFrom(
    context,
    ImsPromiseClient.CLIENT_TYPE.CONSUMER,
    { pair: promisePair },
  );

  try {
    await consumerClient.invalidatePromiseToken(promiseToken.promise_token, enableEncryption);
  } catch (error) {
    context.log?.warn(`[serenity-job-runner] Failed to invalidate promise token for job ${job.getId()}: ${error.message}`);
  }

  // Scrub the token from the record regardless of whether the invalidate call
  // itself succeeded — the caller persists this via its own job.save(). A dead
  // job record should not retain a credential indefinitely at rest.
  const metadata = { ...(job.getMetadata() ?? {}) };
  delete metadata.promiseToken;
  job.setMetadata(metadata);
}
