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

import { NEEDS_REAUTH_ERROR_CODE } from './async-job-runner.js';
import {
  enqueueSemrushMarketGeneration,
  SEMRUSH_MARKET_GENERATION_PUBLIC_JOB_TYPE,
} from './handlers/semrush-market-generation-job.js';

/**
 * Controller-side helpers for the async Semrush-market prompt-generation surface
 * (#3194): the rollout flag, the STRICT reauth caller-identity resolver, and the
 * token-safe polling DTO. Kept out of the controller so each is unit-testable in
 * isolation and the "never leak a token" projection is pinned by its own test.
 */

/** Env flag gating whether the entry points enqueue async generation. */
export const ASYNC_PROMPT_GEN_FLAG = 'SERENITY_ASYNC_PROMPT_GEN';

/**
 * True only when the rollout flag is explicitly `'true'`. Default-off: with the
 * flag unset the three entry points keep their existing synchronous behavior, so
 * this feature adds no breaking change until an environment turns it on
 * (coordinated with the queue in infra#780 and the polling UI in elmo#3071).
 * @param {Record<string, any>|undefined} env
 * @returns {boolean}
 */
export function isAsyncPromptGenEnabled(env) {
  return String(env?.[ASYNC_PROMPT_GEN_FLAG] ?? '').toLowerCase() === 'true';
}

/**
 * Resolves the caller's IMS user id from a SINGLE stable claim (`user_id`) — the
 * authorization-grade resolver for reauth (Gap 6). Deliberately NOT the permissive
 * `resolveCallerImsUserId`, whose own docstring warns it reads `user_id`/`sub`/`email`
 * interchangeably for DISPLAY and is "not an authorization signal". Fails closed
 * (returns null) when the stable claim is absent, so an unresolvable identity can
 * never satisfy the reauth equality check.
 * @param {object} context
 * @returns {string|null}
 */
export function resolveStableImsUserId(context) {
  const profile = context?.attributes?.authInfo?.getProfile?.();
  const raw = profile?.user_id;
  return (typeof raw === 'string' && raw.length > 0) ? raw : null;
}

/**
 * Strict, fail-closed reauth authorization: the re-authenticating caller must be
 * the SAME IMS user that originally enqueued the job. Fails closed if either the
 * stored or the current stable id is unresolvable, or they differ.
 * @param {string|null|undefined} originalImsUserId - stored at enqueue.
 * @param {string|null|undefined} callerImsUserId - resolved now via {@link resolveStableImsUserId}.
 * @returns {boolean}
 */
export function callerMayReauth(originalImsUserId, callerImsUserId) {
  return typeof originalImsUserId === 'string' && originalImsUserId.length > 0
    && typeof callerImsUserId === 'string' && callerImsUserId.length > 0
    && originalImsUserId === callerImsUserId;
}

/**
 * The additive, non-breaking annotation returned to a client on the create/activate
 * response when async generation is enqueued, so the UI (elmo#3071) can poll.
 * @typedef {{ jobId: string, status: 'provisioning', reused: boolean }} PromptGenerationHandle
 */

/**
 * Shared entry-point wiring: the SINGLE place all three producers-callers
 * (createMarket, activate, createBrandForOrg) delegate to when the async rollout
 * flag is on and the caller asked to generate prompts. Resolves the original
 * caller's stable IMS id here (for later reauth), invokes the producer, and maps
 * its result to the client-facing `promptGeneration` handle — or null when there
 * is nothing to poll (feature off, not requested, or an empty catalogue).
 *
 * @param {object} context - request context.
 * @param {object} args
 * @param {boolean} args.enabled - `isAsyncPromptGenEnabled(env)`.
 * @param {boolean} args.generateRequested - the caller's `generatePrompts` flag.
 * @param {object} args.producerParams - the remaining producer params (transport,
 *   brandId, siteId, imsOrgId, workspaceId, geoTargetId, languageCode, market,
 *   brandDomain, baseUrl, subpath, brand, aliases, callerId).
 * @returns {Promise<PromptGenerationHandle|null>}
 */
export async function maybeEnqueueMarketGeneration(context, {
  enabled, generateRequested, producerParams,
}) {
  if (!enabled || !generateRequested) {
    return null;
  }
  const result = await enqueueSemrushMarketGeneration(context, {
    ...producerParams,
    imsUserId: resolveStableImsUserId(context),
  });
  if (!result.enqueued && !result.reused) {
    // No catalogue seeds → nothing generated; the market stands without prompts.
    return null;
  }
  return {
    jobId: /** @type {string} */ (result.jobId),
    status: 'provisioning',
    reused: result.reused === true,
  };
}

/**
 * Projects a token-SAFE polling DTO from a generation job. NEVER spreads raw
 * metadata (which carries the promise token) and never returns the internal
 * `result`/`error` verbatim — only an explicit field allowlist.
 * @param {object} job - an AsyncJob instance.
 * @returns {object}
 */
export function toGenerationJobDto(job) {
  const status = job.getStatus();
  const rawResult = status === 'COMPLETED' ? (job.getResult?.() ?? null) : null;
  const rawError = status === 'FAILED' ? (job.getError?.() ?? null) : null;

  const result = rawResult
    ? {
      promptCount: rawResult.promptCount,
      projectId: rawResult.projectId,
      published: rawResult.published === true,
      verdict: rawResult.verdict,
    }
    : null;

  const error = rawError
    ? {
      code: rawError.code,
      message: rawError.message,
      retryable: rawError.retryable === true,
      // Surface the actionable reauth signal so the UI can prompt re-authentication.
      needsReauth: rawError.code === NEEDS_REAUTH_ERROR_CODE,
    }
    : null;

  return {
    jobId: job.getId(),
    jobType: SEMRUSH_MARKET_GENERATION_PUBLIC_JOB_TYPE,
    status,
    result,
    error,
    createdAt: job.getCreatedAt?.(),
    updatedAt: job.getUpdatedAt?.(),
  };
}
