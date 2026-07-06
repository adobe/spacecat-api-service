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
  tagFor, TAG_DIMENSION, CREATABLE_TAG_DIMENSIONS, CLOSED_TAG_DIMENSIONS, PROJECT_STANDARD_TAGS,
} from '../prompt-tags.js';
import { listProjectTagTree } from './markets.js';

/**
 * POST /serenity/tags — create a prompt TAG on a single market.
 *
 * A ROOT tag is a `dimension:<NAME>` string registered on a market's project
 * (the `aio/tags` surface, via {@link createProjectTags}) under one of the
 * OPEN dimensions ({@link CREATABLE_TAG_DIMENSIONS} — `category` / `topic`);
 * the closed taxonomies (`source` / `intent` / `type`) have a fixed value enum
 * and are not freely creatable, so the `type` is validated against the
 * allow-list (this is what bounds the allowed prefixes). A CHILD tag (created
 * with `parentId`, 1-level nesting) is BARE — no dimension prefix — matching
 * the migration CLI's write shape (serenity-docs#24 §2). The UI's
 * "Categories" view is the `category:` slice of these root tags, plus their
 * bare children, across the brand's markets.
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
 * Validates the UPDATE body's `parentId`, preserving the distinction between
 * omitted (`undefined` -- leave the current parent alone) and an explicit JSON
 * `null` (promote a child to root -- serenity-docs#24 section 3.1 gate 1,
 * verified live 2026-07-02: an explicit `parent_id: null` in the upstream
 * PATCH body promotes a child; omitting the field entirely does not, and an
 * empty string is also a live no-op). {@link parseParentId} (used by create)
 * deliberately collapses omitted/null/empty to "no parent" because create has
 * no current parent to preserve -- that collapse would be wrong here.
 *
 * @param {object} body - the raw request body.
 * @returns {string | null | undefined}
 */
function parseUpdateParentId(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'parentId')) {
    return undefined;
  }
  const raw = body.parentId;
  if (raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new ErrorWithStatusCode('parentId must be a string or null', 400);
  }
  const id = raw.trim();
  if (!id) {
    // An explicit empty string carries no live-verified meaning of its own
    // (gate 1: it's a no-op, distinct from `null`) -- treat it as omission.
    return undefined;
  }
  validateParentIdFormat(id);
  return id;
}

/**
 * Validates + normalizes the create-tag body, throwing a 400
 * {@link ErrorWithStatusCode} on the first problem. Returns the parsed
 * `{ type, name, geoTargetId, languageCode, parentId, isClosed }`. `parentId`
 * (optional) is an upstream tag id under which the new tag is nested (1-level
 * category tree) -- only legal for an OPEN dimension. `isClosed` is true when
 * `type` is one of {@link CLOSED_TAG_DIMENSIONS} (`source`/`intent`/`type`):
 * the `name` must then be one of that dimension's fixed enum values (checked
 * against {@link PROJECT_STANDARD_TAGS}) and no `parentId` may be present --
 * closed-dimension tags are always roots. The handler resolves-or-creates a
 * closed-dimension tag (idempotent) rather than blind-creating it (see
 * {@link handleCreateTag}) since it is a small, project-wide-shared set of
 * values every caller may need the id of, unlike an OPEN dimension's
 * customer-authored, resolve-before-create-by-the-caller names (gate 7).
 *
 * @param {object} body - request body.
 * @returns {{
 *   type: string, name: string, geoTargetId: number,
 *   languageCode: string, parentId: string | undefined, isClosed: boolean,
 * }}
 */
function parseCreateTagBody(body) {
  const type = hasText(body?.type) ? String(body.type).trim().toLowerCase() : '';
  // Both tuples are frozen literal tuples; widen to string[] so `.includes(type)`
  // accepts an arbitrary runtime string for the membership test.
  const openDimensions = /** @type {readonly string[]} */ (CREATABLE_TAG_DIMENSIONS);
  const closedDimensions = /** @type {readonly string[]} */ (CLOSED_TAG_DIMENSIONS);
  const isClosed = closedDimensions.includes(type);
  if (!isClosed && !openDimensions.includes(type)) {
    throw new ErrorWithStatusCode(
      `type must be one of: ${[...CREATABLE_TAG_DIMENSIONS, ...CLOSED_TAG_DIMENSIONS].join(', ')}`,
      400,
    );
  }
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
  // The `<type>:` prefix is added by tagFor(); a `:` in the name would either
  // double-prefix or smuggle a different dimension (e.g. type=category,
  // name='topic:x' → 'category:topic:x'). Reject rather than silently rewrite.
  if (rawName.includes(':')) {
    throw new ErrorWithStatusCode('name must not contain ":"', 400);
  }
  // Reject C0/C1-adjacent control characters (incl. DEL): unprintable chars have
  // no legitimate place in a customer-authored tag value and cause UI + upstream
  // confusion. Zero-width joiners (U+200C/U+200D) are intentionally NOT banned —
  // they are legitimate in some scripts and emoji sequences.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(rawName)) {
    throw new ErrorWithStatusCode('name must not contain control characters', 400);
  }
  if (isClosed
    && !(/** @type {readonly string[]} */ (PROJECT_STANDARD_TAGS)).includes(`${type}:${rawName}`)) {
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
      `parentId is not allowed for a closed dimension (${CLOSED_TAG_DIMENSIONS.join(', ')})`,
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
 * Resolves a closed-dimension tag's upstream id, creating it only if the
 * project doesn't already have it. Unlike an OPEN-dimension create (gate 7:
 * a duplicate name is a hard 500, resolve-before-create is the CALLER's job),
 * a closed-dimension tag is a small, fixed, project-wide-shared value that
 * many independent callers legitimately need the id of -- so the proxy itself
 * does the resolve-before-create, making POST /serenity/tags idempotent for
 * these specific values. Searches the ROOTS level only (closed dims are never
 * nested).
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} tag - the full `<dimension>:<value>` wire name.
 * @param {object} [log] - logger.
 * @returns {Promise<{ id: string | undefined, created: boolean }>}
 */
async function resolveOrCreateClosedTag(transport, semrushWorkspaceId, projectId, tag, log) {
  // Closed tags are seeded at project creation and will almost always be on
  // page 1; stop paginating as soon as a match is found instead of always
  // walking the full root tag list.
  const roots = await listProjectTagTree(
    transport,
    semrushWorkspaceId,
    projectId,
    '',
    log,
    (t) => t.name === tag,
  );
  const existing = roots.items.find((t) => t.name === tag);
  if (existing) {
    return { id: existing.id, created: false };
  }
  const createdList = await transport.createProjectTags(semrushWorkspaceId, projectId, [tag]);
  const { id } = pickTagIds(createdList, undefined);
  return { id, created: true };
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
 * Also returns the target's current NAME, DIMENSION, and (for a root) its
 * childrenCount, so callers can validate a rename/re-parent doesn't cross
 * dimensions and can block demoting a populated root without re-reading the
 * tree. A child's dimension is its ROOT ancestor's dimension (a child's own
 * name is bare), falling back to the root being drilled when the child listing
 * omits it.
 *
 * NOTE: `childrenCount` is only meaningful for `kind: 'root'`. For `'child'` it
 * reflects the child's own listing (typically 0), and for `'unknown'` it is a
 * placeholder `0` meaning "no data", NOT a verified zero — never treat an
 * `unknown` result's `childrenCount` as authoritative.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} tagId - the PATCH target's upstream id.
 * @param {object} [log] - logger.
 * @returns {Promise<{
 *   kind: 'root' | 'child' | 'unknown', parentId: string | null,
 *   name: string | undefined, dimension: string | undefined, childrenCount: number,
 * }>}
 */
async function resolveTagTarget(transport, semrushWorkspaceId, projectId, tagId, log) {
  const roots = await listProjectTagTree(transport, semrushWorkspaceId, projectId, '', log);
  const rootMatch = roots.items.find((t) => t.id === tagId);
  if (rootMatch) {
    return {
      kind: 'root',
      parentId: null,
      name: rootMatch.name,
      dimension: rootMatch.dimension,
      childrenCount: rootMatch.childrenCount,
    };
  }
  const candidates = roots.items.filter((root) => root.childrenCount > 0);
  const searched = candidates.slice(0, MAX_ROOTS_TO_SEARCH);
  for (const root of searched) {
    // Sequential by design: stop at the first root whose children contain the
    // target, rather than fanning out every root's children concurrently for
    // what is expected to resolve within the first few roots in practice.
    // eslint-disable-next-line no-await-in-loop
    const children = await listProjectTagTree(
      transport,
      semrushWorkspaceId,
      projectId,
      root.id,
      log,
    );
    const found = children.items.find((t) => t.id === tagId);
    if (found) {
      return {
        kind: 'child',
        parentId: found.parentId ?? root.id,
        name: found.name,
        dimension: found.dimension ?? root.dimension,
        childrenCount: found.childrenCount,
      };
    }
  }
  return {
    kind: 'unknown', parentId: null, name: undefined, dimension: undefined, childrenCount: 0,
  };
}

/**
 * Structural validation of a caller-supplied `parentId` for a create-with-parent
 * or a re-parent — root-ness and dimension match. Independent of the still-open
 * live-probe question of whether Semrush keys child tag ids by (parent_id, name)
 * or by name alone (serenity-docs#26 §9 G1); the overall parent/child model's
 * soundness depends on that being confirmed, but these structural checks hold
 * regardless. Resolves `parentId` via {@link resolveTagTarget} and rejects with
 * a 400 when the target is not a root, or when the root's dimension does not
 * match `childDimension` (a child must live under a same-dimension root — a
 * `tag:` child cannot nest under a `category:` root, and vice-versa).
 *
 * NOTE: this adds real validation to the create-with-parent path for EVERY open
 * dimension (category included), not just `tag:` — today's parented create
 * forwards `parentId` blindly to the transport with no root-ness check.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} parentId - the requested parent tag id.
 * @param {string} childDimension - the dimension the child will belong to.
 * @param {object} [log] - logger.
 * @returns {Promise<void>}
 */
async function assertValidParent(
  transport,
  semrushWorkspaceId,
  projectId,
  parentId,
  childDimension,
  log,
) {
  const parent = await resolveTagTarget(transport, semrushWorkspaceId, projectId, parentId, log);
  if (parent.kind !== 'root') {
    throw new ErrorWithStatusCode(
      'parentId must reference an existing root tag (one-level nesting only)',
      400,
    );
  }
  if (parent.dimension !== childDimension) {
    throw new ErrorWithStatusCode(
      `parentId root dimension (${parent.dimension ?? 'unknown'}) does not match the tag's dimension (${childDimension})`,
      400,
    );
  }
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
  const tag = tagFor(type, name);

  if (isClosed) {
    const { id, created } = await resolveOrCreateClosedTag(
      transport,
      semrushWorkspaceId,
      projectId,
      tag,
      log,
    );
    log?.info?.('handleCreateTag: resolved closed-dimension tag', {
      brandId, geoTargetId, languageCode, tag, created,
    });
    return {
      status: 200,
      body: {
        brandId, geoTargetId, languageCode, type, name, tag, id, parentId: null, created,
      },
    };
  }

  // Validate the parent (root-ness + same-dimension) before creating a child.
  // This is new validation for EVERY open dimension, not just `tag:` — today's
  // parented create forwards parentId blindly to the transport.
  if (parentId) {
    await assertValidParent(transport, semrushWorkspaceId, projectId, parentId, type, log);
  }
  // A nested child is created BARE (no dimension prefix) — only a root gets the
  // `<dimension>:<value>` name. See issue 21 §1 / serenity-docs#24 §2.
  const openTag = parentId ? name : tag;
  const created = await transport.createProjectTags(
    semrushWorkspaceId,
    projectId,
    [openTag],
    { parentId },
  );
  const { id, parentId: createdParentId } = pickTagIds(created, parentId);
  log?.info?.('handleCreateTag: registered tag', {
    brandId, geoTargetId, languageCode, tag: openTag, parentId,
  });
  return {
    status: 201,
    body: {
      brandId, geoTargetId, languageCode, type, name, tag: openTag, id, parentId: createdParentId,
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
  const tag = tagFor(type, name);

  if (isClosed) {
    const { id, created } = await resolveOrCreateClosedTag(
      transport,
      workspaceId,
      projectId,
      tag,
      log,
    );
    log?.info?.('handleCreateTagSubworkspace: resolved closed-dimension tag', {
      geoTargetId, languageCode, tag, created,
    });
    return {
      status: 200,
      body: {
        geoTargetId, languageCode, type, name, tag, id, parentId: null, created,
      },
    };
  }

  // Validate the parent (root-ness + same-dimension) before creating a child.
  // This is new validation for EVERY open dimension, not just `tag:` — today's
  // parented create forwards parentId blindly to the transport.
  if (parentId) {
    await assertValidParent(transport, workspaceId, projectId, parentId, type, log);
  }
  // A nested child is created BARE (no dimension prefix) — only a root gets the
  // `<dimension>:<value>` name. See issue 21 §1 / serenity-docs#24 §2.
  const openTag = parentId ? name : tag;
  const created = await transport.createProjectTags(
    workspaceId,
    projectId,
    [openTag],
    { parentId },
  );
  const { id, parentId: createdParentId } = pickTagIds(created, parentId);
  log?.info?.('handleCreateTagSubworkspace: registered tag', {
    geoTargetId, languageCode, tag: openTag, parentId,
  });
  return {
    status: 201,
    body: {
      geoTargetId, languageCode, type, name, tag: openTag, id, parentId: createdParentId,
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
 * the first problem. Deliberately does NOT judge whether a bare (no dimension
 * prefix) name is legal -- that depends on whether the PATCH target is
 * currently a root or a child, which only {@link resolveTagTarget} can answer
 * (it needs transport access this pure parser doesn't have). See
 * {@link buildUpdatePayload} for that cross-check.
 *
 * @param {object} body - request body ({ name, parentId?, geoTargetId, languageCode }).
 * @returns {{
 *   dimension: string, value: string, hasDimensionPrefix: boolean,
 *   parentId: string | null | undefined, geoTargetId: number, languageCode: string,
 * }}
 */
function parseUpdateTagBody(body) {
  const rawName = hasText(body?.name) ? String(body.name).trim() : '';
  if (!rawName) {
    throw new ErrorWithStatusCode('name is required', 400);
  }
  const colon = rawName.indexOf(':');
  const hasDimensionPrefix = colon > 0;
  const dimension = hasDimensionPrefix ? rawName.slice(0, colon).toLowerCase() : '';
  const value = hasDimensionPrefix ? rawName.slice(colon + 1) : rawName;
  if (!value) {
    throw new ErrorWithStatusCode('name must not be empty', 400);
  }
  if (value.length > MAX_TAG_NAME_LEN) {
    throw new ErrorWithStatusCode(
      `name value must not exceed ${MAX_TAG_NAME_LEN} characters`,
      400,
    );
  }
  // At most one ':' -- a second colon would smuggle a nested dimension, whether
  // the target turns out to be a root (one ':' expected) or a child (none).
  if (value.includes(':')) {
    throw new ErrorWithStatusCode('name must contain at most one ":"', 400);
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
    dimension, value, hasDimensionPrefix, parentId, geoTargetId, languageCode,
  };
}

/**
 * Update-side re-parent validation, shared by the flat and subworkspace PATCH
 * handlers. Only fires when the caller supplied a concrete new parent (a
 * non-empty `parentId` string); `null` (promote-to-root) and omission introduce
 * no new parent, so there is nothing structural to validate. Rejects:
 *   - self-parenting (`parentId === tagId`);
 *   - demoting a POPULATED root (a root with children given a non-null parent —
 *     would create an illegal depth-2 tree);
 *   - a non-root or cross-dimension parent (via {@link assertValidParent}).
 *
 * The child's own dimension is resolved from its current root ancestor (its own
 * name is bare — {@link resolveTagTarget} walks to the root); a root being
 * demoted carries the `<dimension>:` prefix in the body, so its dimension comes
 * from the parsed name instead.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} tagId - the tag being updated.
 * @param {{ parentId: string | null | undefined, dimension: string }} parsed
 * @param {{ kind: 'root' | 'child' | 'unknown', dimension: string | undefined,
 *   childrenCount: number }} target
 * @param {object} [log] - logger.
 * @returns {Promise<void>}
 */
async function validateUpdateReparent(
  transport,
  semrushWorkspaceId,
  projectId,
  tagId,
  parsed,
  target,
  log,
) {
  if (typeof parsed.parentId !== 'string' || parsed.parentId === '') {
    return;
  }
  const newParentId = parsed.parentId;
  if (newParentId === tagId) {
    throw new ErrorWithStatusCode('a tag cannot be its own parent', 400);
  }
  if (target.kind === 'root' && target.childrenCount > 0) {
    throw new ErrorWithStatusCode(
      'cannot re-parent a root tag that has children (would create a depth-2 tree)',
      400,
    );
  }
  const childDimension = target.kind === 'child' ? target.dimension : parsed.dimension;
  await assertValidParent(
    transport,
    semrushWorkspaceId,
    projectId,
    newParentId,
    /** @type {string} */ (childDimension),
    log,
  );
}

/**
 * Cross-checks the parsed update body's name shape against the PATCH target's
 * resolved tree position (see {@link resolveTagTarget}), and decides what
 * `parentId` to forward upstream. A root keeps the legacy
 * `<dimension>:<value>` requirement (dimension validated against
 * {@link CREATABLE_TAG_DIMENSIONS}, unchanged); a child takes a bare name
 * (no dimension prefix -- mirrors {@link handleCreateTag}'s create-side rule)
 * and ALWAYS gets an explicit `parentId` in the outgoing PATCH: the caller's
 * requested `parentId` when re-parenting, explicit `null` when PROMOTING to
 * root (gate 1), otherwise the child's own CURRENT parent so a rename-only
 * PATCH never omits it (gate 5). An unresolvable (`unknown`) target falls
 * back to the pre-existing full-name requirement and an omitted `parentId` --
 * the upstream 404 on the `tag_id` path segment is what actually catches a
 * genuinely unknown id, not this validation.
 *
 * @param {{
 *   hasDimensionPrefix: boolean, dimension: string, value: string,
 *   parentId: string | null | undefined,
 * }} parsed
 * @param {{ kind: 'root' | 'child' | 'unknown', parentId: string | null,
 *   dimension?: string | undefined }} target
 * @returns {{ tag: string, parentIdToSend: string | null | undefined }}
 */
function buildUpdatePayload(parsed, target) {
  const {
    hasDimensionPrefix, dimension, value, parentId,
  } = parsed;
  if (target.kind === 'child') {
    if (hasDimensionPrefix) {
      throw new ErrorWithStatusCode('a child tag name must not contain ":"', 400);
    }
    // PROMOTE-TO-ROOT (explicit `null`): a promoted child becomes a root, and a
    // root must carry its `<dimension>:` prefix — re-prefix the bare child name
    // with the dimension it inherited from its current root ancestor, else live
    // Semrush returns a bare (prefix-less) root. Contingent on the same open
    // G1/G3 probe questions as the rest of the parent/child model
    // (serenity-docs#26 §9). When the dimension can't be determined, fall back
    // to the bare value rather than guessing a prefix.
    const promoting = parentId === null;
    const tag = promoting && target.dimension ? `${target.dimension}:${value}` : value;
    // target.parentId is never null here: resolveTagTarget's child branch always
    // resolves it (falling back to the child's own root id), so no `?? undefined`
    // is needed the way the root/unknown branch below needs one. `parentId` is
    // either a re-parent target string, explicit `null` (promote-to-root, gate
    // 1), or `undefined` (omitted -- fall back to the current parent, gate 5).
    return {
      tag,
      parentIdToSend: parentId !== undefined ? parentId : /** @type {string} */ (target.parentId),
    };
  }
  // Root, or an id we could not resolve in the tree walk -- legacy behavior:
  // require the full "<dimension>:<value>" shape.
  const creatable = /** @type {readonly string[]} */ (CREATABLE_TAG_DIMENSIONS);
  if (!hasDimensionPrefix || !creatable.includes(dimension)) {
    throw new ErrorWithStatusCode(
      `name must be a "<dimension>:<value>" tag where dimension is one of: ${CREATABLE_TAG_DIMENSIONS.join(', ')}`,
      400,
    );
  }
  // A root rename must not silently cross dimensions (e.g. renaming
  // `category:X` to `tag:Y`) — the dimension is identity here, not a mutable
  // field. Only enforced for a RESOLVED root; an unresolvable (unknown) target
  // keeps the legacy pass-through since we can't know its current dimension.
  if (target.kind === 'root' && target.dimension && dimension !== target.dimension) {
    throw new ErrorWithStatusCode(
      `cannot change a root tag's dimension (${target.dimension} → ${dimension})`,
      400,
    );
  }
  // A root has no parent to remove, so an explicit `null` (promote-to-root) is
  // a no-op here -- not live-verified against a root specifically, so it is
  // defensively collapsed to omission rather than forwarded.
  return { tag: `${dimension}:${value}`, parentIdToSend: parentId ?? undefined };
}

/**
 * PATCH /serenity/tags/:tagId (flat mode) -- rename and/or re-parent a single
 * tag in place. The market's project id comes from the persisted
 * `BrandSemrushProject` mapping (same resolution as handleCreateTag).
 *
 * Resolves the target's current tree position first (see
 * {@link resolveTagTarget}) so a child rename never omits `parent_id` (which
 * would silently promote it to root, serenity-docs#24 section 3.1 gate 5) and
 * so a bare (no dimension prefix) name is only accepted for a child, mirroring
 * {@link handleCreateTag}'s create-side rule. An id we cannot resolve in the
 * tree walk falls back to the pre-existing full-name requirement; the
 * upstream 404 on the `tag_id` path segment (surfaced via the controller's
 * mapError) is what actually catches a genuinely unknown id.
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
  await validateUpdateReparent(transport, semrushWorkspaceId, projectId, id, parsed, target, log);
  const { tag, parentIdToSend } = buildUpdatePayload(parsed, target);
  const updated = await transport.updateProjectTag(
    semrushWorkspaceId,
    projectId,
    id,
    { name: tag, parentId: parentIdToSend },
  );
  const { parentId: updatedParentId } = pickTagIds(updated, parentIdToSend);
  log?.info?.('handleUpdateTag: updated tag', {
    brandId, geoTargetId, languageCode, tagId: id, tag, parentId: parentIdToSend,
  });
  return {
    status: 200,
    body: {
      brandId, geoTargetId, languageCode, tagId: id, tag, parentId: updatedParentId,
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
  await validateUpdateReparent(transport, workspaceId, projectId, id, parsed, target, log);
  const { tag, parentIdToSend } = buildUpdatePayload(parsed, target);
  const updated = await transport.updateProjectTag(
    workspaceId,
    projectId,
    id,
    { name: tag, parentId: parentIdToSend },
  );
  const { parentId: updatedParentId } = pickTagIds(updated, parentIdToSend);
  log?.info?.('handleUpdateTagSubworkspace: updated tag', {
    geoTargetId, languageCode, tagId: id, tag, parentId: parentIdToSend,
  });
  return {
    status: 200,
    body: {
      geoTargetId, languageCode, tagId: id, tag, parentId: updatedParentId,
    },
  };
}

/**
 * Reads the slice (geoTargetId, languageCode) filters off a query-like object,
 * throwing a 400 when either is missing/malformed. Shared by the flat and
 * subworkspace delete handlers. Returns the normalized pair.
 *
 * @param {object} query - the request query ({ geoTargetId, languageCode }).
 * @returns {{ geoTargetId: number, languageCode: string }}
 */
function requireSliceFilters(query) {
  const geoTargetId = normalizeGeoTargetId(query?.geoTargetId);
  const languageCode = normalizeLanguageCode(query?.languageCode);
  if (geoTargetId === null || languageCode === null) {
    throw new ErrorWithStatusCode(
      'geoTargetId (integer) and languageCode (BCP-47 primary subtag) are required',
      400,
    );
  }
  return { geoTargetId, languageCode };
}

/**
 * Shared delete core for both workspace modes. Resolves the target's tree
 * position + dimension, enforces the two guards, then deletes.
 *
 * SCOPE: tag-dimension ONLY for now. Deleting a `category:` (or any non-`tag:`)
 * tag is a deliberate 400 (`categoryDeleteNotYetSupported`) — it conflicts with
 * DRS's existing idempotent category re-sync/soft-delete system (a separate
 * PostgREST `categories` table with its own delete/resurrection semantics,
 * unrelated to this Semrush tag tree). A populated ROOT is a 409
 * (`tagHasChildren`) enforced BEFORE any upstream call, so a rejected delete
 * never touches Semrush.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} tagId - upstream tag id to delete.
 * @param {object} [log] - logger.
 * @returns {Promise<{ status: number }>}
 */
async function deleteResolvedTag(transport, semrushWorkspaceId, projectId, tagId, log) {
  const target = await resolveTagTarget(transport, semrushWorkspaceId, projectId, tagId, log);
  // Unresolvable target (never stored, already deleted, or beyond the tree-walk
  // cap): 404, not a dimension error — we genuinely could not locate the tag, so
  // "category delete not supported" would be factually wrong and unactionable.
  if (target.kind === 'unknown') {
    const err = new ErrorWithStatusCode('Tag not found in the project tag tree', 404);
    err.code = ERROR_CODES.TAG_NOT_RESOLVED;
    throw err;
  }
  if (target.dimension !== TAG_DIMENSION.TAG) {
    const err = new ErrorWithStatusCode(
      'Only tag-dimension tags can be deleted; category delete is not yet supported',
      400,
    );
    err.code = ERROR_CODES.CATEGORY_DELETE_NOT_YET_SUPPORTED;
    throw err;
  }
  if (target.kind === 'root' && target.childrenCount > 0) {
    const err = new ErrorWithStatusCode(
      'Cannot delete a tag that still has children; delete or re-parent them first',
      409,
    );
    err.code = ERROR_CODES.TAG_HAS_CHILDREN;
    throw err;
  }
  await transport.deleteProjectTags(semrushWorkspaceId, projectId, [tagId]);
  log?.info?.('deleteResolvedTag: deleted tag', { semrushWorkspaceId, projectId, tagId });
  return { status: 204 };
}

/**
 * DELETE /serenity/tags/:tagId (flat mode) — delete a single TAG-dimension tag.
 * The market's project id comes from the persisted `BrandSemrushProject`
 * mapping (same resolution as handleCreateTag), keyed by the slice filters on
 * the query string.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {object} dataAccess - data-access layer (BrandSemrushProject).
 * @param {string} brandId - brand UUID.
 * @param {string} semrushWorkspaceId - the org's (parent) workspace id.
 * @param {string} tagId - upstream tag id to delete.
 * @param {object} query - request query ({ geoTargetId, languageCode }).
 * @param {object} log - logger.
 * @returns {Promise<{ status: number }>}
 */
export async function handleDeleteTag(
  transport,
  dataAccess,
  brandId,
  semrushWorkspaceId,
  tagId,
  query,
  log,
) {
  const id = requireTagId(tagId);
  const { geoTargetId, languageCode } = requireSliceFilters(query);
  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    throw marketNotFound();
  }
  return deleteResolvedTag(transport, semrushWorkspaceId, row.getSemrushProjectId(), id, log);
}

/**
 * DELETE /serenity/tags/:tagId (subworkspace mode) — the market's project is
 * resolved live from the brand's own subworkspace listing (same resolution as
 * handleCreateTagSubworkspace). See {@link handleDeleteTag} for the scope
 * restriction and the children guard this shares.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} workspaceId - the brand's subworkspace id.
 * @param {string} tagId - upstream tag id to delete.
 * @param {object} query - request query ({ geoTargetId, languageCode }).
 * @param {object} log - logger.
 * @returns {Promise<{ status: number }>}
 */
export async function handleDeleteTagSubworkspace(
  transport,
  workspaceId,
  tagId,
  query,
  log,
) {
  const id = requireTagId(tagId);
  const { geoTargetId, languageCode } = requireSliceFilters(query);
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    throw marketNotFound();
  }
  return deleteResolvedTag(transport, workspaceId, String(project.id), id, log);
}
