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

import { ErrorWithStatusCode } from '../../utils.js';
import { createSerenityTransport } from '../rest-transport.js';
import {
  createAndEnqueueJob,
  retryableJobError,
  isRetryableJobError,
  PROMISE_PAIR_SEMRUSH,
} from '../async-job-runner.js';
import { isUpstreamGone } from '../errors.js';
import { handleBulkDeletePrompts, BULK_PROMPTS_MAX_ITEMS } from './prompts.js';
import { handleBulkDeletePromptsSubworkspace } from './prompts-subworkspace.js';

// Stored (internal) job type the worker dispatches on, and the public type the
// job-status endpoint reports back to the UI.
export const BULK_DELETE_JOB_TYPE = 'serenity-bulk-delete';
export const BULK_DELETE_PUBLIC_JOB_TYPE = 'bulkDelete';

/**
 * Producer: validate the delete request and enqueue it as an async job, returning
 * 202 + jobId. The synchronous delete+publish for a large brand can exceed the
 * ~15s Fastly edge budget (the Lambda itself has a 900s budget), so the client
 * sees a 503 while the work keeps running; moving it to the job runner lets the
 * mutation complete out-of-band and the UI poll for the outcome (#3287).
 *
 * @param {object} params
 * @param {object} params.context - request context (dataAccess, env, log).
 * @param {string} params.brandId - resolved brand UUID.
 * @param {string} params.orgId - SpaceCat organization id (spaceCatId).
 * @param {string} params.workspaceId - Semrush workspace id.
 * @param {boolean} params.subworkspace - whether the brand is on a sub-workspace.
 * @param {any} params.body - request body ({ prompts: [...] }).
 * @param {string} params.callerId - resolved requester id for the audit trail.
 * @param {{ promise_token: string, expires_in?: number, token_type?: string }} params.promiseToken
 * @param {string} params.promisePair
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function acceptBulkDelete({
  context,
  brandId,
  orgId,
  workspaceId,
  subworkspace,
  body,
  callerId,
  promiseToken,
  promisePair,
}) {
  const targets = Array.isArray(body?.prompts) ? body.prompts : [];
  if (targets.length === 0) {
    throw new ErrorWithStatusCode('Body must include a non-empty prompts array', 400);
  }
  if (targets.length > BULK_PROMPTS_MAX_ITEMS) {
    throw new ErrorWithStatusCode(
      `prompts array exceeds maxItems=${BULK_PROMPTS_MAX_ITEMS}`,
      400,
    );
  }

  const job = await createAndEnqueueJob(context, {
    jobType: BULK_DELETE_JOB_TYPE,
    requirePair: PROMISE_PAIR_SEMRUSH,
    promiseToken,
    promisePair,
    metadata: {
      brandId,
      orgId,
      workspaceId,
      subworkspace: subworkspace === true,
      callerId,
      targets,
    },
  });

  return {
    status: 202,
    body: {
      jobId: job.getId(),
      status: job.getStatus?.() ?? 'IN_PROGRESS',
      jobType: BULK_DELETE_PUBLIC_JOB_TYPE,
    },
  };
}

/**
 * Consumer: runs the delete + publish for the enqueued job using the worker's
 * exchanged access token, then records the same `{ deleted, failed }` result the
 * synchronous handler returns onto the job for the poller to read. Reuses the
 * existing delete logic verbatim, so behaviour (idempotent already-gone deletes,
 * per-target failures, publish reconciliation) is unchanged — only the execution
 * context moves off the edge-bounded request path.
 *
 * @param {object} context
 * @param {object} job - AsyncJob instance.
 * @param {string} accessToken - Semrush access token exchanged by the runner.
 * @param {object} [injectedTransport] - test seam.
 */
export async function bulkDeleteHandler(context, job, accessToken, injectedTransport) {
  const { log } = context;
  const metadata = job.getMetadata?.() ?? {};
  const {
    brandId, orgId, workspaceId, subworkspace, callerId, targets,
  } = metadata;
  const transport = injectedTransport
    ?? createSerenityTransport({ env: context.env, imsToken: accessToken });

  try {
    const result = subworkspace === true
      ? await handleBulkDeletePromptsSubworkspace(
        transport,
        workspaceId,
        { prompts: targets },
        log,
        {
          orgId, brandId, env: context.env, callerId,
        },
      )
      : await handleBulkDeletePrompts(
        transport,
        context.dataAccess,
        brandId,
        workspaceId,
        { prompts: targets },
        log,
        { orgId, env: context.env, callerId },
      );
    job.setResult(result);
    job.setStatus('COMPLETED');
    await job.save();
  } catch (error) {
    // A transient failure of the whole batch (a marked retryable error, or a 5xx
    // that is not an already-gone workspace) is worth a redelivery; a deterministic
    // one fails the job so the poller surfaces it. Per-target upstream failures
    // never reach here — the delete handler collects those into result.failed and
    // returns normally.
    const transient = isRetryableJobError(error)
      || (!isUpstreamGone(error) && Number(error?.status) >= 500);
    if (transient) {
      throw retryableJobError(`bulk-delete job ${job.getId()} failed transiently`, error);
    }
    job.setStatus('FAILED');
    job.setError({
      code: error?.code || 'BULK_DELETE_FAILED',
      message: error?.message || 'Bulk delete failed',
      retryable: false,
    });
    await job.save();
  }
}
