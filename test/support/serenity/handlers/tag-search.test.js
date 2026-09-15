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

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  handleSearchTags,
  MAX_TAG_SEARCH_LIMIT,
  MAX_TAG_SEARCH_QUERY_LENGTH,
  searchTagSnapshot,
} from '../../../../src/support/serenity/handlers/tag-search.js';
import { ERROR_CODES } from '../../../../src/support/serenity/errors.js';
import { clearTagCache } from '../../../../src/support/serenity/handlers/markets.js';
import {
  loadTagTreeSnapshot,
  MAX_TREE_CONCURRENCY,
  MAX_TREE_DURATION_MS,
  MAX_TREE_NODES,
  MAX_TREE_PARENT_READS,
  MAX_TREE_READS,
} from '../../../../src/support/serenity/tag-tree.js';
import {
  MAX_TREE_PAGES_PER_PARENT,
  TAG_TREE_PAGE_SIZE,
} from '../../../../src/support/serenity/tag-search-constants.js';

const WORKSPACE = 'workspace-1';
const PROJECT = 'project-1';
const BRAND = '11111111-2222-3333-4444-555555555555';
const SECRET = 'unit-test-cursor-secret';

use(chaiAsPromised);
use(sinonChai);

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

function dataAccess() {
  return {
    BrandSemrushProject: {
      findBySlice: sinon.stub().resolves({ getSemrushProjectId: () => PROJECT }),
    },
  };
}

function tag(id, name, parentId, childrenCount, path = undefined) {
  return {
    id,
    name,
    ...(parentId ? { parent_id: parentId } : {}),
    children_count: childrenCount,
    prompts_count: 0,
    ...(path ? { path } : {}),
  };
}

function deepTransport(state = { leafName: 'Needle' }) {
  const root = { id: 'tag-root', name: 'tag' };
  const family = { id: 'family', name: 'Campaign' };
  const branch = { id: 'branch', name: 'Spring' };
  return {
    listProjectTags: sinon.stub().callsFake((workspaceId, projectId, options) => {
      expect(workspaceId).to.equal(WORKSPACE);
      expect(projectId).to.equal(PROJECT);
      expect(options).to.not.have.property('search');
      const levels = {
        '': [
          tag('category-root', 'category', null, 0),
          tag(root.id, root.name, null, 1),
        ],
        [root.id]: [tag(family.id, family.name, root.id, 1, [root])],
        [family.id]: [tag(branch.id, branch.name, family.id, 1, [root, family])],
        [branch.id]: [
          tag('leaf', state.leafName, branch.id, 0, [root, family, branch]),
          tag('other-leaf', 'Other Needle', branch.id, 0, [root, family, branch]),
        ],
      };
      const items = levels[options.parentId ?? ''] ?? [];
      return Promise.resolve({
        items,
        page: options.page,
        total: items.length,
      });
    }),
  };
}

afterEach(() => {
  clearTagCache();
  sinon.restore();
});

describe('Serenity custom-tag search', () => {
  it('pins the cacheless traversal safety budgets', () => {
    expect({
      maxParents: MAX_TREE_READS,
      configuredParentReads: MAX_TREE_PARENT_READS,
      maxNodes: MAX_TREE_NODES,
      concurrency: MAX_TREE_CONCURRENCY,
      maxDurationMs: MAX_TREE_DURATION_MS,
      maxPagesPerParent: MAX_TREE_PAGES_PER_PARENT,
      pageSize: TAG_TREE_PAGE_SIZE,
    }).to.deep.equal({
      maxParents: 200,
      configuredParentReads: 200,
      maxNodes: 10_000,
      concurrency: 6,
      maxDurationMs: 15_000,
      maxPagesPerParent: 50,
      pageSize: 100,
    });
  });

  it('finds a deep descendant through nonmatching ancestors without using upstream search', async () => {
    const transport = deepTransport();
    const result = await handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: ' needle ', limit: 25,
      },
      fakeLog(),
      SECRET,
    );

    expect(result).to.deep.equal({
      items: [
        {
          id: 'leaf',
          name: 'Needle',
          parentId: 'branch',
          depth: 4,
          path: ['Campaign', 'Spring', 'Needle'],
          match: 'exact',
        },
        {
          id: 'other-leaf',
          name: 'Other Needle',
          parentId: 'branch',
          depth: 4,
          path: ['Campaign', 'Spring', 'Other Needle'],
          match: 'substring',
        },
      ],
      cursor: null,
      complete: true,
    });
    expect(transport.listProjectTags).to.have.callCount(4);
  });

  it('retrieves every page of a level before searching locally', async () => {
    const root = { id: 'tag-root', name: 'tag' };
    const children = Array.from({ length: TAG_TREE_PAGE_SIZE + 1 }, (_, index) => tag(
      `child-${index}`,
      index === TAG_TREE_PAGE_SIZE ? 'Page Two Needle' : `Filler ${index}`,
      root.id,
      0,
      [root],
    ));
    const transport = {
      listProjectTags: sinon.stub().callsFake((_workspace, _project, options) => {
        if (!options.parentId) {
          return Promise.resolve({
            items: [tag(root.id, root.name, null, children.length)],
            page: options.page,
            total: 1,
          });
        }
        const start = (options.page - 1) * TAG_TREE_PAGE_SIZE;
        return Promise.resolve({
          items: children.slice(start, start + TAG_TREE_PAGE_SIZE),
          page: options.page,
          total: children.length,
        });
      }),
    };

    const result = await handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: 'needle', limit: 25,
      },
      fakeLog(),
      SECRET,
    );

    expect(result.items.map((item) => item.id)).to.deep.equal([`child-${TAG_TREE_PAGE_SIZE}`]);
    expect(transport.listProjectTags).to.have.callCount(3);
  });

  it('ranks exact, prefix, label substring, and path matches with deterministic ties', () => {
    const root = { id: 'root', name: 'tag' };
    const item = (id, name, path) => ({
      id,
      name,
      parentId: path.at(-2)?.id ?? 'root',
      depth: path.length,
      rootName: 'tag',
      fullPath: path,
    });
    const familyA = { id: 'family-a', name: 'A' };
    const familyB = { id: 'family-b', name: 'B' };
    const items = [
      item('exact-b', 'Alpha', [root, familyB, { id: 'exact-b', name: 'Alpha' }]),
      item('path', 'Leaf', [root, { id: 'alpha-path', name: 'Alpha Path' }, { id: 'path', name: 'Leaf' }]),
      item('substring', 'XalphaY', [root, { id: 'family-c', name: 'C' }, { id: 'substring', name: 'XalphaY' }]),
      item('prefix', 'Alphabet', [root, { id: 'family-d', name: 'D' }, { id: 'prefix', name: 'Alphabet' }]),
      item('exact-a', 'Alpha', [root, familyA, { id: 'exact-a', name: 'Alpha' }]),
    ];

    expect(searchTagSnapshot({ items }, 'alpha').map((entry) => entry.id))
      .to.deep.equal(['exact-a', 'exact-b', 'prefix', 'substring', 'path']);
  });

  it('keeps pages stable and rejects a cursor after the taxonomy changes', async () => {
    const state = { leafName: 'Needle' };
    const transport = deepTransport(state);
    const first = await handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: 'needle', limit: 1,
      },
      fakeLog(),
      SECRET,
    );
    expect(first.items.map((item) => item.id)).to.deep.equal(['leaf']);
    expect(first.cursor).to.be.a('string');

    const second = await handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840,
        languageCode: 'en',
        q: 'needle',
        limit: 1,
        cursor: first.cursor,
      },
      fakeLog(),
      SECRET,
    );
    expect(second.items.map((item) => item.id)).to.deep.equal(['other-leaf']);
    expect(second.cursor).to.equal(null);

    state.leafName = 'Needle changed';
    await expect(handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840,
        languageCode: 'en',
        q: 'needle',
        limit: 1,
        cursor: first.cursor,
      },
      fakeLog(),
      SECRET,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(409);
      expect(error.code).to.equal(ERROR_CODES.TAG_SEARCH_SNAPSHOT_CHANGED);
    });
  });

  it('rejects tampered cursors and invalid query bounds', async () => {
    const transport = deepTransport();
    const first = await handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: 'needle', limit: 1,
      },
      fakeLog(),
      SECRET,
    );
    await expect(handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840,
        languageCode: 'en',
        q: 'needle',
        limit: 1,
        cursor: `${first.cursor}x`,
      },
      fakeLog(),
      SECRET,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(400);
      expect(error.code).to.equal(ERROR_CODES.TAG_SEARCH_CURSOR_INVALID);
    });

    for (const query of [
      { geoTargetId: 2840, languageCode: 'en', q: '   ' },
      {
        geoTargetId: 2840,
        languageCode: 'en',
        q: 'x'.repeat(MAX_TAG_SEARCH_QUERY_LENGTH + 1),
      },
      {
        geoTargetId: 2840,
        languageCode: 'en',
        q: 'x',
        limit: MAX_TAG_SEARCH_LIMIT + 1,
      },
      {
        geoTargetId: 2840,
        languageCode: 'en',
        q: 'x',
        cursor: '',
      },
      {
        geoTargetId: 2840,
        languageCode: 'en',
        q: 'x',
        limit: '1.5',
      },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(handleSearchTags(
        transport,
        dataAccess(),
        BRAND,
        WORKSPACE,
        query,
        fakeLog(),
        SECRET,
      )).to.be.rejected.then((error) => {
        expect(error.status).to.equal(400);
      });
    }
  });

  it('fails instead of returning partial results for an incomplete Semrush page', async () => {
    const transport = {
      listProjectTags: sinon.stub().resolves({
        items: [tag('tag-root', 'tag', null, 0)],
        page: 1,
        total: 2,
      }),
    };

    await expect(handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: 'tag', limit: 25,
      },
      fakeLog(),
      SECRET,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(503);
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_READ_INCOMPLETE);
    });
  });

  it('fails explicitly when the node budget is exhausted', async () => {
    const transport = deepTransport();
    await expect(loadTagTreeSnapshot(
      transport,
      WORKSPACE,
      PROJECT,
      fakeLog(),
      { rootName: 'tag', maxNodes: 2 },
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(503);
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_LIMIT_EXCEEDED);
      expect(error.details).to.deep.equal({ budget: 'nodes', maximum: 2 });
    });
  });

  it('fails closed when a child supplies a stale root name for the correct root id', async () => {
    const root = { id: 'tag-root', name: 'tag' };
    const transport = {
      listProjectTags: sinon.stub().callsFake((_workspace, _project, options) => (
        Promise.resolve({
          items: options.parentId
            ? [tag('leaf', 'Needle', root.id, 0, [{ id: root.id, name: 'Tag' }])]
            : [tag(root.id, root.name, null, 1)],
          page: options.page,
          total: 1,
        })
      )),
    };

    await expect(handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: 'needle', limit: 25,
      },
      fakeLog(),
      SECRET,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(503);
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_DATA_INTEGRITY);
      expect(error.details).to.deep.equal({ reason: 'pathMismatch', tagId: 'leaf' });
    });
  });

  it('fails closed when canonical and case-variant plain-tag roots coexist', async () => {
    const transport = {
      listProjectTags: sinon.stub().resolves({
        items: [
          tag('tag-root', 'tag', null, 0),
          tag('variant-root', 'Tag', null, 0),
        ],
        page: 1,
        total: 2,
      }),
    };

    await expect(handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: 'tag', limit: 25,
      },
      fakeLog(),
      SECRET,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(503);
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_DATA_INTEGRITY);
      expect(error.details).to.deep.equal({ reason: 'caseVariantRoot', rootName: 'Tag' });
    });
  });

  it('fails closed when duplicate canonical plain-tag roots coexist', async () => {
    const transport = {
      listProjectTags: sinon.stub().resolves({
        items: [
          tag('tag-root-a', 'tag', null, 0),
          tag('tag-root-b', 'tag', null, 0),
        ],
        page: 1,
        total: 2,
      }),
    };

    await expect(handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: 'tag', limit: 25,
      },
      fakeLog(),
      SECRET,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(503);
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_DATA_INTEGRITY);
      expect(error.details).to.deep.equal({ reason: 'ambiguousRoot', rootName: 'tag' });
    });
  });

  it('rejects repeated ids and cycles as data-integrity failures', async () => {
    const root = { id: 'tag-root', name: 'tag' };
    const transport = {
      listProjectTags: sinon.stub().callsFake((_workspace, _project, options) => (
        Promise.resolve({
          items: options.parentId
            ? [tag(root.id, 'Cycle', options.parentId, 0, [root])]
            : [tag(root.id, root.name, null, 1)],
          page: options.page,
          total: 1,
        })
      )),
    };

    await expect(loadTagTreeSnapshot(
      transport,
      WORKSPACE,
      PROJECT,
      fakeLog(),
      { rootName: 'tag' },
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(503);
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_DATA_INTEGRITY);
      expect(error.details.reason).to.equal('repeatedTagId');
    });
  });

  it('never exceeds the configured Semrush request concurrency', async () => {
    const root = { id: 'tag-root', name: 'tag' };
    const parents = Array.from({ length: 8 }, (_, index) => ({
      id: `parent-${index}`,
      name: `Parent ${index}`,
    }));
    let active = 0;
    let peak = 0;
    const transport = {
      listProjectTags: sinon.stub().callsFake(async (_workspace, _project, options) => {
        if (!options.parentId) {
          return {
            items: [tag(root.id, root.name, null, 1)],
            page: 1,
            total: 1,
          };
        }
        if (options.parentId === root.id) {
          return {
            items: parents.map((parent) => tag(parent.id, parent.name, root.id, 1, [root])),
            page: 1,
            total: parents.length,
          };
        }
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => {
          setTimeout(resolve, 2);
        });
        active -= 1;
        const parent = parents.find((candidate) => candidate.id === options.parentId);
        return {
          items: [tag(
            `leaf-${options.parentId}`,
            'Leaf',
            options.parentId,
            0,
            [root, parent],
          )],
          page: 1,
          total: 1,
        };
      }),
    };

    await loadTagTreeSnapshot(
      transport,
      WORKSPACE,
      PROJECT,
      fakeLog(),
      { rootName: 'tag' },
    );

    expect(peak).to.equal(MAX_TREE_CONCURRENCY);
  });
});
