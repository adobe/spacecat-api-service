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

/**
 * Resolution of a project's dimension-root tag tree to upstream tag ids.
 *
 * Every tag write is id-based, and an id only exists once the tag does — so the
 * proxy must resolve (and, for the fixed parts of the taxonomy, provision) the
 * tree before it can attach anything to a prompt.
 *
 * Two upstream facts shape everything here, both verified against the live
 * Semrush API:
 *
 *  - Creating a name that already exists under the same parent answers **500**.
 *    Every create in this module is therefore resolve-before-create. Names are
 *    unique per `(project, parent)`, not per project, so the resolve must be
 *    scoped to the parent — a bare-name lookup across the whole tree would
 *    conflate a sub-category `human` with the `source` value `human`.
 *  - Tag writes land in the project's DRAFT layer, and a default read serves the
 *    LIVE view. Reads here go through {@link listProjectTagTree}, which passes
 *    `draft: true`, so a tag this module just created is visible to the tag
 *    resolution that follows it.
 */

import { listProjectTagTree } from './handlers/markets.js';
import {
  DIMENSION_ROOT_NAMES,
  CLOSED_DIMENSION_VALUES,
  CLOSED_DIMENSIONS,
} from './prompt-tags.js';

/**
 * Lists one level of the tree and indexes it by bare name. Uniqueness is per
 * `(project, parent)`, so a name is unambiguous WITHIN a level.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} parentId - '' for the root level.
 * @param {object} [log] - logger.
 * @returns {Promise<Map<string, string>>} bare name → tag id.
 */
export async function indexLevelByName(transport, semrushWorkspaceId, projectId, parentId, log) {
  const { items } = await listProjectTagTree(
    transport,
    semrushWorkspaceId,
    projectId,
    parentId,
    log,
  );
  const byName = new Map();
  for (const t of items) {
    // First writer wins: upstream forbids a duplicate (parent, name), so a second
    // entry here would mean upstream drift. Keep the first and let it be visible.
    if (t.name && !byName.has(t.name)) {
      byName.set(t.name, t.id);
    }
  }
  return byName;
}

/**
 * Creates the missing names under one parent and returns their ids, merged with
 * the ones that already existed. A single upstream call carries every name for
 * one parent, so the batch never straddles two parents (the wire has exactly one
 * `parent_id` per request).
 *
 * `createdNames` reports which of `wanted` this call actually minted, so a caller
 * can tell a create apart from a resolve without a second read. It is empty when
 * every name already existed.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} parentId - '' to create at the root level.
 * @param {readonly string[]} wanted - bare names that must exist under `parentId`.
 * @param {object} [log] - logger.
 * @returns {Promise<{ byName: Map<string, string>, createdNames: string[] }>}
 *   `byName` maps every wanted name to its tag id.
 */
export async function ensureChildren(
  transport,
  semrushWorkspaceId,
  projectId,
  parentId,
  wanted,
  log,
) {
  const existing = await indexLevelByName(transport, semrushWorkspaceId, projectId, parentId, log);
  const missing = wanted.filter((name) => !existing.has(name));
  if (missing.length === 0) {
    return { byName: existing, createdNames: [] };
  }
  const created = await transport.createProjectTags(
    semrushWorkspaceId,
    projectId,
    missing,
    parentId ? { parentId } : {},
  );
  // createProjectTags resolves to a LIST of the created nodes, in request order.
  const nodes = Array.isArray(created) ? created : [];
  for (const node of nodes) {
    if (node && typeof node.id === 'string' && node.id && typeof node.name === 'string') {
      existing.set(node.name, node.id);
    }
  }
  // A node the upstream did not echo back leaves a hole; re-read the level rather
  // than hand the caller a map that silently omits a name it asked for.
  if (missing.some((name) => !existing.has(name))) {
    log?.warn?.('ensureChildren: upstream create echoed fewer nodes than requested; re-reading level', {
      semrushWorkspaceId, projectId, parentId, requested: missing.length, echoed: nodes.length,
    });
    return {
      byName: await indexLevelByName(transport, semrushWorkspaceId, projectId, parentId, log),
      createdNames: missing,
    };
  }
  return { byName: existing, createdNames: missing };
}

/**
 * Resolves the four dimension roots, creating any that a project is missing.
 * Older projects predate this taxonomy entirely, so this is the seam that brings
 * them forward on first touch.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {object} [log] - logger.
 * @returns {Promise<Map<string, string>>} root name → tag id, for all four roots.
 */
export async function ensureDimensionRoots(transport, semrushWorkspaceId, projectId, log) {
  const { byName } = await ensureChildren(
    transport,
    semrushWorkspaceId,
    projectId,
    '',
    DIMENSION_ROOT_NAMES,
    log,
  );
  return byName;
}

/**
 * Resolves (provisioning as needed) the full fixed taxonomy: the four roots plus
 * every closed dimension's child vocabulary. The open `category` root is created
 * but left empty — its children are customer content.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {object} [log] - logger.
 * @returns {Promise<{
 *   roots: Map<string, string>,
 *   values: Map<string, Map<string, string>>,
 * }>} `roots` maps a root name to its id; `values` maps a closed dimension name
 *   to that dimension's bare value → id map.
 */
export async function provisionDimensionTree(transport, semrushWorkspaceId, projectId, log) {
  const roots = await ensureDimensionRoots(transport, semrushWorkspaceId, projectId, log);
  const values = new Map();
  for (const dimension of CLOSED_DIMENSIONS) {
    const rootId = roots.get(dimension);
    if (!rootId) {
      // ensureDimensionRoots guarantees every root, so a hole here is upstream drift.
      log?.warn?.('provisionDimensionTree: dimension root missing after ensure', {
        semrushWorkspaceId, projectId, dimension,
      });
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const { byName } = await ensureChildren(
      transport,
      semrushWorkspaceId,
      projectId,
      rootId,
      CLOSED_DIMENSION_VALUES[/** @type {keyof CLOSED_DIMENSION_VALUES} */ (dimension)],
      log,
    );
    values.set(dimension, byName);
  }
  return { roots, values };
}

/**
 * Resolves one closed-dimension value to its upstream id, creating it (and its
 * root) only if absent. Idempotent: many independent callers legitimately need
 * the id of a small, project-wide-shared value.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} dimension - a closed dimension (`intent` / `source` / `type`).
 * @param {string} value - a bare value from that dimension's fixed vocabulary.
 * @param {object} [log] - logger.
 * @returns {Promise<{ id: string | undefined, rootId: string | undefined,
 *   created: boolean }>} `created` is true only when THIS call minted the value.
 */
export async function ensureClosedValue(
  transport,
  semrushWorkspaceId,
  projectId,
  dimension,
  value,
  log,
) {
  const roots = await ensureDimensionRoots(transport, semrushWorkspaceId, projectId, log);
  const rootId = roots.get(dimension);
  if (!rootId) {
    return { id: undefined, rootId: undefined, created: false };
  }
  const { byName, createdNames } = await ensureChildren(
    transport,
    semrushWorkspaceId,
    projectId,
    rootId,
    [value],
    log,
  );
  return { id: byName.get(value), rootId, created: createdNames.includes(value) };
}

/**
 * Resolves the id-based injection of a server-computed `type` value into a
 * prompt write. Returns the wanted value's id plus EVERY id under the `type`
 * root, so the caller can strip any caller-supplied `type` tag id (the client
 * must never set the value itself).
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} wantValue - the computed bare `type` value (`branded` / `non-branded`).
 * @param {object} [log] - logger.
 * @returns {Promise<{ computedId: string | undefined, typeTagIds: string[] }>}
 */
export async function resolveTypeValueInjection(
  transport,
  semrushWorkspaceId,
  projectId,
  wantValue,
  log,
) {
  const roots = await ensureDimensionRoots(transport, semrushWorkspaceId, projectId, log);
  const typeRootId = roots.get('type');
  if (!typeRootId) {
    return { computedId: undefined, typeTagIds: [] };
  }
  const { byName } = await ensureChildren(
    transport,
    semrushWorkspaceId,
    projectId,
    typeRootId,
    [wantValue],
    log,
  );
  return {
    computedId: byName.get(wantValue),
    typeTagIds: [...byName.values()],
  };
}
