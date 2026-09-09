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
import { hasText } from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode } from '../../utils.js';
import { ERROR_CODES } from '../errors.js';
import {
  normalizeGeoTargetId, normalizeLanguageCode, MAX_TAG_ID_LEN, isValidTagIdFormat,
} from '../validation.js';
import { resolveProject } from '../subworkspace-projects.js';
import {
  ALL_DIMENSIONS, SERVER_OWNED_DIMENSIONS,
  isClosedDimension, isServerOwnedDimension, closedValuesOf, isDimensionRootName,
  MAX_TAG_NAME_LEN, dimensionOfRootName,
} from '../prompt-tags.js';
import {
  ensureServerOwnedValue,
  ensureChildren,
  ensureDimensionRoots,
  findTagsInTree,
  assertParentPlacement,
  assertParentWithinDimension,
  collectSubtreeIds,
  readTagTreeSnapshot,
  incompatibleTaxonomyError,
} from '../tag-tree.js';
import { republish } from '../brand-urls.js';
import { invalidateTagCacheForProject } from './markets.js';

/** @typedef {import('../rest-transport.js').SerenityTransport} SerenityTransport */

/**
 * POST /serenity/tags — create a prompt TAG on a single market.
 *
 * Every tag is BARE-NAMED and lives under one of the registered dimension roots
 * (`category`, `tag`, `intent`, `origin`, `type`, `source`) on a market's project — the
 * `aio/tags` surface, via {@link createProjectTags}. A tag's dimension is its
 * root ancestor, never a prefix on its name, so `type` in the request body
 * names the dimension the value belongs to rather than something written into
 * the name.
 *
 * The four SERVER-OWNED dimensions (`intent` / `origin` / `type` / `source`)
 * accept no `parentId` (their values are always direct children of the dimension
 * root) and are created resolve-or-create — a small, project-wide-shared set every
 * caller may need the id of. The three CLOSED ones additionally enum-check the
 * `name`; `source` is open (source-dimension.md) so any bare name resolves-or-
 * creates. The CUSTOMER-AUTHORED open dimensions (`category` and `tag`) carry
 * customer values beneath their own roots.
 *
 * Both the flat-mode and subworkspace-mode handlers resolve the market's project
 * id from the `(geoTargetId, languageCode)` slice and register one tag.
 */

/**
 * Length + whitespace/control-char validation shared by every parentId parser
 * below, given an already-trimmed, already-known-to-be-a-string, non-empty id.
 * Delegates to isValidTagIdFormat (validation.js) for the character check --
 * the same bound prompts.js's tagIds array entries are held to -- but keeps
 * the length and character checks as separate throws so the 400 message
 * pinpoints which one failed. The length check runs first, so by the time
 * isValidTagIdFormat is consulted `id.length` is already known to be in
 * bounds and a `false` result can only mean a whitespace/control character.
 */
function validateParentIdFormat(id) {
  if (id.length > MAX_TAG_ID_LEN) {
    throw new ErrorWithStatusCode(
      `parentId must not exceed ${MAX_TAG_ID_LEN} characters`,
      400,
    );
  }
  if (!isValidTagIdFormat(id)) {
    throw new ErrorWithStatusCode(
      'parentId must not contain whitespace or control characters',
      400,
    );
  }
}

/**
 * Validates an optional upstream parent tag id (an `id` from a prior tags list).
 * Returns the trimmed id, or `undefined` when absent/empty — an empty parent is a
 * no-op upstream (a flat/root create), so it is normalized away rather than sent.
 * Throws a 400 {@link ErrorWithStatusCode} on a malformed value.
 *
 * @param {unknown} raw - the request's `parentId`.
 * @returns {string | undefined}
 */
function parseParentId(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new ErrorWithStatusCode('parentId must be a string', 400);
  }
  const id = raw.trim();
  if (!id) {
    return undefined;
  }
  validateParentIdFormat(id);
  return id;
}

/**
 * Validates the UPDATE body's `parentId`. `undefined` (omitted) means "keep the
 * current parent" -- which this proxy honours by RE-SENDING the target's current
 * parent upstream, never by omitting the field: an upstream PATCH body without
 * `parent_id` PROMOTES the tag to a root (verified live), stranding it outside
 * its dimension while every carrying prompt stays attached.
 *
 * An explicit `null` is rejected. Under the dimension-root model the root level
 * is reserved for the six dimension roots, so promoting a tag to a root is never
 * a legal request -- it would produce a tag with no dimension.
 *
 * @param {object} body - the raw request body.
 * @returns {string | undefined}
 */
function parseUpdateParentId(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'parentId')) {
    return undefined;
  }
  const raw = body.parentId;
  if (raw === null) {
    throw new ErrorWithStatusCode(
      'parentId must not be null: the root level is reserved for the dimension roots, '
      + 'so a tag cannot be promoted to a root',
      400,
    );
  }
  if (typeof raw !== 'string') {
    throw new ErrorWithStatusCode('parentId must be a string', 400);
  }
  const id = raw.trim();
  if (!id) {
    // Omission and an empty string mean the same thing: keep the current parent.
    return undefined;
  }
  validateParentIdFormat(id);
  return id;
}

/**
 * Validates + normalizes the create-tag body, throwing a 400
 * {@link ErrorWithStatusCode} on the first problem. Returns the parsed
 * `{ type, name, geoTargetId, languageCode, parentId, isClosed }`.
 *
 * `type` names one of {@link ALL_DIMENSIONS}. `name` is BARE — a `:` is
 * rejected rather than rewritten, and a reserved dimension-root name is refused
 * so no value can shadow a root. `parentId` (optional) is the upstream id of
 * the tag the new one nests under; it is only legal for the CUSTOMER-AUTHORED open
 * dimension (`category`), since a server-owned dimension's values are always
 * direct children of its root.
 *
 * The two flags answer two independent questions. `isClosed`
 * ({@link isClosedDimension}) drives VOCABULARY validation: a closed value's
 * `name` must be one of that dimension's fixed values ({@link closedValuesOf}).
 * `isServerOwned` ({@link isServerOwnedDimension}) drives the WRITE GUARD and
 * CREATE SEMANTICS: it forbids a `parentId` (server-owned values hang directly off
 * their root) and routes the create through resolve-or-create. `source` is
 * server-owned yet open — a `parentId` is refused and the value is resolved-or-
 * created, but there is no enum to check against.
 *
 * @param {object} body - request body.
 * @returns {{
 *   type: string, name: string, geoTargetId: number,
 *   languageCode: string, parentId: string | undefined,
 *   isClosed: boolean, isServerOwned: boolean,
 * }}
 */
function parseCreateTagBody(body) {
  const type = hasText(body?.type) ? String(body.type).trim().toLowerCase() : '';
  // Frozen literal tuple; widen to string[] so `.includes(type)` accepts an
  // arbitrary runtime string for the membership test.
  const dimensions = /** @type {readonly string[]} */ (ALL_DIMENSIONS);
  if (!dimensions.includes(type)) {
    throw new ErrorWithStatusCode(
      `type must be one of: ${ALL_DIMENSIONS.join(', ')}`,
      400,
    );
  }
  const isClosed = isClosedDimension(type);
  const isServerOwned = isServerOwnedDimension(type);
  const rawName = hasText(body?.name) ? String(body.name).trim() : '';
  if (!rawName) {
    throw new ErrorWithStatusCode('name is required', 400);
  }
  if (rawName.length > MAX_TAG_NAME_LEN) {
    throw new ErrorWithStatusCode(
      `name must not exceed ${MAX_TAG_NAME_LEN} characters`,
      400,
    );
  }
  // Tag names are bare under the dimension-root model — a tag's dimension is its
  // root ancestor, never a prefix on its name. A `:` would be a stale caller
  // trying to smuggle a dimension into the name; reject rather than rewrite.
  if (rawName.includes(':')) {
    throw new ErrorWithStatusCode('name must not contain ":"', 400);
  }
  if (rawName.includes('__')) {
    throw new ErrorWithStatusCode('name must not contain "__"', 400);
  }
  // The root level holds the registered dimension roots. A value may not
  // shadow one of their names, or the tree would have two tags a reader cannot
  // tell apart by name at the level that matters. The CHECK covers every reserved
  // name (both intent spellings); the MESSAGE names only the dimensions, so the
  // `$abv_tags$` marker — a Semrush-internal detail that means nothing to a
  // customer — stays out of a customer-facing 400.
  if (isDimensionRootName(rawName)) {
    throw new ErrorWithStatusCode(
      `name must not be a reserved dimension root name (${ALL_DIMENSIONS.join(', ')})`,
      400,
    );
  }
  // Reject C0/C1-adjacent control characters (incl. DEL): unprintable chars have
  // no legitimate place in a customer-authored tag value and cause UI + upstream
  // confusion. Zero-width joiners (U+200C/U+200D) are intentionally NOT banned —
  // they are legitimate in some scripts and emoji sequences.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(rawName)) {
    throw new ErrorWithStatusCode('name must not contain control characters', 400);
  }
  if (isClosed && !(/** @type {readonly string[]} */ (closedValuesOf(type))).includes(rawName)) {
    throw new ErrorWithStatusCode(
      `name is not a valid ${type} value`,
      400,
    );
  }
  const geoTargetId = normalizeGeoTargetId(Number(body?.geoTargetId));
  if (geoTargetId === null) {
    throw new ErrorWithStatusCode('geoTargetId must be a positive integer', 400);
  }
  const languageCode = normalizeLanguageCode(body?.languageCode);
  if (languageCode === null) {
    throw new ErrorWithStatusCode(
      'languageCode must match ^[a-z]{2,3}(-[a-z]{2,4})?$',
      400,
    );
  }
  const parentId = parseParentId(body?.parentId);
  if (isServerOwned && parentId !== undefined) {
    throw new ErrorWithStatusCode(
      `parentId is not allowed for a server-owned dimension (${SERVER_OWNED_DIMENSIONS.join(', ')}): `
      + 'its values are always direct children of the dimension root',
      400,
    );
  }
  return {
    type, name: rawName, geoTargetId, languageCode, parentId, isClosed, isServerOwned,
  };
}

/**
 * Picks the created/updated tag's upstream id + parent id out of the transport
 * result. `createProjectTags` resolves to a LIST (model.TreeNodeResponse[]);
 * `updateProjectTag` to a single object. A validated parent sent to upstream is
 * authoritative because update responses may intermittently echo the old
 * `parent_id`; the upstream value is used only when no intended parent is known.
 *
 * @param {any} result - transport result (array for create, object for update).
 * @param {string | null | undefined} requestedParentId
 * @returns {{ id: string | undefined, parentId: string | null }}
 */
function pickTagIds(result, requestedParentId) {
  const node = Array.isArray(result) ? result[0] : result;
  const id = node && typeof node.id === 'string' ? node.id : undefined;
  const upstreamParentId = node && typeof node.parent_id === 'string' && node.parent_id
    ? node.parent_id
    : null;
  const parentId = requestedParentId !== undefined
    ? requestedParentId
    : upstreamParentId;
  return { id, parentId };
}

/**
 * The created tag's id, or a 502 when the upstream create answered 2xx without
 * echoing one. Answering 201 with the `id` field missing tells a client its tag
 * exists while giving it nothing to attach a prompt to; the next id-based prompt
 * write is atomic on an unresolvable id and would fail far from the cause.
 *
 * @param {string | undefined} id - the id picked out of the transport result.
 * @returns {string}
 */
function requireCreatedId(id) {
  if (!id) {
    throw new ErrorWithStatusCode('upstream created the tag but echoed no id', 502);
  }
  return id;
}

async function readTagDto(
  transport,
  semrushWorkspaceId,
  projectId,
  id,
  fallback,
  log,
) {
  const snapshot = await readTagTreeSnapshot(
    transport,
    semrushWorkspaceId,
    projectId,
    log,
  );
  const item = snapshot.byId.get(id);
  if (!item) {
    return fallback;
  }
  return {
    id: item.id,
    name: item.name,
    parentId: item.parentId,
    path: item.fullPath.slice(0, -1),
    compatibility: item.compatibility,
    childrenCount: item.childrenCount,
    promptsCount: item.promptsCount,
  };
}

/**
 * The id of an OPEN dimension's root tag, provisioning the six dimension roots
 * if the project predates them. An open-dimension create with no `parentId`
 * hangs the new value directly under this root.
 *
 * `ensureDimensionRoots` fails closed — it throws a 502 rather than return a map
 * missing a root — so the lookup below always resolves. The assertion records
 * that invariant for the type checker instead of re-testing it at runtime.
 *
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} dimension - an open dimension (`category`).
 * @param {object} [log] - logger.
 * @returns {Promise<string>}
 */
async function resolveOpenRootId(transport, semrushWorkspaceId, projectId, dimension, log) {
  const roots = await ensureDimensionRoots(transport, semrushWorkspaceId, projectId, log);
  return /** @type {string} */ (roots.get(dimension));
}

/**
 * The parent an open-dimension create should hang its new tag under: the
 * caller's `parentId` once it is proven to sit inside `dimension`, or the
 * dimension's own root when none was supplied.
 *
 * The proof is the point. `parseCreateTagBody` refuses a `parentId` on a CLOSED
 * dimension, but `type` is caller-supplied and only picks the validation branch —
 * declaring the open dimension and pointing `parentId` at the `intent` root would
 * otherwise file a customer-authored value under `intent`, which is exactly what
 * the closed vocabularies exist to prevent.
 *
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} dimension - the open dimension named by the request.
 * @param {string | undefined} parentId - the caller-supplied parent, if any.
 * @param {object} [log] - logger.
 * @returns {Promise<string>}
 */
async function resolveTargetParent(
  transport,
  semrushWorkspaceId,
  projectId,
  dimension,
  parentId,
  log,
) {
  if (parentId === undefined) {
    return resolveOpenRootId(transport, semrushWorkspaceId, projectId, dimension, log);
  }
  if (dimension === 'tag') {
    const snapshot = await readTagTreeSnapshot(
      transport,
      semrushWorkspaceId,
      projectId,
      log,
    );
    const parent = snapshot.byId.get(parentId);
    if (parent?.compatibility?.state === 'readOnly') {
      throw incompatibleTaxonomyError([parent]);
    }
    if (!parent || parent.rootName !== 'tag' || parent.depth > 2) {
      throw new ErrorWithStatusCode(
        'parentId must be the "tag" root or one of its direct children',
        400,
      );
    }
    return parentId;
  }
  await assertParentWithinDimension(
    transport,
    semrushWorkspaceId,
    projectId,
    dimension,
    parentId,
    log,
  );
  return parentId;
}

/** Throws a 404 `marketNotFound` for a slice with no backing project. */
function marketNotFound() {
  const err = new ErrorWithStatusCode(
    'No market for this brand and (geoTargetId, languageCode) slice',
    404,
  );
  err.code = ERROR_CODES.MARKET_NOT_FOUND;
  return err;
}

/**
 * Flat mode — the market's project id comes from the persisted
 * `BrandSemrushProject` mapping (same resolution as handleListTags).
 *
 * @param {SerenityTransport} transport
 * @param {object} dataAccess - data-access layer (BrandSemrushProject).
 * @param {string} brandId - brand UUID.
 * @param {string} semrushWorkspaceId - the org's (parent) workspace id.
 * @param {object} body - request body ({ type, name, geoTargetId, languageCode, parentId? }).
 * @param {object} log - logger.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleCreateTag(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  body,
  log,
) {
  const {
    type, name, geoTargetId, languageCode, parentId, isServerOwned,
  } = parseCreateTagBody(body);
  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    throw marketNotFound();
  }
  const projectId = row.getSemrushProjectId();

  if (isServerOwned) {
    const { id, rootId, created } = await ensureServerOwnedValue(
      transport,
      semrushWorkspaceId,
      projectId,
      type,
      name,
      log,
    );
    log?.info?.('handleCreateTag: resolved server-owned-dimension value', {
      brandId, geoTargetId, languageCode, type, name, created,
    });
    // A create leaves the project in `live_with_unpublished_updates`; publish so
    // the new value is live (only when we actually seeded one).
    // Errors (including a real quota rejection) propagate, matching the brand-URL
    // / alias / benchmark write paths (SITES-49206 — see brand-urls.js `republish`).
    if (created) {
      await republish(transport, semrushWorkspaceId, projectId, log);
    }
    const tag = await readTagDto(
      transport,
      semrushWorkspaceId,
      projectId,
      id,
      {
        id,
        name,
        parentId: rootId,
        path: null,
        compatibility: { state: 'canonical', reason: null },
        childrenCount: 0,
        promptsCount: 0,
      },
      log,
    );
    return {
      status: 200,
      body: {
        brandId,
        geoTargetId,
        languageCode,
        type,
        ...tag,
        created,
      },
    };
  }

  // An open-dimension value is always a DESCENDANT of its dimension root: a
  // customer category hangs off the `category` root, a sub-category off a
  // category. An omitted parentId therefore means "directly under the root",
  // not "at the root level". A supplied one is checked by ancestry, or it could
  // hang a customer-authored value inside a closed dimension.
  const targetParentId = await resolveTargetParent(
    transport,
    semrushWorkspaceId,
    projectId,
    type,
    parentId,
    log,
  );
  const { byName, createdNames } = await ensureChildren(
    transport,
    semrushWorkspaceId,
    projectId,
    targetParentId,
    [name],
    log,
  );
  const id = byName.get(name);
  const wasCreated = createdNames.includes(name);
  log?.info?.('handleCreateTag: registered tag', {
    brandId, geoTargetId, languageCode, name, parentId: targetParentId,
  });
  // Publish so the newly created tag is live rather than left as a draft
  // (`live_with_unpublished_updates`). See the closed-path note above.
  if (wasCreated) {
    await republish(transport, semrushWorkspaceId, projectId, log);
  }
  const tag = await readTagDto(
    transport,
    semrushWorkspaceId,
    projectId,
    requireCreatedId(id),
    {
      id: requireCreatedId(id),
      name,
      parentId: targetParentId,
      path: null,
      compatibility: { state: 'canonical', reason: null },
      childrenCount: 0,
      promptsCount: 0,
    },
    log,
  );
  return {
    status: wasCreated ? 201 : 200,
    body: {
      brandId,
      geoTargetId,
      languageCode,
      type,
      ...tag,
      created: wasCreated,
    },
  };
}

/**
 * Subworkspace mode — the market's project is resolved live from the brand's
 * own subworkspace listing (same resolution as handleListTagsSubworkspace).
 *
 * @param {SerenityTransport} transport
 * @param {string} workspaceId - the brand's subworkspace id.
 * @param {object} body - request body ({ type, name, geoTargetId, languageCode, parentId? }).
 * @param {object} log - logger.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleCreateTagSubworkspace(
  transport,
  workspaceId,
  body,
  log,
) {
  const {
    type, name, geoTargetId, languageCode, parentId, isServerOwned,
  } = parseCreateTagBody(body);
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    throw marketNotFound();
  }
  const projectId = String(project.id);

  if (isServerOwned) {
    const { id, rootId, created } = await ensureServerOwnedValue(
      transport,
      workspaceId,
      projectId,
      type,
      name,
      log,
    );
    log?.info?.('handleCreateTagSubworkspace: resolved server-owned-dimension value', {
      geoTargetId, languageCode, type, name, created,
    });
    // Publish the seeded value so it is live. See handleCreateTag.
    if (created) {
      await republish(transport, workspaceId, projectId, log);
    }
    const tag = await readTagDto(
      transport,
      workspaceId,
      projectId,
      id,
      {
        id,
        name,
        parentId: rootId,
        path: null,
        compatibility: { state: 'canonical', reason: null },
        childrenCount: 0,
        promptsCount: 0,
      },
      log,
    );
    return {
      status: 200,
      body: {
        geoTargetId,
        languageCode,
        type,
        ...tag,
        created,
      },
    };
  }

  const targetParentId = await resolveTargetParent(
    transport,
    workspaceId,
    projectId,
    type,
    parentId,
    log,
  );
  const { byName, createdNames } = await ensureChildren(
    transport,
    workspaceId,
    projectId,
    targetParentId,
    [name],
    log,
  );
  const id = byName.get(name);
  const wasCreated = createdNames.includes(name);
  log?.info?.('handleCreateTagSubworkspace: registered tag', {
    geoTargetId, languageCode, name, parentId: targetParentId,
  });
  // Publish so the newly created tag is live rather than a draft.
  if (wasCreated) {
    await republish(transport, workspaceId, projectId, log);
  }
  const tag = await readTagDto(
    transport,
    workspaceId,
    projectId,
    requireCreatedId(id),
    {
      id: requireCreatedId(id),
      name,
      parentId: targetParentId,
      path: null,
      compatibility: { state: 'canonical', reason: null },
      childrenCount: 0,
      promptsCount: 0,
    },
    log,
  );
  return {
    status: wasCreated ? 201 : 200,
    body: {
      geoTargetId,
      languageCode,
      type,
      ...tag,
      created: wasCreated,
    },
  };
}

/**
 * Throws a 400 for a missing/blank tagId path param, or one too long or
 * carrying whitespace/control characters -- mirrors {@link parseParentId}'s
 * validation for consistency; openapi-fetch already encodes path params, so
 * this is defense-in-depth rather than a live exploit. Returns the trimmed id.
 */
function requireTagId(tagId) {
  if (!hasText(tagId)) {
    throw new ErrorWithStatusCode('tagId is required', 400);
  }
  const id = String(tagId).trim();
  if (id.length > MAX_TAG_ID_LEN) {
    throw new ErrorWithStatusCode(`tagId must not exceed ${MAX_TAG_ID_LEN} characters`, 400);
  }
  if (!isValidTagIdFormat(id)) {
    throw new ErrorWithStatusCode('tagId must not contain whitespace or control characters', 400);
  }
  return id;
}

/**
 * Validates + normalizes the update-tag body's SYNTAX only, throwing a 400 on
 * the first problem. Whether the PATCH target may be renamed at all depends on
 * its position in the tree, which only {@link resolveTagTarget} can answer (it
 * needs transport access this pure parser doesn't have). See
 * {@link buildUpdatePayload} for that cross-check.
 *
 * @param {object} body - request body ({ name, parentId?, geoTargetId, languageCode }).
 * @returns {{
 *   value: string, parentId: string | undefined,
 *   geoTargetId: number, languageCode: string,
 * }}
 */
function parseUpdateTagBody(body) {
  const rawName = hasText(body?.name) ? String(body.name).trim() : '';
  if (!rawName) {
    throw new ErrorWithStatusCode('name is required', 400);
  }
  const value = rawName;
  if (value.length > MAX_TAG_NAME_LEN) {
    throw new ErrorWithStatusCode(
      `name value must not exceed ${MAX_TAG_NAME_LEN} characters`,
      400,
    );
  }
  // Names are bare: a tag's dimension is its root ancestor, not a name prefix.
  if (value.includes(':')) {
    throw new ErrorWithStatusCode('name must not contain ":"', 400);
  }
  if (value.includes('__')) {
    throw new ErrorWithStatusCode('name must not contain "__"', 400);
  }
  if (isDimensionRootName(value)) {
    throw new ErrorWithStatusCode(
      `name must not be a reserved dimension root name (${ALL_DIMENSIONS.join(', ')})`,
      400,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw new ErrorWithStatusCode('name must not contain control characters', 400);
  }
  const parentId = parseUpdateParentId(body);
  const geoTargetId = normalizeGeoTargetId(Number(body?.geoTargetId));
  if (geoTargetId === null) {
    throw new ErrorWithStatusCode('geoTargetId must be a positive integer', 400);
  }
  const languageCode = normalizeLanguageCode(body?.languageCode);
  if (languageCode === null) {
    throw new ErrorWithStatusCode(
      'languageCode must match ^[a-z]{2,3}(-[a-z]{2,4})?$',
      400,
    );
  }
  return {
    value, parentId, geoTargetId, languageCode,
  };
}

/**
 * @param {{
 *   depth: number,
 *   parentId: string | null,
 *   rootName: string,
 *   fullPath: Array<{ id: string }>,
 * } | undefined} item
 * @returns {import('../tag-tree.js').TagPosition}
 */
function positionFromSnapshot(item) {
  if (!item) {
    return {
      kind: 'unknown', parentId: null, rootName: null, ancestorIds: [],
    };
  }
  return {
    kind: item.depth === 1 ? 'root' : 'descendant',
    parentId: item.parentId,
    rootName: dimensionOfRootName(item.rootName),
    ancestorIds: item.fullPath.slice(0, -1).map((part) => part.id),
  };
}

/**
 * Decides what to forward upstream for a PATCH, given the target's resolved tree
 * position (see {@link findTagsInTree}).
 *
 * The outgoing body ALWAYS carries an explicit `parent_id`: an upstream PATCH
 * that omits it PROMOTES the tag to a root (verified live). So a rename-only
 * PATCH re-sends the target's own current parent, and a re-parent sends the
 * requested one.
 *
 * Three targets are refused. A DIMENSION ROOT is not editable — the root level is
 * reserved for the registered dimension roots ({@link ALL_DIMENSIONS}), and
 * renaming or moving one would leave its whole subtree without a dimension. A
 * SERVER-OWNED dimension's value ({@link SERVER_OWNED_DIMENSIONS}) is not editable
 * either: its vocabulary is authored by the server, and since every
 * resolve-or-create keys on the bare name under the root, renaming a value would
 * not move it, it would hide it — the next server write then mints a second value
 * under the same root and every prompt still carrying the first splits across two
 * ids for one dimension value. The guard therefore keys on the OWNERSHIP axis
 * ({@link isServerOwnedDimension}), not the open/closed vocabulary axis: `source`
 * is open yet server-owned, and became reachable here once its root seeded live
 * projects (LLMO-6665). An UNRESOLVABLE id is refused rather than forwarded: without
 * the target's current parent there is no body that preserves it, and guessing would
 * promote the tag.
 *
 * @param {{ value: string, parentId: string | undefined }} parsed
 * @param {{ kind: 'root' | 'descendant' | 'unknown', parentId: string | null,
 *   rootName: string | null }} target
 * @param {string} tagId - the PATCH target's own id, to refuse a self-parent.
 * @returns {{ name: string, parentIdToSend: string }}
 */
function buildUpdatePayload(parsed, target, tagId) {
  const { value, parentId } = parsed;
  if (target.kind === 'root') {
    throw new ErrorWithStatusCode(
      `a dimension root (${ALL_DIMENSIONS.join(', ')}) cannot be renamed or re-parented`,
      400,
    );
  }
  if (target.kind === 'unknown') {
    const err = new ErrorWithStatusCode('No tag with this id on this market', 404);
    err.code = ERROR_CODES.TAG_NOT_FOUND;
    throw err;
  }
  if (!target.rootName) {
    const error = new ErrorWithStatusCode('Unable to determine the tag dimension', 503);
    error.code = ERROR_CODES.TAG_TREE_READ_INCOMPLETE;
    throw error;
  }
  if (isServerOwnedDimension(target.rootName)) {
    throw new ErrorWithStatusCode(
      `a value of the server-owned "${target.rootName}" dimension cannot be renamed or re-parented`,
      400,
    );
  }
  if (parentId === tagId) {
    throw new ErrorWithStatusCode('parentId must not be the tag itself', 400);
  }
  // findTagsInTree's descendant branch always resolves a parent (falling back to
  // the node it was found under), so this is never null.
  const currentParentId = /** @type {string} */ (target.parentId);
  return { name: value, parentIdToSend: parentId ?? currentParentId };
}

/**
 * PATCH /serenity/tags/:tagId (flat mode) -- rename and/or re-parent a single
 * tag in place. The market's project id comes from the persisted
 * `BrandSemrushProject` mapping (same resolution as handleCreateTag).
 *
 * Resolves the target's current tree position first (see
 * {@link resolveTagTarget}) so a rename never omits `parent_id` — an upstream
 * PATCH without it silently promotes the tag to a root (serenity-docs#24
 * section 3.1 gate 5). A dimension root is refused with a 400, and an id absent
 * from the tree with a 404 `tagNotFound` rather than forwarded: without the
 * target's current parent there is no body that preserves it.
 *
 * @param {SerenityTransport} transport
 * @param {object} dataAccess - data-access layer (BrandSemrushProject).
 * @param {string} brandId - brand UUID.
 * @param {string} semrushWorkspaceId - the org's (parent) workspace id.
 * @param {string} tagId - upstream tag id to update.
 * @param {object} body - request body ({ name, parentId?, geoTargetId, languageCode }).
 * @param {object} log - logger.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleUpdateTag(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  tagId,
  body,
  log,
) {
  const id = requireTagId(tagId);
  const parsed = parseUpdateTagBody(body);
  const { geoTargetId, languageCode } = parsed;
  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    throw marketNotFound();
  }
  const projectId = row.getSemrushProjectId();
  const snapshot = parsed.parentId !== undefined
    ? await readTagTreeSnapshot(
      transport,
      semrushWorkspaceId,
      projectId,
      log,
      { forceRefresh: true },
    )
    : await readTagTreeSnapshot(transport, semrushWorkspaceId, projectId, log);
  const snapshotTarget = snapshot.byId.get(id);
  const snapshotParent = parsed.parentId ? snapshot.byId.get(parsed.parentId) : null;
  const incompatible = [snapshotTarget, snapshotParent]
    .filter((item) => item?.compatibility?.state === 'readOnly');
  if (incompatible.length > 0) {
    throw incompatibleTaxonomyError(incompatible);
  }
  if (snapshotTarget?.rootName === 'tag') {
    const nextParent = snapshotParent
      ?? (snapshotTarget.parentId ? snapshot.byId.get(snapshotTarget.parentId) : undefined);
    if (!nextParent || nextParent.rootName !== 'tag' || nextParent.depth > 2) {
      throw new ErrorWithStatusCode(
        'plain tags may only be authored at depth 2 or 3 beneath the "tag" root',
        400,
      );
    }
  }
  const target = positionFromSnapshot(snapshotTarget);
  const parent = positionFromSnapshot(snapshotParent ?? snapshotTarget);
  const { name, parentIdToSend } = buildUpdatePayload(parsed, target, id);
  if (parsed.parentId !== undefined) {
    // A re-parent may move a tag within its dimension, never across one — and
    // never under the tag's own subtree, which would strand it outside the tree.
    assertParentPlacement(/** @type {string} */ (target.rootName), parent, id);
  }
  const updated = await transport.updateProjectTag(
    semrushWorkspaceId,
    projectId,
    id,
    { name, parentId: parentIdToSend },
  );
  invalidateTagCacheForProject(semrushWorkspaceId, projectId);
  const { parentId: updatedParentId } = pickTagIds(updated, parentIdToSend);
  log?.info?.('handleUpdateTag: updated tag', {
    brandId, geoTargetId, languageCode, tagId: id, name, parentId: parentIdToSend,
  });
  // Publish so the rename / re-parent is live rather than a draft.
  await republish(transport, semrushWorkspaceId, projectId, log);
  const parentNode = snapshot.byId.get(parentIdToSend);
  return {
    status: 200,
    body: {
      brandId,
      geoTargetId,
      languageCode,
      tagId: id,
      id,
      name,
      parentId: updatedParentId,
      path: parentNode?.fullPath ?? null,
      compatibility: { state: 'canonical', reason: null },
      childrenCount: snapshotTarget?.childrenCount ?? 0,
      promptsCount: snapshotTarget?.promptsCount ?? 0,
    },
  };
}

/**
 * PATCH /serenity/tags/:tagId (subworkspace mode) -- the market's project is
 * resolved live from the brand's own subworkspace listing (same resolution as
 * handleCreateTagSubworkspace). See {@link handleUpdateTag} for the
 * child-target resolution / bare-name / parent_id-echo rules this shares.
 *
 * @param {SerenityTransport} transport
 * @param {string} workspaceId - the brand's subworkspace id.
 * @param {string} tagId - upstream tag id to update.
 * @param {object} body - request body ({ name, parentId?, geoTargetId, languageCode }).
 * @param {object} log - logger.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleUpdateTagSubworkspace(
  transport,
  workspaceId,
  tagId,
  body,
  log,
) {
  const id = requireTagId(tagId);
  const parsed = parseUpdateTagBody(body);
  const { geoTargetId, languageCode } = parsed;
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    throw marketNotFound();
  }
  const projectId = String(project.id);
  const snapshot = parsed.parentId !== undefined
    ? await readTagTreeSnapshot(
      transport,
      workspaceId,
      projectId,
      log,
      { forceRefresh: true },
    )
    : await readTagTreeSnapshot(transport, workspaceId, projectId, log);
  const snapshotTarget = snapshot.byId.get(id);
  const snapshotParent = parsed.parentId ? snapshot.byId.get(parsed.parentId) : null;
  const incompatible = [snapshotTarget, snapshotParent]
    .filter((item) => item?.compatibility?.state === 'readOnly');
  if (incompatible.length > 0) {
    throw incompatibleTaxonomyError(incompatible);
  }
  if (snapshotTarget?.rootName === 'tag') {
    const nextParent = snapshotParent
      ?? (snapshotTarget.parentId ? snapshot.byId.get(snapshotTarget.parentId) : undefined);
    if (!nextParent || nextParent.rootName !== 'tag' || nextParent.depth > 2) {
      throw new ErrorWithStatusCode(
        'plain tags may only be authored at depth 2 or 3 beneath the "tag" root',
        400,
      );
    }
  }
  const target = positionFromSnapshot(snapshotTarget);
  const parent = positionFromSnapshot(snapshotParent ?? snapshotTarget);
  const { name, parentIdToSend } = buildUpdatePayload(parsed, target, id);
  if (parsed.parentId !== undefined) {
    // A re-parent may move a tag within its dimension, never across one — and
    // never under the tag's own subtree, which would strand it outside the tree.
    assertParentPlacement(/** @type {string} */ (target.rootName), parent, id);
  }
  const updated = await transport.updateProjectTag(
    workspaceId,
    projectId,
    id,
    { name, parentId: parentIdToSend },
  );
  invalidateTagCacheForProject(workspaceId, projectId);
  const { parentId: updatedParentId } = pickTagIds(updated, parentIdToSend);
  log?.info?.('handleUpdateTagSubworkspace: updated tag', {
    geoTargetId, languageCode, tagId: id, name, parentId: parentIdToSend,
  });
  // Publish so the rename / re-parent is live rather than a draft.
  await republish(transport, workspaceId, projectId, log);
  const parentNode = snapshot.byId.get(parentIdToSend);
  return {
    status: 200,
    body: {
      geoTargetId,
      languageCode,
      tagId: id,
      id,
      name,
      parentId: updatedParentId,
      path: parentNode?.fullPath ?? null,
      compatibility: { state: 'canonical', reason: null },
      childrenCount: snapshotTarget?.childrenCount ?? 0,
      promptsCount: snapshotTarget?.promptsCount ?? 0,
    },
  };
}

/**
 * Validates the DELETE query's `(geoTargetId, languageCode)` market slice.
 * Shared by both handler families -- there is no body on a DELETE, so the
 * slice travels as query params, same convention as the other slice-scoped
 * GETs (e.g. handleListTags).
 *
 * @param {object} query - the raw query params.
 * @returns {{ geoTargetId: number, languageCode: string }}
 */
function requireSliceQuery(query) {
  const geoTargetId = normalizeGeoTargetId(Number(query?.geoTargetId));
  if (geoTargetId === null) {
    throw new ErrorWithStatusCode('geoTargetId must be a positive integer', 400);
  }
  const languageCode = normalizeLanguageCode(query?.languageCode);
  if (languageCode === null) {
    throw new ErrorWithStatusCode(
      'languageCode must match ^[a-z]{2,3}(-[a-z]{2,4})?$',
      400,
    );
  }
  return { geoTargetId, languageCode };
}

/**
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string[]} subtreeIds
 * @returns {Promise<string[]>}
 */
async function listAffectedPromptIds(
  transport,
  semrushWorkspaceId,
  projectId,
  subtreeIds,
) {
  const affected = new Set();
  let page = 1;
  const limit = 200;
  const maxPages = 100;
  const subtree = new Set(subtreeIds);
  while (page <= maxPages) {
    // eslint-disable-next-line no-await-in-loop
    const response = await transport.listPromptsByTags(semrushWorkspaceId, projectId, {
      tag_ids: [],
      page,
      limit,
    });
    const prompts = Array.isArray(response?.items) ? response.items : [];
    for (const prompt of prompts) {
      const hasAffectedTag = (Array.isArray(prompt?.tags) ? prompt.tags : [])
        .some((tag) => subtree.has(typeof tag === 'string' ? tag : String(tag?.id ?? '')));
      if (hasAffectedTag && prompt?.id != null) {
        affected.add(String(prompt.id));
      }
    }
    if (prompts.length < limit) {
      return [...affected].sort();
    }
    page += 1;
  }
  const error = new ErrorWithStatusCode('Unable to establish complete tag impact', 503);
  error.code = ERROR_CODES.IMPACT_UNAVAILABLE;
  throw error;
}

/**
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} tagId
 * @param {object} [log]
 * @returns {Promise<{
 *   tagId: string,
 *   name: string,
 *   path: Array<{ id: string, name: string }>,
 *   descendantCount: number,
 *   affectedPromptCount: number,
 *   complete: true,
 *   revision: string,
 *   deletedIds: string[],
 * }>}
 */
export async function buildTagImpact(transport, semrushWorkspaceId, projectId, tagId, log) {
  const snapshot = await readTagTreeSnapshot(
    transport,
    semrushWorkspaceId,
    projectId,
    log,
  );
  const target = snapshot.byId.get(tagId);
  if (!target) {
    const error = new ErrorWithStatusCode('No tag with this id on this market', 404);
    error.code = ERROR_CODES.TAG_NOT_FOUND;
    throw error;
  }
  if (target.depth === 1) {
    throw new ErrorWithStatusCode(
      `a dimension root (${ALL_DIMENSIONS.join(', ')}) cannot be inspected for deletion`,
      400,
    );
  }
  const dimension = dimensionOfRootName(target.rootName);
  if (isServerOwnedDimension(dimension)) {
    throw new ErrorWithStatusCode(
      `a value of the server-owned "${dimension}" dimension cannot be deleted`,
      400,
    );
  }
  if (target.compatibility?.state === 'readOnly') {
    throw incompatibleTaxonomyError([target]);
  }
  const subtree = snapshot.items.filter((item) => (
    item.id === tagId || item.fullPath.some((part) => part.id === tagId)
  ));
  const subtreeIds = subtree.map((item) => item.id);
  const affectedPromptIds = await listAffectedPromptIds(
    transport,
    semrushWorkspaceId,
    projectId,
    subtreeIds,
  );
  const canonical = JSON.stringify({
    projectId,
    tagId,
    nodes: subtree
      .map((item) => ({
        id: item.id,
        parentId: item.parentId,
        name: item.name,
        rootFirstPath: item.fullPath.map((part) => ({ id: part.id, name: part.name })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    affectedPromptIds,
  });
  const revision = `"${createHash('sha256').update(canonical).digest('base64url')}"`;
  return {
    tagId,
    name: target.name,
    path: target.fullPath,
    descendantCount: subtree.length - 1,
    affectedPromptCount: affectedPromptIds.length,
    complete: true,
    revision,
    deletedIds: subtreeIds,
  };
}

/**
 * Deletes a tag and its whole subtree in one upstream batch call. It refuses
 * dimension roots, server-owned values, and unknown tags before collecting the
 * descendant ids, then publishes the resulting draft mutation. When supplied,
 * `ifMatch` must match a complete impact snapshot to prevent deleting a
 * subtree that changed after the caller inspected it.
 *
 * @param {SerenityTransport} transport
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} tagId - the delete target's id.
 * @param {object} [log] - logger.
 * @param {string} [ifMatch] - expected tag-impact revision.
 * @returns {Promise<{ deletedIds: string[] }>}
 */
async function deleteResolvedTag(
  transport,
  semrushWorkspaceId,
  projectId,
  tagId,
  log,
  ifMatch,
) {
  // Two reads, not one redundant one: findTagsInTree resolves THIS id's own
  // position/kind (root? server-owned? unknown?), while collectSubtreeIds below
  // walks its DESCENDANTS. Neither can answer the other's question.
  const found = await findTagsInTree(transport, semrushWorkspaceId, projectId, [tagId], log);
  const target = found.get(tagId);
  if (!target || target.kind === 'unknown') {
    const err = new ErrorWithStatusCode('No tag with this id on this market', 404);
    err.code = ERROR_CODES.TAG_NOT_FOUND;
    throw err;
  }
  if (target.kind === 'root') {
    throw new ErrorWithStatusCode(
      `a dimension root (${ALL_DIMENSIONS.join(', ')}) cannot be deleted`,
      400,
    );
  }
  if (isServerOwnedDimension(/** @type {string} */ (target.rootName))) {
    throw new ErrorWithStatusCode(
      `a value of the server-owned "${target.rootName}" dimension cannot be deleted`,
      400,
    );
  }
  let deletedIds;
  if (ifMatch) {
    const impact = await buildTagImpact(
      transport,
      semrushWorkspaceId,
      projectId,
      tagId,
      log,
    );
    if (ifMatch !== impact.revision) {
      const error = new ErrorWithStatusCode('Tag impact changed; refresh before deleting', 412);
      error.code = ERROR_CODES.IMPACT_STALE;
      throw error;
    }
    deletedIds = impact.deletedIds;
  } else {
    deletedIds = await collectSubtreeIds(
      transport,
      semrushWorkspaceId,
      projectId,
      tagId,
      log,
    );
  }
  await transport.deleteProjectTags(semrushWorkspaceId, projectId, deletedIds);
  invalidateTagCacheForProject(semrushWorkspaceId, projectId);
  await republish(transport, semrushWorkspaceId, projectId, log);
  return { deletedIds };
}

/**
 * DELETE /serenity/tags/:tagId (flat mode) -- delete a category (or
 * sub-category) and its whole subtree, preserving every carrying prompt
 * (category-delete.md). The market's project id comes from the persisted
 * `BrandSemrushProject` mapping, same resolution as handleUpdateTag.
 *
 * @param {SerenityTransport} transport
 * @param {object} dataAccess - data-access layer (BrandSemrushProject).
 * @param {string} brandId - brand UUID.
 * @param {string} semrushWorkspaceId - the org's (parent) workspace id.
 * @param {string} tagId - upstream tag id to delete.
 * @param {object} query - query params ({ geoTargetId, languageCode }).
 * @param {object} log - logger.
 * @returns {Promise<{status: number, deletedIds: string[]}>} deletedIds is unread by
 *   the controller (which always returns 204 with no body) — kept for the log line above
 *   and for test introspection, not a consumed contract.
 */
export async function handleDeleteTag(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  tagId,
  query,
  log,
  ifMatch,
) {
  const id = requireTagId(tagId);
  const { geoTargetId, languageCode } = requireSliceQuery(query);
  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    throw marketNotFound();
  }
  const projectId = row.getSemrushProjectId();
  const { deletedIds } = await deleteResolvedTag(
    transport,
    semrushWorkspaceId,
    projectId,
    id,
    log,
    ifMatch,
  );
  log?.info?.('handleDeleteTag: deleted tag subtree', {
    brandId, geoTargetId, languageCode, tagId: id, deletedIds,
  });
  return { status: 204, deletedIds };
}

/**
 * DELETE /serenity/tags/:tagId (subworkspace mode) -- the market's project is
 * resolved live from the brand's own subworkspace listing, same resolution as
 * handleUpdateTagSubworkspace. See {@link handleDeleteTag} for the delete
 * semantics this shares.
 *
 * @param {SerenityTransport} transport
 * @param {string} workspaceId - the brand's subworkspace id.
 * @param {string} tagId - upstream tag id to delete.
 * @param {object} query - query params ({ geoTargetId, languageCode }).
 * @param {object} log - logger.
 * @returns {Promise<{status: number, deletedIds: string[]}>} deletedIds is unread by
 *   the controller (which always returns 204 with no body) — kept for the log line above
 *   and for test introspection, not a consumed contract.
 */
export async function handleDeleteTagSubworkspace(
  transport,
  workspaceId,
  tagId,
  query,
  log,
  ifMatch,
) {
  const id = requireTagId(tagId);
  const { geoTargetId, languageCode } = requireSliceQuery(query);
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    throw marketNotFound();
  }
  const projectId = String(project.id);
  const { deletedIds } = await deleteResolvedTag(
    transport,
    workspaceId,
    projectId,
    id,
    log,
    ifMatch,
  );
  log?.info?.('handleDeleteTagSubworkspace: deleted tag subtree', {
    geoTargetId, languageCode, tagId: id, deletedIds,
  });
  return { status: 204, deletedIds };
}

/**
 * Resolves a flat-mode market and returns its complete tag-delete impact
 * snapshot without exposing the internal `deletedIds` bookkeeping field.
 *
 * @param {SerenityTransport} transport
 * @param {object} dataAccess
 * @param {string} brandId
 * @param {string} semrushWorkspaceId
 * @param {string} tagId
 * @param {object} query
 * @param {object} [log]
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleTagImpact(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  tagId,
  query,
  log,
) {
  const id = requireTagId(tagId);
  const { geoTargetId, languageCode } = requireSliceQuery(query);
  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    throw marketNotFound();
  }
  const impact = await buildTagImpact(
    transport,
    semrushWorkspaceId,
    row.getSemrushProjectId(),
    id,
    log,
  );
  const { deletedIds: _, ...body } = impact;
  return { status: 200, body };
}

/**
 * Resolves a subworkspace-mode market and returns its complete tag-delete
 * impact snapshot without exposing the internal `deletedIds` bookkeeping field.
 *
 * @param {SerenityTransport} transport
 * @param {string} workspaceId
 * @param {string} tagId
 * @param {object} query
 * @param {object} [log]
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleTagImpactSubworkspace(
  transport,
  workspaceId,
  tagId,
  query,
  log,
) {
  const id = requireTagId(tagId);
  const { geoTargetId, languageCode } = requireSliceQuery(query);
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    throw marketNotFound();
  }
  const impact = await buildTagImpact(
    transport,
    workspaceId,
    String(project.id),
    id,
    log,
  );
  const { deletedIds: _, ...body } = impact;
  return { status: 200, body };
}
