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
import { iso31661Alpha2ToNumeric } from 'iso-3166';

const LANGUAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const LANGUAGE_TAG_REGEX = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

// Pagination caps for list endpoints. The upstream Semrush API returns
// 100/page; a workspace with hundreds of projects is unusual but plausible.
const WORKSPACE_PROJECTS_PAGE = 100;
const MAX_WORKSPACE_PROJECTS_PAGES = 20; // 2000 projects ceiling
const AI_MODELS_PAGE = 100;
const MAX_AI_MODELS_PAGES = 5;

// `handleListProjectTags` paginates over every prompt in a project to
// derive the unique tag set; if the dashboard polls this on every page
// load that's expensive at scale. Tags change rarely (operators add/rename
// them manually), so a short-TTL cache is a clean fit. Same pattern as the
// language cache below.
const TAG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TAG_CACHE_MAX_ENTRIES = 512;

// Reusable English region-name formatter (ICU-backed, built into Node). Used
// for the `location_name` we send upstream — matches the form Semrush already
// stores on existing projects (`United States`, `Germany`, `Türkiye`).
const ENGLISH_REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Resolves an ISO 3166-1 alpha-2 country code to Semrush's `location_id`
 * (= Google Ads "Geo Target ID") plus an English display name suitable for
 * `location_name` on the upstream create-project body. Returns null on
 * unknown / unassigned codes; the controller maps that to 400.
 *
 * Why `2000 + ISO numeric` works
 * ─────────────────────────────────────────────────────────────────────────
 * Google Ads Geo Targets use a multi-digit `criterion_id` whose first digit
 * encodes the target *type*:
 *   - 1xxx: region / metro / state
 *   - 2xxx: country
 *   - 5xxx, 9xxx, …: airport, postal code, neighbourhood, university, …
 * For countries, the remaining digits are the country's ISO 3166-1 numeric
 * code, so `criterion_id = 2000 + ISO numeric`. Verified 2026-05-22 against
 * every project in the Adobe LLMO-Dev Semrush workspace
 * (US→2840, DE→2276, FR→2250, AU→2036, …). Semrush echoes the same
 * `location.id` back on read, so this stays consistent over time.
 *
 * Canonical Google Ads dataset (countries + cities + ZIPs + airports + …) is
 * downloadable as CSV from:
 *   https://developers.google.com/google-ads/api/data/geotargets
 *
 * TODO(LLMO-XXXX): cities / regions / postal codes do NOT follow this
 * formula — their `criterion_id`s come from the Google CSV above and aren't
 * derivable from ISO codes. When sub-national geo lands in the UX, either
 * (a) proxy a Semrush-side location-search endpoint if/when they expose one
 * (verified absent 2026-05-22 — they accept the integer but don't expose a
 * `/v1/locations/search`), or (b) lazy-load the Google geotargets CSV from
 * S3 on first use and search in-memory. Whichever path, only this function
 * needs to change — `semrush_location_id` is already the slice key.
 */
export function resolveLocation(market) {
  if (!hasText(market)) {
    return null;
  }
  const alpha2 = String(market).toUpperCase();
  const numeric = iso31661Alpha2ToNumeric[alpha2];
  if (!numeric) {
    return null;
  }
  return {
    locationId: 2000 + Number(numeric),
    locationName: ENGLISH_REGION_NAMES.of(alpha2),
  };
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

// Semrush's /v1/languages returns `{ id: <uuid>, name: <english name> }` per
// entry — no ISO/BCP-47 code field (verified 2026-05-22 against
// adobe-hackathon.semrush.com). Map the caller-supplied tag to the catalog's
// English name via the ECMAScript `Intl.DisplayNames` API (ICU-backed, built
// into Node, no dep). The constructor is reusable, so we cache one instance.
const ENGLISH_LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

/**
 * Maps a BCP-47 primary-subtag (`en`, `de`, `zh`, `zho`, ...) to the English
 * language name Semrush uses in its catalog (`English`, `German`, `Chinese`).
 * Returns null when the ICU table doesn't recognise the code (`.of()` echoes
 * the input back in that case, which we treat as "no name available").
 */
function isoToEnglishName(languageTag) {
  // Strip region/script subtag — Semrush's catalog is keyed by primary
  // language only (no `en-US` / `pt-BR` rows). Caller (handleCreateProject)
  // already enforces LANGUAGE_TAG_REGEX, so `primary` is always a 2–3 letter
  // string here — no need for an empty-input guard.
  const primary = String(languageTag).toLowerCase().split('-')[0];
  const name = ENGLISH_LANGUAGE_NAMES.of(primary);
  // ICU echoes the input back when the code is unknown. Treat that as a
  // miss — the lookup against the catalog would fail anyway.
  return name && name.toLowerCase() !== primary ? name : null;
}

async function resolveLanguageId(transport, languageTag, log) {
  const now = Date.now();
  if (languageCache.expiresAt <= now) {
    const resp = await transport.listLanguages();
    const items = Array.isArray(resp?.items) ? resp.items : [];
    languageCache.byTag.clear();
    for (const item of items) {
      if (hasText(item?.name) && hasText(item?.id)) {
        languageCache.byTag.set(String(item.name).toLowerCase(), String(item.id));
      }
    }
    if (languageCache.byTag.size === 0 && items.length > 0) {
      log?.warn?.(
        'resolveLanguageId: language catalog returned no usable names — Semrush field shape may have changed',
        { receivedKeys: Object.keys(items[0] || {}) },
      );
    }
    languageCache.expiresAt = now + LANGUAGE_CACHE_TTL_MS;
  }
  const englishName = isoToEnglishName(languageTag);
  if (!englishName) {
    return null;
  }
  return languageCache.byTag.get(englishName.toLowerCase()) || null;
}

/**
 * Fetches every page of `listWorkspaceProjects` up to MAX_WORKSPACE_PROJECTS_PAGES.
 * Workspaces typically have ~10–100 projects; the cap is a safety net.
 */
async function fetchAllWorkspaceProjects(transport, workspaceId) {
  const all = [];
  let page = 1;
  while (page <= MAX_WORKSPACE_PROJECTS_PAGES) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await transport.listWorkspaceProjects(workspaceId, {
      page,
      limit: WORKSPACE_PROJECTS_PAGE,
    });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    if (items.length === 0) {
      break;
    }
    all.push(...items);
    if (items.length < WORKSPACE_PROJECTS_PAGE) {
      break;
    }
    page += 1;
  }
  return all;
}

async function fetchAllAiModels(transport, workspaceId, projectId) {
  const all = [];
  let page = 1;
  while (page <= MAX_AI_MODELS_PAGES) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await transport.listAiModels(workspaceId, projectId, {
      page,
      limit: AI_MODELS_PAGE,
    });
    const items = Array.isArray(resp?.items) ? resp.items : [];
    if (items.length === 0) {
      break;
    }
    all.push(...items);
    if (items.length < AI_MODELS_PAGE) {
      break;
    }
    page += 1;
  }
  return all;
}

/**
 * GET /semrush/projects — DB rows enriched with live Semrush metadata
 * (name, domain) via `listWorkspaceProjects` (paginated).
 *
 * Enrichment failures are surfaced as `enrichment: 'failed'` in the response
 * rather than silently dropped — clients can distinguish "no upstream data"
 * from "upstream said nothing for this id".
 */
export async function handleListProjects(transport, dataAccess, brandId, workspaceId, query, log) {
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
  let enrichmentFailed = false;
  try {
    const items = await fetchAllWorkspaceProjects(transport, workspaceId);
    liveByProjectId = new Map(
      items
        .filter((p) => p && hasText(p.id))
        .map((p) => [String(p.id), { name: p.name, domain: p.domain }]),
    );
  } catch (e) {
    // Only swallow upstream transport failures — let TypeErrors etc. bubble
    // so a real bug isn't hidden as "enrichment unavailable".
    if (e?.name !== 'SemrushTransportError') {
      throw e;
    }
    enrichmentFailed = true;
    log?.warn?.('handleListProjects: enrichment lookup failed, returning rows without live metadata', {
      error: e.message,
    });
  }

  const out = {
    items: filtered.map((row) => {
      const projectId = row.getSemrushProjectId();
      const live = liveByProjectId.get(projectId) || {};
      return {
        brandId,
        semrushProjectId: projectId,
        semrushLocationId: row.getSemrushLocationId(),
        language: row.getLanguage(),
        name: live.name ?? null,
        domain: live.domain ?? null,
        workspaceId,
        createdAt: row.getCreatedAt ? row.getCreatedAt() : null,
        updatedAt: row.getUpdatedAt ? row.getUpdatedAt() : null,
      };
    }),
  };
  if (enrichmentFailed) {
    out.enrichment = 'failed';
  }
  return out;
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
 *
 * On publish-failure: the upstream project is orphaned (no row written, so
 * the 409 gate won't fire on retry). We log the orphan with the upstream id
 * so operators can clean it up.
 *
 * On concurrent-create race: two requests pass the 409 gate, both call
 * createProject (two upstream projects), the second `dataAccess.create` call
 * fails on the unique constraint. We catch that, log the orphaned upstream
 * id, and return 409. The race orphan and the publish orphan are the only
 * remaining edge cases; both surface in logs.
 */
export async function handleCreateProject(
  transport,
  dataAccess,
  brandId,
  workspaceId,
  body,
  log,
) {
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

  const languageId = await resolveLanguageId(transport, language, log);
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
    // Semrush's POST /v1/workspaces/{ws}/projects expects type='ai' (the value
    // the existing projects on /v2/workspaces/{ws}/projects come back with).
    // The 'AIO' value used as a query filter on the GET endpoint is a
    // distinct collection-level view, NOT a project type — using it on
    // the POST yields `ProjectRequest.Type ... 'oneof'` validation error.
    type: 'ai',
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

  // Upstream publish. Log + propagate on failure so the controller envelopes
  // as 502 — but tag the orphaned upstream id loudly so operators can clean
  // up the dangling Semrush project.
  try {
    await transport.publishProject(workspaceId, semrushProjectId);
  } catch (e) {
    log?.error?.(
      'handleCreateProject: orphaned upstream Semrush project after publish failure',
      {
        brandId,
        workspaceId,
        semrushProjectId,
        semrushLocationId: location.locationId,
        language,
        error: e.message,
      },
    );
    throw e;
  }

  try {
    await dataAccess.BrandSemrushProject.create({
      brandId,
      semrushProjectId,
      semrushLocationId: location.locationId,
      language,
    });
  } catch (e) {
    // Concurrent-create race: another request won the slice between our
    // findBySlice call and our INSERT. The DB raised the unique-constraint
    // violation — we have two upstream projects now; ours is the orphan.
    // PostgREST surfaces this as a 23505 sqlstate inside an error body; the
    // entity layer typically wraps it. We treat any insert failure here as
    // a possible race and respond 409 so the retry-after-race-loser path is
    // idempotent at the API layer.
    log?.error?.(
      'handleCreateProject: orphaned upstream Semrush project after row-create race',
      {
        brandId,
        workspaceId,
        semrushProjectId,
        semrushLocationId: location.locationId,
        language,
        error: e.message,
      },
    );
    const winner = await dataAccess.BrandSemrushProject
      .findBySlice(brandId, location.locationId, language);
    return {
      status: 409,
      body: {
        error: 'sliceExists',
        message: 'Brand already has a Semrush project for this (locationId, language) slice',
        semrushProjectId: winner ? winner.getSemrushProjectId() : '',
      },
    };
  }

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
 * Module-scoped tag cache: `${workspaceId}::${projectId}` → { items, expiresAt }.
 * Bounded by TAG_CACHE_MAX_ENTRIES with insertion-order eviction (matches the
 * pattern used in workspace-resolver). Exported for tests.
 */
const tagCache = new Map();

export function clearTagCache() {
  tagCache.clear();
}

function evictTagCacheIfNeeded() {
  while (tagCache.size >= TAG_CACHE_MAX_ENTRIES) {
    const oldest = tagCache.keys().next().value;
    /* c8 ignore next 3 -- defensive: size>=MAX implies a key exists */
    if (oldest === undefined) {
      break;
    }
    tagCache.delete(oldest);
  }
}

/**
 * GET /semrush/projects/:workspaceId/:projectId/tags — unique tag names across
 * the project's prompts. Paginated, with a short-TTL cache to keep this
 * cheap when called from dashboard polling.
 *
 * Tags change rarely (an operator adds them via the Semrush UI); the cache
 * trades a few minutes of staleness for cutting up-to-50 round-trips per
 * page load down to one.
 */
export async function handleListProjectTags(transport, workspaceId, projectId) {
  const cacheKey = `${workspaceId}::${projectId}`;
  const now = Date.now();
  const cached = tagCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { items: cached.items };
  }

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

  const sorted = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  tagCache.delete(cacheKey);
  evictTagCacheIfNeeded();
  tagCache.set(cacheKey, { items: sorted, expiresAt: now + TAG_CACHE_TTL_MS });
  return { items: sorted };
}

/**
 * GET /semrush/projects/:workspaceId/:projectId/models — AI models configured
 * for the project. `key` is what the Semrush Reporting API expects in
 * `CBF_model` filter clauses.
 */
export async function handleListProjectModels(transport, workspaceId, projectId) {
  const allItems = await fetchAllAiModels(transport, workspaceId, projectId);
  const items = allItems
    .map((it) => it?.model)
    .filter((m) => m && typeof m === 'object' && hasText(m.id) && hasText(m.key))
    .map((m) => ({
      id: m.id,
      key: m.key,
      name: m.name ?? null,
      icon: m.icon ?? null,
    }));
  return { items };
}

/**
 * GET /semrush/workspaces/:workspaceId/projects — all projects in a workspace.
 * Used by the Brand Presence dashboard's Category filter.
 */
export async function handleListWorkspaceProjects(transport, workspaceId) {
  const all = await fetchAllWorkspaceProjects(transport, workspaceId);
  return {
    items: all
      .filter((p) => p && hasText(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name ?? null,
        domain: p.domain ?? null,
      })),
  };
}
