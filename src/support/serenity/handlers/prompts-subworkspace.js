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
  makeTypeInjector,
  makeIntentInjector,
  parseUpdatePromptBody,
  mapLimit,
  publishAffected,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_TAG_IDS,
  BULK_CREATE_CONCURRENCY,
  BULK_PROMPTS_MAX_ITEMS,
  validateDeferPublish,
} from './prompts.js';
import { resolveProject, buildSliceProjectMap, sliceKey } from '../subworkspace-projects.js';
import { redactUpstreamMessage } from '../rest-transport.js';
import { classifyPromptIntents } from '../intent-classification.js';

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
  env,
  writeDeadline,
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
  const injectComputedType = makeTypeInjector(transport, workspaceId, classifyPromptType, log);
  const intentByText = await classifyPromptIntents(
    inputs.map((raw) => String(raw?.text || '')),
    { env, log, deadline: writeDeadline },
  );
  const injectComputedIntent = makeIntentInjector(transport, workspaceId, intentByText, log);

  const results = await mapLimit(inputs, BULK_CREATE_CONCURRENCY, async (raw) => {
    const input = normalizePromptInput(raw);
    if (!input) {
      return {
        skipped: {
          text: String(raw?.text || ''),
          reason: 'text, languageCode, and geoTargetId are required',
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
      // Unified layer: strip any caller-supplied type/intent + inject the computed ones.
      let typed = await injectComputedType(projectId, input);
      typed = await injectComputedIntent(projectId, typed);
      const semrushPromptId = await createOnePrompt(transport, workspaceId, projectId, typed);
      return {
        created: {
          semrushPromptId,
          geoTargetId: typed.geoTargetId,
          languageCode: input.languageCode,
          text: typed.text,
          tags: typed.tags,
          ...(typed.tagIds !== undefined ? { tagIds: typed.tagIds } : {}),
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

  if (deferPublish) {
    log?.info?.('serenity create-prompts (subworkspace): deferPublish set — prompts written as draft, publish skipped', {
      workspaceId, created: created.length, skipped: skipped.length, failed: failed.length,
    });
    return {
      created, skipped, failed, published: false,
    };
  }

  const publishErrors = await publishAffected(transport, workspaceId, affectedProjectIds, log);
  // publishAffected returns { projectId, message } records whose message is
  // ALREADY redacted (redactUpstreamMessage) — pubErr is a record, not a raw error.
  for (const pubErr of publishErrors) {
    failed.push({ text: '', status: 502, message: `publish: ${pubErr.message}` });
  }

  return {
    created, skipped, failed, published: true,
  };
}

/**
 * PATCH /serenity/prompts/:semrushPromptId (subworkspace) — replace. Resolves the
 * slice's project from the live listing, then runs the shared DELETE-then-CREATE
 * (we never CREATE after a failed DELETE — that produced duplicate prompts).
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
  const { text: nextText, tags: nextTags, tagIds: nextTagIds } = parsedBody;
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

  // Recompute the type AND intent tags from the NEW text BEFORE the delete (see
  // the flat-mode twin): the unified layer must not run between delete and create.
  const injectComputedType = makeTypeInjector(transport, workspaceId, classifyPromptType, log);
  const intentByText = await classifyPromptIntents(
    [nextText],
    { env, log, deadline: writeDeadline },
  );
  const injectComputedIntent = makeIntentInjector(transport, workspaceId, intentByText, log);
  let typed = await injectComputedType(projectId, {
    text: nextText, geoTargetId, tags: nextTags, tagIds: nextTagIds,
  });
  typed = await injectComputedIntent(projectId, typed);

  try {
    await transport.deletePromptsByIds(workspaceId, projectId, [semrushPromptId]);
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
    log?.error?.('handleUpdatePromptSubworkspace: deletePromptsByIds failed; aborting before create to avoid duplicate', {
      projectId,
      semrushPromptId,
      error: e.message,
    });
    throw e;
  }

  let newSemrushPromptId;
  try {
    newSemrushPromptId = await createOnePrompt(transport, workspaceId, projectId, typed);
  } catch (e) {
    // The DELETE above already succeeded, so the old prompt is gone upstream —
    // a failure here (e.g. an unresolvable tagId 500ing the atomic id-based
    // create) is a genuine data-loss event, not a retryable no-op. Log it
    // distinctly from the pre-delete failure above so on-call can tell "nothing
    // happened" apart from "the prompt is gone and must be recreated manually".
    log?.error?.('handleUpdatePromptSubworkspace: createOnePrompt failed AFTER a successful delete; the prompt is now lost upstream and must be recreated manually', {
      projectId,
      semrushPromptId,
      error: e.message,
    });
    throw e;
  }

  invalidateTagCacheForProject(workspaceId, projectId);

  await publishAffected(transport, workspaceId, [projectId], log);

  return {
    status: 200,
    body: {
      semrushPromptId: newSemrushPromptId,
      geoTargetId,
      languageCode,
      text: typed.text,
      tags: typed.tags,
      ...(typed.tagIds !== undefined ? { tagIds: typed.tagIds } : {}),
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
