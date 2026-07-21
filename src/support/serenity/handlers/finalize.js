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

import { hasText } from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode } from '../../utils.js';
import { ERROR_CODES, isMeteredQuota } from '../errors.js';
import { handleCreatePrompts } from './prompts.js';
import { handleUpdateModels } from './markets.js';
import { pollProjectPublished, PUBLISH_OUTCOME } from './publish-status.js';

// Slice identity shared between the model results (echoed from body.models) and
// the DB rows (canonical). Normalise both sides — geoTargetId may arrive as a
// string from the trigger payload; languageCode casing is not guaranteed.
const sliceKey = (geoTargetId, languageCode) => `${Number(geoTargetId)}::${String(languageCode ?? '').toLowerCase()}`;

/**
 * LLMO-5492 — publish-after-populate finalize step.
 *
 * Runs when DRS/Brandalf prompt-generation completes for a brand. The brand's
 * Semrush projects were provisioned as drafts by the sub-workspace create path
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
 * Publish is gated on population — Semrush does NO content validation on publish
 * (an empty project goes live), so the populate gate is entirely ours
 * (serenity-docs §5). A project is published only when BOTH hold:
 *   - prompts: if prompts were requested for the brand, at least one was created
 *     (every-push-failed → skip, reason `noPrompts`); and
 *   - models: that project's slice ended with >=1 model set (reason `noModels`
 *     otherwise). Per Semrush's official setup sequence, model creation is a
 *     mandatory pre-publish step (serenity-docs §10 step 4 precedes step 6).
 *
 * DEFAULT-MODEL POLICY (trigger contract): finalize does NOT invent a fallback
 * model set. `body.models` is owned by the DRS-completion trigger, which MUST
 * supply >=1 model per slice it wants published. A slice that arrives with no
 * models is left as an unpublished draft (recorded `publishSkipped`/`noModels`
 * and logged) rather than published with an arbitrary default. So an empty
 * `body.models` publishes nothing — the gate enforcing the contract.
 *
 * PUBLISH IS ASYNC (202 "accepted" != "observed live"). The bounded confirm only
 * promotes a project to `published` when `publish_status` is read back as live.
 * A 202 we could not confirm live in-budget goes to `publishPending` (NOT
 * `published`) for the worker reconcile to resolve — consumers must not read a
 * pending publish as live. A zero-`ai.projects`-quota rejection (405 + text/html)
 * is a PERMANENT failure: `publishFailed` with `permanent: true` (alert, no retry).
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
 * @param {function} [classifyPromptType] - Branded/non-branded classifier threaded
 *   into handleCreatePrompts (the caller builds it from the brand's aliases, same
 *   as the create/prompt endpoints).
 * @param {object} [options] - Publish-confirm tuning (AC3).
 * @param {number} [options.confirmAttempts=1] - Max getProjectStatus reads per
 *   project after publish (bounded to the Lambda budget; the unbounded ≤900s
 *   reconcile loop is the DRS/worker's job, not this Lambda's).
 * @param {number} [options.confirmIntervalMs=0] - Delay between confirm reads.
 * @returns {Promise<{prompts: object, models: Array, published: string[],
 *   publishPending: Array, publishSkipped: Array, publishFailed: Array}>}
 */
export async function finalizeSerenityProjects(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
  classifyPromptType,
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
  /** @type {{created: Array, skipped: Array, failed: Array}} */
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
      classifyPromptType,
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
        // Publish stays deferred to step 3 — handleUpdateModels must not push
        // a per-slice publish of its own here.
        { publish: false },
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

  // Resolve the brand's project rows once — needed by both populate gates and
  // the publish loop. Dedupe projectId → its slice(s) so a project shared by
  // multiple slices (defensive — slices map 1:1 to projects today) is handled
  // exactly once.
  const rows = (await dataAccess.BrandSemrushProject.allByBrandId(brandId)) || [];
  const projectSlices = new Map();
  for (const r of rows) {
    const id = r.getSemrushProjectId();
    if (!hasText(id)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!projectSlices.has(id)) {
      projectSlices.set(id, []);
    }
    projectSlices.get(id).push({
      geoTargetId: r.getGeoTargetId(),
      languageCode: r.getLanguageCode(),
    });
  }

  const published = [];
  const publishPending = [];
  const publishSkipped = [];
  const publishFailed = [];

  const result = () => {
    log?.info?.('finalizeSerenityProjects: complete', {
      brandId,
      promptsCreated: prompts.created.length,
      promptsFailed: prompts.failed.length,
      promptsSkipped: prompts.skipped.length,
      modelSlices: models.length,
      modelSlicesFailed: models.filter((m) => m.status !== 200).length,
      published: published.length,
      publishPending: publishPending.length,
      publishSkipped: publishSkipped.length,
      publishFailed: publishFailed.length,
    });
    return {
      prompts, models, published, publishPending, publishSkipped, publishFailed,
    };
  };

  // POPULATE GATE (prompts). Semrush does no content validation on publish, so
  // guarding against an empty publish is entirely ours. If prompts were
  // requested for the brand but every push failed, the projects are still empty
  // drafts — skip publish for ALL of them (the trigger retries the prompt push).
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
    for (const projectId of projectSlices.keys()) {
      publishSkipped.push({ projectId, reason: 'noPrompts' });
    }
    return result();
  }

  // POPULATE GATE (models) + trigger contract. Model creation is a mandatory
  // pre-publish step (serenity-docs §10). Build the set of slices that ended
  // with >=1 model; a project is publishable only if at least one of its slices
  // is in that set. A project with no models is left as a draft (publishSkipped /
  // noModels) — finalize never invents a default model set; the DRS trigger owns
  // supplying models. Empty body.models therefore publishes nothing.
  const slicesWithModels = new Set(
    models
      .filter((m) => m.status === 200 && Array.isArray(m.items) && m.items.length > 0)
      .map((m) => sliceKey(m.geoTargetId, m.languageCode)),
  );

  const publishable = [];
  for (const [projectId, slices] of projectSlices) {
    const hasModels = slices.some(
      (s) => slicesWithModels.has(sliceKey(s.geoTargetId, s.languageCode)),
    );
    if (hasModels) {
      publishable.push(projectId);
    } else {
      log?.warn?.(
        'finalizeSerenityProjects: skipping publish — no models set for project '
        + '(trigger contract: the DRS payload must supply >=1 model per slice to publish)',
        { brandId, projectId },
      );
      publishSkipped.push({ projectId, reason: 'noModels' });
    }
  }

  // 3. Publish once per publishable project. Publish is async (202) with no
  //    completion webhook; after it is accepted we do a BOUNDED confirm via the
  //    project's `publish_status` (the unbounded ≤900s reconcile is the worker's
  //    job). Bucketing — note `published` means CONFIRMED LIVE only:
  //      - confirmed live                → published
  //      - initial_publish_failed        → publishFailed (terminal)
  //      - 405 + text/html (no quota)    → publishFailed { permanent } (alert, no retry)
  //      - other publish error           → publishFailed (transient; retry/reconcile)
  //      - accepted but not confirmed live in-budget, OR status unreadable, OR
  //        no getProjectStatus            → publishPending (worker reconciles) —
  //        we never report an unconfirmed 202 as live.
  const { confirmAttempts = 1, confirmIntervalMs = 0 } = options;
  const canConfirm = typeof transport.getProjectStatus === 'function';
  for (const projectId of publishable) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await transport.publishProject(semrushWorkspaceId, projectId);
    } catch (e) {
      if (isMeteredQuota(e)) {
        log?.error?.(
          'finalizeSerenityProjects: publish rejected — workspace has no ai.projects quota '
          + '(PERMANENT, alert; not retried)',
          { brandId, projectId, code: ERROR_CODES.PUBLISH_QUOTA_EXHAUSTED },
        );
        publishFailed.push({
          projectId,
          error: 'publish rejected: workspace has no ai.projects quota',
          code: ERROR_CODES.PUBLISH_QUOTA_EXHAUSTED,
          permanent: true,
        });
      } else {
        log?.error?.('finalizeSerenityProjects: publish failed', {
          brandId,
          projectId,
          error: e.message,
        });
        publishFailed.push({ projectId, error: e.message });
      }
      // eslint-disable-next-line no-continue
      continue;
    }

    if (!canConfirm) {
      // Accepted (202) but we have no way to confirm it went live → pending.
      publishPending.push({ projectId, status: null });
      // eslint-disable-next-line no-continue
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const confirm = await pollProjectPublished(transport, semrushWorkspaceId, projectId, {
      attempts: confirmAttempts,
      intervalMs: confirmIntervalMs,
      log,
    });
    if (confirm.outcome === PUBLISH_OUTCOME.PUBLISHED) {
      published.push(projectId);
    } else if (confirm.outcome === PUBLISH_OUTCOME.FAILED) {
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
      // PENDING — accepted, but not confirmed live within budget (still
      // draft/publishing, or status unreadable). The worker reconcile resolves
      // it; until then it is explicitly NOT reported as live.
      publishPending.push({ projectId, status: confirm.status });
    }
  }

  return result();
}
