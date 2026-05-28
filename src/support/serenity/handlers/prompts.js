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
import { normalizeGeoTargetId, normalizeLanguageCode } from '../validation.js';
import { invalidateTagCacheForProject } from './markets.js';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 1000;
// Caps the inflight upstream calls when fanning out a bulk create.
// 8 keeps per-call wall time reasonable without overwhelming upstream rate
// limits — the prior `serenity` testing exhausted Semrush's shared limit
// with higher concurrency.
const BULK_CREATE_CONCURRENCY = 8;

function tagNamesOf(item) {
  if (!Array.isArray(item?.tags)) {
    return [];
  }
  return item.tags
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter(Boolean);
}

function buildPromptDto(geoTargetId, languageCode, item) {
  const text = item?.name || '';
  if (!text) {
    return null;
  }
  return {
    semrushPromptId: String(item?.id ?? ''),
    geoTargetId,
    languageCode,
    text,
    tags: tagNamesOf(item),
  };
}

/**
 * GET /serenity/prompts?geoTargetId=&languageCode=&page=&limit=&search= —
 * list prompts for one slice. Both filters are required (the route handler
 * returns 400 if either is missing). Pagination is real upstream
 * pagination — one slice = one project = one upstream call set per page.
 */
export async function handleListPrompts(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  query,
) {
  const geoTargetId = normalizeGeoTargetId(query?.geoTargetId);
  const languageCode = normalizeLanguageCode(query?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'geoTargetId (integer) and languageCode (BCP-47 primary subtag) are required',
      400,
    );
  }

  // `parsedQuery` in the controller has already converted page/limit to
  // integers (or null on parse failure). Trust that and skip the reparse.
  const page = Number.isInteger(query?.page) && query.page > 0 ? query.page : 1;
  const requestedLimit = Number.isInteger(query?.limit) && query.limit > 0
    ? query.limit : DEFAULT_PAGE_LIMIT;
  const limit = Math.min(requestedLimit, MAX_PAGE_LIMIT);
  const search = hasText(query?.search) ? String(query.search).trim() : undefined;

  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    return {
      items: [], total: 0, page, limit,
    };
  }

  const resp = await transport.listPromptsByTags(
    semrushWorkspaceId,
    row.getSemrushProjectId(),
    {
      tag_ids: [],
      page,
      limit,
      search,
    },
  );
  const items = Array.isArray(resp?.items) ? resp.items : [];
  const total = Number.isFinite(resp?.total) ? resp.total : items.length;
  return {
    items: items
      .map((item) => buildPromptDto(geoTargetId, languageCode, item))
      .filter(Boolean),
    total,
    page,
    limit,
  };
}

async function publishAffected(transport, semrushWorkspaceId, projectIds, log) {
  const unique = Array.from(new Set(projectIds.filter(Boolean)));
  const errors = [];
  await Promise.all(unique.map(async (pid) => {
    try {
      await transport.publishProject(semrushWorkspaceId, pid);
    } catch (e) {
      log?.warn?.('publishProject failed', { projectId: pid, error: e.message });
      errors.push({ projectId: pid, message: e.message });
    }
  }));
  return errors;
}

function normalizePromptInput(input) {
  const text = String(input?.text || '').trim();
  const languageCode = normalizeLanguageCode(input?.languageCode);
  const geoTargetId = normalizeGeoTargetId(Number(input?.geoTargetId));
  const tags = Array.isArray(input?.tags)
    ? input.tags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  if (!text || languageCode === null || geoTargetId === null) {
    return null;
  }
  return {
    text, languageCode, geoTargetId, tags,
  };
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const idx = i;
        i += 1;
        if (idx >= items.length) {
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        out[idx] = await mapper(items[idx], idx);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/**
 * POST /serenity/prompts — bulk create.
 * Each input must carry `(geoTargetId, languageCode, text, tags?)`. Inputs
 * are grouped by slice; the matching BrandSemrushProject row resolves the
 * upstream project; publish runs once per affected project at the end.
 */
export async function handleCreatePrompts(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
) {
  const inputs = Array.isArray(body?.prompts) ? body.prompts : [];
  if (inputs.length === 0) {
    throw new ErrorWithStatusCode('Body must include a non-empty prompts array', 400);
  }

  const projects = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  const projectsBySlice = new Map();
  for (const p of projects || []) {
    projectsBySlice.set(`${p.getGeoTargetId()}:${p.getLanguageCode()}`, p);
  }

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
      const resp = await transport.createTaggedPrompts(
        semrushWorkspaceId,
        projectId,
        { [input.text]: input.tags },
      );
      const semrushPromptId = Array.isArray(resp?.ids) && resp.ids.length > 0
        ? String(resp.ids[0]) : '';
      return {
        created: {
          semrushPromptId,
          geoTargetId: input.geoTargetId,
          languageCode: input.languageCode,
          text: input.text,
          tags: input.tags,
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
          message: e.message,
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

  // Tag cache invalidation: a new prompt may introduce a new tag (or
  // resurrect a tag whose last prompt was previously deleted), so any
  // project that received a successful create must drop its cached
  // tag set on this container.
  for (const pid of new Set(affectedProjectIds)) {
    invalidateTagCacheForProject(semrushWorkspaceId, pid);
  }

  const publishErrors = await publishAffected(
    transport,
    semrushWorkspaceId,
    affectedProjectIds,
    log,
  );
  for (const e of publishErrors) {
    failed.push({
      text: '',
      status: 502,
      message: `publish: ${e.message}`,
    });
  }

  return { created, skipped, failed };
}

/**
 * Walks `listPromptsByTags` to find an item by id. Returns null when the
 * id is not present in any page. Used by the slow path of PATCH below to
 * read old text/tags for preserve-on-omit semantics; not needed when the
 * client provides both `text` and `tags` (the fast path uses the upstream
 * DELETE response for the existence check instead of this walk).
 */
async function findPromptById(transport, semrushWorkspaceId, projectId, semrushPromptId) {
  const LIMIT = 200;
  for (let pageIdx = 1; pageIdx <= 50; pageIdx += 1) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await transport.listPromptsByTags(semrushWorkspaceId, projectId, {
      tag_ids: [],
      page: pageIdx,
      limit: LIMIT,
    });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    const found = items.find((it) => String(it?.id ?? '') === String(semrushPromptId));
    if (found) {
      return found;
    }
    if (items.length < LIMIT) {
      return null;
    }
  }
  return null;
}

/**
 * PATCH /serenity/prompts/:semrushPromptId — partial update.
 *
 * Body carries `{geoTargetId, languageCode, text?, tags?}`. Two paths:
 *
 *   Fast path — body provides BOTH `text` and `tags`.
 *     Skip the prompt walk: we already have the id from the URL, and the
 *     body fully specifies the new state. Use upstream DELETE's response
 *     for the 404 contract: DELETE returns 404 → return 404 to client,
 *     DELETE succeeds → proceed to CREATE, DELETE 5xx → propagate as 502
 *     (the upstream prompt stays in place, retry-safe).
 *
 *   Slow path — body omits either `text` or `tags` (preserve-on-omit).
 *     Paginate `listPromptsByTags` to find the old item, then PATCH
 *     semantics: omitted text → keep `oldItem.name`; omitted tags →
 *     keep `tagNamesOf(oldItem)`. Same DELETE error handling as above.
 *
 * DELETE failure is never swallowed — a previous version warn-logged and
 * proceeded to CREATE, which produced duplicate prompts whenever the
 * upstream DELETE flaked (5xx/timeout). Now: 404 → 404, other errors →
 * 502 (no CREATE).
 *
 * The new upstream prompt id is always different (re-create), and
 * tag-cache invalidation runs after the successful CREATE so the next
 * /serenity/tags read for this project sees any newly-introduced tag.
 */
export async function handleUpdatePrompt(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  semrushPromptId,
  body,
  log,
) {
  // `semrushPromptId` is validated as non-empty at the controller boundary
  // (serenity.js:259) before this handler is invoked over HTTP, so no
  // re-check here.
  if (!body || (body.text === undefined && body.tags === undefined)) {
    return {
      status: 400,
      body: { error: 'missingFields', message: 'PATCH body must include text or tags' },
    };
  }
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

  const project = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!project) {
    return {
      status: 404,
      body: {
        error: 'marketNotFound',
        message: 'No market for this brand and (geoTargetId, languageCode) slice',
      },
    };
  }
  const projectId = project.getSemrushProjectId();

  const hasFullPayload = body.text !== undefined && body.tags !== undefined;
  let nextText;
  let nextTags;

  if (hasFullPayload) {
    // Fast path: trust the client-supplied state, skip the walk.
    nextText = String(body.text);
    nextTags = Array.isArray(body.tags)
      ? body.tags.map((t) => String(t || '').trim()).filter(Boolean)
      : [];
  } else {
    // Slow path: paginate to read old item for preserve-on-omit.
    const oldItem = await findPromptById(transport, semrushWorkspaceId, projectId, semrushPromptId);
    if (!oldItem) {
      return {
        status: 404,
        body: {
          error: 'promptNotFound',
          message: 'No upstream prompt matches the supplied semrushPromptId in this slice',
        },
      };
    }
    const oldText = String(oldItem?.name || '');
    const oldTags = tagNamesOf(oldItem);
    nextText = body.text === undefined ? oldText : String(body.text);
    if (body.tags === undefined) {
      nextTags = oldTags;
    } else if (Array.isArray(body.tags)) {
      nextTags = body.tags.map((t) => String(t || '').trim()).filter(Boolean);
    } else {
      nextTags = [];
    }
  }

  // Unified DELETE error handling for both paths. 404 → return 404 to the
  // client (fast path's existence check; slow path catches the edge case
  // where the item disappeared between findPromptById and this DELETE).
  // Any other error propagates as 502 so we never CREATE a duplicate.
  try {
    await transport.deletePromptsByIds(semrushWorkspaceId, projectId, [semrushPromptId]);
  } catch (e) {
    if (e?.status === 404) {
      return {
        status: 404,
        body: {
          error: 'promptNotFound',
          message: 'No upstream prompt matches the supplied semrushPromptId in this slice',
        },
      };
    }
    log?.error?.('handleUpdatePrompt: deletePromptsByIds failed; aborting before create to avoid duplicate', {
      projectId,
      semrushPromptId,
      error: e.message,
    });
    throw e;
  }

  const resp = await transport.createTaggedPrompts(
    semrushWorkspaceId,
    projectId,
    { [nextText]: nextTags },
  );
  const newSemrushPromptId = Array.isArray(resp?.ids) && resp.ids.length > 0
    ? String(resp.ids[0]) : '';

  // A PATCH can introduce a new tag (or drop the last carrier of an old
  // tag), so drop the cached tag set for this project on this container.
  invalidateTagCacheForProject(semrushWorkspaceId, projectId);

  await publishAffected(transport, semrushWorkspaceId, [projectId], log);

  return {
    status: 200,
    body: {
      semrushPromptId: newSemrushPromptId,
      geoTargetId,
      languageCode,
      text: nextText,
      tags: nextTags,
    },
  };
}

/**
 * POST /serenity/prompts/bulk-delete — body is
 * `{ prompts: [{semrushPromptId, geoTargetId, languageCode}, ...] }`.
 * Resolves each row's owning slice, batches deletes per upstream project,
 * publishes affected projects. Upstream 404 == idempotent success.
 */
export async function handleBulkDeletePrompts(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
) {
  const targets = Array.isArray(body?.prompts) ? body.prompts : [];
  if (targets.length === 0) {
    throw new ErrorWithStatusCode('Body must include a non-empty prompts array', 400);
  }

  const projects = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  const projectBySlice = new Map();
  for (const p of projects || []) {
    projectBySlice.set(
      `${p.getGeoTargetId()}:${p.getLanguageCode()}`,
      p.getSemrushProjectId(),
    );
  }

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
    const pid = projectBySlice.get(`${geoTargetId}:${languageCode}`);
    if (!pid) {
      failed.push({
        semrushPromptId: sid,
        geoTargetId,
        languageCode,
        message: `No market for slice (${geoTargetId}, ${languageCode})`,
      });
      return;
    }
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
      await transport.deletePromptsByIds(semrushWorkspaceId, pid, bucket.ids);
      deleted += bucket.ids.length;
      projectsToPublish.add(pid);
    } catch (e) {
      if (e?.status === 404) {
        deleted += bucket.ids.length;
        projectsToPublish.add(pid);
        log?.info?.('bulk-delete: upstream already-deleted (404 treated as success)', { ids: bucket.ids });
        return;
      }
      bucket.targets.forEach((t) => {
        failed.push({
          semrushPromptId: t.semrushPromptId,
          geoTargetId: t.geoTargetId,
          languageCode: t.languageCode,
          status: e.status || 500,
          message: e.message,
        });
      });
    }
  }));

  // Deleting prompts can remove the last carrier of a tag in the project,
  // so any project that lost prompts must drop its cached tag set on this
  // container.
  for (const pid of projectsToPublish) {
    invalidateTagCacheForProject(semrushWorkspaceId, pid);
  }

  const publishErrors = await publishAffected(
    transport,
    semrushWorkspaceId,
    Array.from(projectsToPublish),
    log,
  );
  publishErrors.forEach((e) => {
    failed.push({
      semrushPromptId: '',
      status: 502,
      message: `publish: ${e.message}`,
    });
  });

  return { deleted, failed };
}
