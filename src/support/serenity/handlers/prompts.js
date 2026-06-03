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
import { ERROR_CODES, isUpstreamGone } from '../errors.js';
import { normalizeGeoTargetId, normalizeLanguageCode } from '../validation.js';
import { invalidateTagCacheForProject } from './markets.js';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 1000;
const MAX_TAG_IDS = 50;
// Caps the inflight upstream calls when fanning out a bulk create.
// 8 keeps per-call wall time reasonable without overwhelming upstream rate
// limits — the prior `serenity` testing exhausted Semrush's shared limit
// with higher concurrency.
const BULK_CREATE_CONCURRENCY = 8;
// Matches the OpenAPI declaration (`maxItems: 500` on
// SerenityCreatePromptsRequest.prompts and SerenityBulkDeletePromptsRequest.prompts).
// Enforced here because the api-service does not run OpenAPI request validation
// as middleware — without this cap, an IMS-authenticated caller could submit
// tens of thousands of items inside API Gateway's request envelope and the
// handler would faithfully build per-project Maps + upstream payloads for all
// of them. Defense-in-depth, not a correctness gate.
const BULK_PROMPTS_MAX_ITEMS = 500;

// Builds { tagName → semrushTagId } from the upstream prompt item.
// Object-form tags (the normal Semrush shape) carry both name and id.
// String-form tags (defensive fallback) are included with an empty id so
// callers can still read the name via Object.keys() — they are excluded
// from tag_ids filtering because filter(Boolean) drops empty strings.
function buildTagMapOf(item) {
  if (!Array.isArray(item?.tags)) {
    return {};
  }
  return item.tags.reduce((acc, t) => {
    if (typeof t === 'string' && t) {
      acc[t] = '';
    } else if (typeof t === 'object' && t?.name) {
      acc[t.name] = t.id ? String(t.id) : '';
    }
    return acc;
  }, {});
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
    tagMap: buildTagMapOf(item),
  };
}

/**
 * GET /serenity/prompts?geoTargetId=&languageCode=&page=&limit=&search=&tagIds= —
 * list prompts for one slice. geoTargetId and languageCode are required.
 * Pagination is real upstream pagination — one slice = one project = one
 * upstream call set per page.
 *
 * tagIds (repeatable): Semrush tag UUIDs from SerenityPrompt.tagMap. Passed
 * as tag_ids to the by_tags endpoint. Semrush applies OR semantics — prompts
 * carrying any of the supplied tag IDs are returned. AND semantics must be
 * enforced by the caller if needed.
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
  const tagIds = Array.isArray(query?.tagIds)
    ? query.tagIds.slice(0, MAX_TAG_IDS).map(String).filter(Boolean)
    : [];

  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    // Aligns with handleUpdatePrompt's missing-slice contract: a renamed
    // /deleted market between page load and the call should not silently
    // render an empty list — that hides "this slice no longer exists" behind
    // the same response shape as "this slice exists but has no prompts".
    // Single-slice handlers (list, PATCH) emit 404 marketNotFound; bulk
    // handlers (create, bulk-delete) keep their per-item skipped/failed
    // shape because each item carries its own slice and the body can mix
    // slices that exist with slices that don't. (Review Important #4.)
    const err = new ErrorWithStatusCode(
      'No market for this brand and (geoTargetId, languageCode) slice',
      404,
    );
    err.code = ERROR_CODES.MARKET_NOT_FOUND;
    throw err;
  }

  const resp = await transport.listPromptsByTags(
    semrushWorkspaceId,
    row.getSemrushProjectId(),
    {
      tag_ids: tagIds,
      page,
      limit,
      search,
    },
  );
  const items = Array.isArray(resp?.items) ? resp.items : [];
  // When fewer items than the limit are returned we are on the last page and
  // know the exact filtered count. Avoids trusting the upstream total which
  // may be the project-wide count rather than the tag/search-filtered count.
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
  if (inputs.length > BULK_PROMPTS_MAX_ITEMS) {
    throw new ErrorWithStatusCode(
      `prompts array exceeds maxItems=${BULK_PROMPTS_MAX_ITEMS}`,
      400,
    );
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
 * PATCH /serenity/prompts/:semrushPromptId — replace.
 *
 * Body carries `{geoTargetId, languageCode, text, tags}`. All four are
 * required: the upstream provider has no in-place update (no GET-by-id
 * either), so the implementation is DELETE-then-CREATE and we treat the
 * payload as the full next state. Clients always have the existing
 * `text`/`tags` available locally (they were returned by the preceding
 * list call that rendered the edit form), so requiring both keeps the
 * server side a single straight line and removes the per-request
 * pagination that "preserve-on-omit" semantics would force.
 *
 * Contract:
 *   - body missing text or tags → 400 (missingFields).
 *   - slice missing on the brand → 404 (marketNotFound).
 *   - upstream DELETE returns 404 → 404 (promptNotFound).
 *   - upstream DELETE returns any other error → throw (handler-level
 *     500 / 502 mapping by the controller). We never CREATE after a
 *     failed DELETE: a previous warn-and-create behaviour produced
 *     duplicate prompts whenever DELETE flaked (5xx / timeout).
 *
 * After a successful CREATE the per-project tag cache is invalidated on
 * this container (a PATCH can introduce a new tag or drop the last
 * carrier of an old tag), then `publishProject` is fired to push the
 * new upstream prompt id live.
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
  if (!body || body.text === undefined || body.tags === undefined) {
    return {
      status: 400,
      body: { error: 'missingFields', message: 'PATCH body must include both text and tags' },
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

  const nextText = String(body.text);
  const nextTags = Array.isArray(body.tags)
    ? body.tags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];

  try {
    await transport.deletePromptsByIds(semrushWorkspaceId, projectId, [semrushPromptId]);
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
  if (targets.length > BULK_PROMPTS_MAX_ITEMS) {
    throw new ErrorWithStatusCode(
      `prompts array exceeds maxItems=${BULK_PROMPTS_MAX_ITEMS}`,
      400,
    );
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
      if (isUpstreamGone(e)) {
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
