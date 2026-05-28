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
import crypto from 'node:crypto';

import { ErrorWithStatusCode } from '../../utils.js';
import { SerenityTransportError } from '../rest-transport.js';
import { LANGUAGE_TAG_REGEX, normalizeLanguageCode, normalizeGeoTargetId } from '../validation.js';

const LANGUAGE_CACHE_TTL_MS = 60 * 60 * 1000;

// Reusable English region-name formatter (ICU-backed, built into Node). Used
// for the `location_name` we send upstream — matches the form Semrush stores
// on existing projects (`United States`, `Germany`, `Türkiye`).
const ENGLISH_REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Resolves an ISO 3166-1 alpha-2 country code to a Google Ads Geo Target ID
 * (`criterion_id = 2000 + ISO numeric` for countries) plus an English display
 * name suitable for `location_name` on the upstream create-project body.
 * Returns null on unknown / unassigned codes; the controller maps that to 400.
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
 * formula — their `criterion_id`s come from the Google CSV above. When
 * sub-national geo lands in the UX, lazy-load that CSV (or proxy a Semrush
 * location-search endpoint if/when they expose one) and search in-memory.
 * Only this function needs to change — `geoTargetId` is already the slice key.
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
    geoTargetId: 2000 + Number(numeric),
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

const ENGLISH_LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

function isoToEnglishName(languageTag) {
  // Strip region/script subtag — the catalog is keyed by primary language
  // only (no `en-US` / `pt-BR` rows). Caller already enforces
  // LANGUAGE_TAG_REGEX, so `primary` is always a 2–3 letter string here.
  const primary = String(languageTag).toLowerCase().split('-')[0];
  const name = ENGLISH_LANGUAGE_NAMES.of(primary);
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
        'resolveLanguageId: language catalog returned no usable names — upstream field shape may have changed',
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

function validateCreateBody(body) {
  const errors = [];
  if (body?.name !== undefined && body.name !== null && !hasText(body.name)) {
    errors.push('name, when provided, must be a non-empty string');
  }
  if (!hasText(body?.market) || !/^[A-Za-z]{2}$/.test(body.market)) {
    errors.push('market must be an ISO-2 country code');
  }
  if (!hasText(body?.languageCode) || !LANGUAGE_TAG_REGEX.test(body.languageCode)) {
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
function defaultMarketName(brandDisplayName) {
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
  const languageCode = String(body.languageCode).toLowerCase();

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
    log?.error?.(
      'handleCreateMarket: orphaned upstream project after publish failure',
      {
        brandId,
        semrushWorkspaceId,
        semrushProjectId,
        geoTargetId: location.geoTargetId,
        languageCode,
        error: e.message,
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
    if (e instanceof SerenityTransportError && e.status === 404) {
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
 * GET /serenity/tags?geoTargetId=&languageCode= — unique tag names across
 * the slice's prompts. Required filters; one slice → one upstream call set.
 * Short-TTL cache to keep dashboard polling cheap.
 */
export async function handleListTags(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  query,
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
  const projectId = row.getSemrushProjectId();
  const cacheKey = tagCacheKey(semrushWorkspaceId, projectId);
  const now = Date.now();
  const cached = tagCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { items: cached.items };
  }

  const seen = new Map();
  let page = 1;
  const LIMIT = 200;
  while (page <= 50) {
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
    page += 1;
  }

  const sorted = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  // delete-then-set refreshes Map insertion order so evictTagCacheIfNeeded()
  // (LRU-by-insertion-order) treats this entry as freshest.
  tagCache.delete(cacheKey);
  evictTagCacheIfNeeded();
  tagCache.set(cacheKey, { items: sorted, expiresAt: now + TAG_CACHE_TTL_MS });
  return { items: sorted };
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
 * GET /serenity/models?geoTargetId=&languageCode= — AI models configured
 * for the slice's upstream project. Required filters.
 */
export async function handleListModels(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  query,
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
  const projectId = row.getSemrushProjectId();
  const allItems = await fetchAllAiModels(transport, semrushWorkspaceId, projectId);
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
