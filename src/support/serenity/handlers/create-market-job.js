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

import { createSerenityTransport } from '../rest-transport.js';
import { orchestrateCreateMarketSubworkspace } from './create-market-orchestration.js';

/**
 * Job type dispatched to {@link createMarketJobHandler} by the runner
 * (`src/serenity-prompt-classification/index.js`). PR-C (LLMO-7352/LLMO-7418): the second phase
 * of a market-creating conversion endpoint's async flow — enqueued by
 * `provision-workspace-job.js` as its `chainedJobType` once the sub-workspace it depends on is
 * confirmed `ready`, never enqueued directly by an HTTP controller.
 */
export const CREATE_MARKET_JOB_TYPE = 'serenity-create-market';

/**
 * Runs the FULL create-a-market orchestration against an ALREADY-READY workspace — this job
 * only ever exists as the second half of a chain started by `provision-workspace-job.js`, so
 * `workspaceId` (merged into this job's metadata by the chain-enqueue) is passed straight through
 * as `preResolvedWorkspaceId`: {@link orchestrateCreateMarketSubworkspace} then skips its own
 * `ensureSubworkspace` call entirely, exactly like the synchronous `activate` batch-loop's
 * per-market calls do today.
 *
 * @param {object} context - worker context (`dataAccess`, `env`, `log`).
 * @param {object} job - the current `AsyncJob`. `job.getMetadata()` carries
 *   `{ brandId, workspaceId, parentWorkspaceId, orgId, requestBody, suppliedSiteIdentity?,
 *   suppliedSiteId?, callerId?, modelIds? }` (the chain-enqueue's `chainedJobMetadata`, plus
 *   `workspaceId` merged in by `provision-workspace-job.js`) — no `promiseToken`/`promisePair`
 *   handling here; this job never self-requeues. `modelIds` (PR-C, LLMO-7352/LLMO-7418) is the
 *   brand-create chain's explicit `semrushModelIds` override for a brand's very first market;
 *   Add Market's own chain never sets it, letting {@link orchestrateCreateMarketSubworkspace}
 *   fall back to its existing-market auto-resolve.
 * @param {string} accessToken - already-exchanged Semrush access token.
 * @returns {Promise<object>} the same `{ status, body }` shape
 *   {@link orchestrateCreateMarketSubworkspace} itself returns — surfaced verbatim as this
 *   AsyncJob's `result`, so a client polling for the job's outcome sees the exact response shape
 *   the synchronous endpoint would have returned.
 */
export async function createMarketJobHandler(context, job, accessToken) {
  const { dataAccess, env, log } = context;
  const metadata = job.getMetadata() ?? {};
  const {
    brandId,
    workspaceId,
    parentWorkspaceId,
    orgId,
    requestBody,
    suppliedSiteIdentity = null,
    suppliedSiteId = null,
    callerId = 'unknown',
    modelIds = null,
  } = metadata;

  const transport = createSerenityTransport({ env, imsToken: accessToken });

  return orchestrateCreateMarketSubworkspace({
    dataAccess,
    env,
    orgId,
    transport,
    brandUuid: brandId,
    parentWorkspaceId,
    workspaceId,
    requestBody,
    log,
    suppliedSiteIdentity,
    suppliedSiteId,
    preResolvedWorkspaceId: workspaceId,
    callerId,
    modelIds,
  });
}
