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
  const geoTargetId = Number.isInteger(query?.geoTargetId) && query.geoTargetId > 0
    ? query.geoTargetId : null;
  const languageCode = hasText(query?.languageCode)
    ? String(query.languageCode).toLowerCase() : null;
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'geoTargetId (integer) and languageCode (BCP-47 primary subtag) are required',
      400,
    );
  }

  const page = Math.max(1, parseInt(query?.page ?? '1', 10) || 1);
  const rawLimit = parseInt(query?.limit ?? String(DEFAULT_PAGE_LIMIT), 10)
    || DEFAULT_PAGE_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, MAX_PAGE_LIMIT));
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
  const languageCode = String(input?.languageCode || '').trim().toLowerCase();
  const geoTargetId = Number(input?.geoTargetId);
  const tags = Array.isArray(input?.tags)
    ? input.tags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  if (!text || !languageCode || !Number.isInteger(geoTargetId) || geoTargetId <= 0) {
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
    return { created: [], skipped: [], failed: [] };
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

async function findUpstreamPromptByText(transport, semrushWorkspaceId, semrushProjectId, text) {
  // PATCH carries only text/tags; we look up the current upstream prompt by
  // listing the project (paginated) and matching on prompt name. Cost is
  // bounded; only paid on PATCH (low volume). Returns the full item so the
  // caller can preserve tags when PATCH omits them.
  const FETCH_PAGE_SIZE = 200;
  const MAX_PAGES = 50;
  let page = 1;
  while (page <= MAX_PAGES) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await transport.listPromptsByTags(semrushWorkspaceId, semrushProjectId, {
      tag_ids: [],
      page,
      limit: FETCH_PAGE_SIZE,
      search: text,
    });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    const found = items.find((it) => (it?.name || '') === text);
    if (found) {
      return found;
    }
    if (items.length < FETCH_PAGE_SIZE) {
      break;
    }
    page += 1;
  }
  return null;
}

/**
 * PATCH /serenity/prompts/:semrushPromptId — partial update.
 *
 * Body carries `{geoTargetId, languageCode, text?, tags?}`. The slice
 * resolves the owning BrandSemrushProject; upstream DELETE-old + POST-new +
 * publish. The :semrushPromptId in the URL identifies the prompt being
 * replaced and is logged for traceability — the upstream prompt id
 * inevitably changes on re-create.
 *
 * Tags-omit preserves the old tags (PATCH semantics: "don't change").
 * Explicit empty array clears them.
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
  if (!hasText(semrushPromptId)) {
    return {
      status: 400,
      body: { error: 'missingPromptId', message: 'Path :semrushPromptId is required' },
    };
  }
  if (!body || (body.text === undefined && body.tags === undefined)) {
    return {
      status: 400,
      body: { error: 'missingFields', message: 'PATCH body must include text or tags' },
    };
  }
  const geoTargetId = Number(body.geoTargetId);
  const languageCode = hasText(body.languageCode)
    ? String(body.languageCode).toLowerCase() : null;
  if (!Number.isInteger(geoTargetId) || geoTargetId <= 0 || languageCode === null) {
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
  // Look up the current upstream prompt by the URL :semrushPromptId by
  // listing pages and matching id. We need the row to read its current text
  // (for the next-text fallback) and tags (for the preserve-on-omit case).
  let oldItem = null;
  let pageIdx = 1;
  const LIMIT = 200;
  while (pageIdx <= 50) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await transport.listPromptsByTags(semrushWorkspaceId, projectId, {
      tag_ids: [],
      page: pageIdx,
      limit: LIMIT,
    });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    oldItem = items.find((it) => String(it?.id ?? '') === String(semrushPromptId)) || null;
    if (oldItem || items.length < LIMIT) {
      break;
    }
    pageIdx += 1;
  }
  if (!oldItem) {
    // Fall back: maybe the caller passed text+slice expecting upsert. Try
    // text-based lookup using body.text (only safe if text was provided).
    if (hasText(body.text)) {
      oldItem = await findUpstreamPromptByText(
        transport,
        semrushWorkspaceId,
        projectId,
        String(body.text),
      );
    }
    if (!oldItem) {
      return {
        status: 404,
        body: {
          error: 'promptNotFound',
          message: 'No upstream prompt matches the supplied semrushPromptId in this slice',
        },
      };
    }
  }
  const oldId = String(oldItem.id);
  const oldText = String(oldItem?.name || '');
  const oldTags = tagNamesOf(oldItem);
  const nextText = body.text === undefined ? oldText : String(body.text);
  let nextTags;
  if (body.tags === undefined) {
    nextTags = oldTags;
  } else {
    nextTags = Array.isArray(body.tags)
      ? body.tags.map((t) => String(t || '').trim()).filter(Boolean)
      : [];
  }

  try {
    await transport.deletePromptsByIds(semrushWorkspaceId, projectId, [oldId]);
  } catch (e) {
    log?.warn?.('deletePromptsByIds (PATCH) failed', { error: e.message });
  }

  const resp = await transport.createTaggedPrompts(
    semrushWorkspaceId,
    projectId,
    { [nextText]: nextTags },
  );
  const newSemrushPromptId = Array.isArray(resp?.ids) && resp.ids.length > 0
    ? String(resp.ids[0]) : '';

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
    const geoTargetId = Number(t?.geoTargetId);
    const languageCode = hasText(t?.languageCode)
      ? String(t.languageCode).toLowerCase() : '';
    if (!sid || !Number.isInteger(geoTargetId) || geoTargetId <= 0 || !languageCode) {
      failed.push({
        semrushPromptId: sid,
        geoTargetId: Number.isFinite(geoTargetId) ? geoTargetId : null,
        languageCode: languageCode || null,
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
