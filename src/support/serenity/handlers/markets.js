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
import crypto from 'node:crypto';

import { ErrorWithStatusCode } from '../../utils.js';
import { ERROR_CODES, isUpstreamGone } from '../errors.js';
import { SerenityTransportError } from '../rest-transport.js';
import { normalizeLanguageCode, normalizeGeoTargetId } from '../validation.js';
import { resolveLocation } from '../locations.js';

const LANGUAGE_CACHE_TTL_MS = 60 * 60 * 1000;
export const MAX_MODEL_IDS = 50;

// Re-exported so existing importers (handlers/markets-subworkspace.js, tests)
// keep resolving it from here; the implementation now lives in ../locations.js
// so the subworkspace read path can share it without a support→handler import.
export { resolveLocation };

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

const ENGLISH_LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

function isoToEnglishName(languageTag) {
  // Strip region/script subtag — the catalog is keyed by primary language
  // only (no `en-US` / `pt-BR` rows). Caller already enforces
  // LANGUAGE_TAG_REGEX, so `primary` is always a 2–3 letter string here.
  const primary = String(languageTag).toLowerCase().split('-')[0];
  const name = ENGLISH_LANGUAGE_NAMES.of(primary);
  return name && name.toLowerCase() !== primary ? name : null;
}

export async function resolveLanguageId(transport, languageTag, log) {
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
      /* c8 ignore start -- `items[0] || {}` guards against a malformed
         upstream where the first slot is explicitly null; in this branch
         items.length > 0 so items[0] is defined, but the `|| {}` keeps
         Object.keys safe under that adversarial shape. */
      log?.warn?.(
        'resolveLanguageId: language catalog returned no usable names — upstream field shape may have changed',
        { receivedKeys: Object.keys(items[0] || {}) },
      );
      /* c8 ignore stop */
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
 * GET /serenity/markets — list a brand's (geoTargetId, languageCode) slices.
 *
 * Pure DB read: the row's existence IS the contract that the market is
 * active for this brand. We do not enrich with upstream metadata — name
 * and publish_status would require an O(workspace-size) `listWorkspaceProjects`
 * call per request, and the consumer (project-elmo-ui) reads neither.
 *
 * `transport` and `semrushWorkspaceId` are kept on the signature for the
 * controller's parity with the other handlers; they are unused here.
 */
// eslint-disable-next-line no-unused-vars
export async function handleListMarkets(transport, dataAccess, brandId, semrushWorkspaceId) {
  const rows = await dataAccess.BrandSemrushProject.allByBrandId(brandId);
  if (!rows || rows.length === 0) {
    return { items: [] };
  }
  return {
    items: rows.map((row) => ({
      brandId,
      geoTargetId: row.getGeoTargetId(),
      languageCode: row.getLanguageCode(),
      createdAt: row.getCreatedAt(),
      updatedAt: row.getUpdatedAt(),
    })),
  };
}

/**
 * GET /serenity/markets/:geoTargetId/:languageCode — resolve a single slice to
 * its full detail, including the upstream `semrushProjectId`.
 *
 * This is the ONE place on the /serenity/* surface that deliberately exposes
 * the upstream project id. The list endpoint (handleListMarkets) stays
 * provider-free (LLMO-5190); the id surfaces here only because the embedded
 * Semrush AIO renderer MFE needs it to mount the dashboard for the selected
 * market. See docs/specs/2026-05-29-serenity-market-detail-endpoint.md for the
 * decision and the documented deviation from the abstraction spec.
 *
 * Slice-key validation mirrors handleDeleteMarket. A missing row is a hard 404
 * (`marketNotFound`) — unlike the list, "no such slice" is NOT an empty
 * success here, because the caller addressed one specific resource. Pure DB
 * read: no upstream call, so it takes neither `transport` nor
 * `semrushWorkspaceId` (the controller's `authorize()` still enforces the
 * workspace check, keeping parity with handleListMarkets at the boundary).
 */
export async function handleGetMarket(dataAccess, brandId, geoTargetId, languageCode) {
  if (normalizeGeoTargetId(geoTargetId) === null) {
    throw new ErrorWithStatusCode('geoTargetId must be a positive integer', 400);
  }
  if (normalizeLanguageCode(languageCode) === null) {
    throw new ErrorWithStatusCode(
      'languageCode must match ^[a-z]{2,3}(-[a-z]{2,4})?$',
      400,
    );
  }

  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    const err = new ErrorWithStatusCode(
      'No market for this brand and (geoTargetId, languageCode) slice',
      404,
    );
    err.code = ERROR_CODES.MARKET_NOT_FOUND;
    throw err;
  }

  return {
    brandId,
    geoTargetId: row.getGeoTargetId(),
    languageCode: row.getLanguageCode(),
    semrushProjectId: row.getSemrushProjectId(),
    createdAt: row.getCreatedAt(),
    updatedAt: row.getUpdatedAt(),
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
  // Route languageCode through the shared normalizer so POST /markets has the
  // exact same acceptance contract as every other handler that takes the same
  // field. The pre-normalizer regex-then-lowercase form rejected uppercase
  // input here while the rest of the surface silently accepted it — same
  // field, two different rules. (Review Important #2.)
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
 * Default market display name. Format: `<brandDisplayName>-<6-hex>`.
 * The random suffix prevents collisions in shared workspaces and
 * disambiguates re-create-after-delete.
 */
export function defaultMarketName(brandDisplayName) {
  const base = hasText(brandDisplayName) ? String(brandDisplayName) : 'brand';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${base}-${suffix}`;
}

/**
 * POST /serenity/markets — onboard a new (brand, geoTargetId, languageCode)
 * slice for this brand. Strict ordering: upstream create → upstream publish →
 * DB row. A row is written **only** when both upstream calls succeed.
 *
 * Known gap: orphan upstream projects on partial failure.
 *   If `publishProject` fails after `createProject` succeeds (or the DB
 *   `BrandSemrushProject.create` races / errors after publish succeeds),
 *   the upstream project stays in the Semrush workspace with no row
 *   pointing at it. We log the orphan at error level with everything
 *   needed to reconcile (brandId, semrushWorkspaceId, semrushProjectId,
 *   slice), but the handler does NOT call `transport.deleteProject` to
 *   roll back automatically.
 *
 *   Why not auto-clean: an auto-rollback path has its own failure modes
 *   (the rollback DELETE itself can 5xx, leaving a partially-deleted
 *   upstream project; the rollback can race with a retry that already
 *   succeeded; the rollback can hide a transient publish failure that
 *   would have self-healed on retry). Adding those edges is non-trivial
 *   and the trade-off only becomes obviously right once the storage
 *   contract is stable.
 *
 *   Why we're deferring: the underlying mapping table
 *   (`brand_to_semrush_projects`) and its relationship to upstream
 *   projects is not final — the plan note for LLMO-5190 calls out that
 *   the brand-to-upstream mapping may be restructured independently
 *   (multi-upstream provider, sub-national geo dimension). Investing in
 *   a tight transactional create/rollback flow against a layout that's
 *   about to change is likely wasted work. Once the mapping stabilises,
 *   revisit with the right pattern (saga, outbox, or a reconciliation
 *   job that scans for orphans on a schedule).
 *
 *   Operational stopgap: the orphan log line is greppable
 *   ("handleCreateMarket: orphaned upstream project"); any orphan can
 *   be reconciled by an operator running `transport.deleteProject` (or
 *   via a one-off script reading the same log stream).
 */
export async function handleCreateMarket(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
) {
  const errors = validateCreateBody(body);
  if (errors.length > 0) {
    // Join into a single `message` so the response body matches the
    // OpenAPI SerenityErrorResponse schema (which declares `message` as
    // a string, not `messages` as an array). Caller-facing improvement
    // and unblocks the contract test from rejecting this response.
    return {
      status: 400,
      body: { error: 'invalidRequest', message: errors.join('; ') },
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
  // Normalizer already validated this above; re-normalize to grab the
  // canonical lowercase form (the body value may have been "EN" etc.).
  const languageCode = normalizeLanguageCode(body.languageCode);

  const existing = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    location.geoTargetId,
    languageCode,
  );
  if (existing) {
    return {
      status: 409,
      body: {
        error: 'sliceExists',
        message: 'Brand already has a market for this (geoTargetId, languageCode) slice',
      },
    };
  }

  const languageId = await resolveLanguageId(transport, languageCode, log);
  if (!languageId) {
    return {
      status: 400,
      body: {
        error: 'unknownLanguage',
        message: `Language '${languageCode}' not found in upstream catalog`,
      },
    };
  }

  const name = hasText(body?.name) ? String(body.name) : defaultMarketName(body.brandDisplayName);

  const upstreamBody = {
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

  const createResp = await transport.createProject(semrushWorkspaceId, upstreamBody);
  const semrushProjectId = String(createResp?.id || '');
  if (!hasText(semrushProjectId)) {
    return {
      status: 502,
      body: {
        error: 'createNoProjectId',
        message: 'Upstream createProject returned no id',
      },
    };
  }

  try {
    await transport.publishProject(semrushWorkspaceId, semrushProjectId);
  } catch (e) {
    // Best-effort upstream cleanup so the documented retry contract holds.
    // Without this, every retry generates a fresh `defaultMarketName` (random
    // hex suffix) and the upstream `createProject` body has no idempotency
    // key — a retry after a `publishProject` failure would create a SECOND
    // upstream project, not recover the first. The 409 gate only fires when
    // a DB row exists; it never sees orphan upstream projects.
    //
    // Swallow the delete's own errors: the publishProject error is what we
    // need to propagate to the caller, and we don't want a follow-on cleanup
    // failure to mask it. Both outcomes are logged so an operator can still
    // reconcile if cleanup itself fails.
    let cleanedUp = false;
    try {
      await transport.deleteProject(semrushWorkspaceId, semrushProjectId);
      cleanedUp = true;
    } catch (cleanupErr) {
      log?.error?.(
        'handleCreateMarket: best-effort cleanup deleteProject failed; orphan upstream project remains',
        {
          brandId,
          semrushWorkspaceId,
          semrushProjectId,
          geoTargetId: location.geoTargetId,
          languageCode,
          error: cleanupErr.message,
        },
      );
    }
    log?.error?.(
      cleanedUp
        ? 'handleCreateMarket: publish failed; upstream project cleaned up'
        : 'handleCreateMarket: orphaned upstream project after publish failure',
      {
        brandId,
        semrushWorkspaceId,
        semrushProjectId,
        geoTargetId: location.geoTargetId,
        languageCode,
        error: e.message,
        cleanedUp,
      },
    );
    throw e;
  }

  try {
    await dataAccess.BrandSemrushProject.create({
      brandId,
      semrushProjectId,
      geoTargetId: location.geoTargetId,
      languageCode,
    });
  } catch (e) {
    log?.error?.(
      'handleCreateMarket: orphaned upstream project after row-create race',
      {
        brandId,
        semrushWorkspaceId,
        semrushProjectId,
        geoTargetId: location.geoTargetId,
        languageCode,
        error: e.message,
      },
    );
    return {
      status: 409,
      body: {
        error: 'sliceExists',
        message: 'Brand already has a market for this (geoTargetId, languageCode) slice',
      },
    };
  }

  return {
    status: 201,
    body: {
      brandId,
      geoTargetId: location.geoTargetId,
      languageCode,
    },
  };
}

/**
 * DELETE /serenity/markets/:geoTargetId/:languageCode — remove a slice from
 * the brand. Idempotent: missing row → 204. Ordering (spec §3.5):
 *   1. lookup row by slice
 *   2. upstream DELETE the project (404 treated as already-gone success)
 *   3. delete the DB row
 * Upstream non-404 failure → 502, row stays. Half-delete (upstream 204 but
 * DB delete fails) → 500; operator retries (idempotent).
 *
 * Concurrent DELETE on the same slice: low-probability race where two
 * callers both pass the `findBySlice` check and both attempt the upstream
 * delete. The 404-as-success branch absorbs the second call's upstream
 * delete (the first call already removed it); the second `row.remove()`
 * then attempts to delete an electroDB row that's already gone. ElectroDB
 * surfaces this as a `not found` error, which we re-throw as a 500. The
 * client retries idempotently — by then the row is gone and the next
 * lookup returns 204. A pre-lock on the slice (advisory lock, conditional
 * delete) would tighten this further but is out of scope for the LLMO-5190
 * cut-over.
 */
export async function handleDeleteMarket(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  geoTargetId,
  languageCode,
  log,
) {
  if (normalizeGeoTargetId(geoTargetId) === null) {
    throw new ErrorWithStatusCode('geoTargetId must be a positive integer', 400);
  }
  if (normalizeLanguageCode(languageCode) === null) {
    throw new ErrorWithStatusCode(
      'languageCode must match ^[a-z]{2,3}(-[a-z]{2,4})?$',
      400,
    );
  }

  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    // Idempotent: missing slice is treated as success.
    return { status: 204 };
  }

  const semrushProjectId = row.getSemrushProjectId();
  try {
    await transport.deleteProject(semrushWorkspaceId, semrushProjectId);
  } catch (e) {
    if (isUpstreamGone(e)) {
      // Already gone upstream — proceed to DB cleanup.
      log?.info?.('handleDeleteMarket: upstream project already deleted (404 treated as success)', {
        brandId,
        semrushWorkspaceId,
        semrushProjectId,
      });
    } else {
      log?.error?.('handleDeleteMarket: upstream delete failed, leaving DB row intact', {
        brandId,
        semrushWorkspaceId,
        semrushProjectId,
        error: e.message,
      });
      throw e;
    }
  }

  try {
    await row.remove();
  } catch (e) {
    // Half-delete state — upstream gone, DB row still present. Surface as
    // 500 so the operator retries; on retry the upstream DELETE returns 404
    // (idempotent) and the DB row gets removed.
    log?.error?.(
      'handleDeleteMarket: half-delete — upstream project gone but DB row remains',
      {
        brandId,
        semrushWorkspaceId,
        semrushProjectId,
        geoTargetId,
        languageCode,
        error: e.message,
      },
    );
    throw new ErrorWithStatusCode(
      'Market upstream deletion succeeded but DB row removal failed; retry',
      500,
    );
  }

  return { status: 204 };
}

// 60s TTL bounds cross-Lambda-container staleness (multiple warm containers
// each hold an independent Map). Same-container freshness comes from the
// `invalidateTagCacheForProject` call wired into every mutating prompts
// handler (POST /prompts, PATCH, bulk-delete). Together: writes are visible
// immediately on the same container, and at most ~60s late on a peer.
const TAG_CACHE_TTL_MS = 60 * 1000;
const TAG_CACHE_MAX_ENTRIES = 512;
const tagCache = new Map();

function tagCacheKey(semrushWorkspaceId, projectId) {
  return `${semrushWorkspaceId}::${projectId}`;
}

/**
 * Removes the cached tag set for one (workspace, project). Called by any
 * handler that mutates prompts in that project so the next /serenity/tags
 * read sees the new set without waiting for TTL.
 */
export function invalidateTagCacheForProject(semrushWorkspaceId, projectId) {
  tagCache.delete(tagCacheKey(semrushWorkspaceId, projectId));
}

export function clearTagCache() {
  tagCache.clear();
}

/* c8 ignore start -- LRU eviction only fires past TAG_CACHE_MAX_ENTRIES (512
   distinct (workspace, project) tuples held in this container). The guard
   is defensive against tagCache.delete failing silently; exercising it in a
   unit test would require seeding 512 cache entries which is wasted work for
   a branch the runtime hits only under unusual scale. */
function evictTagCacheIfNeeded() {
  while (tagCache.size >= TAG_CACHE_MAX_ENTRIES) {
    const oldest = tagCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    tagCache.delete(oldest);
  }
}
/* c8 ignore stop */

/**
 * Project-keyed tag aggregation core, shared by the flat and subworkspace tag
 * handlers (serenity dual-mode). The ONLY thing that differs between modes is
 * how the slice resolves to a `projectId` (DB row vs live listing); the cache,
 * pagination, truncation guard, and sort are identical, so they live here once.
 * `logCtx` is spread into the truncation warning for diagnosability.
 */
export async function listTagsForProject(transport, semrushWorkspaceId, projectId, logCtx, log) {
  const cacheKey = tagCacheKey(semrushWorkspaceId, projectId);
  const now = Date.now();
  const cached = tagCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { items: cached.items };
  }

  const seen = new Map();
  let page = 1;
  const LIMIT = 200;
  const TAG_PAGE_LIMIT = 50;
  let truncated = false;
  while (page <= TAG_PAGE_LIMIT) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await transport.listPromptsByTags(semrushWorkspaceId, projectId, {
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
    if (page === TAG_PAGE_LIMIT) {
      // We hit the ceiling AND the last page was full — there is at least
      // one more page of prompts we never read, so the tag set is
      // incomplete. Surface this to operators (the response is still 200
      // because returning a partial set is preferable to a hard 500 here,
      // but a missing tag in the UI dropdown is a real symptom and the
      // log line is what makes it diagnosable).
      truncated = true;
      break;
    }
    page += 1;
  }

  if (truncated) {
    log?.warn?.(
      'handleListTags: tag pagination ceiling reached, tag set is truncated',
      {
        ...(logCtx || {}),
        semrushWorkspaceId,
        projectId,
        pagesWalked: TAG_PAGE_LIMIT,
        pageSize: LIMIT,
        approximatePromptsScanned: TAG_PAGE_LIMIT * LIMIT,
        tagsFound: seen.size,
      },
    );
  }

  const sorted = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  // delete-then-set refreshes Map insertion order so evictTagCacheIfNeeded()
  // (LRU-by-insertion-order) treats this entry as freshest.
  tagCache.delete(cacheKey);
  evictTagCacheIfNeeded();
  tagCache.set(cacheKey, { items: sorted, expiresAt: now + TAG_CACHE_TTL_MS });
  return { items: sorted };
}

/**
 * GET /serenity/tags?geoTargetId=&languageCode= — unique tag names across
 * the slice's prompts. Required filters; one slice → one upstream call set.
 * Short-TTL cache to keep dashboard polling cheap.
 *
 * TODO: the tag set is computed by paginating the project's prompts and
 * aggregating distinct tag names in JS. This is an O(N) approximation —
 * for a project with N prompts we do ceil(N/200) upstream calls. Capped
 * at 50 pages (10k prompts); beyond that the tag set is silently
 * truncated and a `warn` log fires (see TAG_PAGE_LIMIT in
 * `listTagsForProject`). When/if Semrush exposes a dedicated tags endpoint
 * (`GET /v1/workspaces/{ws}/projects/{pid}/tags`), this whole loop
 * collapses to one upstream call and the truncation risk goes away.
 */
export async function handleListTags(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  query,
  log,
) {
  const geoTargetId = normalizeGeoTargetId(query?.geoTargetId);
  const languageCode = normalizeLanguageCode(query?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'geoTargetId (integer) and languageCode (BCP-47 primary subtag) are required',
      400,
    );
  }

  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    return { items: [] };
  }
  return listTagsForProject(
    transport,
    semrushWorkspaceId,
    row.getSemrushProjectId(),
    { brandId, geoTargetId, languageCode },
    log,
  );
}

const AI_MODELS_PAGE = 100;
const MAX_AI_MODELS_PAGES = 5;

async function fetchAllAiModels(transport, semrushWorkspaceId, projectId) {
  const all = [];
  let page = 1;
  while (page <= MAX_AI_MODELS_PAGES) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await transport.listAiModels(semrushWorkspaceId, projectId, {
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
 * Maps a raw Semrush assignment row to the shape returned by the models
 * endpoints. Returns null for rows that lack a valid model id/key pair.
 */
function assignmentToItem(it) {
  const m = it?.model;
  if (!m || typeof m !== 'object' || !hasText(m.id) || !hasText(m.key)) {
    return null;
  }
  return {
    id: m.id,
    key: m.key,
    name: m.name ?? null,
    icon: m.icon ?? null,
  };
}

/**
 * Global AI-model catalog (no project). Shared by the flat and subworkspace models
 * handlers — the no-params path is workspace-independent, so both modes return
 * the identical catalog. Swallows only 404/405 (endpoint not available); auth
 * and server errors propagate.
 */
export async function listGlobalModelCatalog(transport) {
  let rawItems = [];
  try {
    let page = 1;
    while (page <= MAX_AI_MODELS_PAGES) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await transport.listGlobalAiModels({
        page,
        limit: AI_MODELS_PAGE,
      });
      const batch = Array.isArray(resp?.items) ? resp.items : [];
      if (batch.length === 0) {
        break;
      }
      rawItems.push(...batch);
      if (batch.length < AI_MODELS_PAGE) {
        break;
      }
      page += 1;
    }
  } catch (e) {
    if (e instanceof SerenityTransportError && (e.status === 404 || e.status === 405)) {
      rawItems = [];
    } else {
      throw e;
    }
  }
  // Workspace items may be plain model objects { id, key, name, icon } or
  // wrapped assignments { model: { id, key, name, icon } }. Normalise both.
  const items = rawItems
    .map((it) => (it?.model && typeof it.model === 'object' ? it.model : it))
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
 * Models configured on one upstream project. Shared by the flat and subworkspace
 * slice-models handlers (the only difference upstream is which projectId the
 * slice resolved to).
 */
export async function listSliceModels(transport, semrushWorkspaceId, projectId) {
  const allItems = await fetchAllAiModels(transport, semrushWorkspaceId, projectId);
  const items = allItems.map(assignmentToItem).filter(Boolean);
  return { items };
}

export async function handleListModels(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  query,
) {
  const geoTargetId = normalizeGeoTargetId(query?.geoTargetId);
  const languageCode = normalizeLanguageCode(query?.languageCode);

  // No-params path: return global model catalog.
  if (geoTargetId === null && languageCode === null) {
    return listGlobalModelCatalog(transport);
  }

  // Partial params: both must be provided together.
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'Provide both geoTargetId and languageCode to query a specific market, or omit both for the workspace catalog',
      400,
    );
  }

  // Slice path: return models for the specific (brand, geo, language) project.
  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    return { items: [] };
  }
  return listSliceModels(transport, semrushWorkspaceId, row.getSemrushProjectId());
}

/**
 * Project-keyed diff-based model sync, shared by the flat and subworkspace model
 * update handlers. Removes models absent from `modelIds`, adds models present
 * but unassigned, leaves already-assigned models untouched. The only thing that
 * differs between modes is how the slice resolved to `projectId`. `logCtx` is
 * spread into the structured logs for diagnosability.
 */
export async function syncModelsForProject(
  transport,
  semrushWorkspaceId,
  projectId,
  modelIds,
  logCtx,
  log,
) {
  const ctx = logCtx || {};
  // Fetch current assignments: catalog-id → assignment-id mapping
  const currentAssignments = await fetchAllAiModels(transport, semrushWorkspaceId, projectId);
  const currentMap = new Map(
    currentAssignments
      .filter((it) => it && hasText(it.id) && hasText(it.model?.id))
      .map((it) => [String(it.model.id), String(it.id)]),
  );

  const desiredSet = new Set(modelIds.map(String));
  const currentSet = new Set(currentMap.keys());

  const toAdd = [...desiredSet].filter((id) => !currentSet.has(id));
  const toRemoveAssignmentIds = [...currentSet]
    .filter((id) => !desiredSet.has(id))
    .map((id) => currentMap.get(id))
    .filter(Boolean);

  // Short-circuit: nothing to do — return the already-fetched list as-is.
  if (toAdd.length === 0 && toRemoveAssignmentIds.length === 0) {
    const items = currentAssignments.map(assignmentToItem).filter(Boolean);
    return { items };
  }

  // Apply removals first (fewer dangling adds if a later add fails)
  if (toRemoveAssignmentIds.length > 0) {
    try {
      await transport.deleteAiModelsByIds(semrushWorkspaceId, projectId, toRemoveAssignmentIds);
    } catch (e) {
      log?.error?.('handleUpdateModels: failed to remove AI models', {
        ...ctx,
        semrushWorkspaceId,
        projectId,
        assignmentIds: toRemoveAssignmentIds,
        error: e.message,
      });
      throw e;
    }
  }

  // Apply additions sequentially — Semrush add endpoint takes one model at a
  // time; parallel calls could race on the same project state.
  const alreadyAdded = [];
  for (const catalogId of toAdd) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await transport.addAiModel(semrushWorkspaceId, projectId, catalogId);
      alreadyAdded.push(catalogId);
    } catch (e) {
      // Log which IDs were already added so operators can assess partial state.
      log?.error?.('handleUpdateModels: failed to add AI model', {
        ...ctx,
        semrushWorkspaceId,
        projectId,
        catalogId,
        alreadyAdded,
        error: e.message,
      });
      throw e;
    }
  }

  // Publish so the model-set change goes live. Model assignments are staged on
  // the draft layer (like prompts); without a publish the new set never reaches
  // the live project. This is the one deliberate exception to the "flat
  // handlers frozen" rule — the flat-mode PUT /models never published, a latent
  // bug — and living in the shared core it fixes flat AND subworkspace in one place.
  // Only reached when something actually changed (the no-op path returned above).
  await transport.publishProject(semrushWorkspaceId, projectId);

  // Return the refreshed model list
  const updated = await fetchAllAiModels(transport, semrushWorkspaceId, projectId);
  const items = updated.map(assignmentToItem).filter(Boolean);
  log?.info?.('handleUpdateModels: sync complete', {
    ...ctx,
    projectId,
    added: toAdd.length,
    removed: toRemoveAssignmentIds.length,
  });
  return { items };
}

/**
 * PUT /serenity/models — replaces the AI-model set for a (geoTargetId,
 * languageCode) slice with the caller-supplied list. Implements a diff-based
 * sync: models absent from `modelIds` are removed; models present in
 * `modelIds` but not yet assigned are added. Already-assigned models are
 * left untouched (no unnecessary re-create round-trips).
 *
 * `modelIds` contains catalog model IDs — the `id` field from
 * `AIModelResponse` (i.e. `ProjectAIModelResponse.model.id`), NOT the
 * assignment row's `id`. The caller gets these from a prior `GET /serenity/models`
 * call on the same or any other slice. Duplicate IDs in `modelIds` are
 * silently deduplicated before diffing.
 *
 * Assignment IDs (outer `id` on `ProjectAIModelResponse`) are resolved
 * internally for the DELETE batch and are never exposed to callers.
 *
 * Returns the final model list in the same shape as `handleListModels`.
 */
export async function handleUpdateModels(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
) {
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
    throw new ErrorWithStatusCode(
      'modelIds must be an array of non-empty strings',
      400,
    );
  }
  if (modelIds.length > MAX_MODEL_IDS) {
    throw new ErrorWithStatusCode(
      `modelIds must not exceed ${MAX_MODEL_IDS} entries`,
      400,
    );
  }

  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    throw new ErrorWithStatusCode('Market not found for this brand', 404);
  }
  return syncModelsForProject(
    transport,
    semrushWorkspaceId,
    row.getSemrushProjectId(),
    modelIds,
    { brandId, geoTargetId, languageCode },
    log,
  );
}
