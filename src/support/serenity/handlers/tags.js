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

import { hasText } from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode } from '../../utils.js';
import { ERROR_CODES } from '../errors.js';
import {
  normalizeGeoTargetId, normalizeLanguageCode, MAX_TAG_ID_LEN, isValidTagIdFormat,
} from '../validation.js';
import { resolveProject } from '../subworkspace-projects.js';
import {
  ALL_DIMENSIONS, CLOSED_DIMENSIONS,
  isClosedDimension, closedValuesOf, isDimensionRootName,
} from '../prompt-tags.js';
import { ensureClosedValue, ensureDimensionRoots } from '../tag-tree.js';
import { listProjectTagTree } from './markets.js';

/**
 * POST /serenity/tags — create a prompt TAG on a single market.
 *
 * Every tag is BARE-NAMED and lives under one of the four dimension roots
 * (`category`, `intent`, `source`, `type`) on a market's project — the
 * `aio/tags` surface, via {@link createProjectTags}. A tag's dimension is its
 * root ancestor, never a prefix on its name, so `type` in the request body
 * names the dimension the value belongs to rather than something written into
 * the name.
 *
 * The three CLOSED dimensions (`intent` / `source` / `type`) have a fixed value
 * enum: `name` must be one of those values, no `parentId` is accepted (their
 * values are always direct children of the dimension root), and the create is
 * resolve-or-create — a small, project-wide-shared set every caller may need
 * the id of. The one OPEN dimension (`category`) carries customer-authored
 * values: a category hangs under the `category` root, a sub-category under a
 * category (via `parentId`). The UI's "Categories" view is the `category`
 * root's subtree across the brand's markets.
 *
 * Both the flat-mode and subworkspace-mode handlers resolve the market's project
 * id from the `(geoTargetId, languageCode)` slice and register one tag.
 */

const MAX_TAG_NAME_LEN = 100;
// Bounds resolveTagTarget's per-root fan-out for an unresolvable tagId — well
// above any real project's root-category count, just a ceiling on amplification.
const MAX_ROOTS_TO_SEARCH = 100;

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
 * is reserved for the four dimension roots, so promoting a tag to a root is never
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
 * the tag the new one nests under; it is only legal for the OPEN dimension,
 * since a closed dimension's values are always direct children of its root.
 * `isClosed` is true for the dimensions in {@link CLOSED_DIMENSIONS}, whose
 * `name` must be one of that dimension's fixed values ({@link closedValuesOf}).
 *
 * @param {object} body - request body.
 * @returns {{
 *   type: string, name: string, geoTargetId: number,
 *   languageCode: string, parentId: string | undefined, isClosed: boolean,
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
  // The root level holds exactly the four dimension roots. A value may not
  // shadow one of their names, or the tree would have two tags a reader cannot
  // tell apart by name at the level that matters.
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
  if (isClosed && parentId !== undefined) {
    throw new ErrorWithStatusCode(
      `parentId is not allowed for a closed dimension (${CLOSED_DIMENSIONS.join(', ')}): `
      + 'its values are always direct children of the dimension root',
      400,
    );
  }
  return {
    type, name: rawName, geoTargetId, languageCode, parentId, isClosed,
  };
}

/**
 * Picks the created/updated tag's upstream id + parent id out of the transport
 * result. `createProjectTags` resolves to a LIST (model.TreeNodeResponse[]);
 * `updateProjectTag` to a single object. Returns `{ id, parentId }` with
 * `parentId` falling back to the requested `parentId` (so the echo is stable even
 * if the upstream omits it), or null.
 *
 * @param {any} result - transport result (array for create, object for update).
 * @param {string | null | undefined} requestedParentId
 * @returns {{ id: string | undefined, parentId: string | null }}
 */
function pickTagIds(result, requestedParentId) {
  const node = Array.isArray(result) ? result[0] : result;
  const id = node && typeof node.id === 'string' ? node.id : undefined;
  const parentId = node && typeof node.parent_id === 'string' && node.parent_id
    ? node.parent_id
    : (requestedParentId ?? null);
  return { id, parentId };
}

/**
 * The id of an OPEN dimension's root tag, provisioning the four dimension roots
 * if the project predates them. An open-dimension create with no `parentId`
 * hangs the new value directly under this root.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} dimension - an open dimension (`category`).
 * @param {object} [log] - logger.
 * @returns {Promise<string>}
 */
async function resolveOpenRootId(transport, semrushWorkspaceId, projectId, dimension, log) {
  const roots = await ensureDimensionRoots(transport, semrushWorkspaceId, projectId, log);
  const rootId = roots.get(dimension);
  if (!rootId) {
    throw new ErrorWithStatusCode(`could not resolve the "${dimension}" dimension root`, 502);
  }
  return rootId;
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
 * @param {object} transport - Serenity transport (Semrush proxy client).
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
    type, name, geoTargetId, languageCode, parentId, isClosed,
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

  if (isClosed) {
    const { id, rootId, created } = await ensureClosedValue(
      transport,
      semrushWorkspaceId,
      projectId,
      type,
      name,
      log,
    );
    log?.info?.('handleCreateTag: resolved closed-dimension value', {
      brandId, geoTargetId, languageCode, type, name, created,
    });
    return {
      status: 200,
      body: {
        brandId, geoTargetId, languageCode, type, name, id, parentId: rootId ?? null, created,
      },
    };
  }

  // An open-dimension value is always a DESCENDANT of its dimension root: a
  // customer category hangs off the `category` root, a sub-category off a
  // category. An omitted parentId therefore means "directly under the root",
  // not "at the root level".
  const targetParentId = parentId ?? await resolveOpenRootId(
    transport,
    semrushWorkspaceId,
    projectId,
    type,
    log,
  );
  const created = await transport.createProjectTags(
    semrushWorkspaceId,
    projectId,
    [name],
    { parentId: targetParentId },
  );
  const { id, parentId: createdParentId } = pickTagIds(created, targetParentId);
  log?.info?.('handleCreateTag: registered tag', {
    brandId, geoTargetId, languageCode, name, parentId: targetParentId,
  });
  return {
    status: 201,
    body: {
      brandId, geoTargetId, languageCode, type, name, id, parentId: createdParentId,
    },
  };
}

/**
 * Subworkspace mode — the market's project is resolved live from the brand's
 * own subworkspace listing (same resolution as handleListTagsSubworkspace).
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
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
    type, name, geoTargetId, languageCode, parentId, isClosed,
  } = parseCreateTagBody(body);
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    throw marketNotFound();
  }
  const projectId = String(project.id);

  if (isClosed) {
    const { id, rootId, created } = await ensureClosedValue(
      transport,
      workspaceId,
      projectId,
      type,
      name,
      log,
    );
    log?.info?.('handleCreateTagSubworkspace: resolved closed-dimension value', {
      geoTargetId, languageCode, type, name, created,
    });
    return {
      status: 200,
      body: {
        geoTargetId, languageCode, type, name, id, parentId: rootId ?? null, created,
      },
    };
  }

  const targetParentId = parentId ?? await resolveOpenRootId(
    transport,
    workspaceId,
    projectId,
    type,
    log,
  );
  const created = await transport.createProjectTags(
    workspaceId,
    projectId,
    [name],
    { parentId: targetParentId },
  );
  const { id, parentId: createdParentId } = pickTagIds(created, targetParentId);
  log?.info?.('handleCreateTagSubworkspace: registered tag', {
    geoTargetId, languageCode, name, parentId: targetParentId,
  });
  return {
    status: 201,
    body: {
      geoTargetId, languageCode, type, name, id, parentId: createdParentId,
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
 * Resolves whether `tagId` is currently a ROOT or a CHILD in the project's
 * standalone AIO tag tree, and -- when a child -- its current parent id. There
 * is no upstream "get tag by id" endpoint, so this walks the draft tree: the
 * roots first, then (if not found there) each root's children in turn until
 * `tagId` is found. Bounded by the project's root-category count (O(1 +
 * numRoots) upstream calls) -- acceptable for an admin-frequency rename/
 * re-parent action, not a hot path. Roots with no children are skipped (their
 * `childrenCount` is 0, so a child lookup can never match), and the walk is
 * capped at {@link MAX_ROOTS_TO_SEARCH} roots so a bogus `tagId` against a
 * project with many root categories can't fan out unboundedly.
 *
 * Exists to close a live-verified gap (serenity-docs#24 section 3.1 gate 5,
 * probed 2026-07-02): PATCHing a child with `parent_id` omitted from the
 * upstream body silently PROMOTES it to root -- omission is only safe when the
 * target is already a root. Every PATCH to a child must therefore explicitly
 * re-send its current `parent_id`, even when only the name is changing (see
 * {@link buildUpdatePayload}).
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} tagId - the PATCH target's upstream id.
 * @param {object} [log] - logger.
 * @returns {Promise<{ kind: 'root' | 'descendant' | 'unknown', parentId: string | null }>}
 */
async function resolveTagTarget(transport, semrushWorkspaceId, projectId, tagId, log) {
  const roots = await listProjectTagTree(transport, semrushWorkspaceId, projectId, '', log);
  if (roots.items.some((t) => t.id === tagId)) {
    return { kind: 'root', parentId: null };
  }
  const candidates = roots.items
    .filter((root) => root.childrenCount > 0)
    .slice(0, MAX_ROOTS_TO_SEARCH);
  // Walk the tree breadth-first, one level at a time. A customer category sits at
  // depth 2 and a sub-category at depth 3, so a single children lookup per root is
  // not enough; each level's children with descendants of their own are queued.
  let frontier = candidates;
  while (frontier.length > 0) {
    const next = [];
    for (const node of frontier) {
      // Sequential by design: stop at the first node whose children contain the
      // target, rather than fanning out every node's children concurrently for
      // what is expected to resolve within the first few in practice.
      // eslint-disable-next-line no-await-in-loop
      const children = await listProjectTagTree(
        transport,
        semrushWorkspaceId,
        projectId,
        node.id,
        log,
      );
      const found = children.items.find((t) => t.id === tagId);
      if (found) {
        return { kind: 'descendant', parentId: found.parentId ?? node.id };
      }
      next.push(...children.items.filter((t) => t.childrenCount > 0));
    }
    frontier = next.slice(0, MAX_ROOTS_TO_SEARCH);
  }
  return { kind: 'unknown', parentId: null };
}

/**
 * Decides what to forward upstream for a PATCH, given the target's resolved tree
 * position (see {@link resolveTagTarget}).
 *
 * The outgoing body ALWAYS carries an explicit `parent_id`: an upstream PATCH
 * that omits it PROMOTES the tag to a root (verified live). So a rename-only
 * PATCH re-sends the target's own current parent, and a re-parent sends the
 * requested one.
 *
 * A DIMENSION ROOT is not editable — the root level is reserved for the four
 * roots, and renaming or moving one would leave its whole subtree without a
 * dimension. An UNRESOLVABLE id is refused rather than forwarded: without
 * knowing the target's current parent there is no body that preserves it, and
 * guessing would promote the tag.
 *
 * @param {{ value: string, parentId: string | undefined }} parsed
 * @param {{ kind: 'root' | 'descendant' | 'unknown', parentId: string | null }} target
 * @returns {{ name: string, parentIdToSend: string }}
 */
function buildUpdatePayload(parsed, target) {
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
  // resolveTagTarget's descendant branch always resolves a parent (falling back
  // to the node it was found under), so this is never null.
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
 * @param {object} transport - Serenity transport (Semrush proxy client).
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
  const target = await resolveTagTarget(transport, semrushWorkspaceId, projectId, id, log);
  const { name, parentIdToSend } = buildUpdatePayload(parsed, target);
  const updated = await transport.updateProjectTag(
    semrushWorkspaceId,
    projectId,
    id,
    { name, parentId: parentIdToSend },
  );
  const { parentId: updatedParentId } = pickTagIds(updated, parentIdToSend);
  log?.info?.('handleUpdateTag: updated tag', {
    brandId, geoTargetId, languageCode, tagId: id, name, parentId: parentIdToSend,
  });
  return {
    status: 200,
    body: {
      brandId, geoTargetId, languageCode, tagId: id, name, parentId: updatedParentId,
    },
  };
}

/**
 * PATCH /serenity/tags/:tagId (subworkspace mode) -- the market's project is
 * resolved live from the brand's own subworkspace listing (same resolution as
 * handleCreateTagSubworkspace). See {@link handleUpdateTag} for the
 * child-target resolution / bare-name / parent_id-echo rules this shares.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
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
  const target = await resolveTagTarget(transport, workspaceId, projectId, id, log);
  const { name, parentIdToSend } = buildUpdatePayload(parsed, target);
  const updated = await transport.updateProjectTag(
    workspaceId,
    projectId,
    id,
    { name, parentId: parentIdToSend },
  );
  const { parentId: updatedParentId } = pickTagIds(updated, parentIdToSend);
  log?.info?.('handleUpdateTagSubworkspace: updated tag', {
    geoTargetId, languageCode, tagId: id, name, parentId: parentIdToSend,
  });
  return {
    status: 200,
    body: {
      geoTargetId, languageCode, tagId: id, name, parentId: updatedParentId,
    },
  };
}
