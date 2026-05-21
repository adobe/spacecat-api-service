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

const FETCH_PAGE_SIZE = 200;
const MAX_PROMPTS_PER_PROJECT = 10000;

/**
 * Logical id: opaque, stable across Semrush re-creates. Encodes
 * (brandId, semrushLocationId, language, text) so we can resolve back to a
 * BrandSemrushProject row without a side-channel lookup on PATCH.
 */
export function encodeLogicalId({
  brandId, semrushLocationId, language, text,
}) {
  const payload = JSON.stringify({
    b: String(brandId || ''),
    l: Number(semrushLocationId) || 0,
    lang: String(language || ''),
    t: String(text || ''),
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeLogicalId(id) {
  try {
    const json = Buffer.from(id, 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    return {
      brandId: obj.b,
      semrushLocationId: Number(obj.l) || 0,
      language: obj.lang,
      text: obj.t,
    };
  } catch {
    return null;
  }
}

function tagNamesOf(item) {
  if (!Array.isArray(item?.tags)) {
    return [];
  }
  return item.tags
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter(Boolean);
}

async function fetchProjectPrompts(transport, workspaceId, project, search) {
  const collected = [];
  let page = 1;
  let total = Infinity;
  while (collected.length < total && collected.length < MAX_PROMPTS_PER_PROJECT) {
    // eslint-disable-next-line no-await-in-loop
    const result = await transport.listPromptsByTags(
      workspaceId,
      project.getSemrushProjectId(),
      {
        tag_ids: [],
        page,
        limit: FETCH_PAGE_SIZE,
        search: hasText(search) ? search : undefined,
      },
    );
    const items = Array.isArray(result?.items) ? result.items : [];
    if (items.length === 0) {
      break;
    }
    collected.push(...items);
    total = Number.isFinite(result?.total) ? result.total : collected.length;
    page += 1;
  }
  return collected;
}

function buildPromptDto(brandId, project, item) {
  const text = item?.name || '';
  if (!text) {
    return null;
  }
  const semrushLocationId = project.getSemrushLocationId();
  const language = project.getLanguage();
  return {
    id: encodeLogicalId({
      brandId, semrushLocationId, language, text,
    }),
    semrushId: String(item?.id ?? ''),
    semrushProjectId: project.getSemrushProjectId(),
    semrushLocationId,
    language,
    text,
    tags: tagNamesOf(item),
  };
}

function filterProjects(projects, query) {
  const wantLoc = Number.isInteger(query?.semrushLocationId) && query.semrushLocationId > 0
    ? query.semrushLocationId : null;
  const wantLang = hasText(query?.language) ? String(query.language).toLowerCase() : null;
  return projects.filter((p) => {
    if (wantLoc !== null && p.getSemrushLocationId() !== wantLoc) {
      return false;
    }
    if (wantLang !== null && p.getLanguage() !== wantLang) {
      return false;
    }
    return true;
  });
}

/**
 * GET /semrush/prompts — fan out across every BrandSemrushProject mapped to
 * the brand, merge results, paginate.
 */
export async function handleListPrompts(transport, dataAccess, brandId, workspaceId, query) {
  const projects = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  if (!projects || projects.length === 0) {
    return {
      items: [], total: 0, page: 1, limit: 50, errors: undefined,
    };
  }

  const filtered = filterProjects(projects, query);
  const search = hasText(query?.search) ? String(query.search).trim() : '';

  const responses = await Promise.allSettled(
    filtered.map(async (project) => ({
      project,
      items: await fetchProjectPrompts(transport, workspaceId, project, search),
    })),
  );

  const dtos = [];
  const errors = [];
  for (const r of responses) {
    if (r.status === 'fulfilled') {
      const { project, items } = r.value;
      for (const item of items) {
        const dto = buildPromptDto(brandId, project, item);
        if (dto) {
          dtos.push(dto);
        }
      }
    } else {
      errors.push({ message: r.reason?.message || String(r.reason) });
    }
  }

  const page = Math.max(1, parseInt(query?.page ?? '1', 10) || 1);
  const limit = Math.max(1, Math.min(parseInt(query?.limit ?? '50', 10) || 50, 1000));
  const start = (page - 1) * limit;

  return {
    items: dtos.slice(start, start + limit),
    total: dtos.length,
    page,
    limit,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function publishAffected(transport, workspaceId, projectIds, log) {
  const unique = Array.from(new Set(projectIds.filter(Boolean)));
  const errors = [];
  await Promise.all(unique.map(async (pid) => {
    try {
      await transport.publishProject(workspaceId, pid);
    } catch (e) {
      log?.warn?.('publishProject failed', { projectId: pid, error: e.message });
      errors.push({ semrushProjectId: pid, message: e.message });
    }
  }));
  return errors;
}

function normalizePromptInput(input) {
  const text = String(input?.text || '').trim();
  const language = String(input?.language || '').trim().toLowerCase();
  const semrushLocationId = Number(input?.semrushLocationId);
  const tags = Array.isArray(input?.tags)
    ? input.tags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  if (!text || !language || !Number.isInteger(semrushLocationId) || semrushLocationId <= 0) {
    return null;
  }
  return {
    text, language, semrushLocationId, tags,
  };
}

/**
 * POST /semrush/prompts — bulk create.
 * Each input is grouped by (semrushLocationId, language); the matching
 * BrandSemrushProject row resolves the upstream project; publish runs once
 * per affected project at the end.
 */
export async function handleCreatePrompts(
  transport,
  dataAccess,
  brandId,
  workspaceId,
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
    projectsBySlice.set(`${p.getSemrushLocationId()}:${p.getLanguage()}`, p);
  }

  const tasks = inputs.map(async (raw) => {
    const input = normalizePromptInput(raw);
    if (!input) {
      return {
        skipped: {
          text: String(raw?.text || ''),
          reason: 'text, language, and semrushLocationId are required',
        },
      };
    }
    const project = projectsBySlice.get(`${input.semrushLocationId}:${input.language}`);
    if (!project) {
      return {
        skipped: {
          text: input.text,
          reason: `No BrandSemrushProject for slice (${input.semrushLocationId}, ${input.language})`,
        },
      };
    }
    const projectId = project.getSemrushProjectId();
    try {
      const resp = await transport.createTaggedPrompts(
        workspaceId,
        projectId,
        { [input.text]: input.tags },
      );
      const semrushId = Array.isArray(resp?.ids) && resp.ids.length > 0
        ? String(resp.ids[0]) : '';
      return {
        created: {
          id: encodeLogicalId({
            brandId,
            semrushLocationId: input.semrushLocationId,
            language: input.language,
            text: input.text,
          }),
          semrushId,
          semrushProjectId: projectId,
          semrushLocationId: input.semrushLocationId,
          language: input.language,
          text: input.text,
          tags: input.tags,
        },
        affectedProjectId: projectId,
      };
    } catch (e) {
      return {
        failed: {
          text: input.text,
          semrushProjectId: projectId,
          status: e.status || 500,
          message: e.message,
        },
      };
    }
  });

  const results = await Promise.all(tasks);
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

  const publishErrors = await publishAffected(transport, workspaceId, affectedProjectIds, log);
  for (const e of publishErrors) {
    failed.push({
      text: '',
      semrushProjectId: e.semrushProjectId,
      status: 502,
      message: `publish: ${e.message}`,
    });
  }

  return { created, skipped, failed };
}

async function findSemrushPromptIdByText(transport, workspaceId, semrushProjectId, text) {
  // PATCH carries only text/tags; we look up the current semrush prompt id by
  // listing the project (paginated) and matching on prompt name. Cost is
  // bounded by MAX_PROMPTS_PER_PROJECT and only paid on PATCH (low volume).
  const collected = await fetchProjectPrompts(
    transport,
    workspaceId,
    {
      getSemrushProjectId: () => semrushProjectId,
    },
    text,
  );
  const match = collected.find((it) => (it?.name || '') === text);
  return match ? String(match.id) : null;
}

/**
 * PATCH /semrush/prompts/:promptId — partial update. Decodes the logical id
 * to find the owning slice, looks up the current Semrush prompt id by text,
 * then DELETE-old + POST-new + publish.
 */
export async function handleUpdatePrompt(
  transport,
  dataAccess,
  brandId,
  workspaceId,
  logicalId,
  body,
  log,
) {
  const decoded = decodeLogicalId(logicalId);
  if (!decoded || decoded.brandId !== String(brandId)) {
    return {
      status: 400,
      body: {
        error: 'invalidLogicalId',
        message: 'Logical id does not match brand',
      },
    };
  }
  if (!body || (body.text === undefined && body.tags === undefined)) {
    return {
      status: 400,
      body: {
        error: 'missingFields',
        message: 'PATCH body must include text or tags',
      },
    };
  }
  const project = await dataAccess.BrandSemrushProject.findBySlice(
    decoded.brandId,
    decoded.semrushLocationId,
    decoded.language,
  );
  if (!project) {
    return {
      status: 404,
      body: {
        error: 'projectNotFound',
        message: 'No BrandSemrushProject for this prompt\'s slice',
      },
    };
  }
  const semrushProjectId = project.getSemrushProjectId();
  const oldSemrushId = await findSemrushPromptIdByText(
    transport,
    workspaceId,
    semrushProjectId,
    decoded.text,
  );

  const nextText = String(body.text ?? decoded.text);
  const nextTags = Array.isArray(body.tags)
    ? body.tags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];

  if (oldSemrushId) {
    try {
      await transport.deletePromptsByIds(workspaceId, semrushProjectId, [oldSemrushId]);
    } catch (e) {
      log?.warn?.('deletePromptsByIds (PATCH) failed', { error: e.message });
    }
  }

  const resp = await transport.createTaggedPrompts(
    workspaceId,
    semrushProjectId,
    { [nextText]: nextTags },
  );
  const newSemrushId = Array.isArray(resp?.ids) && resp.ids.length > 0
    ? String(resp.ids[0]) : '';

  await publishAffected(transport, workspaceId, [semrushProjectId], log);

  return {
    status: 200,
    body: {
      id: encodeLogicalId({
        brandId: decoded.brandId,
        semrushLocationId: decoded.semrushLocationId,
        language: decoded.language,
        text: nextText,
      }),
      semrushId: newSemrushId,
      semrushProjectId,
      semrushLocationId: decoded.semrushLocationId,
      language: decoded.language,
      text: nextText,
      tags: nextTags,
    },
  };
}

/**
 * POST /semrush/prompts/bulk-delete — body is
 * `{ semrushIds: [{semrushProjectId, semrushPromptId}] }`.
 * Validates each projectId is in the brand's mapped projects, deletes per
 * project in one upstream call each, publishes affected projects.
 */
export async function handleBulkDeletePrompts(
  transport,
  dataAccess,
  brandId,
  workspaceId,
  body,
  log,
) {
  const targets = Array.isArray(body?.semrushIds) ? body.semrushIds : [];
  if (targets.length === 0) {
    return { deleted: 0, failed: [{ message: 'No semrushIds supplied' }] };
  }

  const projects = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  const projectIds = new Set((projects || []).map((p) => p.getSemrushProjectId()));

  const byProject = new Map();
  const failed = [];
  targets.forEach((t) => {
    const pid = String(t?.semrushProjectId || '');
    const sid = String(t?.semrushPromptId || '');
    if (!pid || !sid) {
      failed.push({
        semrushProjectId: pid,
        semrushPromptId: sid,
        message: 'Missing semrushProjectId or semrushPromptId',
      });
    } else if (!projectIds.has(pid)) {
      failed.push({
        semrushProjectId: pid,
        semrushPromptId: sid,
        message: 'Project not mapped to brand',
      });
    } else {
      if (!byProject.has(pid)) {
        byProject.set(pid, []);
      }
      byProject.get(pid).push(sid);
    }
  });

  let deleted = 0;
  await Promise.all(Array.from(byProject.entries()).map(async ([pid, ids]) => {
    try {
      await transport.deletePromptsByIds(workspaceId, pid, ids);
      deleted += ids.length;
    } catch (e) {
      ids.forEach((sid) => {
        failed.push({
          semrushProjectId: pid,
          semrushPromptId: sid,
          status: e.status || 500,
          message: e.message,
        });
      });
    }
  }));

  const publishErrors = await publishAffected(
    transport,
    workspaceId,
    Array.from(byProject.keys()),
    log,
  );
  publishErrors.forEach((e) => {
    failed.push({
      semrushProjectId: e.semrushProjectId,
      semrushPromptId: '',
      status: 502,
      message: `publish: ${e.message}`,
    });
  });

  return { deleted, failed };
}
