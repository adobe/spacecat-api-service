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

import {
  listProjectsForBrand,
  resolveProjectsForPrompt,
} from '../matrix.js';

const DEFAULT_PAGE_SIZE = 200;

/**
 * Build a stable, opaque logical id for a prompt. Two prompts collapse to
 * the same logical id when they share (brand, category, language, text);
 * region differences fan out as multiple Semrush projects under the same
 * logical id. base64url-encoded JSON keeps the descriptor self-describing
 * without needing a side-channel database lookup.
 */
export function encodeLogicalId({
  brandId, category, language, text,
}) {
  const payload = JSON.stringify({
    b: String(brandId || ''),
    c: String(category || ''),
    l: String(language || ''),
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
      category: obj.c,
      language: obj.l,
      text: obj.t,
    };
  } catch {
    return null;
  }
}

function pickPrimaryTagName(tags) {
  // Semrush prompts may carry multiple tags. We use the first tag's name as
  // the topic for display — the matrix already pins category/market/language
  // via the project, so tag depth doesn't change attribution.
  const first = Array.isArray(tags) && tags.length > 0 ? tags[0] : null;
  return first?.name || null;
}

function fetchProjectPrompts(transport, project, { search }) {
  return transport.listPromptsByTags(project.workspaceId, project.projectId, {
    tag_ids: [],
    page: 1,
    limit: DEFAULT_PAGE_SIZE,
    search: search || undefined,
  });
}

function filterProjects(projects, query) {
  const wantRegion = query?.region ? String(query.region).toUpperCase() : null;
  const wantLanguage = query?.language ? String(query.language).toLowerCase() : null;
  const wantCategory = query?.category ? String(query.category).trim() : null;
  return projects.filter((p) => {
    if (wantRegion && p.market !== wantRegion) {
      return false;
    }
    if (wantLanguage && p.language !== wantLanguage) {
      return false;
    }
    if (wantCategory && p.category !== wantCategory) {
      return false;
    }
    return true;
  });
}

function ingestProjectItems(grouped, brandId, project, items) {
  for (const item of items) {
    const text = item?.name || '';
    if (text) {
      const logicalId = encodeLogicalId({
        brandId,
        category: project.category,
        language: project.language,
        text,
      });
      if (!grouped.has(logicalId)) {
        grouped.set(logicalId, {
          id: logicalId,
          brandId,
          text,
          category: project.category,
          language: project.language,
          topic: pickPrimaryTagName(item.tags),
          regions: [],
          projects: [],
        });
      }
      const entry = grouped.get(logicalId);
      if (!entry.regions.includes(project.market)) {
        entry.regions.push(project.market);
      }
      entry.projects.push({
        projectId: project.projectId,
        market: project.market,
        semrushPromptId: item.id,
      });
    }
  }
}

export async function handleListPrompts(transport, env, brandId, query) {
  const projects = listProjectsForBrand(env, brandId);
  const filtered = filterProjects(projects, query);
  const search = query?.search?.trim() || '';

  const responses = await Promise.allSettled(
    filtered.map(async (project) => {
      const result = await fetchProjectPrompts(transport, project, { search });
      return { project, result };
    }),
  );

  const grouped = new Map();
  const errors = [];

  for (const r of responses) {
    if (r.status === 'fulfilled') {
      const { project, result } = r.value;
      const items = Array.isArray(result?.items) ? result.items : [];
      ingestProjectItems(grouped, brandId, project, items);
    } else {
      errors.push({ message: r.reason?.message || String(r.reason) });
    }
  }

  const all = Array.from(grouped.values());
  const page = Math.max(1, parseInt(query?.page ?? '1', 10) || 1);
  const limit = Math.max(1, Math.min(parseInt(query?.limit ?? '50', 10) || 50, 200));
  const start = (page - 1) * limit;
  const pageItems = all.slice(start, start + limit);

  return {
    items: pageItems,
    total: all.length,
    page,
    limit,
    errors: errors.length ? errors : undefined,
  };
}

async function createOnSingleProject(transport, project, tagName, text) {
  const promptsByTag = { [tagName]: [text] };
  try {
    const r = await transport.createTaggedPrompts(
      project.workspaceId,
      project.projectId,
      promptsByTag,
    );
    const semrushPromptId = Array.isArray(r?.ids) && r.ids.length > 0 ? r.ids[0] : null;
    return {
      projectId: project.projectId,
      market: project.market,
      semrushPromptId,
    };
  } catch (e) {
    return {
      projectId: project.projectId,
      market: project.market,
      error: { status: e.status || 500, message: e.message },
    };
  }
}

function createOnProjects(transport, projectsByTag, text) {
  return Promise.all(
    projectsByTag.map(({ project, tagName }) => (
      createOnSingleProject(transport, project, tagName, text)
    )),
  );
}

function validatePromptInput(input) {
  const text = String(input?.text || '').trim();
  const category = String(input?.category || '').trim();
  const language = String(input?.language || '').trim().toLowerCase();
  const regions = Array.isArray(input?.regions) ? input.regions : [];
  const topic = String(input?.topic || category || 'general');
  if (!text || !category || !language || regions.length === 0) {
    return null;
  }
  return {
    text, category, language, regions, topic,
  };
}

async function createOnePrompt(transport, env, brandId, input) {
  const normalized = validatePromptInput(input);
  if (!normalized) {
    return {
      error: {
        message: 'Prompt requires text, category, language, and at least one region',
        input,
      },
    };
  }
  const {
    text, category, language, regions, topic,
  } = normalized;

  const { matched, skipped } = resolveProjectsForPrompt(env, brandId, {
    category,
    regions,
    language,
  });

  if (matched.length === 0) {
    return {
      error: {
        message: 'No matrix projects matched for this prompt',
        input,
        skipped,
      },
    };
  }

  const projectsByTag = matched.map((project) => ({ project, tagName: topic }));
  const projectResults = await createOnProjects(transport, projectsByTag, text);

  return {
    created: {
      id: encodeLogicalId({
        brandId, category, language, text,
      }),
      brandId,
      text,
      category,
      language,
      topic,
      regions: matched.map((p) => p.market),
      projects: projectResults,
      skipped: skipped.length ? skipped : undefined,
    },
  };
}

export async function handleCreatePrompts(transport, env, brandId, body) {
  const inputs = Array.isArray(body?.prompts) ? body.prompts : [];
  if (inputs.length === 0) {
    return { created: [], errors: [{ message: 'No prompts in request body' }] };
  }

  const results = await Promise.all(
    inputs.map((input) => createOnePrompt(transport, env, brandId, input)),
  );

  const created = [];
  const errors = [];
  for (const r of results) {
    if (r.created) {
      created.push(r.created);
    } else if (r.error) {
      errors.push(r.error);
    }
  }
  return { created, errors };
}

async function deleteOnSingleProject(transport, project, ids) {
  try {
    await transport.deletePromptsByIds(project.workspaceId, project.projectId, ids);
    return { projectId: project.projectId, deleted: ids.length };
  } catch (e) {
    return {
      projectId: project.projectId,
      error: { status: e.status || 500, message: e.message },
    };
  }
}

async function deleteByPerProjectIds(transport, env, brandId, targets) {
  const projects = listProjectsForBrand(env, brandId);
  const byProject = new Map();
  for (const t of targets) {
    if (t?.projectId && t?.semrushPromptId) {
      if (!byProject.has(t.projectId)) {
        byProject.set(t.projectId, []);
      }
      byProject.get(t.projectId).push(t.semrushPromptId);
    }
  }

  const tasks = Array.from(byProject.entries()).map(([projectId, ids]) => {
    const project = projects.find((p) => p.projectId === projectId);
    if (!project) {
      return Promise.resolve({
        projectId,
        error: { status: 404, message: 'Project not in matrix' },
      });
    }
    return deleteOnSingleProject(transport, project, ids);
  });
  return Promise.all(tasks);
}

export async function handleBulkDeletePrompts(transport, env, brandId, body) {
  const targets = Array.isArray(body?.targets) ? body.targets : [];
  if (targets.length === 0) {
    return { deleted: 0, results: [], errors: [{ message: 'No targets supplied' }] };
  }
  const results = await deleteByPerProjectIds(transport, env, brandId, targets);
  const deleted = results.reduce((sum, r) => sum + (r.deleted || 0), 0);
  const errors = results.filter((r) => r.error).map((r) => r.error);
  return { deleted, results, errors };
}

export async function handleUpdatePrompt(transport, env, brandId, logicalId, body) {
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
  const currentProjects = Array.isArray(body?.projects) ? body.projects : [];
  if (currentProjects.length === 0) {
    return {
      status: 400,
      body: {
        error: 'missingProjects',
        message: 'PATCH body must include `projects` from a prior list response so the proxy can clean up old Semrush entries.',
      },
    };
  }

  const next = {
    text: String(body?.text ?? decoded.text),
    category: String(body?.category ?? decoded.category),
    language: String(body?.language ?? decoded.language).toLowerCase(),
    topic: body?.topic ? String(body.topic) : null,
    regions: Array.isArray(body?.regions)
      ? body.regions
      : currentProjects.map((p) => String(p.market || '').toUpperCase()).filter(Boolean),
  };

  const deleteResults = await deleteByPerProjectIds(transport, env, brandId, currentProjects);

  const createResult = await handleCreatePrompts(transport, env, brandId, {
    prompts: [{
      text: next.text,
      category: next.category,
      language: next.language,
      topic: next.topic || next.category,
      regions: next.regions,
    }],
  });

  return {
    status: 200,
    body: {
      updated: createResult.created[0] || null,
      deleted: deleteResults,
      errors: [...(createResult.errors || [])],
    },
  };
}
