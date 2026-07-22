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
import { ERROR_CODES, isUpstreamGone } from '../errors.js';
import { normalizeGeoTargetId, normalizeLanguageCode } from '../validation.js';
import { invalidateTagCacheForProject } from './markets.js';
import {
  buildPromptDto,
  normalizePromptInput,
  createOnePrompt,
  makePromptTagInjector,
  parseUpdatePromptBody,
  mapLimit,
  publishAffected,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_TAG_IDS,
  BULK_CREATE_CONCURRENCY,
  BULK_PROMPTS_MAX_ITEMS,
} from './prompts.js';
import { ORIGIN_VALUE, PROXY_CREATE_SOURCE_VALUE } from '../prompt-tags.js';
import { resolveProject, buildSliceProjectMap, sliceKey } from '../subworkspace-projects.js';
import { redactUpstreamMessage } from '../rest-transport.js';
import { createHeadroomGuard } from '../dynamic-allocation-active.js';

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
 */
export async function handleCreatePromptsSubworkspace(
  transport,
  workspaceId,
  body,
  log,
  classifyPromptType,
  { dynamicAllocation = false, parentWorkspaceId = '' } = {},
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

  const projectsBySlice = await buildSliceProjectMap(transport, workspaceId, log);
  // CREATE: user-authenticated write → derived `origin` is `human` and producing
  // `source` is the constant `config` (see the flat-mode twin handleCreatePrompts,
  // origin-dimension.md §3, source-dimension.md §1).
  const injectComputedTags = makePromptTagInjector(
    transport,
    workspaceId,
    classifyPromptType,
    log,
    { originValue: ORIGIN_VALUE.HUMAN, sourceValue: PROXY_CREATE_SOURCE_VALUE },
  );

  // PROMPT metering seam (Rainer, live-verified LLMO-6190): the metered write is
  // `createPromptsByIds` (inside `createOnePrompt` below), NOT publish — a disguised-quota 405
  // fires there, before any publish, if `used + drafted + batch > total`. Front headroom BEFORE
  // this loop, sized on the whole incoming batch (`inputs.length` — a safe upper bound; some
  // inputs may still skip on validation/missing-project, so this can over-provision slightly, never
  // under). No-op when the flag is OFF.
  const headroom = createHeadroomGuard(
    transport,
    { enabled: dynamicAllocation, subWorkspaceId: workspaceId, parentWorkspaceId },
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
      // Unified layer: strip any caller-supplied type/origin + inject the
      // computed type and the derived origin (`human`).
      const typed = await injectComputedTags(projectId, input);
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
      return {
        failed: {
          text: input.text,
          geoTargetId: input.geoTargetId,
          languageCode: input.languageCode,
          status: e.status || 500,
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
      created.push(r.created);
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

  // LLMO-6190 item 4: route each project's publish through `headroom.retryOnQuota` — a bounded
  // top-up+retry if it STILL 405s as a disguised metered-quota rejection despite the pre-write
  // sizing above (e.g. a raced concurrent write on the same child). `publishAffected` nests this
  // per-project, so a surviving 405 after the retry still lands in `publishErrors` for that project
  // rather than throwing. `headroom` is always defined (a genuine no-op when the flag is OFF).
  const publishErrors = await publishAffected(
    transport,
    workspaceId,
    affectedProjectIds,
    log,
    (fn) => headroom.retryOnQuota(fn, { callSite: 'publishAffected' }),
  );
  // publishAffected returns { projectId, message } records whose message is
  // ALREADY redacted (redactUpstreamMessage) — pubErr is a record, not a raw error.
  for (const pubErr of publishErrors) {
    failed.push({ text: '', status: 502, message: `publish: ${pubErr.message}` });
  }

  return { created, skipped, failed };
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

  // Recompute the type tag from the NEW text BEFORE any upstream write (see
  // the flat-mode twin): a classification failure aborts cleanly with the
  // prompt completely untouched.
  // No `originValue`: origin is never re-derived on edit (origin-dimension.md §3
  // item 3); the stored origin the caller echoes rides through untouched. See the
  // flat-mode twin handleUpdatePrompt.
  const injectComputedTags = makePromptTagInjector(transport, workspaceId, classifyPromptType, log);
  const typed = await injectComputedTags(projectId, {
    text: nextText, geoTargetId, tagIds: nextTagIds,
  });

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
 */
export async function handleBulkDeletePromptsSubworkspace(transport, workspaceId, body, log) {
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
  );
  // pubErr is an already-redacted { projectId, message } record (see above).
  publishErrors.forEach((pubErr) => {
    failed.push({ semrushPromptId: '', status: 502, message: `publish: ${pubErr.message}` });
  });

  return { deleted, failed };
}
