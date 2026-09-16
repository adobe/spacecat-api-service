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
import { assertChainedJobStillApplies } from './chained-job-guard.js';
import { orchestrateActivateMarkets } from './activate-markets-orchestration.js';
import { enqueueMarketGenerations } from '../async-prompt-gen.js';

/**
 * Job type dispatched to {@link activateMarketsJobHandler} by the runner
 * (`src/serenity-prompt-classification/index.js`). PR-C (LLMO-7352/LLMO-7418): the second phase
 * of the async `/serenity/activate` project-activation flow — enqueued by
 * `provision-workspace-job.js` as its `chainedJobType` once the sub-workspace it depends on is
 * confirmed `ready`, never enqueued directly by an HTTP controller.
 */
export const ACTIVATE_MARKETS_JOB_TYPE = 'serenity-activate-markets';

/**
 * Runs the FULL activate market batch against an ALREADY-READY workspace — this job only ever
 * exists as the second half of a chain started by `provision-workspace-job.js`, so `workspaceId`
 * (merged into this job's metadata by the chain-enqueue) is passed straight through as
 * `preResolvedWorkspaceId`: {@link orchestrateActivateMarkets} then skips its own
 * `ensureSubworkspace` call entirely, exactly like the synchronous `activate` endpoint's default
 * branch does today.
 *
 * @param {object} context - worker context (`dataAccess`, `env`, `log`).
 * @param {object} job - the current `AsyncJob`. `job.getMetadata()` carries
 *   `{ brandId, workspaceId, parentWorkspaceId, orgId, requestBody, callerId? }` (the
 *   chain-enqueue's `chainedJobMetadata`, plus `workspaceId` merged in by
 *   `provision-workspace-job.js`) — no `promiseToken`/`promisePair` handling here; this job never
 *   self-requeues.
 * @param {string} accessToken - already-exchanged Semrush access token.
 * @returns {Promise<object>} the same `{ status, body }` shape {@link orchestrateActivateMarkets}
 *   itself returns — surfaced verbatim as this AsyncJob's `result`, so a client polling for the
 *   job's outcome sees the exact response shape the synchronous endpoint would have returned.
 */
export async function activateMarketsJobHandler(context, job, accessToken) {
  const { dataAccess, env, log } = context;
  const metadata = job.getMetadata() ?? {};
  const {
    brandId,
    workspaceId,
    parentWorkspaceId,
    orgId,
    requestBody,
    callerId = 'unknown',
  } = metadata;

  // A deactivate can land between the provisioning worker promoting this workspace and this
  // chained job running. Deactivate decommissions the workspace and clears the pointer; acting
  // anyway would create and publish a live project inside it. The orchestration cannot catch
  // this for us — we pass `preResolvedWorkspaceId`, which makes ensureSubworkspace skip its own
  // pointer read entirely.
  const stillApplies = await assertChainedJobStillApplies({
    brandId,
    workspaceId,
    postgrestClient: dataAccess?.services?.postgrestClient,
    log,
    jobName: 'activate-markets-job',
  });
  if (!stillApplies.ok) {
    return { status: 207, body: { brandId, status: 'superseded', markets: [] } };
  }

  const transport = createSerenityTransport({ env, imsToken: accessToken });

  const result = await orchestrateActivateMarkets({
    dataAccess,
    env,
    orgId,
    transport,
    brandUuid: brandId,
    parentWorkspaceId,
    requestBody,
    log,
    preResolvedWorkspaceId: workspaceId,
    callerId,
  });

  // Same handoff the synchronous activate performs, through the SAME helper, so the two paths
  // cannot drift (#3194/#3252). The token is the one difference: there is no request here to
  // mint from, so forward the one this job already holds.
  const generationsEnqueued = await enqueueMarketGenerations(
    { ...context, params: { ...(context.params || {}), spaceCatId: orgId } },
    {
      inputs: result.generationInputs,
      markets: result.body?.markets,
      transport,
      brandUuid: brandId,
      log,
      promiseToken: metadata.promiseToken,
      callerId,
      imsOrgId: orgId,
    },
  );

  // Strip the internal handoff before this becomes the AsyncJob's stored result — it is served
  // verbatim to any client polling the job and carries the brand's workspace id and aliases.
  const { generationInputs: _, ...jobResult } = result;
  // Any generation job enqueued above carries THIS job's promise token. Tell the runner, or it
  // invalidates that token by identity on terminal state and every one of those jobs fails its
  // exchange. The runner strips this flag before storing the result.
  return generationsEnqueued > 0 ? { ...jobResult, tokenHandedOff: true } : jobResult;
}
