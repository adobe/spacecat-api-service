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

import { createHash } from 'node:crypto';
import { ErrorWithStatusCode } from '../../utils.js';
import { ERROR_CODES } from '../errors.js';
import { DIMENSION } from '../prompt-tags.js';
import { resolveProject } from '../subworkspace-projects.js';
import { readTagTreeSnapshot } from '../tag-tree.js';
import {
  DEFAULT_TAG_SEARCH_LIMIT,
  MAX_TAG_SEARCH_CURSOR_DECODED_BYTES,
  MAX_TAG_SEARCH_CURSOR_LENGTH,
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
 * @property {string | null} cursor - opaque, versioned base64url pagination state.
 */
/**
 * @typedef {object} TagSearchMatch
 * @property {string} id
 * @property {string} name
 * @property {string | null} parentId
 * @property {number} depth
 * @property {string[]} path - the tag's ancestry from its top-level ancestor
 *   down to AND INCLUDING the tag's own name as the last element; only the
 *   root-dimension entry (`tag`) is excluded.
 * @property {'exact' | 'prefix' | 'substring' | 'path'} match
 */
/**
 * @typedef {object} TagSearchResult
 * @property {TagSearchMatch[]} items
 * @property {string | null} cursor - opaque cursor for the next page, or `null`
 *   when this page reached the end of the result set.
 * @property {true} complete - always `true`: the result is NOT budget-truncated
 *   (a partial/incomplete traversal throws instead of returning — see
 *   {@link searchProjectTags}). It is not a point-in-time consistency claim:
 *   the walk spans many upstream calls, so a mutation landing into an
 *   already-visited level is simply absent from this snapshot. Reserved as a
 *   forward-compatible discriminator should a degraded/partial mode ever ship.
 */

export {
  TAG_SEARCH_CURSOR_VERSION,
  MAX_TAG_SEARCH_CURSOR_LENGTH,
  MAX_TAG_SEARCH_CURSOR_DECODED_BYTES,
  DEFAULT_TAG_SEARCH_LIMIT,
  MAX_TAG_SEARCH_LIMIT,
  MAX_TAG_SEARCH_QUERY_LENGTH,
};

function codedError(message, status, code) {
  const error = new ErrorWithStatusCode(message, status);
  error.code = code;
  return error;
}

/**
 * The 503 `tagSearchUnavailable` shape used by the controller's environment
 * kill-switch check after authorization and before project resolution.
 *
 * @param {string} [message]
 * @returns {Error}
 */
export function tagSearchUnavailableError(message = 'Tag search is unavailable') {
  return codedError(message, 503, ERROR_CODES.TAG_SEARCH_UNAVAILABLE);
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
  // Bound the RAW input before normalizing: NFKC can EXPAND a string (one
  // compatibility character folds to several), so normalizing first would let
  // an over-long input through the allocation the length cap exists to bound.
  if (Array.from(query.q).length > MAX_TAG_SEARCH_QUERY_LENGTH) {
    throw codedError(
      `q must not exceed ${MAX_TAG_SEARCH_QUERY_LENGTH} characters`,
      400,
      ERROR_CODES.INVALID_REQUEST,
    );
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

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_KEYS = Object.freeze(['offset', 'q', 'revision', 'v']);
const SHA256_BYTES = 32;

function invalidCursorError() {
  return codedError(
    'The tag search cursor is invalid',
    400,
    ERROR_CODES.TAG_SEARCH_CURSOR_INVALID,
  );
}

function isValidRevision(revision) {
  if (typeof revision !== 'string' || !BASE64URL_PATTERN.test(revision)) {
    return false;
  }
  const bytes = Buffer.from(revision, 'base64url');
  return bytes.length === SHA256_BYTES && bytes.toString('base64url') === revision;
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  try {
    if (typeof cursor !== 'string'
      || cursor.length === 0
      || cursor.length > MAX_TAG_SEARCH_CURSOR_LENGTH
      || !BASE64URL_PATTERN.test(cursor)) {
      throw new Error('malformed');
    }
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.length === 0
      || decoded.length > MAX_TAG_SEARCH_CURSOR_DECODED_BYTES
      || decoded.toString('base64url') !== cursor) {
      throw new Error('non-canonical');
    }
    const json = decoded.toString('utf8');
    if (!Buffer.from(json, 'utf8').equals(decoded)) {
      throw new Error('invalid utf-8');
    }
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).sort().join(',') !== CURSOR_KEYS.join(',')
      || payload.v !== TAG_SEARCH_CURSOR_VERSION
      || !Number.isSafeInteger(payload.offset) || payload.offset < 0
      || typeof payload.q !== 'string'
      || !payload.q
      || Array.from(payload.q).length > MAX_TAG_SEARCH_QUERY_LENGTH
      || normalizeSearchText(payload.q) !== payload.q
      || !isValidRevision(payload.revision)) {
      throw new Error('invalid payload');
    }
    return payload;
  } catch {
    throw invalidCursorError();
  }
}

/**
 * Content hash of the whole snapshot, binding a cursor to the taxonomy it was
 * issued against (a change between pages 409s rather than silently shifting
 * offsets). The per-item JSON key is computed ONCE and sorted on, rather than
 * re-serializing both operands inside the comparator — the comparator runs
 * O(n log n) times over up to `maxNodes` items on every request.
 *
 * @param {TagTreeSnapshotItem[]} items
 * @returns {string}
 */
function revisionOf(items) {
  const tuples = items
    .map((item) => {
      const tuple = [
        item.id,
        item.parentId,
        item.name,
        item.fullPath.map((part) => [part.id, part.name]),
      ];
      return { key: JSON.stringify(tuple), tuple };
    })
    .sort((a, b) => compareText(a.key, b.key))
    .map(({ tuple }) => tuple);
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
 *   decoded/validated — that happens here before use.
 * @param {object} [log] - logger.
 * @param {object} [budgets] - per-environment traversal budget overrides; see
 *   {@link import('../tag-search-constants.js').resolveTagTreeBudgets}.
 * @returns {Promise<TagSearchResult>}
 */
async function searchProjectTags(
  transport,
  workspaceId,
  projectId,
  query,
  log,
  budgets,
) {
  const parsed = query;
  const cursor = parsed.cursor ? decodeCursor(parsed.cursor) : null;
  if (cursor && cursor.q !== parsed.q) {
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
        forceRefresh: true, cacheResult: false, rootName: DIMENSION.TAG, strict: true, budgets,
      },
    );
  } catch (error) {
    log?.warn?.('handleSearchTags: complete-tree traversal failed', {
      workspaceId,
      projectId,
      code: error?.code,
      status: error?.status,
      budget: /** @type {any} */ (error)?.details?.budget,
      budgets,
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
  const matchCounts = /** @type {Record<string, number>} */ ({});
  for (const item of matches) {
    matchCounts[item.match] = (matchCounts[item.match] ?? 0) + 1;
  }
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
        offset: nextOffset,
        revision,
      })
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
 * @param {object} [budgets] - see {@link searchProjectTags}.
 * @returns {Promise<TagSearchResult>}
 */
export async function handleSearchTags(
  transport,
  dataAccess,
  brandId,
  workspaceId,
  query,
  log,
  budgets,
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
    budgets,
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
 * @param {object} [budgets] - see {@link searchProjectTags}.
 * @returns {Promise<TagSearchResult>}
 */
export async function handleSearchTagsSubworkspace(
  transport,
  workspaceId,
  query,
  log,
  budgets,
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
    budgets,
  );
}
