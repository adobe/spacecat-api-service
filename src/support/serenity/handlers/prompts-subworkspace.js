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
import { ERROR_CODES, isMeteredQuota, isUpstreamGone } from '../errors.js';
import { normalizeGeoTargetId, normalizeLanguageCode } from '../validation.js';
import { invalidateTagCacheForProject } from './markets.js';
import {
  buildPromptDto,
  normalizePromptInput,
  createOnePrompt,
  makePromptTagInjector,
  makeIntentInjector,
  validateDeferPublish,
  parseUpdatePromptBody,
  mapLimit,
  publishAffected,
  reconcilePublishErrors,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_TAG_IDS,
  BULK_CREATE_CONCURRENCY,
  BULK_PROMPTS_MAX_ITEMS,
} from './prompts.js';
import { ORIGIN_VALUE } from '../prompt-tags.js';
import { resolveProject, buildSliceProjectMap, sliceKey } from '../subworkspace-projects.js';
import { redactUpstreamMessage } from '../rest-transport.js';
import { createHeadroomGuard } from '../dynamic-allocation-active.js';
import { classifyPromptIntents } from '../intent-classification.js';
import { alertQuotaRejection } from '../quota-alerts.js';

/** @typedef {import('../resource-manager.js').Blocks} Blocks */

/**
 * Subworkspace-mode prompt handlers (serenity dual-mode, subworkspace path). Behaviourally
 * identical to the flat-mode prompt handlers EXCEPT for how a `(geoTargetId,
 * languageCode)` slice resolves to an upstream project: flat mode reads the
 * BrandSemrushProject mapping table, subworkspace resolves it from the brand's own
 * subworkspace via the live `listProjects` listing. Everything downstream —
 * the Semrush prompt calls, the publish-once contract, the per-project tag
 * cache invalidation, the bulk concurrency caps — is the shared, project-keyed
 * logic imported verbatim from prompts.js. The controller dispatches here when
 * resolveBrandWorkspace returns mode === 'subworkspace'.
 *
 * TWIN FILE: the orchestration shape here intentionally parallels the flat-mode
 * handlers in prompts.js. The duplication is DEFERRED, not accidental — flat mode
 * is slated for removal once every brand is migrated to sub-workspaces, at which
 * point this file becomes the sole prompt path and prompts.js's slice→project DB
 * lookup is deleted. Until then, a behavioural change to one twin almost always
 * needs the same change in the other; keep them in lockstep.
 */

/**
 * GET /serenity/prompts (subworkspace) — list one slice's prompts. The slice resolves
 * to a project via the live listing; a missing project is a hard 404
 * marketNotFound (same contract as the flat-mode single-slice list — "no such
 * slice" must not masquerade as "slice exists but empty").
 */
export async function handleListPromptsSubworkspace(transport, workspaceId, query, log) {
  const geoTargetId = normalizeGeoTargetId(query?.geoTargetId);
  const languageCode = normalizeLanguageCode(query?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'geoTargetId (integer) and languageCode (BCP-47 primary subtag) are required',
      400,
    );
  }

  const page = Number.isInteger(query?.page) && query.page > 0 ? query.page : 1;
  const requestedLimit = Number.isInteger(query?.limit) && query.limit > 0
    ? query.limit : DEFAULT_PAGE_LIMIT;
  const limit = Math.min(requestedLimit, MAX_PAGE_LIMIT);
  const search = hasText(query?.search) ? String(query.search).trim() : undefined;
  const tagIds = Array.isArray(query?.tagIds)
    ? query.tagIds.slice(0, MAX_TAG_IDS).map(String).filter(Boolean)
    : [];

  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    const err = new ErrorWithStatusCode(
      'No market for this brand and (geoTargetId, languageCode) slice',
      404,
    );
    err.code = ERROR_CODES.MARKET_NOT_FOUND;
    throw err;
  }

  // Each prompt's tags already carry their own parentage (see buildTagsOf), so
  // one upstream call answers the whole page — no tag-tree walk to join against.
  const resp = await transport.listPromptsByTags(workspaceId, project.id, {
    tag_ids: tagIds,
    page,
    limit,
    search,
  });
  const items = Array.isArray(resp?.items) ? resp.items : [];
  let total;
  if (items.length < limit) {
    total = (page - 1) * limit + items.length;
  } else {
    total = Number.isFinite(resp?.total) ? resp.total : items.length;
  }
  return {
    items: items
      .map((item) => buildPromptDto(geoTargetId, languageCode, item))
      .filter(Boolean),
    total,
    page,
    limit,
  };
}

/**
 * POST /serenity/prompts (subworkspace) — bulk create. Resolves every input's owning
 * project from ONE live listing (buildSliceProjectMap) instead of the DB
 * mapping, then reuses the shared per-slice create + publish-once fan-out.
 * @param {any} transport
 * @param {string} workspaceId
 * @param {any} body
 * @param {any} log
 * @param {any} classifyPromptType
 * @param {object | null} [env] - environment (Azure OpenAI creds), threaded into intent
 *   classification; ALSO used directly to fire the quota-rejection Slack alert (serenity-docs#72
 *   §5). Optional — omitted, alerting is a no-op.
 * @param {number} [writeDeadline] - shared request-write deadline for intent classification.
 * @param {object} [options]
 * @param {boolean} [options.dynamicAllocation]
 * @param {string} [options.parentWorkspaceId]
 * @param {Partial<Blocks>} [options.ceiling] - per-brand AI ceiling (LLMO-6190 flag-flip gate).
 * @param {string | null} [options.orgId] - serenity-docs#72 §5 alert payload only.
 * @param {string | null} [options.brandId] - serenity-docs#72 §5 alert payload only.
 */
export async function handleCreatePromptsSubworkspace(
  transport,
  workspaceId,
  body,
  log,
  classifyPromptType,
  env,
  writeDeadline,
  {
    dynamicAllocation = false,
    parentWorkspaceId = '',
    ceiling = /** @type {Partial<Blocks> | undefined} */ (undefined),
    orgId = null,
    brandId = null,
  } = {},
) {
  const inputs = Array.isArray(body?.prompts) ? body.prompts : [];
  if (inputs.length === 0) {
    throw new ErrorWithStatusCode('Body must include a non-empty prompts array', 400);
  }
  if (inputs.length > BULK_PROMPTS_MAX_ITEMS) {
    throw new ErrorWithStatusCode(
      `prompts array exceeds maxItems=${BULK_PROMPTS_MAX_ITEMS}`,
      400,
    );
  }
  const deferPublish = validateDeferPublish(body);

  const projectsBySlice = await buildSliceProjectMap(transport, workspaceId, log);
  // CREATE: user-authenticated write → derived `origin` is `human` (see the
  // flat-mode twin handleCreatePrompts and origin-dimension.md §3).
  const injectComputedTags = makePromptTagInjector(
    transport,
    workspaceId,
    classifyPromptType,
    log,
    { originValue: ORIGIN_VALUE.HUMAN },
  );
  // Unified layer (serenity-docs#32): batch-classify every distinct text ONCE
  // under the shared request deadline, then thread the resolved map into each
  // per-item injection below.
  // Classify the TRIMMED text: `makeIntentInjector` looks up the map by
  // `input.text`, which `normalizePromptInput` has already trimmed, so the
  // classify key must be trimmed to match — otherwise a whitespace-padded prompt
  // (common in CSV import) misses the map and silently defaults to Informational
  // despite a real classification.
  const intentByText = await classifyPromptIntents(
    inputs.map((raw) => String(raw?.text || '').trim()),
    {
      env,
      log,
      deadline: writeDeadline,
      writePath: deferPublish ? 'csv' : 'create',
      workspaceId,
    },
  );
  const injectComputedIntent = makeIntentInjector(transport, workspaceId, intentByText, log);

  // PROMPT metering seam (Rainer, live-verified LLMO-6190): the metered write is
  // `createPromptsByIds` (inside `createOnePrompt` below), NOT publish — a disguised-quota 405
  // fires there, before any publish, if `used + drafted + batch > total`. Front headroom BEFORE
  // this loop, sized on the whole incoming batch (`inputs.length` — a safe upper bound; some
  // inputs may still skip on validation/missing-project, so this can over-provision slightly, never
  // under). No-op when the flag is OFF.
  const headroom = createHeadroomGuard(
    transport,
    {
      enabled: dynamicAllocation,
      subWorkspaceId: workspaceId,
      parentWorkspaceId,
      ceiling,
      env,
      orgId,
      brandId,
    },
    log,
  );
  await headroom.ensure({ prompts: inputs.length }, { includeDrafted: true });

  const results = await mapLimit(inputs, BULK_CREATE_CONCURRENCY, async (raw) => {
    const { value: input, reason } = normalizePromptInput(raw);
    if (!input) {
      return {
        skipped: {
          text: String(raw?.text || ''),
          reason: /** @type {string} */ (reason),
        },
      };
    }
    const project = projectsBySlice.get(sliceKey(input.geoTargetId, input.languageCode));
    if (!project) {
      return {
        skipped: {
          text: input.text,
          reason: `No market for slice (${input.geoTargetId}, ${input.languageCode})`,
        },
      };
    }
    const projectId = String(project.id);
    try {
      // Unified layer: strip caller-supplied type/origin/intent, then inject the
      // computed type + derived origin (origin-dimension.md §3) and the classified
      // intent (serenity-docs#32). The injectors act on disjoint dimensions.
      let typed = await injectComputedTags(projectId, input);
      typed = await injectComputedIntent(projectId, typed);
      // LLMO-6190 follow-up: the metered write itself can still 405 as a disguised metered-quota
      // rejection despite the pre-loop sizing above (the live-verified ~9s gateway
      // write-enforcement lag after a JIT top-up) — route it through `headroom.retryOnQuota` (a
      // no-op passthrough when the flag is OFF) so each item recovers independently; `mapLimit`'s
      // own per-item try/catch below still isolates a surviving failure to this one item.
      const semrushPromptId = await headroom.retryOnQuota(
        () => createOnePrompt(transport, workspaceId, projectId, typed),
        { callSite: 'createOnePrompt' },
      );
      return {
        created: {
          semrushPromptId,
          geoTargetId: typed.geoTargetId,
          languageCode: input.languageCode,
          text: typed.text,
          tagIds: typed.tagIds,
        },
        affectedProjectId: projectId,
      };
    } catch (e) {
      // serenity-docs#72 §4.1: a residual disguised-405 quota rejection on the metered write
      // itself (not just its later publish) must surface as the stable 409 quotaExceeded token —
      // never the raw upstream status (405) or a generic 500.
      const quota = isMeteredQuota(e);
      if (quota) {
        await alertQuotaRejection({
          orgId, brandId, workspaceId, caseType: 'brandCarveExhausted', dimension: 'prompts',
        }, env, log);
      }
      return {
        failed: {
          text: input.text,
          geoTargetId: input.geoTargetId,
          languageCode: input.languageCode,
          status: quota ? 409 : (e.status || 500),
          ...(quota ? { error: ERROR_CODES.QUOTA_EXCEEDED } : {}),
          message: redactUpstreamMessage(e),
        },
      };
    }
  });

  const created = [];
  const skipped = [];
  const failed = [];
  const affectedProjectIds = [];
  for (const r of results) {
    if (r.created) {
      // `rollbackProjectId` is internal bookkeeping for reconcilePublishErrors' rollback below;
      // stripped before the response is returned.
      created.push({ ...r.created, rollbackProjectId: r.affectedProjectId });
      affectedProjectIds.push(r.affectedProjectId);
    } else if (r.skipped) {
      skipped.push(r.skipped);
    } else if (r.failed) {
      failed.push(r.failed);
    }
  }

  for (const pid of new Set(affectedProjectIds)) {
    invalidateTagCacheForProject(workspaceId, pid);
  }

  if (deferPublish) {
    log?.info?.('serenity create-prompts (subworkspace): deferPublish set — prompts written as draft, publish skipped', {
      workspaceId, created: created.length, skipped: skipped.length, failed: failed.length,
    });
    return {
      // eslint-disable-next-line no-unused-vars -- destructuring-omit to strip the bookkeeping field
      created: created.map(({ rollbackProjectId, ...rest }) => rest),
      skipped,
      failed,
      published: false,
    };
  }

  // Route each project's publish through the headroom guard's retryOnQuota (LLMO-6190 item 4):
  // a disguised metered-405 gets ONE bounded top-up+retry per project before being recorded as a
  // failure. No-op passthrough when the flag is OFF (the guard's retryOnQuota is a plain call).
  const alertContext = { orgId, brandId, env };
  const publishErrors = await publishAffected(
    transport,
    workspaceId,
    affectedProjectIds,
    log,
    (fn) => headroom.retryOnQuota(fn, { callSite: 'publishAffected' }),
    alertContext,
  );
  // serenity-docs#72 §4.1 atomicity: a quota-rejected publish rolls back (deletes) the prompts
  // this request staged in that project and moves them into `failed` — never left as unpublished
  // drafts. A non-quota publish failure is untouched (existing generic `publish:` 502 record).
  await reconcilePublishErrors(
    transport,
    workspaceId,
    publishErrors,
    created,
    failed,
    log,
    alertContext,
  );

  return {
    // eslint-disable-next-line no-unused-vars -- destructuring-omit to strip the bookkeeping field
    created: created.map(({ rollbackProjectId, ...rest }) => rest),
    skipped,
    failed,
    published: true,
  };
}

/**
 * PATCH /serenity/prompts/:semrushPromptId (subworkspace) — in-place edit.
 * Resolves the slice's project from the live listing, then edits the prompt IN
 * PLACE exactly like the flat-mode twin (see handleUpdatePrompt's contract):
 * `rename` first (the one op that can refuse — upstream 404 → promptNotFound,
 * 409 text collision → thrown for the controller's `conflict` mapping), then
 * the replace-mode batch tag write. The prompt id is preserved end to end and
 * echoed unchanged in the response; nothing is deleted on this path.
 */
export async function handleUpdatePromptSubworkspace(
  transport,
  workspaceId,
  semrushPromptId,
  body,
  log,
  classifyPromptType,
  env,
  writeDeadline,
) {
  const parsedBody = parseUpdatePromptBody(body);
  if (!parsedBody.ok) {
    return { status: parsedBody.status, body: parsedBody.body };
  }
  const { text: nextText, tagIds: nextTagIds } = parsedBody;
  const geoTargetId = normalizeGeoTargetId(Number(body.geoTargetId));
  const languageCode = normalizeLanguageCode(body.languageCode);
  if (geoTargetId === null || languageCode === null) {
    return {
      status: 400,
      body: {
        error: 'invalidRequest',
        message: 'PATCH body must include geoTargetId (integer) and languageCode (BCP-47 primary subtag)',
      },
    };
  }

  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    return {
      status: 404,
      body: {
        error: 'marketNotFound',
        message: 'No market for this brand and (geoTargetId, languageCode) slice',
      },
    };
  }
  const projectId = String(project.id);

  // Recompute the type AND intent tags from the NEW text BEFORE any upstream write
  // (see the flat-mode twin handleUpdatePrompt): the unified layer must run before
  // the rename so a classification failure aborts cleanly with the prompt untouched
  // (serenity-docs#31, #32). No `originValue`: origin is never re-derived on edit
  // (origin-dimension.md §3 item 3); the stored origin the caller echoes rides
  // through the replace-mode tag write untouched.
  const injectComputedTags = makePromptTagInjector(transport, workspaceId, classifyPromptType, log);
  const intentByText = await classifyPromptIntents(
    [nextText],
    {
      env, log, deadline: writeDeadline, writePath: 'edit', workspaceId,
    },
  );
  const injectComputedIntent = makeIntentInjector(transport, workspaceId, intentByText, log);
  let typed = await injectComputedTags(projectId, {
    text: nextText, geoTargetId, tagIds: nextTagIds,
  });
  typed = await injectComputedIntent(projectId, typed);

  try {
    await transport.renamePrompt(workspaceId, projectId, semrushPromptId, nextText);
  } catch (e) {
    if (isUpstreamGone(e)) {
      return {
        status: 404,
        body: {
          error: 'promptNotFound',
          message: 'No upstream prompt matches the supplied semrushPromptId in this slice',
        },
      };
    }
    // A 409 (the new text collides with a sibling prompt's) and every other
    // upstream error propagate to the controller's mapError; nothing has
    // mutated upstream — the tag write below has not run.
    throw e;
  }

  // Full replace with the injector's output: the caller's tagIds minus any
  // caller-supplied type value, plus the server-computed one. An unknown
  // prompt id would be skipped silently (204) — the rename above has already
  // established existence.
  try {
    await transport.updatePromptTagsByIds(workspaceId, projectId, [
      { id: semrushPromptId, references: typed.tagIds, replace: true },
    ]);
  } catch (e) {
    // The rename above already landed: the prompt's text has moved while its
    // tags are stale. Record the partial mutation before propagating, so the
    // generic upstream error the caller sees is attributable on-call.
    log?.warn?.('updatePromptTagsByIds failed after a successful rename — text updated, tags stale', {
      semrushPromptId, projectId, error: e.message,
    });
    throw e;
  }

  invalidateTagCacheForProject(workspaceId, projectId);

  await publishAffected(transport, workspaceId, [projectId], log);

  return {
    status: 200,
    body: {
      semrushPromptId,
      geoTargetId,
      languageCode,
      text: nextText,
      tagIds: typed.tagIds,
    },
  };
}

/**
 * POST /serenity/prompts/bulk-delete (subworkspace) — resolve each target's project
 * from ONE live listing, batch deletes per project, publish affected. Upstream
 * 404 == idempotent success.
 * @param {any} transport
 * @param {string} workspaceId
 * @param {any} body
 * @param {any} log
 * @param {object} [options]
 * @param {string | null} [options.orgId] - serenity-docs#72 §5 alert payload only.
 * @param {string | null} [options.brandId] - serenity-docs#72 §5 alert payload only.
 * @param {object | null} [options.env] - serenity-docs#72 §5 alert kill-switch/config only.
 */
export async function handleBulkDeletePromptsSubworkspace(
  transport,
  workspaceId,
  body,
  log,
  { orgId = null, brandId = null, env = null } = {},
) {
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

  const projectsBySlice = await buildSliceProjectMap(transport, workspaceId, log);

  const byProject = new Map();
  const failed = [];
  targets.forEach((t) => {
    const sid = String(t?.semrushPromptId || '');
    const geoTargetId = normalizeGeoTargetId(Number(t?.geoTargetId));
    const languageCode = normalizeLanguageCode(t?.languageCode);
    if (!sid || geoTargetId === null || languageCode === null) {
      failed.push({
        semrushPromptId: sid,
        geoTargetId,
        languageCode,
        message: 'Missing semrushPromptId, geoTargetId, or languageCode',
      });
      return;
    }
    const project = projectsBySlice.get(sliceKey(geoTargetId, languageCode));
    if (!project) {
      failed.push({
        semrushPromptId: sid,
        geoTargetId,
        languageCode,
        message: `No market for slice (${geoTargetId}, ${languageCode})`,
      });
      return;
    }
    const pid = String(project.id);
    if (!byProject.has(pid)) {
      byProject.set(pid, { ids: [], targets: [] });
    }
    const bucket = byProject.get(pid);
    bucket.ids.push(sid);
    bucket.targets.push({ semrushPromptId: sid, geoTargetId, languageCode });
  });

  let deleted = 0;
  const projectsToPublish = new Set();
  await Promise.all(Array.from(byProject.entries()).map(async ([pid, bucket]) => {
    try {
      await transport.deletePromptsByIds(workspaceId, pid, bucket.ids);
      deleted += bucket.ids.length;
      projectsToPublish.add(pid);
    } catch (e) {
      if (isUpstreamGone(e)) {
        deleted += bucket.ids.length;
        projectsToPublish.add(pid);
        log?.info?.('bulk-delete (subworkspace): upstream already-deleted (404 treated as success)', { ids: bucket.ids });
        return;
      }
      bucket.targets.forEach((t) => {
        failed.push({
          semrushPromptId: t.semrushPromptId,
          geoTargetId: t.geoTargetId,
          languageCode: t.languageCode,
          status: e.status || 500,
          message: redactUpstreamMessage(e),
        });
      });
    }
  }));

  for (const pid of projectsToPublish) {
    invalidateTagCacheForProject(workspaceId, pid);
  }

  const publishErrors = await publishAffected(
    transport,
    workspaceId,
    Array.from(projectsToPublish),
    log,
    undefined,
    { orgId, brandId, env },
  );
  // pubErr is an already-redacted { projectId, message, code? } record (see above).
  publishErrors.forEach((pubErr) => {
    if (pubErr.code === ERROR_CODES.QUOTA_EXCEEDED) {
      failed.push({
        semrushPromptId: '', status: 409, error: ERROR_CODES.QUOTA_EXCEEDED, message: pubErr.message,
      });
    } else {
      failed.push({ semrushPromptId: '', status: 502, message: `publish: ${pubErr.message}` });
    }
  });

  return { deleted, failed };
}
