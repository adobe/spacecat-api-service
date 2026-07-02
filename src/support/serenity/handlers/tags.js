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
import { normalizeGeoTargetId, normalizeLanguageCode } from '../validation.js';
import { resolveProject } from '../subworkspace-projects.js';
import { tagFor, CREATABLE_TAG_DIMENSIONS } from '../prompt-tags.js';

/**
 * POST /serenity/tags — create a prompt TAG on a single market.
 *
 * Tags are `dimension:<NAME>` strings registered on a market's project (the
 * `aio/tags` surface, via {@link createProjectTags}). This endpoint creates a
 * tag under one of the OPEN dimensions ({@link CREATABLE_TAG_DIMENSIONS} —
 * `category` / `topic`); the closed taxonomies (`source` / `intent` / `type`)
 * have a fixed value enum and are not freely creatable, so the `type` is
 * validated against the allow-list (this is what bounds the allowed prefixes).
 * The UI's "Categories" view, for instance, is the `category:` slice of these
 * tags across the brand's markets.
 *
 * Both the flat-mode and subworkspace-mode handlers resolve the market's project
 * id from the `(geoTargetId, languageCode)` slice and register one tag.
 */

const MAX_TAG_NAME_LEN = 100;
// Upstream tag ids are opaque (UUIDs in practice); this only bounds an absurd
// value, not a strict format — the id must round-trip from a prior list.
const MAX_TAG_ID_LEN = 200;

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
  if (id.length > MAX_TAG_ID_LEN) {
    throw new ErrorWithStatusCode(
      `parentId must not exceed ${MAX_TAG_ID_LEN} characters`,
      400,
    );
  }
  // Whitespace / control chars can never be a valid upstream id and would corrupt
  // the request (query value on create, path segment on PATCH). Reject them; leave
  // the id otherwise opaque (do not assume a strict UUID shape).
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001F\u007F]/.test(id)) {
    throw new ErrorWithStatusCode(
      'parentId must not contain whitespace or control characters',
      400,
    );
  }
  return id;
}

/**
 * Validates + normalizes the create-tag body, throwing a 400
 * {@link ErrorWithStatusCode} on the first problem. Returns the parsed
 * `{ type, name, geoTargetId, languageCode, parentId }`. `parentId` (optional) is
 * an upstream tag id under which the new tag is nested (1-level category tree).
 *
 * @param {object} body - request body.
 * @returns {{
 *   type: string, name: string, geoTargetId: number,
 *   languageCode: string, parentId: string | undefined,
 * }}
 */
function parseCreateTagBody(body) {
  const type = hasText(body?.type) ? String(body.type).trim().toLowerCase() : '';
  // CREATABLE_TAG_DIMENSIONS is a frozen literal tuple; widen to string[] so
  // `.includes(type)` accepts an arbitrary runtime string for the membership test.
  if (!(/** @type {readonly string[]} */ (CREATABLE_TAG_DIMENSIONS)).includes(type)) {
    throw new ErrorWithStatusCode(
      `type must be one of: ${CREATABLE_TAG_DIMENSIONS.join(', ')}`,
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
  return {
    type, name: rawName, geoTargetId, languageCode, parentId,
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
 * @param {string | undefined} requestedParentId
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
    type, name, geoTargetId, languageCode, parentId,
  } = parseCreateTagBody(body);
  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    throw marketNotFound();
  }
  const tag = tagFor(type, name);
  const created = await transport.createProjectTags(
    semrushWorkspaceId,
    row.getSemrushProjectId(),
    [tag],
    { parentId },
  );
  const { id, parentId: createdParentId } = pickTagIds(created, parentId);
  log?.info?.('handleCreateTag: registered tag', {
    brandId, geoTargetId, languageCode, tag, parentId,
  });
  return {
    status: 201,
    body: {
      brandId, geoTargetId, languageCode, type, name, tag, id, parentId: createdParentId,
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
    type, name, geoTargetId, languageCode, parentId,
  } = parseCreateTagBody(body);
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    throw marketNotFound();
  }
  const tag = tagFor(type, name);
  const created = await transport.createProjectTags(
    workspaceId,
    String(project.id),
    [tag],
    { parentId },
  );
  const { id, parentId: createdParentId } = pickTagIds(created, parentId);
  log?.info?.('handleCreateTagSubworkspace: registered tag', {
    geoTargetId, languageCode, tag, parentId,
  });
  return {
    status: 201,
    body: {
      geoTargetId, languageCode, type, name, tag, id, parentId: createdParentId,
    },
  };
}

/** Throws a 400 for a missing/blank tagId path param. Returns the trimmed id. */
function requireTagId(tagId) {
  if (!hasText(tagId)) {
    throw new ErrorWithStatusCode('tagId is required', 400);
  }
  return String(tagId).trim();
}

/**
 * Validates + normalizes the update-tag body, throwing a 400 on the first
 * problem. Unlike create, `name` here is the FULL `<dimension>:<value>` tag
 * string (upstream requires `name` on every PATCH, so a pure re-parent still
 * carries the tag's current full name — the caller has it from a prior list). The
 * dimension must be one of {@link CREATABLE_TAG_DIMENSIONS}, so a PATCH can never
 * smuggle a tag into a closed taxonomy (`intent`/`source`/`type`). `parentId`
 * (optional) re-parents when non-empty.
 *
 * @param {object} body - request body ({ name, parentId?, geoTargetId, languageCode }).
 * @returns {{
 *   tag: string, parentId: string | undefined,
 *   geoTargetId: number, languageCode: string,
 * }}
 */
function parseUpdateTagBody(body) {
  const rawName = hasText(body?.name) ? String(body.name).trim() : '';
  if (!rawName) {
    throw new ErrorWithStatusCode('name is required', 400);
  }
  const colon = rawName.indexOf(':');
  const dimension = colon > 0 ? rawName.slice(0, colon).toLowerCase() : '';
  const value = colon > 0 ? rawName.slice(colon + 1) : '';
  // Widen the frozen tuple to string[] for the runtime membership test (see the
  // same idiom in parseCreateTagBody).
  const creatable = /** @type {readonly string[]} */ (CREATABLE_TAG_DIMENSIONS);
  if (!creatable.includes(dimension) || !value) {
    throw new ErrorWithStatusCode(
      `name must be a "<dimension>:<value>" tag where dimension is one of: ${CREATABLE_TAG_DIMENSIONS.join(', ')}`,
      400,
    );
  }
  if (value.length > MAX_TAG_NAME_LEN) {
    throw new ErrorWithStatusCode(
      `name value must not exceed ${MAX_TAG_NAME_LEN} characters`,
      400,
    );
  }
  // Exactly one ':' — a second colon would smuggle a nested dimension.
  if (value.includes(':')) {
    throw new ErrorWithStatusCode('name must contain exactly one ":"', 400);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw new ErrorWithStatusCode('name must not contain control characters', 400);
  }
  const parentId = parseParentId(body?.parentId);
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
    tag: `${dimension}:${value}`, parentId, geoTargetId, languageCode,
  };
}

/**
 * PATCH /serenity/tags/:tagId (flat mode) — rename and/or re-parent a single tag
 * in place. The market's project id comes from the persisted `BrandSemrushProject`
 * mapping (same resolution as handleCreateTag). An unknown `tagId` surfaces as the
 * upstream 404 (SerenityTransportError) via the controller's mapError.
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
  const {
    tag, parentId, geoTargetId, languageCode,
  } = parseUpdateTagBody(body);
  const row = await dataAccess.BrandSemrushProject.findBySlice(
    brandId,
    geoTargetId,
    languageCode,
  );
  if (!row) {
    throw marketNotFound();
  }
  const updated = await transport.updateProjectTag(
    semrushWorkspaceId,
    row.getSemrushProjectId(),
    id,
    { name: tag, parentId },
  );
  const { parentId: updatedParentId } = pickTagIds(updated, parentId);
  log?.info?.('handleUpdateTag: updated tag', {
    brandId, geoTargetId, languageCode, tagId: id, tag, parentId,
  });
  return {
    status: 200,
    body: {
      brandId, geoTargetId, languageCode, tagId: id, tag, parentId: updatedParentId,
    },
  };
}

/**
 * PATCH /serenity/tags/:tagId (subworkspace mode) — the market's project is
 * resolved live from the brand's own subworkspace listing (same resolution as
 * handleCreateTagSubworkspace).
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
  const {
    tag, parentId, geoTargetId, languageCode,
  } = parseUpdateTagBody(body);
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    throw marketNotFound();
  }
  const updated = await transport.updateProjectTag(
    workspaceId,
    String(project.id),
    id,
    { name: tag, parentId },
  );
  const { parentId: updatedParentId } = pickTagIds(updated, parentId);
  log?.info?.('handleUpdateTagSubworkspace: updated tag', {
    geoTargetId, languageCode, tagId: id, tag, parentId,
  });
  return {
    status: 200,
    body: {
      geoTargetId, languageCode, tagId: id, tag, parentId: updatedParentId,
    },
  };
}
