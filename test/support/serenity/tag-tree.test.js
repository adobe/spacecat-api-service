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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  indexLevelByName,
  ensureChildren,
  ensureDimensionRoots,
  provisionDimensionTree,
  ensureServerOwnedValue,
  resolveTypeValueInjection,
  resolveClosedValueInjection,
  findTagsInTree,
  assertParentWithinDimension,
} from '../../../src/support/serenity/tag-tree.js';
import { DIMENSION } from '../../../src/support/serenity/prompt-tags.js';
import {
  TAG_IDS,
  dimensionTreeLevels,
  makeListProjectTagsStub,
  makeProvisioningTransportStubs,
} from './fixtures/tag-tree.js';

use(chaiAsPromised);
use(sinonChai);

const WS = 'ws-1';
const PROJECT = 'proj-1';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(),
  };
}

describe('serenity tag-tree', () => {
  describe('indexLevelByName', () => {
    it('indexes one level by bare name and never descends into it', async () => {
      const listProjectTags = makeListProjectTagsStub();
      const transport = { listProjectTags };
      const parent = TAG_IDS.categoryRoot;
      const byName = await indexLevelByName(transport, WS, PROJECT, parent, fakeLog());
      expect([...byName.keys()]).to.deep.equal(['Running Shoes']);
      expect(byName.get('Running Shoes')).to.equal(TAG_IDS.categoryRunningShoes);
      // Exactly one level read — the sub-category beneath it is not fetched.
      expect(listProjectTags).to.have.been.calledOnce;
    });

    it('reads the DRAFT view, so a just-created tag is visible to the next resolve', async () => {
      const listProjectTags = makeListProjectTagsStub();
      await indexLevelByName({ listProjectTags }, WS, PROJECT, '', fakeLog());
      expect(listProjectTags.firstCall.args[2]).to.include({ parentId: '', draft: true });
    });

    it('keeps the first entry when upstream drifts and returns a duplicate name', async () => {
      const listProjectTags = makeListProjectTagsStub({
        '': [
          { id: 'first', name: 'category', children_count: 0 },
          { id: 'second', name: 'category', children_count: 0 },
        ],
      });
      const byName = await indexLevelByName({ listProjectTags }, WS, PROJECT, '', fakeLog());
      expect(byName.get('category')).to.equal('first');
    });

    it('skips a row carrying no name', async () => {
      const listProjectTags = makeListProjectTagsStub({
        '': [{ id: 'nameless', children_count: 0 }],
      });
      const byName = await indexLevelByName({ listProjectTags }, WS, PROJECT, '', fakeLog());
      expect(byName.size).to.equal(0);
    });
  });

  describe('ensureChildren', () => {
    it('creates nothing and reports no creates when every name already exists', async () => {
      const transport = {
        listProjectTags: makeListProjectTagsStub(),
        createProjectTags: sinon.stub(),
      };
      const wanted = ['branded', 'non-branded'];
      const parent = TAG_IDS.typeRoot;
      const { byName, createdNames } = await ensureChildren(
        transport,
        WS,
        PROJECT,
        parent,
        wanted,
        fakeLog(),
      );
      expect(createdNames).to.deep.equal([]);
      expect(byName.get('branded')).to.equal(TAG_IDS.typeBranded);
      // Upstream 500s on a duplicate (parent, name), so this must never fire.
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('creates only the missing names, in one call, under the requested parent', async () => {
      const levels = dimensionTreeLevels();
      levels[TAG_IDS.typeRoot] = [{
        id: TAG_IDS.typeBranded, name: 'branded', parent_id: TAG_IDS.typeRoot, children_count: 0,
      }];
      const transport = {
        listProjectTags: makeListProjectTagsStub(levels),
        createProjectTags: sinon.stub().resolves([
          { id: 'new-nb', name: 'non-branded', parent_id: TAG_IDS.typeRoot },
        ]),
      };
      const wanted = ['branded', 'non-branded'];
      const parent = TAG_IDS.typeRoot;
      const { byName, createdNames } = await ensureChildren(
        transport,
        WS,
        PROJECT,
        parent,
        wanted,
        fakeLog(),
      );
      expect(createdNames).to.deep.equal(['non-branded']);
      expect(transport.createProjectTags).to.have.been.calledOnceWithExactly(
        WS,
        PROJECT,
        ['non-branded'],
        { parentId: TAG_IDS.typeRoot },
      );
      expect(byName.get('branded')).to.equal(TAG_IDS.typeBranded);
      expect(byName.get('non-branded')).to.equal('new-nb');
    });

    it('omits parent_id entirely when creating at the root level', async () => {
      const { listProjectTags, createProjectTags } = makeProvisioningTransportStubs();
      const transport = { listProjectTags, createProjectTags };
      await ensureChildren(transport, WS, PROJECT, '', ['category'], fakeLog());
      // An empty parent is a no-op upstream; sending it needlessly widens the wire.
      expect(createProjectTags.firstCall.args[3]).to.deep.equal({});
    });

    // Upstream echoes the created nodes back. If it echoes fewer than requested,
    // the map would silently omit a name the caller asked for, and the atomic
    // id-based prompt write would then 500 on the missing id.
    it('re-reads the level when upstream echoes fewer nodes than requested', async () => {
      const levels = { '': [] };
      const listProjectTags = sinon.stub();
      listProjectTags.onFirstCall().resolves({ items: levels[''] });
      listProjectTags.onSecondCall().resolves({
        items: [
          { id: 'r-cat', name: 'category', children_count: 0 },
          { id: 'r-int', name: 'intent', children_count: 0 },
        ],
      });
      const transport = {
        listProjectTags,
        // Only one of the two requested nodes comes back.
        createProjectTags: sinon.stub().resolves([{ id: 'r-cat', name: 'category' }]),
      };
      const log = fakeLog();
      const { byName, createdNames } = await ensureChildren(
        transport,
        WS,
        PROJECT,
        '',
        ['category', 'intent'],
        log,
      );
      expect(listProjectTags).to.have.been.calledTwice;
      expect(byName.get('intent')).to.equal('r-int');
      // `intent` was resolved by the re-read, not minted by this call's echo, so it
      // is NOT claimed. Claiming it would report `created: true` for a tag another
      // writer may have won.
      expect(createdNames).to.deep.equal(['category']);
      expect(log.warn).to.have.been.calledWithMatch(/echoed fewer nodes than requested/);
    });

    it('ignores a malformed created node rather than mapping a name to an empty id', async () => {
      const listProjectTags = sinon.stub();
      listProjectTags.onFirstCall().resolves({ items: [] });
      listProjectTags.onSecondCall().resolves({
        items: [{ id: 'real', name: 'category', children_count: 0 }],
      });
      const transport = {
        listProjectTags,
        createProjectTags: sinon.stub().resolves([{ id: '', name: 'category' }]),
      };
      const { byName } = await ensureChildren(transport, WS, PROJECT, '', ['category'], fakeLog());
      expect(byName.get('category')).to.equal('real');
    });

    it('tolerates a non-array create response by re-reading the level', async () => {
      const listProjectTags = sinon.stub();
      listProjectTags.onFirstCall().resolves({ items: [] });
      listProjectTags.onSecondCall().resolves({
        items: [{ id: 'r-cat', name: 'category', children_count: 0 }],
      });
      const transport = {
        listProjectTags,
        createProjectTags: sinon.stub().resolves(null),
      };
      const { byName } = await ensureChildren(transport, WS, PROJECT, '', ['category'], fakeLog());
      expect(byName.get('category')).to.equal('r-cat');
    });

    it('502s when the create answers 2xx but the draft re-read still lacks the name', async () => {
      // The live draft-layer failure: a 201 that echoes nothing and changes nothing.
      // Returning a map with a hole here is what let a caller answer 200 with an
      // `undefined` tag id and `created: true`.
      const listProjectTags = sinon.stub().resolves({ items: [] });
      const transport = { listProjectTags, createProjectTags: sinon.stub().resolves([]) };
      const err = await ensureChildren(transport, WS, PROJECT, '', ['category'], fakeLog())
        .then(() => null, (e) => e);
      expect(err).to.be.an('error');
      expect(err.status).to.equal(502);
      expect(err.message).to.match(/did not persist the tag\(s\): category/);
    });

    it('resolves rather than fails when a concurrent writer minted the names first', async () => {
      // Upstream answers 500 on a duplicate (parent, name). Resolve-before-create is
      // not atomic, so the loser of a race must re-read and resolve, not blow up.
      const listProjectTags = sinon.stub();
      listProjectTags.onFirstCall().resolves({ items: [] });
      listProjectTags.onSecondCall().resolves({
        items: [{ id: 'raced-cat', name: 'category', children_count: 0 }],
      });
      const transport = {
        listProjectTags,
        createProjectTags: sinon.stub().rejects(new Error('upstream 500: duplicate tag')),
      };
      const log = fakeLog();
      const { byName, createdNames } = await ensureChildren(transport, WS, PROJECT, '', ['category'], log);
      expect(byName.get('category')).to.equal('raced-cat');
      // We did not mint it, so we must not claim we did.
      expect(createdNames).to.deep.equal([]);
      expect(log.info).to.have.been.calledWithMatch(/lost a create race/);
    });

    it('rethrows the create failure when the re-read does not explain it', async () => {
      const listProjectTags = sinon.stub().resolves({ items: [] });
      const transport = {
        listProjectTags,
        createProjectTags: sinon.stub().rejects(new Error('upstream 503: unavailable')),
      };
      await expect(ensureChildren(transport, WS, PROJECT, '', ['category'], fakeLog()))
        .to.be.rejectedWith(/upstream 503: unavailable/);
    });
  });

  describe('ensureDimensionRoots', () => {
    it('resolves all five roots without creating them when they exist', async () => {
      const transport = {
        listProjectTags: makeListProjectTagsStub(),
        createProjectTags: sinon.stub(),
      };
      const roots = await ensureDimensionRoots(transport, WS, PROJECT, fakeLog());
      // Membership, not a count — a further open root is contemplated (source-dimension.md).
      expect([...roots.keys()]).to.include.members(['category', 'intent', 'origin', 'type', 'source']);
      // The producing-system `source` root resolves (the fixture's `source` root is
      // not authorship), distinct from the `origin` root.
      expect(roots.get('source')).to.equal(TAG_IDS.sourceRoot);
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('brings a project that predates the taxonomy forward on first touch', async () => {
      const { listProjectTags, createProjectTags } = makeProvisioningTransportStubs();
      const transport = { listProjectTags, createProjectTags };
      const roots = await ensureDimensionRoots(transport, WS, PROJECT, fakeLog());
      expect(createProjectTags).to.have.been.calledOnce;
      expect(createProjectTags.firstCall.args[2])
        .to.deep.equal(['category', 'intent', 'origin', 'type', 'source']);
      expect(roots.get('type')).to.equal('created::type');
      // A fresh project mints the producing-system `source` root outright.
      expect(roots.get('source')).to.equal('created::source');
    });

    it('adopts a legacy `source` authorship root in place, minting no second `origin`', async () => {
      // A project the reshape has not yet renamed: its authorship root is still `source`,
      // with `ai`/`human` beneath it (origin-dimension.md §7 gate 3).
      const legacyLevels = {
        '': [
          { id: 'root-category', name: 'category', children_count: 0 },
          { id: 'root-intent', name: 'intent', children_count: 5 },
          { id: 'root-source', name: 'source', children_count: 2 },
          { id: 'root-type', name: 'type', children_count: 2 },
        ],
        'root-source': [
          { id: 'legacy-ai', name: 'ai', parent_id: 'root-source' },
          { id: 'legacy-human', name: 'human', parent_id: 'root-source' },
        ],
      };
      const transport = {
        listProjectTags: makeListProjectTagsStub(legacyLevels),
        createProjectTags: sinon.stub(),
      };
      const roots = await ensureDimensionRoots(transport, WS, PROJECT, fakeLog());
      // The `origin` key maps to the physical `source` root — adopted in place …
      expect(roots.get('origin')).to.equal('root-source');
      // … and NOTHING was created: no empty second authorship root (spec §8).
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('does NOT adopt a `source` root carrying non-authorship values; creates `origin`', async () => {
      // The companion producing-system `source` dimension (source-dimension.md §9): its
      // children are not {ai, human}, so it must not be mistaken for authorship.
      const created = [];
      const levels = {
        '': [
          { id: 'root-category', name: 'category', children_count: 0 },
          { id: 'root-intent', name: 'intent', children_count: 5 },
          { id: 'root-source', name: 'source', children_count: 1 },
          { id: 'root-type', name: 'type', children_count: 2 },
        ],
        'root-source': [{ id: 'src-config', name: 'config', parent_id: 'root-source' }],
      };
      const transport = {
        listProjectTags: makeListProjectTagsStub(levels),
        createProjectTags: sinon.stub().callsFake((ws, pid, names) => {
          created.push(...names);
          return Promise.resolve(names.map((n) => ({ id: `made-${n}`, name: n })));
        }),
      };
      const roots = await ensureDimensionRoots(transport, WS, PROJECT, fakeLog());
      expect(created).to.deep.equal(['origin']);
      expect(roots.get('origin')).to.equal('made-origin');
    });

    it('prefers `origin` over a legacy `source` when a project carries BOTH roots', async () => {
      // A partially-migrated project: the new `origin` root already exists alongside
      // the not-yet-cleaned-up legacy `source` root. `origin` must win, and the
      // orphan `source` is left untouched (removed at WP-O6) — never a second mint.
      const bothLevels = {
        '': [
          { id: 'root-category', name: 'category', children_count: 0 },
          { id: 'root-intent', name: 'intent', children_count: 5 },
          { id: 'root-origin', name: 'origin', children_count: 2 },
          { id: 'root-source', name: 'source', children_count: 2 },
          { id: 'root-type', name: 'type', children_count: 2 },
        ],
      };
      const transport = {
        listProjectTags: makeListProjectTagsStub(bothLevels),
        createProjectTags: sinon.stub(),
      };
      const roots = await ensureDimensionRoots(transport, WS, PROJECT, fakeLog());
      // The `origin` key resolves to the real `origin` root, not the legacy `source`.
      expect(roots.get('origin')).to.equal('root-origin');
      // Nothing was created and the orphan `source` was not touched.
      expect(transport.createProjectTags).to.not.have.been.called;
      // Performance contract: finding `origin` short-circuits before any legacy
      // adoption, so no child-level read of the orphan `source` — exactly ONE read.
      expect(transport.listProjectTags).to.have.callCount(1);
    });

    it('adopts a CHILDLESS legacy `source` root in place (vacuous authorship guard)', async () => {
      // The intentional vacuous-true branch of `childrenAreAuthorship`: a `source`
      // root not yet populated is still an authorship root, so it is adopted rather
      // than shadowed by a second `origin`. Documents the behavior until WP-O6.
      const childlessLevels = {
        '': [
          { id: 'root-category', name: 'category', children_count: 0 },
          { id: 'root-intent', name: 'intent', children_count: 5 },
          { id: 'root-source', name: 'source', children_count: 0 },
          { id: 'root-type', name: 'type', children_count: 2 },
        ],
        'root-source': [],
      };
      const transport = {
        listProjectTags: makeListProjectTagsStub(childlessLevels),
        createProjectTags: sinon.stub(),
      };
      const roots = await ensureDimensionRoots(transport, WS, PROJECT, fakeLog());
      expect(roots.get('origin')).to.equal('root-source');
      expect(transport.createProjectTags).to.not.have.been.called;
    });
  });

  describe('provisionDimensionTree', () => {
    it('resolves the roots plus every closed vocabulary, leaving category empty', async () => {
      const transport = {
        listProjectTags: makeListProjectTagsStub(),
        createProjectTags: sinon.stub(),
      };
      const { roots, values } = await provisionDimensionTree(transport, WS, PROJECT, fakeLog());

      expect(roots.get('category')).to.equal(TAG_IDS.categoryRoot);
      expect([...values.keys()]).to.deep.equal(['intent', 'origin', 'type']);
      // The open dimension's children are customer content, never provisioned.
      expect(values.has('category')).to.equal(false);
      expect([...values.get('intent').keys()]).to.deep.equal([
        'Informational', 'Task', 'Commercial', 'Transactional', 'Navigational',
      ]);
      expect(values.get('type').get('branded')).to.equal(TAG_IDS.typeBranded);
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('provisions the whole fixed taxonomy on an empty project', async () => {
      const { listProjectTags, createProjectTags } = makeProvisioningTransportStubs();
      const transport = { listProjectTags, createProjectTags };
      const { values } = await provisionDimensionTree(transport, WS, PROJECT, fakeLog());
      // Roots first, then one call per closed dimension.
      expect(createProjectTags).to.have.callCount(4);
      expect(values.get('origin').get('ai')).to.equal('created:created::origin:ai');
      expect(values.get('intent').get('Navigational'))
        .to.equal('created:created::intent:Navigational');
    });

    it('502s rather than return a values map missing a dimension', async () => {
      // Upstream drift: the roots read answers without the `type` root, and the
      // create echoes nothing back for it either. A caller must never receive a
      // map it has to re-check.
      const listProjectTags = makeListProjectTagsStub({
        '': [
          { id: 'r-cat', name: 'category', children_count: 0 },
          { id: 'r-int', name: 'intent', children_count: 0 },
          { id: 'r-src', name: 'source', children_count: 0 },
        ],
        'r-int': [],
        'r-src': [],
      });
      const transport = {
        listProjectTags,
        createProjectTags: sinon.stub().callsFake((ws, pid, names, opts) => Promise.resolve(
          names
            .filter((n) => n !== 'type')
            .map((n) => ({ id: `made-${n}`, name: n, parent_id: opts.parentId || null })),
        )),
      };
      const err = await provisionDimensionTree(transport, WS, PROJECT, fakeLog())
        .then(() => null, (e) => e);
      expect(err).to.be.an('error');
      expect(err.status).to.equal(502);
      expect(err.message).to.match(/did not persist the tag\(s\): type/);
    });

    it('resolves the three closed vocabularies concurrently, one level read each', async () => {
      const listProjectTags = makeListProjectTagsStub();
      const transport = { listProjectTags, createProjectTags: sinon.stub() };
      const { roots, values } = await provisionDimensionTree(transport, WS, PROJECT, fakeLog());
      expect([...roots.keys()]).to.include.members(['category', 'intent', 'origin', 'type', 'source']);
      expect(values.get('origin')?.get('ai')).to.equal(TAG_IDS.originAi);
      expect(values.get('type')?.get('branded')).to.equal(TAG_IDS.typeBranded);
      // The open `category` root is provisioned but its children are customer content.
      expect(values.has('category')).to.equal(false);
      expect(transport.createProjectTags).to.not.have.been.called;
    });
  });

  describe('ensureServerOwnedValue', () => {
    it('resolves an existing value and reports created:false', async () => {
      const transport = {
        listProjectTags: makeListProjectTagsStub(),
        createProjectTags: sinon.stub(),
      };
      const res = await ensureServerOwnedValue(transport, WS, PROJECT, 'origin', 'ai', fakeLog());
      expect(res).to.deep.equal({
        id: TAG_IDS.originAi, rootId: TAG_IDS.originRoot, created: false,
      });
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('creates a missing value under its root and reports created:true', async () => {
      const levels = dimensionTreeLevels();
      levels[TAG_IDS.originRoot] = [];
      const transport = {
        listProjectTags: makeListProjectTagsStub(levels),
        createProjectTags: sinon.stub().resolves([
          { id: 'made-ai', name: 'ai', parent_id: TAG_IDS.originRoot },
        ]),
      };
      const res = await ensureServerOwnedValue(transport, WS, PROJECT, 'origin', 'ai', fakeLog());
      expect(res).to.deep.equal({
        id: 'made-ai', rootId: TAG_IDS.originRoot, created: true,
      });
    });

    it('502s rather than hand back an undefined id when the root cannot be resolved', async () => {
      const transport = {
        listProjectTags: makeListProjectTagsStub({ '': [] }),
        // The create echoes nothing, so no root id is ever learned.
        createProjectTags: sinon.stub().resolves([]),
      };
      const err = await ensureServerOwnedValue(transport, WS, PROJECT, 'origin', 'ai', fakeLog())
        .then(() => null, (e) => e);
      expect(err).to.be.an('error');
      expect(err.status).to.equal(502);
    });
  });

  // FIX (MysticatBot nit): direct coverage of the generalized resolver. It was
  // previously exercised only indirectly through the `resolveTypeValueInjection`
  // wrapper and `makePromptTagInjector`; these tests hit it straight, for the
  // `origin` dimension. NOTE: the actual gate-8 strip (dropping a caller-supplied
  // id that collides by NAME but not by root) lives in `makePromptTagInjector`,
  // not here — this resolver only returns the strip SET (`valueTagIds`), scoped to
  // the dimension root. So these tests pin that the returned set is root-scoped;
  // the strip behaviour itself is covered by the injector tests in prompts.test.js.
  describe('resolveClosedValueInjection', () => {
    it('resolves an `origin` value id plus EVERY id under the origin root (strip set)', async () => {
      const transport = {
        listProjectTags: makeListProjectTagsStub(),
        createProjectTags: sinon.stub(),
      };
      const res = await resolveClosedValueInjection(transport, WS, PROJECT, DIMENSION.ORIGIN, 'human', fakeLog());
      expect(res.computedId).to.equal(TAG_IDS.originHuman);
      // Strip set is every id under the ORIGIN root — the two closed values only.
      expect(res.valueTagIds).to.have.members([TAG_IDS.originAi, TAG_IDS.originHuman]);
      // REGRESSION GUARD (not active filter validation): a customer sub-category
      // also named `human` (subCategoryHuman) lives under the CATEGORY root. The
      // resolver only reads the ORIGIN root's children, so this id is excluded BY
      // CONSTRUCTION rather than by any filter in the SUT — the assertion locks in
      // that the strip set stays root-scoped (never widens to a name match) should
      // the resolution ever change to read more of the tree.
      expect(res.valueTagIds).to.not.include(TAG_IDS.subCategoryHuman);
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('resolves the `ai` origin value id', async () => {
      const transport = {
        listProjectTags: makeListProjectTagsStub(),
        createProjectTags: sinon.stub(),
      };
      const res = await resolveClosedValueInjection(transport, WS, PROJECT, DIMENSION.ORIGIN, 'ai', fakeLog());
      expect(res.computedId).to.equal(TAG_IDS.originAi);
      expect(res.valueTagIds).to.have.members([TAG_IDS.originAi, TAG_IDS.originHuman]);
      expect(transport.createProjectTags).to.not.have.been.called;
    });
  });

  // A MID-RENAME project (legacy `source` root carrying ai/human, no `origin`):
  // ensureDimensionRoots adopts `source` as authorship and leaves the producing
  // `source` key undefined. The server-owned resolve paths must fail LOUD rather
  // than let an undefined root id degrade into a stranded root-level create.
  describe('source root distinctness guard (mid-rename, WP-O6-gated)', () => {
    const midRenameLevels = () => ({
      '': [
        { id: 'root-category', name: 'category', children_count: 0 },
        { id: 'root-intent', name: 'intent', children_count: 5 },
        { id: 'root-source', name: 'source', children_count: 2 },
        { id: 'root-type', name: 'type', children_count: 2 },
      ],
      'root-source': [
        { id: 'legacy-ai', name: 'ai', parent_id: 'root-source' },
        { id: 'legacy-human', name: 'human', parent_id: 'root-source' },
      ],
    });

    it('ensureDimensionRoots leaves the producing `source` key undefined', async () => {
      const transport = {
        listProjectTags: makeListProjectTagsStub(midRenameLevels()),
        createProjectTags: sinon.stub(),
      };
      const roots = await ensureDimensionRoots(transport, WS, PROJECT, fakeLog());
      expect(roots.get('origin')).to.equal('root-source');
      expect(roots.get('source')).to.equal(undefined);
    });

    it('ensureServerOwnedValue(source) throws a clear 502 and issues NO root-level create', async () => {
      const createProjectTags = sinon.stub();
      const transport = {
        listProjectTags: makeListProjectTagsStub(midRenameLevels()),
        createProjectTags,
      };
      const err = await ensureServerOwnedValue(transport, WS, PROJECT, 'source', 'config', fakeLog())
        .then(() => null, (e) => e);
      expect(err).to.be.an('error');
      expect(err.status).to.equal(502);
      expect(err.message).to.match(/source dimension root not provisioned/);
      expect(createProjectTags).to.not.have.been.called;
    });

    it('resolveClosedValueInjection(source) — the injector path — throws and creates nothing', async () => {
      const createProjectTags = sinon.stub();
      const transport = {
        listProjectTags: makeListProjectTagsStub(midRenameLevels()),
        createProjectTags,
      };
      const err = await resolveClosedValueInjection(transport, WS, PROJECT, 'source', 'config', fakeLog())
        .then(() => null, (e) => e);
      expect(err).to.be.an('error');
      expect(err.status).to.equal(502);
      expect(err.message).to.match(/source dimension root not provisioned/);
      expect(createProjectTags).to.not.have.been.called;
    });
  });

  describe('resolveTypeValueInjection', () => {
    it('returns the wanted value id plus EVERY id under the type root', async () => {
      const transport = {
        listProjectTags: makeListProjectTagsStub(),
        createProjectTags: sinon.stub(),
      };
      const res = await resolveTypeValueInjection(transport, WS, PROJECT, 'branded', fakeLog());
      expect(res.computedId).to.equal(TAG_IDS.typeBranded);
      // The strip set is every type id — the caller may not set the value itself.
      expect(res.typeTagIds).to.have.members([TAG_IDS.typeBranded, TAG_IDS.typeNonBranded]);
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('creates the value on demand when a project predating the taxonomy lacks it', async () => {
      const { listProjectTags, createProjectTags } = makeProvisioningTransportStubs();
      const transport = { listProjectTags, createProjectTags };
      const res = await resolveTypeValueInjection(transport, WS, PROJECT, 'branded', fakeLog());
      expect(res.computedId).to.equal('created:created::type:branded');
      expect(res.typeTagIds).to.deep.equal(['created:created::type:branded']);
    });

    it('502s rather than skip injection when the type root cannot be resolved', async () => {
      // A prompt written without the server-computed `type` tag stays unclassified
      // forever: the client may not set that dimension itself. Fail the write.
      const transport = {
        listProjectTags: makeListProjectTagsStub({ '': [] }),
        createProjectTags: sinon.stub().resolves([]),
      };
      const err = await resolveTypeValueInjection(transport, WS, PROJECT, 'branded', fakeLog())
        .then(() => null, (e) => e);
      expect(err).to.be.an('error');
      expect(err.status).to.equal(502);
    });

    it('propagates a transport failure while reading the tag tree', async () => {
      const transport = {
        listProjectTags: sinon.stub().rejects(new Error('listProjectTags 502')),
        createProjectTags: sinon.stub(),
      };
      await expect(resolveTypeValueInjection(transport, WS, PROJECT, 'branded', fakeLog()))
        .to.be.rejectedWith(/listProjectTags 502/);
      expect(transport.createProjectTags).to.not.have.been.called;
    });
  });

  describe('findTagsInTree', () => {
    it('places several ids in one walk and reports each ancestry', async () => {
      const transport = { listProjectTags: makeListProjectTagsStub() };
      const found = await findTagsInTree(
        transport,
        WS,
        PROJECT,
        [TAG_IDS.subCategoryHuman, TAG_IDS.categoryRoot],
        fakeLog(),
      );
      expect(found.get(TAG_IDS.categoryRoot)).to.deep.equal({
        kind: 'root', parentId: null, rootName: 'category', ancestorIds: [],
      });
      expect(found.get(TAG_IDS.subCategoryHuman)).to.deep.include({
        kind: 'descendant', rootName: 'category',
      });
      expect(found.get(TAG_IDS.subCategoryHuman).ancestorIds).to.deep.equal([
        TAG_IDS.categoryRoot, TAG_IDS.categoryRunningShoes,
      ]);
    });

    it('stops walking as soon as every wanted id is placed', async () => {
      const transport = { listProjectTags: makeListProjectTagsStub() };
      await findTagsInTree(transport, WS, PROJECT, [TAG_IDS.categoryRunningShoes], fakeLog());
      // Root level, then the `category` root's children. The closed roots' levels
      // are never read, because the target was already placed.
      expect(transport.listProjectTags).to.have.been.calledTwice;
    });

    it('maps an id absent from the tree to unknown, alongside the ones it placed', async () => {
      const transport = { listProjectTags: makeListProjectTagsStub() };
      const found = await findTagsInTree(
        transport,
        WS,
        PROJECT,
        [TAG_IDS.originHuman, 'no-such-tag'],
        fakeLog(),
      );
      expect(found.get(TAG_IDS.originHuman).rootName).to.equal('origin');
      expect(found.get('no-such-tag')).to.deep.equal({
        kind: 'unknown', parentId: null, rootName: null, ancestorIds: [],
      });
    });
  });

  describe('findTagsInTree — single-id placement', () => {
    it('reports a dimension root as a root, with its own name as the dimension', async () => {
      const transport = { listProjectTags: makeListProjectTagsStub() };
      const placed = await findTagsInTree(transport, WS, PROJECT, [TAG_IDS.intentRoot], fakeLog());
      const found = placed.get(TAG_IDS.intentRoot);
      expect(found).to.deep.equal({
        kind: 'root', parentId: null, rootName: 'intent', ancestorIds: [],
      });
    });

    it('reports a depth-3 sub-category with the dimension it descends from', async () => {
      const transport = { listProjectTags: makeListProjectTagsStub() };
      const sub = TAG_IDS.subCategoryHuman;
      const found = (await findTagsInTree(transport, WS, PROJECT, [sub], fakeLog())).get(sub);
      expect(found.kind).to.equal('descendant');
      expect(found.parentId).to.equal(TAG_IDS.categoryRunningShoes);
      // The bare name `human` also exists under the `source` root. Ancestry, not
      // the name, decides the dimension.
      expect(found.rootName).to.equal('category');
      // Root first, the tag itself excluded — this is what the re-parent guard
      // tests membership against.
      expect(found.ancestorIds).to.deep.equal([
        TAG_IDS.categoryRoot, TAG_IDS.categoryRunningShoes,
      ]);
    });

    it('reports the same bare name under a different root as that other dimension', async () => {
      const transport = { listProjectTags: makeListProjectTagsStub() };
      const placed = await findTagsInTree(transport, WS, PROJECT, [TAG_IDS.originHuman], fakeLog());
      const found = placed.get(TAG_IDS.originHuman);
      expect(found.rootName).to.equal('origin');
    });

    it('reports an id absent from the tree as unknown', async () => {
      const transport = { listProjectTags: makeListProjectTagsStub() };
      const placed = await findTagsInTree(transport, WS, PROJECT, ['no-such-tag'], fakeLog());
      const found = placed.get('no-such-tag');
      expect(found).to.deep.equal({
        kind: 'unknown', parentId: null, rootName: null, ancestorIds: [],
      });
    });

    it('terminates on an upstream parentage cycle instead of walking forever', async () => {
      // `a` claims a child `b`, and `b` claims `a` right back.
      const transport = {
        listProjectTags: makeListProjectTagsStub({
          '': [{ id: 'a', name: 'category', children_count: 1 }],
          a: [{
            id: 'b', name: 'B', parent_id: 'a', children_count: 1,
          }],
          b: [{
            id: 'a', name: 'category', parent_id: 'b', children_count: 1,
          }],
        }),
      };
      const placed = await findTagsInTree(transport, WS, PROJECT, ['no-such-tag'], fakeLog());
      const found = placed.get('no-such-tag');
      expect(found.kind).to.equal('unknown');
    });

    it('502s rather than page a tree larger than the read budget', async () => {
      // A wide single level: one root, 250 children each claiming children of
      // their own. Bounding total reads (not per-level width) means an existing
      // tag is never reported absent — the walk refuses instead.
      const children = Array.from({ length: 250 }, (_, i) => ({
        id: `c${i}`, name: `C${i}`, parent_id: 'r-cat', children_count: 1,
      }));
      const levels = {
        '': [{ id: 'r-cat', name: 'category', children_count: 250 }],
        'r-cat': children,
      };
      for (const c of children) {
        levels[c.id] = [];
      }
      const transport = { listProjectTags: makeListProjectTagsStub(levels) };
      const err = await findTagsInTree(transport, WS, PROJECT, ['no-such-tag'], fakeLog())
        .then(() => null, (e) => e);
      expect(err).to.be.an('error');
      expect(err.status).to.equal(502);
      expect(err.message).to.match(/tag tree too large to resolve/);
    });
  });

  describe('assertParentWithinDimension', () => {
    it('accepts the dimension root itself as a parent', async () => {
      const transport = { listProjectTags: makeListProjectTagsStub() };
      await expect(assertParentWithinDimension(transport, WS, PROJECT, 'category', TAG_IDS.categoryRoot, fakeLog())).to.eventually.be.fulfilled;
    });

    it('accepts a descendant of the dimension root as a parent', async () => {
      const transport = { listProjectTags: makeListProjectTagsStub() };
      await expect(assertParentWithinDimension(transport, WS, PROJECT, 'category', TAG_IDS.categoryRunningShoes, fakeLog())).to.eventually.be.fulfilled;
    });

    it('400s on a parent that roots in a DIFFERENT dimension', async () => {
      const transport = { listProjectTags: makeListProjectTagsStub() };
      const err = await assertParentWithinDimension(transport, WS, PROJECT, 'category', TAG_IDS.intentRoot, fakeLog()).then(() => null, (e) => e);
      expect(err.status).to.equal(400);
      expect(err.message).to.match(/must be the "category" dimension root or one of its descendants/);
    });

    it('400s on a parent nested UNDER a closed root, not just on the root id', async () => {
      // The cheap check — comparing against the three closed root ids — passes here.
      // Ancestry is what catches it.
      const transport = { listProjectTags: makeListProjectTagsStub() };
      const err = await assertParentWithinDimension(transport, WS, PROJECT, 'category', TAG_IDS.originHuman, fakeLog()).then(() => null, (e) => e);
      expect(err.status).to.equal(400);
    });

    it('400s on a parent that does not resolve on this market', async () => {
      const transport = { listProjectTags: makeListProjectTagsStub() };
      const err = await assertParentWithinDimension(transport, WS, PROJECT, 'category', 'not-a-tag', fakeLog()).then(() => null, (e) => e);
      expect(err.status).to.equal(400);
      expect(err.message).to.match(/does not resolve to a tag on this market/);
    });
  });
});
