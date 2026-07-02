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
import esmock from 'esmock';

use(chaiAsPromised);
use(sinonChai);

const BRAND = '11111111-2222-3333-4444-555555555555';
const WORKSPACE = '22222222-3333-4444-5555-666666666666';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

// Default: an empty tree, so resolveTagTarget() resolves any tagId to
// 'unknown' unless a test overrides listProjectTags to place it as a root or
// a child. This preserves the legacy full-"<dimension>:<value>"-name
// behavior for every test that isn't specifically about child-target
// resolution.
function makeTransport(overrides = {}) {
  return {
    createProjectTags: sinon.stub().resolves([{ id: 'tag-1', name: 'category:Footwear' }]),
    updateProjectTag: sinon.stub().resolves({ id: 'tag-1', name: 'category:Footwear', parent_id: 'tag-parent' }),
    listProjectTags: sinon.stub().resolves({ page: 1, total: 0, items: [] }),
    ...overrides,
  };
}

// Stubs listProjectTags so resolveTagTarget() resolves `childId` as a CHILD
// of `rootId` (mirrors the live shape: children carry `parent_id`).
function makeChildTreeTransport(rootId, childId, overrides = {}) {
  const listProjectTags = sinon.stub();
  listProjectTags.withArgs(sinon.match.any, sinon.match.any, sinon.match({ parentId: '' }))
    .resolves({ page: 1, total: 1, items: [{ id: rootId, name: 'category:Footwear', children_count: 1 }] });
  listProjectTags.withArgs(sinon.match.any, sinon.match.any, sinon.match({ parentId: rootId }))
    .resolves({
      page: 1,
      total: 1,
      items: [{
        id: childId, name: 'Sneakers', parent_id: rootId, path: [{ id: rootId, name: 'category:Footwear' }],
      }],
    });
  return makeTransport({ listProjectTags, ...overrides });
}

// Stubs listProjectTags so resolveTagTarget() resolves `rootId` as a ROOT.
function makeRootTreeTransport(rootId, overrides = {}) {
  const listProjectTags = sinon.stub();
  listProjectTags.withArgs(sinon.match.any, sinon.match.any, sinon.match({ parentId: '' }))
    .resolves({ page: 1, total: 1, items: [{ id: rootId, name: 'category:Footwear', children_count: 0 }] });
  return makeTransport({ listProjectTags, ...overrides });
}

function makeDataAccess(findBySliceResult) {
  return {
    BrandSemrushProject: {
      findBySlice: sinon.stub().resolves(findBySliceResult),
    },
  };
}

const validBody = {
  type: 'category', name: 'Footwear', geoTargetId: 2840, languageCode: 'en',
};

describe('serenity tags handler (POST /serenity/tags)', () => {
  afterEach(() => sinon.restore());

  describe('handleCreateTag (flat mode)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('registers a category:<NAME> tag on the slice project and returns 201', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        validBody,
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body).to.include({
        brandId: BRAND,
        geoTargetId: 2840,
        languageCode: 'en',
        type: 'category',
        name: 'Footwear',
        tag: 'category:Footwear',
      });
      expect(transport.createProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', ['category:Footwear'], { parentId: undefined });
    });

    it('falls back to an undefined id when the upstream create response has no usable node (defensive)', async () => {
      const transport = makeTransport({ createProjectTags: sinon.stub().resolves([{}]) });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        validBody,
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body.id).to.equal(undefined);
      expect(res.body.parentId).to.equal(null);
    });

    it('supports the topic dimension (also free-form)', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, type: 'topic', name: 'Running Shoes' },
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body.tag).to.equal('topic:Running Shoes');
      expect(transport.createProjectTags.firstCall.args[2]).to.deep.equal(['topic:Running Shoes']);
    });

    it('404s (marketNotFound) when no project backs the slice', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess(null);
      await expect(
        handler.handleCreateTag(transport, dataAccess, BRAND, WORKSPACE, validBody, fakeLog()),
      ).to.be.rejected.then((err) => {
        expect(err.status).to.equal(404);
        expect(err.code).to.equal('marketNotFound');
      });
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s when type is not a recognized open or closed dimension', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      for (const type of ['bogus', '', undefined]) {
        // eslint-disable-next-line no-await-in-loop
        await expect(handler.handleCreateTag(
          transport,
          dataAccess,
          BRAND,
          WORKSPACE,
          { ...validBody, type },
          fakeLog(),
        )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s when name is missing, too long, contains a colon, or has control characters', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const bad = [
        { ...validBody, name: undefined },
        { ...validBody, name: '   ' },
        { ...validBody, name: 'x'.repeat(101) },
        { ...validBody, name: 'topic:smuggled' },
        { ...validBody, name: 'bad\u0000name' },
        { ...validBody, name: 'tab\there' },
      ];
      for (const body of bad) {
        // eslint-disable-next-line no-await-in-loop
        await expect(
          handler.handleCreateTag(transport, dataAccess, BRAND, WORKSPACE, body, fakeLog()),
        ).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s on a non-positive geoTargetId or malformed languageCode', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const bad = [
        { ...validBody, geoTargetId: 0 },
        { ...validBody, geoTargetId: 'abc' },
        { ...validBody, languageCode: 'EN_US!' },
        { ...validBody, languageCode: '' },
      ];
      for (const body of bad) {
        // eslint-disable-next-line no-await-in-loop
        await expect(
          handler.handleCreateTag(transport, dataAccess, BRAND, WORKSPACE, body, fakeLog()),
        ).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
    });
  });

  describe('handleCreateTag — closed dimensions (source/intent/type)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('creates a closed-dimension tag when it does not yet exist (200, created:true)', async () => {
      const transport = makeTransport({
        createProjectTags: sinon.stub().resolves([{ id: 'tag-source-ai', name: 'source:ai' }]),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        {
          type: 'source', name: 'ai', geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({
        tag: 'source:ai', id: 'tag-source-ai', parentId: null, created: true,
      });
      expect(transport.createProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', ['source:ai']);
    });

    it('resolves an EXISTING closed-dimension tag without creating a duplicate (200, created:false)', async () => {
      const listProjectTags = sinon.stub();
      listProjectTags.withArgs(sinon.match.any, sinon.match.any, sinon.match({ parentId: '' }))
        .resolves({
          page: 1, total: 1, items: [{ id: 'tag-intent-info', name: 'intent:Informational', children_count: 0 }],
        });
      const transport = makeTransport({ listProjectTags });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        {
          type: 'intent', name: 'Informational', geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({
        tag: 'intent:Informational', id: 'tag-intent-info', parentId: null, created: false,
      });
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s a closed-dimension value not in the fixed enum', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        {
          type: 'type', name: 'bogus-value', geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s a closed-dimension create that carries a parentId', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        {
          type: 'source', name: 'ai', geoTargetId: 2840, languageCode: 'en', parentId: 'root-1',
        },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.createProjectTags).to.not.have.been.called;
    });
  });

  describe('handleCreateTagSubworkspace', () => {
    it('resolves the project from the live listing and registers the tag', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      const res = await handler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        validBody,
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body).to.include({ type: 'category', name: 'Footwear', tag: 'category:Footwear' });
      expect(res.body).to.not.have.property('brandId');
      expect(resolveProjectStub).to.have.been.calledOnceWithExactly(
        transport,
        WORKSPACE,
        2840,
        'en',
        sinon.match.any,
      );
      expect(transport.createProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-sub-1', ['category:Footwear'], { parentId: undefined });
    });

    it('404s (marketNotFound) when the slice has no live project', async () => {
      const resolveProjectStub = sinon.stub().resolves(null);
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      await expect(handler.handleCreateTagSubworkspace(transport, WORKSPACE, validBody, fakeLog()))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(404);
          expect(err.code).to.equal('marketNotFound');
        });
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s on a bad body before resolving any project', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      await expect(handler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        { ...validBody, type: 'bogus' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(resolveProjectStub).to.not.have.been.called;
    });

    it('creates a BARE-named child when parentId is present (twin of the flat-mode fix)', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport({
        createProjectTags: sinon.stub().resolves([{ id: 'child-1', name: 'Sneakers', parent_id: 'parent-1' }]),
      });
      const res = await handler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        {
          type: 'category', name: 'Sneakers', geoTargetId: 2840, languageCode: 'en', parentId: 'parent-1',
        },
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body).to.include({ tag: 'Sneakers', id: 'child-1', parentId: 'parent-1' });
      expect(transport.createProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-sub-1', ['Sneakers'], { parentId: 'parent-1' });
    });

    it('resolves a closed-dimension tag (twin of the flat-mode fix)', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport({
        createProjectTags: sinon.stub().resolves([{ id: 'tag-type-branded', name: 'type:branded' }]),
      });
      const res = await handler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        {
          type: 'type', name: 'branded', geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({
        tag: 'type:branded', id: 'tag-type-branded', parentId: null, created: true,
      });
      expect(transport.createProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-sub-1', ['type:branded']);
    });
  });

  describe('handleCreateTag — nested (parentId)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('threads parentId to the transport and creates a BARE-named child, echoing the id + parentId', async () => {
      const transport = makeTransport({
        createProjectTags: sinon.stub().resolves([
          { id: 'child-1', name: 'Sneakers', parent_id: 'parent-1' },
        ]),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        {
          type: 'category', name: 'Sneakers', geoTargetId: 2840, languageCode: 'en', parentId: 'parent-1',
        },
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      // A child is BARE — no `category:` prefix — unlike a root (see the plain
      // 'registers a category:<NAME> tag' test above). serenity-docs#24 §2.
      expect(res.body).to.include({ tag: 'Sneakers', id: 'child-1', parentId: 'parent-1' });
      expect(transport.createProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', ['Sneakers'], { parentId: 'parent-1' });
    });

    it('normalizes an empty parentId to undefined (flat create)', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: '' },
        fakeLog(),
      );
      expect(transport.createProjectTags.firstCall.args[3]).to.deep.equal({ parentId: undefined });
    });

    it('400s on a non-string parentId', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: 123 },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s on a parentId with whitespace/control chars', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: 'has space' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
    });

    it('accepts a UUID parentId (hyphens are valid)', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: '6f383e4e-d8e1-47bb-888e-1f93e8575567' },
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(transport.createProjectTags.firstCall.args[3])
        .to.deep.equal({ parentId: '6f383e4e-d8e1-47bb-888e-1f93e8575567' });
    });

    it('normalizes a whitespace-only parentId to undefined (trims to empty)', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: '   ' },
        fakeLog(),
      );
      expect(transport.createProjectTags.firstCall.args[3]).to.deep.equal({ parentId: undefined });
    });

    it('400s on a parentId over the length ceiling', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, parentId: 'x'.repeat(201) },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.createProjectTags).to.not.have.been.called;
    });
  });

  describe('handleUpdateTag (flat mode) — PATCH /serenity/tags/:tagId', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    const updateBody = {
      name: 'category:Footwear', parentId: 'tag-parent', geoTargetId: 2840, languageCode: 'en',
    };

    it('re-parents/renames via the transport and returns 200', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, 'tag-1', updateBody, fakeLog());
      expect(res.status).to.equal(200);
      expect(res.body).to.include({
        brandId: BRAND, tagId: 'tag-1', tag: 'category:Footwear', parentId: 'tag-parent',
      });
      expect(transport.updateProjectTag)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', 'tag-1', { name: 'category:Footwear', parentId: 'tag-parent' });
    });

    it('omits parent_id when only renaming (no parentId sent)', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'tag-1',
        { name: 'category:Renamed', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(transport.updateProjectTag.firstCall.args[3]).to.deep.equal({ name: 'category:Renamed', parentId: undefined });
    });

    it('400s on a missing tagId', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, '', updateBody, fakeLog())).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s on a missing/blank name', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      for (const name of [undefined, '   ']) {
        // eslint-disable-next-line no-await-in-loop
        await expect(handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, 'tag-1', { ...updateBody, name }, fakeLog())).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s on a name that is not a creatable <dimension>:<value>', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'tag-1',
        { ...updateBody, name: 'intent:Informational' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s on a name missing its dimension prefix', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'tag-1',
        { ...updateBody, name: 'Footwear' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
    });

    it('400s on a name whose value is empty, too long, has a second colon, or has control characters', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const bad = [
        { ...updateBody, name: 'category:' },
        { ...updateBody, name: `category:${'x'.repeat(101)}` },
        { ...updateBody, name: 'category:topic:smuggled' },
        { ...updateBody, name: 'category:bad\u0000name' },
      ];
      for (const body of bad) {
        // eslint-disable-next-line no-await-in-loop
        await expect(
          handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, 'tag-1', body, fakeLog()),
        ).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('400s on a non-positive geoTargetId or malformed languageCode', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const bad = [
        { ...updateBody, geoTargetId: 0 },
        { ...updateBody, languageCode: 'EN_US!' },
      ];
      for (const body of bad) {
        // eslint-disable-next-line no-await-in-loop
        await expect(
          handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, 'tag-1', body, fakeLog()),
        ).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
    });

    it('400s a non-string, non-null parentId', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, 'tag-1', { ...updateBody, parentId: 123 }, fakeLog())).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('treats a whitespace-only parentId the same as omission (not promote-to-root)', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, 'tag-1', { ...updateBody, parentId: '   ' }, fakeLog());
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', 'tag-1', { name: 'category:Footwear', parentId: undefined });
    });

    it('404s (marketNotFound) when no project backs the slice', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess(null);
      await expect(handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, 'tag-1', updateBody, fakeLog())).to.be.rejected.then((err) => {
        expect(err.status).to.equal(404);
        expect(err.code).to.equal('marketNotFound');
      });
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('propagates an upstream 404 for an unknown tag id', async () => {
      const notFound = Object.assign(new Error('not found'), { status: 404 });
      const transport = makeTransport({ updateProjectTag: sinon.stub().rejects(notFound) });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(transport, dataAccess, BRAND, WORKSPACE, 'ghost', updateBody, fakeLog())).to.be.rejectedWith('not found');
    });
  });

  describe('handleUpdateTag — child target (serenity-docs#24 §3.1 gate 5)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('accepts a BARE name on a child and echoes its CURRENT parent_id even when only renaming (no parentId sent)', async () => {
      const transport = makeChildTreeTransport('root-1', 'child-1', {
        updateProjectTag: sinon.stub().resolves({ id: 'child-1', name: 'SneakersRenamed', parent_id: 'root-1' }),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'child-1',
        { name: 'SneakersRenamed', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({ tag: 'SneakersRenamed', parentId: 'root-1' });
      // The fix: parent_id is explicitly re-sent (never omitted for a child),
      // even though the request itself carried no parentId — omitting it here
      // is exactly what silently promotes a child to root on live Semrush.
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        'child-1',
        { name: 'SneakersRenamed', parentId: 'root-1' },
      );
    });

    it('falls back to the root id when the upstream child listing omits parent_id (defensive)', async () => {
      const listProjectTags = sinon.stub();
      listProjectTags.withArgs(sinon.match.any, sinon.match.any, sinon.match({ parentId: '' }))
        .resolves({ page: 1, total: 1, items: [{ id: 'root-1', name: 'category:Footwear', children_count: 1 }] });
      listProjectTags.withArgs(sinon.match.any, sinon.match.any, sinon.match({ parentId: 'root-1' }))
        .resolves({ page: 1, total: 1, items: [{ id: 'child-1', name: 'Sneakers' }] }); // no parent_id
      const transport = makeTransport({
        listProjectTags,
        updateProjectTag: sinon.stub().resolves({ id: 'child-1', name: 'SneakersRenamed', parent_id: 'root-1' }),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'child-1',
        { name: 'SneakersRenamed', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        'child-1',
        { name: 'SneakersRenamed', parentId: 'root-1' },
      );
    });

    it('400s a child rename that carries a dimension prefix (children are bare, like create)', async () => {
      const transport = makeChildTreeTransport('root-1', 'child-1');
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'child-1',
        { name: 'category:Sneakers', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('uses the CALLER-supplied parentId (not the current one) when explicitly re-parenting a child', async () => {
      const transport = makeChildTreeTransport('root-1', 'child-1', {
        updateProjectTag: sinon.stub().resolves({ id: 'child-1', name: 'Sneakers', parent_id: 'root-2' }),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'child-1',
        {
          name: 'Sneakers', parentId: 'root-2', geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        'child-1',
        { name: 'Sneakers', parentId: 'root-2' },
      );
    });

    it('400s a BARE name on a ROOT — unaffected by the child fix, roots still require the dimension prefix', async () => {
      const transport = makeRootTreeTransport('root-1');
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'root-1',
        { name: 'Footwear', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('omits parentId (unaffected, safe) when renaming a ROOT with no parentId sent', async () => {
      const transport = makeRootTreeTransport('root-1', {
        updateProjectTag: sinon.stub().resolves({ id: 'root-1', name: 'category:FootwearRenamed' }),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'root-1',
        { name: 'category:FootwearRenamed', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        'root-1',
        { name: 'category:FootwearRenamed', parentId: undefined },
      );
    });

    it('forwards an explicit null parentId as promote-to-root (gate 1)', async () => {
      const transport = makeChildTreeTransport('root-1', 'child-1', {
        updateProjectTag: sinon.stub().resolves({ id: 'child-1', name: 'Sneakers', parent_id: null }),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'child-1',
        {
          name: 'Sneakers', parentId: null, geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(res.body).to.include({ tag: 'Sneakers', parentId: null });
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        'child-1',
        { name: 'Sneakers', parentId: null },
      );
    });

    it('treats an explicit null parentId on a ROOT as a no-op (defensive, not live-verified)', async () => {
      const transport = makeRootTreeTransport('root-1', {
        updateProjectTag: sinon.stub().resolves({ id: 'root-1', name: 'category:Footwear' }),
      });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'root-1',
        {
          name: 'category:Footwear', parentId: null, geoTargetId: 2840, languageCode: 'en',
        },
        fakeLog(),
      );
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-1',
        'root-1',
        { name: 'category:Footwear', parentId: undefined },
      );
    });
  });

  describe('handleUpdateTag — tagId validation (MysticatBot review, PR 2737)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('400s a tagId over the length ceiling', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'x'.repeat(201),
        { name: 'category:Footwear', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.listProjectTags).to.not.have.been.called;
    });

    it('400s a tagId containing whitespace', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'tag one',
        { name: 'category:Footwear', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.listProjectTags).to.not.have.been.called;
    });

    it('400s a tagId containing a control character', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      await expect(handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        `tag-${String.fromCharCode(7)}`,
        { name: 'category:Footwear', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(transport.listProjectTags).to.not.have.been.called;
    });
  });

  describe('resolveTagTarget — root fan-out bounds (MysticatBot review, PR 2737)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('skips a childless root (childrenCount 0) without fetching its children', async () => {
      const listProjectTags = sinon.stub();
      listProjectTags.withArgs(sinon.match.any, sinon.match.any, sinon.match({ parentId: '' }))
        .resolves({
          page: 1,
          total: 1,
          items: [{ id: 'root-empty', name: 'category:Empty', children_count: 0 }],
        });
      const transport = makeTransport({ listProjectTags });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      // tagId resolves to 'unknown' (not found among roots or their children) —
      // same legacy dimension-prefix path as a root, so this succeeds (200); the
      // assertion under test is the call count, not the outcome.
      const res = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'no-such-tag',
        { name: 'category:Whatever', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      // Only the roots-level call — the childless root is never drilled.
      expect(listProjectTags).to.have.been.calledOnce;
    });

    it('caps the number of roots searched for an unresolvable tagId', async () => {
      const ROOT_COUNT = 150;
      const roots = Array.from({ length: ROOT_COUNT }, (_, i) => ({
        id: `root-${i}`, name: `category:R${i}`, children_count: 1,
      }));
      const listProjectTags = sinon.stub().callsFake((ws, pid, opts) => {
        if (opts.parentId === '') {
          // Real pagination: 100 items/page (matches listProjectTagTree's LIMIT),
          // so this correctly spans 2 pages for 150 roots.
          const start = (opts.page - 1) * opts.limit;
          return Promise.resolve({
            page: opts.page, total: ROOT_COUNT, items: roots.slice(start, start + opts.limit),
          });
        }
        // Any root's children: empty (tagId is never found).
        return Promise.resolve({ page: 1, total: 0, items: [] });
      });
      const transport = makeTransport({ listProjectTags });
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleUpdateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        'no-such-tag',
        { name: 'category:Whatever', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      // 2 roots-level pages (150 roots / 100 per page) + at most 100 per-root
      // drills (the cap), not all 150 — bounds the total at 102, not 152.
      expect(listProjectTags.callCount).to.be.at.most(102);
      expect(listProjectTags.callCount).to.be.greaterThan(2);
    });
  });

  describe('handleUpdateTagSubworkspace', () => {
    const updateBody = {
      name: 'category:Footwear', parentId: 'tag-parent', geoTargetId: 2840, languageCode: 'en',
    };

    it('resolves the project live and updates the tag (200)', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      const res = await handler.handleUpdateTagSubworkspace(transport, WORKSPACE, 'tag-1', updateBody, fakeLog());
      expect(res.status).to.equal(200);
      expect(res.body).to.include({ tagId: 'tag-1', tag: 'category:Footwear', parentId: 'tag-parent' });
      expect(res.body).to.not.have.property('brandId');
      expect(transport.updateProjectTag)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-sub-1', 'tag-1', { name: 'category:Footwear', parentId: 'tag-parent' });
    });

    it('404s (marketNotFound) when the slice has no live project', async () => {
      const resolveProjectStub = sinon.stub().resolves(null);
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      await expect(handler.handleUpdateTagSubworkspace(transport, WORKSPACE, 'tag-1', updateBody, fakeLog()))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(404);
          expect(err.code).to.equal('marketNotFound');
        });
      expect(transport.updateProjectTag).to.not.have.been.called;
    });

    it('accepts a BARE child rename and echoes its CURRENT parent_id (twin of the flat-mode fix)', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeChildTreeTransport('root-1', 'child-1', {
        updateProjectTag: sinon.stub().resolves({ id: 'child-1', name: 'SneakersRenamed', parent_id: 'root-1' }),
      });
      const res = await handler.handleUpdateTagSubworkspace(
        transport,
        WORKSPACE,
        'child-1',
        { name: 'SneakersRenamed', geoTargetId: 2840, languageCode: 'en' },
        fakeLog(),
      );
      expect(res.status).to.equal(200);
      expect(res.body).to.include({ tag: 'SneakersRenamed', parentId: 'root-1' });
      expect(transport.updateProjectTag).to.have.been.calledOnceWithExactly(
        WORKSPACE,
        'proj-sub-1',
        'child-1',
        { name: 'SneakersRenamed', parentId: 'root-1' },
      );
    });
  });
});
