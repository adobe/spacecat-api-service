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

import { resolveLocation } from './locations.js';

/**
 * Shared helpers for the subworkspace path (serenity dual-mode). In subworkspace mode there
 * is no BrandSemrushProject mapping: a brand's markets are enumerated live
 * from its subworkspace (v1 default view) and a slice resolves to a project
 * by matching the project's echoed settings. Both the read handlers and the
 * write/prompt/model handlers route their slice→project resolution through
 * here so the listing/mapping rules live in exactly one place.
 *
 * Read rules (workspace doc §2/§6, verified live 2026-06-15 against the dev
 * parent): the v1 default view (`GET …/projects?type=ai`) echoes the draft's
 * real settings as NESTED objects — `settings.ai.location.id` (numeric geo
 * target id) and `settings.ai.language.name` (BCP-47 code). Project list items
 * expose `updated_at` (and `published_at` when live) but NOT `created_at`. We
 * never trust the v2 list for draft settings (it returns `brand_names: null`).
 */

/**
 * Maps a Semrush `publish_status` to the market `status` surfaced on the
 * /serenity/markets DTO (design §3), 1:1:
 *   draft | publishing | initial_publish_failed→publish_failed |
 *   live | live_with_unpublished_updates
 */
export function mapPublishStatus(publishStatus) {
  switch (publishStatus) {
    case 'publishing': return 'publishing';
    case 'initial_publish_failed': return 'publish_failed';
    case 'live': return 'live';
    case 'live_with_unpublished_updates': return 'live_with_unpublished_updates';
    case 'draft':
    default:
      return 'draft';
  }
}

export function geoOf(project) {
  const ai = project?.settings?.ai;
  const raw = ai?.location?.id;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) {
    return n;
  }
  // Fallback for projects created in the Semrush native UI: they may carry only
  // a country (settings.ai.country.code) and leave settings.ai.location.id null.
  // Derive the country-level geoTargetId from the ISO-2 code via the same map
  // the create path uses, so a country market reads back with the exact
  // geoTargetId we would have written for it. Sub-national locations (cities,
  // regions) always carry a real location.id, so this only fills the country gap.
  const resolved = hasText(ai?.country?.code) ? resolveLocation(ai.country.code) : null;
  return resolved ? resolved.geoTargetId : null;
}

export function langOf(project) {
  const lang = project?.settings?.ai?.language?.name;
  return hasText(lang) ? String(lang).toLowerCase() : null;
}

// Deterministic ordering key for the duplicate-slice "oldest wins" rule. The
// key is built from the IMMUTABLE `created_at` plus the (immutable) project id
// ONLY — it deliberately does NOT fall back to `updated_at`. The v1 list view
// omits `created_at` today, so in practice every project's timestamp component
// is the empty string and the project id (stable) is what picks the canonical
// duplicate. Falling back to `updated_at` would make the choice UNSTABLE: a
// write bumps the canonical project's `updated_at`, pushing it later than its
// duplicate, so the OTHER project would become "oldest" and subsequent reads
// and writes would silently flip to it mid-life. ISO 8601 timestamps sort
// lexically, so when `created_at` is present it dominates the id suffix and the
// rule degrades to true chronological oldest.
function orderKey(project) {
  const ts = String(project?.created_at ?? '');
  return `${ts}|${String(project?.id ?? '')}`;
}

/**
 * Projects a raw Semrush project (v1 default view) onto the slice DTO the
 * elmo client binds, plus the additive `status`/`semrushProjectId` fields.
 * `createdAt`/`updatedAt` come from the project's own timestamps (also the key
 * used by the duplicate-race oldest-wins read, design §7).
 */
export function projectToSlice(project, brandId) {
  return {
    brandId,
    geoTargetId: geoOf(project),
    languageCode: langOf(project),
    // Projects expose no created_at; surface it when present (null otherwise),
    // and always carry updated_at. The elmo DTO treats both as optional.
    createdAt: project?.created_at ?? null,
    updatedAt: project?.updated_at ?? project?.published_at ?? null,
    status: mapPublishStatus(project?.publish_status),
    semrushProjectId: hasText(project?.id) ? String(project.id) : null,
  };
}

/**
 * Lists a subworkspace's projects (one v1 GET) and maps each to a slice.
 * Projects whose slice cannot be resolved (no geo/lang) are dropped — they are
 * not addressable markets.
 */
export async function listMarkets(transport, workspaceId, brandId) {
  const listing = await transport.listProjects(workspaceId);
  const items = Array.isArray(listing?.items) ? listing.items : [];
  return items
    .map((p) => projectToSlice(p, brandId))
    .filter((m) => m.geoTargetId !== null && m.languageCode !== null);
}

/** Slice key shared by the subworkspace-mode read and write handlers. */
export function sliceKey(geoTargetId, languageCode) {
  const lang = hasText(languageCode) ? String(languageCode).toLowerCase() : '';
  return `${geoTargetId}:${lang}`;
}

/**
 * Lists a subworkspace's projects ONCE and returns a `"geo:lang" → project`
 * Map, applying the same deterministic oldest-wins rule as resolveProject
 * when a slice has duplicate projects (design §7). Bulk write handlers (create
 * prompts, bulk-delete) use this to resolve every input's owning project from a
 * single upstream listing instead of one resolve per slice. Projects that don't
 * resolve to a (geo, lang) slice are skipped — they are not addressable markets.
 */
export async function buildSliceProjectMap(transport, workspaceId, log) {
  const listing = await transport.listProjects(workspaceId);
  const items = Array.isArray(listing?.items) ? listing.items : [];
  const map = new Map();
  for (const p of items) {
    const geo = geoOf(p);
    const lang = langOf(p);
    if (geo === null || lang === null) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const key = sliceKey(geo, lang);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, p);
    } else {
      // Duplicate slice: oldest wins, deterministically (same rule as the
      // single-slice resolver). Alert so the drift is visible.
      const ordered = [prev, p].sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
      map.set(key, ordered[0]);
      log?.error?.('serenity subworkspace: duplicate projects on one slice — oldest wins', {
        workspaceId,
        geoTargetId: geo,
        languageCode: lang,
        projectIds: [prev?.id, p?.id],
      });
    }
  }
  return map;
}

/**
 * Resolves a slice to its raw project from the live listing, applying the
 * deterministic duplicate-slice rule (design §7): if more than one project
 * matches the slice, the OLDEST (`created_at`) wins and an error-level alert
 * is logged. Returns the raw project (so callers get `id`, `publish_status`,
 * settings) or null when no project matches.
 */
export async function resolveProject(transport, workspaceId, geoTargetId, languageCode, log) {
  const listing = await transport.listProjects(workspaceId);
  const items = Array.isArray(listing?.items) ? listing.items : [];
  const wantLang = hasText(languageCode) ? String(languageCode).toLowerCase() : null;
  const matches = items.filter(
    (p) => geoOf(p) === Number(geoTargetId) && langOf(p) === wantLang,
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    matches.sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
    log?.error?.('serenity subworkspace: duplicate projects on one slice — oldest wins', {
      workspaceId,
      geoTargetId,
      languageCode: wantLang,
      projectIds: matches.map((m) => m?.id),
    });
  }
  return matches[0];
}
