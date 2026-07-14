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
 *
 * Resolve-before-create is not atomic, so a concurrent writer can mint a name
 * between the read and the create — including a second in-flight resolution
 * inside this same request. {@link ensureChildren} therefore treats a rejected
 * create as a possible lost race and re-reads before giving up, which is what
 * makes every export here idempotent rather than merely usually-idempotent.
 *
 * The seam FAILS CLOSED. A name that is still unresolved after the create and
 * the re-read is a 502, never a hole in the returned map: a caller that receives
 * a map has every name it asked for, so no consumer can answer 2xx for a write
 * that did not land.
 */

import { ErrorWithStatusCode } from '../utils.js';
import { listProjectTagTree } from './handlers/markets.js';
import {
  DIMENSION,
  DIMENSION_ROOT_NAMES,
  CLOSED_DIMENSION_VALUES,
  CLOSED_DIMENSIONS,
} from './prompt-tags.js';

/**
 * Where one tag sits in the dimension tree.
 *
 * @typedef {object} TagPosition
 * @property {'root' | 'descendant' | 'unknown'} kind
 * @property {string | null} parentId
 * @property {string | null} rootName - the tag's dimension: its own name when it
 *   IS a root, else `path[0]`.
 * @property {string[]} ancestorIds - ids of the tag's ancestors, root FIRST and
 *   the tag itself excluded. Empty for a root and for an unknown id.
 */

/**
 * Ceiling on the LEVEL reads one tree walk may perform. The tree has no upstream
 * depth or width limit, so an unresolvable id would otherwise cost one sequential
 * read per node against Semrush's shared rate limit.
 *
 * A "read" here is one {@link listProjectTagTree} call — one level of one node.
 * That call pages internally, so this caps the levels a walk visits, not the
 * upstream HTTP calls it issues; a level wider than one page costs more than one
 * call. Nothing caps a level's width on purpose: truncating a level would report
 * a tag that exists as absent, which is a wrong answer rather than a slow one.
 */
const MAX_TREE_READS = 200;

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
 * every name already existed, and it never names a tag this call did not create —
 * a name another writer minted first, or one the upstream echoed but did not
 * persist, is resolved, not claimed.
 *
 * Fails closed: throws a 502 rather than returning a map missing a wanted name.
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

  let echoed;
  try {
    echoed = await transport.createProjectTags(
      semrushWorkspaceId,
      projectId,
      missing,
      parentId ? { parentId } : {},
    );
  } catch (e) {
    // Upstream answers 500 on a duplicate (parent, name). Between our read and
    // our create, a concurrent writer — possibly another resolution inside this
    // same request — may have minted exactly the names we asked for. Re-read
    // before deciding this is a failure. The batch is all-or-nothing upstream,
    // so one collision also fails the names we were not racing on.
    const reread = await indexLevelByName(transport, semrushWorkspaceId, projectId, parentId, log);
    if (!missing.every((name) => reread.has(name))) {
      throw e;
    }
    log?.info?.('ensureChildren: lost a create race; resolved the names a concurrent writer minted', {
      semrushWorkspaceId, projectId, parentId, resolved: missing,
    });
    return { byName: reread, createdNames: [] };
  }

  // createProjectTags resolves to a LIST of the created nodes, in request order.
  const nodes = Array.isArray(echoed) ? echoed : [];
  for (const node of nodes) {
    if (node && typeof node.id === 'string' && node.id && typeof node.name === 'string') {
      existing.set(node.name, node.id);
    }
  }
  if (missing.every((name) => existing.has(name))) {
    return { byName: existing, createdNames: missing };
  }

  // A node the upstream did not echo back leaves a hole. Re-read rather than hand
  // back a map that silently omits a name the caller asked for.
  log?.warn?.('ensureChildren: upstream create echoed fewer nodes than requested', {
    semrushWorkspaceId,
    projectId,
    parentId,
    unechoed: missing.filter((name) => !existing.has(name)),
  });
  const byName = await indexLevelByName(transport, semrushWorkspaceId, projectId, parentId, log);
  const unresolved = missing.filter((name) => !byName.has(name));
  if (unresolved.length > 0) {
    // The create answered 2xx and the draft-layer re-read still does not see the
    // name. Returning here would let a caller answer 2xx for a write that did not
    // land, handing it an `undefined` tag id.
    log?.error?.('ensureChildren: upstream accepted the create but did not persist it', {
      semrushWorkspaceId,
      projectId,
      parentId,
      unresolved,
    });
    throw new ErrorWithStatusCode(
      `upstream did not persist the tag(s): ${unresolved.join(', ')}`,
      502,
    );
  }
  // Only the names the create echoed are ours to claim. A name that reappeared on
  // the re-read was resolved, not minted here — another writer may have won it.
  return { byName, createdNames: missing.filter((name) => existing.has(name)) };
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
 * The id of one dimension root out of an {@link ensureDimensionRoots} result.
 *
 * `ensureChildren` fails closed, so a map it returned carries every name that was
 * asked for — all four roots. The assertion records that invariant for the type
 * checker instead of re-testing it at runtime.
 *
 * @param {Map<string, string>} roots - the resolved root name → id map.
 * @param {string} dimension - one of the four dimension root names.
 * @returns {string}
 */
function rootIdOf(roots, dimension) {
  return /** @type {string} */ (roots.get(dimension));
}

/**
 * Locates every id in `tagIds` in the project's draft tag tree, in ONE walk, and
 * reports where each sits: the DIMENSION it belongs to (the name of its root
 * ancestor) and the ids of its ancestors, root-first.
 *
 * There is no upstream "get tag by id", so this walks the tree a level at a time:
 * the roots first, then the children of every node that has any. Resolving a set
 * in one traversal is what keeps a re-parent — which must place both the moved
 * tag and its prospective parent — from paying for the tree twice, and it reads
 * both positions from the SAME snapshot, so the ancestry proved for one cannot
 * have moved under the other.
 *
 * A `visited` set makes an upstream parentage cycle terminate, and
 * {@link MAX_TREE_READS} bounds the level reads. Nothing here caps a level's
 * width: dropping the tail of a level would report an existing tag as absent,
 * and callers turn `unknown` into a 404.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string[]} tagIds - the upstream ids to locate.
 * @param {object} [log] - logger.
 * @returns {Promise<Map<string, TagPosition>>} one entry per DISTINCT requested
 *   id; an id absent from the tree maps to a `kind: 'unknown'` position.
 */
export async function findTagsInTree(transport, semrushWorkspaceId, projectId, tagIds, log) {
  const wanted = new Set(tagIds);
  /** @type {Map<string, TagPosition>} */
  const found = new Map();
  const roots = await listProjectTagTree(transport, semrushWorkspaceId, projectId, '', log);
  for (const root of roots.items) {
    if (wanted.has(root.id)) {
      found.set(root.id, {
        kind: 'root', parentId: null, rootName: root.name, ancestorIds: [],
      });
    }
  }
  const visited = new Set();
  let reads = 1;
  let frontier = roots.items
    .filter((r) => r.childrenCount > 0)
    .map((r) => ({ node: r, rootName: r.name, ancestorIds: [r.id] }));
  while (frontier.length > 0 && found.size < wanted.size) {
    const next = [];
    for (const { node, rootName, ancestorIds } of frontier) {
      if (!visited.has(node.id)) {
        visited.add(node.id);
        reads += 1;
        if (reads > MAX_TREE_READS) {
          throw new ErrorWithStatusCode('tag tree too large to resolve', 502);
        }
        // Sequential by design: stop as soon as every wanted id is placed rather
        // than fanning out every node's children concurrently.
        // eslint-disable-next-line no-await-in-loop
        const children = await listProjectTagTree(
          transport,
          semrushWorkspaceId,
          projectId,
          node.id,
          log,
        );
        for (const child of children.items) {
          if (wanted.has(child.id)) {
            found.set(child.id, {
              kind: 'descendant',
              parentId: child.parentId ?? node.id,
              rootName: child.path?.[0]?.name ?? rootName,
              ancestorIds,
            });
          }
        }
        if (found.size === wanted.size) {
          return found;
        }
        next.push(...children.items
          .filter((t) => t.childrenCount > 0)
          .map((child) => ({ node: child, rootName, ancestorIds: [...ancestorIds, child.id] })));
      }
    }
    frontier = next;
  }
  for (const id of wanted) {
    if (!found.has(id)) {
      found.set(id, {
        kind: 'unknown', parentId: null, rootName: null, ancestorIds: [],
      });
    }
  }
  return found;
}

/**
 * Locates one tag. Thin wrapper over {@link findTagsInTree}; see it for the walk.
 * Private on purpose: a caller that already knows both ids it needs should place
 * them in a single walk rather than call this twice.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} tagId - the upstream id to locate.
 * @param {object} [log] - logger.
 * @returns {Promise<TagPosition>} `rootName` is the tag's dimension: its own name
 *   when it IS a root, else `path[0]`.
 */
async function findTagInTree(transport, semrushWorkspaceId, projectId, tagId, log) {
  const found = await findTagsInTree(transport, semrushWorkspaceId, projectId, [tagId], log);
  return /** @type {TagPosition} */ (found.get(tagId));
}

/**
 * Throws unless `parent` is the `dimension` root itself or one of its
 * descendants, and — when a tag is being MOVED under it — unless `parent` sits
 * outside that tag's own subtree.
 *
 * A tag's dimension is its root ancestor, so an unchecked `parentId` is the one
 * edge that can move a tag into a dimension its caller never named — filing a
 * customer-authored value under `intent`, where the fixed vocabulary is supposed
 * to be the only content. Membership must be tested by ANCESTRY, not by comparing
 * against the three closed root ids: a parent nested under a closed root is one
 * level deeper and would pass that test.
 *
 * The subtree check is the same argument one edge further in. Upstream stores a
 * parent pointer, not a tree, so it will happily accept `A.parent = B` when `B`
 * already descends from `A`. Nothing then references `A` or `B` from a root, and
 * because every walk here starts AT the roots, both become permanently
 * unreachable: `findTagsInTree` reports them `unknown`, every later PATCH 404s,
 * and no request can undo the edge. The `visited` set makes such a cycle
 * survivable on read; refusing it on write is what keeps it from existing.
 *
 * @param {string} dimension - the dimension the new/edited tag belongs to.
 * @param {TagPosition} parent - the resolved position of the caller's `parentId`.
 * @param {string} [movingTagId] - the tag being re-parented; omitted on a create,
 *   where nothing exists yet to be a parent's ancestor.
 * @returns {void}
 */
export function assertParentPlacement(dimension, parent, movingTagId) {
  if (parent.kind === 'unknown') {
    throw new ErrorWithStatusCode('parentId does not resolve to a tag on this market', 400);
  }
  if (parent.rootName !== dimension) {
    throw new ErrorWithStatusCode(
      `parentId must be the "${dimension}" dimension root or one of its descendants`,
      400,
    );
  }
  if (movingTagId && parent.ancestorIds.includes(movingTagId)) {
    throw new ErrorWithStatusCode('parentId must not be a descendant of the tag', 400);
  }
}

/**
 * Resolves `parentId` and asserts it may parent a tag of `dimension`. Used by the
 * CREATE paths, where the tag does not exist yet; a re-parent instead resolves
 * the target and the parent together via {@link findTagsInTree} and calls
 * {@link assertParentPlacement} directly.
 *
 * @param {object} transport - Serenity transport (Semrush proxy client).
 * @param {string} semrushWorkspaceId
 * @param {string} projectId
 * @param {string} dimension - the dimension the new tag belongs to.
 * @param {string} parentId - the caller-supplied parent id.
 * @param {object} [log] - logger.
 * @returns {Promise<void>}
 */
export async function assertParentWithinDimension(
  transport,
  semrushWorkspaceId,
  projectId,
  dimension,
  parentId,
  log,
) {
  const parent = await findTagInTree(transport, semrushWorkspaceId, projectId, parentId, log);
  assertParentPlacement(dimension, parent);
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
  // The three closed dimensions hang off different parents and their vocabularies
  // are disjoint, so nothing orders these against each other.
  const resolved = await Promise.all(CLOSED_DIMENSIONS.map((dimension) => ensureChildren(
    transport,
    semrushWorkspaceId,
    projectId,
    rootIdOf(roots, dimension),
    CLOSED_DIMENSION_VALUES[/** @type {keyof CLOSED_DIMENSION_VALUES} */ (dimension)],
    log,
  )));
  const values = new Map(
    CLOSED_DIMENSIONS.map((dimension, i) => [dimension, resolved[i].byName]),
  );
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
 * @returns {Promise<{ id: string, rootId: string, created: boolean }>} `created`
 *   is true only when THIS call minted the value. Both ids are always resolved —
 *   {@link ensureChildren} throws rather than leave a hole.
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
  const rootId = rootIdOf(roots, dimension);
  const { byName, createdNames } = await ensureChildren(
    transport,
    semrushWorkspaceId,
    projectId,
    rootId,
    [value],
    log,
  );
  return {
    id: /** @type {string} */ (byName.get(value)),
    rootId,
    created: createdNames.includes(value),
  };
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
 * @returns {Promise<{ computedId: string, typeTagIds: string[] }>} `computedId` is
 *   always resolved — {@link ensureChildren} throws rather than leave a hole, so a
 *   prompt can never be written with the server-computed `type` tag missing.
 */
export async function resolveTypeValueInjection(
  transport,
  semrushWorkspaceId,
  projectId,
  wantValue,
  log,
) {
  const roots = await ensureDimensionRoots(transport, semrushWorkspaceId, projectId, log);
  const typeRootId = rootIdOf(roots, DIMENSION.TYPE);
  const { byName } = await ensureChildren(
    transport,
    semrushWorkspaceId,
    projectId,
    typeRootId,
    [wantValue],
    log,
  );
  return {
    computedId: /** @type {string} */ (byName.get(wantValue)),
    typeTagIds: [...byName.values()],
  };
}
