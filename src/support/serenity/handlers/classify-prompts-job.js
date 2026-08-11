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
import { createAndEnqueueJob } from '../async-job-runner.js';
import { brandNeedles, classifyBrandedTag } from '../branded-classifier.js';
import { marketForGeoTargetId } from '../locations.js';
import { getBrandAliases } from '../../brands-storage.js';
import { classifyPromptIntentsUnbounded } from '../async-intent-classification.js';
import { invalidateTagCacheForProject } from './markets.js';
import {
  normalizePromptInput,
  createOnePrompt,
  makePromptTagInjector,
  makeIntentInjector,
  mapLimit,
  publishAffected,
  BULK_CREATE_CONCURRENCY,
} from './prompts.js';
import { ORIGIN_VALUE } from '../prompt-tags.js';
import { resolveIntentValueInjection } from '../tag-tree.js';

/** @typedef {import('../rest-transport.js').SerenityTransport} SerenityTransport */

/**
 * Job type dispatched to {@link classifyPromptsHandler} by the runner
 * (`src/serenity-prompt-classification/index.js`).
 */
export const CLASSIFY_PROMPTS_JOB_TYPE = 'serenity-classify-prompts';

/**
 * Hard cap on self-requeue depth. Each requeue only carries forward prompts still
 * unresolved after a full `classifyPromptIntentsUnbounded` retry ladder, so a chain
 * this long means something is persistently wrong (e.g. Azure OpenAI down for an
 * extended period), not ordinary flakiness — after this many hops the remaining
 * items are left permanently pending (surfaced via `pendingClassificationCount`)
 * rather than requeuing forever.
 */
const MAX_REQUEUE_DEPTH = 5;

/**
 * Builds the same server-side `branded`/`non-branded` `type`-value classifier
 * the synchronous create path builds per request
 * (`src/controllers/serenity.js`'s `buildPromptTypeClassifier`) — deterministic
 * and cheap (serenity-docs#31), so the worker just re-derives it rather than
 * threading it through job metadata.
 *
 * Exported so the one-off re-classification sweep
 * (`scripts/serenity-retype-backfill.mjs`) classifies through the SAME closure the
 * write paths use, rather than reassembling needles itself. A second assembly is
 * how the four-way classifier divergence started; the sweep exists precisely to
 * correct that class of drift, so it must not introduce a fifth.
 *
 * @param {object} dataAccess - `context.dataAccess`.
 * @param {string} brandId - SpaceCat brand uuid.
 * @returns {Promise<(text: string, geoTargetId: number) => string>}
 */
export async function buildPromptTypeClassifier(dataAccess, brandId) {
  const brand = await dataAccess.Brand.findById(brandId);
  const brandName = brand?.getName?.() || '';
  const brandAliases = await getBrandAliases(brandId, dataAccess.services.postgrestClient);
  /** @type {Map<string, ReturnType<typeof brandNeedles>>} */
  const needlesByMarket = new Map();
  return (text, geoTargetId) => {
    const market = marketForGeoTargetId(geoTargetId) || '';
    let needles = needlesByMarket.get(market);
    if (!needles) {
      needles = brandNeedles(brandName, brandAliases, market);
      needlesByMarket.set(market, needles);
    }
    return classifyBrandedTag(text, needles);
  };
}

/**
 * Enqueues a fresh `serenity-classify-prompts` job scoped to just the prompts
 * still pending classification after this invocation (serenity-docs#33: "one
 * re-enqueue per handler invocation", not an in-loop retry). The re-enqueued
 * job carries `mode: 'reclassify'` — those prompts already exist upstream, so
 * the next run patches their tags in place rather than creating them again.
 *
 * Carries the CURRENT job's already-exchanged promise token forward explicitly
 * rather than letting `createAndEnqueueJob` mint a fresh one via
 * `getIMSPromiseToken` — that helper reads the caller's HTTP `Authorization`
 * header, which does not exist inside this SQS worker. Depth-guarded: stops
 * requeuing after {@link MAX_REQUEUE_DEPTH} hops rather than chaining forever.
 *
 * @param {object} context - worker context (`dataAccess`, `sqs`, `env`, `log`).
 * @param {object} job - the current `AsyncJob` being processed (its metadata
 *   carries the promise token and the current requeue depth).
 * @param {string} semrushWorkspaceId
 * @param {Array<{ projectId: string, promptId: string, text: string, tagIds: string[] }>} items
 * @returns {Promise<string|null>} the new job's id, or `null` if there was
 *   nothing to requeue, or the depth cap was reached.
 */
async function requeuePending(context, job, semrushWorkspaceId, items) {
  if (items.length === 0) {
    return null;
  }
  const currentMetadata = job.getMetadata() ?? {};
  const currentDepth = currentMetadata.requeueDepth ?? 0;
  if (currentDepth >= MAX_REQUEUE_DEPTH) {
    context.log?.warn(`[serenity-classify-prompts] Requeue depth ${currentDepth} reached max ${MAX_REQUEUE_DEPTH} for job ${job.getId()}; leaving ${items.length} prompt(s) permanently pending`);
    return null;
  }
  const newJob = await createAndEnqueueJob(context, {
    jobType: CLASSIFY_PROMPTS_JOB_TYPE,
    promiseToken: currentMetadata.promiseToken,
    metadata: {
      mode: 'reclassify', semrushWorkspaceId, items, requeueDepth: currentDepth + 1,
    },
  });
  return newJob.getId();
}

/**
 * `mode: 'create'` (default / absent `mode`): the CSV-import path. Classifies
 * every prompt text with no time budget, creates each prompt already carrying
 * its intent value (serenity-docs#33 steps 1-2), publishes every affected
 * project (step 3), and — for any prompt whose classification is still
 * unresolved after the unbounded retry ladder — creates it with NO value under
 * the `intent` root and requeues a `reclassify` job scoped to just those ids.
 *
 * @param {object} context
 * @param {object} job - the current `AsyncJob` (for the self-requeue's promise
 *   token and depth guard).
 * @param {SerenityTransport} transport - Serenity transport built from the exchanged
 *   access token.
 * @param {object} metadata - the job's metadata (`brandId`, `semrushWorkspaceId`,
 *   `prompts`).
 * @returns {Promise<object>} the job result.
 */
async function createAndClassify(context, job, transport, metadata) {
  const {
    dataAccess, env, log,
  } = context;
  // Authorship (LLMO-6289): the caller id captured at enqueue time in the create
  // controller, carried through the async job so classified-on-create prompts are
  // stamped with the human/service that submitted them, not the job runner.
  const { brandId, semrushWorkspaceId, callerId = 'unknown' } = metadata;
  const inputs = Array.isArray(metadata.prompts) ? metadata.prompts : [];

  const projects = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  const projectsBySlice = new Map();
  for (const p of projects || []) {
    projectsBySlice.set(`${p.getGeoTargetId()}:${p.getLanguageCode()}`, p);
  }

  const classifyPromptType = await buildPromptTypeClassifier(dataAccess, brandId);
  const injectComputedTags = makePromptTagInjector(
    transport,
    semrushWorkspaceId,
    classifyPromptType,
    log,
    { originValue: ORIGIN_VALUE.HUMAN },
  );

  // No time budget (serenity-docs#33): retries with backoff until resolved or
  // exhausted, never a shared-deadline default.
  const intentByText = await classifyPromptIntentsUnbounded(
    inputs.map((raw) => String(raw?.text || '').trim()),
    { env, log },
  );
  const injectComputedIntent = makeIntentInjector(transport, semrushWorkspaceId, intentByText, log);

  const results = await mapLimit(inputs, BULK_CREATE_CONCURRENCY, async (raw) => {
    const { value: input, reason } = normalizePromptInput(raw);
    if (!input) {
      return { skipped: { text: String(raw?.text || ''), reason: /** @type {string} */ (reason) } };
    }
    const project = projectsBySlice.get(`${input.geoTargetId}:${input.languageCode}`);
    if (!project) {
      return {
        skipped: {
          text: input.text,
          reason: `No market for slice (${input.geoTargetId}, ${input.languageCode})`,
        },
      };
    }
    const projectId = project.getSemrushProjectId();
    try {
      let typed = await injectComputedTags(projectId, input);
      typed = await injectComputedIntent(projectId, typed);
      const semrushPromptId = await createOnePrompt(
        transport,
        semrushWorkspaceId,
        projectId,
        typed,
        callerId,
      );
      const intentPending = intentByText.get(input.text) === null;
      return {
        created: {
          semrushPromptId,
          geoTargetId: typed.geoTargetId,
          languageCode: input.languageCode,
          text: typed.text,
          tagIds: typed.tagIds,
          intentPending,
        },
        affectedProjectId: projectId,
        pending: intentPending
          ? {
            projectId, promptId: semrushPromptId, text: input.text, tagIds: typed.tagIds,
          }
          : null,
      };
    } catch (e) {
      return {
        failed: {
          text: input.text,
          geoTargetId: input.geoTargetId,
          languageCode: input.languageCode,
          status: e.status || 500,
          message: e.message,
        },
      };
    }
  });

  const created = [];
  const skipped = [];
  const failed = [];
  const affectedProjectIds = [];
  const pendingItems = [];
  for (const r of results) {
    if (r.created) {
      created.push(r.created);
      affectedProjectIds.push(r.affectedProjectId);
      if (r.pending) {
        pendingItems.push(r.pending);
      }
    } else if (r.skipped) {
      skipped.push(r.skipped);
    } else if (r.failed) {
      failed.push(r.failed);
    }
  }

  for (const pid of new Set(affectedProjectIds)) {
    invalidateTagCacheForProject(semrushWorkspaceId, pid);
  }

  const publishErrors = await publishAffected(
    transport,
    semrushWorkspaceId,
    affectedProjectIds,
    log,
  );
  for (const pubErr of publishErrors) {
    failed.push({ text: '', status: 502, message: `publish: ${pubErr.message}` });
  }

  const requeuedJobId = await requeuePending(context, job, semrushWorkspaceId, pendingItems);

  return {
    created,
    skipped,
    failed,
    published: true,
    pendingClassificationCount: pendingItems.length,
    requeuedJobId,
  };
}

/**
 * `mode: 'reclassify'`: patches an existing batch of already-created prompts
 * in place. Used both for the self-requeue above and for the background-retry
 * bridge from a synchronous soft failure (serenity-docs#33 "Background
 * retry" §2) — either way, the prompts already have a `semrushPromptId`, so
 * this reclassifies their text and writes the full desired tag set via
 * `updatePromptTagsByIds` (`replace: true`), never `createPromptsByIds`.
 *
 * @param {object} context
 * @param {object} job - the current `AsyncJob` (for the self-requeue's promise
 *   token and depth guard).
 * @param {SerenityTransport} transport
 * @param {object} metadata - `{ semrushWorkspaceId, items: [{ projectId,
 *   promptId, text, tagIds }] }` — `tagIds` is the FULL desired tag set minus
 *   `intent` (caller tags + server type/origin), matching the edit handlers'
 *   "recompute the whole set, then replace" contract.
 * @returns {Promise<object>} the job result.
 */
async function reclassifyExisting(context, job, transport, metadata) {
  const { env, log } = context;
  const { semrushWorkspaceId } = metadata;
  const items = Array.isArray(metadata.items) ? metadata.items : [];

  const intentByText = await classifyPromptIntentsUnbounded(
    items.map((i) => String(i?.text || '').trim()),
    { env, log },
  );

  const patched = [];
  const failed = [];
  const stillPending = [];
  const affectedProjectIds = [];

  // Group by project: `updatePromptTagsByIds` writes one project's items at a
  // time (transport call is scoped by `projectId` in the path).
  const itemsByProject = new Map();
  for (const item of items) {
    if (!itemsByProject.has(item.projectId)) {
      itemsByProject.set(item.projectId, []);
    }
    itemsByProject.get(item.projectId).push(item);
  }

  await Promise.all([...itemsByProject.entries()].map(async ([projectId, projectItems]) => {
    const patchItems = [];
    for (const item of projectItems) {
      const trimmedText = String(item.text || '').trim();
      const intentValue = intentByText.get(trimmedText) ?? null;
      const baseTagIds = Array.isArray(item.tagIds) ? item.tagIds : [];
      if (intentValue === null) {
        stillPending.push(item);
      } else {
        // eslint-disable-next-line no-await-in-loop
        const { computedId } = await resolveIntentValueInjection(
          transport,
          semrushWorkspaceId,
          projectId,
          intentValue,
          log,
        );
        patchItems.push({
          id: item.promptId, references: [...baseTagIds, computedId], replace: true,
        });
        patched.push({ semrushPromptId: item.promptId, projectId, intent: intentValue });
      }
    }
    if (patchItems.length === 0) {
      return;
    }
    try {
      await transport.updatePromptTagsByIds(semrushWorkspaceId, projectId, patchItems);
      affectedProjectIds.push(projectId);
    } catch (e) {
      failed.push({ projectId, status: e.status || 500, message: e.message });
    }
  }));

  for (const pid of new Set(affectedProjectIds)) {
    invalidateTagCacheForProject(semrushWorkspaceId, pid);
  }
  const publishErrors = await publishAffected(
    transport,
    semrushWorkspaceId,
    affectedProjectIds,
    log,
  );
  for (const pubErr of publishErrors) {
    failed.push({
      projectId: pubErr.projectId, status: 502, message: `publish: ${pubErr.message}`,
    });
  }

  const requeuedJobId = await requeuePending(context, job, semrushWorkspaceId, stillPending);

  return {
    patched,
    failed,
    published: true,
    pendingClassificationCount: stillPending.length,
    requeuedJobId,
  };
}

/**
 * Worker entry point for job type `serenity-classify-prompts`
 * (serenity-docs#33), the first consumer of the deferred Semrush job runner
 * (serenity-docs#186). Dispatches on `job.getMetadata().mode`:
 *   - absent / `'create'`: the CSV-import path — classify, create-with-tags,
 *     publish (see {@link createAndClassify}).
 *   - `'reclassify'`: patch an existing batch's tags in place (see
 *     {@link reclassifyExisting}) — used by this handler's own self-requeue
 *     and by the synchronous soft-failure bridge.
 *
 * @param {object} context - worker context (`dataAccess`, `env`, `log`, `sqs`).
 * @param {object} job - the loaded `AsyncJob` (promise token already exchanged
 *   by the caller).
 * @param {string} accessToken - the exchanged access token.
 * @returns {Promise<object>} the job result (`job.setResult`'d by the caller).
 */
export async function classifyPromptsHandler(context, job, accessToken) {
  const { env } = context;
  const metadata = job.getMetadata() ?? {};
  const transport = createSerenityTransport({ env, imsToken: accessToken });

  if (metadata.mode === 'reclassify') {
    return reclassifyExisting(context, job, transport, metadata);
  }
  return createAndClassify(context, job, transport, metadata);
}
