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

// @ts-check

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ErrorWithStatusCode } from '../../utils.js';
import { ERROR_CODES } from '../errors.js';
import { DIMENSION } from '../prompt-tags.js';
import { resolveProject } from '../subworkspace-projects.js';
import { readTagTreeSnapshot } from '../tag-tree.js';
import {
  DEFAULT_TAG_SEARCH_LIMIT,
  MAX_TAG_SEARCH_LIMIT,
  MAX_TAG_SEARCH_QUERY_LENGTH,
  TAG_SEARCH_CURSOR_VERSION,
} from '../tag-search-constants.js';
import { normalizeGeoTargetId, normalizeLanguageCode } from '../validation.js';

/** @typedef {import('../rest-transport.js').SerenityTransport} SerenityTransport */
/**
 * @typedef {import('../tag-tree.js').TagTreeSnapshotItem} TagTreeSnapshotItem
 */
/**
 * @typedef {object} ParsedTagSearchQuery
 * @property {number} geoTargetId
 * @property {string} languageCode
 * @property {string} q - normalized (NFKC, trimmed, lower-cased) search text.
 * @property {number} limit
 * @property {string | null} cursor - opaque, HMAC-signed pagination cursor.
 */
/**
 * @typedef {object} TagSearchMatch
 * @property {string} id
 * @property {string} name
 * @property {string | null} parentId
 * @property {number} depth
 * @property {string[]} path - ancestor names, root-dimension entry excluded.
 * @property {'exact' | 'prefix' | 'substring' | 'path'} match
 */
/**
 * @typedef {object} TagSearchResult
 * @property {TagSearchMatch[]} items
 * @property {string | null} cursor - opaque cursor for the next page, or `null`
 *   when this page reached the end of the result set.
 * @property {true} complete - always `true`: a partial/incomplete traversal
 *   throws instead of returning (see {@link searchProjectTags}).
 */

export {
  TAG_SEARCH_CURSOR_VERSION,
  DEFAULT_TAG_SEARCH_LIMIT,
  MAX_TAG_SEARCH_LIMIT,
  MAX_TAG_SEARCH_QUERY_LENGTH,
};

function codedError(message, status, code) {
  const error = new ErrorWithStatusCode(message, status);
  error.code = code;
  return error;
}

function normalizeSearchText(value) {
  return String(value).normalize('NFKC').trim().toLowerCase();
}

function compareText(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function parseSearchQuery(query) {
  const geoTargetId = normalizeGeoTargetId(Number(query?.geoTargetId));
  const languageCode = normalizeLanguageCode(query?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw codedError(
      'geoTargetId (integer) and languageCode (BCP-47 primary subtag) are required',
      400,
      ERROR_CODES.INVALID_REQUEST,
    );
  }
  if (typeof query?.q !== 'string') {
    throw codedError('q is required', 400, ERROR_CODES.INVALID_REQUEST);
  }
  const q = normalizeSearchText(query.q);
  if (!q) {
    throw codedError('q must not be empty', 400, ERROR_CODES.INVALID_REQUEST);
  }
  if (Array.from(q).length > MAX_TAG_SEARCH_QUERY_LENGTH) {
    throw codedError(
      `q must not exceed ${MAX_TAG_SEARCH_QUERY_LENGTH} characters`,
      400,
      ERROR_CODES.INVALID_REQUEST,
    );
  }
  let limit = DEFAULT_TAG_SEARCH_LIMIT;
  if (query?.limit !== undefined) {
    limit = typeof query.limit === 'number' || /^[0-9]+$/.test(String(query.limit))
      ? Number(query.limit)
      : Number.NaN;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TAG_SEARCH_LIMIT) {
    throw codedError(
      `limit must be an integer between 1 and ${MAX_TAG_SEARCH_LIMIT}`,
      400,
      ERROR_CODES.INVALID_REQUEST,
    );
  }
  if (query?.cursor !== undefined
    && (typeof query.cursor !== 'string' || !query.cursor)) {
    throw codedError(
      'cursor must be an opaque string',
      400,
      ERROR_CODES.TAG_SEARCH_CURSOR_INVALID,
    );
  }
  return {
    geoTargetId,
    languageCode,
    q,
    limit,
    cursor: query?.cursor ?? null,
  };
}

function cursorSignature(encoded, secret) {
  return createHmac('sha256', secret).update(encoded).digest('base64url');
}

function encodeCursor(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${cursorSignature(encoded, secret)}`;
}

function decodeCursor(cursor, secret) {
  try {
    const [encoded, signature, extra] = cursor.split('.');
    if (!encoded || !signature || extra !== undefined) {
      throw new Error('malformed');
    }
    const expected = Buffer.from(cursorSignature(encoded, secret), 'utf8');
    const supplied = Buffer.from(signature, 'utf8');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new Error('invalid signature');
    }
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || payload.v !== TAG_SEARCH_CURSOR_VERSION
      || !Number.isInteger(payload.offset) || payload.offset < 0
      || typeof payload.q !== 'string'
      || typeof payload.project !== 'string'
      || typeof payload.revision !== 'string') {
      throw new Error('invalid payload');
    }
    return payload;
  } catch {
    throw codedError(
      'The tag search cursor is invalid',
      400,
      ERROR_CODES.TAG_SEARCH_CURSOR_INVALID,
    );
  }
}

function revisionOf(items) {
  const tuples = items
    .map((item) => [
      item.id,
      item.parentId,
      item.name,
      item.fullPath.map((part) => [part.id, part.name]),
    ])
    .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(tuples)).digest('base64url');
}

/**
 * @param {TagTreeSnapshotItem} item
 * @param {string} query - already-normalized search text.
 * @returns {{
 *   rank: number,
 *   match: 'exact' | 'prefix' | 'substring' | 'path',
 *   normalizedPath: string,
 * } | null}
 */
function matchOf(item, query) {
  const normalizedName = normalizeSearchText(item.name);
  const normalizedPath = item.fullPath.slice(1)
    .map((part) => normalizeSearchText(part.name))
    .join(' / ');
  if (normalizedName === query) {
    return { rank: 0, match: 'exact', normalizedPath };
  }
  if (normalizedName.startsWith(query)) {
    return { rank: 1, match: 'prefix', normalizedPath };
  }
  if (normalizedName.includes(query)) {
    return { rank: 2, match: 'substring', normalizedPath };
  }
  if (normalizedPath.includes(query)) {
    return { rank: 3, match: 'path', normalizedPath };
  }
  return null;
}

/**
 * @typedef {{
 *   rank: number,
 *   match: 'exact' | 'prefix' | 'substring' | 'path',
 *   normalizedPath: string,
 *   item: TagTreeSnapshotItem,
 * }} TagSearchMatchEntry
 */
/**
 * Type-guard for `.filter()`: `Array.prototype.filter(Boolean)` does not
 * narrow away `null` under `strictNullChecks`, so the sort/map that follows
 * would otherwise see `TagSearchMatchEntry | null`.
 *
 * @param {TagSearchMatchEntry | null} entry
 * @returns {entry is TagSearchMatchEntry}
 */
function isMatchEntry(entry) {
  return entry !== null;
}

/**
 * Filters a complete tag-tree snapshot to plain-tag (root-dimension `tag`,
 * depth > 1 — the root itself never matches) descendants matching `query`,
 * ranked exact > prefix > substring > path, tied by normalized path then id.
 *
 * @param {{ items: TagTreeSnapshotItem[] }} snapshot - see
 *   {@link import('../tag-tree.js').loadTagTreeSnapshot}.
 * @param {string} query - already-normalized (NFKC, trimmed, lower-cased)
 *   search text; see {@link normalizeSearchText}.
 * @returns {TagSearchMatch[]} rank-ordered matches (no `rank` field — that is
 *   sort-only and dropped from the returned shape).
 */
export function searchTagSnapshot(snapshot, query) {
  return snapshot.items
    .filter((item) => item.rootName === DIMENSION.TAG && item.depth > 1)
    .map((item) => {
      const matched = matchOf(item, query);
      return matched ? { item, ...matched } : null;
    })
    .filter(isMatchEntry)
    .sort((a, b) => a.rank - b.rank
      || compareText(a.normalizedPath, b.normalizedPath)
      || compareText(a.item.id, b.item.id))
    .map(({ item, match }) => ({
      id: item.id,
      name: item.name,
      parentId: item.parentId,
      depth: item.depth,
      path: item.fullPath.slice(1).map((part) => part.name),
      match,
    }));
}

/**
 * Runs one complete-tree, cacheless, fail-closed tag search against a
 * resolved project, deriving/validating the opaque pagination cursor.
 *
 * @param {SerenityTransport} transport
 * @param {string} workspaceId - Semrush (sub-)workspace id.
 * @param {string} projectId - AIO project id.
 * @param {ParsedTagSearchQuery} query - already-validated/normalized query
 *   (see {@link parseSearchQuery}); `cursor`, if present, has NOT yet been
 *   decoded/verified — that happens here, against `cursorSecret`.
 * @param {object} [log] - logger.
 * @param {string} [cursorSecret] - HMAC key signing the opaque cursor; a
 *   falsy value fails closed with 503 `TAG_SEARCH_UNAVAILABLE` before any
 *   traversal or cursor decode is attempted.
 * @returns {Promise<TagSearchResult>}
 */
async function searchProjectTags(
  transport,
  workspaceId,
  projectId,
  query,
  log,
  cursorSecret,
) {
  if (!cursorSecret) {
    throw codedError(
      'Tag search cursor signing is unavailable',
      503,
      ERROR_CODES.TAG_SEARCH_UNAVAILABLE,
    );
  }
  const parsed = query;
  const project = `${workspaceId}:${projectId}`;
  const cursor = parsed.cursor ? decodeCursor(parsed.cursor, cursorSecret) : null;
  if (cursor && (cursor.q !== parsed.q || cursor.project !== project)) {
    throw codedError(
      'The tag search cursor does not match this request',
      400,
      ERROR_CODES.TAG_SEARCH_CURSOR_INVALID,
    );
  }
  const startedAt = Date.now();
  let snapshot;
  try {
    snapshot = await readTagTreeSnapshot(
      transport,
      workspaceId,
      projectId,
      log,
      {
        forceRefresh: true, cacheResult: false, rootName: DIMENSION.TAG, strict: true,
      },
    );
  } catch (error) {
    log?.warn?.('handleSearchTags: complete-tree traversal failed', {
      workspaceId,
      projectId,
      code: error?.code,
      status: error?.status,
      durationMs: Date.now() - startedAt,
      cacheBypass: true,
    });
    throw error;
  }
  const revision = revisionOf(snapshot.items);
  if (cursor && cursor.revision !== revision) {
    throw codedError(
      'The tag search snapshot changed; restart from the first page',
      409,
      ERROR_CODES.TAG_SEARCH_SNAPSHOT_CHANGED,
    );
  }
  const matches = searchTagSnapshot(snapshot, parsed.q);
  const offset = cursor?.offset ?? 0;
  if (offset > matches.length) {
    throw codedError(
      'The tag search cursor offset is invalid',
      400,
      ERROR_CODES.TAG_SEARCH_CURSOR_INVALID,
    );
  }
  const items = matches.slice(offset, offset + parsed.limit);
  const nextOffset = offset + items.length;
  const matchCounts = matches.reduce((counts, item) => ({
    ...counts,
    [item.match]: (counts[item.match] ?? 0) + 1,
  }), {});
  log?.info?.('handleSearchTags: complete-tree search finished', {
    workspaceId,
    projectId,
    nodesVisited: snapshot.items.length,
    maximumDepth: snapshot.items.reduce((maximum, item) => Math.max(maximum, item.depth), 0),
    resultCount: matches.length,
    returnedCount: items.length,
    matchCounts,
    offset,
    nextOffset,
    durationMs: Date.now() - startedAt,
    cacheBypass: true,
  });
  return {
    items,
    cursor: nextOffset < matches.length
      ? encodeCursor({
        v: TAG_SEARCH_CURSOR_VERSION,
        q: parsed.q,
        project,
        offset: nextOffset,
        revision,
      }, cursorSecret)
      : null,
    complete: true,
  };
}

function marketNotFound() {
  return codedError(
    'No market for this brand and (geoTargetId, languageCode) slice',
    404,
    ERROR_CODES.MARKET_NOT_FOUND,
  );
}

/**
 * `GET /serenity/tags/search` (flat/brand-level mode): resolves the project
 * for a brand's (geoTargetId, languageCode) market slice, then runs
 * {@link searchProjectTags} against it.
 *
 * @param {SerenityTransport} transport
 * @param {{ BrandSemrushProject: {
 *   findBySlice: (brandId: string, geoTargetId: number, languageCode: string)
 *     => Promise<{ getSemrushProjectId: () => string } | null>,
 * } }} dataAccess
 * @param {string} brandId
 * @param {string} workspaceId - Semrush (sub-)workspace id.
 * @param {object} query - raw, unvalidated request query params; validated
 *   and normalized internally via {@link parseSearchQuery}.
 * @param {object} [log] - logger.
 * @param {string} [cursorSecret] - see {@link searchProjectTags}.
 * @returns {Promise<TagSearchResult>}
 */
export async function handleSearchTags(
  transport,
  dataAccess,
  brandId,
  workspaceId,
  query,
  log,
  cursorSecret,
) {
  const parsed = parseSearchQuery(query);
  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    parsed.geoTargetId,
    parsed.languageCode,
  );
  if (!row) {
    throw marketNotFound();
  }
  return searchProjectTags(
    transport,
    workspaceId,
    row.getSemrushProjectId(),
    parsed,
    log,
    cursorSecret,
  );
}

/**
 * `GET /serenity/tags/search` (sub-workspace mode): resolves the project for
 * a (geoTargetId, languageCode) slice directly under the workspace (no brand
 * row), then runs {@link searchProjectTags} against it.
 *
 * @param {SerenityTransport} transport
 * @param {string} workspaceId - Semrush (sub-)workspace id.
 * @param {object} query - raw, unvalidated request query params; validated
 *   and normalized internally via {@link parseSearchQuery}.
 * @param {object} [log] - logger.
 * @param {string} [cursorSecret] - see {@link searchProjectTags}.
 * @returns {Promise<TagSearchResult>}
 */
export async function handleSearchTagsSubworkspace(
  transport,
  workspaceId,
  query,
  log,
  cursorSecret,
) {
  const parsed = parseSearchQuery(query);
  const project = await resolveProject(
    transport,
    workspaceId,
    parsed.geoTargetId,
    parsed.languageCode,
    log,
  );
  if (!project) {
    throw marketNotFound();
  }
  return searchProjectTags(
    transport,
    workspaceId,
    String(project.id),
    parsed,
    log,
    cursorSecret,
  );
}
