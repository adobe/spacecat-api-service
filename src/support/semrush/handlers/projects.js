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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { hasText } from '@adobe/spacecat-shared-utils';

// JSON import assertions ('with { type: "json" }') aren't supported by the
// repo's eslint parser, so we read the locations table from disk once at
// module load. The file ships in the lambda bundle next to this handler.
const LOCATIONS_JSON_PATH = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'locations.json',
);
const locationsData = JSON.parse(readFileSync(LOCATIONS_JSON_PATH, 'utf8'));

const LANGUAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const LANGUAGE_TAG_REGEX = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

/**
 * Map ISO-2 country code (uppercase) -> { locationId, locationName }. Lazy
 * normalised on first access so we don't pay the work on cold start.
 */
let normalizedLocations = null;
function getLocations() {
  if (!normalizedLocations) {
    normalizedLocations = new Map();
    for (const [iso, value] of Object.entries(locationsData)) {
      if (value && Number.isInteger(value.locationId)) {
        normalizedLocations.set(String(iso).toUpperCase(), {
          locationId: value.locationId,
          locationName: value.locationName,
        });
      }
    }
  }
  return normalizedLocations;
}

/**
 * Resolves an ISO-2 market code to Semrush's location_id (= Google Ads
 * Geo Target ID). Returns null on unknown markets; controllers map to 400.
 */
export function resolveLocation(market) {
  if (!hasText(market)) {
    return null;
  }
  return getLocations().get(String(market).toUpperCase()) || null;
}

/**
 * Module-scoped Semrush language UUID cache. 1h TTL — the catalog is stable
 * but languages do get added occasionally, so we don't pin it for the
 * lifetime of the warm Lambda container.
 */
const languageCache = {
  expiresAt: 0,
  byTag: new Map(),
};

export function clearLanguageCache() {
  languageCache.expiresAt = 0;
  languageCache.byTag.clear();
}

async function resolveLanguageId(transport, languageTag) {
  const now = Date.now();
  if (languageCache.expiresAt <= now) {
    const resp = await transport.listLanguages();
    const items = Array.isArray(resp?.items) ? resp.items : [];
    languageCache.byTag.clear();
    for (const item of items) {
      const code = item?.code || item?.iso || item?.tag;
      if (hasText(code) && hasText(item?.id)) {
        languageCache.byTag.set(String(code).toLowerCase(), String(item.id));
      }
    }
    languageCache.expiresAt = now + LANGUAGE_CACHE_TTL_MS;
  }
  return languageCache.byTag.get(String(languageTag).toLowerCase()) || null;
}

/**
 * GET /semrush/projects — DB rows enriched with live Semrush metadata
 * (name, domain) via one `listWorkspaceProjects` call.
 */
export async function handleListProjects(transport, dataAccess, brandId, workspaceId, query) {
  const rows = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  if (!rows || rows.length === 0) {
    return { items: [] };
  }

  const wantLoc = Number.isInteger(query?.semrushLocationId) && query.semrushLocationId > 0
    ? query.semrushLocationId : null;
  const wantLang = hasText(query?.language) ? String(query.language).toLowerCase() : null;
  const filtered = rows.filter((row) => {
    if (wantLoc !== null && row.getSemrushLocationId() !== wantLoc) {
      return false;
    }
    if (wantLang !== null && row.getLanguage() !== wantLang) {
      return false;
    }
    return true;
  });
  if (filtered.length === 0) {
    return { items: [] };
  }

  let liveByProjectId = new Map();
  try {
    const resp = await transport.listWorkspaceProjects(workspaceId);
    const items = Array.isArray(resp?.items) ? resp.items : [];
    liveByProjectId = new Map(
      items
        .filter((p) => p && hasText(p.id))
        .map((p) => [String(p.id), { name: p.name, domain: p.domain }]),
    );
  } catch {
    // If the upstream list call fails, return the rows without enrichment
    // rather than 502'ing the whole request. The DB rows are still
    // authoritative for slice membership.
  }

  return {
    items: filtered.map((row) => {
      const projectId = row.getSemrushProjectId();
      const live = liveByProjectId.get(projectId) || {};
      return {
        brandId,
        semrushProjectId: projectId,
        semrushLocationId: row.getSemrushLocationId(),
        language: row.getLanguage(),
        name: live.name,
        domain: live.domain,
        workspaceId,
        createdAt: row.getCreatedAt ? row.getCreatedAt() : undefined,
        updatedAt: row.getUpdatedAt ? row.getUpdatedAt() : undefined,
      };
    }),
  };
}

function validateCreateBody(body) {
  const errors = [];
  if (!hasText(body?.name)) {
    errors.push('name is required');
  }
  if (!hasText(body?.market) || !/^[A-Za-z]{2}$/.test(body.market)) {
    errors.push('market must be an ISO-2 country code');
  }
  if (!hasText(body?.language) || !LANGUAGE_TAG_REGEX.test(body.language)) {
    errors.push('language must match ^[a-z]{2,3}(-[a-z]{2,4})?$');
  }
  if (!hasText(body?.brandDomain)) {
    errors.push('brandDomain is required');
  }
  if (!Array.isArray(body?.brandNames) || body.brandNames.length === 0
      || !body.brandNames.every(hasText)) {
    errors.push('brandNames must be a non-empty array of strings');
  }
  if (body?.projectType !== undefined && body.projectType !== 'aio') {
    errors.push("projectType, when provided, must be 'aio'");
  }
  return errors;
}

/**
 * POST /semrush/projects — onboard a new (brand, location, language) slice.
 *
 * Strict ordering: upstream create -> upstream publish -> DB row.
 * A row is written **only** when both upstream calls succeed. Callers may
 * safely retry with the same body — the 409 gate on findBySlice catches
 * duplicates before the upstream call.
 */
export async function handleCreateProject(transport, dataAccess, brandId, workspaceId, body) {
  const errors = validateCreateBody(body);
  if (errors.length > 0) {
    return {
      status: 400,
      body: { error: 'invalidRequest', messages: errors },
    };
  }
  const location = resolveLocation(body.market);
  if (!location) {
    return {
      status: 400,
      body: {
        error: 'unknownMarket',
        message: `Unknown market '${body.market}' — not in locations table`,
      },
    };
  }
  const language = String(body.language).toLowerCase();

  const existing = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    location.locationId,
    language,
  );
  if (existing) {
    return {
      status: 409,
      body: {
        error: 'sliceExists',
        message: 'Brand already has a Semrush project for this (locationId, language) slice',
        semrushProjectId: existing.getSemrushProjectId(),
      },
    };
  }

  const languageId = await resolveLanguageId(transport, language);
  if (!languageId) {
    return {
      status: 400,
      body: {
        error: 'unknownLanguage',
        message: `Language '${language}' not found in Semrush catalog`,
      },
    };
  }

  const upstreamBody = {
    name: String(body.name),
    type: 'aio',
    brand_name_display: body.brandNames[0],
    brand_names: body.brandNames,
    domain: body.brandDomain,
    country_code: body.market.toLowerCase(),
    location_id: location.locationId,
    location_name: location.locationName,
    language_id: languageId,
  };

  // Upstream create. SemrushTransportError propagates to the controller, which
  // maps it to a 502 envelope. No row written when this throws.
  const createResp = await transport.createProject(workspaceId, upstreamBody);
  const semrushProjectId = String(createResp?.id || '');
  if (!hasText(semrushProjectId)) {
    return {
      status: 502,
      body: {
        error: 'createNoProjectId',
        message: 'Semrush createProject returned no id',
      },
    };
  }

  // Upstream publish. Same rule — no row on failure.
  await transport.publishProject(workspaceId, semrushProjectId);

  await dataAccess.BrandSemrushProject.create({
    brandId,
    semrushProjectId,
    semrushLocationId: location.locationId,
    language,
  });

  return {
    status: 201,
    body: {
      semrushProjectId,
      semrushLocationId: location.locationId,
      language,
      name: upstreamBody.name,
      workspaceId,
    },
  };
}

/**
 * GET /semrush/projects/:workspaceId/:projectId/tags — unique tag names across
 * the project's prompts. Paginated.
 */
export async function handleListProjectTags(transport, workspaceId, projectId) {
  const seen = new Map();
  let page = 1;
  const LIMIT = 200;
  // Match the safety cap in prompts.js: 50 pages * 200 = 10k items.
  while (page <= 50) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await transport.listPromptsByTags(workspaceId, projectId, {
      tag_ids: [],
      page,
      limit: LIMIT,
    });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    for (const item of items) {
      const tags = Array.isArray(item?.tags) ? item.tags : [];
      for (const t of tags) {
        if (typeof t === 'string') {
          if (!seen.has(t)) {
            seen.set(t, { id: t, name: t });
          }
        } else if (t && hasText(t.name)) {
          const id = hasText(t.id) ? String(t.id) : t.name;
          if (!seen.has(id)) {
            seen.set(id, { id, name: t.name });
          }
        }
      }
    }
    if (items.length < LIMIT) {
      break;
    }
    page += 1;
  }
  return {
    items: Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * GET /semrush/projects/:workspaceId/:projectId/models — AI models configured
 * for the project. `key` is what the Semrush Reporting API expects in
 * `CBF_model` filter clauses.
 */
export async function handleListProjectModels(transport, workspaceId, projectId) {
  const resp = await transport.listAiModels(workspaceId, projectId);
  const items = Array.isArray(resp?.items) ? resp.items : [];
  const models = items
    .map((it) => it?.model)
    .filter((m) => m && typeof m === 'object' && hasText(m.id) && hasText(m.key))
    .map((m) => ({
      id: m.id,
      key: m.key,
      name: m.name,
      icon: m.icon,
    }));
  return { models };
}

/**
 * GET /semrush/workspaces/:workspaceId/projects — all projects in a workspace.
 * Used by the Brand Presence dashboard's Category filter.
 *
 * Response shape uses `projects` (not `items`) to match
 * SemrushWorkspaceProjectListResponse in docs/openapi/schemas.yaml.
 */
export async function handleListWorkspaceProjects(transport, workspaceId) {
  const resp = await transport.listWorkspaceProjects(workspaceId);
  const items = Array.isArray(resp?.items) ? resp.items : [];
  return {
    projects: items
      .filter((p) => p && hasText(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        domain: p.domain,
      })),
  };
}
