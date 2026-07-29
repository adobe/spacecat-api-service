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

import sinon from 'sinon';

import {
  DIMENSION_ROOT_NAMES,
  CLOSED_DIMENSION_VALUES,
} from '../../../../src/support/serenity/prompt-tags.js';

/**
 * A dimension-root tag tree in the shape upstream actually returns it, plus a
 * `listProjectTags` stub that serves it one level at a time.
 *
 * The tree the handlers walk is never flat: `listProjectTagTree` reads a single
 * level per call, keyed by `parentId` ('' for the roots). A stub that ignores
 * `parentId` and answers with every tag would let a handler that forgot to
 * descend still pass, so this one is keyed by parent — asking for a level that
 * does not exist yields an empty page, exactly as upstream does.
 *
 * The fixture deliberately carries a cross-dimension name collision: the
 * sub-category `human` under `Running Shoes` and the `origin` value `human` are
 * different tags with the same bare name. Any handler that keys tags by name
 * rather than id collapses them, and the tests that use this tree catch it.
 */

export const TAG_IDS = Object.freeze({
  categoryRoot: 'root-category',
  intentRoot: 'root-intent',
  originRoot: 'root-origin',
  typeRoot: 'root-type',

  intentInformational: 'intent-informational',
  intentTask: 'intent-task',
  intentCommercial: 'intent-commercial',
  intentTransactional: 'intent-transactional',
  intentNavigational: 'intent-navigational',

  originAi: 'origin-ai',
  originHuman: 'origin-human',

  typeBranded: 'type-branded',
  typeNonBranded: 'type-non-branded',

  categoryRunningShoes: 'category-running-shoes',
  subCategoryHuman: 'subcategory-human',
});

const ROOT_IDS = Object.freeze({
  category: TAG_IDS.categoryRoot,
  intent: TAG_IDS.intentRoot,
  origin: TAG_IDS.originRoot,
  type: TAG_IDS.typeRoot,
});

const CLOSED_VALUE_IDS = Object.freeze({
  intent: {
    Informational: TAG_IDS.intentInformational,
    Task: TAG_IDS.intentTask,
    Commercial: TAG_IDS.intentCommercial,
    Transactional: TAG_IDS.intentTransactional,
    Navigational: TAG_IDS.intentNavigational,
  },
  origin: { ai: TAG_IDS.originAi, human: TAG_IDS.originHuman },
  type: { branded: TAG_IDS.typeBranded, 'non-branded': TAG_IDS.typeNonBranded },
});

/** Upstream wire shape of one tag (snake_case, `path` = root-first ancestry). */
function upstreamTag({
  id, name, parentId = null, childrenCount = 0, path = null,
}) {
  return {
    id,
    name,
    parent_id: parentId,
    children_count: childrenCount,
    path,
  };
}

const CATEGORY_CRUMB = [{ id: TAG_IDS.categoryRoot, name: 'category' }];

/**
 * Builds the level map: `parentId` → the tags directly beneath it. `''` is the
 * root level. Callers may add or replace levels via `extraLevels`.
 *
 * @param {Record<string, object[]>} [extraLevels]
 * @returns {Record<string, object[]>}
 */
export function dimensionTreeLevels(extraLevels = {}) {
  const roots = DIMENSION_ROOT_NAMES.map((name) => upstreamTag({
    id: ROOT_IDS[name],
    name,
    childrenCount: name === 'category' ? 1 : CLOSED_DIMENSION_VALUES[name].length,
  }));

  const closedLevels = {};
  for (const dimension of ['intent', 'origin', 'type']) {
    closedLevels[ROOT_IDS[dimension]] = CLOSED_DIMENSION_VALUES[dimension].map((value) => (
      upstreamTag({
        id: CLOSED_VALUE_IDS[dimension][value],
        name: value,
        parentId: ROOT_IDS[dimension],
        path: [{ id: ROOT_IDS[dimension], name: dimension }],
      })
    ));
  }

  return {
    '': roots,
    ...closedLevels,
    [TAG_IDS.categoryRoot]: [upstreamTag({
      id: TAG_IDS.categoryRunningShoes,
      name: 'Running Shoes',
      parentId: TAG_IDS.categoryRoot,
      childrenCount: 1,
      path: CATEGORY_CRUMB,
    })],
    // Depth 3. Shares its bare name with the `origin` value `human`.
    [TAG_IDS.categoryRunningShoes]: [upstreamTag({
      id: TAG_IDS.subCategoryHuman,
      name: 'human',
      parentId: TAG_IDS.categoryRunningShoes,
      path: [...CATEGORY_CRUMB, { id: TAG_IDS.categoryRunningShoes, name: 'Running Shoes' }],
    })],
    ...extraLevels,
  };
}

/**
 * A `listProjectTags` stub that answers with the level under the requested
 * `parentId`. An unknown parent yields an empty page — a leaf, not an error.
 *
 * @param {Record<string, object[]>} [levels] - defaults to the full tree.
 * @returns {import('sinon').SinonStub}
 */
export function makeListProjectTagsStub(levels = dimensionTreeLevels()) {
  return sinon.stub().callsFake((_workspaceId, _projectId, options) => Promise.resolve({
    page: 1,
    total: (levels[options?.parentId ?? ''] || []).length,
    items: levels[options?.parentId ?? ''] || [],
  }));
}

/**
 * A `listProjectTags` stub over an EMPTY project, paired with a
 * `createProjectTags` stub that mints ids as `created:<parentId>:<name>` and
 * folds each created tag back into the served tree — so a second read inside
 * the same test sees what the first write created, as upstream's draft layer
 * does.
 *
 * @returns {{ listProjectTags: import('sinon').SinonStub,
 *   createProjectTags: import('sinon').SinonStub }}
 */
export function makeProvisioningTransportStubs() {
  /** @type {Record<string, object[]>} */
  const levels = { '': [] };
  const listProjectTags = makeListProjectTagsStub(levels);
  const createProjectTags = sinon.stub().callsFake(
    (_workspaceId, _projectId, names, options = {}) => {
      const parentId = options.parentId || '';
      const created = names.map((name) => upstreamTag({
        id: `created:${parentId}:${name}`,
        name,
        parentId: parentId || null,
      }));
      levels[parentId] = [...(levels[parentId] || []), ...created];
      // Upstream answers a BARE ARRAY of the created nodes, not an envelope.
      return Promise.resolve(created);
    },
  );
  return { listProjectTags, createProjectTags };
}
