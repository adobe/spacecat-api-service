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

/**
 * Shared helpers for the child path (serenity dual-mode). In child mode there
 * is no BrandSemrushProject mapping: a brand's markets are enumerated live
 * from its child workspace (v1 default view) and a slice resolves to a project
 * by matching the project's echoed settings. Both the read handlers and the
 * write/prompt/model handlers route their slice→project resolution through
 * here so the listing/mapping rules live in exactly one place.
 *
 * Read rules (workspace doc §2/§6, live-verified): the v1 default view echoes
 * `settings.ai.location` (numeric geo target id) and `settings.ai.language`
 * (BCP-47 code) faithfully for drafts; counts/sub-resources read the live
 * layer. We never trust the v2 list for draft settings.
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

function geoOf(project) {
  const raw = project?.settings?.ai?.location;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function langOf(project) {
  const lang = project?.settings?.ai?.language;
  return hasText(lang) ? String(lang).toLowerCase() : null;
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
    createdAt: project?.created_at ?? null,
    updatedAt: project?.updated_at ?? null,
    status: mapPublishStatus(project?.publish_status),
    semrushProjectId: hasText(project?.id) ? String(project.id) : null,
  };
}

/**
 * Lists a child workspace's projects (one v1 GET) and maps each to a slice.
 * Projects whose slice cannot be resolved (no geo/lang) are dropped — they are
 * not addressable markets.
 */
export async function listChildMarkets(transport, workspaceId, brandId) {
  const listing = await transport.listProjects(workspaceId);
  const items = Array.isArray(listing?.items) ? listing.items : [];
  return items
    .map((p) => projectToSlice(p, brandId))
    .filter((m) => m.geoTargetId !== null && m.languageCode !== null);
}

/**
 * Resolves a slice to its raw project from the live listing, applying the
 * deterministic duplicate-slice rule (design §7): if more than one project
 * matches the slice, the OLDEST (`created_at`) wins and an error-level alert
 * is logged. Returns the raw project (so callers get `id`, `publish_status`,
 * settings) or null when no project matches.
 */
export async function resolveChildProject(transport, workspaceId, geoTargetId, languageCode, log) {
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
    matches.sort((a, b) => String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? '')));
    log?.error?.('serenity child: duplicate projects on one slice — oldest wins', {
      workspaceId,
      geoTargetId,
      languageCode: wantLang,
      projectIds: matches.map((m) => m?.id),
    });
  }
  return matches[0];
}
