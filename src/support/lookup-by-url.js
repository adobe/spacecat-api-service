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

import { hasText, isNonEmptyObject, canonicalizeUrl } from '@adobe/spacecat-shared-utils';
import { lookupEntityIdsByUrl } from '@adobe/spacecat-shared-data-access';
import { applyFieldProjection } from '../utils/field-projection.js';

/**
 * Shared engine for the `POST .../by-url` lookup endpoints (opportunities + suggestions).
 * See `lookup-service-api-design.md` (Milestone 1). Both endpoints:
 *   1. take a body `{ urls: [...] }` (1-100; invalid entries dropped, not hard-failed),
 *   2. resolve matching entity ids from the site-scoped source-URL index
 *      (`opportunity_urls` / `suggestion_urls`) via `lookupEntityIdsByUrl`,
 *   3. hydrate + status-filter + keyset-paginate the DISTINCT matched entities in memory
 *      (the index util returns the full match set; the set per URL is bounded by the URL cap),
 *   4. return a normalized response: `results[]` referencing ids + a top-level entity map.
 *
 * Matching is over the canonical URL (writer and reader both use `canonicalizeUrl`), so callers
 * pass raw URLs and the echoed `url` is always their original, unmodified input string.
 */

export const MAX_LOOKUP_URLS = 100;
export const DEFAULT_LOOKUP_PAGE_SIZE = 100;
export const MAX_LOOKUP_PAGE_SIZE = 100;

/**
 * Validates the request-body `urls`. Non-array / oversized are hard errors; individual
 * non-string/empty entries are dropped (drop-don't-fail), and an all-dropped/empty list is
 * allowed (the caller gets an empty response, not a 400).
 * @param {*} rawUrls
 * @returns {{ urls: string[] } | { error: string }}
 */
export function parseLookupUrls(rawUrls) {
  if (!Array.isArray(rawUrls)) {
    return { error: 'urls must be an array' };
  }
  if (rawUrls.length > MAX_LOOKUP_URLS) {
    return { error: `urls must contain at most ${MAX_LOOKUP_URLS} entries` };
  }
  const urls = rawUrls.filter((u) => typeof u === 'string' && u.trim().length > 0);
  return { urls };
}

/**
 * Validates the optional `status` query param against the entity's status enum.
 * @param {string|undefined} statusParam - comma-separated status value(s)
 * @param {string[]} validStatuses - allowed status values
 * @returns {{ statuses: string[] } | { error: string }}
 */
export function parseLookupStatus(statusParam, validStatuses) {
  if (!hasText(statusParam)) {
    return { statuses: [] };
  }
  const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = statuses.filter((s) => !validStatuses.includes(s));
  if (invalid.length > 0) {
    return { error: `Invalid status value(s): ${invalid.join(', ')}. Valid: ${validStatuses.join(', ')}` };
  }
  return { statuses };
}

function decodeCursor(cursor) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!isNonEmptyObject(decoded) || typeof decoded.k !== 'string') {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function encodeCursor(sortKey) {
  return Buffer.from(JSON.stringify({ k: sortKey }), 'utf8').toString('base64url');
}

/**
 * Validates `limit` / `cursor` query params.
 * @param {object} params
 * @returns {{ limit: number, cursorKey: object|null } | { error: string }}
 */
export function parseLookupPagination(params = {}) {
  let limit = DEFAULT_LOOKUP_PAGE_SIZE;
  const rawLimit = params.limit;
  if (rawLimit !== undefined && rawLimit !== null && `${rawLimit}` !== '') {
    limit = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOOKUP_PAGE_SIZE) {
      return { error: `limit must be an integer between 1 and ${MAX_LOOKUP_PAGE_SIZE}` };
    }
  }
  let cursorKey = null;
  if (hasText(params.cursor)) {
    cursorKey = decodeCursor(params.cursor);
    if (cursorKey === null) {
      return { error: 'Invalid cursor' };
    }
  }
  return { limit, cursorKey };
}

/**
 * Projects the page's full DTOs down to the requested `fields`, or to the endpoint's
 * lightweight default when `fields` is omitted. `forceFields` are always retained (e.g.
 * suggestions force-include `opportunityId` on top of the base `id`).
 * @returns {{ list: object[] } | { error: string }}
 */
function projectLookup(fullDtos, fieldsParam, lightweightFields, forceFields) {
  if (hasText(fieldsParam)) {
    const { list, error } = applyFieldProjection(fullDtos, fieldsParam);
    if (error) {
      return { error };
    }
    const withForced = list.map((item, i) => {
      const src = fullDtos[i];
      const out = { ...item };
      for (const f of forceFields) {
        if (!Object.hasOwn(out, f) && src && Object.hasOwn(src, f)) {
          out[f] = src[f];
        }
      }
      return out;
    });
    return { list: withForced };
  }
  const keys = [...new Set([...lightweightFields, ...forceFields])];
  const list = fullDtos.map((src) => {
    const out = {};
    for (const k of keys) {
      if (src && Object.hasOwn(src, k)) {
        out[k] = src[k];
      }
    }
    return out;
  });
  return { list };
}

/**
 * Runs a by-URL lookup and builds the normalized response (or a validation error the caller
 * should surface as `badRequest`). Site existence + access control are the caller's concern —
 * this runs after those pass.
 *
 * @param {object} postgrestClient - `dataAccess.services.postgrestClient`
 * @param {object} cfg
 * @param {string} cfg.table - `opportunity_urls` | `suggestion_urls`
 * @param {string} cfg.siteId
 * @param {*} cfg.rawUrls - request body `urls`
 * @param {object} cfg.params - query params (`fields`, `status`, `limit`, `cursor`)
 * @param {string[]} cfg.validStatuses - the entity status enum
 * @param {string[]} cfg.defaultExcludedStatuses - statuses hidden when `status` is omitted
 * @param {(ids: string[]) => Promise<object[]>} cfg.fetchEntities - batch hydrate by id
 * @param {(entities: object[]) => object[]|Promise<object[]>} [cfg.filterEntities] - optional
 *   authorization / product-gating narrowing of the hydrated set, before status-filter
 * @param {(e: object) => string} cfg.getId
 * @param {(e: object) => string} cfg.getStatus
 * @param {(e: object) => string} cfg.getSortKey - immutable keyset sort key
 * @param {(e: object) => object} cfg.toFullDto - full DTO JSON for an entity
 * @param {string[]} cfg.lightweightFields - default projection when `fields` omitted
 * @param {string[]} cfg.forceFields - always-retained fields
 * @param {string} cfg.idListKey - `opportunityIds` | `suggestionIds`
 * @param {string} cfg.mapKey - `opportunities` | `suggestions`
 * @param {boolean} cfg.includeNoMatchInResults - opportunities keep no-match URLs in `results`
 * @param {boolean} cfg.includeUnmatchedUrls - suggestions add a first-page `unmatchedUrls`
 * @returns {Promise<{ response: object } | { error: string }>}
 */
export async function lookupByUrl(postgrestClient, cfg) {
  const {
    table, siteId, rawUrls, params = {},
    validStatuses, defaultExcludedStatuses,
    fetchEntities, filterEntities, getId, getStatus, getSortKey, toFullDto,
    lightweightFields, forceFields,
    idListKey, mapKey, includeNoMatchInResults, includeUnmatchedUrls,
  } = cfg;

  const urlsResult = parseLookupUrls(rawUrls);
  if (urlsResult.error) {
    return { error: urlsResult.error };
  }
  const statusResult = parseLookupStatus(params.status, validStatuses);
  if (statusResult.error) {
    return { error: statusResult.error };
  }
  const pageResult = parseLookupPagination(params);
  if (pageResult.error) {
    return { error: pageResult.error };
  }

  const { urls } = urlsResult;
  const { statuses } = statusResult;
  const { limit, cursorKey } = pageResult;
  const isFirstPage = !cursorKey;

  const buildResponse = (results, entityMap, nextCursor, hasMore, unmatchedUrls) => {
    const response = {
      results,
      [mapKey]: entityMap,
      pagination: { limit, cursor: nextCursor, hasMore },
    };
    if (includeUnmatchedUrls && isFirstPage) {
      response.unmatchedUrls = unmatchedUrls;
    }
    return response;
  };

  if (urls.length === 0) {
    return { response: buildResponse([], {}, null, false, []) };
  }

  const rows = await lookupEntityIdsByUrl(postgrestClient, { table, siteId, urls });

  // canonical URL -> ordered distinct matched ids; plus the distinct id set (first-seen order).
  const idsByCanonical = new Map();
  const allIds = [];
  const seenIds = new Set();
  for (const row of rows) {
    if (!seenIds.has(row.entity_id)) {
      seenIds.add(row.entity_id);
      allIds.push(row.entity_id);
    }
    let arr = idsByCanonical.get(row.url);
    if (!arr) {
      arr = [];
      idsByCanonical.set(row.url, arr);
    }
    if (!arr.includes(row.entity_id)) {
      arr.push(row.entity_id);
    }
  }

  const hydrated = allIds.length > 0 ? await fetchEntities(allIds) : [];
  // Authorization / product-gating narrowing (e.g. D4 FACS composite type-scoping,
  // Summit-PLG). Applied to the full hydrated set BEFORE status filtering and
  // pagination, so an entity the caller may not see is absent from the entity map,
  // the per-URL id lists, and the page — and (for suggestions) counted as unmatched,
  // i.e. indistinguishable from "no match".
  const entities = filterEntities ? await filterEntities(hydrated) : hydrated;

  // status filter (default excludes the dismissed statuses)
  const survivingById = new Map();
  for (const entity of entities) {
    const status = getStatus(entity);
    if (statuses.length > 0) {
      if (!statuses.includes(status)) {
        // eslint-disable-next-line no-continue
        continue;
      }
    } else if (defaultExcludedStatuses.includes(status)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    survivingById.set(getId(entity), entity);
  }

  // keyset page over the immutable sort key (keys are distinct entity ids, so a 2-way
  // comparator is total — no equal case to handle).
  const sorted = [...survivingById.values()]
    .sort((a, b) => (getSortKey(a) < getSortKey(b) ? -1 : 1));
  const afterCursor = cursorKey
    ? sorted.filter((e) => getSortKey(e) > cursorKey.k)
    : sorted;
  const pageEntities = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > limit;
  const nextCursor = hasMore
    ? encodeCursor(getSortKey(pageEntities[pageEntities.length - 1]))
    : null;
  const pageIds = new Set(pageEntities.map((e) => getId(e)));

  // project the page and build the id -> DTO map
  const fullDtos = pageEntities.map((e) => toFullDto(e));
  const projection = projectLookup(fullDtos, params.fields, lightweightFields, forceFields);
  if (projection.error) {
    return { error: projection.error };
  }
  const entityMap = {};
  pageEntities.forEach((e, i) => {
    entityMap[getId(e)] = projection.list[i];
  });

  // results (input order) + first-page unmatchedUrls (zero surviving matches across whole set)
  const results = [];
  const unmatchedUrls = [];
  const unmatchedSeen = new Set();
  for (const url of urls) {
    const canonical = canonicalizeUrl(url);
    const matched = idsByCanonical.get(canonical) || [];
    const pageMatched = matched.filter((id) => pageIds.has(id));
    if (includeNoMatchInResults || pageMatched.length > 0) {
      results.push({ url, [idListKey]: pageMatched });
    }
    if (includeUnmatchedUrls && isFirstPage && !unmatchedSeen.has(url)) {
      const survivingMatched = matched.some((id) => survivingById.has(id));
      if (!survivingMatched) {
        unmatchedSeen.add(url);
        unmatchedUrls.push(url);
      }
    }
  }

  return { response: buildResponse(results, entityMap, nextCursor, hasMore, unmatchedUrls) };
}
