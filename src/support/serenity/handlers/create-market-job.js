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
import { orchestrateCreateMarketSubworkspace } from './create-market-orchestration.js';
import { maybeEnqueueMarketGeneration } from '../async-prompt-gen.js';

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
    jobName: 'create-market-job',
  });
  if (!stillApplies.ok) {
    return { status: 207, body: { brandId, status: 'superseded', markets: [] } };
  }

  const transport = createSerenityTransport({ env, imsToken: accessToken });

  const result = await orchestrateCreateMarketSubworkspace({
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

  // Async prompt generation (#3194/#3252) for a market created through the CHAIN rather than
  // in-request. Without this, turning that feature on would leave every async-created market
  // generating prompts the old inline way -- the low-quality catalogue-string output it exists
  // to remove -- while synchronously-created markets got the DRS-generated ones. Same product,
  // two prompt qualities, decided by a code path the user never sees and reported by nothing.
  //
  // The token is the reason this cannot simply call the same helper the controller does: there
  // is no request here, so `getIMSPromiseToken` has no Authorization header to mint from. Pass
  // the one this job already holds, exactly as the chain's own hops forward it.
  let tokenHandedOff = false;
  if (result.generationInputs) {
    try {
      const org = await dataAccess.Organization?.findById?.(orgId);
      const promptGeneration = await maybeEnqueueMarketGeneration(
        { ...context, params: { ...(context.params || {}), spaceCatId: orgId } },
        {
          enabled: true,
          generateRequested: true,
          producerParams: {
            ...result.generationInputs,
            transport,
            imsOrgId: org?.getImsOrgId?.() ?? orgId,
            callerId,
            promiseToken: metadata.promiseToken,
          },
        },
      );
      if (promptGeneration) {
        result.body = { ...result.body, promptGeneration };
        // This job's promise token now belongs to the generation job too. Say so, or the runner
        // invalidates it by identity on terminal state and that job's copy is dead before it is
        // ever exchanged — the runner strips this flag before storing the result.
        tokenHandedOff = true;
      }
    } catch (e) {
      // Best-effort, same as the synchronous path: the market is created and published, and a
      // producer hiccup must not turn that into a failed job.
      log?.warn?.('create-market-job: async prompt-generation enqueue failed (non-fatal)', {
        brandId, error: e?.message,
      });
    }
  }
  // Strip the internal enqueue inputs before this becomes the AsyncJob's stored result: that
  // result is served verbatim to any client polling the job, and `generationInputs` carries the
  // brand's Semrush workspace id and alias set -- internal state this epic is otherwise careful
  // never to expose (see the job-status endpoint's "secret-free by design" contract).
  const { generationInputs: _, ...jobResult } = result;
  return tokenHandedOff ? { ...jobResult, tokenHandedOff: true } : jobResult;
}
