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

import { createHash } from 'node:crypto';
import { hasText } from '@adobe/spacecat-shared-utils';

import { createSerenityTransport } from '../rest-transport.js';
import {
  createAndEnqueueJob,
  exchangeAndPersistPromiseToken,
  retryableJobError,
  PROMISE_PAIR_SEMRUSH,
} from '../async-job-runner.js';
import { invokeDrsGeneration, DrsGenerationTerminalError } from '../drs-generation-client.js';
import { provisionDimensionTree, ensureServerOwnedValue } from '../tag-tree.js';
import { resolveProject } from '../subworkspace-projects.js';
import { publishAffected, buildCreateMetadata } from './prompts.js';
import { DIMENSION, GENERATED_PROMPT_SOURCE_VALUE, ORIGIN_VALUE } from '../prompt-tags.js';

/** @typedef {import('../rest-transport.js').SerenityTransport} SerenityTransport */

/**
 * Async Semrush-market AI-prompt provisioning (serenity-docs#443, this repo's
 * half #3194). Replaces the synchronous verbatim-catalogue path
 * (`generateAndAttachPrompts` in markets-subworkspace.js) with: fetch + bound the
 * Semrush catalogue seeds in-request (the producer), then in a token-bearing SQS
 * worker synchronously invoke the stateless DRS generation service, exchange the
 * write-scoped Semrush token AFTER DRS returns, and idempotently write the
 * validated prompts to the market draft, publish, and record the outcome.
 *
 * This job type is BOTH lease-required (Gap 4 — the atomic per-job claim is a
 * security control against promise-token replay + double-write under SQS
 * at-least-once) AND deferred-exchange (the write token is exchanged inside this
 * handler, after DRS, not by the runner up front). The worker registers it in
 * both `LEASE_REQUIRED_JOB_TYPES` and `DEFERRED_EXCHANGE_JOB_TYPES`.
 */

/** Job type the worker dispatches on (stored on `metadata.jobType`). */
export const SEMRUSH_MARKET_GENERATION_JOB_TYPE = 'serenity-generate-semrush-market';

/** Public (client-facing) job type for the polling DTO. */
export const SEMRUSH_MARKET_GENERATION_PUBLIC_JOB_TYPE = 'generateSemrushMarket';

/** Keep at most this many catalogue seeds (top by search volume; 0 = keep all). */
export const DEFAULT_TOPIC_CAP = 50;

/** Keep at most this many example prompts per seed (bounds the DRS request size). */
export const DEFAULT_EXAMPLE_CAP = 10;

/** Default desired prompt count requested from DRS when a caller omits it. */
export const DEFAULT_PROMPT_COUNT = 50;

/**
 * Derives a stable UUID from the reservation key `(brandId, geoTargetId,
 * languageCode)`. `AsyncJob.metadata` is unindexed (only `status`/`updatedAt`
 * composites exist), so "is there already an open generation job for this slice?"
 * cannot be a table scan — the deterministic id IS the application-layer
 * reservation key: two concurrent onboardings of the same slice resolve to the
 * same job row, and the producer's find-before-create collapses them.
 *
 * The output is a syntactically valid v4-shaped UUID (version nibble `4`, variant
 * `8-b`) so it passes `isValidUUID` on the polling route.
 *
 * @param {string} brandId
 * @param {number|string} geoTargetId
 * @param {string} languageCode
 * @returns {string}
 */
export function reservationJobId(brandId, geoTargetId, languageCode) {
  const key = `serenity-generate-semrush-market:${brandId}:${geoTargetId}:${languageCode}`;
  const h = createHash('sha256').update(key).digest('hex').slice(0, 32)
    .split('');
  h[12] = '4';
  // Variant nibble in the 8..b range, computed without bitwise operators.
  h[16] = (8 + (parseInt(h[16], 16) % 4)).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Bounds + dedupes raw `getBrandTopics` output into the seed list sent to DRS:
 * keeps the top `topicCap` topics by volume, caps example prompts per topic, and
 * drops empties. The seed carries only the topic string, its volume, and a few
 * example prompts — never anything token-bearing.
 *
 * @param {any} rawTopics - the `transport.getBrandTopics` result (array or `{ items }`).
 * @param {object} [opts]
 * @param {number} [opts.topicCap]
 * @param {number} [opts.exampleCap]
 * @returns {Array<{ topic: string, volume: number, examplePrompts: string[] }>}
 */
export function boundCatalogueSeeds(rawTopics, {
  topicCap = DEFAULT_TOPIC_CAP, exampleCap = DEFAULT_EXAMPLE_CAP,
} = {}) {
  let topics = [];
  if (Array.isArray(rawTopics)) {
    topics = rawTopics;
  } else if (Array.isArray(rawTopics?.items)) {
    topics = rawTopics.items;
  }
  const ranked = topics
    .filter((t) => hasText(t?.topic))
    .sort((a, b) => (Number(b?.volume) || 0) - (Number(a?.volume) || 0));
  const selected = topicCap > 0 ? ranked.slice(0, topicCap) : ranked;
  return selected.map((t) => ({
    topic: String(t.topic),
    volume: Number(t?.volume) || 0,
    examplePrompts: (Array.isArray(t?.prompts) ? t.prompts : [])
      .filter((p) => hasText(p))
      .slice(0, exampleCap)
      .map((p) => String(p)),
  }));
}

/**
 * THE shared producer — the single convergence point for all three entry points
 * (net-new customer/brand/site, new market, activate). "Which entry point" is a
 * fact the producer resolves; it is never a branch in the job. Fetches + bounds
 * the catalogue seeds in-request, then enqueues ONE `serenity-generate-semrush-market`
 * job carrying those seeds and a freshly-minted Semrush-pair promise token.
 *
 * Idempotent: a live (IN_PROGRESS) job for the same `(brandId, geoTargetId,
 * languageCode)` reservation is returned as-is rather than re-enqueued; a stale
 * terminal job for the same slice is cleared so a fresh generation can run.
 *
 * The promise pair is hard-bound to Semrush server-side (`requirePair`) — the
 * enqueue FAILS rather than silently minting on the default IMS pair (Gap 1).
 *
 * @param {object} context - request context (`dataAccess`, `sqs`, `env`, `log`, IMS auth).
 * @param {object} params
 * @param {SerenityTransport} params.transport - request-scoped transport (seed READ).
 * @param {string} params.brandId - SpaceCat brand uuid.
 * @param {string} params.siteId - SpaceCat site id (for DRS + ownership scoping).
 * @param {string} params.imsOrgId - IMS org id.
 * @param {string} params.workspaceId - Semrush (sub-)workspace id the project lives in.
 * @param {number} params.geoTargetId - the market's geo target.
 * @param {string} params.languageCode - authoritative language code.
 * @param {string} params.market - market country code.
 * @param {string} params.brandDomain - brand domain (seed fetch key).
 * @param {string} params.baseUrl - brand base URL (sent to DRS).
 * @param {string} [params.subpath] - market subpath.
 * @param {string} params.brand - brand display name (sent to DRS).
 * @param {string[]} [params.aliases] - brand aliases (sent to DRS).
 * @param {string} [params.audience] - audience descriptor.
 * @param {number} [params.count] - desired prompt count.
 * @param {number} [params.topicCap] - seed cap.
 * @param {string} [params.callerId] - resolved caller id for authorship stamping.
 * @param {string|null} [params.imsUserId] - the ORIGINAL caller's stable IMS user id
 *   (`user_id` claim only), stored so the reauth endpoint can strict-match the
 *   re-authenticating caller against it (Gap 6). May be null; reauth then fails closed.
 * @returns {Promise<{ enqueued: boolean, jobId?: string, status?: string,
 *   reused?: boolean, reason?: string }>}
 */
export async function enqueueSemrushMarketGeneration(context, params) {
  const { dataAccess, log } = context;
  const {
    transport, brandId, siteId, imsOrgId, workspaceId, geoTargetId, languageCode, market,
    brandDomain, baseUrl, subpath, brand, aliases = [], audience,
    count = DEFAULT_PROMPT_COUNT, topicCap = DEFAULT_TOPIC_CAP, callerId = 'unknown',
    imsUserId = null,
  } = params;

  // Resolve seeds server-side (a bounded read, same single upstream call the old
  // synchronous path made). An empty catalogue is a clean no-op — nothing to
  // generate, so nothing to enqueue.
  const rawTopics = await transport.getBrandTopics(
    workspaceId,
    { domain: brandDomain, country: market },
  );
  const seeds = boundCatalogueSeeds(rawTopics, { topicCap });
  if (seeds.length === 0) {
    log?.info?.('[semrush-market-gen] no catalogue seeds; skipping enqueue', {
      brandId, workspaceId, market,
    });
    return { enqueued: false, reason: 'no-seeds' };
  }

  const jobId = reservationJobId(brandId, geoTargetId, languageCode);

  // Reservation: dedupe a live job; clear a stale terminal one so a re-run can proceed.
  const existing = await dataAccess.AsyncJob.findById(jobId).catch(() => null);
  if (existing) {
    if (existing.getStatus() === 'IN_PROGRESS') {
      log?.info?.('[semrush-market-gen] live generation job already reserved; reusing', {
        brandId, jobId, geoTargetId, languageCode,
      });
      return {
        enqueued: false, reused: true, jobId, status: existing.getStatus(),
      };
    }
    // Terminal (COMPLETED/FAILED/CANCELLED) — clear it so the deterministic id is
    // free for a fresh generation of this slice.
    await existing.remove().catch((e) => {
      log?.warn?.(`[semrush-market-gen] could not clear stale job ${jobId}: ${e.message}`);
    });
  }

  const job = await createAndEnqueueJob(context, {
    jobType: SEMRUSH_MARKET_GENERATION_JOB_TYPE,
    jobId,
    requirePair: PROMISE_PAIR_SEMRUSH,
    promisePair: PROMISE_PAIR_SEMRUSH,
    metadata: {
      brandId,
      siteId,
      imsOrgId,
      workspaceId,
      geoTargetId,
      languageCode,
      market,
      baseUrl,
      subpath,
      brand,
      aliases,
      audience,
      count,
      seeds,
      callerId,
      imsUserId,
    },
  });

  return {
    enqueued: true, jobId: job.getId(), status: job.getStatus(),
  };
}

/**
 * Worker handler for {@link SEMRUSH_MARKET_GENERATION_JOB_TYPE}. Deferred-exchange:
 * the runner passes NO access token — this handler exchanges the write-scoped
 * Semrush token itself, AFTER DRS returns.
 *
 * Phases, each checkpointed so a retry never repeats an expensive/irreversible step:
 *   1. **generate** — invoke DRS synchronously; persist the returned `{prompt,
 *      category}` batch onto the job BEFORE the write phase. On retry, resume from
 *      the persisted batch — NEVER re-invoke DRS (Gap: idempotency of the expensive
 *      generation step). The transient per-prompt language evidence is deliberately
 *      NOT persisted.
 *   2. **write** — exchange the Semrush token now, resolve the (already-created)
 *      market project, provision the dimension tree, resolve server-owned
 *      `source=semrush` + `origin=ai` tags, and write the prompts. Checkpointed
 *      via `promptsWritten` so a publish retry does not double-write.
 *   3. **publish** — publish the affected project; retryable on a transient upstream
 *      failure (writes already checkpointed, so a re-publish is safe).
 *
 * A held / gate_error / zero-prompt outcome throws terminal and NEVER publishes —
 * the parent market/brand/site created synchronously by the entry point stays
 * valid and recoverable (Gap 7).
 *
 * @param {object} context - worker context (`env`, `dataAccess`, `log`, `runtime`).
 * @param {object} job - the loaded `AsyncJob`.
 * @param {string|null} _accessToken - always null for this deferred-exchange type.
 * @param {object} [deps] - injectable seams for tests.
 * @param {typeof invokeDrsGeneration} [deps.invokeDrs]
 * @param {(args: object) => SerenityTransport} [deps.buildTransport]
 * @returns {Promise<object>} the job result.
 */
export async function semrushMarketGenerationHandler(context, job, _accessToken, deps = {}) {
  const { log } = context;
  const invokeDrs = deps.invokeDrs ?? invokeDrsGeneration;
  const buildTransport = deps.buildTransport
    ?? ((args) => createSerenityTransport(args));

  const metadata = job.getMetadata() ?? {};
  const {
    workspaceId, geoTargetId, languageCode, market, brand, aliases = [],
    baseUrl, subpath, audience, count = DEFAULT_PROMPT_COUNT, seeds = [],
    siteId, imsOrgId, callerId = 'unknown',
  } = metadata;

  // ---- Phase 1: generation (checkpointed) --------------------------------
  let batch = metadata.generatedBatch;
  if (!batch) {
    const drsResult = await invokeDrs(context, {
      seeds,
      brand,
      aliases,
      baseUrl,
      subpath,
      market,
      languageCode,
      audience,
      count,
      siteId,
      imsOrgId,
    });
    // Persist ONLY the durable batch. The per-prompt language evidence is
    // transient (a generation-time artefact) and is intentionally dropped.
    batch = { prompts: drsResult.prompts };
    job.setMetadata({ ...(job.getMetadata() ?? {}), generatedBatch: batch });
    await job.save();
    log.info('[semrush-market-gen] DRS batch persisted before writes', {
      jobId: job.getId(),
      promptCount: batch.prompts.length,
      verdict: drsResult.shipSummary?.verdict,
    });
  } else {
    log.info('[semrush-market-gen] resuming from persisted DRS batch (no DRS re-invoke)', {
      jobId: job.getId(), promptCount: Array.isArray(batch.prompts) ? batch.prompts.length : 0,
    });
  }

  const prompts = Array.isArray(batch.prompts) ? batch.prompts : [];
  if (prompts.length === 0) {
    // A shipped-but-empty batch must never publish an empty market (Gap 7).
    throw new DrsGenerationTerminalError('DRS shipped zero prompts; nothing to write');
  }

  // ---- Phase 2: exchange write token AFTER DRS, then write ----------------
  const accessToken = await exchangeAndPersistPromiseToken(context, job);
  const transport = buildTransport({ env: context.env, imsToken: accessToken });

  if (!job.getMetadata()?.promptsWritten) {
    const project = await resolveProject(
      transport,
      workspaceId,
      Number(geoTargetId),
      languageCode,
      log,
    );
    const projectId = project?.id ? String(project.id) : '';
    if (!hasText(projectId)) {
      // The synchronous entry point creates the project before enqueue; a missing
      // project here is a transient read/race far more often than a permanent
      // absence, so retry within the attempt bound.
      throw retryableJobError(
        `No project for slice (${geoTargetId}, ${languageCode}) in workspace ${workspaceId}`,
      );
    }

    await provisionDimensionTree(transport, workspaceId, projectId, log);
    const { id: sourceId } = await ensureServerOwnedValue(
      transport,
      workspaceId,
      projectId,
      DIMENSION.SOURCE,
      GENERATED_PROMPT_SOURCE_VALUE,
      log,
    );
    const { id: originId } = await ensureServerOwnedValue(
      transport,
      workspaceId,
      projectId,
      DIMENSION.ORIGIN,
      ORIGIN_VALUE.AI,
      log,
    );
    // Server-owned tags only. `category` is DEFERRED to serenity-docs#44 (the
    // multi-level customer-category → topic hierarchy); v1 writes uncategorized
    // and tolerates a `category` on the DRS output without acting on it.
    const tagIds = [sourceId, originId];
    const categorized = prompts.filter((p) => hasText(p?.category)).length;
    if (categorized > 0) {
      log.info('[semrush-market-gen] DRS returned categories; deferring categorization (serenity-docs#44)', {
        jobId: job.getId(), categorized,
      });
    }

    const createMeta = buildCreateMetadata(callerId);
    const seen = new Set();
    const items = [];
    for (const p of prompts) {
      const name = String(p?.prompt || '').trim();
      if (hasText(name) && !seen.has(name)) {
        seen.add(name);
        items.push({ name, metadata: createMeta });
      }
    }
    if (items.length > 0) {
      await transport.createPromptsWithMetadata(workspaceId, projectId, items, tagIds);
    }

    // Checkpoint the write BEFORE publish so a publish retry re-publishes rather
    // than re-writing (no double-write on the publish-retry path).
    job.setMetadata({ ...(job.getMetadata() ?? {}), promptsWritten: true, projectId });
    await job.save();
  }

  // ---- Phase 3: publish (idempotent, retryable) ---------------------------
  const projectId = job.getMetadata()?.projectId;
  const publishErrors = await publishAffected(transport, workspaceId, [projectId], log);
  if (publishErrors.length > 0) {
    throw retryableJobError(`publish failed for project ${projectId}: ${publishErrors.map((e) => e.message).join('; ')}`);
  }

  return {
    promptCount: prompts.length,
    written: job.getMetadata()?.promptsWritten === true,
    projectId,
    published: true,
    verdict: 'ship',
  };
}
