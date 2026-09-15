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
 * Shared engine for the `POST .../by-urls` lookup endpoints (opportunities + suggestions).
 * See the Lookup Service architecture doc ("Offsite Intelligence - Funneling"), section 4.2,
 * in the gambit-ai-toolkit knowledge base - not a file in this repo. Both endpoints:
 *   1. take a body `{ urls: [...] }` (1-100; invalid entries dropped, not hard-failed) plus
 *      `fields`/`status`/`limit`/`cursor`, all in the same JSON body - this middleware stack
 *      (`helix-shared-body-data`) only ever exposes `request.json()` as `context.data` for a
 *      JSON POST, so a query-param path for these is not reachable, not just undocumented,
 *   2. resolve matching entity ids from the site-scoped source-URL index
 *      (`opportunity_urls` / `suggestion_urls`) via `lookupEntityIdsByUrl`,
 *   3. hydrate + authorize + status-filter + keyset-paginate the DISTINCT matched entities in
 *      memory, bounded by `MAX_LOOKUP_MATCHES` (the URL cap alone does not bound the match set,
 *      since one URL can legitimately back many entities),
 *   4. return a normalized response: `results[]` referencing ids + a top-level entity map.
 *
 * Matching is over the canonical URL (writer and reader both use `canonicalizeUrl`), so callers
 * pass raw URLs and the echoed `url` is always their original, unmodified input string.
 */

export const MAX_LOOKUP_URLS = 100;
export const MAX_URL_LENGTH = 2048;
export const MAX_LOOKUP_MATCHES = 1000;
export const DEFAULT_LOOKUP_PAGE_SIZE = 100;
export const MAX_LOOKUP_PAGE_SIZE = 100;

// A raw double-quote, backslash, or control character is never valid in a URL, and (unlike a
// comma or parenthesis, both legitimate in a path/query) would let a crafted entry break out of
// the PostgREST `.in()` filter's value quoting. Drop it like any other malformed entry
// (drop-don't-fail), rather than rejecting the whole request.
// eslint-disable-next-line no-control-regex -- control-character range is intentional here
const INVALID_URL_CHARS = /["\\\u0000-\u001f]/;

/**
 * Validates the request-body `urls`. Non-array / oversized are hard errors; individual
 * non-string/empty/oversized/unsafe entries are dropped (drop-don't-fail), and an
 * all-dropped/empty list is allowed (the caller gets an empty response, not a 400).
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
  const urls = rawUrls.filter((u) => typeof u === 'string'
    && u.trim().length > 0
    && u.length <= MAX_URL_LENGTH
    && !INVALID_URL_CHARS.test(u));
  return { urls };
}

/**
 * Validates the optional `status` body field against the entity's status enum.
 * @param {string|undefined} statusParam - comma-separated status value(s)
 * @param {string[]} validStatuses - allowed status values
 * @returns {{ statuses: string[] } | { error: string }}
 */
export function parseLookupStatus(statusParam, validStatuses) {
  if (statusParam === undefined || statusParam === null || statusParam === '') {
    return { statuses: [] };
  }
  if (typeof statusParam !== 'string') {
    return { error: 'status must be a string' };
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
    if (!isNonEmptyObject(decoded) || typeof decoded.k !== 'string' || typeof decoded.id !== 'string') {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function encodeCursor(sortKey, id) {
  return Buffer.from(JSON.stringify({ k: sortKey, id }), 'utf8').toString('base64url');
}

/**
 * Validates `limit` / `cursor` body fields.
 * @param {object} params
 * @returns {{ limit: number, cursorKey: object|null } | { error: string }}
 */
export function parseLookupPagination(params = {}) {
  let limit = DEFAULT_LOOKUP_PAGE_SIZE;
  const rawLimit = params.limit;
  if (rawLimit !== undefined && rawLimit !== null && `${rawLimit}` !== '') {
    const isCleanInteger = typeof rawLimit === 'number'
      ? Number.isInteger(rawLimit)
      : /^\d+$/.test(String(rawLimit).trim());
    limit = Number.parseInt(rawLimit, 10);
    if (!isCleanInteger || limit < 1 || limit > MAX_LOOKUP_PAGE_SIZE) {
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
  if (fieldsParam !== undefined && fieldsParam !== null && typeof fieldsParam !== 'string') {
    return { error: 'fields must be a string' };
  }
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
 * Total-order comparator over the caller's (not-necessarily-unique) sort key, breaking ties on
 * the always-unique entity id so entities with an equal `getSortKey` value are never dropped by
 * the cursor filter below (a plain `<`/`>` comparator with no equal case silently treats a tie
 * as "already past the cursor").
 */
function compareEntities(a, b, getSortKey, getId) {
  const ka = getSortKey(a);
  const kb = getSortKey(b);
  if (ka !== kb) {
    return ka < kb ? -1 : 1;
  }
  // Tie-break on id. The caller's `survivingById` is a Map keyed by id, so two entities with
  // the same id can never both reach this comparator - the `ida === idb` case is unreachable.
  return getId(a) < getId(b) ? -1 : 1;
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
 * @param {object} cfg.params - body fields (`fields`, `status`, `limit`, `cursor`)
 * @param {object} [cfg.log] - optional logger; when omitted, the engine logs nothing
 * @param {string[]} cfg.validStatuses - the entity status enum
 * @param {string[]} cfg.defaultExcludedStatuses - statuses hidden when `status` is omitted
 * @param {(ids: string[]) => Promise<object[]>} cfg.fetchEntities - batch hydrate by id
 * @param {(entities: object[]) => object[]|Promise<object[]>} [cfg.filterEntities] - optional
 *   authorization / product-gating narrowing of the hydrated set, before status-filter. Never
 *   invoked when nothing was hydrated, so a hook with its own fixed per-call cost (e.g. an
 *   `allBySiteId` fetch) is not paid on a request that matched nothing.
 * @param {(e: object) => string} cfg.getId
 * @param {(e: object) => string} cfg.getStatus
 * @param {(e: object) => string} cfg.getSortKey - keyset sort key; need not be unique - the
 *   engine breaks ties on `getId` internally, so uniqueness is structural, not a caller contract
 * @param {(e: object) => object} cfg.toFullDto - full DTO JSON for an entity
 * @param {string[]} cfg.lightweightFields - default projection when `fields` omitted
 * @param {string[]} cfg.forceFields - always-retained fields
 * @param {string} cfg.idListKey - `opportunityIds` | `suggestionIds`
 * @param {string} cfg.mapKey - `opportunities` | `suggestions`
 * @param {boolean} cfg.includeNoMatchInResults - opportunities keep no-match URLs in `results`
 * @returns {Promise<{ response: object } | { error: string }>}
 */
export async function lookupByUrl(postgrestClient, cfg) {
  const {
    table, siteId, rawUrls, params = {}, log,
    validStatuses, defaultExcludedStatuses,
    fetchEntities, filterEntities, getId, getStatus, getSortKey, toFullDto,
    lightweightFields, forceFields,
    idListKey, mapKey, includeNoMatchInResults,
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
    if (isFirstPage) {
      response.unmatchedUrls = unmatchedUrls;
    }
    return response;
  };

  if (urls.length === 0) {
    return { response: buildResponse([], {}, null, false, []) };
  }

  const rows = await lookupEntityIdsByUrl(postgrestClient, { table, siteId, urls });
  if (!Array.isArray(rows)) {
    log?.error?.(`[lookup-by-url] lookupEntityIdsByUrl returned a non-array result for table=${table} siteId=${siteId}`);
    return { error: 'Failed to resolve the URL index' };
  }

  // canonical URL -> Set of matched entity ids; plus the distinct id set (first-seen order).
  const idsByCanonical = new Map();
  const allIds = [];
  const seenIds = new Set();
  for (const row of rows) {
    if (!seenIds.has(row.entity_id)) {
      seenIds.add(row.entity_id);
      allIds.push(row.entity_id);
    }
    let set = idsByCanonical.get(row.url);
    if (!set) {
      set = new Set();
      idsByCanonical.set(row.url, set);
    }
    set.add(row.entity_id);
  }

  if (allIds.length > MAX_LOOKUP_MATCHES) {
    // Raw index-matched count, before status filtering (which runs after hydration, below) -
    // a status filter cannot reduce this number, so it is deliberately not suggested as a fix.
    return { error: `Too many matched entities (${allIds.length}); narrow the urls list to fewer/less-popular URLs` };
  }

  const hydrated = allIds.length > 0 ? await fetchEntities(allIds) : [];
  if (hydrated.length !== allIds.length) {
    log?.warn?.(`[lookup-by-url] index referenced ${allIds.length - hydrated.length} entity id(s) that could not be hydrated (table=${table}, siteId=${siteId}) - the index may be stale`);
  }
  // Authorization / product-gating narrowing (e.g. D4 FACS composite type-scoping,
  // Summit-PLG). Applied to the full hydrated set BEFORE status filtering and
  // pagination, so an entity the caller may not see is absent from the entity map,
  // the per-URL id lists, and the page — and (for suggestions) counted as unmatched,
  // i.e. indistinguishable from "no match". Skipped entirely when nothing was hydrated,
  // so a hook with its own fixed cost (e.g. an `allBySiteId` fetch) isn't paid on a
  // request that matched nothing.
  const entities = (filterEntities && hydrated.length > 0)
    ? await filterEntities(hydrated)
    : hydrated;

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

  // keyset page over `getSortKey`, tie-broken on `getId` (see `compareEntities`) so the sort
  // is total and the cursor filter below can never silently drop a tied entity.
  const sorted = [...survivingById.values()]
    .sort((a, b) => compareEntities(a, b, getSortKey, getId));
  const afterCursor = cursorKey
    ? sorted.filter((e) => {
      const k = getSortKey(e);
      return k !== cursorKey.k ? k > cursorKey.k : getId(e) > cursorKey.id;
    })
    : sorted;
  const pageEntities = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > limit;
  const lastPageEntity = pageEntities[pageEntities.length - 1];
  const nextCursor = hasMore
    ? encodeCursor(getSortKey(lastPageEntity), getId(lastPageEntity))
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
    const matched = [...(idsByCanonical.get(canonical) ?? [])];
    const pageMatched = matched.filter((id) => pageIds.has(id));
    if (includeNoMatchInResults || pageMatched.length > 0) {
      results.push({ url, [idListKey]: pageMatched });
    }
    if (isFirstPage && !unmatchedSeen.has(url)) {
      const survivingMatched = matched.some((id) => survivingById.has(id));
      if (!survivingMatched) {
        unmatchedSeen.add(url);
        unmatchedUrls.push(url);
      }
    }
  }

  log?.info?.(`[lookup-by-url] table=${table} siteId=${siteId} urls=${urls.length} indexRows=${rows.length} matchedIds=${allIds.length} hydrated=${hydrated.length} afterAuth=${entities.length} page=${pageEntities.length} hasMore=${hasMore}`);

  return { response: buildResponse(results, entityMap, nextCursor, hasMore, unmatchedUrls) };
}
