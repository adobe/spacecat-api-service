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
import {
  resolveLocation,
  resolveLanguageId,
  defaultMarketName,
  listTagsForProject,
  listGlobalModelCatalog,
  listSliceModels,
  syncModelsForProject,
  MAX_MODEL_IDS,
} from './markets.js';
import {
  listMarkets, resolveProject, mapPublishStatus, projectToSlice,
} from '../subworkspace-projects.js';
import { ensureSubworkspace } from '../workspace-lifecycle.js';

/**
 * Subworkspace-mode market handlers (serenity design §3/§5). The brand has its own
 * Semrush subworkspace; markets are enumerated live (no BrandSemrushProject
 * mapping). The controller dispatches here when resolveBrandWorkspace returns
 * mode === 'subworkspace'; the flat-mode handlers stay frozen and untouched.
 */

// "live" publish states — a slice that already has a published project (a real
// existing market), vs a leftover draft that a retry should adopt and resume.
const LIVE_STATES = new Set(['live', 'live_with_unpublished_updates']);

function validateSlice(geoTargetId, languageCode) {
  if (normalizeGeoTargetId(geoTargetId) === null) {
    throw new ErrorWithStatusCode('geoTargetId must be a positive integer', 400);
  }
  if (normalizeLanguageCode(languageCode) === null) {
    throw new ErrorWithStatusCode('languageCode must match ^[a-z]{2,3}(-[a-z]{2,4})?$', 400);
  }
}

/** GET /serenity/markets (subworkspace) — one live listing of the subworkspace. */
export async function handleListMarketsSubworkspace(transport, brandId, workspaceId) {
  return { items: await listMarkets(transport, workspaceId, brandId) };
}

/**
 * GET /serenity/markets/:geo/:lang (subworkspace) — resolve the slice from the live
 * listing; surface semrushProjectId + status + `initialized` (one extra
 * init_status read, detail only). 404 marketNotFound if no project matches.
 */
export async function handleGetMarketSubworkspace(
  transport,
  brandId,
  workspaceId,
  geoTargetId,
  languageCode,
  log,
) {
  validateSlice(geoTargetId, languageCode);
  const lang = normalizeLanguageCode(languageCode);
  const project = await resolveProject(transport, workspaceId, Number(geoTargetId), lang, log);
  if (!project) {
    const err = new ErrorWithStatusCode('No market for this brand and (geoTargetId, languageCode) slice', 404);
    err.code = ERROR_CODES.MARKET_NOT_FOUND;
    throw err;
  }
  let initialized = null;
  try {
    const status = await transport.getInitStatus(workspaceId, project.id);
    initialized = status?.initialized ?? null;
  } catch (e) {
    // AIO readiness is best-effort enrichment; never fail the detail read on it.
    log?.info?.('handleGetMarketSubworkspace: init_status read failed (non-fatal)', {
      brandId, workspaceId, projectId: project.id, error: e.message,
    });
  }
  const slice = projectToSlice(project, brandId);
  return { ...slice, initialized };
}

function buildCreateProjectBody(body, location, languageId) {
  const name = hasText(body?.name) ? String(body.name) : defaultMarketName(body.brandDisplayName);
  return {
    name,
    type: 'ai',
    brand_name_display: body.brandNames[0],
    brand_names: body.brandNames,
    domain: body.brandDomain,
    country_code: body.market.toLowerCase(),
    location_id: location.geoTargetId,
    location_name: location.locationName,
    language_id: languageId,
  };
}

function validateCreateBody(body) {
  const errors = [];
  if (body?.name !== undefined && body.name !== null && !hasText(body.name)) {
    errors.push('name, when provided, must be a non-empty string');
  }
  if (!hasText(body?.market) || !/^[A-Za-z]{2}$/.test(body.market)) {
    errors.push('market must be an ISO-2 country code');
  }
  if (normalizeLanguageCode(body?.languageCode) === null) {
    errors.push('languageCode must match ^[a-z]{2,3}(-[a-z]{2,4})?$');
  }
  if (!hasText(body?.brandDomain)) {
    errors.push('brandDomain is required');
  }
  if (!Array.isArray(body?.brandNames) || body.brandNames.length === 0
      || !body.brandNames.every(hasText)) {
    errors.push('brandNames must be a non-empty array of strings');
  }
  return errors;
}

/**
 * POST /serenity/markets (subworkspace, design flow 3) — ensure the subworkspace
 * (lazy-create / re-grant), then create-or-adopt the slice's draft, publish
 * once, and confirm. No mapping write, no rollback: a leftover draft is a
 * resumable state, not an orphan (design §7). The duplicate-create race is
 * accepted (oldest-wins reads + alert).
 *
 * @param {string|null} [preResolvedWorkspaceId] - when set (the activate batch
 *   path), the sub-workspace is already ensured/sized; skip the per-call ensure
 *   and create directly against it. Omitted on the single-market POST path.
 */
export async function handleCreateMarketSubworkspace(
  transport,
  brand,
  parentWorkspaceId,
  body,
  log,
  preResolvedWorkspaceId = null,
) {
  const errors = validateCreateBody(body);
  if (errors.length > 0) {
    return { status: 400, body: { error: 'invalidRequest', message: errors.join('; ') } };
  }
  const location = resolveLocation(body.market);
  if (!location) {
    return { status: 400, body: { error: 'unknownMarket', message: `Unknown market '${body.market}'` } };
  }
  const languageCode = normalizeLanguageCode(body.languageCode);

  // activate() ensures the sub-workspace once for the whole batch (sized to the
  // real market count) and passes it in here. The single-market POST /markets
  // path passes nothing, so we ensure on the spot, sized for one market.
  const workspaceId = hasText(preResolvedWorkspaceId)
    ? preResolvedWorkspaceId
    : await ensureSubworkspace(transport, brand, parentWorkspaceId, 1, log);

  const existing = await resolveProject(
    transport,
    workspaceId,
    location.geoTargetId,
    languageCode,
    log,
  );
  let projectId;
  if (existing) {
    if (LIVE_STATES.has(mapPublishStatus(existing.publish_status))) {
      return {
        status: 409,
        body: { error: 'sliceExists', message: 'Brand already has a live market for this slice' },
      };
    }
    // Leftover draft → adopt and resume (publish-once below).
    projectId = existing.id;
  } else {
    const languageId = await resolveLanguageId(transport, languageCode, log);
    if (!languageId) {
      return { status: 400, body: { error: 'unknownLanguage', message: `Language '${languageCode}' not found` } };
    }
    const createResp = await transport.createProject(
      workspaceId,
      buildCreateProjectBody(body, location, languageId),
    );
    projectId = String(createResp?.id || '');
    if (!hasText(projectId)) {
      return { status: 502, body: { error: 'createNoProjectId', message: 'Upstream createProject returned no id' } };
    }
  }

  await transport.publishProject(workspaceId, projectId);

  return {
    status: 201,
    body: { brandId: brand.getId(), geoTargetId: location.geoTargetId, languageCode },
  };
}

/**
 * DELETE /serenity/markets/:geo/:lang (subworkspace, design flow 4) — resolve from the
 * listing, delete the project (404-as-success). NO floor check: removing the
 * last market is allowed; the empty subworkspace is kept.
 */
export async function handleDeleteMarketSubworkspace(
  transport,
  workspaceId,
  geoTargetId,
  languageCode,
  log,
) {
  validateSlice(geoTargetId, languageCode);
  const lang = normalizeLanguageCode(languageCode);
  const project = await resolveProject(transport, workspaceId, Number(geoTargetId), lang, log);
  if (!project) {
    return { status: 204 };
  }
  try {
    await transport.deleteProject(workspaceId, project.id);
  } catch (e) {
    if (!isUpstreamGone(e)) {
      throw e;
    }
  }
  return { status: 204 };
}

/**
 * GET /serenity/tags (subworkspace) — unique tag names across the slice's prompts.
 * Resolves the slice's project from the live listing, then reuses the shared
 * project-keyed tag aggregation (cache + pagination + truncation guard). A
 * missing slice returns an empty set, matching the flat-mode tags contract.
 */
export async function handleListTagsSubworkspace(transport, workspaceId, query, log) {
  const geoTargetId = normalizeGeoTargetId(query?.geoTargetId);
  const languageCode = normalizeLanguageCode(query?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'geoTargetId (integer) and languageCode (BCP-47 primary subtag) are required',
      400,
    );
  }
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    return { items: [] };
  }
  return listTagsForProject(
    transport,
    workspaceId,
    String(project.id),
    { geoTargetId, languageCode },
    log,
  );
}

/**
 * GET /serenity/models (subworkspace). No params → the (workspace-independent) global
 * catalog. With (geoTargetId, languageCode) → models on the slice's project,
 * resolved from the live listing. Partial params → 400. A missing slice returns
 * an empty set, matching the flat-mode models contract.
 */
export async function handleListModelsSubworkspace(transport, workspaceId, query, log) {
  const geoTargetId = normalizeGeoTargetId(query?.geoTargetId);
  const languageCode = normalizeLanguageCode(query?.languageCode);

  if (geoTargetId === null && languageCode === null) {
    return listGlobalModelCatalog(transport);
  }
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'Provide both geoTargetId and languageCode to query a specific market, or omit both for the workspace catalog',
      400,
    );
  }
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    return { items: [] };
  }
  return listSliceModels(transport, workspaceId, String(project.id));
}

/**
 * PUT /serenity/models (subworkspace) — replace the AI-model set for a slice. Resolves
 * the slice's project from the live listing (404 if absent), then reuses the
 * shared diff-based sync. Validation mirrors the flat-mode handler exactly.
 */
export async function handleUpdateModelsSubworkspace(transport, workspaceId, body, log) {
  const geoTargetId = normalizeGeoTargetId(Number(body?.geoTargetId));
  const languageCode = normalizeLanguageCode(body?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'geoTargetId (integer) and languageCode (BCP-47 primary subtag) are required',
      400,
    );
  }
  const modelIds = body?.modelIds;
  if (!Array.isArray(modelIds) || !modelIds.every((id) => hasText(id))) {
    throw new ErrorWithStatusCode('modelIds must be an array of non-empty strings', 400);
  }
  if (modelIds.length > MAX_MODEL_IDS) {
    throw new ErrorWithStatusCode(`modelIds must not exceed ${MAX_MODEL_IDS} entries`, 400);
  }

  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    throw new ErrorWithStatusCode('Market not found for this brand', 404);
  }
  return syncModelsForProject(
    transport,
    workspaceId,
    String(project.id),
    modelIds,
    { geoTargetId, languageCode },
    log,
  );
}
