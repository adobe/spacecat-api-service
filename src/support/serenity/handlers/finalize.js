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

import { hasText } from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode } from '../../utils.js';
import { handleCreatePrompts } from './prompts.js';
import { handleUpdateModels } from './markets.js';
import { pollProjectPublished, PUBLISH_OUTCOME } from './publish-status.js';

/**
 * LLMO-5492 — publish-after-populate finalize step.
 *
 * Runs when DRS/Brandalf prompt-generation completes for a brand. The brand's
 * Semrush projects were provisioned as drafts by the onboarding fan-out
 * (defer-publish on); this step populates and then publishes them once:
 *
 *   1. push generated prompts (reuses handleCreatePrompts, publish deferred),
 *   2. set the selected LLMs/models per slice (reuses handleUpdateModels),
 *   3. publish each of the brand's projects exactly once.
 *
 * It is resilient by design: a per-slice model failure or a per-project publish
 * failure is recorded and the remaining work still runs, so a partial DRS
 * payload still makes forward progress.
 *
 * Publish is gated on population: if prompts were requested but every push
 * failed, the publish step is skipped so we never publish an empty project
 * (the bug this ticket fixes). A models-only or no-payload call still publishes
 * the brand's existing drafts.
 *
 * Retry semantics differ per step. Model sync (diff-based) and publish are
 * idempotent. Prompt push is NOT: handleCreatePrompts unconditionally creates
 * each input upstream, so a re-fire would duplicate prompts in Semrush. The
 * DRS-completion *trigger* (an audit-worker/SQS job, a separate repo) must
 * therefore deliver the prompt payload exactly once — it is intentionally NOT
 * wired here; this is the reusable mechanism it will call.
 *
 * @param {object} transport - Serenity REST transport.
 * @param {object} dataAccess - SpaceCat data-access layer.
 * @param {string} brandId - Brand whose projects to finalize.
 * @param {string} semrushWorkspaceId - Org's Semrush workspace id.
 * @param {object} body - { prompts?: Array, models?: Array<{geoTargetId, languageCode, modelIds}> }
 * @param {object} [log] - Logger.
 * @param {object} [options] - Publish-confirm tuning (AC3).
 * @param {number} [options.confirmAttempts=1] - Max getProjectStatus reads per
 *   project after publish (bounded to the Lambda budget; the unbounded ≤900s
 *   reconcile loop is the DRS/worker's job, not this Lambda's).
 * @param {number} [options.confirmIntervalMs=0] - Delay between confirm reads.
 * @returns {Promise<{prompts: object, models: Array, published: string[], publishFailed: Array}>}
 */
export async function finalizeSerenityProjects(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
  options = {},
) {
  if (!hasText(brandId)) {
    throw new ErrorWithStatusCode('brandId is required', 400);
  }
  if (!hasText(semrushWorkspaceId)) {
    throw new ErrorWithStatusCode('semrushWorkspaceId is required', 400);
  }

  // 1. Push prompts. publish:false so the single authoritative publish happens
  //    in step 3 after models are also set — never an empty/half-populated
  //    publish.
  let prompts = { created: [], skipped: [], failed: [] };
  const promptInputs = Array.isArray(body?.prompts) ? body.prompts : [];
  if (promptInputs.length > 0) {
    prompts = await handleCreatePrompts(
      transport,
      dataAccess,
      brandId,
      semrushWorkspaceId,
      { prompts: promptInputs },
      log,
      { publish: false },
    );
  }

  // 2. Set models per slice. A per-slice failure is recorded, not fatal — the
  //    remaining slices and the publish step still run.
  const models = [];
  const modelSlices = Array.isArray(body?.models) ? body.models : [];
  for (const slice of modelSlices) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await handleUpdateModels(
        transport,
        dataAccess,
        brandId,
        semrushWorkspaceId,
        slice,
        log,
      );
      models.push({
        geoTargetId: slice?.geoTargetId,
        languageCode: slice?.languageCode,
        status: 200,
        items: result.items,
      });
    } catch (e) {
      log?.error?.('finalizeSerenityProjects: set models failed for slice', {
        brandId,
        geoTargetId: slice?.geoTargetId,
        languageCode: slice?.languageCode,
        error: e.message,
      });
      models.push({
        geoTargetId: slice?.geoTargetId,
        languageCode: slice?.languageCode,
        status: e.status || 500,
        error: e.message,
      });
    }
  }

  // Don't publish empty: if prompts were requested but every push failed, the
  // projects are still empty drafts — publishing would re-introduce the exact
  // empty-publish bug this ticket fixes. Skip publish and surface it loudly so
  // the trigger can retry the prompt push. (A models-only or no-prompt call has
  // nothing to gate on and proceeds.)
  const promptsRequested = promptInputs.length > 0;
  if (promptsRequested && prompts.created.length === 0) {
    log?.warn?.(
      'finalizeSerenityProjects: every prompt push failed — skipping publish to avoid '
      + 'publishing empty projects',
      {
        brandId,
        promptsFailed: prompts.failed.length,
        promptsSkipped: prompts.skipped.length,
      },
    );
    return {
      prompts, models, published: [], publishFailed: [],
    };
  }

  // 3. Publish once per distinct project across the brand's slices. Every slice
  //    was provisioned as a draft, so this is the step that makes the now
  //    populated projects live. Dedupe so a project shared by multiple slices
  //    (defensive — slices map 1:1 to projects today) is published only once.
  const rows = (await dataAccess.BrandSemrushProject.allByBrandId(brandId)) || [];
  const projectIds = [...new Set(
    rows.map((r) => r.getSemrushProjectId()).filter((id) => hasText(id)),
  )];
  // AC3: publish is async (202) with no completion webhook. After the publish
  // is accepted we do a BOUNDED, best-effort confirm via the project's
  // `publish_status` (handlers/publish-status.js). The bound stays inside the
  // Lambda wall budget — the unbounded ≤900s reconcile poll is the DRS/worker's
  // job. Confirm semantics:
  //   - confirmed live                → published
  //   - initial_publish_failed        → publishFailed (terminal, surfaced early)
  //   - still draft/publishing/unknown within budget, OR status unreadable
  //                                    → published (accepted; the worker
  //                                      reconciles) — we do NOT mislabel an
  //                                      in-progress async publish as a failure.
  const { confirmAttempts = 1, confirmIntervalMs = 0 } = options;
  const canConfirm = typeof transport.getProjectStatus === 'function';
  const published = [];
  const publishFailed = [];
  for (const projectId of projectIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await transport.publishProject(semrushWorkspaceId, projectId);
    } catch (e) {
      log?.error?.('finalizeSerenityProjects: publish failed', {
        brandId,
        projectId,
        error: e.message,
      });
      publishFailed.push({ projectId, error: e.message });
      // eslint-disable-next-line no-continue
      continue;
    }

    if (!canConfirm) {
      published.push(projectId);
      // eslint-disable-next-line no-continue
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const confirm = await pollProjectPublished(transport, semrushWorkspaceId, projectId, {
      attempts: confirmAttempts,
      intervalMs: confirmIntervalMs,
      log,
    });
    if (confirm.outcome === PUBLISH_OUTCOME.FAILED) {
      log?.error?.('finalizeSerenityProjects: publish reported failed by upstream', {
        brandId,
        projectId,
        publishStatus: confirm.status,
        failedReason: confirm.failedReason,
      });
      publishFailed.push({
        projectId,
        error: confirm.failedReason || confirm.status || 'initial_publish_failed',
        publishStatus: confirm.status,
      });
    } else {
      // published (confirmed live) or pending (accepted, worker reconciles).
      published.push(projectId);
    }
  }

  log?.info?.('finalizeSerenityProjects: complete', {
    brandId,
    promptsCreated: prompts.created.length,
    promptsFailed: prompts.failed.length,
    promptsSkipped: prompts.skipped.length,
    modelSlices: models.length,
    modelSlicesFailed: models.filter((m) => m.status !== 200).length,
    published: published.length,
    publishFailed: publishFailed.length,
  });

  return {
    prompts, models, published, publishFailed,
  };
}
