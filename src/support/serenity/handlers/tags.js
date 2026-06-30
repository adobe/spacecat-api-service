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

/**
 * Validates + normalizes the create-tag body, throwing a 400
 * {@link ErrorWithStatusCode} on the first problem. Returns the parsed
 * `{ type, name, geoTargetId, languageCode }`.
 *
 * @param {object} body - request body.
 * @returns {{ type: string, name: string, geoTargetId: number, languageCode: string }}
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
    type, name: rawName, geoTargetId, languageCode,
  };
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
 * @param {object} body - request body ({ type, name, geoTargetId, languageCode }).
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
    type, name, geoTargetId, languageCode,
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
  await transport.createProjectTags(semrushWorkspaceId, row.getSemrushProjectId(), [tag]);
  log?.info?.('handleCreateTag: registered tag', {
    brandId, geoTargetId, languageCode, tag,
  });
  return {
    status: 201,
    body: {
      brandId, geoTargetId, languageCode, type, name, tag,
    },
  };
}

/**
 * Subworkspace mode — the market's project is resolved live from the brand's
 * own subworkspace listing (same resolution as handleListTagsSubworkspace).
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} workspaceId - the brand's subworkspace id.
 * @param {object} body - request body ({ type, name, geoTargetId, languageCode }).
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
    type, name, geoTargetId, languageCode,
  } = parseCreateTagBody(body);
  const project = await resolveProject(transport, workspaceId, geoTargetId, languageCode, log);
  if (!project) {
    throw marketNotFound();
  }
  const tag = tagFor(type, name);
  await transport.createProjectTags(workspaceId, String(project.id), [tag]);
  log?.info?.('handleCreateTagSubworkspace: registered tag', {
    geoTargetId, languageCode, tag,
  });
  return {
    status: 201,
    body: {
      geoTargetId, languageCode, type, name, tag,
    },
  };
}
