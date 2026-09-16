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

import { createHmac } from 'node:crypto';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  handleSearchTags,
  handleSearchTagsSubworkspace,
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

function signedCursor(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function rewriteCursor(cursor, update) {
  const [encoded] = cursor.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  return signedCursor({ ...payload, ...update });
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
    const tieFamily = { id: 'family-tie', name: 'Tie' };
    const items = [
      item('exact-b', 'Alpha', [root, familyB, { id: 'exact-b', name: 'Alpha' }]),
      item('tie-b', 'Alpha', [root, tieFamily, { id: 'tie-b', name: 'Alpha' }]),
      item('path', 'Leaf', [root, { id: 'alpha-path', name: 'Alpha Path' }, { id: 'path', name: 'Leaf' }]),
      item('substring', 'XalphaY', [root, { id: 'family-c', name: 'C' }, { id: 'substring', name: 'XalphaY' }]),
      item('prefix', 'Alphabet', [root, { id: 'family-d', name: 'D' }, { id: 'prefix', name: 'Alphabet' }]),
      item('tie-a', 'Alpha', [root, tieFamily, { id: 'tie-a', name: 'Alpha' }]),
      item('exact-a', 'Alpha', [root, familyA, { id: 'exact-a', name: 'Alpha' }]),
    ];

    expect(searchTagSnapshot({ items }, 'alpha').map((entry) => entry.id))
      .to.deep.equal([
        'exact-a',
        'exact-b',
        'tie-a',
        'tie-b',
        'prefix',
        'substring',
        'path',
      ]);
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

  it('rejects invalid selectors, a missing query, and malformed cursor payloads', async () => {
    const transport = deepTransport();
    for (const query of [
      { geoTargetId: 'nope', languageCode: 'en', q: 'needle' },
      { geoTargetId: 2840, languageCode: '', q: 'needle' },
      { geoTargetId: 2840, languageCode: 'en' },
      {
        geoTargetId: 2840, languageCode: 'en', q: 'needle', cursor: 'malformed',
      },
      {
        geoTargetId: 2840,
        languageCode: 'en',
        q: 'needle',
        cursor: signedCursor({
          v: 1,
          offset: 'invalid',
          q: 'needle',
          project: `${WORKSPACE}:${PROJECT}`,
          revision: 'revision',
        }),
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

  it('rejects missing cursor signing, request-mismatched cursors, and invalid offsets', async () => {
    const transport = deepTransport();
    await expect(handleSearchTags(
      transport,
      dataAccess(),
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: 'needle', limit: 1,
      },
      fakeLog(),
      undefined,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(503);
      expect(error.code).to.equal(ERROR_CODES.TAG_SEARCH_UNAVAILABLE);
    });

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
        q: 'different',
        limit: 1,
        cursor: first.cursor,
      },
      fakeLog(),
      SECRET,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(400);
      expect(error.code).to.equal(ERROR_CODES.TAG_SEARCH_CURSOR_INVALID);
    });
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
        cursor: rewriteCursor(first.cursor, { offset: 999 }),
      },
      fakeLog(),
      SECRET,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(400);
      expect(error.code).to.equal(ERROR_CODES.TAG_SEARCH_CURSOR_INVALID);
    });
  });

  it('returns marketNotFound for missing flat and subworkspace slices', async () => {
    const missingDataAccess = dataAccess();
    missingDataAccess.BrandSemrushProject.findBySlice.resolves(null);
    await expect(handleSearchTags(
      deepTransport(),
      missingDataAccess,
      BRAND,
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: 'needle',
      },
      fakeLog(),
      SECRET,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(404);
      expect(error.code).to.equal(ERROR_CODES.MARKET_NOT_FOUND);
    });

    await expect(handleSearchTagsSubworkspace(
      { listProjects: sinon.stub().resolves({ items: [] }) },
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: 'needle',
      },
      fakeLog(),
      SECRET,
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(404);
      expect(error.code).to.equal(ERROR_CODES.MARKET_NOT_FOUND);
    });
  });

  it('searches the resolved subworkspace project', async () => {
    const transport = {
      ...deepTransport(),
      listProjects: sinon.stub().resolves({
        items: [{
          id: PROJECT,
          settings: {
            ai: {
              location: { id: 2840 },
              language: { name: 'en' },
            },
          },
        }],
      }),
    };

    const result = await handleSearchTagsSubworkspace(
      transport,
      WORKSPACE,
      {
        geoTargetId: 2840, languageCode: 'en', q: 'needle',
      },
      fakeLog(),
      SECRET,
    );

    expect(result.items.map((item) => item.id)).to.deep.equal(['leaf', 'other-leaf']);
    expect(transport.listProjects).to.have.been.calledOnceWith(WORKSPACE);
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

  it('fails explicitly when traversal duration or initial-root node budgets are exhausted', async () => {
    const roots = {
      listProjectTags: sinon.stub().resolves({
        items: [
          tag('category-root', 'category', null, 0),
          tag('tag-root', 'tag', null, 0),
        ],
        page: 1,
        total: 2,
      }),
    };
    await expect(loadTagTreeSnapshot(
      roots,
      WORKSPACE,
      PROJECT,
      fakeLog(),
      { maxDurationMs: 0 },
    )).to.be.rejected.then((error) => {
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_LIMIT_EXCEEDED);
      expect(error.details).to.deep.equal({ budget: 'duration', maximum: 0 });
    });
    await expect(loadTagTreeSnapshot(
      roots,
      WORKSPACE,
      PROJECT,
      fakeLog(),
      { maxNodes: 1 },
    )).to.be.rejected.then((error) => {
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_LIMIT_EXCEEDED);
      expect(error.details).to.deep.equal({ budget: 'nodes', maximum: 1 });
    });
  });

  it('stops a multi-page parent read mid-pagination once the traversal deadline expires '
    + '(deterministic fake timers)', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now() });
    try {
      const root = { id: 'tag-root', name: 'tag' };
      const transport = {
        listProjectTags: sinon.stub().callsFake((_workspace, _project, options) => {
          if (!options.parentId) {
            return Promise.resolve({
              items: [tag(root.id, root.name, null, 1)],
              page: 1,
              total: 1,
            });
          }
          // Every page for the root's children is a FULL page against a large
          // total, so `listProjectTagTree`'s internal loop keeps requesting more
          // pages — this is the "in-flight pagination" the deadline must reach.
          if (options.page === 2) {
            // Simulate real elapsed time between page 1 and page 2 landing —
            // deterministic, not a real setTimeout wait.
            clock.tick(1_000);
          }
          const items = Array.from({ length: TAG_TREE_PAGE_SIZE }, (_, index) => tag(
            `${root.id}-p${options.page}-${index}`,
            `Leaf ${options.page}-${index}`,
            root.id,
            0,
            [root],
          ));
          return Promise.resolve({ items, page: options.page, total: 500 });
        }),
      };

      await expect(loadTagTreeSnapshot(
        transport,
        WORKSPACE,
        PROJECT,
        fakeLog(),
        { rootName: 'tag', maxDurationMs: 500 },
      )).to.be.rejected.then((error) => {
        expect(error.code).to.equal(ERROR_CODES.TAG_TREE_LIMIT_EXCEEDED);
        expect(error.details).to.deep.equal({ budget: 'duration', maximum: 500 });
      });

      // Root read (1) + page 1 + page 2 of the parent read = 3 upstream calls.
      // The clock crossed the 500ms budget while page 2 was in flight, so the
      // per-page deadline check fires before a page 3 request ever goes out.
      expect(transport.listProjectTags.callCount).to.equal(3);
    } finally {
      clock.restore();
    }
  });

  it('bounds an already in-flight parent page request past the real traversal deadline — '
    + 'not just gates the next page', async () => {
    // Real (not fake) timers: `AbortSignal.timeout` is a platform timer, not
    // driven by sinon's faked `setTimeout` — see the fake-timer test above for
    // the synchronous `onBeforePage` path, and this one for the abort-based
    // in-flight bound. The parent page's promise NEVER resolves on its own —
    // only the deadline signal ends it.
    const root = { id: 'tag-root', name: 'tag' };
    let pageTwoStarted = false;
    let capturedSignal;
    const transport = {
      listProjectTags: sinon.stub().callsFake((_workspace, _project, options) => {
        if (!options.parentId) {
          return Promise.resolve({ items: [tag(root.id, root.name, null, 1)], page: 1, total: 1 });
        }
        if (options.page === 2) {
          pageTwoStarted = true;
          return Promise.resolve({ items: [], page: 2, total: 0 });
        }
        // Page 1 of the parent read: capture the signal `listProjectTagTree`
        // forwarded, then hang forever — an already-in-flight request against
        // a sleeping/retrying shared client.
        capturedSignal = options.signal;
        return new Promise(() => {});
      }),
    };

    await expect(loadTagTreeSnapshot(
      transport,
      WORKSPACE,
      PROJECT,
      fakeLog(),
      { rootName: 'tag', maxDurationMs: 30 },
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(503);
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_LIMIT_EXCEEDED);
      expect(error.details).to.deep.equal({ budget: 'duration', maximum: 30 });
    });

    expect(capturedSignal).to.exist;
    expect(capturedSignal.aborted).to.equal(true);
    // The pending page 1 request never settled — page 2 is never attempted.
    expect(pageTwoStarted).to.equal(false);
  });

  it('fails closed when the traversal signal is already expired', async () => {
    const controller = new AbortController();
    controller.abort();
    const timeoutStub = sinon.stub(AbortSignal, 'timeout').returns(controller.signal);
    const transport = {
      listProjectTags: sinon.stub().resolves({ items: [], page: 1, total: 0 }),
    };

    try {
      await expect(loadTagTreeSnapshot(
        transport,
        WORKSPACE,
        PROJECT,
        fakeLog(),
        { rootName: 'tag', maxDurationMs: 500 },
      )).to.be.rejected.then((error) => {
        expect(error.status).to.equal(503);
        expect(error.code).to.equal(ERROR_CODES.TAG_TREE_LIMIT_EXCEEDED);
        expect(error.details).to.deep.equal({ budget: 'duration', maximum: 500 });
      });
    } finally {
      timeoutStub.restore();
    }
  });

  it('rejects duplicate selected roots and child parent mismatches', async () => {
    await expect(loadTagTreeSnapshot(
      {
        listProjectTags: sinon.stub().resolves({
          items: [
            tag('category-a', 'category', null, 0),
            tag('category-b', 'category', null, 0),
          ],
          page: 1,
          total: 2,
        }),
      },
      WORKSPACE,
      PROJECT,
      fakeLog(),
      { rootName: 'category', strict: true },
    )).to.be.rejected.then((error) => {
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_DATA_INTEGRITY);
      expect(error.details).to.deep.equal({ reason: 'ambiguousRoot', rootName: 'category' });
    });

    const root = { id: 'tag-root', name: 'tag' };
    await expect(loadTagTreeSnapshot(
      {
        listProjectTags: sinon.stub().callsFake((_workspace, _project, options) => (
          Promise.resolve({
            items: options.parentId
              ? [tag('child', 'Child', 'wrong-parent', 0, [root])]
              : [tag(root.id, root.name, null, 1)],
            page: options.page,
            total: 1,
          })
        )),
      },
      WORKSPACE,
      PROJECT,
      fakeLog(),
      { rootName: 'tag', strict: true },
    )).to.be.rejected.then((error) => {
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_DATA_INTEGRITY);
      expect(error.details).to.deep.equal({ reason: 'parentMismatch', tagId: 'child' });
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

  it('rejects repeated ids and cycles as data-integrity failures in strict mode', async () => {
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
      { rootName: 'tag', strict: true },
    )).to.be.rejected.then((error) => {
      expect(error.status).to.equal(503);
      expect(error.code).to.equal(ERROR_CODES.TAG_TREE_DATA_INTEGRITY);
      expect(error.details.reason).to.equal('repeatedTagId');
    });
  });

  it('never exceeds the configured Semrush request concurrency in strict mode', async () => {
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
      { rootName: 'tag', strict: true },
    );

    expect(peak).to.equal(MAX_TREE_CONCURRENCY);
  });

  describe('legacy (non-strict) traversal — prior tolerant behavior', () => {
    it('defaults to a single in-flight parent read (no strict option passed)', async () => {
      const root = { id: 'tag-root', name: 'tag' };
      const parents = Array.from({ length: 4 }, (_, index) => ({
        id: `parent-${index}`,
        name: `Parent ${index}`,
      }));
      let active = 0;
      let peak = 0;
      const transport = {
        listProjectTags: sinon.stub().callsFake(async (_workspace, _project, options) => {
          if (!options.parentId) {
            return { items: [tag(root.id, root.name, null, 1)], page: 1, total: 1 };
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
          return { items: [], page: 1, total: 0 };
        }),
      };

      await loadTagTreeSnapshot(transport, WORKSPACE, PROJECT, fakeLog(), { rootName: 'tag' });

      expect(peak).to.equal(1);
    });

    it('skips a revisited tag id instead of throwing repeatedTagId', async () => {
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

      const snapshot = await loadTagTreeSnapshot(
        transport,
        WORKSPACE,
        PROJECT,
        fakeLog(),
        { rootName: 'tag' },
      );

      // The revisited id is skipped rather than expanded again or thrown on.
      expect(snapshot.items.map((item) => item.id)).to.deep.equal([root.id]);
    });

    it('trusts an upstream-supplied path over a parentId disagreement instead of throwing', async () => {
      const root = { id: 'tag-root', name: 'tag' };
      const transport = {
        listProjectTags: sinon.stub().callsFake((_workspace, _project, options) => (
          Promise.resolve({
            items: options.parentId
              ? [tag('child', 'Child', 'wrong-parent', 0, [root])]
              : [tag(root.id, root.name, null, 1)],
            page: options.page,
            total: 1,
          })
        )),
      };

      const snapshot = await loadTagTreeSnapshot(
        transport,
        WORKSPACE,
        PROJECT,
        fakeLog(),
        { rootName: 'tag' },
      );

      const child = snapshot.byId.get('child');
      expect(child).to.exist;
      expect(child.fullPath.map((part) => part.id)).to.deep.equal([root.id, 'child']);
    });

    it('tolerates case-variant and duplicate canonical roots instead of failing closed', async () => {
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

      const snapshot = await loadTagTreeSnapshot(
        transport,
        WORKSPACE,
        PROJECT,
        fakeLog(),
      );

      expect(snapshot.items.map((item) => item.id).sort())
        .to.deep.equal(['tag-root', 'variant-root']);
    });
  });
});
