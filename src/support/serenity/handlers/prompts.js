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

function pickTagNames(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags.map((t) => t?.name).filter(Boolean);
}

// Hard cap so a runaway project doesn't blow the request out. Semrush's
// largest single-project prompt set we've seen is ~7k; the cap is generous.
const MAX_PROMPTS_PER_PROJECT = 10000;

/**
 * Paginate through `POST /aio/prompts/by_tags` until we've collected every
 * prompt in the project (or hit the safety cap). Semrush returns
 * `{ items, page, total }`; we keep advancing `page` until items run out or
 * we've fetched `total`.
 */
async function fetchProjectPrompts(transport, project, { search }) {
  const collected = [];
  let page = 1;
  let total = Infinity;
  while (collected.length < total && collected.length < MAX_PROMPTS_PER_PROJECT) {
    // eslint-disable-next-line no-await-in-loop
    const result = await transport.listPromptsByTags(project.workspaceId, project.projectId, {
      tag_ids: [],
      page,
      limit: DEFAULT_PAGE_SIZE,
      search: search || undefined,
    });
    const items = Array.isArray(result?.items) ? result.items : [];
    if (items.length === 0) {
      break;
    }
    collected.push(...items);
    total = Number.isFinite(result?.total) ? result.total : collected.length;
    page += 1;
  }
  return { items: collected, total: collected.length, page: 1 };
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

function parseTimestamp(v) {
  if (v == null) {
    return 0;
  }
  if (typeof v === 'number') {
    return v > 1e12 ? v : v * 1000;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

function ingestProjectItems(grouped, sortKeys, brandId, project, items) {
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
          tags: pickTagNames(item.tags),
          regions: [],
          projects: [],
        });
        sortKeys.set(logicalId, { createdAtMs: 0, idStr: '' });
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
      const key = sortKeys.get(logicalId);
      const itemCreatedAtMs = parseTimestamp(
        item?.created_at ?? item?.createdAt ?? item?.created ?? null,
      );
      if (itemCreatedAtMs > key.createdAtMs) {
        key.createdAtMs = itemCreatedAtMs;
      }
      const idStr = String(item?.id ?? '');
      if (idStr > key.idStr) {
        key.idStr = idStr;
      }
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
  const sortKeys = new Map();
  const errors = [];

  for (const r of responses) {
    if (r.status === 'fulfilled') {
      const { project, result } = r.value;
      const items = Array.isArray(result?.items) ? result.items : [];
      ingestProjectItems(grouped, sortKeys, brandId, project, items);
    } else {
      errors.push({ message: r.reason?.message || String(r.reason) });
    }
  }

  const all = Array.from(grouped.values());

  // Newest-first ordering so prompts just minted via createPrompts (e.g.
  // Tracking Recommendations) surface at the top of page 1. Primary key:
  // max `created_at` across project refs (set when Semrush returns one).
  // Fallback: lexicographic comparison of the max `semrushPromptId` string —
  // works for either numeric-string ids (where lex order tracks insertion
  // order for equal-length ids) or opaque ids (deterministic tiebreaker).
  all.sort((a, b) => {
    const ka = sortKeys.get(a.id) || { createdAtMs: 0, idStr: '' };
    const kb = sortKeys.get(b.id) || { createdAtMs: 0, idStr: '' };
    if (kb.createdAtMs !== ka.createdAtMs) {
      return kb.createdAtMs - ka.createdAtMs;
    }
    return kb.idStr.localeCompare(ka.idStr);
  });

  const page = Math.max(1, parseInt(query?.page ?? '1', 10) || 1);
  const limit = Math.max(1, Math.min(parseInt(query?.limit ?? '50', 10) || 50, 200));
  const start = (page - 1) * limit;
  const pageItems = all.slice(start, start + limit);

  const availableTags = Array.from(
    new Set(all.flatMap((p) => (Array.isArray(p.tags) ? p.tags : []))),
  ).sort();

  return {
    items: pageItems,
    total: all.length,
    page,
    limit,
    availableTags,
    errors: errors.length ? errors : undefined,
  };
}

async function createOnSingleProject(transport, project, text, tagNames) {
  // Semrush /aio/prompts/tagged body is text-keyed: { prompts: { [text]: [tag1, tag2, ...] } }
  const promptsByText = { [text]: tagNames };
  try {
    const r = await transport.createTaggedPrompts(
      project.workspaceId,
      project.projectId,
      promptsByText,
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

function createOnProjects(transport, projects, text, tagNames) {
  return Promise.all(
    projects.map((project) => (
      createOnSingleProject(transport, project, text, tagNames)
    )),
  );
}

/**
 * Publish every distinct (workspaceId, projectId) pair so freshly created /
 * updated / deleted prompts move out of the project's draft buffer and become
 * visible in subsequent listings. Failures are swallowed — Semrush returns 202
 * Accepted and the publish is async; a publish error shouldn't fail the
 * mutation itself, but should be surfaced so the caller can warn the user.
 */
async function publishAffectedProjects(transport, projectRefs, log) {
  const unique = new Map();
  for (const p of projectRefs) {
    if (p?.workspaceId && p?.projectId) {
      unique.set(`${p.workspaceId}:${p.projectId}`, p);
    }
  }
  const errors = [];
  await Promise.all(Array.from(unique.values()).map(async (p) => {
    try {
      await transport.publishProject(p.workspaceId, p.projectId);
    } catch (e) {
      log?.warn?.('publishProject failed', { projectId: p.projectId, error: e.message });
      errors.push({ projectId: p.projectId, message: e.message });
    }
  }));
  return errors;
}

function normalizeTopics(input) {
  if (Array.isArray(input?.topics)) {
    return input.topics.map((t) => String(t || '').trim()).filter(Boolean);
  }
  if (input?.topic) {
    return [String(input.topic).trim()].filter(Boolean);
  }
  return [];
}

function validatePromptInput(input) {
  const text = String(input?.text || '').trim();
  const category = String(input?.category || '').trim();
  const language = String(input?.language || '').trim().toLowerCase();
  const regions = Array.isArray(input?.regions) ? input.regions : [];
  const topics = normalizeTopics(input);
  if (!text || !category || !language || regions.length === 0) {
    return null;
  }
  return {
    text, category, language, regions, topics,
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
    text, category, language, regions, topics,
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

  const tagNames = topics.length > 0 ? topics : [category];
  const projectResults = await createOnProjects(transport, matched, text, tagNames);

  return {
    created: {
      id: encodeLogicalId({
        brandId, category, language, text,
      }),
      brandId,
      text,
      category,
      language,
      topic: tagNames[0] || null,
      tags: tagNames,
      regions: matched.map((p) => p.market),
      projects: projectResults,
      skipped: skipped.length ? skipped : undefined,
    },
    affectedProjects: matched.map((p) => ({ workspaceId: p.workspaceId, projectId: p.projectId })),
  };
}

export async function handleCreatePrompts(transport, env, brandId, body, log) {
  const inputs = Array.isArray(body?.prompts) ? body.prompts : [];
  if (inputs.length === 0) {
    return { created: [], errors: [{ message: 'No prompts in request body' }] };
  }

  const results = await Promise.all(
    inputs.map((input) => createOnePrompt(transport, env, brandId, input)),
  );

  const created = [];
  const errors = [];
  const affectedProjectRefs = [];
  for (const r of results) {
    if (r.created) {
      created.push(r.created);
      if (Array.isArray(r.affectedProjects)) {
        affectedProjectRefs.push(...r.affectedProjects);
      }
    } else if (r.error) {
      errors.push(r.error);
    }
  }
  const publishErrors = await publishAffectedProjects(transport, affectedProjectRefs, log);
  if (publishErrors.length > 0) {
    errors.push(...publishErrors.map((e) => ({ ...e, message: `publish: ${e.message}` })));
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

export async function handleBulkDeletePrompts(transport, env, brandId, body, log) {
  const targets = Array.isArray(body?.targets) ? body.targets : [];
  if (targets.length === 0) {
    return { deleted: 0, results: [], errors: [{ message: 'No targets supplied' }] };
  }
  const results = await deleteByPerProjectIds(transport, env, brandId, targets);
  const deleted = results.reduce((sum, r) => sum + (r.deleted || 0), 0);
  const errors = results.filter((r) => r.error).map((r) => r.error);

  const matrix = listProjectsForBrand(env, brandId);
  const affectedRefs = Array.from(new Set(results.map((r) => r.projectId).filter(Boolean)))
    .map((pid) => matrix.find((m) => m.projectId === pid))
    .filter(Boolean)
    .map((m) => ({ workspaceId: m.workspaceId, projectId: m.projectId }));
  const publishErrors = await publishAffectedProjects(transport, affectedRefs, log);
  if (publishErrors.length > 0) {
    errors.push(...publishErrors.map((e) => ({ ...e, message: `publish: ${e.message}` })));
  }
  return { deleted, results, errors };
}

export async function handleUpdatePrompt(transport, env, brandId, logicalId, body, log) {
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
    topics: normalizeTopics(body),
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
      topics: next.topics.length > 0 ? next.topics : [next.category],
      regions: next.regions,
    }],
  }, log);

  // handleCreatePrompts already publishes projects affected by the new content,
  // but the projects we deleted from may be different (e.g. region changed),
  // so publish those too. publishAffectedProjects de-dupes by (ws, projectId).
  const matrix = listProjectsForBrand(env, brandId);
  const deletedRefs = Array.from(new Set(deleteResults.map((r) => r.projectId).filter(Boolean)))
    .map((pid) => matrix.find((m) => m.projectId === pid))
    .filter(Boolean)
    .map((m) => ({ workspaceId: m.workspaceId, projectId: m.projectId }));
  const publishErrors = await publishAffectedProjects(transport, deletedRefs, log);

  return {
    status: 200,
    body: {
      updated: createResult.created[0] || null,
      deleted: deleteResults,
      errors: [
        ...(createResult.errors || []),
        ...publishErrors.map((e) => ({ ...e, message: `publish: ${e.message}` })),
      ],
    },
  };
}
